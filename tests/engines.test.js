// SPEC §3.7 / §3.8 / §3.9 / §3.11 引擎层单测：vision / scoreSystem / deepSystem / orchestrator。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, makeApi } from '../src/engine/api.js';
import { makeDeepSystem, deepReportSchema, parseDeepReport } from '../src/engine/deepSystem.js';
import { makeOrchestrator } from '../src/engine/orchestrator.js';
import { makeScoreSystem } from '../src/engine/scoreSystem.js';
import { makeVisionEngine } from '../src/engine/vision.js';
import { SCORE_QUESTION_IDS } from '../src/core/protocol.js';
import { DEEP_DIMENSION_NAMES } from '../src/core/prompts.js';
import { UNRECOGNIZABLE } from '../src/data/copy.js';
import {
  deepReportForLookIds,
  loadDeepFixture,
  loadDescription,
  makeFetchMock,
  UNRECOGNIZABLE_TEXT,
} from './helpers/fetchMock.js';

const STATE = { occasion: ['commute'], weather: ['cool'], style: ['minimal'], note: '' };
const QUESTION = { builtinId: 'slimmer', text: '哪套更显瘦？' };
const ARTIFACT = (lookId) => ({
  lookId,
  mime: 'image/jpeg',
  base64: `BASE64_${lookId}`,
  width: 390,
  height: 520,
});
const LOOKS = ['look1', 'look2', 'look3', 'look4'];
const artifacts = (ids = LOOKS) => ids.map(ARTIFACT);
const descriptionsFor = (ids = LOOKS) => Object.fromEntries(ids.map((id) => [id, loadDescription(id)]));
const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});
const apiWith = (fetchImpl, config = {}) => makeApi({
  config: { ...DEFAULT_CONFIG, ...config },
  fetchImpl,
});

/* ---------------------------------- vision --------------------------------- */

test('vision.describeLook：取 answers[0].content，trim 后返回', async () => {
  const mock = makeFetchMock();
  const vision = makeVisionEngine({ api: apiWith(mock), model: 'outfit-judge-v1' });
  const result = await vision.describeLook({ artifact: ARTIFACT('look2'), lookId: 'look2' });
  assert.equal(result.lookId, 'look2');
  assert.ok(result.text.startsWith('整体风格：温柔甜美'));
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].body.questions[0].id, 'describe_look2');
  assert.equal(mock.calls[0].body.questions[0].type, 'text');
  assert.ok(mock.calls[0].body.state.length > 0, 'state 需要非空占位');
  assert.deepEqual(
    mock.calls[0].body.images,
    [{ id: 'look2', dataUri: 'data:image/jpeg;base64,BASE64_look2' }],
    '§3.7 v1.2：describe 必须带上这一套自己的图，且只有 1 张',
  );
});

test('vision.describeLook：artifact 缺 mime/base64 时退化为不带 images', async () => {
  const mock = makeFetchMock();
  const vision = makeVisionEngine({ api: apiWith(mock), model: 'm' });
  await vision.describeLook({ artifact: { lookId: 'look1' }, lookId: 'look1' });
  assert.equal(mock.calls[0].body.images, undefined, '无图可传时不应塞空壳 images');
});

test('vision.describeLook：空 content → {kind:invalid_input}', async () => {
  const mock = makeFetchMock({ failures: { look1: { describeEmpty: true } } });
  const vision = makeVisionEngine({ api: apiWith(mock), model: 'm' });
  await assert.rejects(
    () => vision.describeLook({ artifact: ARTIFACT('look1'), lookId: 'look1' }),
    (err) => {
      assert.equal(err.kind, 'invalid_input');
      assert.equal(err.message, UNRECOGNIZABLE);
      return true;
    },
  );
});

/* ------------------------------- scoreSystem ------------------------------- */

