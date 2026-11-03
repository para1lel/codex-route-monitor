import test from "node:test";
import assert from "node:assert/strict";
await import("../ui/panel-controller.js");
const { createController, unpack } = globalThis.CodexRouteMonitorPanel;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const idle = { running: false, lastRun: null };
const active = { running: true, active: { scope: "all" }, progress: { phase: "probe", total: 2, completed: 0, probesCompleted: 1, probesTotal: 3, attempts: 1 }, lastRun: { id: "r", status: "running", scope: "all" } };
function fixture(call) {
  const views = [], timers = new Map(); let id = 0;
  const controller = createController({ call, render: (s) => views.push(structuredClone(s)), schedule: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, cancel: (n) => timers.delete(n) });
  return { controller, views, timers, latest: () => views.at(-1) };
}

test("panel unwraps its own tool's JSON and rejects invalid replies", () => {
  assert.deepEqual(unpack({ text: '{"running":false}' }), { running: false });
  assert.deepEqual(unpack('{"started":true}'), { started: true });
  for (const value of [null, [], "false", { text: "not-json" }]) assert.throws(() => unpack(value));
});

for (const scope of ["all", "enabled"]) {
  test(`manual ${scope} button sends the exact scope and real-scan flag`, async (t) => {
    const calls = []; let status = idle;
    const f = fixture(async (name, args) => {
      calls.push({ name, args });
      if (name === "codex_route_scan") { status = active; return { text: JSON.stringify({ started: true, busy: false, scope, pid: 123 }) }; }
      return { text: JSON.stringify(status) };
    });
    t.after(() => f.controller.dispose());
    await f.controller.refresh();
    assert.equal(f.latest().busy, false);
    const result = await f.controller.start(scope);
    assert.equal(result.started, true);
    assert.deepEqual(calls.find((c) => c.name === "codex_route_scan").args, { scope, dry_run: false });
    assert.equal(f.latest().busy, true);
    assert.equal(f.latest().report.progress.probesCompleted, 1);
    status = { running: false, lastRun: { id: "r", status: "done", scope, accounts: [{ verdict: "ok" }] }, progress: { total: 1, completed: 1 } };
    await f.controller.refresh();
    assert.equal(f.latest().busy, false);
    assert.equal(f.latest().report.lastRun.status, "done");
  });
}

test("rapid repeated clicks cannot dispatch a second scan", async (t) => {
  const launch = deferred(); let dispatched = 0;
  const f = fixture(async (name) => {
    if (name === "codex_route_scan") { ++dispatched; return launch.promise; }
    return active;
  });
  t.after(() => f.controller.dispose());
  const first = f.controller.start("all");
  assert.equal(f.latest().starting, true);
  assert.deepEqual(await f.controller.start("enabled"), { started: false, busy: true });
  assert.equal(dispatched, 1);
  launch.resolve({ started: true, pid: 123 });
  await first;
  assert.equal(f.latest().running, true);
});

test("an old idle status response cannot re-enable buttons after a click", async (t) => {
  const old = deferred(); let reads = 0;
  const f = fixture(async (name) => name === "codex_route_scan" ? { started: true } : ++reads === 1 ? old.promise : active);
  t.after(() => f.controller.dispose());
  const pendingRead = f.controller.refresh();
  const started = f.controller.start("all");
  old.resolve(idle);
  await Promise.all([pendingRead, started]);
  assert.equal(reads, 2);
  assert.ok(f.views.every((v) => v.busy), "the stale idle report must never clear a pending launch");
  assert.equal(f.latest().report.running, true);
});

test("an existing scan is shown as busy rather than falsely starting a new one", async (t) => {
  const f = fixture(async (name) => name === "codex_route_scan" ? { started: false, busy: true, active: { scope: "all" } } : active);
  t.after(() => f.controller.dispose());
  const result = await f.controller.start("enabled");
  assert.equal(result.started, false);
  assert.equal(f.latest().notice, "busy");
  assert.equal(f.latest().busy, true);
});

test("spawn failure is visible and leaves a retry possible", async (t) => {
  let fail = true;
  const f = fixture(async (name) => {
    if (name !== "codex_route_scan") return active;
    if (fail) return { started: false, busy: false, code: "spawn_failed", error: "fixture: cannot spawn" };
    return { started: true };
  });
  t.after(() => f.controller.dispose());
  assert.equal((await f.controller.start("all")).started, false);
  assert.match(f.latest().error, /cannot spawn/);
  assert.equal(f.latest().busy, false);
  fail = false;
  assert.equal((await f.controller.start("enabled")).started, true);
  assert.equal(f.latest().busy, true);
});

test("a failed status read does not assume a running scan is idle", async (t) => {
  let fail = false, starts = 0;
  const f = fixture(async (name) => {
    if (name === "codex_route_scan") { ++starts; return { started: true }; }
    if (fail) throw new Error("fixture: status offline");
    return active;
  });
  t.after(() => f.controller.dispose());
  await f.controller.start("all"); fail = true;
  await f.controller.refresh();
  assert.equal(f.latest().busy, true);
  assert.match(f.latest().error, /status offline/);
  await f.controller.start("enabled");
  assert.equal(starts, 1);
});

test("polling is slower at idle and stops when hidden or disposed", async () => {
  let status = idle, calls = 0;
  const f = fixture(async () => { ++calls; return status; });
  await f.controller.refresh();
  assert.equal([...f.timers.values()][0].ms, 15000);
  status = active;
  await f.controller.refresh();
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].ms, 3000);
  f.controller.setVisible(false);
  assert.equal(f.timers.size, 0);
  await f.controller.refresh();
  assert.equal(calls, 2);
  f.controller.setVisible(true);
  await f.controller.refresh();
  assert.equal(calls, 3);
  f.controller.dispose();
  assert.equal(f.timers.size, 0);
  await f.controller.refresh();
  assert.equal(calls, 3);
});

test("invalid scopes fail before a tool can be called", async (t) => {
  const f = fixture(async () => assert.fail("unexpected tool call"));
  t.after(() => f.controller.dispose());
  await assert.rejects(f.controller.start("auto"), /Invalid scan scope/);
});
