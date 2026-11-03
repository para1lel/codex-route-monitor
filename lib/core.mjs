// One scan: ask magpie who its Codex accounts are, probe each one with three
// ModelTrace challenges through codex itself, attribute the model that
// answered, and put the accounts that are held back out of use (or back in).

import fs from "node:fs";
import path from "node:path";
import { generateChallenges } from "./challenges.mjs";
import { analyzeGlobalOutputs, parseNumbers } from "./fingerprint.mjs";
import { loadBank } from "./bank.mjs";
import {
  ensureDir,
  loadConfig,
  loadState,
  logLine,
  logsDir,
  runsDir,
  saveState,
  slotKey,
  stateDir,
  writeJSON,
} from "./config.mjs";
import {
  gatewayUrl,
  healthcheck,
  listCodexAccounts,
  providerOff,
  readPool,
  setPoolEnabled,
  setProviderOn,
} from "./magpie.mjs";
import { runProbe } from "./probe.mjs";
import { topResults, verdictOf } from "./policy.mjs";
import { readLock, tryAcquire } from "./lock.mjs";
import { publicLock } from "./manual.mjs";

const stamp = (date = new Date()) => {
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function slug(text) {
  return String(text).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
}

function resolveGateway(config) {
  return gatewayUrl(config);
}

function minimumOf(expectedCount) {
  return expectedCount ? Math.max(80, Math.ceil(expectedCount * 0.55)) : 80;
}

/**
 * probeAccount asks config.probes challenges of one account. A response whose
 * list is refused or cut short is asked again (up to probeAttempts tries in
 * all); fewer than `probes` usable answers is an error for the account, so an
 * account is never enabled or disabled on half a diagnosis.
 */
export async function probeAccount({ account, config, bank, gateway, runDir, log, pin = true, onProgress = () => {} }, dependencies = {}) {
  const executeProbe = dependencies.runProbe ?? runProbe;
  const challenges = (dependencies.generateChallenges ?? generateChallenges)(config.probes);
  const label = account || config.model;
  const workDir = path.join(runDir, "work", slug(label));
  const homeDir = path.join(runDir, "codex-home", slug(label));
  const attempts = [];
  const accepted = [];
  let next = 0;
  const startedAt = Date.now();
  const budget = Number(config.accountBudgetMs) > 0 ? Number(config.accountBudgetMs) : 60 * 60_000;
  try {
    while (accepted.length < challenges.length && attempts.length < config.probeAttempts) {
      if (Date.now() - startedAt > budget) {
        log(`  ${account}: out of time after ${attempts.length} tries (${Math.round(budget / 60000)} min an account)`);
        break;
      }
      // a probe that produced nothing in its whole timeout is a stalled
      // connection, not a short answer: two of those are enough to call it
      if (attempts.filter((item) => item.timedOut).length >= 2) {
        log(`  ${account}: two probes timed out without an answer; leaving it at that`);
        break;
      }
      const challenge = challenges[next];
      const probe = await executeProbe({
        account: pin ? account : "",
        challenge,
        config,
        gateway,
        workDir,
        homeDir,
        timeoutMs: config.probeTimeoutMs,
      });
      const numbers = parseNumbers(probe.text);
      const minimum = minimumOf(challenge.expected_count);
      const usable = probe.ok && numbers.length >= minimum;
      attempts.push({
        challenge: challenge.id,
        expected_count: challenge.expected_count,
        ok: probe.ok,
        numbers: numbers.length,
        minimum,
        usable,
        ms: probe.ms,
        exitCode: probe.exitCode,
        timedOut: probe.timedOut,
        error: probe.ok ? "" : probe.error || firstErrorLine(probe),
      });
      log(
        `  probe ${next + 1}/${challenges.length} for ${account}: ${numbers.length}/${minimum} numbers, ${Math.round(probe.ms / 1000)}s${usable ? "" : " — asking again"}`,
      );
      if (usable) {
        accepted.push({ challenge, text: probe.text });
        next += 1;
      }
      onProgress({
        attempts: attempts.length,
        accepted: accepted.length,
        total: challenges.length,
        lastProbe: { ...attempts.at(-1) },
      });
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }

  if (accepted.length < challenges.length) {
    return {
      user: account,
      verdict: "error",
      error: `only ${accepted.length} of ${challenges.length} answers were usable after ${attempts.length} tries`,
      attempts,
    };
  }

  const diagnosis = analyzeGlobalOutputs(
    accepted.map((item) => ({ text: item.text, expected_count: item.challenge.expected_count })),
    bank,
  );
  const verdict = verdictOf(diagnosis, config);
  return {
    user: account,
    verdict: verdict.verdict,
    model: verdict.model,
    displayName: verdict.displayName,
    probability: verdict.probability,
    lunaProbability: verdict.lunaProbability,
    family: verdict.family,
    familyName: verdict.familyName,
    note: verdict.note,
    usedOutputs: diagnosis.used_outputs,
    calibration: diagnosis.calibration,
    familyProbabilities: diagnosis.family_probabilities,
    top: topResults(diagnosis),
    attempts,
    outputs: accepted.map((item) => ({ challenge: item.challenge.id, text: item.text })),
  };
}

function firstErrorLine(probe) {
  const text = `${probe.stderr || ""}\n${probe.stdout || ""}`;
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => /error|failed|refused|429|400|401|403|404|timeout/i.test(item))
    .pop();
  return line ?? (probe.timedOut ? "the probe timed out" : "codex answered with no message");
}

/**
 * runScan is one full pass. scope:
 *   all     — every account magpie knows, in use or not (the midnight run)
 *   enabled — the accounts in use only (the three-hourly runs)
 */
const SCAN_DEPENDENCIES = {
  loadConfig, loadBank, loadState, saveState, tryAcquire,
  healthcheck, providerOff, setProviderOn, listCodexAccounts, readPool, setPoolEnabled,
  probeAccount, sleep,
};

export async function runScan({ scope = "enabled", trigger = "manual", slot = null, overrides = {}, echo = false } = {}, dependencies = {}) {
  if (scope !== "all" && scope !== "enabled") throw new Error("scope must be all or enabled");
  const {
    loadConfig, loadBank, loadState, saveState, tryAcquire,
    healthcheck, providerOff, setProviderOn, listCodexAccounts, readPool, setPoolEnabled,
    probeAccount, sleep,
  } = { ...SCAN_DEPENDENCIES, ...dependencies };
  const config = loadConfig(overrides);
  const started = new Date();
  const runId = stamp(started);
  const runDir = ensureDir(path.join(runsDir(), runId));
  const log = (line) => logLine(`[${runId}] ${line}`, { echo });
  const lockInfo = { scope, trigger, slot, dryRun: config.dryRun === true };
  let lock = tryAcquire(lockInfo);
  // The reserved child can arrive while its parent is handing off the PID.
  // A short guard collision is not another scan: wait to adopt our reservation.
  if (process.env.CODEX_ROUTE_MONITOR_LOCK_TOKEN) {
    const deadline = Date.now() + 5_000;
    while (lock.contended && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      lock = tryAcquire(lockInfo);
    }
  }
  if (lock.busy) {
    log(`another scan is already running (${lock.held?.pid ?? "?"} on ${lock.held?.host ?? "?"}); this one does nothing`);
    // the slot was marked running by the process that started this one: put
    // it back so a later tick runs it once the other scan is done
    if (slot) {
      const state = loadState();
      state.slots ??= {};
      state.slots[slot] = { status: "pending", at: new Date().toISOString(), error: "another scan was running" };
      saveState(state);
    }
    return { skipped: true, reason: "another scan is running", id: runId };
  }

  const state = loadState();
  const run = {
    id: runId,
    pid: process.pid,
    host: lock.held?.host ?? null,
    lockToken: lock.token ?? null,
    progress: {
      phase: "starting",
      totalAccounts: null,
      completedAccounts: 0,
      currentAccount: null,
      probes: null,
      updatedAt: started.toISOString(),
    },
    startedAt: started.toISOString(),
    finishedAt: null,
    scope,
    trigger,
    slot,
    dryRun: config.dryRun === true,
    status: "running",
    gateway: resolveGateway(config),
    model: config.model,
    effort: config.effort,
    probes: config.probes,
    accounts: [],
    enabledBefore: [],
    enabledAfter: [],
    applied: null,
    error: "",
  };

  const flush = () => {
    run.progress.updatedAt = new Date().toISOString();
    run.progress.completedAccounts = run.accounts.length;
    writeJSON(path.join(runDir, "run.json"), run);
    for (const account of run.accounts) {
      state.accounts[account.user] = {
        verdict: account.verdict,
        model: account.model ?? null,
        displayName: account.displayName ?? null,
        probability: account.probability ?? null,
        lunaProbability: account.lunaProbability ?? null,
        enabledAfter: account.enabledAfter ?? null,
        at: run.finishedAt ?? new Date().toISOString(),
        runId,
        error: account.error || undefined,
      };
    }
    state.lastRun = {
      id: runId,
      pid: run.pid,
      host: run.host,
      lockToken: run.lockToken,
      progress: run.progress,
      dryRun: run.dryRun,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      scope,
      trigger,
      status: run.status,
      accounts: run.accounts.map((account) => ({
        user: account.user,
        verdict: account.verdict,
        model: account.model ?? null,
      })),
    };
    saveState(state);
  };

  log(`scan ${runId} (${scope}, ${trigger}${slot ? `, slot ${slot}` : ""}) against ${run.gateway} with ${config.model} at effort ${config.effort}`);

  let wasOff = false;
  let appliedFinal = false;
  try {
    // Publish before any asynchronous gateway/account work (and bank loading).
    flush();
    const bank = loadBank();
    if (!(await healthcheck())) {
      throw new Error("magpie's gateway does not answer (magpie healthcheck failed)");
    }
    // every account held back at the last full pass leaves the Codex
    // subscription switched off: nothing of it may serve. The midnight pass
    // turns it on for its probes and switches it off again if that has not
    // changed; the three-hourly passes have nothing in use to probe.
    wasOff = providerOff("codex");
    if (wasOff && scope !== "all") {
      log("the Codex subscription is switched off (every account was held back at the last full pass); nothing is in use to probe");
      run.status = "done";
      run.finishedAt = new Date().toISOString();
      run.enabledBefore = [];
      run.enabledAfter = [];
      run.progress.totalAccounts = 0;
      run.applied = { users: [], providerOff: true, skipped: "the Codex subscription is off" };
      flush();
      return run;
    }
    if (wasOff) {
      log("switching the Codex subscription on for the probes");
      await setProviderOn("codex", true);
    }
    const detail = await listCodexAccounts();
    if (!detail.length) throw new Error("magpie knows no Codex account");
    const pool = await readPool();
    const order = pool.accounts.map((account) => account.user);
    const known = new Set(order.map((user) => user.toLowerCase()));
    for (const account of detail) {
      if (!known.has(account.user.toLowerCase())) {
        order.push(account.user);
        known.add(account.user.toLowerCase());
      }
    }
    const plans = new Map(detail.map((account) => [account.user.toLowerCase(), account]));
    let enabled = new Set(
      pool.accounts.filter((account) => account.enabled).map((account) => account.user.toLowerCase()),
    );
    // a subscription switched off serves nothing: no account of it is in use,
    // whatever its own switch still says, and one a scan cannot diagnose goes
    // back to not being in use rather than being put back in
    if (wasOff) enabled = new Set();
    const originallyEnabled = new Set(enabled);
    run.enabledBefore = order.filter((user) => enabled.has(user.toLowerCase()));
    const targets = scope === "all" ? order : order.filter((user) => enabled.has(user.toLowerCase()));
    run.progress.totalAccounts = targets.length;
    run.progress.phase = "targets";
    flush();
    if (!targets.length) {
      log("no Codex account to probe");
      run.status = "done";
      run.finishedAt = new Date().toISOString();
      flush();
      return run;
    }
    log(`probing ${targets.length} account(s): ${targets.join(", ")}`);

    const gateway = resolveGateway(config);
    for (const user of targets) {
      const key = user.toLowerCase();
      run.progress.phase = "account";
      run.progress.currentAccount = user;
      run.progress.probes = { attempts: 0, accepted: 0, total: config.probes, lastProbe: null };
      flush();
      // a probe is pinned to one account, and a pinned account has to be one
      // magpie would route to: an account kept out of use is put in for the
      // length of its own probe only
      if (!enabled.has(key)) {
        if (config.dryRun) {
          run.accounts.push({
            user,
            plan: plans.get(key)?.plan ?? "",
            verdict: "error",
            error: "the account is out of use in magpie, and a dry run does not put it back in",
          });
          run.progress.phase = "account_done";
          run.progress.currentAccount = null;
          flush();
          continue;
        }
        const withAccount = order.filter((item) => enabled.has(item.toLowerCase()) || item === user);
        log(`putting ${user} in use for its own probe`);
        await setPoolEnabled(withAccount);
        enabled = new Set(withAccount.map((item) => item.toLowerCase()));
      }
      const accountStarted = Date.now();
      let result;
      try {
        result = await probeAccount({
          account: user, config, bank, gateway, runDir, log,
          onProgress: (probes) => {
            run.progress.phase = "probe";
            run.progress.probes = probes;
            flush();
          },
        });
      } catch (error) {
        result = { user, verdict: "error", error: String(error?.message ?? error) };
      }
      result.plan = plans.get(key)?.plan ?? "";
      result.ms = Date.now() - accountStarted;
      result.enabledBefore = enabled.has(key);
      if (result.verdict === "risk") {
        enabled.delete(key);
      } else if (result.verdict === "ok") {
        enabled.add(key);
      } else if (!originallyEnabled.has(key)) {
        // an account put in use only for its own probe goes back out of use:
        // an undiagnosed account is never left enabled on the strength of it
        enabled.delete(key);
      }
      result.enabledAfter = enabled.has(key);
      run.accounts.push(result);
      run.progress.phase = "account_done";
      run.progress.currentAccount = null;
      flush();
      log(
        `${user}: ${result.verdict === "error" ? `could not be diagnosed (${result.error})` : `${result.verdict} — ${result.displayName} (${(result.probability * 100).toFixed(1)}%)`}; in use after: ${result.enabledAfter}`,
      );
      if (targets.indexOf(user) < targets.length - 1) await sleep(config.pauseMs);
    }

    run.progress.phase = "applying";
    flush();
    const finalUsers = order.filter((user) => enabled.has(user.toLowerCase()));
    run.enabledAfter = finalUsers;
    if (config.dryRun) {
      log(`dry run: magpie's Codex accounts were left as they are (would be: ${finalUsers.join(", ") || "none — the Codex subscription switched off"})`);
      run.applied = { dryRun: true, users: finalUsers };
    } else if (!finalUsers.length) {
      // magpie always keeps the account Codex is signed in to in use, so
      // "no account" cannot be expressed as account switches; a provider
      // switched off is what leaves none of them serving, and every routing
      // group of the subscription falls to its next member
      log("every account came back held back: switching the Codex subscription off");
      await setProviderOn("codex", false);
      appliedFinal = true;
      for (const account of run.accounts) account.enabledAfter = false;
      run.applied = { users: [], providerOff: true };
    } else {
      await setProviderOn("codex", true);
      const pool = await setPoolEnabled(finalUsers);
      appliedFinal = true;
      run.applied = { users: finalUsers, pool: pool.accounts };
      log(`magpie's Codex accounts in use now: ${finalUsers.join(", ")}`);
    }
    run.status = "done";
  } catch (error) {
    run.status = "failed";
    run.error = String(error?.message ?? error);
    log(`scan failed: ${run.error}`);
  } finally {
    // the subscription was switched on for the probes and the scan never got
    // to say what to do with it: leave it as it was
    if (wasOff && !appliedFinal && !config.dryRun && run.status === "failed") {
      try {
        await setProviderOn("codex", false);
        log("the Codex subscription was left switched off, as the scan found it");
      } catch (error) {
        log(`the Codex subscription could not be switched off again: ${String(error)}`);
      }
    }
    run.finishedAt = new Date().toISOString();
    // a full pass covers the three-hourly slots it has passed: they have
    // nothing to add, and running them would probe every account again
    if (slot && scope === "all" && run.status === "done") {
      const day = slot.slice(0, 10);
      const hour = Number(slot.slice(11, 13));
      for (const other of config.slots) {
        if (other >= hour) continue;
        const key = `${day}T${String(other).padStart(2, "0")}:00`;
        if (state.slots?.[key]?.status === "done") continue;
        state.slots ??= {};
        state.slots[key] = {
          status: "done",
          scope: other === (config.slots[0] ?? 0) ? "all" : "enabled",
          at: run.finishedAt,
          coveredBy: runId,
          note: "covered by the full pass",
        };
      }
    }
    // every way out of a scan records its slot, the early ones included
    if (slot) {
      state.slots ??= {};
      state.slots[slot] = {
        status: run.status === "done" ? "done" : "failed",
        runId,
        scope,
        at: run.finishedAt,
        error: run.error || undefined,
      };
    }
    run.progress.phase = run.status;
    run.progress.currentAccount = null;
    try {
      flush();
    } finally {
      lock.release();
    }
  }

  // a record of the run's own log, beside the plugin host's
  try {
    fs.writeFileSync(
      path.join(logsDir(), `scan-${runId}.log`),
      run.accounts
        .map((account) => `${account.user}\t${account.verdict}\t${account.model ?? ""}\t${account.error ?? ""}`)
        .join("\n") + "\n",
    );
  } catch {
    // the log is a convenience
  }
  return run;
}

const pick = (object, fields) => Object.fromEntries(fields.filter((key) => object?.[key] !== undefined).map((key) => [key, object[key]]));

function publicProgress(progress, phase = "starting") {
  return {
    phase: progress?.phase ?? phase,
    total: progress?.totalAccounts ?? null,
    completed: progress?.completedAccounts ?? 0,
    currentAccount: progress?.currentAccount ?? null,
    attempts: progress?.probes?.attempts ?? 0,
    probesCompleted: progress?.probes?.accepted ?? 0,
    probesTotal: progress?.probes?.total ?? null,
    updatedAt: progress?.updatedAt ?? null,
  };
}

/** Safe, live snapshot for CLI and UI. Never spread stored config or raw runs. */
export function statusReport(limit = 10, dependencies = {}) {
  const state = (dependencies.loadState ?? loadState)();
  const config = (dependencies.loadConfig ?? loadConfig)();
  const lock = (dependencies.readLock ?? readLock)();
  const directory = (dependencies.stateDir ?? stateDir)();
  const stored = state.lastRun;
  const matches = lock.running && stored?.status === "running" && (
    stored.lockToken ? stored.lockToken === lock.held?.token :
      stored.pid ? stored.pid === lock.held?.pid :
        lock.held?.phase !== "starting" && Math.abs(Date.parse(stored.startedAt) - Date.parse(lock.held?.startedAt)) < 2_000
  );
  const lastRun = stored ? {
    ...pick(stored, ["id", "pid", "startedAt", "finishedAt", "scope", "trigger", "status", "dryRun", "error"]),
    accounts: (stored.accounts ?? []).map((account) => pick(account, ["user", "verdict", "model"])),
    progress: publicProgress(stored.progress, stored.status),
  } : null;
  if (lastRun?.status === "running" && !matches) {
    lastRun.status = "interrupted";
    lastRun.error = "the scan process is no longer running";
    lastRun.progress.phase = "interrupted";
    lastRun.progress.currentAccount = null;
  }
  // A previous completed run must not hide a newly spawned child's startup.
  const progress = lock.running
    ? matches ? lastRun.progress : publicProgress(null, lock.held?.phase ?? "starting")
    : lastRun?.progress ?? null;
  const report = {
    stateDir: directory,
    running: lock.running === true,
    active: lock.running ? publicLock(lock.held) : null,
    progress,
    lastRun,
    slots: Object.fromEntries(Object.entries(state.slots ?? {}).map(([key, value]) => [key,
      pick(value, ["status", "scope", "at", "runId", "coveredBy", "note", "error"])])),
    accounts: Object.fromEntries(Object.entries(state.accounts ?? {}).map(([key, value]) => [key,
      pick(value, ["verdict", "model", "displayName", "probability", "lunaProbability", "enabledAfter", "at", "runId", "error"])])),
    config: pick(config, ["model", "effort", "probes", "slots", "scheduler", "dryRun"]),
    recentRuns: dependencies.recentRuns ? dependencies.recentRuns(limit) : fs.existsSync(path.join(directory, "runs"))
      ? fs.readdirSync(path.join(directory, "runs"), { withFileTypes: true })
          ?.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().slice(-limit) ?? []
      : [],
  };
  // Upstream errors can echo credentials. Redact configured secrets even inside
  // otherwise whitelisted error strings, not just the config object itself.
  const secret = typeof config.gatewayKey === "string" && config.gatewayKey ? config.gatewayKey : null;
  const redact = (value) => typeof value === "string" ? secret ? value.split(secret).join("[redacted]") : value
    : Array.isArray(value) ? value.map(redact)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) : value;
  return redact(report);
}

/** recordAccountOutcomes folds a finished run into state.accounts. */
export function recordAccountOutcomes(run) {
  const state = loadState();
  for (const account of run.accounts ?? []) {
    state.accounts[account.user] = {
      verdict: account.verdict,
      model: account.model ?? null,
      displayName: account.displayName ?? null,
      probability: account.probability ?? null,
      lunaProbability: account.lunaProbability ?? null,
      enabledAfter: account.enabledAfter ?? null,
      at: run.finishedAt ?? run.startedAt,
      runId: run.id,
      error: account.error ?? undefined,
    };
  }
  saveState(state);
}