test('scoreSystem：4 套并行，6 维分数合法、降序、shape 正确（§7 断言 2）', async () => {
  const mock = makeFetchMock();
  const system = makeScoreSystem({ api: apiWith(mock), model: 'outfit-judge-v1' });
  const result = await system.scoreLooks({
    artifacts: artifacts(),
    descriptions: descriptionsFor(),
    userState: STATE,
    question: QUESTION,
  });

  assert.equal(mock.calls.length, 4);
  for (const call of mock.calls) {
    assert.deepEqual(call.body.questions.map((item) => item.id), SCORE_QUESTION_IDS, '6 维 question id 必须逐字对齐');
    assert.ok(call.body.questions.every((item) => item.type === 'score'));
    assert.ok(/【穿搭[一二三四]】/.test(call.body.state), 'mock 靠【穿搭N】区分套数');
  }

  assert.equal(result.ids.length, 4);
  assert.deepEqual(result.ranked.map((row) => row.lookId), [...result.ranked]
    .sort((a, b) => b.overall - a.overall)
    .map((row) => row.lookId));
  assert.deepEqual(result.ranked.map((row) => row.rank), [1, 2, 3, 4]);
  assert.deepEqual(Object.keys(result.ranked[0]).sort(), [
    'confidences',
    'lookId',
    'overall',
    'rank',
    'relevance',
    'scores',
  ]);
  for (const row of result.ranked) {
    assert.deepEqual(Object.keys(row.scores), SCORE_QUESTION_IDS);
    for (const id of SCORE_QUESTION_IDS) {
      const value = row.scores[id];
      assert.equal(typeof value, 'number', `${row.lookId}.${id} 必须是数字`);
      assert.ok(value >= 0 && value <= 5, `${row.lookId}.${id} ∈ [0,5]`);
      assert.equal(Math.round(value * 10) / 10, value, `${row.lookId}.${id} 必须 1 位小数`);
      assert.equal(typeof row.confidences[id], 'number');
    }
    assert.equal(row.overall, row.scores.overall_score);
  }
  assert.deepEqual(Object.keys(result.byLook), LOOKS);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.usage, {
    prompt_tokens: 1200,
    completion_tokens: 240,
    total_tokens: 1440,
  });
  assert.deepEqual(Object.keys(result.descriptions), LOOKS);
});

test('scoreSystem：相关维度只影响 relevance，问题数恒为 6（§3.4）', async () => {
  const mock = makeFetchMock();
  const system = makeScoreSystem({ api: apiWith(mock), model: 'm' });
  const result = await system.scoreLooks({
    artifacts: artifacts(['look1']),
    descriptions: descriptionsFor(['look1']),
    userState: STATE,
    question: { builtinId: 'slimmer', text: '哪套更显瘦？' },
  });
  assert.deepEqual(result.ranked[0].relevance, ['figure_score']);
  assert.equal(mock.calls[0].body.questions.length, 6, '映射结果不得改变问题条数');
  assert.equal(result.ranked[0].overall, result.ranked[0].scores.overall_score);
});

test('scoreSystem：单套失败 → overall=null 且不阻塞其他套（§5.4）', async () => {
  const mock = makeFetchMock({ failures: { look3: { status: 500 } } });
  const system = makeScoreSystem({ api: apiWith(mock), model: 'm' });
  const result = await system.scoreLooks({
    artifacts: artifacts(),
    descriptions: descriptionsFor(),
    userState: STATE,
    question: QUESTION,
  });
  const failed = result.ranked.find((row) => row.lookId === 'look3');
  assert.equal(failed.overall, null);
  assert.equal(failed.rank, 4, '失败的套排在最后');
  assert.equal(result.ranked.filter((row) => row.overall !== null).length, 3);
  assert.deepEqual(result.failures, [{ lookId: 'look3', kind: 'server' }]);
  assert.equal(result.byLook.look3.scores.overall_score, null);
});

test('scoreSystem：描述为空的套不发起请求，其余照常出分', async () => {
  const mock = makeFetchMock();
  const system = makeScoreSystem({ api: apiWith(mock), model: 'm' });
  const result = await system.scoreLooks({
    artifacts: artifacts(),
    descriptions: { ...descriptionsFor(), look1: '' },
    userState: STATE,
    question: QUESTION,
  });
  assert.equal(mock.calls.length, 3, '空描述不值得再打一次分');
  const empty = result.ranked.find((row) => row.lookId === 'look1');
  assert.equal(empty.overall, null);
  assert.equal(empty.rank, 4);
  assert.deepEqual(result.failures, [{ lookId: 'look1', kind: 'invalid_input' }]);
});

