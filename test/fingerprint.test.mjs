import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeGlobalOutputs } from "../lib/fingerprint.mjs";
import { loadBank } from "../lib/bank.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const inputs = JSON.parse(fs.readFileSync(path.join(HERE, "parity", "inputs.json"), "utf8"));
const expected = JSON.parse(fs.readFileSync(path.join(HERE, "parity", "expected.json"), "utf8"));

function close(actual, wanted, label, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - wanted) <= tolerance,
    `${label}: ${actual} is not ${wanted} (${Math.abs(actual - wanted)} off)`,
  );
}

// The JavaScript port has to answer exactly what ModelTrace's own
// fingerprint.py answered for the same responses and bank.
test("scoring matches ModelTrace's fingerprint.py", () => {
  const bank = loadBank();
  for (const [name, outputs] of Object.entries(inputs)) {
    const wanted = expected[name];
    const got = analyzeGlobalOutputs(outputs, bank);
    assert.equal(got.prediction, wanted.prediction, `${name}: prediction`);
    assert.equal(got.used_outputs, wanted.used_outputs, `${name}: used outputs`);
    assert.equal(got.family_prediction, wanted.family_prediction, `${name}: family`);
    close(got.probability, wanted.probability, `${name}: top probability`, 1e-9);
    close(got.family_probability, wanted.family_probability, `${name}: family probability`, 1e-9);
    close(got.calibration.beta, wanted.calibration.beta, `${name}: beta`);
    assert.equal(got.calibration.queries, String(wanted.calibration.queries), `${name}: calibration key`);
    for (const [index, item] of got.results.entries()) {
      const target = wanted.results[index];
      assert.equal(item.model, target.model, `${name}: model ${index}`);
      close(item.probability, target.probability, `${name}: ${target.model} probability`, 1e-9);
      close(item.score, target.score, `${name}: ${target.model} score`, 1e-9);
      close(item.profile_similarity, target.profile_similarity, `${name}: ${target.model} similarity`, 1e-9);
      close(
        item.conditional_probability,
        target.conditional_probability,
        `${name}: ${target.model} conditional`,
        1e-9,
      );
    }
    assert.deepEqual(
      got.diagnostics.map((item) => [item.index, item.parsed_numbers, item.accepted]),
      wanted.diagnostics.map((item) => [item.index, item.parsed_numbers, item.accepted]),
      `${name}: diagnostics`,
    );
  }
});
