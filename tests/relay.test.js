// 中转服务单测（task-4 验收）。
//
// 覆盖：
//   1. 缺 APP_TOKEN 拒绝启动；口令缺失/错误 → 401（且绝不碰上游）
//   2. 正确口令 → 三类请求各自路由正确（打分→决策端点 / describe+review+deep→多模态端点）
//   3. deep_report 空正文自动重投**一次且最多一次**；用户已取消时不重投；describe 空正文不重投
//   4. 非 2xx 上游的 body 原因被读出来（含非 JSON 错误页）并透传进 error.message
//   5. 日志绝不含 Key / dataUri / base64（Key 一律脱敏）
//   6. /health 不需要鉴权；CORS 放行
//
// 上游一律用 node:http 假服务 + `listen(0)` 随机空闲端口，不占用 8787/8000（别的任务在用）。
// 测试名保持 ASCII：本机 PowerShell 是 GBK，控制台打中文会乱码，注释用中文即可。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  createRelayServer,
  forwardVision,
  readConfig,
  redactSecrets,
  resolveEndpoint,
  tokenMatches,
  upstreamReason,
} from '../relay/relay-server.mjs';

/* ────────────────────────── 固定夹具（全是假 Key） ────────────────────────── */

const FAKE_APP_TOKEN = 'test-app-token-abc123';
const FAKE_DECISION_KEY = 'sk-test-decision-9f8e7d';
const FAKE_VISION_KEY = 'sk-test-vision-1a2b3c';

// 1×1 透明 PNG 的 data URI（真实 base64，用来验证"图片确实被转发"与"日志里不出现"）。
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URI = `data:image/png;base64,${PNG_BASE64}`;

const SCORE_QUESTIONS = [
  { id: 'overall_score', type: 'score', question: '这套穿搭的整体得分是多少？' },
  { id: 'aesthetic_score', type: 'score', question: '这套穿搭的美观度是多少？' },
  { id: 'scene_score', type: 'score', question: '这套穿搭和我的场合匹配吗？' },
  { id: 'figure_score', type: 'score', question: '这套穿搭对身形修饰如何？' },
  { id: 'style_score', type: 'score', question: '这套穿搭风格统一吗？' },
  { id: 'practical_score', type: 'score', question: '这套穿搭方便吗？' },
];

const STATE_TEXT = '【穿搭一】\n整体风格：休闲\n\n【我的场合】正式面试';

const DEEP_QUESTIONS = [{ id: 'deep_report', type: 'text', question: '请给出深度分析报告。' }];
const REVIEW_QUESTIONS = [{ id: 'review', type: 'text', question: '请纠正上面的分数。' }];
const DESCRIBE_QUESTIONS = [{ id: 'describe_look1', type: 'text', question: '请客观描述这张穿搭照片。' }];

/* ────────────────────────── 测试脚手架 ────────────────────────── */

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function stop(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** 写响应要防"客户端已断开"：取消测试里上游可能会往死 socket 上写。 */
function reply(res, status, payload) {
  try {
    if (res.writableEnded || res.destroyed) return;
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  } catch {
    // 客户端断开导致的写失败对测试无意义
  }
}

function replyText(res, status, text, contentType = 'text/plain') {
  try {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  } catch {
    // 同上
  }
}

/**
 * 假上游：记录每条请求（method/url/headers/body），交给 handler 决定怎么答。
 * handler 拿得到 `requests`，方便按路径数"被调用了几次"。
 */
function createUpstream(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      const record = { method: req.method, url: req.url, headers: req.headers, text, json };
      requests.push(record);
      handler(record, res, requests);
    });
  });
  return { server, requests };
}

function callsTo(requests, prefix) {
  return requests.filter((record) => record.url.startsWith(prefix)).length;
}

