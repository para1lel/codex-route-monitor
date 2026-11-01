// Probing one account: a non-interactive `codex exec` that asks for one
// ModelTrace challenge, sent through magpie's gateway and pinned to a single
// Codex account with the X-Magpie-Account header.
//
// Why pinned and not "just let magpie route it": a diagnosis is about one
// account. magpie's routing would spread the three probes over whichever
// accounts are in use, and the answer would say nothing about the account the
// scan is asking about. The header is magpie's own way of naming one account,
// so nothing has to be toggled while a probe runs.
//
// Why through the gateway at all: magpie holds each account's sign-in and
// renews it. Copying tokens into a throwaway CODEX_HOME would run the risk of
// rotating a refresh token magpie still has, and would sign magpie's account
// state out.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./config.mjs";

const OUTPUT_LIMIT = 64 << 10;

export function resolveCodex() {
  const explicit = process.env.CODEX_ROUTE_MONITOR_CODEX?.trim();
  if (explicit) return explicit;
  return findOnPath(process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"]) ??
    (process.platform === "win32" ? "codex.exe" : "codex");
}

// findOnPath walks PATH in order and, in each folder, tries the names in turn:
// the CLI a person gets when they type `codex` is the first one on PATH, which
// may be a .cmd wrapper beside an older .exe from another install.
function findOnPath(names) {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not there
      }
    }
  }
  return null;
}

// A .cmd or .bat wrapper is not a program Windows can start directly: it goes
// through the command interpreter, with every argument quoted.
function needsShell(file) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
}

function quoteArg(value) {
  const text = String(value);
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

export function spawnCodex(args, options) {
  const bin = resolveCodex();
  if (needsShell(bin)) {
    const line = [quoteArg(bin), ...args.map(quoteArg)].join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], options);
  }
  return spawn(bin, args, options);
}

/** codexVersion reports what `codex --version` says, for the doctor command. */
export function codexVersion() {
  const bin = resolveCodex();
  const options = { encoding: "utf8", timeout: 30_000, windowsHide: true };
  try {
    const out = needsShell(bin)
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `${quoteArg(bin)} --version`], options)
      : spawnSync(bin, ["--version"], options);
    return (out.stdout || out.stderr || "").trim();
  } catch {
    return "";
  }
}

/** tomlString quotes a TOML basic string. */
function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** writeCodexHome prepares an isolated CODEX_HOME that talks to magpie only. */
export function writeCodexHome({ dir, config, gateway, account }) {
  ensureDir(dir);
  const headers = account ? { "X-Magpie-Account": account } : {};
  const toml = [
    `model = ${tomlString(config.model)}`,
    `model_provider = "magpie-monitor"`,
    `model_reasoning_effort = ${tomlString(config.effort)}`,
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    `forced_login_method = "chatgpt"`,
    "",
    "[model_providers.magpie-monitor]",
    `name = "magpie"`,
    `base_url = ${tomlString(`${gateway}/v1`)}`,
    `wire_api = "responses"`,
    `experimental_bearer_token = ${tomlString(config.gatewayKey)}`,
    `supports_websockets = false`,
    ...(Object.keys(headers).length
      ? [
          `http_headers = { ${Object.entries(headers)
            .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
            .join(", ")} }`,
        ]
      : []),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "config.toml"), toml);
  // no hooks, plugins or MCP servers: a probe is the model and its prompt
  fs.rmSync(path.join(dir, "hooks.json"), { force: true });
  return dir;
}

function tail(text, limit = 4000) {
  const value = String(text ?? "");
  return value.length > limit ? value.slice(value.length - limit) : value;
}

/**
 * runProbe sends one challenge and returns what the model answered.
 * `challenge` is { id, expected_count, prompt }; the prompt goes in on stdin so
 * that no text of it ever lands on a command line.
 */
export async function runProbe({ account, challenge, config, gateway, workDir, homeDir, timeoutMs }) {
  ensureDir(workDir);
  const outFile = path.join(workDir, `${challenge.id}.md`);
  fs.rmSync(outFile, { force: true });
  writeCodexHome({ dir: homeDir, config, gateway, account });

  const args = [
    "exec",
    "-m",
    config.model,
    "-c",
    `model_reasoning_effort=${config.effort}`,
    "--skip-git-repo-check",
    "--ephemeral",
    "-C",
    workDir,
    "-o",
    outFile,
    "-",
  ];
  const started = Date.now();
  const child = spawnCodex(args, {
    cwd: workDir,
    env: {
      ...process.env,
      CODEX_HOME: homeDir,
      NO_COLOR: "1",
      TERM: "dumb",
      RUST_LOG: process.env.CODEX_ROUTE_MONITOR_DEBUG ? "info" : "error",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString();
  });

  const timer = setTimeout(() => {
    killTree(child);
  }, Math.max(30_000, timeoutMs));

  const exit = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ error }));
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(challenge.prompt);
  });
  clearTimeout(timer);

  const ms = Date.now() - started;
  let text = "";
  try {
    text = fs.readFileSync(outFile, "utf8").trim();
  } catch {
    text = "";
  }
  if (!text) text = lastMessageFromStdout(stdout);

  const timedOut = exit.signal === "SIGKILL" || exit.signal === "SIGTERM";
  const ok = typeof exit.code === "number" && exit.code === 0 && text.length > 0;
  return {
    ok,
    text,
    stdout: tail(stdout),
    stderr: tail(stderr),
    exitCode: exit.code ?? null,
    signal: exit.signal ?? null,
    timedOut,
    ms,
    error: exit.error ? String(exit.error.message ?? exit.error) : "",
  };
}

// lastMessageFromStdout picks the final "codex" block out of codex's plain
// output, for a run that wrote no -o file.
function lastMessageFromStdout(stdout) {
  const marker = /\ncodex\n/;
  const at = stdout.search(marker);
  if (at < 0) return "";
  const rest = stdout.slice(at).replace(marker, "");
  const end = rest.search(/\n(tokens used|--------)\n/);
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        timeout: 15_000,
      });
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}
