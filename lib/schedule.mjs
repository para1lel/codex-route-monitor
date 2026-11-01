// The schedule: a full pass at midnight over every Codex account, and passes
// over the accounts in use every three hours after it (03:00 … 21:00).
//
// The tick lives in magpie's plugin host while it runs, which is the only
// place a magpie plugin is given a timer. A run itself is started as a
// separate process: a probe can take minutes, and a scan must survive a plugin
// host that is restarted under it (a plugin update, a proxy change, magpie
// being quit) without leaving the account switches half-applied.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadState, logLine, saveState, slotKey } from "./config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLI = path.join(HERE, "..", "bin", "codex-route-monitor.mjs");

let started = false;
let timer = null;

function slotStart(key) {
  const [date, hourText] = key.split("T");
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day, Number(hourText.slice(0, 2)), 0, 0, 0);
}

function scopeOf(hour, config) {
  return hour === (config.slots[0] ?? 0) ? "all" : "enabled";
}

function slotWindows(config, now) {
  const out = [];
  for (const dayOffset of [0, -1]) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    for (const hour of config.slots) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0);
      out.push({ key: slotKey(at), at, hour });
    }
  }
  return out;
}

/**
 * dueSlot is the latest slot that has come and not been run: the daily full
 * pass may be caught up for the rest of its day, the three-hourly ones within
 * catchUpMinutes. A slot whose process died is taken again once its mark is
 * old enough to be stale.
 */
export function dueSlot(config = loadConfig(), now = new Date()) {
  const state = loadState();
  const daily = config.slots[0] ?? 0;
  let best = null;
  for (const slot of slotWindows(config, now)) {
    if (slot.at > now) continue;
    const mark = state.slots?.[slot.key];
    if (mark) {
      if (mark.status === "done" || mark.status === "failed") continue;
      if (mark.status === "running") {
        const age = Date.now() - Date.parse(mark.at ?? 0);
        if (age < 45 * 60 * 1000) continue;
      }
    }
    const lateMinutes = (now - slot.at) / 60_000;
    const window = slot.hour === daily ? 24 * 60 : config.catchUpMinutes;
    if (lateMinutes > window) continue;
    if (!best || slot.at > best.at) best = { ...slot, lateMinutes };
  }
  return best;
}

function spawnRun(slot, config, { echo = false } = {}) {
  const scope = scopeOf(slot.hour, config);
  const child = spawn(
    process.execPath,
    [CLI, "scan", "--scope", scope, "--trigger", "schedule", "--slot", slot.key],
    { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env } },
  );
  child.unref();
  logLine(`slot ${slot.key} (${scope}) started as pid ${child.pid ?? "?"}`, { echo });
  return { scope, pid: child.pid ?? null };
}

function tick({ echo = false } = {}) {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logLine(`the schedule could not read its config: ${String(error)}`);
    return;
  }
  const now = new Date();
  const slot = dueSlot(config, now);
  if (!slot) return;
  const state = loadState();
  state.slots ??= {};
  state.slots[slot.key] = { status: "running", at: now.toISOString(), scope: scopeOf(slot.hour, config) };
  saveState(state);
  try {
    spawnRun(slot, config, { echo });
  } catch (error) {
    state.slots[slot.key] = { status: "failed", at: new Date().toISOString(), error: String(error) };
    saveState(state);
    logLine(`slot ${slot.key} could not be started: ${String(error)}`, { echo });
  }
}

/**
 * startScheduler starts the tick in this process once. It is called as the
 * plugin loads, which is at magpie's start and after every plugin change.
 */
export function startScheduler({ echo = false, config } = {}) {
  if (started) return { started: false, reason: "already started" };
  let cfg;
  try {
    cfg = config ?? loadConfig();
  } catch (error) {
    logLine(`the scheduler was not started: ${String(error)}`);
    return { started: false, reason: String(error) };
  }
  if (cfg.scheduler === false) {
    logLine("the scheduler is off in config.json (scheduler: false)");
    return { started: false, reason: "off" };
  }
  started = true;
  tick({ echo });
  timer = setInterval(() => tick({ echo }), 20_000);
  timer.unref?.();
  logLine(
    `scheduler started: slots ${cfg.slots.map((hour) => `${String(hour).padStart(2, "0")}:00`).join(", ")} (local time)`,
  );
  return { started: true };
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

/** schedulePlan lists the slots around now with what has come of them. */
export function schedulePlan(config = loadConfig(), now = new Date()) {
  const state = loadState();
  const from = now.getTime() - 24 * 60 * 60 * 1000;
  return slotWindows(config, now)
    .filter((slot) => slot.at.getTime() >= from)
    .sort((left, right) => left.at - right.at)
    .map((slot) => ({
      slot: slot.key,
      scope: scopeOf(slot.hour, config),
      at: slot.at.toISOString(),
      status: state.slots?.[slot.key]?.status ?? "pending",
    }));
}

export { slotStart };
