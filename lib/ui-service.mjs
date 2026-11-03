// Loopback-only UI transport. It deliberately does not expose a public JSON
// bootstrap: the API key is readable only in the non-CORS, frame-restricted HTML.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { stateDir } from "./config.mjs";
import { statusReport } from "./core.mjs";
import { createRuntimeManualController } from "./ui-runtime.mjs";
import { findUIRegistration, readUIRegistration } from "./ui-registration.mjs";

export const UI_APP = "codex-route-monitor-ui";
export const UI_PROTOCOL = 1;
export const UI_DEFAULT_PORT = 3489;
export const UI_MANAGER_HEADER = "x-codex-monitor-manager-key";
export const UI_KEY_HEADER = "x-codex-monitor-key";

export function validateUIPort(port = UI_DEFAULT_PORT, { allowZero = false, forbiddenPorts = [] } = {}) {
  if (typeof port === "string" && /^\d+$/.test(port)) port = Number(port);
  if (!Number.isInteger(port) || (port === 0 ? !allowZero : port < 1024 || port > 65535) || [3425, 3430, ...forbiddenPorts].includes(port)) throw new Error("uiPort must be a dedicated TCP port from 1024 to 65535, not the Magpie gateway or web port");
  return port;
}
export function uiActivationPath(dir = stateDir()) { return path.join(path.resolve(dir), "ui-service-activation.json"); }
export function atomicUIJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  try { fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  try { fs.chmodSync(file, 0o600); } catch { /* Windows uses the user's profile ACL. */ }
}
export function readUIJSON(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
export function uiPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
export function getUIServiceKeys(dir = stateDir()) {
  const file = path.join(path.resolve(dir), "ui-service-keys.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    const keys = { protocol: UI_PROTOCOL, apiKey: crypto.randomBytes(32).toString("hex"), managerKey: crypto.randomBytes(32).toString("hex") };
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(keys), { mode: 0o600 });
    try { fs.linkSync(tmp, file); } catch (error) { if (error.code !== "EEXIST") throw error; }
    finally { fs.unlinkSync(tmp); }
  }
  const keys = readUIJSON(file);
  if (keys?.protocol !== UI_PROTOCOL || !/^[a-f0-9]{64}$/.test(keys.apiKey) || !/^[a-f0-9]{64}$/.test(keys.managerKey) || keys.apiKey === keys.managerKey) throw new Error("Invalid UI service key file; refusing to replace an existing key");
  try { fs.chmodSync(file, 0o600); } catch { /* Profile ACL on Windows. */ }
  return keys;
}
function matches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function originAllowed(req) { return req.headers.origin === undefined || req.headers.origin === "null"; }
function json(res, code, value, cors = false) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...(cors ? { "Access-Control-Allow-Origin": "null", "Vary": "Origin" } : {}) });
  res.end(JSON.stringify(value));
}
async function bodyJSON(req, max = 16 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw Object.assign(new Error("application/json required"), { status: 415 });
  if (Number(req.headers["content-length"]) > max) throw Object.assign(new Error("Request body exceeds 16 KiB"), { status: 413 });
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > max) throw Object.assign(new Error("Request body exceeds 16 KiB"), { status: 413 });
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw Object.assign(new Error("Arguments must be an object"), { status: 400 });
  return data;
}

