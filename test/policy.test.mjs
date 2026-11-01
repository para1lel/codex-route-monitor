import assert from "node:assert/strict";
import test from "node:test";
import { verdictOf, lunaProbability, topResults } from "../lib/policy.mjs";

const config = { riskModels: ["gpt-5.6-luna", "gpt-6-luna"] };

function diagnosis(models) {
  const results = models.map(([model, probability]) => ({
    model,
    display_name: model.toUpperCase(),
    probability,
    profile_similarity: 0,
    score: 0,
  }));
  return {
    results,
    family_prediction: "gpt",
    family_prediction_name: "GPT",
  };
}

test("a Luna answer means the account is held back", () => {
  for (const model of ["gpt-5.6-luna", "gpt-6-luna"]) {
    const verdict = verdictOf(diagnosis([[model, 0.7], ["gpt-6-sol", 0.3]]), config);
    assert.equal(verdict.verdict, "risk", model);
    assert.equal(verdict.model, model);
  }
});

test("any other top answer means the account is fine", () => {
  for (const model of ["gpt-6-sol", "gpt-6.1-sol", "gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra"]) {
    const verdict = verdictOf(diagnosis([[model, 0.6], ["gpt-5.6-luna", 0.4]]), config);
    assert.equal(verdict.verdict, "ok", model);
  }
});

test("a Luna answer that is not the top one does not condemn the account", () => {
  const value = diagnosis([["gpt-6-sol", 0.62], ["gpt-6-luna", 0.38]]);
  const verdict = verdictOf(value, config);
  assert.equal(verdict.verdict, "ok");
  assert.ok(Math.abs(lunaProbability(value, config) - 0.38) < 1e-12);
});

test("topResults keeps the order and the fields a record needs", () => {
  const top = topResults(diagnosis([["b", 0.9], ["a", 0.1]]), 2);
  assert.deepEqual(top.map((item) => item.model), ["b", "a"]);
  assert.equal(top[0].probability, 0.9);
});
