// Immutable executable/UI snapshots. Neither the daemon nor a scan runs from
// node_modules, which Magpie's package updater is allowed to replace.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stateDir } from "./config.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FORMAT = 1;
const FIXED = ["package.json", "bin/codex-route-monitor.mjs", "bin/codex-route-monitor-ui.mjs", "data/unified_bank.json", "ui/service.html", "ui/service.js", "ui/panel-controller.js"];
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

export function uiRuntimeFiles(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const files = [...FIXED, ...fs.readdirSync(path.join(root, "lib"), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".mjs")).map(entry => `lib/${entry.name}`)];
  for (const optional of ["ui/service.css", "LICENSE", "NOTICE"]) if (fs.existsSync(path.join(root, optional))) files.push(optional);
  return [...new Set(files)].sort();
}

function sourceFiles(root) {
  const contents = new Map();
  for (const rel of uiRuntimeFiles(root)) {
    const file = path.join(root, rel);
    if (!fs.lstatSync(file).isFile()) throw new Error(`UI runtime requires a regular file: ${rel}`);
    contents.set(rel, fs.readFileSync(file));
  }
  return contents;
}
function buildHash(files) {
  const hash = crypto.createHash("sha256");
  for (const [name, bytes] of files) hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`).update(bytes);
  return hash.digest("hex");
}

export function loadUIRuntime(root, { verify = true } = {}) {
  root = path.resolve(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "ui-runtime.json"), "utf8"));
  if (manifest.format !== FORMAT || !/^[a-f0-9]{64}$/.test(manifest.buildId) || typeof manifest.version !== "string" || !manifest.files || Array.isArray(manifest.files)) throw new Error("Invalid UI runtime manifest");
  if (verify) {
    const files = new Map();
    // Use byte/code-unit ordering, identical to prepareUIRuntime's Array.sort.
    for (const rel of Object.keys(manifest.files).sort()) {
      if (rel.includes("\\") || path.posix.isAbsolute(rel) || rel.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Unsafe UI runtime manifest path");
      const file = path.join(root, rel);
      if (!fs.lstatSync(file).isFile()) throw new Error(`Invalid UI runtime file: ${rel}`);
      const bytes = fs.readFileSync(file);
      if (sha(bytes) !== manifest.files[rel]) throw new Error(`UI runtime is corrupted: ${rel}`);
      files.set(rel, bytes);
    }
    if (buildHash(files) !== manifest.buildId) throw new Error("UI runtime build hash mismatch");
    const pkg = JSON.parse(files.get("package.json")?.toString("utf8") || "null");
    if (pkg?.name !== "codex-route-monitor" || pkg.version !== manifest.version) throw new Error("UI runtime package metadata mismatch");
    for (const rel of FIXED) if (!files.has(rel)) throw new Error(`Incomplete UI runtime: ${rel}`);
  }
  return Object.freeze({ root, buildId: manifest.buildId, version: manifest.version, createdAt: manifest.createdAt, sourceRoot: manifest.sourceRoot });
}

export function prepareUIRuntime(input = PACKAGE_ROOT) {
  const options = typeof input === "string" ? { sourceRoot: input } : input;
  const sourceRoot = path.resolve(options.sourceRoot || PACKAGE_ROOT);
  const dir = path.resolve(options.dir || stateDir());
  const files = sourceFiles(sourceRoot);
  const pkg = JSON.parse(files.get("package.json").toString("utf8"));
  if (pkg.name !== "codex-route-monitor" || typeof pkg.version !== "string") throw new Error("UI runtime source is not codex-route-monitor");
  const buildId = buildHash(files), base = path.join(dir, "ui-runtimes"), root = path.join(base, buildId);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  if (fs.existsSync(root)) return Object.freeze({ ...loadUIRuntime(root), sourceRoot });
  const stage = path.join(base, `.tmp-${process.pid}-${crypto.randomBytes(12).toString("hex")}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    for (const [rel, bytes] of files) {
      const file = path.join(stage, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, bytes, { mode: 0o600 });
    }
    const manifest = { format: FORMAT, buildId, version: pkg.version, sourceRoot, createdAt: new Date().toISOString(), files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha(bytes)])) };
    fs.writeFileSync(path.join(stage, "ui-runtime.json"), JSON.stringify(manifest), { mode: 0o600 });
    try { fs.renameSync(stage, root); }
    catch (error) { if (!fs.existsSync(root)) throw error; }
  } finally {
    // Only the staging directory created by this call can ever be removed.
    if (path.dirname(stage) !== base || !path.basename(stage).startsWith(".tmp-")) throw new Error("Invalid runtime staging cleanup");
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
  }
  return Object.freeze({ ...loadUIRuntime(root), sourceRoot });
}

export function isUIRuntimeSourceCurrent(runtime) {
  if (!runtime.sourceRoot || !fs.existsSync(runtime.sourceRoot)) return null;
  try { return buildHash(sourceFiles(runtime.sourceRoot)) === runtime.buildId; }
  catch { return false; }
}

export async function createRuntimeManualController(runtime, options = {}) {
  const root = path.resolve(runtime.root);
  const module = await import(pathToFileURL(path.join(root, "lib/manual.mjs")).href);
  return module.createManualController({ ...options, cli: path.join(root, "bin/codex-route-monitor.mjs"), cwd: root });
}
