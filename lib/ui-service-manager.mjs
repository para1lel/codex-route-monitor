// A plugin-host lease owns the daemon, not its lifetime. The process and every
// scan run from immutable snapshots and are independent of the plugin folder.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { stateDir } from "./config.mjs";
import { createLockManager } from "./lock.mjs";
import { isUIRuntimeSourceCurrent } from "./ui-runtime.mjs";
import { UI_APP, UI_PROTOCOL, UI_MANAGER_HEADER, UI_DEFAULT_PORT, validateUIPort, getUIServiceKeys, uiActivationPath, atomicUIJSON, readUIJSON } from "./ui-service.mjs";

const managers = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (message, code) => Object.assign(new Error(message), { code });
function compareVersion(a, b) {
  const x = String(a).split(/[.-]/).slice(0, 3).map(Number), y = String(b).split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) { if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) return 0; if (x[i] !== y[i]) return x[i] - y[i]; }
  return 0;
}
export function requestUIManager(port, managerKey, route = "/health", { method = "GET", timeoutMs = 1200 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method, agent: false, headers: { [UI_MANAGER_HEADER]: managerKey, "Connection": "close" } }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; if (text.length > 16 * 1024) req.destroy(failure("Unexpected service at UI port", "EUI_PORT_IN_USE")); });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(failure(`UI port ${port} is occupied by an unrecognized or unauthorized service`, "EUI_PORT_IN_USE"));
        try { resolve(JSON.parse(text)); } catch { reject(failure(`UI port ${port} did not return a manager response`, "EUI_PORT_IN_USE")); }
      });
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(failure(`UI port ${port} did not answer manager authorization`, "EUI_PORT_IN_USE")));
    req.once("error", error => error.code === "ECONNREFUSED" ? resolve(null) : reject(error));
    req.end();
  });
}
async function healthAt(port, key, timeoutMs) {
  const value = await requestUIManager(port, key, "/health", { timeoutMs });
  if (value && (value.app !== UI_APP || value.protocol !== UI_PROTOCOL || !Number.isInteger(value.pid) || typeof value.buildId !== "string" || typeof value.version !== "string")) throw failure(`UI port ${port} belongs to another service`, "EUI_PORT_IN_USE");
  return value;
}
function gatewayPorts(env, dir) {
  const ports = [];
  try { const u = new URL(readUIJSON(path.join(dir, "config.json"))?.gatewayUrl); if (["127.0.0.1", "localhost"].includes(u.hostname) && u.port) ports.push(Number(u.port)); } catch { /* no explicit gateway URL */ }
  const match = String(env.MAGPIE_ADDR || "").match(/:(\d+)$/); if (match) ports.push(Number(match[1]));
  return ports;
}