function defaultUpstreamHandler(record, res) {
  if (record.url.startsWith('/v1/systemone')) {
    const questions = (record.json && record.json.questions) || {};
    const answers = {};
    for (const id of Object.keys(questions)) {
      answers[id] = { type: 'score', score: 4, confidence: 0.5, answer_confidence: 0.66 };
    }
    reply(res, 200, { model: 'fake-decision', answers, usage: { input_tokens: 11, output_tokens: 22 } });
    return;
  }
  if (record.url.startsWith('/chat/completions')) {
    reply(res, 200, {
      model: 'fake-vision',
      choices: [{ message: { content: '整体风格：休闲' } }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    });
    return;
  }
  reply(res, 404, { error: { message: 'unknown path' } });
}

/** 一套「假上游 + 中转」的完整装置，注册好 t.after 清理。 */
async function makeRig(t, options = {}) {
  const upstream = options.upstream || createUpstream(defaultUpstreamHandler);
  const upstreamUrl = await listen(upstream.server);
  const logs = [];
  const config = readConfig({
    APP_TOKEN: FAKE_APP_TOKEN,
    DECISION_BASE_URL: upstreamUrl,
    DECISION_MODEL: 'fake-decision-model',
    DECISION_API_KEY: FAKE_DECISION_KEY,
    VISION_BASE_URL: upstreamUrl,
    VISION_MODEL: 'fake-vision-model',
    VISION_API_KEY: FAKE_VISION_KEY,
    ...(options.env || {}),
  });
  const relay = createRelayServer(config, { log: (line) => logs.push(line) });
  const relayUrl = await listen(relay);
  t.after(async () => {
    await stop(relay);
    await stop(upstream.server);
  });
  return { relayUrl, upstreamUrl, requests: upstream.requests, logs, config };
}

async function ask(relayUrl, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.token !== null) headers.Authorization = `Bearer ${options.token || FAKE_APP_TOKEN}`;
  const response = await fetch(`${relayUrl}/ask`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: options.signal,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return false;
}

/* ────────────────────────── ① 配置与启动门禁 ────────────────────────── */

test('readConfig refuses to start without APP_TOKEN', () => {
  assert.throws(
    () => readConfig({ DECISION_BASE_URL: 'http://127.0.0.1:1' }),
    (err) => err.code === 'APP_TOKEN_REQUIRED' && /APP_TOKEN/.test(err.message),
  );
  // 空白 token 也算缺（不能靠一个空格"启动成功"）
  assert.throws(() => readConfig({ APP_TOKEN: '   ' }), /APP_TOKEN/);
  // 直接建服务同样拒绝，避免有人绕过 readConfig
  assert.throws(() => createRelayServer({ decision: {}, vision: {} }), /APP_TOKEN/);
});

test('readConfig defaults: port 8787, VISION_MAX_TOKENS 8000, endpoint suffix handling', () => {
  const config = readConfig({
    APP_TOKEN: 't',
    DECISION_BASE_URL: 'http://d.example/',
    VISION_BASE_URL: 'http://v.example',
  });
  assert.equal(config.port, 8787);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.vision.maxTokens, 8000);
  assert.equal(config.decision.url, 'http://d.example/v1/systemone');
  assert.equal(config.vision.url, 'http://v.example/chat/completions');
  assert.equal(config.decision.configured, true);
  assert.equal(config.vision.configured, true);
  // 缺 Key 但配了地址：仍算 configured（有些自建端点不要 Key），只是日志里会警告
  assert.equal(readConfig({ APP_TOKEN: 't', DECISION_BASE_URL: 'http://d.example' }).decision.apiKeySet, false);

  assert.equal(resolveEndpoint('http://v.example/v1/chat/completions', '/chat/completions'), 'http://v.example/v1/chat/completions');
  assert.equal(resolveEndpoint('http://d.example/ask', '/v1/systemone'), 'http://d.example/ask');
  assert.equal(resolveEndpoint('http://d.example/', '/v1/systemone'), 'http://d.example/v1/systemone');
  assert.equal(resolveEndpoint('', '/v1/systemone'), '');

  assert.throws(() => readConfig({ APP_TOKEN: 't', RELAY_PORT: 'abc' }), /RELAY_PORT/);
  assert.throws(() => readConfig({ APP_TOKEN: 't', VISION_MAX_TOKENS: '0' }), /VISION_MAX_TOKENS/);
});

