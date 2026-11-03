import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { createManualController } from "../lib/manual.mjs";
import { createLockManager, readLock } from "../lib/lock.mjs";
import { probeAccount, runScan, statusReport } from "../lib/core.mjs";
import { DEFAULT_CONFIG, saveState } from "../lib/config.mjs";

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-manual-"));
  const previous = process.env.CODEX_ROUTE_MONITOR_HOME;
  process.env.CODEX_ROUTE_MONITOR_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_ROUTE_MONITOR_HOME;
    else process.env.CODEX_ROUTE_MONITOR_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fakeLauncher(t, { event = "spawn", error = new Error("ENOENT fake-node"), syncError = false } = {}) {
  const dir = home(t);
  const locks = createLockManager({ dir, pid: 100, host: "fake", isAlive: () => true });
  const calls = [];
  const children = [];
  const spawnProcess = (...args) => {
    calls.push(args);
    if (syncError) throw error;
    const child = new EventEmitter();
    child.pid = 200;
    child.unref = () => { child.unreferenced = true; };
    children.push(child);
    queueMicrotask(() => child.emit(event, error));
    return child;
  };
  const controller = createManualController({ spawnProcess, acquire: locks.tryAcquire, getStateDir: () => dir, env: { ONLY_TEST: "yes" } });
  return { dir, locks, calls, children, controller, spawnProcess };
}

for (const scope of ["all", "enabled"]) {
  test(`manual ${scope} starts the existing CLI as a real (non-dry) scan`, async (t) => {
    const { controller, calls, children, locks } = fakeLauncher(t);
    const result = await controller.start({ scope });
    assert.equal(result.started, true);
    assert.equal(result.busy, false);
    assert.equal(result.dryRun, false);
    assert.equal(result.pid, 200);
    assert.deepEqual(calls[0][1].slice(1), ["scan", "--scope", scope, "--trigger", "tool"]);
    assert.equal(calls[0][2].stdio, "ignore");
    assert.equal(calls[0][2].detached, true);
    assert.ok(calls[0][2].env.CODEX_ROUTE_MONITOR_LOCK_TOKEN);
    assert.equal(locks.readLock().held.pid, 200);
    assert.equal(children[0].unreferenced, true);
    children[0].emit("close", 0);
    assert.equal(locks.lockHeld(), false);
  });
}

test("default scope and legacy dry_run remain compatible; invalid arguments never spawn", async (t) => {
  const { controller, calls, children } = fakeLauncher(t);
  for (const args of [{ scope: "ALL" }, { scope: "auto" }, { scope: null }, { scope: 1 }, { scope: "" }, { dry_run: "false" }, null, []]) {
    const result = await controller.start(args);
    assert.equal(result.started, false);
    assert.equal(result.busy, false);
    assert.match(result.code, /^invalid_/);
  }
  assert.equal(calls.length, 0);
  const result = await controller.start({ dry_run: true });
  assert.equal(result.scope, "enabled");
  assert.equal(result.dryRun, true);
  assert.equal(calls[0][1].at(-1), "--dry-run");
  children[0].emit("close", 0);
});

test("rapid and concurrent calls across controllers reserve only one scan", async (t) => {
  const { dir, controller, calls, children, spawnProcess } = fakeLauncher(t);
  const otherLocks = createLockManager({ dir, pid: 101, host: "fake", isAlive: () => true });
  const other = createManualController({ spawnProcess, acquire: otherLocks.tryAcquire });
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) =>
    (index % 2 ? other : controller).start({ scope: index % 3 ? "all" : "enabled" })));
  assert.equal(calls.length, 1);
  assert.equal(results.filter((item) => item.started).length, 1);
  assert.equal(results.filter((item) => item.busy).length, 29);
  for (const result of results.filter((item) => item.busy)) {
    assert.equal(result.started, false);
    assert.equal(result.running, true);
    assert.equal(JSON.stringify(result).includes("token"), false);
  }
  children[0].emit("close", 0);
  assert.equal((await other.start({ scope: "all" })).started, true);
  children[1].emit("close", 0);
});

