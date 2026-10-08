// SPEC §4.1 · 反馈回路单测：轻量反馈（用户最后穿了哪套）必须能在不破坏隐私不变量的前提下积累。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEEDBACK_VERDICTS,
  FEEDBACK_VERDICT_LABELS,
  UNKNOWN_BUCKET,
  buildFeedback,
  feedbackSummary,
  parseFeedbackList,
  serializeFeedbackList,
  stripImages,
} from '../src/core/feedback.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'src', 'core', 'feedback.js'), 'utf8');

const RECORD_KEYS = ['lookId', 'verdict', 'scoreSnapshot', 'engineMode', 'systemMode', 'at'];

test('常量：三种 verdict（穿了/没穿/没参考）与文案一一对应', () => {
  assert.deepEqual(FEEDBACK_VERDICTS, ['wore', 'not_wore', 'skipped']);
  assert.deepEqual(Object.keys(FEEDBACK_VERDICT_LABELS), FEEDBACK_VERDICTS);
  for (const verdict of FEEDBACK_VERDICTS) {
    assert.equal(typeof FEEDBACK_VERDICT_LABELS[verdict], 'string');
    assert.ok(FEEDBACK_VERDICT_LABELS[verdict].length > 0);
  }
  assert.equal(UNKNOWN_BUCKET, 'unknown');
});

test('buildFeedback：白名单字段、键顺序固定、scoreSnapshot 只留有限数字', () => {
  const record = buildFeedback({
    lookId: 'look3',
    verdict: 'wore',
    scoreSnapshot: {
      overall_score: 4.5,
      aesthetic_score: 3,
      junk: 'high', // 字符串 → 丢
      nested: { a: 1 }, // 嵌套对象 → 丢
      arr: [1], // 数组 → 丢
      nan: NaN, // 非有限数 → 丢
      inf: Infinity, // 非有限数 → 丢
    },
    engineMode: 'laya_review',
    systemMode: 'both',
    at: 1700000000000,
  });
  assert.deepEqual(Object.keys(record), RECORD_KEYS);
  assert.deepEqual(record, {
    lookId: 'look3',
    verdict: 'wore',
    scoreSnapshot: { overall_score: 4.5, aesthetic_score: 3 },
    engineMode: 'laya_review',
    systemMode: 'both',
    at: 1700000000000,
  });
});

test('buildFeedback：非法 verdict 返回 null；大小写与空白归一化', () => {
  const bad = [null, undefined, '', '   ', 'maybe', 'wore!', 0, 1, true, {}, [], ['wore']];
  for (const verdict of bad) {
    assert.equal(
      buildFeedback({ lookId: 'look1', verdict }),
      null,
      `verdict=${JSON.stringify(verdict)} 必须返回 null`,
    );
  }
  assert.equal(buildFeedback(), null, '无参也必须返回 null，不得抛错');
  assert.equal(buildFeedback({ verdict: 'WORE' }).verdict, 'wore');
  assert.equal(buildFeedback({ verdict: '  Wore  ' }).verdict, 'wore');
  assert.equal(buildFeedback({ verdict: 'SKIPPED' }).verdict, 'skipped');
  assert.equal(buildFeedback({ verdict: 'not_wore' }).verdict, 'not_wore');
});

test('buildFeedback：缺省字段稳定成型；at 缺省取当前时间、非法 at 也回退当前时间', () => {
  const before = Date.now();
  const record = buildFeedback({ verdict: 'skipped' });
  const after = Date.now();
  assert.deepEqual(Object.keys(record), RECORD_KEYS);
  assert.equal(record.lookId, '');
  assert.deepEqual(record.scoreSnapshot, {});
  assert.equal(record.engineMode, null);
  assert.equal(record.systemMode, null);
  assert.ok(record.at >= before && record.at <= after, `at 应为当前时间，实际 ${record.at}`);

  assert.equal(buildFeedback({ verdict: 'wore', at: 123 }).at, 123);
  for (const badAt of [NaN, Infinity, -Infinity, '123', null, {}]) {
    const at = buildFeedback({ verdict: 'wore', at: badAt }).at;
    assert.ok(Number.isFinite(at), `非法 at=${JSON.stringify(badAt)} 应回退时间戳，实际 ${at}`);
  }
  // scoreSnapshot 非对象 / 数组 → 空对象（形状稳定，不给上层 null 判空）
  assert.deepEqual(buildFeedback({ verdict: 'wore', scoreSnapshot: null }).scoreSnapshot, {});
  assert.deepEqual(buildFeedback({ verdict: 'wore', scoreSnapshot: 'x' }).scoreSnapshot, {});
  assert.deepEqual(buildFeedback({ verdict: 'wore', scoreSnapshot: [1, 2] }).scoreSnapshot, {});
  // 档位非字符串 → null（不校验取值，只保证类型）
  assert.equal(buildFeedback({ verdict: 'wore', engineMode: 7, systemMode: {} }).engineMode, null);
  assert.equal(buildFeedback({ verdict: 'wore', engineMode: ' laya_only ' }).engineMode, 'laya_only');
});