test('scoreSystem：全部无法识别 → invalid_input；全部硬失败 → 按真实错误抛', async () => {
  const mock = makeFetchMock({ scenario: 'unrecognizable' });
  const system = makeScoreSystem({ api: apiWith(mock), model: 'm' });
  await assert.rejects(
    () => system.scoreLooks({
      artifacts: artifacts(),
      descriptions: Object.fromEntries(LOOKS.map((id) => [id, UNRECOGNIZABLE_TEXT])),
      userState: STATE,
      question: QUESTION,
    }),
    (err) => err.kind === 'invalid_input' && err.message === UNRECOGNIZABLE,
  );
  assert.equal(mock.calls.length, 0, '没有任何一套值得打分时不应发请求');

  const serverApi = makeScoreSystem({
    api: apiWith(makeFetchMock(), { model: 'test-server-error' }),
    model: 'test-server-error',
  });
  await assert.rejects(
    () => serverApi.scoreLooks({
      artifacts: artifacts(),
      descriptions: descriptionsFor(),
      userState: STATE,
      question: QUESTION,
    }),
    (err) => err.kind === 'server',
  );

  const unknownIds = makeScoreSystem({
    api: apiWith(async () => jsonResponse({ model: 'm', answers: [{ id: 'nope', type: 'score', score: 4 }] })),
    model: 'm',
  });
  await assert.rejects(
    () => unknownIds.scoreLooks({
      artifacts: artifacts(['look1']),
      descriptions: descriptionsFor(['look1']),
      userState: STATE,
      question: QUESTION,
    }),
    (err) => err.kind === 'parse',
  );
});

test('scoreSystem：并发上限 4（4 套同时在飞）', async () => {
  const mock = makeFetchMock({ delayMs: 25 });
  const system = makeScoreSystem({ api: apiWith(mock), model: 'm' });
  await system.scoreLooks({
    artifacts: artifacts(),
    descriptions: descriptionsFor(),
    userState: STATE,
    question: QUESTION,
  });
  assert.ok(mock.stats.maxConcurrent <= 4, `并发不得超过 4，实际 ${mock.stats.maxConcurrent}`);
  assert.ok(mock.stats.maxConcurrent >= 2, `应当并行，实际 ${mock.stats.maxConcurrent}`);
});

/* ------------------------------- deepSystem -------------------------------- */

test('deepSystem.analyze：一次多模态调用，图片走 images 通道', async () => {
  const mock = makeFetchMock();
  const deep = makeDeepSystem({ api: apiWith(mock), model: 'm' });
  const report = await deep.analyze({
    artifacts: artifacts(),
    userState: STATE,
    question: QUESTION,
  });
  assert.equal(mock.calls.length, 1, 'System Two 只调用一次');
  assert.equal(mock.calls[0].body.questions[0].id, 'deep_report');
  assert.equal(mock.calls[0].body.images.length, 4, 'deep 必须带上全部 4 套原图');
  assert.deepEqual(mock.calls[0].body.images.map((image) => image.id), LOOKS);
  assert.equal(mock.calls[0].body.images[0].dataUri, 'data:image/jpeg;base64,BASE64_look1');
  assert.ok(mock.calls[0].body.state.includes('通勤上班 · 凉爽 · 简约干练'));
  assert.ok(!mock.calls[0].body.state.includes('{{STATE}}'));
  assert.equal(report.ranking.length, 4);
  assert.equal(report.details.length, 4);
  assert.ok(LOOKS.includes(report.conclusion.pick));
});

test('deepSystem.analyze：2 套时条数 = 2；空 content → parse', async () => {
  const mock = makeFetchMock();
  const deep = makeDeepSystem({ api: apiWith(mock), model: 'm' });
  const report = await deep.analyze({ artifacts: artifacts(['look1', 'look2']), userState: STATE, question: QUESTION });
  assert.deepEqual(report.ranking.map((row) => row.lookId).sort(), ['look1', 'look2'], '命中 report-2looks fixture');
  assert.deepEqual(report.details.map((row) => row.lookId).sort(), ['look1', 'look2']);

  const report2 = await deep.analyze({ artifacts: artifacts(['look2', 'look4']), userState: STATE, question: QUESTION });
  assert.deepEqual(report2.ranking.map((row) => row.lookId).sort(), ['look2', 'look4'], '非连续 lookId 也要齐');
  assert.deepEqual(report2.details.map((row) => row.lookId).sort(), ['look2', 'look4']);

  const empty = makeDeepSystem({ api: apiWith(makeFetchMock({ failures: { look1: { deepEmpty: true } } })), model: 'm' });
  await assert.rejects(
    () => empty.analyze({ artifacts: artifacts(['look1']), userState: STATE, question: QUESTION }),
    (err) => err.kind === 'parse',
  );
});

