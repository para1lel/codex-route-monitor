#!/usr/bin/env node
// codex-route-monitor: the monitor's own command line, used by the schedule
// installers and by hand. Everything the plugin's tools do is here too.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  loadState,
  saveState,
  stateDir,
  statePath,
} from "../lib/config.mjs";
import { bankSummary, loadBank } from "../lib/bank.mjs";
import { runScan, statusReport } from "../lib/core.mjs";
import { dueSlot, schedulePlan, startScheduler } from "../lib/schedule.mjs";
import { gatewayUrl, healthcheck, listCodexAccounts, magpieVersion, readPool } from "../lib/magpie.mjs";
import { codexVersion, resolveCodex } from "../lib/probe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "codex-route-monitor.mjs");

const USAGE = `codex-route-monitor — Codex account routing monitor for magpie

  scan [--scope all|enabled|auto] [--dry-run] [--trigger <why>] [--slot <key>] [--json]
                        probe Codex accounts and set which are in use:
                        all — every account; enabled — the accounts in use;
                        auto — whatever the schedule says is due now (default)
  status [--json]       what the last runs came to, per account and per slot
  probe --account <email> [--json]
                        ask one account and print the diagnosis, changing nothing
  doctor                check magpie, the gateway, codex, the bank and the schedule
  schedule [--print]    the slots around now, in local time
  schedule --serve      run the schedule in this process (for an OS service)
  config [--json]       the settings in use, and where they are kept
  bank [--json]         the fingerprint bank's models and calibration
  install-schedule [--dry-run]
                        install an OS schedule that calls \`scan --scope auto\`
                        (Windows Task Scheduler, or systemd --user timers)
  uninstall-schedule    remove it
  version               print the version

Settings live in ` +
  stateDir() +
  `/config.json; the next run uses them without a restart.
`;

function parseFlags(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      flags._.push(item);
      continue;
    }
    const name = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

async function commandScan(flags) {
  const scope = flags.scope ?? "auto";
  const echo = flags.json !== true;
  if (!["all", "enabled", "auto"].includes(scope)) {
    throw new Error(`--scope takes all, enabled or auto, not ${JSON.stringify(scope)}`);
  }
  if (scope === "auto") {
    const config = loadConfig();
    const now = new Date();
    const slot = dueSlot(config, now);
    if (!slot) {
      const plan = schedulePlan(config, now).filter(
        (item) => item.status === "pending" && new Date(item.at) > now,
      );
      if (echo) {
        console.log("nothing is due: the schedule has no slot to run now");
        if (plan.length) console.log(`next: ${plan[0].slot} (${plan[0].scope})`);
      }
      return 0;
    }
    const state = loadState();
    state.slots ??= {};
    state.slots[slot.key] = { status: "running", at: now.toISOString(), scope: slotScope(config, slot.hour) };
    saveState(state);
    const run = await runScan({
      scope: slotScope(config, slot.hour),
      trigger: flags.trigger ?? "schedule",
      slot: slot.key,
      overrides: {},
      echo,
    });
    if (flags.json === true) printRunJSON(run);
    return run.status === "done" ? 0 : 1;
  }
  const run = await runScan({
    scope,
    trigger: flags.trigger ?? "manual",
    slot: flags.slot ?? null,
    overrides: { dryRun: flags["dry-run"] === true },
    echo,
  });
  if (flags.json === true) printRunJSON(run);
  return run.status === "done" || run.skipped ? 0 : 1;
}

function slotScope(config, hour) {
  return hour === (config.slots[0] ?? 0) ? "all" : "enabled";
}

function printRunJSON(run) {
  console.log(
    JSON.stringify(
      {
        ...run,
        accounts: (run.accounts ?? []).map((account) => ({
          user: account.user,
          verdict: account.verdict,
          model: account.model ?? null,
          probability: account.probability ?? null,
          enabledAfter: account.enabledAfter ?? null,
          error: account.error ?? null,
        })),
      },
      null,
      2,
    ),
  );
}

