// One scan at a time, across processes: the plugin host's timer, a manual
// `codex-route-monitor scan`, and an OS schedule all meet here. A lock file
// with the owner's pid and host is enough — a run that died leaves a lock that
// goes stale, and one still held by a live process is left alone.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir, stateDir } from "./config.mjs";

const STALE_MS = 6 * 60 * 60 * 1000;

function lockPath() {
  return path.join(ensureDir(stateDir()), "scan.lock");
}

function alive(pid, host) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (host && host !== os.hostname()) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** tryAcquire takes the scan lock, or reports who holds it. */
export function tryAcquire(info = {}) {
  const file = lockPath();
  const body = JSON.stringify(
    { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), ...info },
    null,
    2,
  );
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeSync(fd, `${body}\n`);
    fs.closeSync(fd);
    return { release: () => release(file), file };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  let held = null;
  try {
    held = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    held = null;
  }
  const age = held?.startedAt ? Date.now() - Date.parse(held.startedAt) : Infinity;
  const stale = !held || age > STALE_MS || !alive(held.pid, held.host);
  if (stale) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // somebody else removed it
    }
    return tryAcquire(info);
  }
  return { busy: true, held, file };
}

function release(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // already gone
  }
}
