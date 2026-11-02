// Where the monitor keeps what it knows: its settings, its last state, one
// record per run, and its log. All of it sits beside magpie's own settings, in
// ~/.config/magpie/codex-route-monitor, so it goes wherever magpie's config
// goes on each machine.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CONFIG = {
  // The model and effort each probe asks for. `codex/<id>` names the Codex
  // subscription's own model, which is the one a Codex account serves; the
  // X-Magpie-Account header pins the probe to one account.
  model: "codex/gpt-6.1-sol",
  effort: "low",
  // How many challenges make one diagnosis, and how many tries are allowed to
  // get that many usable answers (a refusal or a cut list is asked again).
  probes: 3,
  probeAttempts: 8,
  // One request may take this long: a reasoning model that answers a list of
  // numbers can sit on a single challenge for minutes, and a probe cut off at
  // three minutes took a good answer with it.
  probeTimeoutMs: 600_000,
  // One account is given this long in all, retries included: three challenges
  // at the ten-minute request limit still fit, and a slow model must not turn
  // a three-hourly pass into an afternoon of probing.
  accountBudgetMs: 60 * 60_000,
  // Accounts are probed one after another; the pause keeps a scan gentle.
  concurrency: 1,
  pauseMs: 3_000,
  // Pinned requests need a gateway key magpie trusts from this computer.
  gatewayKey: "magpie",
  gatewayUrl: null,
  // The daily and three-hourly slots, in local time: 0 runs every account
  // (including disabled ones), the rest run the accounts in use.
  slots: [0, 3, 6, 9, 12, 15, 18, 21],
  // A slot missed while magpie was down is still run this long after it starts.
  catchUpMinutes: 120,
  // A scan that failed (magpie off, its gateway silent) is tried again after
  // this long, while the slot's own window lasts.
  retryFailedMinutes: 15,
  // A top-1 diagnosis in any of these means the account answered with a Luna
  // model, i.e. it was moved off the model that was asked for.
  riskModels: ["gpt-5.6-luna", "gpt-6-luna"],
  // Never touch magpie's account switches: only report.
  dryRun: false,
  // Whether to run the scan's own scheduler inside magpie's plugin host.
  scheduler: true,
};

export function stateDir() {  const explicit = process.env.CODEX_ROUTE_MONITOR_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), ".config", "magpie", "codex-route-monitor");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function loadConfig(overrides = {}) {
  const dir = stateDir();
  const saved = readJSON(path.join(dir, "config.json"), {}) ?? {};
  const config = { ...DEFAULT_CONFIG, ...saved, ...overrides };
  config.slots = normaliseSlots(config.slots);
  config.riskModels = Array.isArray(config.riskModels) && config.riskModels.length
    ? config.riskModels.map((id) => String(id).toLowerCase())
    : [...DEFAULT_CONFIG.riskModels];
  return config;
}

function normaliseSlots(slots) {
  const list = Array.isArray(slots) ? slots : DEFAULT_CONFIG.slots;
  const hours = [...new Set(list.map((hour) => Number(hour)))]
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
    .sort((a, b) => a - b);
  return hours.length ? hours : [...DEFAULT_CONFIG.slots];
}

export function saveConfig(config) {
  const dir = ensureDir(stateDir());
  writeJSON(path.join(dir, "config.json"), config);
}

export function statePath() {
  return path.join(stateDir(), "state.json");
}

export function loadState() {
  const state = readJSON(statePath(), null);
  if (!state || typeof state !== "object") return { version: 1, slots: {}, accounts: {} };
  state.version ??= 1;
  state.slots ??= {};
  state.accounts ??= {};
  return state;
}

export function saveState(state) {
  state.updatedAt = new Date().toISOString();
  writeJSON(statePath(), state);
}

export function runsDir() {
  return ensureDir(path.join(stateDir(), "runs"));
}

export function logsDir() {
  return ensureDir(path.join(stateDir(), "logs"));
}

export function writeRun(run) {
  const file = path.join(runsDir(), `${run.id}.json`);
  writeJSON(file, run);
  return file;
}

export function listRuns(limit = 20) {
  const dir = runsDir();
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit);
  return files.map((name) => readJSON(path.join(dir, name))).filter(Boolean);
}

/** slotKey names the schedule slot a moment belongs to: 2026-11-02T00:00. */
export function slotKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`;
}

/** logLine appends one line to the monitor's log, and echoes it when asked. */
export function logLine(line, { echo = false } = {}) {
  const stamped = `${new Date().toISOString()} ${line}`;
  try {
    fs.appendFileSync(path.join(logsDir(), "monitor.log"), `${stamped}\n`);
  } catch {
    // a log that cannot be written must not fail a scan
  }
  if (echo) console.log(stamped);
}