test('serialize / parse 往返等价，脏条目被跳过', () => {
  const list = [
    buildFeedback({
      lookId: 'look1',
      verdict: 'wore',
      scoreSnapshot: { overall_score: 4.5, practical_score: 2 },
      engineMode: 'laya_review',
      systemMode: 'both',
      at: 1,
    }),
    buildFeedback({ lookId: 'look2', verdict: 'not_wore', engineMode: 'multimodal_only', systemMode: 'quick', at: 2 }),
    buildFeedback({ verdict: 'skipped', at: 3 }),
  ];
  const raw = serializeFeedbackList(list);
  assert.equal(typeof raw, 'string');
  assert.deepEqual(parseFeedbackList(raw), list, 'parse(serialize(list)) 必须与 list 等价');
  assert.deepEqual(parseFeedbackList(raw), parseFeedbackList(parseFeedbackList(raw)), 'parse 幂等');
  assert.deepEqual(parseFeedbackList(JSON.parse(raw)), list, '已经是数组时也能规整');

  const withDirty = serializeFeedbackList([{ verdict: 'wore', at: 1 }, { verdict: 'nope' }, 'x', null, 42]);
  assert.equal(JSON.parse(withDirty).length, 1);
  assert.equal(parseFeedbackList(withDirty)[0].verdict, 'wore');
  assert.equal(parseFeedbackList(withDirty)[0].at, 1);
});

test('parseFeedbackList：非法 JSON / 非数组 / 脏条目安全降级，不抛错', () => {
  const cases = [
    ['{ not json', []],
    ['', []],
    ['   ', []],
    ['null', []],
    ['"wore"', []],
    ['42', []],
    ['true', []],
    ['{}', []],
    ['[]', []],
    ['[1,2,3]', []],
    ['["wore"]', []],
    ['[null]', []],
    ['[{"verdict":"maybe"}]', []],
    ['[{"verdict":"wore","at":1}]', [{ lookId: '', verdict: 'wore', scoreSnapshot: {}, engineMode: null, systemMode: null, at: 1 }]],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(parseFeedbackList(input), expected, `parseFeedbackList(${JSON.stringify(input)})`);
  }

  for (const bad of [null, undefined, 42, true, {}, () => {}]) {
    assert.deepEqual(parseFeedbackList(bad), [], `非字符串/非数组入参应安全降级：${String(bad)}`);
  }

  // 混合脏数据：只保留合法条目，顺序与合法字段不变
  const mixed = parseFeedbackList([
    { lookId: 'look1', verdict: 'wore', at: 10 },
    { verdict: 'bogus' },
    null,
    'x',
    { lookId: 'look2', verdict: 'skipped', at: 20 },
  ]);
  assert.deepEqual(mixed.map((entry) => entry.lookId), ['look1', 'look2']);
  assert.deepEqual(mixed.map((entry) => entry.at), [10, 20], 'parse 必须保留原有时间戳，不得重造');
});

test('serializeFeedbackList：非法输入也产出可解析字符串（恒字符串，绝不抛错）', () => {
  assert.equal(serializeFeedbackList(null), '[]');
  assert.equal(serializeFeedbackList(undefined), '[]');
  assert.equal(serializeFeedbackList('{ bad json'), '[]');
  assert.equal(serializeFeedbackList(42), '[]');
  assert.equal(serializeFeedbackList([]), '[]');
  assert.equal(serializeFeedbackList([{ verdict: 'bogus' }]), '[]');
  assert.deepEqual(JSON.parse(serializeFeedbackList([{ verdict: 'wore', at: 1 }])).length, 1);
});

test('feedbackSummary：按 verdict / engineMode / systemMode 计数，未知档位归 unknown', () => {
  const summary = feedbackSummary([
    { lookId: 'look1', verdict: 'wore', engineMode: 'laya_review', systemMode: 'both', at: 1 },
    { lookId: 'look2', verdict: 'wore', engineMode: 'laya_review', systemMode: 'quick', at: 2 },
    { lookId: 'look3', verdict: 'not_wore', engineMode: 'multimodal_only', systemMode: 'both', at: 3 },
    { lookId: 'look4', verdict: 'skipped', at: 4 },
    { verdict: 'bogus', at: 5 }, // 脏条目：不计入
  ]);
  assert.deepEqual(summary, {
    total: 4,
    byVerdict: { wore: 2, not_wore: 1, skipped: 1 },
    byEngineMode: { laya_review: 2, multimodal_only: 1, unknown: 1 },
    bySystemMode: { both: 2, quick: 1, unknown: 1 },
  });
  // 吃 JSON 字符串（持久化形态）结果一致
  const persisted = serializeFeedbackList([
    { lookId: 'look1', verdict: 'wore', engineMode: 'laya_review', systemMode: 'both', at: 1 },
    { lookId: 'look2', verdict: 'wore', engineMode: 'laya_review', systemMode: 'quick', at: 2 },
    { lookId: 'look3', verdict: 'not_wore', engineMode: 'multimodal_only', systemMode: 'both', at: 3 },
    { lookId: 'look4', verdict: 'skipped', at: 4 },
  ]);
  assert.deepEqual(feedbackSummary(persisted), summary, '从 JSON 字符串统计与从原始数组统计必须一致');

  // 空输入结构稳定
  assert.deepEqual(feedbackSummary(null), {
    total: 0,
    byVerdict: { wore: 0, not_wore: 0, skipped: 0 },
    byEngineMode: {},
    bySystemMode: {},
  });
  assert.deepEqual(feedbackSummary('{ bad json').total, 0);
  assert.deepEqual(Object.keys(feedbackSummary([]).byVerdict), FEEDBACK_VERDICTS);
});