test('tokenMatches only accepts an exact Bearer token', () => {
  assert.equal(tokenMatches('Bearer abc', 'abc'), true);
  assert.equal(tokenMatches('bearer abc', 'abc'), true);
  assert.equal(tokenMatches('Bearer  abc ', 'abc'), true);
  assert.equal(tokenMatches('Bearer abcd', 'abc'), false);
  assert.equal(tokenMatches('abc', 'abc'), false);
  assert.equal(tokenMatches('Bearer ', 'abc'), false);
  assert.equal(tokenMatches(undefined, 'abc'), false);
  assert.equal(tokenMatches('Bearer abc', ''), false);
});

/* ────────────────────────── ② /health 与鉴权 ────────────────────────── */

test('GET /health needs no auth, reports both upstreams, and never calls upstream', async (t) => {
  const rig = await makeRig(t);
  const response = await fetch(`${rig.relayUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(json.relay, 'outfit-relay');
  assert.equal(json.upstream.decision.configured, true);
  assert.equal(json.upstream.vision.configured, true);
  assert.equal(json.upstream.vision.maxTokens, 8000);
  assert.equal(rig.requests.length, 0, 'health check must not hit the upstream');
});

test('POST /ask without a token or with a wrong token returns 401 and never calls upstream', async (t) => {
  const rig = await makeRig(t);
  const missing = await ask(rig.relayUrl, { questions: SCORE_QUESTIONS }, { token: null });
  assert.equal(missing.status, 401);
  const wrong = await ask(rig.relayUrl, { questions: SCORE_QUESTIONS }, { token: 'not-the-token' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.message, 'invalid or missing app token');
  assert.equal(wrong.headers.get('access-control-allow-origin'), '*');
  assert.equal(rig.requests.length, 0, 'rejected requests must not reach the upstream');
});

test('OPTIONS preflight is allowed without auth (web preview)', async (t) => {
  const rig = await makeRig(t);
  const response = await fetch(`${rig.relayUrl}/ask`, { method: 'OPTIONS' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-headers') || '', /Authorization/i);
});

/* ────────────────────────── ③ 打分路由 ────────────────────────── */

test('scoring questions route to the decision endpoint with a 6-criteria map', async (t) => {
  const rig = await makeRig(t);
  const response = await ask(rig.relayUrl, { model: 'app-model', state: STATE_TEXT, questions: SCORE_QUESTIONS });
  assert.equal(response.status, 200);

  assert.equal(callsTo(rig.requests, '/v1/systemone'), 1, 'scoring must hit the decision endpoint');
  assert.equal(callsTo(rig.requests, '/chat/completions'), 0, 'scoring must NOT hit the vision endpoint');
  const upstream = rig.requests[0];
  assert.equal(upstream.headers.authorization, `Bearer ${FAKE_DECISION_KEY}`, 'relay must attach its own key');
  assert.equal(upstream.json.model, 'fake-decision-model', 'DECISION_MODEL wins over the App model name');
  assert.equal(Array.isArray(upstream.json.questions), false, 'upstream expects an id-keyed map');
  assert.deepEqual(Object.keys(upstream.json.questions), SCORE_QUESTIONS.map((q) => q.id));
  for (const id of Object.keys(upstream.json.questions)) {
    assert.equal(upstream.json.questions[id].criteria.length, 6, `${id} must carry 6 criteria`);
  }
  // 场合必须进了问句（实测调优过的措辞，不能丢）
  assert.ok(upstream.json.questions.scene_score.instructions.includes('正式面试'));

  // 响应形状 = App 契约 {model, answers:[{id,type,score,confidence}], usage}
  assert.deepEqual(Object.keys(response.json).sort(), ['answers', 'model', 'usage']);
  assert.equal(response.json.answers.length, 6);
  const overall = response.json.answers.find((a) => a.id === 'overall_score');
  assert.deepEqual(overall, { id: 'overall_score', type: 'score', score: 4, confidence: 0.66 });
  assert.deepEqual(response.json.usage, { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 });
});

test('scoring response keeps the App envelope when the App model name is used', async (t) => {
  // DECISION_MODEL 未配置 → 回落成 App 传来的名字（适配器的既有口径）
  const rig = await makeRig(t, { env: { DECISION_MODEL: '' } });
  const response = await ask(rig.relayUrl, { model: 'app-supplied', state: STATE_TEXT, questions: SCORE_QUESTIONS });
  assert.equal(response.status, 200);
  assert.equal(rig.requests[0].json.model, 'app-supplied');
  assert.equal(typeof response.json.model, 'string');
});

/* ────────────────────────── ④ 多模态路由 ────────────────────────── */

test('describe_* routes to the vision endpoint with its own key, image and max_tokens', async (t) => {
  const rig = await makeRig(t);
  const response = await ask(rig.relayUrl, {
    state: '（本次只做图片客观描述，无用户上下文）',
    questions: DESCRIBE_QUESTIONS,
    images: [{ id: 'look1', dataUri: PNG_DATA_URI }],
  });
  assert.equal(response.status, 200);

  assert.equal(callsTo(rig.requests, '/chat/completions'), 1, 'describe must hit the vision endpoint');
  assert.equal(callsTo(rig.requests, '/v1/systemone'), 0, 'describe must NOT hit the decision endpoint');
  const upstream = rig.requests[0];
  assert.equal(upstream.headers.authorization, `Bearer ${FAKE_VISION_KEY}`);
  assert.equal(upstream.json.model, 'fake-vision-model');
  assert.equal(upstream.json.max_tokens, 8000, 'VISION_MAX_TOKENS defaults to 8000 (reasoning budget)');
  assert.equal(upstream.json.messages.length, 1);
  assert.equal(upstream.json.messages[0].role, 'user');
  const parts = upstream.json.messages[0].content;
  assert.equal(parts[0].type, 'text');
  assert.ok(parts[0].text.includes('请客观描述'));
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, PNG_DATA_URI, 'the image must actually be forwarded');

  assert.equal(response.json.answers[0].id, 'describe_look1');
  assert.equal(response.json.answers[0].type, 'text');
  assert.equal(response.json.answers[0].content, '整体风格：休闲');
  assert.deepEqual(response.json.usage, { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 });
});

test('VISION_MAX_TOKENS is honoured', async (t) => {
  const rig = await makeRig(t, { env: { VISION_MAX_TOKENS: '1234' } });
  await ask(rig.relayUrl, { state: 's', questions: DESCRIBE_QUESTIONS, images: [{ id: 'look1', dataUri: PNG_DATA_URI }] });
  assert.equal(rig.requests[0].json.max_tokens, 1234);
});

test('describe_* with several look ids answers every id', async (t) => {
  const rig = await makeRig(t);
  const response = await ask(rig.relayUrl, {
    state: 's',
    questions: [
      { id: 'describe_look1', type: 'text', question: '请客观描述第 1 套。' },
      { id: 'describe_look2', type: 'text', question: '请客观描述第 2 套。' },
    ],
    images: [{ id: 'look1', dataUri: PNG_DATA_URI }, { id: 'look2', dataUri: PNG_DATA_URI }],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.answers.map((a) => a.id), ['describe_look1', 'describe_look2']);
  const upstream = rig.requests[0];
  assert.equal(upstream.json.messages[0].content.length, 3, 'text + 2 images');
});

test('review and deep_report route to vision with their own temperature', async (t) => {
  const rig = await makeRig(t);
  await ask(rig.relayUrl, { state: STATE_TEXT, questions: REVIEW_QUESTIONS, images: [{ id: 'look1', dataUri: PNG_DATA_URI }] });
  await ask(rig.relayUrl, { state: STATE_TEXT, questions: DEEP_QUESTIONS, images: [{ id: 'look1', dataUri: PNG_DATA_URI }] });

  assert.equal(callsTo(rig.requests, '/v1/systemone'), 0, 'review/deep must never be treated as scoring');
  assert.equal(callsTo(rig.requests, '/chat/completions'), 2);
  assert.equal(rig.requests[0].json.temperature, 0, 'review is deterministic');
  assert.equal(rig.requests[1].json.temperature, 0.2, 'deep report keeps a little creativity');
  assert.equal(rig.requests[1].json.messages[0].content[0].text, '请给出深度分析报告。');
});

/* ────────────────────────── ⑤ 空正文重投 ────────────────────────── */

test('deep_report retries exactly once on empty content and uses the second answer', async (t) => {
  const upstream = createUpstream((record, res, requests) => {
    if (!record.url.startsWith('/chat/completions')) return reply(res, 404, { error: { message: 'nope' } });
    const attempt = requests.filter((r) => r.url.startsWith('/chat/completions')).length;
    // 第一次模仿推理模型：HTTP 200 但 content 是空串；第二次给出正文
    reply(res, 200, {
      model: 'fake-vision',
      choices: [{ message: { content: attempt === 1 ? '' : 'DEEP-REPORT-OK' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
  });
  const rig = await makeRig(t, { upstream });
  const response = await ask(rig.relayUrl, { state: STATE_TEXT, questions: DEEP_QUESTIONS, images: [{ id: 'look1', dataUri: PNG_DATA_URI }] });

  assert.equal(response.status, 200);
  assert.equal(response.json.answers[0].content, 'DEEP-REPORT-OK');
  assert.equal(callsTo(rig.requests, '/chat/completions'), 2, 'exactly one retry');
});

test('deep_report retries at most once when every attempt comes back empty', async (t) => {
  const upstream = createUpstream((record, res) => {
    if (!record.url.startsWith('/chat/completions')) return reply(res, 404, { error: { message: 'nope' } });
    reply(res, 200, { model: 'fake-vision', choices: [{ message: { content: '   ' } }], usage: {} });
  });
  const rig = await makeRig(t, { upstream });
  const response = await ask(rig.relayUrl, { state: STATE_TEXT, questions: DEEP_QUESTIONS, images: [{ id: 'look1', dataUri: PNG_DATA_URI }] });

  assert.equal(response.status, 200);
  assert.equal(response.json.answers[0].content, '', 'still empty -> explicit empty answer, not fake success');
  assert.equal(callsTo(rig.requests, '/chat/completions'), 2, 'at most one retry, never two');
});

test('describe_* does NOT retry on empty content', async (t) => {
  const upstream = createUpstream((record, res) => {
    if (!record.url.startsWith('/chat/completions')) return reply(res, 404, { error: { message: 'nope' } });
    reply(res, 200, { model: 'fake-vision', choices: [{ message: { content: '' } }], usage: {} });
  });
  const rig = await makeRig(t, { upstream });
  const response = await ask(rig.relayUrl, { state: 's', questions: DESCRIBE_QUESTIONS, images: [{ id: 'look1', dataUri: PNG_DATA_URI }] });

  assert.equal(response.status, 200);
  assert.equal(response.json.answers[0].content, '');
  assert.equal(callsTo(rig.requests, '/chat/completions'), 1, 'empty describe is a real failure, not a retry case');
});

test('forwardVision does not retry once the caller is cancelled', async (t) => {
  const upstream = createUpstream((record, res) => {
    reply(res, 200, { model: 'fake-vision', choices: [{ message: { content: '' } }], usage: {} });
  });
  const upstreamUrl = await listen(upstream.server);
  t.after(() => stop(upstream.server));
  const config = readConfig({
    APP_TOKEN: 't',
    VISION_BASE_URL: upstreamUrl,
    VISION_MODEL: 'm',
    VISION_API_KEY: FAKE_VISION_KEY,
  });

  const result = await forwardVision(config, {
    answerIds: ['deep_report'],
    state: STATE_TEXT,
    questionText: 'q',
    images: [{ id: 'look1', dataUri: PNG_DATA_URI }],
    allowEmptyRetry: true,
    isCancelled: () => true,
  });

  assert.equal(result.attempts, 1, 'cancelled -> no retry');
  assert.equal(upstream.requests.length, 1);
  assert.equal(result.status, 200);
  assert.equal(result.payload.answers[0].content, '');
});

test('client disconnect during a deep request stops the retry', async (t) => {
  const upstream = createUpstream((record, res) => {
    if (!record.url.startsWith('/chat/completions')) return reply(res, 404, { error: { message: 'nope' } });
    // 第一次慢 200ms 再回空正文：给客户端留出"取消"的时间窗
    setTimeout(() => reply(res, 200, { model: 'fake-vision', choices: [{ message: { content: '' } }], usage: {} }), 200);
  });
  const rig = await makeRig(t, { upstream });

  const controller = new AbortController();
  const pending = fetch(`${rig.relayUrl}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FAKE_APP_TOKEN}` },
    body: JSON.stringify({ state: STATE_TEXT, questions: DEEP_QUESTIONS, images: [{ id: 'look1', dataUri: PNG_DATA_URI }] }),
    signal: controller.signal,
  }).catch(() => null);

  assert.equal(await waitFor(() => callsTo(rig.requests, '/chat/completions') >= 1), true, 'upstream must have been called once');
  controller.abort();
  await pending;
  await sleep(400);

  assert.equal(callsTo(rig.requests, '/chat/completions'), 1, 'a cancelled user must not trigger a retry');
});

/* ────────────────────────── ⑥ 上游错误原因 ────────────────────────── */

test('decision upstream 4xx reason is read from the body and surfaced', async (t) => {
  const upstream = createUpstream((record, res) => {
    reply(res, 401, { error: { message: 'Invalid API key' } });
  });
  const rig = await makeRig(t, { upstream });
  const response = await ask(rig.relayUrl, { state: STATE_TEXT, questions: SCORE_QUESTIONS });

  assert.equal(response.status, 502);
  assert.match(response.json.error.message, /decision upstream HTTP 401/);
  assert.match(response.json.error.message, /Invalid API key/);
  assert.equal(response.json.error.upstream_status, 401);
});

test('non-JSON upstream error pages are still read (response.text then parse)', async (t) => {
  const upstream = createUpstream((record, res) => {
    replyText(res, 500, '<html><body>Internal Server Error</body></html>', 'text/html');
  });
  const rig = await makeRig(t, { upstream });
  const response = await ask(rig.relayUrl, { state: STATE_TEXT, questions: DESCRIBE_QUESTIONS, images: [{ id: 'look1', dataUri: PNG_DATA_URI }] });

  assert.equal(response.status, 502);
  assert.match(response.json.error.message, /vision upstream HTTP 500/);
  assert.match(response.json.error.message, /Internal Server Error/);
});

test('an upstream error that echoes a key is redacted before it reaches the App', async (t) => {
  const upstream = createUpstream((record, res) => {
    reply(res, 401, { error: { message: `bad key sk-live-ABCDEFG12345 rejected` } });
  });
  const rig = await makeRig(t, { upstream });
  const response = await ask(rig.relayUrl, { state: STATE_TEXT, questions: SCORE_QUESTIONS });

  assert.equal(response.status, 502);
  assert.ok(!response.json.error.message.includes('sk-live-ABCDEFG12345'), 'never echo a key');
  assert.match(response.json.error.message, /sk-\*\*\*/);
});

test('unreachable decision upstream reports 502 with a reason', async (t) => {
  const dead = http.createServer();
  const deadUrl = await listen(dead);
  await stop(dead); // 端口随即关闭 → 连接被拒
  const upstream = createUpstream(defaultUpstreamHandler);
  const upstreamUrl = await listen(upstream.server);
  const config = readConfig({
    APP_TOKEN: FAKE_APP_TOKEN,
    DECISION_BASE_URL: deadUrl,
    DECISION_MODEL: 'm',
    DECISION_API_KEY: FAKE_DECISION_KEY,
    VISION_BASE_URL: upstreamUrl,
    VISION_MODEL: 'm',
    VISION_API_KEY: FAKE_VISION_KEY,
  });
  const relay = createRelayServer(config, { log: () => {} });
  const relayUrl = await listen(relay);
  t.after(async () => {
    await stop(relay);
    await stop(upstream.server);
  });

  const response = await ask(relayUrl, { state: STATE_TEXT, questions: SCORE_QUESTIONS });
  assert.equal(response.status, 502);
  assert.match(response.json.error.message, /decision upstream unreachable/i);
  assert.ok(response.json.error.message.length > 'decision upstream unreachable'.length, 'must carry the reason');
});

test('upstreamReason extracts message detail and redacts keys', () => {
  assert.equal(upstreamReason({ status: 401, json: { error: { message: 'Invalid API key' } }, text: 'x' }), 'Invalid API key');
  assert.equal(upstreamReason({ status: 400, json: { message: 'model not found' }, text: 'x' }), 'model not found');
  assert.equal(upstreamReason({ status: 500, json: null, text: 'Internal Server Error' }), 'Internal Server Error');
  assert.equal(upstreamReason({ status: 0, error: new Error('connect ECONNREFUSED') }), 'connect ECONNREFUSED');
  assert.equal(upstreamReason({ status: 0, timedOut: true, error: new Error('aborted') }), 'upstream timeout');
  assert.ok(!upstreamReason({ status: 401, json: { error: { message: 'bad sk-live-abcdef123456' } }, text: '' }).includes('abcdef123456'));
});

/* ────────────────────────── ⑦ 请求体校验 / 日志纯净 ────────────────────────── */

test('malformed requests get 400/404/405 without touching the upstream', async (t) => {
  const rig = await makeRig(t);
  const badJson = await ask(rig.relayUrl, '{not json');
  assert.equal(badJson.status, 400);
  const noQuestions = await ask(rig.relayUrl, { state: 's', questions: [] });
  assert.equal(noQuestions.status, 400);
  assert.match(noQuestions.json.error.message, /questions/);
  const noImage = await ask(rig.relayUrl, { state: 's', questions: DESCRIBE_QUESTIONS });
  assert.equal(noImage.status, 400);
  assert.match(noImage.json.error.message, /requires images/);

  const getAsk = await fetch(`${rig.relayUrl}/ask`);
  assert.equal(getAsk.status, 405);
  const notFound = await fetch(`${rig.relayUrl}/nope`);
  assert.equal(notFound.status, 404);
  assert.equal(rig.requests.length, 0);
});

test('logs never contain an app token, an upstream key, a dataUri or base64', async (t) => {
  const rig = await makeRig(t);
  // 三种请求都跑一遍：打分（带图，图应被忽略）、deep（带图）、鉴权失败
  await ask(rig.relayUrl, { state: STATE_TEXT, questions: SCORE_QUESTIONS, images: [{ id: 'look1', dataUri: PNG_DATA_URI }] });
  await ask(rig.relayUrl, { state: STATE_TEXT, questions: DEEP_QUESTIONS, images: [{ id: 'look1', dataUri: PNG_DATA_URI }] });
  await ask(rig.relayUrl, { state: STATE_TEXT, questions: SCORE_QUESTIONS }, { token: 'wrong-token' });

  const logs = rig.logs.join('\n');
  assert.ok(logs.length > 0, 'the relay must actually log something');
  assert.ok(!logs.includes(FAKE_APP_TOKEN), 'app token must not be logged');
  assert.ok(!logs.includes(FAKE_DECISION_KEY), 'decision key must not be logged');
  assert.ok(!logs.includes(FAKE_VISION_KEY), 'vision key must not be logged');
  assert.ok(!logs.includes('base64'), 'no base64 markers in logs');
  assert.ok(!logs.includes(PNG_BASE64), 'no image payload in logs');
  assert.ok(!logs.includes('data:image'), 'no dataUri in logs');
  // 但摘要信息必须在：模式、状态码、计数
  assert.match(logs, /mode=score/);
  assert.match(logs, /mode=deep/);
  assert.match(logs, /status=401/);
});

test('redactSecrets scrubs keys, bearer tokens and data URIs', () => {
  assert.equal(redactSecrets('key=sk-abcdef123456 done'), 'key=sk-*** done');
  assert.equal(redactSecrets('Authorization: Bearer abcdef123456'), 'Authorization: Bearer ***');
  assert.equal(redactSecrets(`img ${PNG_DATA_URI} end`), 'img data:*** end');
  assert.equal(redactSecrets('plain text'), 'plain text');
});