test('parseDeepReport：代码块/前后缀、排序、5 维固定、越界钳制、pick 回落', () => {
  const fixture = loadDeepFixture('report-4looks');
  const parsed = parseDeepReport(JSON.stringify(fixture));
  assert.deepEqual(parsed.ranking.map((row) => row.lookId), ['look2', 'look1', 'look4', 'look3']);
  assert.deepEqual(parsed.details.map((row) => row.lookId), parsed.ranking.map((row) => row.lookId));
  for (const detail of parsed.details) {
    assert.deepEqual(detail.dimensions.map((item) => item.name), DEEP_DIMENSION_NAMES);
    assert.ok(detail.pros.length >= 2 && detail.pros.length <= 3);
    assert.ok(detail.cons.length >= 1 && detail.cons.length <= 2);
    assert.ok(detail.suggestions.length >= 1 && detail.suggestions.length <= 3);
  }
  assert.equal(parsed.conclusion.pick, 'look2');

  const fenced = parseDeepReport(`\`\`\`json\n${JSON.stringify(fixture)}\n\`\`\``);
  assert.deepEqual(fenced, parsed, 'markdown 代码块要能剥掉');
  const prefixed = parseDeepReport(`好的，这是报告：\n${JSON.stringify(fixture)}\n希望有帮助`);
  assert.deepEqual(prefixed, parsed, '前后缀文字要能容忍');

  const messy = parseDeepReport(JSON.stringify({
    ranking: [
      { lookId: 'look1', stars: '4.5', oneLineReason: ' 一句话 ' },
      { lookId: 'look9', stars: 3, oneLineReason: '不在上传范围' },
      { lookId: 'look2', stars: 8, oneLineReason: '越界' },
    ],
    details: [
      { lookId: 'look2', dimensions: DEEP_DIMENSION_NAMES.map((name) => ({ name, stars: 4.3 })), pros: ['a', 'b'], cons: ['c'], suggestions: ['d'] },
      { lookId: 'look1', dimensions: DEEP_DIMENSION_NAMES.map((name) => ({ name, stars: 4 })), pros: ['a', 'b', 'c', 'd'], cons: ['c'], suggestions: ['d', 'e', 'f', 'g'] },
    ],
    conclusion: { pick: 'look1', reason: ' r ', alternatives: ['alt1', 'alt2', 'alt3'], tip: ' t ' },
  }), { lookIds: ['look1', 'look2'] });
  assert.deepEqual(messy.ranking.map((row) => row.lookId), ['look2', 'look1'], '未知 lookId 丢弃 + 按 stars 降序');
  assert.equal(messy.ranking[0].stars, 5, '越界 stars 钳制到 5');
  assert.equal(messy.ranking[1].stars, 4.5, '数字字符串要接受');
  assert.equal(messy.details[0].dimensions[0].stars, 4.5, '4.3 步进到 0.5 → 4.5');
  assert.equal(messy.details[1].pros.length, 3, 'pros 超长截断到 3');
  assert.equal(messy.details[1].suggestions.length, 3);
  assert.equal(messy.conclusion.alternatives.length, 2);

  const badPick = parseDeepReport(JSON.stringify({
    ...fixture,
    conclusion: { ...fixture.conclusion, pick: 'look42' },
  }));
  assert.equal(badPick.conclusion.pick, 'look2', 'pick 非法时回落第一名');
});

