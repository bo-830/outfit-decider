// SPEC §3.10b · JEv 协议单测（App 直连 TypeSafe 时用到的纯逻辑）。
//
// 事实依据是官方文档（https://docs.typesafe.ai），不是推测：
//   questions 是 map、criteria 有序且索引从 0 起、score 可落在两档之间、模型别名 jev-latest。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JEV_ASK_PATH,
  JEV_MODEL,
  SCORE_IDS,
  SCORE_RUBRICS,
  fromJevAnswers,
  resolveJevModel,
  resolveProtocol,
  sceneOf,
  toJevQuestions,
  toJevRequest,
} from '../src/core/jev.js';
import { DEFAULT_CONFIG, makeApi } from '../src/engine/api.js';

/* ── 协议判定 ─────────────────────────────────────────────── */

test('resolveProtocol：显式配置优先，其次按主机名判断 typesafe.ai', () => {
  assert.equal(resolveProtocol('https://api.typesafe.ai/v1', 'jev'), 'jev');
  assert.equal(resolveProtocol('https://api.deepseek.com/v1', 'jev'), 'jev', '显式 jev 覆盖主机名');
  assert.equal(resolveProtocol('https://api.typesafe.ai/v1', 'generic'), 'generic', '显式 generic 也尊重');
  assert.equal(resolveProtocol('https://api.typesafe.ai/v1', 'auto'), 'jev');
  assert.equal(resolveProtocol('https://api.typesafe.ai/v1'), 'jev');
});

test('resolveProtocol：非 typesafe 一律 generic（不猜）', () => {
  assert.equal(resolveProtocol('http://127.0.0.1:8787'), 'generic');
  assert.equal(resolveProtocol('http://192.168.1.9:8787'), 'generic');
  assert.equal(resolveProtocol('https://api.deepseek.com/v1'), 'generic');
  assert.equal(resolveProtocol(''), 'generic');
  assert.equal(resolveProtocol(undefined), 'generic');
  assert.equal(resolveProtocol('not a url'), 'generic');
  // 子域要认，伪装域名不能认
  assert.equal(resolveProtocol('https://api.typesafe.ai'), 'jev');
  assert.equal(resolveProtocol('https://evil-typesafe.ai'), 'generic');
  assert.equal(resolveProtocol('https://typesafe.ai.evil.com'), 'generic');
});

test('JEv 端点常量与文档一致', () => {
  assert.equal(JEV_MODEL, 'jev-latest');
  assert.equal(JEV_ASK_PATH, '/systemone');
});

/* ── 请求形状：数组 → map（这就是"直连"必须做的翻译） ────────── */

test('toJevQuestions：App 的数组式 questions 变成 JEv 要的 map', () => {
  const map = toJevQuestions([
    { id: 'overall_score', type: 'score', question: '正式面试穿这套得体吗？' },
    { id: 'scene_score', type: 'score', question: '适合面试吗？' },
  ], { scene: '正式面试' });

  assert.equal(Array.isArray(map), false, '必须是 map，不是数组');
  assert.deepEqual(Object.keys(map).sort(), ['overall_score', 'scene_score']);
  for (const q of Object.values(map)) {
    assert.equal(q.type, 'score');
    assert.ok(Array.isArray(q.criteria));
    assert.equal(typeof q.instructions, 'string');
  }
});

test('toJevQuestions：criteria 是 6 档、索引即 0–5（JEv 直通，无需映射）', () => {
  const map = toJevQuestions([{ id: 'overall_score', type: 'score', question: '得体吗？' }]);
  assert.equal(map.overall_score.criteria.length, 6);
  assert.deepEqual(map.overall_score.criteria, SCORE_RUBRICS.overall_score);
  assert.equal(map.overall_score.criteria[0], '完全不适合这个场合');
  assert.equal(map.overall_score.criteria[5], '非常得体');
});

test('toJevQuestions：6 个维度全部覆盖，措辞与共享档位表逐字一致', () => {
  const map = toJevQuestions(SCORE_IDS.map((id) => ({ id, type: 'score', question: 'q' })));
  assert.deepEqual(Object.keys(map).sort(), [...SCORE_IDS].sort());
  for (const id of SCORE_IDS) {
    assert.deepEqual(map[id].criteria, SCORE_RUBRICS[id], `${id} 档位必须与共享表一致`);
  }
});

