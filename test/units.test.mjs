import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePoolText, providerOffFrom } from "../lib/magpie.mjs";
import { parseNumbers } from "../lib/fingerprint.mjs";
import { writeCodexHome } from "../lib/probe.mjs";

test("magpie's pool report says which accounts take part", () => {
  const text = [
    "1. on  omoyan0_1@163.com · no cap: used to 100%",
    "2. off woshijuruo@gmail.com · capped at 90%",
    "stop at caps · off: at the caps, a request goes on to the fallbacks (none set, so it is answered 429)",
  ].join("\n");
  assert.deepEqual(parsePoolText(text), [
    { user: "omoyan0_1@163.com", enabled: true },
    { user: "woshijuruo@gmail.com", enabled: false },
  ]);
  assert.deepEqual(parsePoolText(""), []);
});

test("a provider magpie was told to leave alone is read as off", () => {
  assert.equal(providerOffFrom({ providers: [{ id: "codex", off: true }] }, "codex"), true);
  assert.equal(providerOffFrom({ providers: [{ id: "codex" }] }, "codex"), false);
  assert.equal(providerOffFrom({ providers: [{ id: "other", off: true }] }, "codex"), false);
  assert.equal(providerOffFrom({}, "codex"), false);
  assert.equal(providerOffFrom(null, "codex"), false);
});

test("the parser keeps the longest run of numbers in range", () => {
  assert.deepEqual(parseNumbers("here: 1 2 3 999 4 5"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseNumbers("x 12 13 then words 21 22 23 24"), [21, 22, 23, 24]);
  assert.deepEqual(parseNumbers("no numbers here"), []);
  assert.deepEqual(parseNumbers("1, 2, 355"), [1, 2, 355]);
  assert.deepEqual(parseNumbers("356 357"), []);
});

test("a probe's CODEX_HOME talks to magpie and names one account", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-home-"));
  try {
    writeCodexHome({
      dir,
      config: { model: "codex/gpt-6.1-sol", effort: "low", gatewayKey: "magpie" },
      gateway: "http://127.0.0.1:3425",
      account: "someone@example.com",
    });
    const toml = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    assert.match(toml, /^model = "codex\/gpt-6\.1-sol"$/m);
    assert.match(toml, /^model_provider = "magpie-monitor"$/m);
    assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:3425\/v1"/);
    assert.match(toml, /"X-Magpie-Account" = "someone@example\.com"/);
    assert.match(toml, /experimental_bearer_token = "magpie"/);
    assert.doesNotMatch(toml, /requires_openai_auth = true/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an account's address is escaped in the TOML", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-home-"));
  try {
    writeCodexHome({
      dir,
      config: { model: "codex/gpt-6.1-sol", effort: "low", gatewayKey: "magpie" },
      gateway: "http://127.0.0.1:3425",
      account: 'weird"name@example.com',
    });
    const toml = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    assert.match(toml, /"X-Magpie-Account" = "weird\\"name@example\.com"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
