import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createUIService } from "../lib/ui-service.mjs";
import { fixture, freePort, httpCall } from "./ui-service-helpers.mjs";

// Public page/status seam only. No process exits, registration off/remove,
// service-manager reloads or real scans are exercised by these regressions.
async function pageFixture(t, { malformed = false, spec = "github:para1lel/codex-route-monitor" } = {}) {
  const f = fixture(t, { autoCleanup: false }), port = await freePort();
  const config = path.join(f.base, "native-magpie"), plugins = path.join(config, "plugins");
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(path.join(plugins, "package.json"), JSON.stringify({ dependencies: { "codex-route-monitor": spec } }));
  fs.writeFileSync(path.join(config, "plugins.json"), malformed ? "{" : JSON.stringify({ plugins: [{ spec, options: { uiPort: String(port) } }] }));
  // Lexical installed source is intentionally absent. A replaced package is
  // not lifetime authority; the immutable runtime and native registration are.
  const runtime = { ...f.runtime, sourceRoot: path.join(plugins, "node_modules", "codex-route-monitor") };
  fs.writeFileSync(path.join(f.state, "ui-service-activation.json"), JSON.stringify({ buildId: runtime.buildId, port, ownerPid: 424242, enabled: true, heartbeatAt: 0 }));
  const key = "fixture-ui-registration-key";
  const service = await createUIService({ runtime, dir: f.state, port, uiApiKey: key, managerKey: "fixture-private-manager-key",
    manual: { start() { assert.fail("Page/status regression must never start a scan"); } },
    status: () => ({ running: false, fixture: true }), enforceLease: true,
    now: () => 100000, isAlive: () => false, leaseGraceMs: 500, leaseCheckMs: 10 });
  t.after(async () => { await service.close(); f.cleanup(); });
  return { port, key, service };
}

test("native registered page and status remain readable despite a stale dead-owner lease", async t => {
  for (const spec of ["github:para1lel/codex-route-monitor", "codex-route-monitor@1.4.2"]) {
    const f = await pageFixture(t, { spec });
    await new Promise(resolve => setTimeout(resolve, 80));
    const page = await httpCall(f.port, "/");
    assert.equal(page.status, 200);
    assert.equal(page.headers["access-control-allow-origin"], undefined);
    const status = await httpCall(f.port, "/api/status", { headers: { "X-Codex-Monitor-Key": f.key } });
    assert.equal(status.status, 200);
    assert.deepEqual(status.json, { running: false, fixture: true });
  }
});

test("unreadable native registration fails page/status reads closed without exposing bootstrap", async t => {
  const f = await pageFixture(t, { malformed: true });
  const page = await httpCall(f.port, "/");
  assert.equal(page.status, 503);
  assert.equal(page.text.includes(f.key), false);
  assert.equal(page.headers["access-control-allow-origin"], undefined);
  const status = await httpCall(f.port, "/api/status", { headers: { "X-Codex-Monitor-Key": f.key } });
  assert.equal(status.status, 503);
  assert.equal(status.text.includes(f.key), false);
});