test('toJevQuestions：instructions 用 App 原文（不套 Laya 模板措辞）', () => {
  const map = toJevQuestions([
    { id: 'overall_score', type: 'score', question: '这套适合去约会吗？' },
  ], { scene: '约会见面' });
  assert.equal(map.overall_score.instructions, '这套适合去约会吗？');
  assert.ok(!map.overall_score.instructions.includes('我的问题：'), '不做模板拼接');
});

test('toJevQuestions：缺 question 文本时用模板兜底，不产生空 instructions', () => {
  const map = toJevQuestions([{ id: 'overall_score' }], { scene: '通勤上班' });
  assert.ok(map.overall_score.instructions.length > 0);
  assert.ok(map.overall_score.instructions.includes('通勤上班'), '场合要进问句');
  assert.equal(map.overall_score.criteria.length, 6);
});

test('toJevQuestions：非评分项也产出合法形状（JEv 无文本生成，不能给 text 型）', () => {
  const map = toJevQuestions([{ id: 'describe_look1', type: 'text', question: '描述这张图' }]);
  assert.equal(map.describe_look1.type, 'score', 'JEv 只接受 score/choice/noul');
  assert.deepEqual(map.describe_look1.criteria, ['无法回答', '部分回答', '可以回答']);
});

test('toJevQuestions：忽略脏条目，不抛错', () => {
  const map = toJevQuestions([null, undefined, {}, { id: '' }, { id: 'overall_score' }]);
  assert.deepEqual(Object.keys(map), ['overall_score']);
  assert.deepEqual(toJevQuestions(null), {});
  assert.deepEqual(toJevQuestions(undefined), {});
});

test('toJevRequest：字段顺序 state → model → questions，model 默认 jev-latest', () => {
  const req = toJevRequest({
    state: '【我的场合】正式面试',
    questions: [{ id: 'overall_score', type: 'score', question: '得体吗？' }],
  });
  assert.deepEqual(Object.keys(req), ['state', 'model', 'questions'], '字段顺序必须稳定');
  assert.equal(req.model, JEV_MODEL);
  assert.equal(req.state, '【我的场合】正式面试');
  assert.equal(Array.isArray(req.questions), false);
});

test('toJevRequest：显式 model 覆盖默认别名', () => {
  assert.equal(toJevRequest({ model: 'other-model', state: 's' }).model, 'other-model');
  assert.equal(toJevRequest({ model: '', state: 's' }).model, JEV_MODEL, '空字符串回落到默认');
});

test('sceneOf：取第一个场合，缺失时用中性说法', () => {
  assert.equal(sceneOf('【我的场合】正式面试、约会见面'), '正式面试');
  assert.equal(sceneOf('【我的场合】正式面试'), '正式面试');
  assert.equal(sceneOf('没有场合信息'), '日常出门');
  assert.equal(sceneOf(''), '日常出门');
});

/* ── 响应形状：map → App 的数组，并做钳制 ─────────────────────── */

test('fromJevAnswers：map → 数组，score 钳到 0–5 且 1 位小数', () => {
  const answers = fromJevAnswers({
    overall_score: { type: 'score', score: 4.5, confidence: 0.8 },
    scene_score: { type: 'score', score: 3.67, confidence: 0.6 },
  });
  assert.equal(answers.length, 2);
  const byId = Object.fromEntries(answers.map((a) => [a.id, a]));
  assert.equal(byId.overall_score.score, 4.5);
  assert.equal(byId.scene_score.score, 3.7, '四舍五入到 1 位小数');
  assert.equal(byId.overall_score.confidence, 0.8);
});

test('fromJevAnswers：越界分数被钳制，不放大到非法区间', () => {
  const answers = fromJevAnswers({
    a: { type: 'score', score: 9.9 },
    b: { type: 'score', score: -3 },
  });
  const byId = Object.fromEntries(answers.map((x) => [x.id, x]));
  assert.equal(byId.a.score, 5);
  assert.equal(byId.b.score, 0);
});

