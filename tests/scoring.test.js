// SPEC §3.3 汇总层单测：置信度、极值汇总、质量门槛、描述可识别性。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeConfidence,
  isMeaningfulDescription,
  meetsMinQuality,
  rankLooks,
  summarize,
} from '../src/core/scoring.js';
import { rankLooks as protocolRankLooks } from '../src/core/protocol.js';
import { UNRECOGNIZABLE_TEXT } from './helpers/fetchMock.js';

const FULL = {
  overall_score: 4,
  aesthetic_score: 5,
  scene_score: 3,
  figure_score: 4.5,
  style_score: 4,
  practical_score: 3.5,
};

test('computeConfidence：各维度均值，空集 → 0', () => {
  const confidences = {
    overall_score: 0.8,
    aesthetic_score: 0.8,
    scene_score: 0.8,
    figure_score: 0.8,
    style_score: 0.8,
    practical_score: 0.8,
  };
  assert.equal(computeConfidence(FULL, confidences), 0.8);
  assert.equal(computeConfidence({}, {}), 0);
  assert.equal(computeConfidence(null, null), 0);
  assert.equal(computeConfidence(FULL, {}), 0.5, '缺 confidence 时按协议默认 0.5');
});

test('computeConfidence：只统计有分数的维度，越界 confidence 钳制', () => {
  const scores = { overall_score: 4, aesthetic_score: 3, scene_score: null, figure_score: null, style_score: null, practical_score: null };
  const confidences = { overall_score: 0.6, aesthetic_score: 0.8, scene_score: 0.9, figure_score: 0.9 };
  assert.equal(computeConfidence(scores, confidences), 0.7, '只有前两个维度计入');
  assert.equal(computeConfidence(scores, { overall_score: 5, aesthetic_score: 1 }), 1, '越界钳制到 [0,1]');
});

test('summarize：best/worst/avg；并列取维度顺序靠前者；空集全 null', () => {
  assert.deepEqual(summarize(FULL), { best: 'aesthetic_score', worst: 'scene_score', avg: 4 });
  assert.deepEqual(summarize({ overall_score: 4, aesthetic_score: 4, scene_score: Number.NaN }), {
    best: 'overall_score',
    worst: 'overall_score',
    avg: 4,
  });
  assert.deepEqual(summarize({}), { best: null, worst: null, avg: 0 });
  assert.deepEqual(summarize(null), { best: null, worst: null, avg: 0 });
  const avg = summarize({ overall_score: 4.1, aesthetic_score: 4.2 }).avg;
  assert.equal(avg, 4.15, 'avg 保留两位小数');
});

test('isMeaningfulDescription：空 / 全「未清晰显示」判否，部分可见判真', () => {
  assert.equal(isMeaningfulDescription(''), false);
  assert.equal(isMeaningfulDescription('   '), false);
  assert.equal(isMeaningfulDescription('未清晰显示'), false);
  assert.equal(isMeaningfulDescription(UNRECOGNIZABLE_TEXT), false, '7 维全为未清晰显示 → 无有效穿搭');
  assert.equal(isMeaningfulDescription('整体风格：简约干练；配饰：未清晰显示'), true);
  assert.equal(isMeaningfulDescription('整体风格：未清晰显示\n上衣：米白色针织短袖'), true);
  assert.equal(isMeaningfulDescription(null), false);
  assert.equal(isMeaningfulDescription(42), false);
});

test('meetsMinQuality：描述非空且 ≥1 维有分数', () => {
  assert.equal(meetsMinQuality([
    { id: 'describe_look1', type: 'text', content: '整体风格：简约干练' },
    { id: 'overall_score', type: 'score', score: 4 },
  ]), true);
  assert.equal(meetsMinQuality([
    { id: 'describe_look1', type: 'text', content: UNRECOGNIZABLE_TEXT },
    { id: 'overall_score', type: 'score', score: 4 },
  ]), false);
  assert.equal(meetsMinQuality([
    { id: 'describe_look1', type: 'text', content: '' },
    { id: 'overall_score', type: 'score', score: 4 },
  ]), false);
  assert.equal(meetsMinQuality([{ id: 'describe_look1', type: 'text', content: '整体风格：简约' }]), false);
  assert.equal(meetsMinQuality({ description: '整体风格：简约', scores: { overall_score: 4 } }), true);
  assert.equal(meetsMinQuality({ description: '整体风格：简约', scores: {} }), false);
  assert.equal(meetsMinQuality('整体风格：未清晰显示'), false);
  assert.equal(meetsMinQuality(null), false);
});

test('scoring.rankLooks 与 protocol.rankLooks 行为一致', () => {
  const rows = [
    { lookId: 'look3', scores: { overall_score: 2 } },
    { lookId: 'look1', scores: { overall_score: 4 } },
    { lookId: 'look2', scores: { overall_score: null } },
  ];
  assert.deepEqual(rankLooks(rows), protocolRankLooks(rows));
});