export async function startUIService({ runtime, port = UI_DEFAULT_PORT, dir = stateDir(), executable = process.execPath, env = process.env, spawnProcess = spawn, watchMs = 3000, leaseGraceMs = 60_000, readyTimeoutMs = 8000, healthTimeoutMs = 1000, onError = () => {} } = {}) {
  if (!runtime?.root || !runtime.buildId || !runtime.version) throw new Error("prepareUIRuntime must run before startUIService");
  dir = path.resolve(dir);
  port = validateUIPort(port, { forbiddenPorts: gatewayPorts(env, dir) });
  const key = `${dir}\0${port}\0${runtime.buildId}`;
  if (managers.has(key)) return managers.get(key);
  const promise = makeManager(); managers.set(key, promise);
  try { return await promise; } catch (error) { if (managers.get(key) === promise) managers.delete(key); throw error; }

  async function makeManager() {
    const keys = getUIServiceKeys(dir), activationFile = uiActivationPath(dir);
    // Existing tested nonce/PID locks live in a UI-only namespace. The real
    // monitor's stateDir/scan.lock is never acquired or modified here.
    const locks = createLockManager({ dir: path.join(dir, "ui-service-startup") });
    const generation = crypto.randomBytes(24).toString("hex");
    let disposed = false, superseded = false, timer, inFlight, currentHealth;
    const owns = () => readUIJSON(activationFile)?.generation === generation;
    const stopWatch = () => {
      clearInterval(timer); timer = undefined;
      if ((disposed || superseded) && managers.get(key) === promise) managers.delete(key);
    };
    const heartbeat = () => {
      const active = readUIJSON(activationFile);
      if (active?.generation !== generation) { superseded = true; stopWatch(); return false; }
      atomicUIJSON(activationFile, { ...active, heartbeatAt: Date.now() }); return true;
    };
    const guard = async fn => {
      const deadline = Date.now() + readyTimeoutMs;
      let lock;
      do {
        lock = locks.tryAcquire({ kind: "ui-service-startup", port }, { claimToken: null });
        if (!lock.busy) break;
        if (Date.now() >= deadline) throw failure("UI service startup is already owned by another live process", "EUI_START_BUSY");
        await pause(25);
      } while (true);
      try { return await fn(deadline); } finally { lock.release(); }
    };
    const stopOwned = async (oldPort, deadline) => {
      try { await requestUIManager(oldPort, keys.managerKey, "/internal/shutdown", { method: "POST", timeoutMs: healthTimeoutMs }); }
      catch (error) { if (!["ECONNRESET", "EPIPE", "ECONNREFUSED"].includes(error.code)) throw error; }
      while (Date.now() < deadline) {
        try { if (!await healthAt(oldPort, keys.managerKey, healthTimeoutMs)) return; }
        catch (error) { if (!["ECONNRESET", "EPIPE"].includes(error.code)) throw error; }
        await pause(40);
      }
      throw failure("Owned UI service did not stop in time; no PID was killed", "EUI_STOP_TIMEOUT");
    };
    const spawnDaemon = async deadline => {
      const child = spawnProcess(executable, [path.join(runtime.root, "bin/codex-route-monitor-ui.mjs"), "--port", String(port)], {
        detached: true, stdio: "ignore", windowsHide: true, cwd: runtime.root,
        env: { ...env, CODEX_ROUTE_MONITOR_HOME: dir, CODEX_MONITOR_UI_LEASE_GRACE_MS: String(leaseGraceMs) },
      });
      let childError;
      await new Promise((resolve, reject) => {
        child.once("error", error => { childError = error; reject(error); });
        child.once("spawn", () => Number.isInteger(child.pid) && child.pid > 0 ? resolve() : reject(new Error("UI daemon spawn returned no PID")));
      });
      child.on("error", error => { childError = error; });
      child.unref();
      let exited = false;
      child.once("exit", () => { exited = true; });
      while (Date.now() < deadline) {
        if (childError) throw childError;
        if (disposed || !heartbeat()) throw failure("UI startup owner was superseded", "EUI_SUPERSEDED");
        const health = await healthAt(port, keys.managerKey, Math.min(healthTimeoutMs, Math.max(50, deadline - Date.now())));
        if (health) {
          if (health.buildId !== runtime.buildId) throw failure("Another owned runtime answered this UI port", "EUI_WRONG_RUNTIME");
          currentHealth = health;
          atomicUIJSON(path.join(dir, `ui-service-${port}.json`), { ...health, root: runtime.root, port, generation, updatedAt: Date.now() });
          return health;
        }
        if (exited) throw failure("UI daemon exited before becoming ready", "EUI_DAEMON_EXIT");
        await pause(50);
      }
      throw failure("UI service did not become ready within the startup deadline", "EUI_READY_TIMEOUT");
    };
    const ensureLocked = async deadline => {
      if (disposed || superseded || !owns()) { superseded = !disposed; stopWatch(); return { superseded: true }; }
      heartbeat();
      const health = await healthAt(port, keys.managerKey, healthTimeoutMs);
      if (health?.buildId === runtime.buildId) { currentHealth = health; return health; }
      if (health) {
        if (compareVersion(health.version, runtime.version) > 0) { superseded = true; stopWatch(); return { superseded: true }; }
        await stopOwned(port, deadline);
      }
      return spawnDaemon(deadline);
    };
    const ensure = () => {
      if (disposed || superseded) return Promise.resolve({ superseded: true });
      if (inFlight) return inFlight;
      inFlight = guard(ensureLocked).finally(() => { inFlight = undefined; }); return inFlight;
    };
    const dispose = async () => {
      if (disposed) return;
      disposed = true; stopWatch();
      // Serialize token recheck and write with new activations; a late old
      // disposer must never overwrite a newer host's pointer.
      await guard(async () => {
        const active = readUIJSON(activationFile);
        if (active?.generation === generation) atomicUIJSON(activationFile, { ...active, enabled: false, heartbeatAt: Date.now() });
      });
      if (managers.get(key) === promise) managers.delete(key);
    };
    try {
      await guard(async deadline => {
        const previous = readUIJSON(activationFile);
        const sourceCurrent = isUIRuntimeSourceCurrent(runtime);
        if (sourceCurrent === false || (previous && previous.buildId !== runtime.buildId && (compareVersion(previous.version, runtime.version) > 0 || (sourceCurrent === null && Date.parse(previous.createdAt) > Date.parse(runtime.createdAt))))) throw failure("A newer UI runtime is active or the source package changed; old manager must not replace it", "EUI_SUPERSEDED");
        // Health is checked before activation so a foreign server is never
        // adopted, shut down, or replaced even after a stale metadata file.
        let health = await healthAt(port, keys.managerKey, healthTimeoutMs);
        if (health && compareVersion(health.version, runtime.version) > 0) throw failure("A newer UI runtime already owns this port", "EUI_SUPERSEDED");
        if (previous?.port && previous.port !== port) {
          const oldHealth = await healthAt(previous.port, keys.managerKey, healthTimeoutMs);
          if (oldHealth) await stopOwned(previous.port, deadline);
        }
        atomicUIJSON(activationFile, { protocol: UI_PROTOCOL, generation, buildId: runtime.buildId, version: runtime.version, root: runtime.root, sourceRoot: runtime.sourceRoot, createdAt: runtime.createdAt, port, ownerPid: process.pid, enabled: true, heartbeatAt: Date.now() });
        if (health && health.buildId !== runtime.buildId) { await stopOwned(port, deadline); health = null; }
        currentHealth = health || await spawnDaemon(deadline);
        atomicUIJSON(path.join(dir, `ui-service-${port}.json`), { ...currentHealth, root: runtime.root, port, generation, updatedAt: Date.now() });
      });
      timer = setInterval(() => { ensure().catch(error => { try { onError(error); } catch { /* callbacks must not crash the host */ } }); }, watchMs);
      timer.unref?.();
      return { runtime, port, ready: Promise.resolve(currentHealth), ensure, health: () => healthAt(port, keys.managerKey, healthTimeoutMs), dispose };
    } catch (error) { await dispose(); throw error; }
  }
}
