#!/usr/bin/env node
/**
 * 真实照片成对评估：用用户生成的 8 张真实穿搭照（4 组，每组一套明显合适 + 一套明显不合适），
 * 比较 `laya_only` 与 `laya_review` 两档的**方向正确率**。
 *
 * 为什么这才是关键证据：之前的夹具是抽象扁平插画，只能证明"链路通、纠正会改分"，
 * 证明不了"判断准"。这 8 张是真实照片摄影质感，且成对设计给出客观标尺——
 * 应赢的那套分数是不是真的更高，不靠主观判断。
 *
 * 前置：
 *   1) C:\博830\vibecoding\laya-service\start-laya.cmd   （8000）
 *   2) cd outfit-decider && cmd /c "npm run laya"          （8787，含 DeepSeek 视觉）
 * 用法：node tools/laya-real-photo-eval.mjs [--adapter http://127.0.0.1:8787] [--pairs A,B,C,D]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeApi, DEFAULT_CONFIG } from '../src/engine/api.js';
import { makeOrchestrator } from '../src/engine/orchestrator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const ADAPTER = argValue('adapter', 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ONLY = argValue('pairs', '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

/** 设计要求：每组的 first 是「应赢」、second 是「应输」。 */
const PAIRS = [
  {
    id: 'A',
    occasion: 'interview',
    sceneLabel: '正式面试',
    style: ['minimal'],
    first: { file: 'A1-interview-suit.jpg', label: '藏青西装+白真丝衬衫+中跟单鞋' },
    second: { file: 'A2-interview-casual.jpg', label: '卡通卫衣+花短裤+人字拖+荧光泳帽' },
  },
  {
    id: 'B',
    occasion: 'date',
    sceneLabel: '约会见面',
    style: ['sweet'],
    first: { file: 'B1-date-dress.jpg', label: '浅粉方领衬衫+白高腰A字裙+玛丽珍鞋' },
    second: { file: 'B2-date-padded.jpg', label: '长款厚羽绒服全包住+雪地靴' },
  },
  {
    id: 'C',
    occasion: 'sport',
    sceneLabel: '运动健身',
    style: ['cool'],
    first: { file: 'C1-sport-set.jpg', label: '速干背心+高腰紧身运动裤+跑鞋' },
    second: { file: 'C2-sport-leather.jpg', label: '皮夹克+雪纺衬衫+百褶长裙+细高跟' },
  },
  {
    id: 'D',
    occasion: 'commute',
    sceneLabel: '通勤上班',
    style: ['minimal'],
    first: { file: 'D1-commute-shirt.jpg', label: '白衬衫+驼色开衫+直筒西裤+乐福鞋' },
    second: { file: 'D2-commute-crop.jpg', label: '露脐短上衣+超短百褶裙+长筒靴' },
  },
];

function artifactOf(dir, file, lookId) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) throw new Error(`missing photo: ${full}`);
  return {
    lookId,
    mime: 'image/jpeg',
    base64: fs.readFileSync(full).toString('base64'),
    width: 0,
    height: 0,
  };
}

const f1 = (n) => (typeof n === 'number' ? n.toFixed(1) : '—');

async function runPair(pair, engineMode) {
  const api = makeApi({
    config: {
      ...DEFAULT_CONFIG,
      baseUrl: ADAPTER,
      askPath: '/ask',
      model: 'laya',
      engineMode,
      // 本机部署形态：视觉模型配在**服务端**（适配器读自己的 .env.local 调 DeepSeek），
      // 所以 App 侧没有 visionBaseUrl/visionModel。这正是 visionServerSide 的用途——
      // 不设它的话 laya_review 会以 vision_unconfigured 放弃纠正（第一次跑就踩到了）。
      visionServerSide: true,
    },
  });
  const orchestrator = makeOrchestrator({ api, model: 'laya', engineMode });
  const artifacts = [
    artifactOf(path.join(ROOT, 'fixtures', 'images-real'), pair.first.file, 'look1'),
    artifactOf(path.join(ROOT, 'fixtures', 'images-real'), pair.second.file, 'look2'),
  ];
  const started = Date.now();
  const quick = await orchestrator.runQuick({
    artifacts,
    userState: { occasion: [pair.occasion], weather: ['cool'], style: pair.style, note: '' },
    question: { builtinId: 'best_for_occasion', text: `哪套最适合${pair.sceneLabel}？` },
  });
  return { quick, ms: Date.now() - started };
}