test('parseDeepReport：结构不合规一律 {kind:parse}', () => {
  const fixture = loadDeepFixture('report-2looks');
  const broken = [
    'not-json',
    '',
    JSON.stringify({ details: [], conclusion: {} }),
    JSON.stringify({ ...fixture, details: [] }),
    JSON.stringify({ ...fixture, conclusion: undefined }),
    JSON.stringify({ ...fixture, details: [{ ...fixture.details[0], dimensions: [] }] }),
    JSON.stringify({ ...fixture, details: [{ ...fixture.details[0], pros: ['只有一个'] }] }),
    JSON.stringify({ ...fixture, details: [{ ...fixture.details[0], cons: [] }] }),
    JSON.stringify({ ...fixture, details: [{ ...fixture.details[0], suggestions: [] }] }),
    JSON.stringify({ ...fixture, ranking: [{ lookId: 'look9', stars: 4, oneLineReason: '不在范围' }] }),
    JSON.stringify({ ...fixture, conclusion: { ...fixture.conclusion, alternatives: [] } }),
    JSON.stringify({ ...fixture, conclusion: { ...fixture.conclusion, tip: '' } }),
  ];
  for (const raw of broken) {
    assert.throws(
      () => parseDeepReport(raw),
      (err) => err.kind === 'parse',
      `应判 parse：${String(raw).slice(0, 40)}`,
    );
  }
});

test('deepReportSchema：字面量 schema 结构 + fixtures 逐条通过校验', () => {
  const schema = deepReportSchema();
  assert.deepEqual(schema.required, ['ranking', 'details', 'conclusion']);
  assert.deepEqual(Object.keys(schema.properties), ['ranking', 'details', 'conclusion']);
  assert.deepEqual(schema.properties.conclusion.required, ['pick', 'reason', 'alternatives', 'tip']);
  assert.deepEqual(
    schema.properties.details.items.properties.dimensions.items.properties.name.enum,
    DEEP_DIMENSION_NAMES,
  );
  assert.notEqual(deepReportSchema(), schema, '每次返回独立副本');
  for (const name of ['report-2looks', 'report-4looks']) {
    assertSchema(loadDeepFixture(name), schema, name);
  }
  assertSchema(deepReportForLookIds(['look1', 'look2', 'look3']), schema, 'trimmed');
  assertSchema(parseDeepReport(JSON.stringify(loadDeepFixture('report-4looks'))), schema, 'parsed');
});

/* ------------------------------ orchestrator ------------------------------- */

test('orchestrator.runQuick：describe → score 的进度与结果', async () => {
  const mock = makeFetchMock();
  const events = [];
  const orchestrator = makeOrchestrator({ api: apiWith(mock), model: 'm' });
  const quick = await orchestrator.runQuick({
    artifacts: artifacts(),
    userState: STATE,
    question: QUESTION,
    onProgress: (event) => events.push(event),
  });

  const describing = events.filter((event) => event.stage === 'describing');
  assert.equal(describing.length, 4);
  assert.deepEqual(describing.map((event) => event.done), [1, 2, 3, 4]);
  assert.ok(describing.every((event) => event.total === 4));
  assert.ok(describing.every((event) => typeof event.text === 'string' && event.text.length > 0), 'App 需要拿到描述文本');

  const scoring = events.filter((event) => event.stage === 'scoring');
  assert.equal(scoring.length, 5, 'scoring 起点 + 4 次完成');
  assert.deepEqual(scoring[0], { stage: 'scoring', done: 0, total: 4 });
  assert.deepEqual(scoring.at(-1), { stage: 'scoring', done: 4, total: 4 });

  assert.equal(quick.ranked.length, 4);
  assert.equal(quick.weakNetwork, false);
  assert.deepEqual(Object.keys(quick.descriptions), LOOKS);
  assert.equal(mock.calls.length, 8, '4 次 describe + 4 次 score');
  const describeCalls = mock.calls.filter((call) => String(call.body.questions[0].id).startsWith('describe_'));
  const scoreCalls = mock.calls.filter((call) => call.body.questions[0].id === 'overall_score');
  assert.equal(describeCalls.length, 4);
  assert.equal(scoreCalls.length, 4);
  assert.ok(
    describeCalls.every((call) => call.body.images.length === 1),
    '§3.7 v1.2：每次 describe 只带自己那 1 张图',
  );
  assert.deepEqual(describeCalls.map((call) => call.body.images[0].id).sort(), LOOKS);
  assert.ok(scoreCalls.every((call) => call.body.images === undefined), 'score 阶段不需要图');
});

