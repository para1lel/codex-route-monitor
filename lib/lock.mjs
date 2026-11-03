// The schedule, CLI and manual buttons share one scan lock. Manual launches
// reserve it before spawning; only the child holding the nonce may adopt it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, stateDir } from "./config.mjs";

const STARTUP_MS = 60_000;

function alive(pid, host) {
  if (!Number.isInteger(pid) || pid <= 0 || (host && host !== os.hostname())) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Injectable for tests; production always uses the same state directory.
export function createLockManager({ dir = stateDir, pid = process.pid, host = os.hostname(), isAlive = alive, now = Date.now } = {}) {
  const file = () => path.join(ensureDir(typeof dir === "function" ? dir() : dir), "scan.lock");
  const read = (name) => {
    try { return JSON.parse(fs.readFileSync(name, "utf8")); } catch { return null; }
  };
  const live = (held) => Boolean(held) && isAlive(held.pid, held.host) &&
    (held.phase !== "starting" || now() - Date.parse(held.startedAt) < STARTUP_MS);
  const write = (name, held) => {
    const tmp = `${name}.${pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(held, null, 2)}\n`);
    fs.renameSync(tmp, name);
  };

  // Serialize stale removal and ownership changes too: competing processes must
  // never unlink a new owner's lock after both observed the same dead owner.
  function guarded(action, lockFile = file()) {
    const name = `${lockFile}.guard`;
    try {
      fs.mkdirSync(name);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = read(path.join(name, "owner.json"));
      let old = false;
      try { old = now() - fs.statSync(name).mtimeMs > 30_000; } catch { /* another owner released */ }
      if (old && (!owner || !isAlive(owner.pid, owner.host))) {
        try { fs.rmSync(name, { recursive: true, force: true }); } catch { /* another contender won */ }
        // A contender may already own the replacement: mkdir is still the gate.
        return guarded(action, lockFile);
      }
      return { busy: true, contended: true, held: read(lockFile) };
    }
    try {
      fs.writeFileSync(path.join(name, "owner.json"), JSON.stringify({ pid, host }));
      return action();
    } finally {
      fs.rmSync(name, { recursive: true, force: true });
    }
  }

  function eventually(action, lockFile) {
    const result = guarded(action, lockFile);
    if (result?.busy) {
      // A competing acquire only holds the guard for synchronous file IO. Do
      // not leave a live owner's scan lock stuck just because release collided.
      const timer = setTimeout(() => {
        if (!fs.existsSync(lockFile)) return;
        try { eventually(action, lockFile); } catch { /* The owner's exit makes any leftover lock stale. */ }
      }, 10);
      timer.unref?.();
    }
    return result;
  }

  function handle(held) {
    const lockFile = file();
    return {
      file: lockFile,
      token: held.token,
      held,
      release: () => fs.existsSync(lockFile) ? eventually(() => {
        if (read(lockFile)?.token === held.token) fs.rmSync(lockFile, { force: true });
      }, lockFile) : undefined,
      handoff: (childPid) => guarded(() => {
        const current = read(lockFile);
        if (current?.token === held.token && current.phase === "starting") {
          write(lockFile, { ...current, pid: childPid });
        }
      }, lockFile),
    };
  }

  function tryAcquire(info = {}, { reserve = false, claimToken = process.env.CODEX_ROUTE_MONITOR_LOCK_TOKEN } = {}) {
    return guarded(() => {
      const held = read(file());
      if (claimToken && held?.token === claimToken && held.phase === "starting") {
        const adopted = { ...held, ...info, pid, host, phase: "running" };
        write(file(), adopted);
        return handle(adopted);
      }
      if (live(held)) return { busy: true, held, file: file() };
      const next = {
        ...info,
        pid,
        host,
        startedAt: new Date(now()).toISOString(),
        phase: reserve ? "starting" : "running",
        token: randomUUID(),
      };
      write(file(), next);
      return handle(next);
    });
  }

  function readLock() {
    const held = read(file());
    const running = live(held);
    return { running, held, stale: Boolean(held) && !running };
  }
  return { tryAcquire, readLock, lockHeld: () => readLock().running };
}

const locks = createLockManager();
export const tryAcquire = (...args) => locks.tryAcquire(...args);
export const readLock = () => locks.readLock();
export const lockHeld = () => locks.lockHeld();
