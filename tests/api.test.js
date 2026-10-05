// SPEC §3.10 网络层单测：URL 归一化、鉴权、images 通道、错误分类、超时、脱敏。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIG,
  classifyError,
  makeApi,
  normalizeBaseUrl,
  redactConfig,
} from '../src/engine/api.js';
import { ERRORS, UNRECOGNIZABLE } from '../src/data/copy.js';
import { makeFetchMock } from './helpers/fetchMock.js';

const config = (overrides = {}) => ({ ...DEFAULT_CONFIG, apiKey: 'sk-secret-key', ...overrides });
const QUESTIONS = [{ id: 'overall_score', type: 'score', question: '打分' }];

test('DEFAULT_CONFIG 与 SPEC §3.10 逐字一致', () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    mode: 'jev',
    baseUrl: 'http://127.0.0.1:8787',
    askPath: '/ask',
    healthPath: '/health',
    model: 'outfit-judge-v1',
    apiKey: '',
    timeoutMs: 45000,
    quickTimeoutMs: 20000,
  });
});

test('normalizeBaseUrl：补 scheme、去尾斜杠、兼容局域网写法', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(normalizeBaseUrl('https://api.example.com///'), 'https://api.example.com');
  assert.equal(normalizeBaseUrl('192.168.1.5:8787'), 'http://192.168.1.5:8787');
  assert.equal(normalizeBaseUrl('192.168.1.5:8787/'), 'http://192.168.1.5:8787');
  assert.equal(normalizeBaseUrl('localhost:8787'), 'http://localhost:8787');
  assert.equal(normalizeBaseUrl('api.example.com'), 'http://api.example.com');
  assert.equal(normalizeBaseUrl('//host:1234/'), 'http://host:1234');
  assert.equal(normalizeBaseUrl('  http://a.b/c  '), 'http://a.b/c');
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(normalizeBaseUrl('http://'), '');
  assert.equal(normalizeBaseUrl(null), '');
  assert.equal(normalizeBaseUrl(undefined), '');
  assert.equal(normalizeBaseUrl(123), '');
});

test('redactConfig：apiKey 只留 ***，不改入参，其他字段原样', () => {
  const source = config();
  const redacted = redactConfig(source);
  assert.equal(redacted.apiKey, '***');
  assert.ok(!JSON.stringify(redacted).includes('sk-secret-key'));
  assert.equal(source.apiKey, 'sk-secret-key', '不得修改入参');
  assert.equal(redacted.baseUrl, source.baseUrl);
  assert.equal(redacted.model, source.model);
  assert.equal(redactConfig({ ...DEFAULT_CONFIG }).apiKey, '', '空 key 保持空串');
  assert.equal(redactConfig(null).apiKey, '');
  assert.equal(redactConfig().apiKey, '');
});

test('classifyError：§5.1 分类表逐条命中，且只返回四个字段', () => {
  const cases = [
    [{ status: 401 }, 'auth'],
    [{ status: 403 }, 'auth'],
    [{ status: 429 }, 'rate_limit'],
    [{ status: 500 }, 'server'],
    [{ status: 503 }, 'server'],
    [{ statusCode: 404 }, 'server'],
    [Object.assign(new TypeError('fetch failed'), {}), 'network'],
    [Object.assign(new Error('connect fail'), { code: 'ECONNREFUSED' }), 'network'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'cancelled'],
    [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'timeout'],
    [new SyntaxError('Unexpected token n in JSON'), 'parse'],
    [{ kind: 'invalid_input' }, 'invalid_input'],
    [new Error('boom'), 'server'],
  ];
  for (const [input, expected] of cases) {
    const info = classifyError(input);
    assert.equal(info.kind, expected, `${JSON.stringify(input.message || input.status || input.code)} → ${expected}`);
    assert.deepEqual(Object.keys(info), ['kind', 'message', 'action', 'retryable']);
    assert.equal(info.message, ERRORS[expected].message);
    assert.equal(info.action, ERRORS[expected].action);
    assert.equal(info.retryable, ERRORS[expected].retryable === true);
  }
  assert.equal(classifyError({ kind: 'invalid_input' }).message, UNRECOGNIZABLE);
  assert.equal(classifyError({ name: 'AbortError' }).message, '', 'cancelled 静默');
  assert.equal(classifyError({ status: 401 }).retryable, false);
  assert.equal(classifyError({ status: 429 }).retryable, true);
  assert.equal(classifyError(null).kind, 'server');
});

