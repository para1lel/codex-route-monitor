import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { startUIService, requestUIManager } from "../lib/ui-service-manager.mjs";
import { getUIServiceKeys, uiPidAlive } from "../lib/ui-service.mjs";
import { fixture, freePort, until, httpCall } from "./ui-service-helpers.mjs";

async function setup(t, options={}) {
  const f=fixture(t,{autoCleanup:false,...options}),port=await freePort(),handles=[],beforeCleanup=[];
  t.after(async()=>{
    for(const fn of beforeCleanup)await fn();
    for(const h of handles)await h.dispose();
    let pid;
    try{pid=(await requestUIManager(port,getUIServiceKeys(f.state).managerKey))?.pid;await requestUIManager(port,getUIServiceKeys(f.state).managerKey,"/internal/shutdown",{method:"POST"});}catch{}
    await until(async()=>{try{return !await requestUIManager(port,getUIServiceKeys(f.state).managerKey);}catch{return false;}},4000).catch(()=>{});
    if(pid)await until(()=>!uiPidAlive(pid),4000).catch(()=>{});
    f.cleanup();
  });
  const start=async(overrides={})=>{const h=await startUIService({runtime:f.runtime,dir:f.state,port,watchMs:100,leaseGraceMs:500,readyTimeoutMs:7000,...overrides});handles.push(h);return h;};
  return {...f,port,start,handles,beforeCleanup};
}

test("same-process concurrent ensure reuses one daemon and recovers unexpected exit",{timeout:20000},async t=>{
  const f=await setup(t);
  const hs=await Promise.all(Array.from({length:8},()=>f.start()));
  const first=await hs[0].health();
  assert.ok(hs.every(h=>h===hs[0]));
  const all=await Promise.all(Array.from({length:8},()=>hs[0].ensure()));assert.ok(all.every(h=>h.pid===first.pid));
  process.kill(first.pid);
  const repaired=await until(async()=>{try{const h=await hs[0].health();return h?.pid!==first.pid&&h;}catch{return false;}});
  assert.notEqual(repaired.pid,first.pid);assert.equal(repaired.buildId,f.runtime.buildId);
});
test("foreign occupied port is rejected without shutting down or killing its owner",{timeout:10000},async t=>{
  const f=fixture(t,{autoCleanup:false});let calls=0;
  const foreign=http.createServer((req,res)=>{calls++;res.writeHead(401);res.end("not yours");});
  await new Promise(resolve=>foreign.listen(0,"127.0.0.1",resolve));const port=foreign.address().port;
  t.after(async()=>{await new Promise(resolve=>foreign.close(resolve));f.cleanup();});
  await assert.rejects(startUIService({runtime:f.runtime,dir:f.state,port,readyTimeoutMs:1500}),error=>error.code==="EUI_PORT_IN_USE");
  assert.ok(foreign.listening);assert.equal((await httpCall(port,"/still-alive")).status,401);assert.ok(calls>=2);
  assert.equal(fs.existsSync(path.join(f.state,"ui-service-activation.json")),false);
});
test("snapshot daemon and scan survive package removal; upgrade cannot be undone by old watchdog",{timeout:25000},async t=>{
  const f=await setup(t),old=await f.start(),key=getUIServiceKeys(f.state).apiKey;
  const scan=await httpCall(f.port,"/api/scan",{method:"POST",headers:{"X-Codex-Monitor-Key":key,"Content-Type":"application/json"},body:JSON.stringify({scope:"enabled"})});
  assert.equal(scan.json.started,true);const scanPid=scan.json.pid;
  f.beforeCleanup.push(async()=>{if(uiPidAlive(scanPid))process.kill(scanPid);await until(()=>!uiPidAlive(scanPid),4000).catch(()=>{});});
  const marker=await until(()=>{try{return JSON.parse(fs.readFileSync(path.join(f.state,"fixture-scan.json"),"utf8"));}catch{return false;}});
  assert.equal(marker.cwd,f.runtime.root);assert.ok(marker.entry.includes("ui-runtimes"));
  const moved=`${f.source}-removed`;fs.renameSync(f.source,moved);fs.rmSync(moved,{recursive:true,force:true});
  const first=await old.health();process.kill(first.pid);
  await until(async()=>{try{const h=await old.health();return h&&h.pid!==first.pid;}catch{return false;}});
  assert.ok(uiPidAlive(scanPid));
  const next=fixture(t,{version:"2.0.0",state:f.state,autoCleanup:false});t.after(next.cleanup);
  const newer=await f.start({runtime:next.runtime}),newHealth=await newer.health();
  assert.equal(newHealth.version,"2.0.0");assert.ok(uiPidAlive(scanPid));
  assert.equal((await old.ensure()).superseded,true);
  assert.equal((await newer.health()).pid,newHealth.pid);
  await assert.rejects(startUIService({runtime:f.runtime,dir:f.state,port:f.port}),error=>error.code==="EUI_SUPERSEDED");
});
test("disposing the active plugin lease stops its orphan daemon without PID killing",{timeout:12000},async t=>{
  const f=await setup(t),h=await f.start();const pid=(await h.health()).pid;
  await h.dispose();
  await until(async()=>{try{return !await h.health();}catch{return false;}},5000);
  await until(()=>!uiPidAlive(pid),5000);
});
test("cross-process startup guard adopts exactly one daemon",{timeout:25000},async t=>{
  const f=await setup(t),children=[],paths=[];
  const managerURL=pathToFileURL(path.resolve("lib/ui-service-manager.mjs")).href;
  const helper=path.join(f.base,"manager-helper.mjs");
  fs.writeFileSync(helper,`import fs from'node:fs';import{startUIService}from ${JSON.stringify(managerURL)};const h=await startUIService(JSON.parse(process.argv[2]));fs.writeFileSync(process.argv[3],JSON.stringify(await h.health()));setInterval(()=>{},1000);`);
  f.beforeCleanup.push(async()=>{for(const c of children){try{process.kill(c.pid);}catch{}}await new Promise(r=>setTimeout(r,200));});
  for(let i=0;i<4;i++){
    const result=path.join(f.base,`ready-${i}.json`);paths.push(result);
    const child=spawn(process.execPath,[helper,JSON.stringify({runtime:f.runtime,dir:f.state,port:f.port,watchMs:100,leaseGraceMs:1000}),result],{stdio:"ignore",windowsHide:true});children.push(child);
    child.on("error",()=>{});
  }
  const results=await until(()=>paths.every(p=>fs.existsSync(p))&&paths.map(p=>JSON.parse(fs.readFileSync(p))),15000);
  assert.equal(new Set(results.map(r=>r.pid)).size,1);assert.equal(results[0].buildId,f.runtime.buildId);
});
