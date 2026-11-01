// Model attribution over the ModelTrace fingerprint bank — a JavaScript port
// of ModelTrace's fingerprint.py (https://github.com/xqy2006/ModelTrace, MIT,
// (c) 2026 xqy2006), kept numerically identical to it.
//
// A response is scored against every model's centroid in the bank's shared
// feature space:
//
//   0.75 * nuisance-Hellinger similarity of the marginal distribution
//   + 0.25 * ordered-block similarity
//
// and the three responses are averaged, standardised and turned into a
// probability with the bank's cross-validated softmax temperature.

export const VALUE_MIN = 1;
export const VALUE_MAX = 355;
export const DIMENSION = VALUE_MAX - VALUE_MIN + 1;
export const ALPHA = 0.5;

/**
 * parseNumbers returns the longest run of integers in 1..355 found in `text`,
 * as ModelTrace's parser does: a run is broken where two numbers are separated
 * by letters (so prose around the list does not join it), and numbers outside
 * the range are dropped.
 */
export function parseNumbers(text) {
  const runs = [];
  let current = [];
  let previousEnd = 0;
  const source = String(text ?? "");
  for (const match of source.matchAll(/\d+/g)) {
    const separator = source.slice(previousEnd, match.index);
    const value = Number(match[0]);
    if (current.length && /\p{L}/u.test(separator)) {
      runs.push(current);
      current = [];
    }
    if (value >= VALUE_MIN && value <= VALUE_MAX) current.push(value);
    previousEnd = match.index + match[0].length;
  }
  if (current.length) runs.push(current);
  if (!runs.length) return [];
  let best = runs[0];
  for (const run of runs) if (run.length > best.length) best = run;
  return best;
}

export function countNumbers(numbers) {
  const counts = Array(DIMENSION).fill(0);
  for (const number of numbers) counts[number - VALUE_MIN] += 1;
  return counts;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardize(values) {
  const center = mean(values);
  const variance = mean(values.map((value) => (value - center) ** 2));
  const scale = Math.max(Math.sqrt(variance), 1e-12);
  return values.map((value) => (value - center) / scale);
}

function dot(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index];
  return total;
}

function norm(values) {
  return Math.sqrt(dot(values, values));
}

function normalized(values) {
  const scale = Math.max(norm(values), 1e-12);
  return values.map((value) => value / scale);
}

function subtractBasis(values, basis) {
  const out = values.slice();
  for (const vector of basis ?? []) {
    const projection = dot(out, vector);
    for (let index = 0; index < out.length; index += 1) {
      out[index] -= projection * vector[index];
    }
  }
  return out;
}

function hellingerFeature(counts) {
  const scaled = counts.map((value) => value + ALPHA);
  const total = scaled.reduce((sum, value) => sum + value, 0);
  return scaled.map((value) => Math.sqrt(value / total));
}

// splitIntoFour is numpy.array_split(values, 4): earlier chunks take the
// remainder, one extra element each.
function splitIntoFour(values) {
  const base = Math.floor(values.length / 4);
  const remainder = values.length % 4;
  const chunks = [];
  let start = 0;
  for (let index = 0; index < 4; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    chunks.push(values.slice(start, start + size));
    start += size;
  }
  return chunks;
}

// orderedBlockFeature is ModelTrace's ordered_block_feature(): a 16-bin
// histogram over each quarter of the sequence, plus the last-digit histogram,
// each as a square-root (Hellinger) distribution.
function orderedBlockFeature(numbers) {
  const pieces = [];
  for (const chunk of splitIntoFour(numbers)) {
    const bins = Array(16).fill(0);
    for (const value of chunk) {
      // numpy.histogram(bins=16, range=(1, 356)) puts value v in bin
      // floor((v - 1) / 355 * 16), v = 355 in the last one.
      const index = Math.min(15, Math.floor(((value - VALUE_MIN) * 16) / (VALUE_MAX - VALUE_MIN + 1)));
      bins[index] += 1;
    }
    const smoothed = bins.map((value) => value + 0.5);
    const total = smoothed.reduce((sum, value) => sum + value, 0);
    pieces.push(...smoothed.map((value) => Math.sqrt(value / total)));
  }
  const lastDigits = Array(10).fill(0.5);
  for (const value of numbers) lastDigits[value % 10] += 1;
  const lastTotal = lastDigits.reduce((sum, value) => sum + value, 0);
  pieces.push(...lastDigits.map((value) => Math.sqrt(value / lastTotal)));
  return pieces;
}