function commandStatus(flags) {
  const report = statusReport();
  const config = loadConfig();
  if (flags.json === true) {
    console.log(JSON.stringify({ ...report, schedule: schedulePlan(config) }, null, 2));
    return 0;
  }
  console.log(`state: ${report.stateDir}`);
  console.log(`model: ${config.model} · effort: ${config.effort} · probes: ${config.probes}`);
  console.log(
    `schedule: ${config.slots.map((hour) => `${String(hour).padStart(2, "0")}:00`).join(", ")} (local)${
      config.scheduler ? "" : " — scheduler off"
    }`,
  );
  const last = report.lastRun;
  console.log(
    last
      ? `last run: ${last.id} (${last.scope}) ${last.status}${last.finishedAt ? ` · finished ${last.finishedAt}` : ""}`
      : "last run: none yet",
  );
  if (last?.accounts?.length) {
    for (const account of last.accounts) {
      console.log(`  ${account.user.padEnd(28)} ${account.verdict.padEnd(6)} ${account.model ?? ""}`);
    }
  }
  const plan = schedulePlan(config);
  const upcoming = plan.filter((item) => item.status === "pending").slice(0, 3);
  if (upcoming.length) {
    console.log("next slots:");
    for (const item of upcoming) console.log(`  ${item.slot}  ${item.scope}`);
  }
  return 0;
}

async function commandDoctor() {
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok, detail });
  let version = "";
  try {
    version = await magpieVersion();
    check("magpie", version.length > 0, version);
  } catch (error) {
    check("magpie", false, String(error?.message ?? error));
  }
  try {
    check("magpie gateway answers", await healthcheck(), gatewayUrl(loadConfig()));
  } catch (error) {
    check("magpie gateway answers", false, String(error?.message ?? error));
  }
  try {
    const accounts = await listCodexAccounts();
    check("Codex accounts", accounts.length > 0, `${accounts.length} account(s)`);
    const pool = await readPool();
    check(
      "Codex pool readable",
      true,
      pool.accounts.map((account) => `${account.user}=${account.enabled ? "on" : "off"}`).join(" "),
    );
  } catch (error) {
    check("Codex accounts", false, String(error?.message ?? error));
  }
  try {
    const config = loadConfig();
    const bank = loadBank();
    const summary = bankSummary(bank);
    check("fingerprint bank", summary.models.length > 0, `${summary.models.length} models, β ${bank.calibration["3"]?.beta}`);
    check("model asked for", config.model.length > 0, `${config.model} at effort ${config.effort}`);
  } catch (error) {
    check("fingerprint bank", false, String(error?.message ?? error));
  }
  const codex = codexVersion();
  check("codex CLI", codex.length > 0, `${codex} (${resolveCodex()})`);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.accessSync(stateDir(), fs.constants.W_OK);
  check("state directory is writable", true, statePath());

  for (const item of checks) {
    console.log(`${item.ok ? "ok  " : "FAIL"} ${item.name}${item.detail ? `: ${item.detail}` : ""}`);
  }
  return checks.every((item) => item.ok) ? 0 : 1;
}

function commandSchedule(flags) {
  const config = loadConfig();
  if (flags.serve === true) {
    const result = startScheduler({ echo: true, config });
    console.log(JSON.stringify(result));
    setInterval(() => {}, 1 << 30); // stay up while the OS service says so
    return 0;
  }
  const plan = schedulePlan(config);
  if (flags.json === true) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  for (const item of plan) console.log(`${item.slot}  ${item.scope.padEnd(7)} ${item.status}`);
  return 0;
}

function commandConfig(flags) {
  const config = loadConfig();
  if (flags.json === true) {
    console.log(JSON.stringify({ config, dir: stateDir() }, null, 2));
    return 0;
  }
  console.log(`settings: ${path.join(stateDir(), "config.json")}`);
  console.log(JSON.stringify(config, null, 2));
  return 0;
}