test('orchestrator.runQuick：test-partial-fail → look1 的 overall 必须是 null，其余 3 套正常（§5.4）', async () => {
  const mock = makeFetchMock();
  const api = apiWith(mock, { model: 'test-partial-fail' });
  const orchestrator = makeOrchestrator({ api, model: 'test-partial-fail' });
  const quick = await orchestrator.runQuick({
    artifacts: artifacts(),
    userState: STATE,
    question: QUESTION,
  });

  const byId = Object.fromEntries(quick.ranked.map((row) => [row.lookId, row]));
  assert.equal(byId.look1.overall, null, 'describe 为空的套不得出分');
  assert.equal(byId.look1.rank, 4, '失败套排在最后');
  for (const lookId of ['look2', 'look3', 'look4']) {
    assert.equal(typeof byId[lookId].overall, 'number', `${lookId} 必须正常出分`);
    assert.ok(byId[lookId].overall >= 0 && byId[lookId].overall <= 5);
  }
  assert.deepEqual(
    quick.ranked.filter((row) => row.overall !== null).map((row) => row.overall),
    quick.ranked.filter((row) => row.overall !== null).map((row) => row.overall).sort((a, b) => b - a),
    '成功的三套必须按分数降序',
  );
  assert.deepEqual(quick.failures, [{ lookId: 'look1', kind: 'invalid_input' }]);
  assert.equal(Object.keys(quick.descriptions).length, 3, '只保留识别成功的描述');
});

test('orchestrator.runQuick：全部识别失败 → invalid_input 文案（§5.1）', async () => {
  const mock = makeFetchMock();
  const api = apiWith(mock, { model: 'test-unrecognizable' });
  const orchestrator = makeOrchestrator({ api, model: 'test-unrecognizable' });
  await assert.rejects(
    () => orchestrator.runQuick({ artifacts: artifacts(), userState: STATE, question: QUESTION }),
    (err) => {
      assert.equal(err.kind, 'invalid_input');
      assert.equal(err.message, '无法识别有效穿搭内容，请上传清晰的穿搭照片哦');
      return true;
    },
  );
  assert.equal(mock.calls.length, 4, '全部不可识别时不应继续打分');
});