function robustScoreCounts(counts, bank) {
  const artifact = bank.robust.hellinger;
  const feature = hellingerFeature(counts);
  let projected = feature.map(
    (value, index) => (value - artifact.feature_mean[index]) / artifact.feature_scale[index],
  );
  projected = subtractBasis(projected, artifact.nuisance_basis);
  projected = normalized(projected);
  const scores = artifact.centroids.map((centroid) => dot(projected, centroid));
  const nuisance = standardize(scores);
  return { fused: nuisance, nuisance };
}

function orderedBlockScores(numbers, bank) {
  const artifact = bank.robust.ordered_blocks;
  const feature = orderedBlockFeature(numbers);
  const standardized = feature.map(
    (value, index) => (value - artifact.feature_mean[index]) / artifact.feature_scale[index],
  );
  const unit = normalized(standardized);
  const environmentScores = artifact.environment_centroids.map((centroids) =>
    centroids.map((centroid) => dot(unit, centroid)),
  );
  const template = standardize(
    artifact.centroids.map((_, modelIndex) =>
      Math.max(...environmentScores.map((scores) => scores[modelIndex])),
    ),
  );
  const projected = normalized(subtractBasis(standardized, artifact.nuisance_basis));
  const nuisance = standardize(artifact.centroids.map((centroid) => dot(projected, centroid)));
  return standardize(template.map((value, index) => 0.5 * value + 0.5 * nuisance[index]));
}

export function robustScoreNumbers(numbers, bank) {
  const marginal = robustScoreCounts(countNumbers(numbers), bank);
  const artifact = bank.robust.ordered_blocks;
  const weight = artifact ? Number(artifact.weight ?? 0) : 0;
  if (!artifact || weight === 0) {
    return { ...marginal, marginal_fused: marginal.fused, ordered: marginal.fused };
  }
  const ordered = orderedBlockScores(numbers, bank);
  const fused = marginal.fused.map((value, index) => (1 - weight) * value + weight * ordered[index]);
  return { fused, nuisance: marginal.nuisance, marginal_fused: marginal.fused, ordered };
}

function softmax(values) {
  const maximum = Math.max(...values);
  const weights = values.map((value) => Math.exp(value - maximum));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((value) => value / total);
}

// jsSimilarity is ModelTrace's js_similarity(): 1 - sqrt(JSD / ln 2) between
// the pooled counts and a model's reference counts.
function jsSimilarity(left, right) {
  const leftTotal = left.reduce((sum, value) => sum + value, 0);
  const rightTotal = right.reduce((sum, value) => sum + value, 0) + ALPHA * DIMENSION;
  const p = left.map((value) => value / leftTotal);
  const q = right.map((value) => (value + ALPHA) / rightTotal);
  const midpoint = p.map((value, index) => (value + q[index]) / 2);
  const divergence = (values) =>
    values.reduce(
      (total, value, index) => (value ? total + value * Math.log(value / midpoint[index]) : total),
      0,
    );
  const js = (divergence(p) + divergence(q)) / 2;
  return 1 - Math.sqrt(js / Math.log(2));
}

export function familyNamesOf(bank) {
  const families = [...new Set(bank.models.map((model) => model.family ?? "models"))];
  const names = {};
  for (const family of families) {
    const model = bank.models.find((item) => (item.family ?? "models") === family && item.family_name);
    names[family] = model?.family_name ?? family;
  }
  return names;
}