function summarize(quick) {
  const byId = {};
  for (const row of quick.ranked) byId[row.lookId] = row;
  return {
    winner: quick.ranked[0] ? quick.ranked[0].lookId : null,
    look1: byId.look1 ? { overall: byId.look1.scores.overall_score, scene: byId.look1.scores.scene_score, rank: byId.look1.rank } : null,
    look2: byId.look2 ? { overall: byId.look2.scores.overall_score, scene: byId.look2.scores.scene_score, rank: byId.look2.rank } : null,
    reviewFailed: quick.reviewFailed === true,
    reviewErrorKind: quick.reviewErrorKind || null,
    reviewModel: quick.reviewModel || null,
  };
}

const pairs = ONLY.length ? PAIRS.filter((p) => ONLY.includes(p.id)) : PAIRS;
const results = [];

for (const pair of pairs) {
  process.stdout.write(`\n=== ${pair.id} 组 · ${pair.sceneLabel} ===\n`);
  process.stdout.write(`  应赢: ${pair.first.label}\n`);
  process.stdout.write(`  应输: ${pair.second.label}\n`);
  for (const mode of ['laya_only', 'laya_review']) {
    try {
      const { quick, ms } = await runPair(pair, mode);
      const s = summarize(quick);
      const correct = s.winner === 'look1';
      results.push({ pair: pair.id, mode, correct, ...s, ms });
      process.stdout.write(
        `  ${mode.padEnd(16)} 第1名=${s.winner} 应赢${s.look1.overall} / 应输${s.look2.overall} `
        + `场景${s.look1.scene}/${s.look2.scene} ${correct ? 'PASS' : 'FAIL'} ${ms}ms`
        + `${s.reviewFailed ? ` reviewFailed=${s.reviewErrorKind}` : ''}\n`,
      );
    } catch (err) {
      process.stdout.write(`  ${mode.padEnd(16)} ERROR kind=${err.kind || '?'} ${String(err.message).slice(0, 100)}\n`);
      results.push({ pair: pair.id, mode, error: `${err.kind || '?'}: ${String(err.message).slice(0, 80)}` });
    }
  }
}

process.stdout.write('\n=== 汇总 ===\n');
for (const mode of ['laya_only', 'laya_review']) {
  const rows = results.filter((r) => r.mode === mode && !r.error);
  const pass = rows.filter((r) => r.correct).length;
  process.stdout.write(`${mode.padEnd(16)} 方向正确 ${pass}/${rows.length}\n`);
}

// 纠正前后的"该赢减去该输"分差：差得越开说明判断越有分辨力
process.stdout.write('\n=== 纠正是否让"该赢"更赢（overall 差值）===\n');
for (const pair of pairs) {
  const pick = (mode) => results.find((r) => r.pair === pair.id && r.mode === mode && !r.error);
  const a = pick('laya_only');
  const b = pick('laya_review');
  if (!a || !b) continue;
  const gapA = a.look1.overall - a.look2.overall;
  const gapB = b.look1.overall - b.look2.overall;
  process.stdout.write(
    `${pair.id} 组  Laya 差=${gapA >= 0 ? '+' : ''}${gapA.toFixed(1)}  →  纠正后差=${gapB >= 0 ? '+' : ''}${gapB.toFixed(1)}`
    + `  ${gapB > gapA ? '（更分明）' : gapB === gapA ? '（不变）' : '（更模糊）'}\n`,
  );
}

const reportPath = path.join(ROOT, 'artifacts', 'real-photo-eval.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({ adapter: ADAPTER, results }, null, 1), 'utf8');
process.stdout.write(`\n报告: ${reportPath}\n`);