test('classifyError：绝不回显原始错误文本（API Key 不进 message）', () => {
  const leaky = Object.assign(new Error('Authorization: Bearer sk-super-secret failed'), { status: 500 });
  const info = classifyError(leaky);
  assert.ok(!info.message.includes('sk-super-secret'));
  assert.equal(info.message, ERRORS.server.message);
  const leakyNetwork = Object.assign(new TypeError('Bearer sk-super-secret'), {});
  assert.ok(!classifyError(leakyNetwork).message.includes('sk-super-secret'));
});

test('ask：happy path —— URL/方法/鉴权头/字段顺序/返回值', async () => {
  const mock = makeFetchMock();
  const api = makeApi({ config: config(), fetchImpl: mock });
  const result = await api.ask({ state: '【穿搭一】\n整体风格：简约', questions: QUESTIONS });

  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:8787/ask');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.equal(call.headers.Authorization, 'Bearer sk-secret-key');
  assert.deepEqual(Object.keys(call.body), ['model', 'state', 'questions'], 'strict 字段顺序');
  assert.equal(call.body.model, 'outfit-judge-v1');
  assert.deepEqual(call.body.images, undefined, 'System One 请求不带 images');
  assert.equal(result.model, 'outfit-judge-v1');
  assert.equal(result.answers.length, 1);
  assert.equal(result.answers[0].id, 'overall_score');
  assert.deepEqual(result.usage, { prompt_tokens: 300, completion_tokens: 60, total_tokens: 360 });
});

test('ask：Laya 模式不带 Authorization；baseUrl/askPath 生效', async () => {
  const mock = makeFetchMock();
  const api = makeApi({
    config: config({ mode: 'laya', baseUrl: '192.168.1.5:8787/', askPath: 'ask' }),
    fetchImpl: mock,
  });
  await api.ask({ state: 's', questions: QUESTIONS });
  assert.equal(mock.calls[0].url, 'http://192.168.1.5:8787/ask', 'askPath 无前导 / 也要拼对');
  assert.equal(mock.calls[0].headers.Authorization, undefined);
  await api.ask({ state: 's', questions: QUESTIONS, model: 'other-model' });
  assert.equal(mock.calls[1].body.model, 'other-model', '单次请求可覆盖 model');
});

test('ask：images 通道（System Two）与 dataUri 归一化', async () => {
  const mock = makeFetchMock({ failures: {} });
  const api = makeApi({ config: config(), fetchImpl: mock });
  await api.ask({
    state: 's',
    questions: [{ id: 'deep_report', type: 'text', question: '报告' }],
    images: [
      { id: 'look1', dataUri: 'data:image/jpeg;base64,AAA' },
      { lookId: 'look2', base64: 'BBB', mime: 'image/png' },
      { id: 'look3', dataUri: '' },
    ],
  });
  assert.deepEqual(mock.calls[0].body.images, [
    { id: 'look1', dataUri: 'data:image/jpeg;base64,AAA' },
    { id: 'look2', dataUri: 'data:image/png;base64,BBB' },
  ], '无 dataUri 的项被丢弃');
  await api.ask({ state: 's', questions: QUESTIONS, images: [] });
  assert.equal(mock.calls[1].body.images, undefined, '空数组不进请求体');
});