function commandBank(flags) {
  const summary = bankSummary();
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

/**
 * probe asks one account and prints the diagnosis, changing nothing: the way
 * to see what a scan would say before a scan turns anything off.
 */
async function commandProbe(flags) {
  const account = typeof flags.account === "string" ? flags.account : "";
  const pin = flags["no-pin"] !== true;
  if (!account) throw new Error("probe needs --account <email> (or --no-pin, to ask magpie for the model as it is)");
  const overrides = {};
  if (typeof flags.model === "string") overrides.model = flags.model;
  if (typeof flags.effort === "string") overrides.effort = flags.effort;
  if (typeof flags.probes === "string") overrides.probes = Number(flags.probes);
  const config = loadConfig(overrides);
  const { probeAccount } = await import("../lib/core.mjs");
  const runDir = path.join(stateDir(), "probe", stampName());
  const gateway = gatewayUrl(config);
  const label = pin ? account : config.model;
  console.log(`probing ${label} at ${gateway} with ${config.model} (effort ${config.effort}, ${config.probes} challenges)`);
  const result = await probeAccount({
    account: pin ? account : "",
    config,
    bank: loadBank(),
    gateway,
    runDir,
    log: (line) => console.log(line),
  });
  fs.rmSync(runDir, { recursive: true, force: true });
  if (flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return result.verdict === "error" ? 1 : 0;
  }
  if (result.verdict === "error") {
    console.log(`could not diagnose ${account}: ${result.error}`);
    return 1;
  }
  console.log(`\n${account}: ${result.verdict.toUpperCase()} — ${result.displayName} ${(result.probability * 100).toFixed(1)}%`);
  console.log(`luna probability ${(result.lunaProbability * 100).toFixed(1)}% · family ${result.familyName} ${(result.familyProbabilities.find((item) => item.family === result.family)?.probability * 100).toFixed(1)}%`);
  for (const item of result.top) console.log(`  ${(item.probability * 100).toFixed(1).padStart(5)}%  ${item.model}`);
  if (result.verdict === "risk") console.log(`\n${result.note}`);
  return 0;
}

function stampName() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function commandInstall(flags, uninstall = false) {
  const script = process.platform === "win32" ? "install-schedule.ps1" : "install-schedule.sh";
  const file = path.join(HERE, "..", "scripts", script);
  const { spawn } = await import("node:child_process");
  const cli = typeof flags.cli === "string" ? path.resolve(flags.cli) : CLI;
  const node = typeof flags.node === "string" ? path.resolve(flags.node) : process.execPath;
  const args =
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          file,
          "-Cli",
          cli,
          "-Node",
          node,
          ...(uninstall ? ["-Uninstall"] : []),
          ...(flags["dry-run"] === true ? ["-DryRun"] : []),
        ]
      : [
          file,
          ...(uninstall ? ["--uninstall"] : []),
          "--cli",
          cli,
          "--node",
          node,
          ...(flags["dry-run"] === true ? ["--dry-run"] : []),
        ];
  const bin = process.platform === "win32" ? "powershell.exe" : "bash";
  const code = await new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "inherit", windowsHide: true });
    child.on("close", (status) => resolve(status ?? 1));
    child.on("error", (error) => {
      console.error(String(error));
      resolve(1);
    });
  });
  return code;
}

async function main(argv) {
  const flags = parseFlags(argv);
  const command = flags._[0] ?? "status";
  switch (command) {
    case "scan":
      return commandScan(flags);
    case "status":
      return commandStatus(flags);
    case "doctor":
      return commandDoctor(flags);
    case "schedule":
      return commandSchedule(flags);
    case "config":
      return commandConfig(flags);
    case "bank":
      return commandBank(flags);
    case "probe":
      return commandProbe(flags);
    case "install-schedule":
      return commandInstall(flags, false);
    case "uninstall-schedule":
      return commandInstall(flags, true);
    case "version": {
      const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
      console.log(pkg.version);
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`no command ${JSON.stringify(command)}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    console.error(`codex-route-monitor: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
