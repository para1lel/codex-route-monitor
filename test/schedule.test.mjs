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

// the shipped schedule: every account at midnight, the ones in use at 08:00 and 16:00
const config = { ...DEFAULT_CONFIG, slots: [0, 8, 16], catchUpMinutes: 120 };

const at = (text) => new Date(`${text}:00`);

function reset(slots = {}) {
  saveState({ version: 1, slots, accounts: {} });
}

const done = (key) => ({ status: "done", at: `${key.split("T")[0]}T00:02:00.000Z` });

test("a slot is named by its hour", () => {
  assert.equal(slotKey(new Date(2026, 10, 2, 7, 59, 59)), "2026-11-02T07:00");
  assert.equal(slotKey(new Date(2026, 0, 1, 0, 0, 0)), "2026-01-01T00:00");
});

test("the full pass comes before the 08:00 slot it has passed", () => {
  reset();
  // nothing has run: the midnight pass is the one to do, not 08:00 behind it
  assert.equal(dueSlot(config, at("2026-11-02T08:05")).key, "2026-11-02T00:00");
  // with it done, the 08:00 slot is next
  reset({ "2026-11-02T00:00": done("2026-11-02T00:00") });
  assert.equal(dueSlot(config, at("2026-11-02T08:05")).key, "2026-11-02T08:00");
});

test("a slot already run is not run again", () => {
  reset({
    "2026-11-02T00:00": done("2026-11-02T00:00"),
    "2026-11-02T08:00": done("2026-11-02T08:00"),
  });
  assert.equal(dueSlot(config, at("2026-11-02T08:05")), null);
});

test("a running slot is left alone until it is stale", () => {
  reset({
    "2026-11-02T00:00": done("2026-11-02T00:00"),
    "2026-11-02T08:00": { status: "running", at: "2026-11-02T08:01:00" },
  });
  assert.equal(dueSlot(config, at("2026-11-02T08:05")), null);
  // a run whose mark is three hours old is taken again
  reset({
    "2026-11-02T00:00": done("2026-11-02T00:00"),
    "2026-11-02T08:00": { status: "running", at: "2026-11-02T05:00:00" },
  });
  assert.equal(dueSlot(config, at("2026-11-02T08:05")).key, "2026-11-02T08:00");
});

test("the daily pass may be caught up for the rest of its day", () => {
  reset();
  // 21:30 and nothing has run: the midnight pass is still the one to do
  assert.equal(dueSlot(config, at("2026-11-02T21:30")).key, "2026-11-02T00:00");
  reset({ "2026-11-02T00:00": done("2026-11-02T00:00") });
  // 16:00 is still inside its two-hour window at 17:00
  assert.equal(dueSlot(config, at("2026-11-02T17:00")).key, "2026-11-02T16:00");
  // and late at night nothing is due any more
  assert.equal(dueSlot(config, at("2026-11-02T21:30")), null);
});

test("the 08:00 slot missed by more than the window is not run late", () => {
  reset({ "2026-11-02T00:00": done("2026-11-02T00:00") });
  // 10:15 is 2h15 late: past a 120 minute window and past a 60 one
  assert.equal(dueSlot({ ...config, catchUpMinutes: 60 }, at("2026-11-02T10:15")), null);
  // 09:30 is 90 minutes late, inside a 120 minute window
  assert.equal(dueSlot(config, at("2026-11-02T09:30")).key, "2026-11-02T08:00");
});

test("a failed slot is tried again after a while", () => {
  reset({
    "2026-11-02T00:00": done("2026-11-02T00:00"),
    "2026-11-02T08:00": { status: "failed", at: "2026-11-02T08:10:00", error: "magpie's gateway does not answer" },
  });
  // at 08:20 it has failed too recently to be asked again
  assert.equal(dueSlot(config, at("2026-11-02T08:20")), null);
  // at 08:40 the retry window has passed, and the slot is still inside its own
  assert.equal(dueSlot(config, at("2026-11-02T08:40")).key, "2026-11-02T08:00");
  // past the slot's own window, a failure is the day's answer
  assert.equal(dueSlot(config, at("2026-11-02T11:30")), null);
});

test("the plan shows the slots around now and what came of them", () => {
  reset({ "2026-11-02T00:00": done("2026-11-02T00:00") });
  const plan = schedulePlan(config, at("2026-11-02T08:05"));
  assert.ok(plan.length >= 3);
  assert.equal(plan.find((item) => item.slot === "2026-11-02T00:00")?.status, "done");
  assert.ok(plan.some((item) => item.slot === "2026-11-02T08:00" && item.scope === "enabled"));
  assert.ok(plan.every((item) => ["all", "enabled"].includes(item.scope)));
  // 16:00 is the last slot of the day: nothing at 12:00 any more
  assert.ok(!plan.some((item) => item.slot === "2026-11-02T12:00"));
});
