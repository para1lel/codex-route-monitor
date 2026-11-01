// Makes deterministic inputs for the parity fixture: plain long number lists,
// as a model would write them. The numbers are not from a model; they only
// need to exercise the whole scoring path on both implementations.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function mulberry32(seed) {
  return function next() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function numbers(seed, count, bias) {
  const rand = mulberry32(seed);
  const out = [];
  for (let index = 0; index < count; index += 1) {
    // a mild bias towards one part of the range, so cases differ
    const roll = rand();
    const value = roll < 0.5 ? Math.floor(1 + rand() * 355 * bias) : Math.floor(1 + rand() * 355);
    out.push(Math.min(355, Math.max(1, value)));
  }
  return out;
}

function text(seed, count, bias, separator) {
  return numbers(seed, count, bias).join(separator);
}

const cases = {
  threeResponses: [
    { expected_count: 300, text: `记录如下：${text(11, 300, 0.7, ", ")}` },
    { expected_count: 310, text: text(12, 310, 1, " ") },
    { expected_count: 295, text: `Here are the numbers.\n${text(13, 295, 0.4, "\n")}` },
  ],
  twoResponses: [
    { expected_count: 292, text: text(21, 292, 0.9, ",") },
    { expected_count: 320, text: text(22, 320, 0.55, ", ") },
  ],
  oneResponse: [{ expected_count: 305, text: text(31, 305, 1.2, "，") }],
};

const out = path.join(HERE, "inputs.json");
fs.writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`);
console.log(`wrote ${out}`);
