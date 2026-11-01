// The one case magpie's CLI cannot express: every account flagged, so none
// should be in use. `magpie provider pool --accounts` refuses to name no
// account, and turning off the account Codex is signed in to means pausing it
// (logins_on.go in magpie). So the last step is made in magpie's own account
// file, in the shape magpie writes it, and then checked back through the CLI.
//
// This runs only when every account of a scan came back held back: leaving
// them all in use would keep an account spending an allowance it should not.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPool } from "./magpie.mjs";

function loginsPath() {
  return path.join(os.homedir(), ".config", "magpie", "logins.json");
}

/**
 * disableEveryAccount takes every Codex account out of use, marking the one
 * Codex is signed in to as paused (the only way magpie stops routing to it).
 * Returns magpie's pool report once it agrees.
 */
export async function disableEveryAccount({ log = () => {} } = {}) {
  const file = loginsPath();
  const before = fs.readFileSync(file);
  const accounts = JSON.parse(before.toString("utf8"));
  if (!Array.isArray(accounts)) throw new Error(`${file} does not hold a list of accounts`);
  let touched = 0;
  for (const account of accounts) {
    if (account?.agent !== "codex") continue;
    if (account.on !== false) {
      account.on = false;
      touched += 1;
    }
    // the account Codex is signed in to is "in use" whatever its on flag;
    // paused is what makes the gateway pass it over
    if (account.paused !== true) {
      account.paused = true;
      touched += 1;
    }
  }
  log(`taking every Codex account out of use in ${file} (${touched} field(s))`);
  fs.writeFileSync(`${file}.codex-route-monitor.bak`, before, { mode: 0o600 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const pool = await readPool();
  const still = pool.accounts.filter((account) => account.enabled).map((account) => account.user);
  if (still.length) {
    throw new Error(
      `magpie still has Codex accounts in use after they were all taken out: ${still.join(", ")}`,
    );
  }
  log("magpie reports no Codex account in use");
  return { pool };
}