test('stripImages：递归剔除图片字段、不改入参、非对象输入安全', () => {
  const dirty = {
    lookId: 'look1',
    scoreSnapshot: { overall_score: 4, image_data: 'data:image/jpeg;base64,AAAA' },
    nested: { list: ['data:image/png;base64,BBBB', 'kept'] },
    blob: 'AAAA',
  };
  const clean = stripImages(dirty);
  assert.deepEqual(clean, {
    lookId: 'look1',
    scoreSnapshot: { overall_score: 4 },
    nested: { list: ['kept'] },
  });
  assert.ok(dirty.scoreSnapshot.image_data, '入参不得被就地修改');
  assert.equal(dirty.blob, 'AAAA');

  assert.equal(stripImages(null), null);
  assert.equal(stripImages(undefined), null);
  assert.equal(stripImages('data:image/png;base64,AAAA'), null);
  assert.equal(stripImages(42), null);
  assert.equal(stripImages(true), null);
  assert.deepEqual(stripImages([]), []);
  assert.deepEqual(stripImages({}), {});

  // 正常文字原样保留（只剔图片，不做别的清洗）
  const text = { lookId: 'look2', verdict: 'wore', note: '今天通勤穿这套' };
  assert.deepEqual(stripImages(text), text);
});

test('隐私不变量：任何含 dataUri / base64 / image 的输入，输出里都不出现这些内容', () => {
  const PAYLOAD = 'data:image/jpeg;base64,QUJDREVG';
  const LONG_BASE64 = 'A'.repeat(300);
  const dirty = {
    lookId: 'look1',
    verdict: 'wore',
    at: 1,
    image: PAYLOAD,
    base64: 'QUJDREVG',
    dataUri: PAYLOAD,
    longBase64: LONG_BASE64,
    scoreSnapshot: { overall_score: 4, dataUri: PAYLOAD },
    nested: { images: [PAYLOAD], image_base64: PAYLOAD, keep: 'kept' },
  };

  const outputs = {
    stripImages: stripImages(dirty),
    buildFeedback: buildFeedback(dirty),
    parseFeedbackList: parseFeedbackList([dirty]),
    serializeFeedbackList: serializeFeedbackList([dirty]),
    feedbackSummary: feedbackSummary([dirty]),
  };

  for (const [label, output] of Object.entries(outputs)) {
    const serialized = typeof output === 'string' ? output : JSON.stringify(output);
    assert.ok(!/data:/i.test(serialized), `${label}: 不得出现 data URI`);
    assert.ok(!/base64/i.test(serialized), `${label}: 不得出现 base64`);
    assert.ok(!serialized.includes('QUJDREVG'), `${label}: 不得回显原始 base64 内容`);
    assert.ok(!serialized.includes('A'.repeat(64)), `${label}: 不得回显长 base64 内容`);
    for (const needle of ['"dataUri"', '"base64"', '"image"', '"images"', '"image_base64"']) {
      assert.ok(!serialized.includes(needle), `${label}: 不得出现字段 ${needle}`);
    }
  }

  // buildFeedback：只认识白名单入参，图片字段根本进不来；scoreSnapshot 里的 dataUri 被丢弃
  assert.deepEqual(Object.keys(outputs.buildFeedback), RECORD_KEYS);
  assert.deepEqual(outputs.buildFeedback.scoreSnapshot, { overall_score: 4 });
  assert.equal(outputs.feedbackSummary.total, 1);
});

test('feedback 模块零网络能力：无 import 语句、无网络调用（隐私不变量）', () => {
  assert.ok(!/^\s*import\s/m.test(SOURCE), 'feedback.js 不得有任何 import 语句');
  assert.ok(!/from\s+['"](react|react-native|expo)/.test(SOURCE), '不得 import react/react-native/expo');
  assert.ok(!/\brequire\s*\(/.test(SOURCE), '不得 require 任何模块');
  assert.ok(!/\bfetch\b|XMLHttpRequest|sendBeacon/.test(SOURCE), '不得有任何上送能力');
  assert.ok(!/\bwindow\b|\bdocument\b/.test(SOURCE), '不得触碰浏览器全局对象');
});
