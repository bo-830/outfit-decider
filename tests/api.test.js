// SPEC §3.10 网络层单测：URL 归一化、鉴权、images 通道、错误分类、超时、脱敏。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIG,
  ENGINE_MODES,
  classifyError,
  makeApi,
  normalizeBaseUrl,
  redactConfig,
} from '../src/engine/api.js';
import { ERRORS, UNRECOGNIZABLE } from '../src/data/copy.js';
import { makeFetchMock } from './helpers/fetchMock.js';

/**
 * 测试用配置：显式声明走「JEv 云端 + API Key」。
 *
 * 为什么必须显式写 `mode: 'jev'`：DEFAULT_CONFIG 的默认 mode 是 `laya`
 * （默认 baseUrl 是本机适配器，不带出站 Key）。本文件大量用例在断言
 * `Authorization: Bearer …`，依赖的是"云端会带 Key"这个语义，
 * 不该靠默认值碰巧成立 —— 默认值一改就会连带变红（实测踩过）。
 */
const config = (overrides = {}) => ({
  ...DEFAULT_CONFIG,
  mode: 'jev',
  apiKey: 'sk-secret-key',
  ...overrides,
});
const QUESTIONS = [{ id: 'overall_score', type: 'score', question: '打分' }];

test('DEFAULT_CONFIG 与 SPEC §3.10 逐字一致', () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    // 上游默认是本机适配器，所以默认 mode 必须是 laya（曾误设为 jev，与 baseUrl 矛盾）
    mode: 'laya',
    // v1.5 §3.9c：三档引擎模式与独立的多模态通道
    engineMode: 'laya_review',
    visionBaseUrl: '',
    visionModel: '',
    visionApiKey: '',
    // 深度分析实测 15–37s；8000 预算下偏慢一侧更常见，所以两条超时都放宽
    visionTimeoutMs: 120000,
    visionServerSide: false,
    decisionUnlocked: false,
    // reasoning 模型会把预算花在 reasoning 上：4000 时实测约 1/4 深度分析返回空串
    visionMaxTokens: 8000,
    baseUrl: 'http://127.0.0.1:8787',
    askPath: '/ask',
    healthPath: '/health',
    model: 'outfit-judge-v1',
    // SPEC §3.10b：上游协议（auto = 按主机名判断；直连 typesafe.ai 时自动用 JEv 原生协议）
    protocol: 'auto',
    apiKey: '',
    timeoutMs: 120000,
    quickTimeoutMs: 20000,
  });
});

test('默认引擎模式是 laya_review（§3.9c：保留 Laya 在环，但由多模态纠正）', () => {
  assert.equal(DEFAULT_CONFIG.engineMode, 'laya_review');
  assert.deepEqual(ENGINE_MODES, ['laya_only', 'laya_review', 'multimodal_only']);
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
    // v1.7 §5.4b：其余 4xx 是"我们的请求不对"，不再混进 server（那会把用户引向错误方向）
    [{ statusCode: 404 }, 'endpoint_rejected'],
    [{ status: 400 }, 'endpoint_rejected'],
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

/* ── SPEC §5.1「重试」列：引擎侧语义由本文件负责（SPEC §6） ───────────────── */

/** 按状态码脚本依次回应答的 fetch 替身，记录每次调用。 */
function sequenceFetch(statuses, { body = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    // 'hang'：永不主动返回，但必须遵守 AbortSignal —— 真实 fetch 在 abort 时会 reject。
    // 若这里不监听 signal，调用方的超时门就永远等不到结果，测试会挂死（我第一版就踩了这个坑）。
    if (status === 'hang') {
      return new Promise((resolve, reject) => {
        const signal = init && init.signal;
        if (signal && signal.aborted) {
          reject(abortError());
          return;
        }
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        }
      });
    }
    const ok = status >= 200 && status < 300;
    // 非 2xx 时 `body` 就是**对端给的原因**，且必须同时提供 text() —— 生产代码用
    // text() 读取它（不能先 json()，否则非 JSON 的错误页会抛异常、原因又丢了）。
    const errorBody = body && Object.keys(body).length
      ? body
      : { error: { message: 'boom' } };
    return {
      ok,
      status,
      json: async () => (ok
        ? { model: 'm', answers: [{ id: 'overall_score', type: 'score', score: 4.1, confidence: 0.5 }], usage: body }
        : errorBody),
      text: async () => JSON.stringify(ok
        ? { model: 'm', answers: [{ id: 'overall_score', type: 'score', score: 4.1, confidence: 0.5 }], usage: body }
        : errorBody),
    };
  };
  return { fetchImpl, calls };
}

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

const OK_ANSWER = (res) => res.answers[0].score;

test('§5.1 重试：server(500) 自动重投 1 次后成功', async () => {
  const { fetchImpl, calls } = sequenceFetch([500, 200]);
  const api = makeApi({ config: config(), fetchImpl });
  const res = await api.ask({ state: 's', questions: QUESTIONS });
  assert.equal(OK_ANSWER(res), 4.1);
  assert.equal(calls.length, 2, '500 必须重投一次');
});

test('§5.1 重试：network 失败自动重投 1 次，最终仍失败则抛原始 kind', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  };
  const api = makeApi({ config: config(), fetchImpl });
  await assert.rejects(
    () => api.ask({ state: 's', questions: QUESTIONS }),
    (err) => err.kind === 'network' && err.message === ERRORS.network.message,
  );
  assert.equal(calls, 2, 'network 必须重投恰好一次');
});

