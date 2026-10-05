#!/usr/bin/env node
/**
 * 真实纠正效果评估：用**真实图片** + **真实 DeepSeek** 回答一个问题——
 * 「Laya 判断力不合格，多模态纠正真的能救回来吗？」
 *
 * 做法：同一组图片分别跑
 *   A) laya_only        → Laya 自己的 6 维分
 *   B) laya_review      → Laya 打分后再由 deepseek-flash 直接看图纠正
 * 然后比较「得体一套 − 荒谬一套」的分差。纠正有效的判据是：
 *   1) 得体套的综合分明显高于荒谬套（分差变大）；
 *   2) 场合适配度方向正确（得体 > 荒谬），而 Laya 实测是反的。
 *
 * key/model 从 .env.local 读；不写死在代码里。
 * 用法：node tools/laya-real-review-eval.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeApi, DEFAULT_CONFIG } from '../src/engine/api.js';
import { makeOrchestrator } from '../src/engine/orchestrator.js';
import { SCORE_QUESTION_IDS } from '../src/core/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...loadEnv(), ...process.env };
if (!env.VISION_API_KEY || !env.VISION_MODEL) {
  console.log('ERROR .env.local 缺少 VISION_API_KEY / VISION_MODEL');
  process.exit(1);
}

/**
 * 我们的夹具图是抽象扁平插画（不是真实照片），对"看衣服"这件事信息量有限。
 * 这正是要暴露的现实：夹具能验证链路，但不能验证真实审美判断。
 * 所以脚本会把这一点写进结论里，而不是假装夹具图代表了真实穿搭照。
 */
const FIXTURE_LOOKS = [
  { lookId: 'look1', file: 'look1.jpg', note: '浅蓝上衣 + 深色长裤（通勤感）' },
  { lookId: 'look3', file: 'look3.jpg', note: '深色外套 + 深蓝裤（偏酷飒）' },
];

const artifacts = FIXTURE_LOOKS.map((item) => ({
  lookId: item.lookId,
  mime: 'image/jpeg',
  base64: fs.readFileSync(path.join(ROOT, 'fixtures', 'images', item.file)).toString('base64'),
  width: 390,
  height: 520,
}));

const userState = {
  occasion: ['interview'],
  weather: ['cool'],
  style: ['minimal'],
  note: '正式面试，希望看起来干净利落、不随意',
};
const question = { builtinId: 'best_for_occasion', text: '哪套最适合今天的场合？' };

function build(engineMode) {
  const api = makeApi({
    config: {
      ...DEFAULT_CONFIG,
      baseUrl: env.LAYA_ADAPTER_URL || 'http://127.0.0.1:8787',
      model: 'laya',
      engineMode,
      visionBaseUrl: env.VISION_BASE_URL,
      visionModel: env.VISION_MODEL,
      visionApiKey: env.VISION_API_KEY,
    },
  });
  return makeOrchestrator({ api, model: 'laya', engineMode });
}

const f = (n) => (n === null || n === undefined ? '—' : Number(n).toFixed(1));

async function run(engineMode) {
  const started = Date.now();
  const quick = await build(engineMode).runQuick({ artifacts, userState, question });
  return { quick, ms: Date.now() - started };
}

function table(quick) {
  const header = ['lookId', ...SCORE_QUESTION_IDS.map((id) => id.replace('_score', ''))];
  const lines = [header.map((h) => h.padEnd(11)).join('')];
  for (const row of quick.ranked) {
    lines.push([
      row.lookId.padEnd(11),
      ...SCORE_QUESTION_IDS.map((id) => f(row.scores[id]).padEnd(11)),
    ].join(''));
  }
  return lines.join('\n');
}

const results = {};
for (const mode of ['laya_only', 'laya_review']) {
  try {
    results[mode] = await run(mode);
  } catch (err) {
    console.log(`\n=== ${mode} ===\n  ERROR kind=${err.kind || '?'} ${String(err.message).slice(0, 120)}`);
  }
}

for (const mode of Object.keys(results)) {
  const { quick, ms } = results[mode];
  console.log(`\n=== ${mode} (${ms} ms) ===`);
  console.log(table(quick));
  console.log(`  reviewModel=${quick.reviewModel || '-'} reviewFailed=${quick.reviewFailed || false} changed=${(quick.reviewChanged || []).length}`);
}

if (results.laya_only && results.laya_review) {
  const byId = (quick, lookId) => quick.byLook[lookId].scores;
  console.log('\n=== 纠正前后对比（同一组图、同一场合）===');
  for (const id of SCORE_QUESTION_IDS) {
    const before = byId(results.laya_only.quick, 'look1')[id];
    const after = byId(results.laya_review.quick, 'look1')[id];
    const delta = Number(after) - Number(before);
    const mark = Math.abs(delta) >= 0.5 ? '  ← 明显改动' : '';
    console.log(`  look1 ${id.padEnd(17)} Laya=${f(before)} → 纠正后=${f(after)}  Δ=${delta >= 0 ? '+' : ''}${delta.toFixed(1)}${mark}`);
  }
  const pick = (quick) => quick.ranked[0].lookId;
  console.log(`\n  第 1 名： Laya=${pick(results.laya_only.quick)}  纠正后=${pick(results.laya_review.quick)}`);
}

console.log('\n注意：夹具图是抽象扁平插画，不是真实穿搭照。');
console.log('     它能证明「链路通、纠正确实改变了分数」，但不能证明真实审美判断的准确度；');
console.log('     要评准确度需要用真实穿搭照片跑同一套对照。');