test('orchestrator.runQuick：describe 全网络失败 → 抛真实错误而非 invalid_input', async () => {
  const api = makeApi({
    config: { ...DEFAULT_CONFIG },
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  const orchestrator = makeOrchestrator({ api, model: 'm' });
  await assert.rejects(
    () => orchestrator.runQuick({ artifacts: artifacts(), userState: STATE, question: QUESTION }),
    (err) => err.kind === 'network',
  );
});

test('orchestrator：首个 describe > 6s → 弱网标记（§5.2）', async () => {
  const base = makeFetchMock();
  let clock = 0;
  const slowFirst = async (url, init) => {
    clock += 7000;
    return base(url, init);
  };
  const api = apiWith(slowFirst);
  const events = [];
  const weakReasons = [];
  const orchestrator = makeOrchestrator({
    api,
    model: 'm',
    now: () => clock,
    onWeakNet: (info) => weakReasons.push(info.reason),
  });
  const quick = await orchestrator.runQuick({
    artifacts: artifacts(),
    userState: STATE,
    question: QUESTION,
    onProgress: (event) => events.push(event),
  });
  assert.equal(quick.weakNetwork, true, 'runQuick 返回值必须带上弱网标记');
  assert.deepEqual(weakReasons, ['slow_describe']);
  assert.ok(events.some((event) => event.weakNetwork === true), '后续进度事件必须带弱网标记');
  const fast = makeOrchestrator({ api: apiWith(makeFetchMock()), model: 'm' });
  const normal = await fast.runQuick({ artifacts: artifacts(['look1']), userState: STATE, question: QUESTION });
  assert.equal(normal.weakNetwork, false);
});

test('orchestrator：连续 2 次 timeout → 弱网标记', async () => {
  const weakReasons = [];
  const api = apiWith(makeFetchMock(), { model: 'test-timeout', quickTimeoutMs: 60, timeoutMs: 60 });
  const orchestrator = makeOrchestrator({
    api,
    model: 'test-timeout',
    onWeakNet: (info) => weakReasons.push(info.reason),
  });
  await assert.rejects(
    () => orchestrator.runQuick({ artifacts: artifacts(), userState: STATE, question: QUESTION }),
    (err) => err.kind === 'timeout',
  );
  assert.ok(weakReasons.includes('timeout_streak'), `实际弱网原因：${weakReasons.join(',')}`);
});

test('orchestrator.runDeep / runBoth：deep 失败不丢 quick 结果', async () => {
  const mock = makeFetchMock();
  const api = apiWith(mock);
  const orchestrator = makeOrchestrator({ api, model: 'm' });
  const deepEvents = [];
  const report = await orchestrator.runDeep({
    artifacts: artifacts(['look1', 'look2']),
    userState: STATE,
    question: QUESTION,
    onProgress: (event) => deepEvents.push(event),
  });
  assert.deepEqual(deepEvents.map((event) => `${event.stage}:${event.done}/${event.total}`), ['deep:0/2', 'deep:1/2']);
  assert.equal(report.ranking.length, 2);

  const both = await orchestrator.runBoth({ artifacts: artifacts(), userState: STATE, question: QUESTION });
  assert.equal(both.quick.ranked.length, 4);
  assert.equal(both.deep.ranking.length, 4);
  assert.equal(both.deepError, null);

  const deepOnlyFails = async (url, init) => {
    const body = JSON.parse(init.body);
    // v1.2：describe（System One）也带 images，必须用问题语义判别 deep / quick，不能用"有没有图"
    const isDeep = Array.isArray(body.questions)
      && body.questions.some((item) => item && item.id === 'deep_report');
    if (isDeep) {
      return jsonResponse({ error: { message: 'boom' } }, 500);
    }
    return mock(url, init);
  };
  const partial = makeOrchestrator({ api: apiWith(deepOnlyFails), model: 'm' });
  const result = await partial.runBoth({ artifacts: artifacts(), userState: STATE, question: QUESTION });
  assert.equal(result.quick.ranked.length, 4, '深度失败不得丢掉快速评分');
  assert.equal(result.deep, null);
  assert.equal(result.deepError.kind, 'server');
});

test('orchestrator：concurrency 参数只作用于 describe 阶段', async () => {
  const mock = makeFetchMock({ delayMs: 25 });
  let describesInFlight = 0;
  let maxDescribes = 0;
  const tracking = async (url, init) => {
    const body = JSON.parse(init.body);
    const isDescribe = Array.isArray(body.questions)
      && body.questions.some((item) => String(item.id).startsWith('describe_'));
    if (isDescribe) {
      describesInFlight += 1;
      maxDescribes = Math.max(maxDescribes, describesInFlight);
    }
    try {
      return await mock(url, init);
    } finally {
      if (isDescribe) describesInFlight -= 1;
    }
  };
  const orchestrator = makeOrchestrator({ api: apiWith(tracking), model: 'm', concurrency: 2 });
  await orchestrator.runQuick({ artifacts: artifacts(), userState: STATE, question: QUESTION });
  assert.equal(maxDescribes, 2, `describe 并发应被限制为 2，实际 ${maxDescribes}`);
});

/* --------------------------------- helpers -------------------------------- */

function assertSchema(value, schema, path) {
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path} 不在枚举内：${value}`);
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${path} 必须是对象`);
    for (const key of schema.required || []) assert.ok(key in value, `${path}.${key} 缺失`);
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) assertSchema(value[key], sub, `${path}.${key}`);
    }
    return;
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path} 必须是数组`);
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${path} 长度不足`);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${path} 长度超限`);
    value.forEach((item, index) => assertSchema(item, schema.items, `${path}[${index}]`));
    return;
  }
  if (schema.type === 'number') {
    assert.equal(typeof value, 'number', `${path} 必须是数字`);
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${path} 小于下限`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${path} 大于上限`);
    if (schema.multipleOf !== undefined) {
      const ratio = value / schema.multipleOf;
      assert.ok(Math.abs(ratio - Math.round(ratio)) < 1e-9, `${path} 不是 ${schema.multipleOf} 的整数倍`);
    }
    return;
  }
  if (schema.type === 'string') {
    assert.equal(typeof value, 'string', `${path} 必须是字符串`);
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${path} 太短`);
  }
}