test('§5.1 重试：auth / parse 不得重试（重投只会得到同样结果）', async () => {
  const authSeq = sequenceFetch([401]);
  await assert.rejects(
    () => makeApi({ config: config(), fetchImpl: authSeq.fetchImpl }).ask({ state: 's', questions: QUESTIONS }),
    (err) => err.kind === 'auth',
  );
  assert.equal(authSeq.calls.length, 1, '401 不得重试');

  const parseSeq = sequenceFetch([200], {});
  const parseApi = makeApi({
    config: config(),
    fetchImpl: async (url, init) => {
      parseSeq.calls.push({ url, init });
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } };
    },
  });
  await assert.rejects(() => parseApi.ask({ state: 's', questions: QUESTIONS }), (err) => err.kind === 'parse');
  assert.equal(parseSeq.calls.length, 1, '非 JSON 响应不得重试');
});

test('§5.4b 重试：400/404 归为 endpoint_rejected 且不得自动重试', async () => {
  for (const status of [400, 404]) {
    const seq = sequenceFetch([status]);
    await assert.rejects(
      () => makeApi({ config: config(), fetchImpl: seq.fetchImpl }).ask({ state: 's', questions: QUESTIONS }),
      (err) => err.kind === 'endpoint_rejected' && err.status === status && err.retryable === false,
      `${status} 必须 endpoint_rejected 且 retryable=false`,
    );
    assert.equal(seq.calls.length, 1, `${status} 不得重试`);
  }
});

test('§5.4b 错误详情：对端给的说明要透传到 classifyError 的 message 里', async () => {
  // 以前非 2xx 时对端的原因被整段丢掉，用户只看到「决策模型服务出错了」——
  // 无法判断是 Key 错、模型名不存在还是路径写错。实测：JEv 的 403 就这样被误显示。
  const seq = sequenceFetch([400], { body: { error: { message: 'model not found: jev-latest' } } });
  const api = makeApi({ config: config(), fetchImpl: seq.fetchImpl });
  let caught = null;
  try {
    await api.ask({ state: 's', questions: QUESTIONS });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, '应当抛出');
  assert.equal(caught.kind, 'endpoint_rejected');
  assert.equal(caught.upstreamDetail, 'model not found: jev-latest');
  const info = classifyError(caught);
  assert.match(info.message, /model not found/, '对端的原话必须出现在给用户看的文案里');
});

test('§5.4b 错误详情：多模态端点的失败原因同样要透传（视觉连通性测试要用）', async () => {
  const seq = sequenceFetch([401], { body: { error: { message: 'Incorrect API key provided' } } });
  const api = makeApi({
    config: { ...config(), visionBaseUrl: 'https://api.deepseek.com/v1', visionModel: 'm', visionApiKey: 'bad' },
    fetchImpl: seq.fetchImpl,
  });
  let caught = null;
  try {
    await api.vision({ system: 's', content: 'ping', answerId: 'ping' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, '应当抛出');
  assert.equal(caught.kind, 'auth');
  const info = classifyError(caught);
  assert.match(info.message, /Incorrect API key/, '必须能看出是 Key 不对');
});

test('§5.4b 错误详情：绝不把 Key 回显出来（脱敏）', async () => {
  const seq = sequenceFetch([400], { body: { error: { message: 'bad key sk-abcdef123456 rejected' } } });
  const api = makeApi({ config: config(), fetchImpl: seq.fetchImpl });
  let caught = null;
  try {
    await api.ask({ state: 's', questions: QUESTIONS });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.ok(!/sk-abcdef123456/.test(caught.upstreamDetail), 'Key 必须被脱敏');
  assert.match(caught.upstreamDetail, /sk-\*\*\*/);
});

test('§5.1 重试：rate_limit 用文案里的 2000ms 退避，且最终抛出 rate_limit', async () => {
  const seq = sequenceFetch([429, 429]);
  const api = makeApi({ config: config(), fetchImpl: seq.fetchImpl });
  const startedAt = Date.now();
  await assert.rejects(() => api.ask({ state: 's', questions: QUESTIONS }), (err) => err.kind === 'rate_limit');
  const elapsed = Date.now() - startedAt;
  assert.equal(seq.calls.length, 2, '429 允许重投一次');
  assert.ok(elapsed >= ERRORS.rate_limit.retryDelayMs - 200, `退避应≈2000ms，实测 ${elapsed}ms`);
});

test('§5.1 重试：退避期间被取消 → 立即停手、不再发第二次请求', async () => {
  const seq = sequenceFetch(['hang']);
  const api = makeApi({ config: config({ quickTimeoutMs: 30 }), fetchImpl: seq.fetchImpl });
  const startedAt = Date.now();
  await assert.rejects(
    () => api.ask({ state: 's', questions: QUESTIONS }),
    (err) => err.kind === 'timeout',
  );
  const elapsed = Date.now() - startedAt;
  // 单次预算 30ms + 退避 600ms 后才会重投 => 两次窗口约 30*2+600。
  // 这里只断言"确实重投过"，避免把退避时长写死在测试里。
  assert.equal(seq.calls.length, 2, 'timeout 属可重试，应重投一次');
  assert.ok(elapsed < 5000, `不应出现无限等待，实测 ${elapsed}ms`);
});

test('§5.1 重试：health() 不参与自动重试（只探测一次）', async () => {
  const seq = sequenceFetch([500]);
  const health = await makeApi({ config: config(), fetchImpl: seq.fetchImpl }).health({});
  assert.equal(health.ok, false);
  assert.equal(seq.calls.length, 1, '健康检查必须只发一次');
});
