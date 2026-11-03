// Manual button/tool entry point. The actual work stays in the existing CLI
// and runScan orchestration, including its account-switching policy.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, saveState, stateDir } from "./config.mjs";
import { tryAcquire } from "./lock.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function publicLock(held) {
  if (!held) return null;
  return {
    pid: held.pid ?? null,
    scope: held.scope ?? null,
    trigger: held.trigger ?? null,
    startedAt: held.startedAt ?? null,
    phase: held.phase ?? "running",
  };
}

export function createManualController({
  spawnProcess = spawn,
  acquire = tryAcquire,
  getStateDir = stateDir,
  readState = loadState,
  writeState = saveState,
  cli = path.join(ROOT, "bin", "codex-route-monitor.mjs"),
  cwd = ROOT,
  executable = process.execPath,
  env = process.env,
} = {}) {
  async function start(args = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { started: false, busy: false, code: "invalid_arguments", error: "arguments must be an object" };
    }
    const scope = args.scope === undefined ? "enabled" : args.scope;
    if (scope !== "all" && scope !== "enabled") {
      return { started: false, busy: false, code: "invalid_scope", error: "scope must be all or enabled" };
    }
    if (args.dry_run !== undefined && typeof args.dry_run !== "boolean") {
      return { started: false, busy: false, code: "invalid_arguments", error: "dry_run must be a boolean" };
    }
    const dryRun = args.dry_run === true;
    let reservation;
    try {
      reservation = acquire({ scope, trigger: "tool", dryRun }, { reserve: true, claimToken: null });
    } catch (error) {
      return { started: false, busy: false, scope, dryRun, code: "lock_failed", error: String(error?.message ?? error) };
    }
    if (reservation.busy) {
      return { started: false, busy: true, running: true, scope, dryRun, active: publicLock(reservation.held), code: "busy" };
    }
    const release = () => {
      try { reservation.release(); } catch { /* Dead/startup locks are recoverable; cleanup must not crash the host. */ }
    };
    const recordFailure = (message) => {
      try {
        const state = readState();
        if (state.lastRun?.lockToken !== reservation.token || state.lastRun.status !== "running") return;
        state.lastRun.status = "failed";
        state.lastRun.error = message;
        state.lastRun.finishedAt = new Date().toISOString();
        state.lastRun.progress = { ...state.lastRun.progress, phase: "failed", currentAccount: null, updatedAt: state.lastRun.finishedAt };
        writeState(state);
      } catch { /* The tool must still report spawn errors if state IO failed. */ }
    };
    const argv = [cli, "scan", "--scope", scope, "--trigger", "tool"];
    if (dryRun) argv.push("--dry-run");
    try {
      // Record the reservation before spawn: even a child that fails to import
      // the CLI leaves a useful failure, instead of showing yesterday's run.
      const state = readState();
      const startedAt = reservation.held?.startedAt ?? new Date().toISOString();
      state.lastRun = {
        id: `launch-${Date.now()}-${process.pid}`,
        pid: reservation.held?.pid ?? process.pid,
        lockToken: reservation.token,
        scope, trigger: "tool", dryRun,
        startedAt, finishedAt: null, status: "running", error: "", accounts: [],
        progress: { phase: "starting", totalAccounts: null, completedAccounts: 0, currentAccount: null, updatedAt: startedAt },
      };
      writeState(state);
      const child = spawnProcess(executable, argv, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        cwd,
        env: { ...env, CODEX_ROUTE_MONITOR_LOCK_TOKEN: reservation.token },
      });
      // spawn() may return successfully and emit ENOENT/EACCES later. Never
      // report started until its 'spawn' event, and always retain error listeners.
      let warning;
      await new Promise((resolve, reject) => {
        child.once("error", (error) => {
          recordFailure(String(error?.message ?? error));
          release();
          reject(error);
        });
        child.once("close", (code, signal) => {
          recordFailure(`scan process exited before completing (code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""})`);
          release();
        });
        child.once("spawn", () => {
          if (!Number.isInteger(child.pid) || child.pid <= 0) {
            release();
            reject(new Error("spawn returned no child pid"));
            return;
          }
          try {
            reservation.handoff?.(child.pid);
          } catch {
            // Spawning succeeded. Keep the reservation, not an unlocked live
            // child: runScan can still adopt it using the nonce in its env.
            warning = "scan spawned; lock PID handoff failed, awaiting child adoption";
          }
          resolve();
        });
      });
      child.unref();
      return {
        started: true,
        busy: false,
        running: true,
        scope,
        dryRun,
        pid: child.pid,
        stateDir: getStateDir(),
        ...(warning ? { warning } : {}),
        note: "the scan runs as its own process; codex_route_status shows progress and results",
      };
    } catch (error) {
      recordFailure(String(error?.message ?? error));
      release();
      return { started: false, busy: false, running: false, scope, dryRun, code: "spawn_failed", error: String(error?.message ?? error) };
    }
  }
  return { start };
}
