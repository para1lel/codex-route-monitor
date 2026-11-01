import assert from "node:assert/strict";
import test from "node:test";
import { generateChallenges } from "../lib/challenges.mjs";

test("a challenge is a long 1..355 number list, one per position", () => {
  const challenges = generateChallenges(3);
  assert.equal(challenges.length, 3);
  const lengths = new Set();
  for (const challenge of challenges) {
    assert.match(challenge.id, /^probe-[1-3]-[0-9a-f]{14}$/);
    assert.ok(challenge.expected_count >= 292 && challenge.expected_count <= 332, "length in ModelTrace's range");
    lengths.add(challenge.expected_count);
    assert.ok(challenge.prompt.includes(`${challenge.expected_count} 个 1 到 355`), "the count and range are said");
    assert.ok(challenge.prompt.includes("禁止调用或借助任何工具"), "tools are refused in the prompt");
    assert.ok(challenge.prompt.includes("直接从第一个取值开始输出"), "it starts with the numbers");
  }
  assert.equal(lengths.size, 3, "the three lengths differ, as ModelTrace samples without repeats");
});

test("challenges differ from run to run", () => {
  const first = generateChallenges(3).map((item) => item.id).join(",");
  const second = generateChallenges(3).map((item) => item.id).join(",");
  assert.notEqual(first, second);
});

test("a count of one or more is accepted, nonsense is not", () => {
  assert.equal(generateChallenges(1).length, 1);
  assert.throws(() => generateChallenges(0));
  assert.throws(() => generateChallenges(1.5));
});
