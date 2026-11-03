#!/usr/bin/env node
// Internal immutable-snapshot daemon entry. Keys and leases never live in the
// package directory and no scan starts until an authenticated explicit POST.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadUIRuntime } from "../lib/ui-runtime.mjs";
import { createUIService, validateUIPort } from "../lib/ui-service.mjs";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1])) throw new Error("Usage: codex-route-monitor-ui --port <dedicated TCP port>");
  const port = validateUIPort(Number(args[1]));
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const runtime = loadUIRuntime(root);
  const rawGrace = process.env.CODEX_MONITOR_UI_LEASE_GRACE_MS;
  const leaseGraceMs = rawGrace && /^\d+$/.test(rawGrace) ? Math.max(100, Number(rawGrace)) : 60_000;
  const service = await createUIService({ runtime, port, enforceLease: true, leaseGraceMs, leaseCheckMs: Math.min(3000, Math.max(100, Math.floor(leaseGraceMs / 3))) });
  const stop = () => { service.close().catch(() => { process.exitCode = 1; }); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
main().catch(error => { console.error(`codex-route-monitor UI: ${error?.message || error}`); process.exitCode = 1; });
