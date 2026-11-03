import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createUIService, getUIServiceKeys, validateUIPort } from "../lib/ui-service.mjs";
import { prepareUIRuntime, loadUIRuntime, createRuntimeManualController } from "../lib/ui-runtime.mjs";
import { fixture, httpCall } from "./ui-service-helpers.mjs";

async function httpFixture(t) {
  const f = fixture(t), calls = [];
  const keys = { uiApiKey: "test-ui-key", managerKey: "private-manager-key" };
  const s = await createUIService({ runtime: f.runtime, port: 0, dir: f.state, ...keys, manual: { start: args => { calls.push(args);return { started:true, scope:args.scope }; } }, status: () => ({ running:false, accounts:[] }) });
  t.after(() => s.close()); return { ...f, ...s, calls, keys };
}
test("immutable runtime is complete, survives package removal and refuses corrupt reuse", async t => {
  const f = fixture(t);
  assert.deepEqual(prepareUIRuntime({ sourceRoot:f.source, dir:f.state }), f.runtime);
  assert.ok(fs.existsSync(path.join(f.runtime.root,"bin/codex-route-monitor-ui.mjs")));
  const controller = await createRuntimeManualController(f.runtime, { spawnProcess:() => { throw Error("No spawn allowed"); } });
  assert.equal(typeof controller.start,"function");
  fs.renameSync(f.source,`${f.source}-removed`);
  assert.equal(loadUIRuntime(f.runtime.root).buildId,f.runtime.buildId);
  fs.appendFileSync(path.join(f.runtime.root,"ui/service.js"),"// corrupt");
  assert.throws(() => loadUIRuntime(f.runtime.root),/corrupt/);
});
test("runtime hashing includes UI assets and all runtime libraries without deleting previous builds", t => {
  const f=fixture(t);
  fs.appendFileSync(path.join(f.source,"ui/service.js"),"// change");
  const updated=prepareUIRuntime({sourceRoot:f.source,dir:f.state});
  assert.notEqual(updated.buildId,f.runtime.buildId);
  assert.equal(loadUIRuntime(f.runtime.root).buildId,f.runtime.buildId);
  fs.writeFileSync(path.join(f.source,"lib/extra-runtime.mjs"),"export const x=1;");
  assert.notEqual(prepareUIRuntime({sourceRoot:f.source,dir:f.state}).buildId,updated.buildId);
});
test("UI and manager keys are persistent, distinct and private", t => {
  const f=fixture(t), keys=getUIServiceKeys(f.state);
  assert.notEqual(keys.apiKey,keys.managerKey);assert.deepEqual(getUIServiceKeys(f.state),keys);
  if(process.platform!=="win32")assert.equal(fs.statSync(path.join(f.state,"ui-service-keys.json")).mode&0o777,0o600);
});
test("HTML bootstrap is non-CORS, escaped and nonce constrained; only curated assets are public", async t => {
  const f=await httpFixture(t), html=await httpCall(f.port,"/",{headers:{Origin:"null"}});
  assert.equal(html.status,200);assert.ok(html.text.includes(f.keys.uiApiKey));assert.ok(!html.text.includes(f.keys.managerKey));
  assert.equal(html.headers["access-control-allow-origin"],undefined);
  assert.match(html.headers["content-security-policy"],/script-src 'nonce-/);assert.match(html.headers["content-security-policy"],/frame-ancestors/);
  assert.match(html.headers["content-security-policy"],/connect-src http: https:/);
  assert.equal(html.headers["cache-control"],"no-store");assert.equal(html.headers["x-content-type-options"],"nosniff");
  assert.ok(!html.text.includes("__CSP_NONCE__"));assert.ok(!html.text.includes("__CODEX_MONITOR_BOOT__"));
  for(const p of ["/service.js","/panel-controller.js"]){const r=await httpCall(f.port,p,{headers:{Origin:"null"}});assert.equal(r.status,200);assert.match(r.headers["content-type"],/javascript/);assert.equal(r.headers["access-control-allow-origin"],undefined);}
  for(const p of ["/package.json","/lib/config.mjs","/api/bootstrap","/ui/service.html","/..%2fpackage.json"])assert.notEqual((await httpCall(f.port,p)).status,200);
});
test("Host, Origin and constant-time-key boundaries protect status and scanning", async t => {
  const f=await httpFixture(t), auth={"X-Codex-Monitor-Key":f.keys.uiApiKey};
  for(const headers of [{},{...auth,Origin:"https://evil.example"},{...auth,Host:"evil.example"},{...auth,Host:`127.0.0.1:${f.port+1}`},{"X-Codex-Monitor-Key":"wrong"}]){
    const r=await httpCall(f.port,"/api/status",{headers});assert.equal(r.status,403);assert.equal(r.headers["access-control-allow-origin"],undefined);
  }
  for(const origin of [undefined,"null"]){const r=await httpCall(f.port,"/api/status",{headers:{...auth,...(origin?{Origin:origin}:{})}});assert.equal(r.status,200);assert.equal(r.headers["access-control-allow-origin"],"null");assert.deepEqual(r.json,{running:false,accounts:[]});}
  assert.equal((await httpCall(f.port,"/health",{headers:auth})).status,403);
  const health=await httpCall(f.port,"/health",{headers:{"X-Codex-Monitor-Manager-Key":f.keys.managerKey}});assert.equal(health.json.protocol,1);assert.equal(health.headers["access-control-allow-origin"],undefined);
  assert.equal(f.calls.length,0);
});
test("preflight never mutates, invalid JSON/scope/dry-run/oversize cannot launch; valid scopes preserve engine arguments", async t => {
  const f=await httpFixture(t), headers={Origin:"null","X-Codex-Monitor-Key":f.keys.uiApiKey,"Content-Type":"application/json"};
  let r=await httpCall(f.port,"/api/scan",{method:"OPTIONS",headers:{Origin:"null","Access-Control-Request-Method":"POST","Access-Control-Request-Headers":"content-type,x-codex-monitor-key"}});assert.equal(r.status,204);assert.equal(f.calls.length,0);
  r=await httpCall(f.port,"/api/scan",{method:"OPTIONS",headers:{Origin:"https://evil.example"}});assert.equal(r.status,403);
  for(const body of ["{", "[]", "null", "{}", '{"scope":"ALL"}', '{"scope":"all","dry_run":"false"}', '{"scope":"all","path":"evil"}'])assert.equal((await httpCall(f.port,"/api/scan",{method:"POST",headers,body})).status,400);
  assert.equal((await httpCall(f.port,"/api/scan",{method:"POST",headers:{...headers,"Content-Type":"text/plain"},body:'{"scope":"all"}'})).status,415);
  assert.equal((await httpCall(f.port,"/api/scan",{method:"POST",headers,body:JSON.stringify({scope:"all",padding:"x".repeat(17000)})})).status,413);
  assert.equal(f.calls.length,0);
  for(const scope of ["all","enabled"])assert.equal((await httpCall(f.port,"/api/scan",{method:"POST",headers,body:JSON.stringify({scope})})).json.started,true);
  assert.deepEqual(f.calls,[{scope:"all",dry_run:false},{scope:"enabled",dry_run:false}]);
});
test("dedicated UI port rejects ambiguous values and Magpie endpoints",()=>{
  for(const p of [" 3489","3489 ","3e3",true,[],{},null,NaN,1.5,-1,0,80,1023,65536,3425,3430])assert.throws(()=>validateUIPort(p));
  assert.equal(validateUIPort(3489),3489);assert.equal(validateUIPort("3489"),3489);assert.throws(()=>validateUIPort(9000,{forbiddenPorts:[9000]}));
});