/**
 * analyzeOutputs scores a submission's responses. `outputs` is
 * [{ text, expected_count }]; a response whose number list is too short
 * (a refusal, or one cut off) is reported in `diagnostics` and left out, as
 * ModelTrace does. Throws when none of them is usable.
 */
export function analyzeOutputs(outputs, bank) {
  const modelIds = bank.models.map((model) => model.id);
  const valid = [];
  const diagnostics = [];
  outputs.forEach((item, index) => {
    const expected = Number(item.expected_count ?? 0);
    const numbers = parseNumbers(item.text ?? "");
    const minimum = expected ? Math.max(80, Math.ceil(expected * 0.55)) : 80;
    const accepted = numbers.length >= minimum;
    diagnostics.push({ index, parsed_numbers: numbers.length, minimum_numbers: minimum, accepted });
    if (accepted) {
      valid.push({ numbers, counts: countNumbers(numbers), components: robustScoreNumbers(numbers, bank) });
    }
  });
  if (!valid.length) {
    throw new Error("no usable response: the number lists were refused or cut short");
  }

  const combinedScores = modelIds.map((_, modelIndex) => mean(valid.map((item) => item.components.fused[modelIndex])));
  const combinedNuisance = modelIds.map((_, modelIndex) =>
    mean(valid.map((item) => item.components.nuisance[modelIndex])),
  );
  const calibrationKey = String(Math.min(valid.length, 3));
  const calibration = bank.calibration[calibrationKey];
  const probabilities = softmax(combinedScores.map((value) => Number(calibration.beta) * value));
  const pooledCounts = Array.from({ length: DIMENSION }, (_, index) =>
    valid.reduce((sum, item) => sum + item.counts[index], 0),
  );
  const byId = Object.fromEntries(bank.models.map((model) => [model.id, model]));
  const results = modelIds
    .map((model, index) => ({
      model,
      display_name: byId[model].display_name,
      probability: probabilities[index],
      profile_similarity: jsSimilarity(pooledCounts, byId[model].counts),
      score: combinedScores[index],
      nuisance_score: combinedNuisance[index],
    }))
    .sort((left, right) => right.probability - left.probability);

  return {
    prediction: results[0].model,
    prediction_name: results[0].display_name,
    probability: results[0].probability,
    used_outputs: valid.length,
    results,
    diagnostics,
    calibration: {
      queries: calibrationKey,
      beta: Number(calibration.beta),
      cv_accuracy: calibration.cv_accuracy,
    },
    method: bank.method?.name ?? "Ordered-block + nuisance-Hellinger",
  };
}

/**
 * analyzeGlobalOutputs is analyzeOutputs plus the family roll-up that
 * ModelTrace's global report adds.
 */
export function analyzeGlobalOutputs(outputs, bank) {
  const result = analyzeOutputs(outputs, bank);
  const byId = Object.fromEntries(bank.models.map((model) => [model.id, model]));
  const familyOrder = [...new Set(bank.models.map((model) => model.family ?? "models"))];
  const familyNames = familyNamesOf(bank);
  const familyProbabilities = {};
  for (const family of familyOrder) {
    familyProbabilities[family] = result.results
      .filter((item) => (byId[item.model].family ?? "models") === family)
      .reduce((sum, item) => sum + item.probability, 0);
  }
  for (const item of result.results) {
    const family = byId[item.model].family ?? "models";
    item.family = family;
    item.family_name = familyNames[family];
    item.conditional_probability = item.probability / familyProbabilities[family];
  }
  const winner = familyOrder.reduce((best, family) =>
    familyProbabilities[family] > familyProbabilities[best] ? family : best,
  );
  return {
    ...result,
    family_prediction: winner,
    family_prediction_name: familyNames[winner],
    family_probability: familyProbabilities[winner],
    family_probabilities: familyOrder.map((family) => ({
      family,
      display_name: familyNames[family],
      probability: familyProbabilities[family],
    })),
    method: "统一全局稳健数字指纹",
  };
}
