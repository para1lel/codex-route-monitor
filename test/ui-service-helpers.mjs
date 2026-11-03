import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { prepareUIRuntime } from "../lib/ui-runtime.mjs";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function fixture(t, { version = "1.4.0", state, autoCleanup = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "crm-ui-test-")), source = path.join(base, "package");
  state ||= path.join(base, "state");
  for (const name of ["lib", "bin", "ui", "data"]) fs.mkdirSync(path.join(source, name), { recursive: true });
  for (const name of fs.readdirSync(path.join(ROOT, "lib"))) if (name.endsWith(".mjs")) fs.copyFileSync(path.join(ROOT, "lib", name), path.join(source, "lib", name));
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "codex-route-monitor", version, type: "module" }));
  fs.writeFileSync(path.join(source, "data/unified_bank.json"), "{}");
  fs.writeFileSync(path.join(source, "ui/service.html"), `<html><style nonce="__CSP_NONCE__">body{color:red}</style><script nonce="__CSP_NONCE__">window.boot=__CODEX_MONITOR_BOOT__;</script><script nonce="__CSP_NONCE__" src="service.js"></script></html>`);
  fs.writeFileSync(path.join(source, "ui/service.js"), "// fixture UI\n");
  fs.writeFileSync(path.join(source, "ui/panel-controller.js"), "// fixture controller\n");
  fs.writeFileSync(path.join(source, "bin/codex-route-monitor-ui.mjs"), `import path from 'node:path';import{fileURLToPath}from'node:url';import{loadUIRuntime}from'../lib/ui-runtime.mjs';import{createUIService}from'../lib/ui-service.mjs';const runtime=loadUIRuntime(path.dirname(path.dirname(fileURLToPath(import.meta.url))));const s=await createUIService({runtime,port:Number(process.argv[3]),status:()=>({running:false,fixture:true}),enforceLease:true,leaseGraceMs:Number(process.env.CODEX_MONITOR_UI_LEASE_GRACE_MS||60000),leaseCheckMs:100});process.on('SIGTERM',()=>s.close());`);
  fs.writeFileSync(path.join(source, "bin/codex-route-monitor.mjs"), `import fs from 'node:fs';import path from 'node:path';import{tryAcquire}from'../lib/lock.mjs';import{stateDir}from'../lib/config.mjs';const lock=tryAcquire({scope:'enabled',trigger:'tool'});if(lock.busy)process.exit(3);fs.writeFileSync(path.join(stateDir(),'fixture-scan.json'),JSON.stringify({pid:process.pid,cwd:process.cwd(),entry:import.meta.url}));setInterval(()=>{},1000);process.on('SIGTERM',()=>{lock.release();process.exit(0)});`);
  const cleanup = () => { if (path.dirname(base) === os.tmpdir() && path.basename(base).startsWith("crm-ui-test-")) fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); };
  if (autoCleanup) t.after(cleanup);
  const runtime = prepareUIRuntime({ sourceRoot: source, dir: state });
  return { base, source, state, runtime, cleanup };
}
export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
export async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error("Timed out waiting for test condition");
}
export function httpCall(port, route, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method, agent: false, headers }, res => {
      const chunks = [];res.on("data", chunk => chunks.push(chunk));res.on("end", () => { const text = Buffer.concat(chunks).toString();let json;try { json = JSON.parse(text); } catch {}resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.once("error", reject);if (body !== undefined) req.write(body);req.end();
  });
}
