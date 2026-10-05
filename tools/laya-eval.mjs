#!/usr/bin/env node
/**
 * 验证 Laya 在本产品上的可用性：确定性 + 区分度。
 *
 * 为什么必须做这一步：Laya 是一个**通用决策**模型，不是时尚评审模型。它能对任何
 * 问题输出分数，但"能输出"不等于"输出有意义"。在把 App 接到它之前，必须证明两件事：
 *   1) 确定性——同一输入两次调用得到同一结果（否则 App 的排序会无故抖动）；
 *   2) 区分度——明显好/坏的穿搭要拿到明显不同的分数（否则接进去等于接了个随机数）。
 *
 * 用法：node tools/laya-eval.mjs [--upstream http://127.0.0.1:8000]
 */
import { SCORE_RUBRICS, SCORE_INSTRUCTIONS, sceneOf } from './laya-adapter.mjs';

const argv = process.argv.slice(2);
const i = argv.indexOf('--upstream');
const UPSTREAM = (i >= 0 && argv[i + 1] ? argv[i + 1] : 'http://127.0.0.1:8000').replace(/\/+$/, '');

/**
 * 问句与档位**必须与 tools/laya-adapter.mjs 保持一致**，否则这个评估测的不是线上真实问法。
 * 这里直接从适配器导入，不复制一份。
 */
function questions(state) {
  const scene = sceneOf(state);
  const out = {};
  for (const [id, criteria] of Object.entries(SCORE_RUBRICS)) {
    const template = SCORE_INSTRUCTIONS[id] || '{scene}穿这一套得体吗？';
    out[id] = {
      type: 'score',
      instructions: template.replace('{scene}', scene),
      criteria,
    };
  }
  return out;
}

const GOOD = `【穿搭一】
整体风格：简约通勤风，线条干净利落；上衣：浅蓝色棉质衬衫，版型合身，袖口平整；下装：深灰色直筒九分西裤，裤线清晰；鞋履：白色低帮皮质板鞋，鞋面干净；配饰：细棕色皮带与银色表盘腕表，风格统一；身材视觉效果：腰线清晰可见，上下身比例匀称；其他细节：衬衫下摆收进裤腰，整体干净利落

【我的场合】正式面试
【我的天气】凉爽
【我的风格偏好】简约干练

【我的问题】哪套最适合今天的场合？`;

const BAD = `【穿搭一】
整体风格：风格杂乱，上下身不属于同一种场合；上衣：亮橙色宽松运动卫衣，印有大面积卡通图案，下摆外放；下装：印花朵纹的运动短裤，裤长及膝；鞋履：磨损明显的旧拖鞋；配饰：头上戴荧光绿色游泳帽，脖子上挂大串塑料珠链；身材视觉效果：腰部被宽松卫衣完全遮挡，比例不清晰；其他细节：衣着明显偏休闲运动

【我的场合】正式面试
【我的天气】凉爽
【我的风格偏好】简约干练

【我的问题】哪套最适合今天的场合？`;

const MID = `【穿搭一】
整体风格：日常休闲；上衣：白色纯棉短袖T恤，版型合身；下装：深蓝色直筒牛仔裤，长度合适；鞋履：白色运动鞋，略旧；配饰：未清晰显示；身材视觉效果：上下身比例正常；其他细节：无明显图案

【我的场合】正式面试
【我的天气】凉爽
【我的风格偏好】简约干练

【我的问题】哪套最适合今天的场合？`;

async function predict(state) {
  const started = Date.now();
  const response = await fetch(`${UPSTREAM}/v1/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, questions: questions(state) }),
  });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  const scores = {};
  for (const [id, answer] of Object.entries(body.answers || {})) {
    // answer_confidence 是「这个答案可信度」，confidence 是熵置信度（语料里对决策不确定性的度量）。
    // 实测两者可差一个数量级，这里优先取 answer_confidence。
    const conf = answer.answer_confidence !== undefined ? answer.answer_confidence : answer.confidence;
    scores[id] = { score: answer.score, confidence: conf };
  }
  return { scores, ms: Date.now() - started, routing: body.routing && body.routing.model };
}

function fmt(scores) {
  return Object.entries(scores)
    .map(([id, v]) => `${id.replace('_score', '')}=${Number(v.score).toFixed(2)}(conf ${Number(v.confidence).toFixed(2)})`)
    .join(' ');
}

const round = (n) => Math.round(n * 100) / 100;

async function main() {
  const results = {};
  for (const [name, state] of [['GOOD', GOOD], ['BAD', BAD], ['MID', MID]]) {
    const first = await predict(state);
    const second = await predict(state);
    const deterministic = JSON.stringify(first.scores) === JSON.stringify(second.scores);
    results[name] = { first, second, deterministic };
    console.log(`${name.padEnd(5)} ms=${String(first.ms).padStart(5)} routing=${first.routing}`);
    console.log(`      run1 ${fmt(first.scores)}`);
    console.log(`      run2 ${fmt(second.scores)}  deterministic=${deterministic}`);
  }

  const overall = (name) => results[name].first.scores.overall_score.score;
  const scene = (name) => results[name].first.scores.scene_score.score;
  console.log('');
  console.log('--- verdict ---');
  const allDeterministic = Object.values(results).every((r) => r.deterministic);
  console.log(`determinism      : ${allDeterministic ? 'PASS' : 'FAIL'}`);
  console.log(`overall GOOD-BAD : ${round(overall('GOOD') - overall('BAD'))} (GOOD ${round(overall('GOOD'))} vs BAD ${round(overall('BAD'))})`);
  console.log(`scene   GOOD-BAD : ${round(scene('GOOD') - scene('BAD'))} (GOOD ${round(scene('GOOD'))} vs BAD ${round(scene('BAD'))})`);
  console.log(`monotonic order  : ${overall('GOOD') > overall('MID') && overall('MID') > overall('BAD') ? 'PASS' : 'FAIL'} (GOOD>=MID>=BAD)`);

  const avgConfidence = Object.values(results)
    .flatMap((r) => Object.values(r.first.scores))
    .reduce((sum, v) => sum + Number(v.confidence), 0) / (Object.values(results).flatMap((r) => Object.values(r.first.scores)).length);
  console.log(`avg confidence   : ${round(avgConfidence)}`);
}

main().catch((err) => {
  console.log(`ERROR ${err.message}`);
  process.exitCode = 1;
});
