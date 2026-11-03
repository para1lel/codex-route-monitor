import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { prepareUIRuntime } from "../lib/ui-runtime.mjs";
import { createUIService } from "../lib/ui-service.mjs";
import { fixture, httpCall } from "./ui-service-helpers.mjs";

test("real packaged HTML renders valid bootstrap JavaScript and narrows proxy CSP before deferred assets",async t=>{
  const f=fixture(t),sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const prepared=prepareUIRuntime({sourceRoot,dir:f.state});
  const version='</script><script>throw Error("injected")</script>';
  const s=await createUIService({runtime:{...prepared,version},port:0,dir:f.state,uiApiKey:"render-ui-key",managerKey:"render-private-key",manual:{start:()=>{throw Error("not called");}},status:()=>({running:false})});
  t.after(()=>s.close());
  const r=await httpCall(s.port,"/",{headers:{Origin:"null"}});assert.equal(r.status,200);
  assert.ok(!r.text.includes(version));assert.equal(r.headers["access-control-allow-origin"],undefined);
  const metas=[],window={},href="http://127.0.0.1:3430/api/plugin-pages/service/fixture/";
  const context=vm.createContext({window,URL,location:{href},document:{createElement:()=>({}),head:{appendChild:m=>metas.push(m)}}});
  let inline=0;
  for(const match of r.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    if(/\bsrc=/.test(match[1]))continue;
    new vm.Script(match[2]).runInContext(context);inline++;
  }
  assert.ok(inline>=1);assert.equal(window.CodexMonitorBoot.apiKey,"render-ui-key");assert.equal(window.CodexMonitorBoot.version,version);assert.equal(window.CodexMonitorBoot.buildId,prepared.buildId);
  assert.ok(metas.some(m=>m.httpEquiv==="Content-Security-Policy"&&m.content===`connect-src ${href};`));
  assert.ok(!r.text.includes("__CODEX_MONITOR_BOOT__"));assert.ok(!r.text.includes("render-private-key"));
});