test("an existing scheduled scan returns busy without spawning", async (t) => {
  const { controller, locks, calls } = fakeLauncher(t);
  const lock = locks.tryAcquire({ scope: "enabled", trigger: "schedule" }, { claimToken: null });
  const result = await controller.start({ scope: "all" });
  assert.equal(result.busy, true);
  assert.equal(result.started, false);
  assert.equal(result.active.trigger, "schedule");
  assert.equal(calls.length, 0);
  lock.release();
});

for (const syncError of [false, true]) {
  test(`${syncError ? "synchronous" : "asynchronous"} spawn errors are returned and release the reservation`, async (t) => {
    const { controller, locks } = fakeLauncher(t, { syncError, event: "error" });
    const result = await controller.start({ scope: "all" });
    assert.equal(result.started, false);
    assert.equal(result.running, false);
    assert.equal(result.code, "spawn_failed");
    assert.match(result.error, /ENOENT/);
    assert.equal(locks.lockHeld(), false);
    assert.equal(statusReport(10, { readLock: locks.readLock }).lastRun.status, "failed");
  });
}

test("handoff IO errors do not escape the spawn callback or unlock a live child", async (t) => {
  const { dir, locks, spawnProcess, calls, children } = fakeLauncher(t);
  const controller = createManualController({
    spawnProcess,
    acquire: (...args) => {
      const lock = locks.tryAcquire(...args);
      return lock.busy ? lock : { ...lock, handoff: () => { throw new Error("fake handoff IO failure"); } };
    },
  });
  const started = await controller.start({ scope: "all" });
  assert.equal(started.started, true);
  assert.match(started.warning, /handoff failed/);
  assert.equal(locks.lockHeld(), true);
  assert.equal((await controller.start({ scope: "all" })).busy, true);
  assert.equal(calls.length, 1);
  const childLocks = createLockManager({ dir, pid: 200, host: "fake", isAlive: () => true });
  const adopted = childLocks.tryAcquire({ scope: "all" }, { claimToken: calls[0][2].env.CODEX_ROUTE_MONITOR_LOCK_TOKEN });
  assert.equal(adopted.busy, undefined);
  assert.equal(childLocks.readLock().held.pid, 200);
  children[0].emit("close", 0);
});

test("a real OS spawn error cannot crash the host or leave it busy", async (t) => {
  const dir = home(t);
  const controller = createManualController({ executable: path.join(dir, "nonexistent-test-node") });
  const result = await controller.start({ scope: "enabled" });
  assert.equal(result.started, false);
  assert.equal(result.code, "spawn_failed");
  await new Promise((resolve) => setImmediate(resolve)); // Let the failed child's close listener settle before restoring HOME.
  assert.equal(readLock().running, false);
  assert.equal(statusReport().lastRun.status, "failed");
});

test("lock IO failures are explicit and never spawn", async () => {
  const controller = createManualController({
    acquire: () => { throw new Error("read-only test directory"); },
    spawnProcess: () => assert.fail("must not spawn"),
  });
  assert.equal((await controller.start({ scope: "all" })).code, "lock_failed");
});

test("reservation handoff adopts the nonce; old handles cannot remove a later scan", (t) => {
  const dir = home(t);
  let now = Date.now();
  const live = new Set([100, 200]);
  const parent = createLockManager({ dir, pid: 100, host: "fake", isAlive: (pid) => live.has(pid), now: () => now });
  const child = createLockManager({ dir, pid: 200, host: "fake", isAlive: (pid) => live.has(pid), now: () => now });
  const reservation = parent.tryAcquire({ scope: "all" }, { reserve: true, claimToken: null });
  reservation.handoff(200);
  live.delete(100); // The plugin host can disappear without losing the child.
  const scan = child.tryAcquire({ scope: "all" }, { claimToken: reservation.token });
  assert.equal(scan.busy, undefined);
  assert.equal(child.readLock().held.phase, "running");
  now += 7 * 60 * 60_000; // Do not expire an actually live, long-running scan.
  assert.equal(child.lockHeld(), true);
  assert.equal(parent.tryAcquire({}, { claimToken: null }).busy, true);
  scan.release();
  const next = child.tryAcquire({}, { claimToken: null });
  reservation.release();
  assert.equal(child.lockHeld(), true);
  next.release();
});

