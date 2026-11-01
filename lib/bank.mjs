// The fingerprint bank: ModelTrace's unified_bank.json, vendored here so a
// scan needs no network and no third checkout.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function bankPath() {
  return process.env.CODEX_ROUTE_MONITOR_BANK?.trim() || path.join(HERE, "..", "data", "unified_bank.json");
}

let cached = null;

/** loadBank reads and checks the bank once per process. */
export function loadBank() {
  if (cached) return cached;
  const file = bankPath();
  let bank;
  try {
    bank = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`the fingerprint bank could not be read from ${file}: ${String(error)}`);
  }
  if (!Array.isArray(bank.models) || bank.models.length === 0) {
    throw new Error(`the fingerprint bank at ${file} lists no models`);
  }
  const models = bank.robust?.hellinger?.centroids;
  if (!Array.isArray(models) || models.length !== bank.models.length) {
    throw new Error(
      `the fingerprint bank at ${file} is inconsistent: ${models?.length ?? 0} centroids for ${bank.models.length} models`,
    );
  }
  cached = bank;
  return bank;
}

export function bankSummary(bank = loadBank()) {
  return {
    path: bankPath(),
    models: bank.models.map((model) => model.id),
    calibration: Object.keys(bank.calibration ?? {}),
    method: bank.method?.name ?? "",
    orderedBlockWeight: bank.robust?.ordered_blocks?.weight ?? 0,
  };
}