export async function createUIService({ runtime, port = UI_DEFAULT_PORT, dir = stateDir(), uiApiKey, managerKey, manual, status = statusReport, leaseGraceMs = 60_000, leaseCheckMs = 3000, enforceLease = false, now = Date.now, isAlive = uiPidAlive } = {}) {
  if (!runtime?.root || !runtime.buildId || !runtime.version) throw new Error("A prepared UI runtime is required");
  port = validateUIPort(port, { allowZero: true });
  dir = path.resolve(dir);
  const keys = uiApiKey && managerKey ? { apiKey: uiApiKey, managerKey } : getUIServiceKeys(dir);
  if (typeof keys.apiKey !== "string" || !keys.apiKey || typeof keys.managerKey !== "string" || !keys.managerKey || keys.apiKey === keys.managerKey) throw new Error("Distinct UI and manager keys are required");
  const controller = manual || await createRuntimeManualController(runtime);
  let actualPort = port, closed = false, leaseTimer, unavailableSince = null;
  const registration = findUIRegistration(runtime, { configDirs: [path.dirname(dir)] });
  const registered = () => {
    if (!registration) return null;
    const authority = readUIRegistration(registration, { port: actualPort });
    if (authority.state === "unknown") unavailableSince ??= now();
    else unavailableSince = null;
    return authority;
  };
  const close = async () => {
    if (closed) return;
    closed = true; clearInterval(leaseTimer);
    await new Promise(resolve => {
      const force = setTimeout(() => { server.closeAllConnections?.(); resolve(); }, 1500);
      force.unref?.();
      server.close(() => { clearTimeout(force); resolve(); });
      server.closeIdleConnections?.();
    });
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    let authorized = false;
    try {
      const host = req.headers.host?.toLowerCase();
      const hosts = req.rawHeaders.filter((_, i) => i % 2 === 0).filter(h => h.toLowerCase() === "host");
      if (hosts.length !== 1 || ![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host)) return json(res, 403, { error: "Invalid Host" });
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      if (["/health", "/internal/shutdown"].includes(url.pathname)) {
        if (!originAllowed(req) || !matches(req.headers[UI_MANAGER_HEADER], keys.managerKey)) return json(res, 403, { error: "Manager authorization required" });
        if (url.pathname === "/health" && req.method === "GET") return json(res, 200, { app: UI_APP, protocol: UI_PROTOCOL, buildId: runtime.buildId, version: runtime.version, pid: process.pid });
        if (url.pathname === "/internal/shutdown" && req.method === "POST") {
          json(res, 200, { stopping: true });
          setImmediate(() => { close().catch(() => {}); });
          return;
        }
        return json(res, 405, { error: "Method not allowed" });
      }
      if (url.pathname.startsWith("/api/")) {
        if (!originAllowed(req)) return json(res, 403, { error: "Origin denied" });
        if (req.method === "OPTIONS" && ["/api/status", "/api/scan"].includes(url.pathname)) {
          const method = url.pathname === "/api/status" ? "GET" : "POST";
          if (req.headers["access-control-request-method"] && req.headers["access-control-request-method"] !== method) return json(res, 403, { error: "Preflight method denied" });
          const requested = String(req.headers["access-control-request-headers"] || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
          if (requested.some(h => !["content-type", UI_KEY_HEADER].includes(h))) return json(res, 403, { error: "Preflight headers denied" });
          res.writeHead(204, { "Access-Control-Allow-Origin": "null", "Access-Control-Allow-Methods": method, "Access-Control-Allow-Headers": "content-type, x-codex-monitor-key", "Vary": "Origin" });
          return res.end();
        }
        if (!matches(req.headers[UI_KEY_HEADER], keys.apiKey)) return json(res, 403, { error: "UI authorization required" });
        authorized = true;
        const authority = registered();
        if (authority && authority.state !== "enabled") return json(res, 503, { error: "Plugin registration is unavailable or disabled" }, true);
        if (url.pathname === "/api/status" && req.method === "GET") return json(res, 200, await status(), true);
        if (url.pathname === "/api/scan" && req.method === "POST") {
          const args = await bodyJSON(req);
          if (!["all", "enabled"].includes(args.scope) || (args.dry_run !== undefined && typeof args.dry_run !== "boolean") || Object.keys(args).some(k => !["scope", "dry_run"].includes(k))) return json(res, 400, { error: "scope must be all or enabled; dry_run must be boolean" }, true);
          const currentAuthority = registered();
          if (currentAuthority && currentAuthority.state !== "enabled") return json(res, 503, { error: "Plugin registration is unavailable or disabled" }, true);
          return json(res, 200, await controller.start({ scope: args.scope, dry_run: args.dry_run ?? false }), true);
        }
        return json(res, ["/api/status", "/api/scan"].includes(url.pathname) ? 405 : 404, { error: "Not found or method not allowed" }, true);
      }
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
      if (url.pathname === "/") {
        const authority = registered();
        if (authority && authority.state !== "enabled") return json(res, 503, { error: "Plugin registration is unavailable or disabled" });
        const nonce = crypto.randomBytes(18).toString("base64");
        const boot = JSON.stringify({ apiKey: keys.apiKey, version: runtime.version, buildId: runtime.buildId }).replace(/</g, "\\u003c");
        const html = fs.readFileSync(path.join(runtime.root, "ui/service.html"), "utf8").replaceAll("__CODEX_MONITOR_BOOT__", boot).replaceAll("__CSP_NONCE__", nonce);
        const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src http: https:; img-src data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self' http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:* http://wails.localhost https://wails.localhost wails:`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp });
        return res.end(html);
      }
      const assets = { "/service.js": ["service.js", "text/javascript; charset=utf-8"], "/panel-controller.js": ["panel-controller.js", "text/javascript; charset=utf-8"], "/service.css": ["service.css", "text/css; charset=utf-8"] };
      if (assets[url.pathname]) {
        const [file, mime] = assets[url.pathname], full = path.join(runtime.root, "ui", file);
        if (!fs.existsSync(full)) return json(res, 404, { error: "Not found" });
        res.writeHead(200, { "Content-Type": mime }); return res.end(fs.readFileSync(full));
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : "UI service request failed" }, authorized);
      else res.end();
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  actualPort = server.address().port;
  if (enforceLease || registration) {
    leaseTimer = setInterval(() => {
      // A CLI command may load this plugin into a host which immediately exits.
      // Native enabled registration is durable authority: such a transient PID
      // must not expire a healthy UI. Explicit off/remove/port changes revoke it.
      const authority = registered();
      if (authority) {
        if (authority.state === "disabled" || (authority.state === "unknown" && now() - unavailableSince > leaseGraceMs)) close().catch(() => {});
        return;
      }
      // Standalone/test runtimes have no native registry to consult, so retain
      // the original owner lease rather than leaving an unowned daemon alive.
      const activation = readUIJSON(uiActivationPath(dir));
      const matchesRuntime = activation?.buildId === runtime.buildId && activation.port === actualPort;
      const fresh = matchesRuntime && activation.enabled !== false && isAlive(activation.ownerPid) && now() - activation.heartbeatAt <= leaseGraceMs;
      if (!fresh && (!matchesRuntime || !activation || now() - activation.heartbeatAt > leaseGraceMs)) close().catch(() => {});
    }, leaseCheckMs);
    leaseTimer.unref?.();
  }
  return { server, port: actualPort, address: `http://127.0.0.1:${actualPort}`, close, runtime };
}
