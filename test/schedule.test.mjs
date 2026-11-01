import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crm-schedule-"));
process.env.CODEX_ROUTE_MONITOR_HOME = HOME;

const { DEFAULT_CONFIG, slotKey, loadState, saveState } = await import("../lib/config.mjs");
const { dueSlot, schedulePlan } = await import("../lib/schedule.mjs");

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const config = { ...DEFAULT_CONFIG, slots: [0, 3, 6, 9, 12, 15, 18, 21], catchUpMinutes: 120 };

const at = (text) => new Date(`${text}:00`);

function reset() {
  saveState({ version: 1, slots: {}, accounts: {} });
}

test("a slot is named by its hour", () => {
  assert.equal(slotKey(new Date(2026, 10, 2, 3, 59, 59)), "2026-11-02T03:00");
  assert.equal(slotKey(new Date(2026, 0, 1, 0, 0, 0)), "2026-01-01T00:00");
});

test("the latest slot that has come is the one due", () => {
  reset();
  const due = dueSlot(config, at("2026-11-02T03:05"));
  assert.equal(due.key, "2026-11-02T03:00");
  assert.equal(due.hour, 3);
});

test("a slot already run is not run again", () => {
  reset();
  const state = loadState();
  state.slots["2026-11-02T03:00"] = { status: "done", at: "2026-11-02T03:02:00.000Z" };
  state.slots["2026-11-02T00:00"] = { status: "done", at: "2026-11-02T00:03:00.000Z" };
  saveState(state);
  assert.equal(dueSlot(config, at("2026-11-02T03:05")), null);
});

test("a running slot is left alone until it is stale", () => {
  reset();
  const state = loadState();
  state.slots["2026-11-02T03:00"] = { status: "running", at: new Date().toISOString() };
  saveState(state);
  assert.equal(dueSlot(config, at("2026-11-02T03:05"))?.key ?? null, "2026-11-02T00:00");
  // a run that died three hours ago is taken again
  state.slots["2026-11-02T03:00"] = { status: "running", at: new Date(Date.now() - 3 * 3600_000).toISOString() };
  saveState(state);
  assert.equal(dueSlot(config, at("2026-11-02T03:05")).key, "2026-11-02T03:00");
});

test("the daily pass may be caught up for the rest of its day", () => {
  reset();
  // 21:30, nothing has run: the midnight pass is still the daily one to do,
  // while the 21:00 three-hourly slot is inside its own window too
  const due = dueSlot(config, at("2026-11-02T21:30"));
  assert.equal(due.key, "2026-11-02T21:00");
  const state = loadState();
  state.slots["2026-11-02T21:00"] = { status: "done", at: "2026-11-02T21:02:00.000Z" };
  saveState(state);
  assert.equal(dueSlot(config, at("2026-11-02T21:30")).key, "2026-11-02T00:00");
});

test("a three-hourly slot missed by more than the window is not run late", () => {
  reset();
  const state = loadState();
  for (const hour of ["00", "03", "06", "09", "12"]) {
    state.slots[`2026-11-02T${hour}:00`] = { status: "done", at: `2026-11-02T${hour}:02:00.000Z` };
  }
  saveState(state);
  // 15:00 is 2h10 late at 17:10: past the 120 minute window
  assert.equal(dueSlot({ ...config, catchUpMinutes: 60 }, at("2026-11-02T17:10")), null);
  // 16:30: 15:00 is 90 minutes late, inside a 120 minute window
  assert.equal(dueSlot(config, at("2026-11-02T16:30")).key, "2026-11-02T15:00");
});

test("the plan shows the slots around now and what came of them", () => {
  reset();
  const state = loadState();
  state.slots["2026-11-02T00:00"] = { status: "done", at: "2026-11-02T00:04:00.000Z" };
  saveState(state);
  const plan = schedulePlan(config, at("2026-11-02T03:05"));
  assert.ok(plan.length >= 8);
  assert.equal(plan.find((item) => item.slot === "2026-11-02T00:00")?.status, "done");
  assert.ok(plan.some((item) => item.slot === "2026-11-02T03:00" && item.scope === "enabled"));
  assert.ok(plan.every((item) => ["all", "enabled"].includes(item.scope)));
});
