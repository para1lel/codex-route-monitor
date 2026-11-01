// Runs magpie's own CLI. Everything the monitor changes passes through it, so
// the account switches it makes are the same ones the app's account list and
// `magpie provider pool` make — no file of magpie's is written directly.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const MAGPIE_TIMEOUT_MS = 60_000;

export function magpieBin() {
  return process.env.CODEX_ROUTE_MONITOR_MAGPIE?.trim() || "magpie";
}

async function magpie(args, { timeout = MAGPIE_TIMEOUT_MS } = {}) {
  try {
    const { stdout, stderr } = await run(magpieBin(), args, {
      timeout,
      windowsHide: true,
      maxBuffer: 8 << 20,
      env: process.env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `magpie was not found (${magpieBin()}). Put it on PATH or set CODEX_ROUTE_MONITOR_MAGPIE.`,
      );
    }
    return {
      code: typeof error?.code === "number" ? error.code : 1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? String(error?.message ?? error),
    };
  }
}

/** listCodexAccounts is `magpie accounts codex --json`, as data. */
export async function listCodexAccounts() {
  const out = await magpie(["accounts", "codex", "--json"]);
  if (out.code !== 0) {
    throw new Error(`magpie accounts codex --json failed: ${out.stderr.trim() || out.stdout.trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(out.stdout);
  } catch (error) {
    throw new Error(`magpie accounts codex --json did not print JSON: ${String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("magpie accounts codex --json printed no list");
  return parsed
    .filter((account) => account && typeof account.user === "string" && account.user)
    .map((account) => ({
      user: account.user,
      plan: account.plan ?? "",
      on: account.on === true,
      active: account.active === true,
      windows: Array.isArray(account.windows) ? account.windows : [],
    }));
}

/**
 * poolAccounts puts exactly `users` in use, in that order, and the rest out of
 * it: `magpie provider pool codex --accounts a,b`. An empty list cannot be
 * expressed through the CLI (it refuses to name no account), so the caller
 * handles that case itself.
 */
export async function poolAccounts(users, { cap } = {}) {
  const args = ["provider", "pool", "codex", "--accounts", users.join(",")];
  if (cap !== undefined) args.push("--cap", String(cap));
  const out = await magpie(args);
  if (out.code !== 0) {
    throw new Error(`magpie provider pool failed: ${(out.stderr || out.stdout).trim()}`);
  }
  return out.stdout.trim();
}

/** poolText is `magpie provider pool codex` with nothing changed: its report. */
export async function poolText() {
  const out = await magpie(["provider", "pool", "codex"]);
  return out.code === 0 ? out.stdout.trim() : `${out.stderr || out.stdout}`.trim();
}

/**
 * parsePoolText reads `magpie provider pool codex`'s report: one numbered line
 * per account, "on" or "off", then its name.
 */
export function parsePoolText(text) {
  const accounts = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^\s*\d+\.\s+(on|off)\s+(\S+?)\s+·/.exec(line);
    if (match) accounts.push({ user: match[2], enabled: match[1] === "on" });
  }
  return accounts;
}

/**
 * readPool is the accounts of the Codex pool and whether each takes part in
 * it. It comes from `magpie provider pool codex`'s own report, not from
 * `magpie accounts --json`: an account the agent is signed in to always
 * reports `on` there, even when magpie is passing over it (paused), and the
 * pool report is the one that tells the two apart.
 */
export async function readPool() {
  const text = await poolText();
  const accounts = parsePoolText(text);
  if (!accounts.length) {
    throw new Error(`could not read the Codex pool from magpie:\n${text}`);
  }
  return { accounts, text };
}

/**
 * setPoolEnabled puts exactly `users` in use, in that order, and the rest out
 * of it, then checks magpie's own report says so.
 */
export async function setPoolEnabled(users, { attempts = 2 } = {}) {
  const wanted = users.map((user) => user.toLowerCase());
  let last = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await poolAccounts(users);
    const pool = await readPool();
    const enabled = pool.accounts.filter((account) => account.enabled).map((account) => account.user.toLowerCase());
    const same = enabled.length === wanted.length && enabled.every((user) => wanted.includes(user));
    if (same) return pool;
    last = pool.text;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error(
    `magpie did not take the Codex pool it was given (${users.join(", ")} or none):\n${last}`,
  );
}

export async function healthcheck() {
  const out = await magpie(["healthcheck"]);
  return out.code === 0;
}

export async function magpieVersion() {
  const out = await magpie(["--version"]);
  return out.code === 0 ? out.stdout.trim() : "";
}

/**
 * gatewayUrl is where codex sends its requests: MAGPIE_ADDR when magpie's
 * plugin host runs this (it is told its gateway there), else the monitor's own
 * setting, else magpie's default port.
 */
export function gatewayUrl(config = {}) {
  const explicit = config.gatewayUrl || process.env.CODEX_ROUTE_MONITOR_GATEWAY;
  if (explicit) return normaliseGateway(String(explicit));
  const addr = process.env.MAGPIE_ADDR?.trim();
  if (addr) return normaliseGateway(addr);
  return "http://127.0.0.1:3425";
}

function normaliseGateway(addr) {
  const withScheme = /^https?:\/\//.test(addr) ? addr : `http://${addr}`;
  // a gateway listening on every interface is reached on loopback, not at the
  // wildcard address
  return withScheme.replace(/\/\/0\.0\.0\.0([:/])/, "//127.0.0.1$1").replace(/\/\/\[::\]([:/])/, "//127.0.0.1$1").replace(/\/+$/, "");
}
