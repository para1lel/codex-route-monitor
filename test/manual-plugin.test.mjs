import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import codexRouteMonitor, { createPlugin } from "../index.js";
import { createManualController } from "../lib/manual.mjs";

// This only loads the plugin with scheduler:false and calls non-scanning tools.
// Neither provider commands nor the scan CLI are run.
test("plugin keeps the README tool names and default {tool} shape", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-plugin-"));
  const previous = process.env.CODEX_ROUTE_MONITOR_HOME;
  process.env.CODEX_ROUTE_MONITOR_HOME = dir;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ scheduler: false, gatewayKey: "fixture-private-key" }));
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_ROUTE_MONITOR_HOME;
    else process.env.CODEX_ROUTE_MONITOR_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(typeof codexRouteMonitor, "function");
  const plugin = await createPlugin({ initialiseUI: async () => ({ manual: createManualController() }) })();
  assert.deepEqual(Object.keys(plugin), ["tool"]);
  assert.deepEqual(Object.keys(plugin.tool).sort(), ["codex_route_scan", "codex_route_status"]);
  const scan = plugin.tool.codex_route_scan;
  assert.deepEqual(scan.args.properties.scope.enum, ["enabled", "all"]);
  assert.equal((await scan.execute({ scope: "invalid" })).code, "invalid_scope");
  const report = await plugin.tool.codex_route_status.execute();
  assert.equal(report.running, false);
  assert.equal(report.lastRun, null);
  assert.ok(Array.isArray(report.schedule));
  assert.equal(report.bank, "data/unified_bank.json (ModelTrace)");
  assert.equal(JSON.stringify(report).includes("fixture-private-key"), false);
  assert.equal(JSON.stringify(report).includes("gatewayKey"), false);
});
