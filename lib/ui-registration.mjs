// A native Magpie registration, not a transient Bun/CLI host PID, owns the UI.
// Paths come only from the immutable runtime's source metadata. No browser input
// can select a registry. Keep the descriptor when package updates replace files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NAME = "codex-route-monitor";
const lower = value => process.platform === "win32" ? value.toLowerCase() : value;
function samePath(a, b) { return lower(path.resolve(a)) === lower(path.resolve(b)); }
function real(file) { try { return fs.realpathSync(file); } catch { return null; } }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function read(file) {
  try {
    if (fs.statSync(file).size > 1024 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return object(value) ? value : null;
  } catch { return null; }
}
function descriptor(configDir, sourceRoot) {
  const dependenciesFile = path.join(configDir, "plugins", "package.json");
  const initialDependencySpec = read(dependenciesFile)?.dependencies?.[NAME];
  return Object.freeze({ mode: "native", configDir, sourceRoot, packageName: NAME,
    registryFile: path.join(configDir, "plugins.json"), dependenciesFile,
    initialDependencySpec: typeof initialDependencySpec === "string" ? initialDependencySpec : null });
}

export function findUIRegistration(runtime, { configDirs = [] } = {}) {
  if (typeof runtime?.sourceRoot !== "string" || !path.isAbsolute(runtime.sourceRoot)) return null;
  const sourceRoot = path.resolve(runtime.sourceRoot);
  // This also finds the outer node_modules of Bun's nested .bun/*/node_modules
  // layout. Its lexical path is sufficient even while the package is replaced.
  for (let at = path.dirname(sourceRoot);; at = path.dirname(at)) {
    const parent = path.dirname(at);
    if (lower(path.basename(at)) === "node_modules" && lower(path.basename(parent)) === "plugins") return descriptor(path.dirname(parent), sourceRoot);
    if (parent === at) break;
  }
  // Bun may resolve imports to a cache outside plugins/. Only accept a known
  // native root when its installed package resolves to this exact source.
  const installed = real(sourceRoot);
  const candidates = [...configDirs, path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "magpie")];
  for (const candidate of candidates) {
    const configDir = path.resolve(candidate), target = real(path.join(configDir, "plugins", "node_modules", NAME));
    if (installed && target && samePath(installed, target)) return descriptor(configDir, sourceRoot);
  }
  return null;
}

function npmName(spec) {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}
function pathSpec(spec) {
  return spec.startsWith("file://") || spec.startsWith(".") || path.isAbsolute(spec) || /^[a-z]:[\\/]/i.test(spec);
}
function gitSpec(spec) {
  return /^(?:(?:github|gitlab|bitbucket):|git\+[a-z]+:\/\/|git:\/\/)\S+$/.test(spec) || /^https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\/\S+$/.test(spec) || /^[a-z\d][a-z\d_.-]*\/[a-z\d_.-]+(?:#\S+)?$/i.test(spec);
}
function selectedPort(entry) {
  let value = entry.options?.uiPort ?? 3489;
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  return Number.isInteger(value) && value >= 1024 && value <= 65535 && ![3425, 3430].includes(value) ? value : null;
}

export function readUIRegistration(registration, { port } = {}) {
  if (!registration) return { mode: "standalone", state: "unknown", reason: "no-native-registration" };
  const registry = read(registration.registryFile);
  if (!Array.isArray(registry?.plugins)) return { mode: "native", state: "unknown", reason: "registry-unavailable" };
  const dependencies = read(registration.dependenciesFile)?.dependencies;
  const dependencySpec = object(dependencies) && typeof dependencies[NAME] === "string" ? dependencies[NAME] : registration.initialDependencySpec;
  let unresolvedGit = false;
  const matches = registry.plugins.filter(entry => {
    if (!object(entry) || typeof entry.spec !== "string") return false;
    const spec = entry.spec;
    if (pathSpec(spec)) {
      const candidate = path.resolve(registration.configDir, spec.replace(/^file:\/\//, ""));
      return samePath(candidate, registration.sourceRoot) || Boolean(real(candidate) && real(registration.sourceRoot) && samePath(real(candidate), real(registration.sourceRoot)));
    }
    if (gitSpec(spec)) {
      if (!dependencySpec) unresolvedGit = true;
      return dependencySpec !== null && spec === dependencySpec;
    }
    return npmName(spec) === NAME;
  });
  if (!matches.length) return { mode: "native", state: unresolvedGit ? "unknown" : "disabled", reason: unresolvedGit ? "dependencies-unavailable" : "removed" };
  if (matches.some(entry => (entry.off !== undefined && typeof entry.off !== "boolean") || (entry.options != null && !object(entry.options)))) return { mode: "native", state: "unknown", reason: "invalid-registration" };
  const enabled = matches.filter(entry => entry.off !== true);
  if (!enabled.length) return { mode: "native", state: "disabled", reason: "off" };
  if (!enabled.some(entry => selectedPort(entry) === port)) return { mode: "native", state: "disabled", reason: "wrong-port" };
  return { mode: "native", state: "enabled", reason: "registered" };
}
