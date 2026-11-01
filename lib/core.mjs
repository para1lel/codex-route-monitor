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
import { tryAcquire } from "./lock.mjs";

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
export async function probeAccount({ account, config, bank, gateway, runDir, log, pin = true }) {
  const challenges = generateChallenges(config.probes);
  const label = account || config.model;
  const workDir = path.join(runDir, "work", slug(label));
  const homeDir = path.join(runDir, "codex-home", slug(label));
  const attempts = [];
  const accepted = [];
  let next = 0;
  try {
    while (accepted.length < challenges.length && attempts.length < config.probeAttempts) {
      const challenge = challenges[next];
      const probe = await runProbe({
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
export async function runScan({ scope = "enabled", trigger = "manual", slot = null, overrides = {}, echo = false } = {}) {
  const config = loadConfig(overrides);
  const bank = loadBank();
  const started = new Date();
  const runId = stamp(started);
  const runDir = ensureDir(path.join(runsDir(), runId));
  const log = (line) => logLine(`[${runId}] ${line}`, { echo });
  const state = loadState();

  const lock = tryAcquire({ scope, trigger, slot });
  if (lock.busy) {
    log(`another scan is already running (${lock.held?.pid ?? "?"} on ${lock.held?.host ?? "?"}); this one does nothing`);
    return { skipped: true, reason: "another scan is running", id: runId };
  }

  const run = {
    id: runId,
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
    const originallyEnabled = new Set(enabled);
    run.enabledBefore = order.filter((user) => enabled.has(user.toLowerCase()));
    const targets = scope === "all" ? order : order.filter((user) => enabled.has(user.toLowerCase()));
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
        result = await probeAccount({ account: user, config, bank, gateway, runDir, log });
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
      flush();
      log(
        `${user}: ${result.verdict === "error" ? `could not be diagnosed (${result.error})` : `${result.verdict} — ${result.displayName} (${(result.probability * 100).toFixed(1)}%)`}; in use after: ${result.enabledAfter}`,
      );
      if (targets.indexOf(user) < targets.length - 1) await sleep(config.pauseMs);
    }

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
    flush();
    lock.release();
  }

  if (slot) {
    state.slots[slot] = {
      status: run.status === "done" ? "done" : "failed",
      runId,
      scope,
      at: run.finishedAt,
      error: run.error || undefined,
    };
    saveState(state);
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

/** statusReport is what `status` prints and the plugin's tool returns. */
export function statusReport(limit = 10) {
  const state = loadState();
  const config = loadConfig();
  const path = stateDir();
  return {
    stateDir: path,
    lastRun: state.lastRun ?? null,
    slots: state.slots ?? {},
    accounts: state.accounts ?? {},
    config,
    recentRuns: fs.existsSync(path)
      ? fs
          .readdirSync(runsDir())
          .filter((name) => name.endsWith(".json"))
          .sort()
          .slice(-limit)
      : [],
  };
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