test('ask：错误分类落到 kind（401/500/非 JSON/缺字段/网络拒绝）', async () => {
  const cases = [
    ['test-auth-fail', 'auth'],
    ['test-server-error', 'server'],
    ['test-parse-fail', 'parse'],
    ['test-empty-answers', 'parse'],
    ['test-network-fail', 'network'],
  ];
  for (const [model, expected] of cases) {
    const mock = model === 'test-network-fail' || model === 'test-empty-answers'
      ? makeFetchMock()
      : makeFetchMock();
    const fetchImpl = model === 'test-network-fail'
      ? async () => { throw new TypeError('fetch failed'); }
      : (model === 'test-empty-answers'
        ? async () => new Response(JSON.stringify({ model, usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : mock);
    const api = makeApi({ config: config({ model }), fetchImpl });
    await assert.rejects(
      () => api.ask({ state: 's', questions: QUESTIONS }),
      (err) => {
        assert.equal(err.kind, expected, `${model} → ${expected}`);
        assert.equal(err.message, ERRORS[expected].message);
        assert.ok(!err.message.includes('sk-secret-key'));
        return true;
      },
    );
  }
});

test('ask：超时 → kind=timeout，且 System One 走 quickTimeoutMs、System Two 走 timeoutMs', async () => {
  const quickMock = makeFetchMock();
  const quickApi = makeApi({
    config: config({ model: 'test-timeout', timeoutMs: 10000, quickTimeoutMs: 60 }),
    fetchImpl: quickMock,
  });
  const startedAt = Date.now();
  await assert.rejects(
    () => quickApi.ask({ state: 's', questions: QUESTIONS }),
    (err) => err.kind === 'timeout',
  );
  assert.ok(Date.now() - startedAt < 5000, '不能等满 timeoutMs');

  const deepMock = makeFetchMock();
  const deepApi = makeApi({
    config: config({ model: 'test-timeout', timeoutMs: 60, quickTimeoutMs: 10000 }),
    fetchImpl: deepMock,
  });
  await assert.rejects(
    () => deepApi.ask({
      state: 's',
      questions: [{ id: 'deep_report', type: 'text', question: 'x' }],
      images: [{ id: 'look1', dataUri: 'data:image/jpeg;base64,AAA' }],
    }),
    (err) => err.kind === 'timeout',
    'deep_report 请求必须用 timeoutMs',
  );

  // v1.2 §3.7 修正后 describe 也带图：判别必须靠问题语义，不能靠"有没有 images"，
  // 否则 System One 会误用 45s 预算，§7 断言 9 的 timeout/弱网路径将永远不触发。
  const describeApi = makeApi({
    config: config({ model: 'test-timeout', timeoutMs: 10000, quickTimeoutMs: 60 }),
    fetchImpl: makeFetchMock(),
  });
  await assert.rejects(
    () => describeApi.ask({
      state: 's',
      questions: [{ id: 'describe_look1', type: 'text', question: 'x' }],
      images: [{ id: 'look1', dataUri: 'data:image/jpeg;base64,AAA' }],
    }),
    (err) => err.kind === 'timeout',
    'describe 带图仍属 System One，必须用 quickTimeoutMs',
  );

  const explicit = makeApi({ config: config({ model: 'test-timeout', timeoutMs: 10000, quickTimeoutMs: 10000 }), fetchImpl: makeFetchMock() });
  await assert.rejects(
    () => explicit.ask({ state: 's', questions: QUESTIONS, timeoutMs: 60 }),
    (err) => err.kind === 'timeout',
    '显式 timeoutMs 优先',
  );
});

test('ask：外部取消 → kind=cancelled（静默），与 timeout 区分', async () => {
  const mock = makeFetchMock();
  const api = makeApi({ config: config({ model: 'test-timeout', timeoutMs: 5000 }), fetchImpl: mock });
  const controller = new AbortController();
  const pending = api.ask({ state: 's', questions: QUESTIONS, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => pending, (err) => {
    assert.equal(err.kind, 'cancelled');
    assert.equal(err.message, '');
    return true;
  });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    () => api.ask({ state: 's', questions: QUESTIONS, signal: alreadyAborted.signal }),
    (err) => err.kind === 'cancelled',
  );
});

test('health：2xx 可达、失败不抛错、detail 不带密钥', async () => {
  const okMock = makeFetchMock();
  const okApi = makeApi({ config: config(), fetchImpl: okMock });
  const ok = await okApi.health({ timeoutMs: 500 });
  assert.equal(ok.ok, true);
  assert.equal(typeof ok.ms, 'number');
  assert.equal(ok.detail, 'HTTP 200');
  assert.equal(okMock.calls[0].method, 'GET');
  assert.equal(okMock.calls[0].url, 'http://127.0.0.1:8787/health');

  const downApi = makeApi({ config: config(), fetchImpl: makeFetchMock({ healthStatus: 503 }) });
  const down = await downApi.health({ timeoutMs: 500 });
  assert.equal(down.ok, false);
  assert.equal(down.detail, 'HTTP 503');

  const netApi = makeApi({
    config: config(),
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  const net = await netApi.health({ timeoutMs: 500 });
  assert.equal(net.ok, false);
  assert.equal(net.detail, ERRORS.network.message);
  assert.ok(!net.detail.includes('sk-secret-key'));

  const hangingFetch = (url, init) => new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    if (!init || !init.signal) return;
    if (init.signal.aborted) onAbort();
    else init.signal.addEventListener('abort', onAbort, { once: true });
  });
  const slowApi = makeApi({ config: config(), fetchImpl: hangingFetch });
  const slow = await slowApi.health({ timeoutMs: 60 });
  assert.equal(slow.ok, false);
  assert.equal(slow.detail, ERRORS.timeout.message);

  const brokenApi = makeApi({ config: config({ baseUrl: '' }), fetchImpl: makeFetchMock() });
  const broken = await brokenApi.health({});
  assert.equal(broken.ok, false, '地址非法不抛错');
});

test('makeApi：缺少 fetch 实现时按 network 处理，不抛同步异常', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    const api = makeApi({ config: config(), fetchImpl: undefined });
    await assert.rejects(() => api.ask({ state: 's', questions: QUESTIONS }), (err) => err.kind === 'network');
    const health = await api.health({});
    assert.equal(health.ok, false);
  } finally {
    globalThis.fetch = original;
  }
});
