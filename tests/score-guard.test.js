// SPEC §3.1 补充 · 分数越界检测单测：整轮量纲错配绝不能被静默夹住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OUTLIER_RATIO_THRESHOLD,
  SCORE_MAX,
  SCORE_MIN,
  auditScores,
  shouldRejectScores,
} from '../src/core/scoreGuard.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'src', 'core', 'scoreGuard.js'), 'utf8');

const IDS = [
  'overall_score',
  'aesthetic_score',
  'scene_score',
  'figure_score',
  'style_score',
  'practical_score',
];

/** 把 6 个原始分组装成协议层那种条目形状 */
const answers = (values) => IDS.map((id, i) => ({ id, score: values[i] }));

test('常量：量表 0–5，默认越界阈值 0.2', () => {
  assert.equal(SCORE_MIN, 0);
  assert.equal(SCORE_MAX, 5);
  assert.equal(OUTLIER_RATIO_THRESHOLD, 0.2);
});

test('正常一轮：全部在 [0,5] 内 → ok=true、无 outliers、ratio=0', () => {
  const audit = auditScores(answers([4.5, 3, 0, 5, 2.4, 1]));
  assert.deepEqual(audit, { ok: true, outliers: [], total: 6, outlierCount: 0, ratio: 0 });
  assert.equal(shouldRejectScores(audit), false);
});

test('边界：恰好等于 0 / 5 不算越界，越出一点点就算', () => {
  const audit = auditScores([
    { id: 'a', score: 0 },
    { id: 'b', score: 5 },
    { id: 'c', score: 5.0001 },
    { id: 'd', score: -0.0001 },
  ]);
  assert.deepEqual(audit.outliers, [
    { id: 'c', value: 5.0001 },
    { id: 'd', value: -0.0001 },
  ]);
  assert.equal(audit.total, 4);
  assert.equal(audit.outlierCount, 2);
  assert.equal(audit.ratio, 0.5);
  assert.equal(audit.ok, false);
});

test('1–10 量纲：整轮越界 → 6/6、ratio=1、应拒绝（核心事故场景）', () => {
  const values = [8, 7, 9, 6.5, 7.2, 8.8];
  const audit = auditScores(answers(values));
  assert.equal(audit.total, 6);
  assert.equal(audit.outlierCount, 6);
  assert.equal(audit.ratio, 1);
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.outliers.map((o) => o.id), IDS);
  assert.deepEqual(audit.outliers.map((o) => o.value), values, 'outliers 必须带原始值，不是夹过的 5');
  assert.equal(shouldRejectScores(audit), true);
});

test('0–100 量纲与负数域：同样判为整轮越界', () => {
  const hundred = auditScores(answers([82, 76, 90, 68, 74, 88]));
  assert.equal(hundred.outlierCount, 6);
  assert.equal(hundred.ratio, 1);
  assert.equal(shouldRejectScores(hundred), true);

  const negative = auditScores(answers([-3, -1, -2.5, -4, -0.5, -8]));
  assert.equal(negative.outlierCount, 6);
  assert.deepEqual(negative.outliers.map((o) => o.value), [-3, -1, -2.5, -4, -0.5, -8]);
  assert.equal(shouldRejectScores(negative), true);
});

test('阈值 0.2：1/6 不拒绝、2/6 拒绝；恰好等于阈值不算"超过"', () => {
  const one = auditScores(answers([3, 4, 8, 2, 5, 1]));
  assert.ok(Math.abs(one.ratio - 1 / 6) < 1e-12, `ratio 应为 1/6，实际 ${one.ratio}`);
  assert.equal(one.ok, false, 'ok 是"有无越界"的严格口径：有越界就是 false');
  assert.equal(shouldRejectScores(one), false, '单点越界（1/6 ≈ 0.167）不足以判定整轮解析异常');

  const two = auditScores(answers([3, 4, 8, 2, 5, 9]));
  assert.equal(shouldRejectScores(two), true, '2/6 ≈ 0.333 超过阈值，应报 parse 重试');

  const exactly = auditScores([3, 4, 8, 2, 5]); // 1/5 === 0.2
  assert.equal(exactly.ratio, 0.2);
  assert.equal(shouldRejectScores(exactly), false, '恰好等于阈值不是"超过"');
  assert.equal(shouldRejectScores(exactly, { ratioThreshold: 0.19 }), true);
});