test('fromJevAnswers：缺 score / confidence 时给 null，不编造数值', () => {
  const answers = fromJevAnswers({ a: { type: 'score' } });
  assert.equal(answers[0].score, null);
  assert.equal(answers[0].confidence, null);
});

test('fromJevAnswers：choice 型保留 choice 文本', () => {
  const answers = fromJevAnswers({ pick: { type: 'choice', choice: 'A', confidence: 0.9 } });
  assert.equal(answers[0].type, 'choice');
  assert.equal(answers[0].content, 'A');
});

test('fromJevAnswers：输入异常一律返回空数组，不抛错', () => {
  assert.deepEqual(fromJevAnswers(null), []);
  assert.deepEqual(fromJevAnswers(undefined), []);
  assert.deepEqual(fromJevAnswers([]), [], '数组不是合法 answers 形状');
  assert.deepEqual(fromJevAnswers('x'), []);
  assert.deepEqual(fromJevAnswers({ a: null }), []);
});

/* ── 直连：api 层真的按 JEv 说话（请求形状 / 端点 / 鉴权 / 响应归一化） ────── */

/** 造一个记录请求的 fetch 替身，返回 JEv 形状（answers 是 map）。 */
function jevFetch({ status = 200, answers = { overall_score: { type: 'score', score: 4.5, confidence: 0.8 } } } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body || '{}') });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ model: 'jev-latest', answers, usage: { total_tokens: 10 } }),
      };
    },
  };
}

const SCORE_QUESTIONS = [
  { id: 'overall_score', type: 'score', question: '正式面试穿这套得体吗？' },
  { id: 'scene_score', type: 'score', question: '适合面试吗？' },
];

test('直连 JEv：命中 typesafe.ai 时自动用原生协议（questions 变 map、补 model、打对端点）', async () => {
  const mock = jevFetch();
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, baseUrl: 'https://api.typesafe.ai/v1', apiKey: 'k-test' },
    fetchImpl: mock.fetchImpl,
  });

  await api.ask({ state: '【我的场合】正式面试', questions: SCORE_QUESTIONS });

  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.equal(call.url, 'https://api.typesafe.ai/v1/systemone', '必须打文档里的 /v1/systemone');
  assert.equal(call.headers.Authorization, 'Bearer k-test', 'JEv 必须带 Bearer Key');
  assert.equal(Array.isArray(call.body.questions), false, 'questions 必须是 map');
  assert.deepEqual(Object.keys(call.body.questions).sort(), ['overall_score', 'scene_score']);
  assert.equal(call.body.questions.overall_score.criteria.length, 6, '6 档直通 0–5');
  assert.equal(call.body.model, 'jev-latest');
  assert.equal(call.body.images, undefined, 'JEv 不接受图片，不该带 images');
});

test('直连 JEv：响应里的 map answers 被归一化成数组，上层无需知道对端是谁', async () => {
  const mock = jevFetch({
    answers: {
      overall_score: { type: 'score', score: 4.51, confidence: 0.82 },
      scene_score: { type: 'score', score: 3.4, confidence: 0.6 },
    },
  });
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, baseUrl: 'https://api.typesafe.ai/v1' },
    fetchImpl: mock.fetchImpl,
  });
  const res = await api.ask({ state: 's', questions: SCORE_QUESTIONS });

  assert.ok(Array.isArray(res.answers), '必须返回数组式 answers');
  const byId = Object.fromEntries(res.answers.map((a) => [a.id, a]));
  assert.equal(byId.overall_score.score, 4.5, '0–5 且 1 位小数');
  assert.equal(byId.scene_score.score, 3.4);
  assert.equal(res.model, 'jev-latest');
});

test('显式 protocol=generic 时强行用数组协议（自建对端场景）', async () => {
  const mock = jevFetch({ answers: [] });
  const calls = [];
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, baseUrl: 'https://api.typesafe.ai/v1', protocol: 'generic' },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
      return { ok: true, status: 200, json: async () => ({ model: 'm', answers: [] }) };
    },
  });
  await api.ask({ state: 's', questions: SCORE_QUESTIONS });
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/ask', 'generic 用 App 默认 askPath');
  assert.ok(Array.isArray(calls[0].body.questions), 'generic 保持数组形状');
  void mock;
});