test("dead scans and startup timeouts are recoverable, never permanent busy", (t) => {
  const dir = home(t);
  let now = Date.now();
  let alive = true;
  const locks = createLockManager({ dir, pid: 100, host: "fake", isAlive: () => alive, now: () => now });
  const first = locks.tryAcquire({}, { claimToken: null });
  alive = false;
  assert.equal(locks.readLock().stale, true);
  alive = true;
  const reserved = locks.tryAcquire({}, { reserve: true, claimToken: null });
  // The old live lock still owns this attempt; explicitly release it first.
  assert.equal(reserved.busy, true);
  first.release();
  const launch = locks.tryAcquire({}, { reserve: true, claimToken: null });
  now += 60_001;
  assert.equal(locks.lockHeld(), false);
  const recovered = locks.tryAcquire({}, { claimToken: null });
  assert.equal(recovered.busy, undefined);
  launch.release();
  assert.equal(locks.lockHeld(), true);
  recovered.release();
  alive = false;
  locks.tryAcquire({}, { claimToken: null });
  const deadRecovered = locks.tryAcquire({}, { claimToken: null });
  assert.equal(deadRecovered.busy, undefined);
  deadRecovered.release();
});

test("independent worker contenders acquire exactly one shared filesystem lock", async (t) => {
  const dir = home(t);
  const moduleUrl = pathToFileURL(path.resolve("lib/lock.mjs")).href;
  const workers = Array.from({ length: 10 }, () => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.moduleUrl).then(({ createLockManager }) => {
      const result = createLockManager({ dir: workerData.dir }).tryAcquire({ scope: 'all' }, { reserve: true, claimToken: null });
      parentPort.postMessage({ acquired: !result.busy });
      parentPort.on('message', () => { if (!result.busy) result.release(); parentPort.close(); });
    }).catch(error => { throw error; });
  `, { eval: true, workerData: { dir, moduleUrl } }));
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  const results = await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  })));
  assert.equal(results.filter((item) => item.acquired).length, 1);
  await Promise.all(workers.map((worker) => new Promise((resolve) => { worker.once("exit", resolve); worker.postMessage("release"); })));
});

function scanFakes(extra = {}) {
  const snapshots = [];
  const probed = [];
  const switches = [];
  const providers = [];
  const dependencies = {
    loadConfig: (overrides) => ({ ...DEFAULT_CONFIG, gatewayKey: "test-secret-credential", ...overrides }),
    loadBank: () => ({}),
    healthcheck: async () => true,
    providerOff: () => false,
    setProviderOn: async (...args) => { providers.push(args); },
    listCodexAccounts: async () => [{ user: "enabled@example.test" }, { user: "disabled@example.test" }, { user: "third@example.test" }],
    readPool: async () => ({ accounts: [{ user: "enabled@example.test", enabled: true }, { user: "disabled@example.test", enabled: false }] }),
    setPoolEnabled: async (users) => { switches.push([...users]); return { accounts: users.map((user) => ({ user, enabled: true })) }; },
    probeAccount: async ({ account, onProgress }) => {
      probed.push(account);
      for (let i = 1; i <= 3; i++) onProgress({ attempts: i, accepted: i, total: 3, lastProbe: { error: "not for UI" } });
      return { user: account, verdict: "ok", model: "fake-model", probability: 1, displayName: "Fake" };
    },
    saveState: (state) => { saveState(state); snapshots.push(statusReport()); },
    sleep: async () => {},
    ...extra,
  };
  return { dependencies, snapshots, probed, switches, providers };
}

for (const scope of ["all", "enabled"]) {
  test(`runScan ${scope} preserves target selection and records every progress boundary`, async (t) => {
    home(t);
    const { dependencies, snapshots, probed, switches } = scanFakes();
    const run = await runScan({ scope, trigger: "tool" }, dependencies);
    const expected = scope === "all" ? ["enabled@example.test", "disabled@example.test", "third@example.test"] : ["enabled@example.test"];
    assert.deepEqual(probed, expected);
    assert.equal(run.status, "done");
    assert.equal(readLock().running, false);
    assert.equal(snapshots[0].running, true);
    assert.equal(snapshots[0].progress.phase, "starting");
    assert.equal(snapshots[0].progress.total, null);
    assert.equal(snapshots.find((item) => item.progress?.phase === "targets").progress.total, expected.length);
    for (const user of expected) {
      const starts = snapshots.filter((item) => item.progress?.phase === "account" && item.progress.currentAccount === user);
      assert.equal(starts.length, 1);
      assert.equal(starts[0].progress.attempts, 0);
      assert.deepEqual(snapshots.filter((item) => item.progress?.phase === "probe" && item.progress.currentAccount === user).map((item) => item.progress.probesCompleted), [1, 2, 3]);
    }
    assert.equal(snapshots.filter((item) => item.progress?.phase === "account_done").length, expected.length);
    const status = statusReport();
    assert.equal(status.running, false);
    assert.equal(status.lastRun.status, "done");
    assert.equal(status.progress.completed, expected.length);
    assert.equal(status.progress.currentAccount, null);
    assert.ok(status.lastRun.finishedAt);
    assert.deepEqual(switches.at(-1), expected);
    assert.equal(JSON.stringify(status).includes("lockToken"), false);
    assert.equal(JSON.stringify(status).includes("lastProbe"), false);
  });
}

test("probeAccount emits a callback after each actual attempt, including rejected probes", async (t) => {
  const dir = home(t);
  const updates = [];
  let calls = 0;
  const result = await probeAccount({
    account: "fake@example.test", config: { ...DEFAULT_CONFIG, probes: 3, probeAttempts: 3 },
    bank: {}, gateway: "http://never-contact.invalid", runDir: dir, log: () => {},
    onProgress: (progress) => updates.push(progress),
  }, {
    generateChallenges: () => [{ id: "one", expected_count: 100 }, { id: "two", expected_count: 100 }, { id: "three", expected_count: 100 }],
    runProbe: async () => ({ ok: ++calls > 1, text: calls > 1 ? Array(100).fill(42).join(" ") : "", ms: 1, exitCode: 0 }),
  });
  assert.equal(result.verdict, "error"); // Two accepted answers aren't enough; no fingerprinting or real probe.
  assert.deepEqual(updates.map((item) => item.attempts), [1, 2, 3]);
  assert.deepEqual(updates.map((item) => item.accepted), [0, 1, 2]);
});

test("failure is visible from startup through final status and releases the lock", async (t) => {
  home(t);
  const { dependencies, snapshots, probed } = scanFakes({ healthcheck: async () => false });
  const run = await runScan({ scope: "all" }, dependencies);
  assert.equal(run.status, "failed");
  assert.equal(probed.length, 0);
  assert.equal(snapshots[0].running, true);
  const status = statusReport();
  assert.equal(status.running, false);
  assert.equal(status.lastRun.status, "failed");
  assert.equal(status.progress.phase, "failed");
  assert.match(status.lastRun.error, /healthcheck failed/);
  assert.ok(status.lastRun.finishedAt);
});

test("bank loading failure is recorded after initial progress and releases the lock", async (t) => {
  home(t);
  const { dependencies, snapshots } = scanFakes({ loadBank: () => { throw new Error("broken fixture bank"); } });
  const run = await runScan({ scope: "enabled" }, dependencies);
  assert.equal(run.status, "failed");
  assert.equal(snapshots[0].progress.phase, "starting");
  assert.equal(statusReport().running, false);
});

test("provider-off enabled scans probe nothing and preserve its switch", async (t) => {
  home(t);
  const { dependencies, probed, switches, providers } = scanFakes({ providerOff: () => true });
  const run = await runScan({ scope: "enabled" }, dependencies);
  assert.equal(run.status, "done");
  assert.equal(statusReport().progress.total, 0);
  assert.deepEqual(probed, []);
  assert.deepEqual(switches, []);
  assert.deepEqual(providers, []);
});

test("dry run skips disabled targets without changing account switches", async (t) => {
  home(t);
  const { dependencies, probed, switches, providers } = scanFakes();
  const run = await runScan({ scope: "all", overrides: { dryRun: true } }, dependencies);
  assert.equal(run.status, "done");
  assert.deepEqual(probed, ["enabled@example.test"]);
  assert.deepEqual(switches, []);
  assert.deepEqual(providers, []);
  assert.equal(statusReport().progress.completed, 3);
});

test("all-risk still switches the provider off; failed temporary accounts are not left enabled", async (t) => {
  home(t);
  const { dependencies, providers } = scanFakes({
    probeAccount: async ({ account }) => ({ user: account, verdict: account.startsWith("enabled") ? "risk" : "error", probability: 1, displayName: "Fake" }),
  });
  const run = await runScan({ scope: "all" }, dependencies);
  assert.equal(run.status, "done");
  assert.deepEqual(run.enabledAfter, []);
  assert.deepEqual(providers.at(-1), ["codex", false]);
});

test("status marks zombie runs interrupted, omits credentials/raw data, and does not mutate stored state", (t) => {
  home(t);
  const state = {
    accounts: { "fake@example.test": { verdict: "error", enabledAfter: true, error: "token secret-key", outputs: "raw secret", accessToken: "token" } },
    slots: { fixture: { status: "done", gatewayKey: "hidden" } },
    lastRun: { id: "dead", status: "running", startedAt: new Date().toISOString(), lockToken: "private-nonce", config: { gatewayKey: "hidden" }, progress: { phase: "probe", totalAccounts: 2, completedAccounts: 1, currentAccount: "fake@example.test" } },
  };
  const report = statusReport(10, {
    loadState: () => state,
    loadConfig: () => ({ ...DEFAULT_CONFIG, gatewayKey: "secret-key", gatewayUrl: "http://user:password@localhost", extraSecret: "never-return" }),
    readLock: () => ({ running: false, held: { pid: 999 } }),
    recentRuns: () => [],
  });
  assert.equal(report.running, false);
  assert.equal(report.lastRun.status, "interrupted");
  assert.equal(report.progress.phase, "interrupted");
  assert.equal(report.progress.currentAccount, null);
  assert.equal(state.lastRun.status, "running");
  const json = JSON.stringify(report);
  for (const secret of ["gatewayKey", "gatewayUrl", "secret-key", "password", "accessToken", "outputs", "private-nonce", "never-return"]) assert.equal(json.includes(secret), false, secret);
  assert.equal(report.accounts["fake@example.test"].error, "token [redacted]");
});

test("status replaces an old result with startup immediately and records early child failure", async (t) => {
  const { controller, locks, children } = fakeLauncher(t);
  saveState({ accounts: {}, slots: {}, lastRun: { id: "previous", status: "done" } });
  const pending = controller.start({ scope: "all" });
  const getStatus = () => statusReport(10, { readLock: locks.readLock });
  assert.equal(getStatus().running, true);
  assert.equal(getStatus().progress.phase, "starting");
  assert.equal(getStatus().lastRun.status, "running");
  assert.equal(getStatus().lastRun.scope, "all");
  await pending;
  children[0].emit("close", 1);
  assert.equal(getStatus().running, false);
  assert.equal(getStatus().lastRun.status, "failed");
  assert.match(getStatus().lastRun.error, /code 1/);
});

test("runScan busy never calls provider dependencies and invalid scope never acquires", async (t) => {
  home(t);
  const { dependencies, probed } = scanFakes({ tryAcquire: () => ({ busy: true, held: { pid: 123 } }), loadBank: () => assert.fail("must not load bank") });
  assert.equal((await runScan({ scope: "all" }, dependencies)).skipped, true);
  assert.deepEqual(probed, []);
  await assert.rejects(runScan({ scope: "invalid" }, dependencies), /scope must/);
});
