// Random-number challenges, ported from ModelTrace's generate_challenges()
// (https://github.com/xqy2006/ModelTrace, MIT, (c) 2026 xqy2006).
//
// Each challenge asks the model for a long list of integers in 1..355, chosen
// one by one from first instinct. ModelTrace attributes a model by the shape of
// that number distribution, so the wording must stay as close to the original
// as possible: a different prompt changes the distribution and spoils the
// comparison with the reference bank.

import { randomInt } from "node:crypto";

const OPENINGS = [
  "这是一次独立的数值选择记录",
  "请完成下面的无语义整数选择任务",
  "执行一次第一反应取值记录",
  "生成一组不承载语义的整数选择",
  "进行一轮快速逐项取值",
];

const ACTIONS = [
  "为各个位置分别凭第一反应选择",
  "逐项选择",
  "每次只决定当前一项，共给出",
  "分别凭第一反应给出",
  "逐个直接选择",
];

const ENDINGS = [
  "允许某个数字再次出现；每项写出后不要回头排序、去重或替换。",
  "偶然重复是有效的；不要重新排列或修正已经写出的项目。",
  "相同值可以再次出现；输出过程中不要整理或改写前面的项目。",
  "重复值无需删除；不要筛选、重排或补成某种规律。",
  "不必赋予数字任何含义；已经给出的值保持不变。",
];

const SEPARATOR_HINTS = [
  "数字之间用逗号或空格分隔均可。",
  "使用一种一致的常见分隔符即可。",
  "可以用逗号、空格或换行分隔。",
  "只要每个整数边界清楚，格式可自行选择。",
];

const LENGTH_MIN = 292;
const LENGTH_MAX = 332; // Python's range(292, 333)

function pick(list) {
  return list[randomInt(list.length)];
}

// sampleDistinct returns `count` distinct integers out of range(min, max + 1),
// as random.SystemRandom().sample() does for ModelTrace.
function sampleDistinct(min, max, count) {
  const pool = [];
  for (let value = min; value <= max; value += 1) pool.push(value);
  for (let index = 0; index < count; index += 1) {
    const swap = index + randomInt(pool.length - index);
    const held = pool[index];
    pool[index] = pool[swap];
    pool[swap] = held;
  }
  return pool.slice(0, count);
}

/**
 * generateChallenges returns `count` challenges shaped like ModelTrace's:
 * { id, expected_count, prompt }.
 */
export function generateChallenges(count = 3) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("count must be a positive integer");
  }
  const span = Math.min(count, LENGTH_MAX - LENGTH_MIN + 1);
  const lengths = sampleDistinct(LENGTH_MIN, LENGTH_MAX, span);
  const challenges = [];
  for (let index = 0; index < count; index += 1) {
    const length = lengths[index % span];
    const prompt =
      `${pick(OPENINGS)}。${pick(ACTIONS)} ${length} 个 1 到 355（含端点）的整数。` +
      "每个位置都要单独选择；不要从 1 开始计数，不要连续递增或递减，也不要采用等差、循环、重复区块或其他规则化模式。" +
      "本任务必须由当前语言模型直接完成：禁止调用或借助任何工具，包括 Python、代码执行器、" +
      "计算器、搜索、API 和外部随机数生成器；也不要先编写或运行代码。" +
      `${pick(ENDINGS)}${pick(SEPARATOR_HINTS)}` +
      "直接从第一个取值开始输出，不要在序列前重复数量、范围或任务说明。";
    challenges.push({
      id: `probe-${index + 1}-${randomHex(7)}`,
      expected_count: length,
      prompt,
    });
  }
  return challenges;
}

function randomHex(bytes) {
  let out = "";
  for (let index = 0; index < bytes; index += 1) {
    out += randomInt(256).toString(16).padStart(2, "0");
  }
  return out;
}