test('shouldRejectScores：阈值可调、非法阈值回退默认、非法 audit 不抛错且不误判', () => {
  const audit = auditScores(answers([3, 4, 8, 2, 5, 9])); // ratio = 2/6
  assert.equal(shouldRejectScores(audit, { ratioThreshold: 0.34 }), false);
  assert.equal(shouldRejectScores(audit, { ratioThreshold: 0.33 }), true);
  assert.equal(shouldRejectScores(audit, { ratioThreshold: 0 }), true, '阈值 0：任何越界都拒绝');
  assert.equal(shouldRejectScores(auditScores([3, 4, 5, 2, 5, 1]), { ratioThreshold: 0 }), false);

  // 非法阈值（NaN / 负数 / 非数字）回退默认 0.2
  assert.equal(shouldRejectScores(audit, { ratioThreshold: NaN }), true);
  assert.equal(shouldRejectScores(audit, { ratioThreshold: -1 }), true);
  assert.equal(shouldRejectScores(audit, { ratioThreshold: 'x' }), true);

  const badAudits = [null, undefined, 0, 'x', [], {}, { ratio: NaN }, { ratio: '0.9' }, { total: 0, outlierCount: 3 }];
  for (const bad of badAudits) {
    assert.equal(shouldRejectScores(bad), false, `非法 audit 不得抛错/不得误判：${JSON.stringify(bad)}`);
  }

  // 容错：直接把原始条目数组交给它也能判定（避免"传错形状 → 恒 false"的静默失效）
  assert.equal(shouldRejectScores([8, 8, 8, 8, 8, 8]), true);
  assert.equal(shouldRejectScores([5, 4, 3]), false);
});

test('边界：null / NaN / 字符串 / 空数组 / 非数组入参都不抛错', () => {
  for (const bad of [null, undefined, 42, '4.5', {}, true]) {
    assert.deepEqual(
      auditScores(bad),
      { ok: true, outliers: [], total: 0, outlierCount: 0, ratio: 0 },
      `auditScores(${JSON.stringify(bad)}) 应安全降级`,
    );
  }

  const dirty = auditScores([null, NaN, 'x', {}, [], true, undefined, { id: 'a' }, { id: 'b', score: '8' }]);
  assert.equal(dirty.total, 9);
  assert.equal(dirty.outlierCount, 0, '非数值不是"越界分"，不得计成越界');
  assert.equal(dirty.ratio, 0);
  assert.equal(dirty.ok, true);
  assert.equal(shouldRejectScores(dirty), false);
});

test('入参形状：数字 / {score} / {value} 混用，id 缺失时回退下标', () => {
  const audit = auditScores([
    3,
    { id: 'a', score: 8 },
    { id: 'b', value: -1 },
    { score: 5.5 },
    { id: 7, score: 9 },
  ]);
  assert.deepEqual(audit.outliers, [
    { id: 'a', value: 8 },
    { id: 'b', value: -1 },
    { id: '3', value: 5.5 },
    { id: '7', value: 9 },
  ]);
  assert.equal(audit.total, 5);
  assert.equal(audit.ratio, 0.8);
  assert.equal(shouldRejectScores(audit), true);
});

test('量表可自定义：{min:1,max:10} 下 8 不再是越界；非法边界回退 0–5', () => {
  const shifted = auditScores([8, 7, 9, 6, 10, 1], { min: 1, max: 10 });
  assert.deepEqual(shifted, { ok: true, outliers: [], total: 6, outlierCount: 0, ratio: 0 });

  const out = auditScores([0, 11], { min: 1, max: 10 });
  assert.deepEqual(out.outliers, [{ id: '0', value: 0 }, { id: '1', value: 11 }]);

  const fallback = auditScores([6], { min: 'x', max: null });
  assert.equal(fallback.outlierCount, 1, '非法边界必须回退默认 0–5，而不是让比较静默失效');
});

test('scoreGuard 是纯逻辑：无 UI 运行时依赖、无网络、不触碰全局对象', () => {
  assert.ok(!/from\s+['"](react|react-native|expo)/.test(SOURCE), '不得 import react/react-native/expo');
  assert.ok(!/^\s*import\s/m.test(SOURCE), 'scoreGuard.js 不应有任何 import 语句');
  assert.ok(!/\bwindow\b|\bdocument\b/.test(SOURCE), '不得触碰浏览器全局对象');
  assert.ok(!/\bfetch\s*\(/.test(SOURCE), '不得有任何网络调用');
});