test('protocol=jev 时即使 baseUrl 不是 typesafe 也走 JEv 协议（显式优先）', async () => {
  const mock = jevFetch();
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, baseUrl: 'https://my-proxy.example.com/v1', protocol: 'jev', apiKey: 'k' },
    fetchImpl: mock.fetchImpl,
  });
  await api.ask({ state: 's', questions: SCORE_QUESTIONS });
  assert.equal(mock.calls[0].url, 'https://my-proxy.example.com/v1/systemone');
  assert.equal(Array.isArray(mock.calls[0].body.questions), false);
});

test('直连 JEv：401 归类为 auth 且不重试（Key 错时别让用户白等）', async () => {
  const mock = jevFetch({ status: 401, answers: {} });
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, baseUrl: 'https://api.typesafe.ai/v1', apiKey: 'bad' },
    fetchImpl: mock.fetchImpl,
  });
  await assert.rejects(
    () => api.ask({ state: 's', questions: SCORE_QUESTIONS }),
    (err) => err.kind === 'auth' && err.retryable === false,
  );
  assert.equal(mock.calls.length, 1, 'auth 不重试');
});

test('直连 JEv：health 把 401/403 视为"可达但需要 Key"，不假报服务挂了', async () => {
  for (const status of [401, 403]) {
    const api = makeApi({
      config: { ...DEFAULT_CONFIG, baseUrl: 'https://api.typesafe.ai/v1' },
      fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }),
    });
    const h = await api.health();
    assert.equal(h.ok, true, `HTTP ${status} 说明主机可达`);
    assert.equal(h.authRequired, true);
    assert.match(h.detail, /Key/);
  }
});

test('直连 JEv：空 answers 明确报 parse，而不是"成功但没有分"', async () => {
  const mock = jevFetch({ answers: {} });
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, baseUrl: 'https://api.typesafe.ai/v1' },
    fetchImpl: mock.fetchImpl,
  });
  await assert.rejects(
    () => api.ask({ state: 's', questions: SCORE_QUESTIONS }),
    (err) => err.kind === 'parse',
  );
});

/* ── 模型名：旧持久化值不能把 JEv 请求搞坏 ─────────────────────── */

test('resolveJevModel：已知的非 JEv 名字换成官方别名，用户自填的尊重', () => {
  // 老版本持久化过 model（实测存的是 'laya'），切到直连 JEv 会一直被带过去 → 400
  assert.equal(resolveJevModel('laya'), 'jev-latest');
  assert.equal(resolveJevModel('outfit-judge-v1'), 'jev-latest');
  assert.equal(resolveJevModel(''), 'jev-latest');
  assert.equal(resolveJevModel(undefined), 'jev-latest');
  assert.equal(resolveJevModel('  '), 'jev-latest');
  // 用户自己填的其它名字一律尊重，不猜
  assert.equal(resolveJevModel('my-jev-proxy-model'), 'my-jev-proxy-model');
  assert.equal(resolveJevModel('jev-latest'), 'jev-latest');
});

test('直连 JEv：持久化的旧模型名 laya 会被换成 jev-latest 发出去', async () => {
  const mock = jevFetch();
  const api = makeApi({
    // 模拟老安装：config.model 存着 'laya'
    config: { ...DEFAULT_CONFIG, baseUrl: 'https://api.typesafe.ai/v1', model: 'laya' },
    fetchImpl: mock.fetchImpl,
  });
  await api.ask({ state: 's', questions: SCORE_QUESTIONS });
  assert.equal(mock.calls[0].body.model, 'jev-latest', '不能把 laya 发给 JEv');
});

test('api.isJevDirect：直连时 true，本机适配器时 false（供 vision 层判断能否产出文字）', () => {
  const jev = makeApi({ config: { ...DEFAULT_CONFIG, baseUrl: 'https://api.typesafe.ai/v1' }, fetchImpl: jevFetch().fetchImpl });
  assert.equal(jev.isJevDirect(), true);
  const local = makeApi({ config: { ...DEFAULT_CONFIG, baseUrl: 'http://127.0.0.1:8787' }, fetchImpl: jevFetch().fetchImpl });
  assert.equal(local.isJevDirect(), false);
});
