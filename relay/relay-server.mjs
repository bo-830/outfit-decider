#!/usr/bin/env node
/**
 * relay/relay-server.mjs —— 可托管部署的「中转服务」
 *
 * 为什么需要它
 * ------------
 * 原来的部署形态要求用户自己配**两把**上游 Key（决策模型 + 多模态模型），对"没有电脑、
 * 也懒得折腾"的用户门槛太高。中转服务把上游 Key 收进**服务端环境变量**，App 侧只需要填
 * 「中转地址 + 一个口令」，于是：
 *
 *   App ──POST /ask (Bearer <APP_TOKEN>)──▶ relay ──Bearer <上游 Key>──▶ 决策模型 / 多模态模型
 *
 * App 的请求/响应契约（SPEC §1.3）**完全不变**：
 *   请求  {model, state, questions:[{id,type,question}], images?:[{id,dataUri}]}
 *   响应  {model, answers:[{id,type,score,content,confidence}], usage:{...}}
 * 协议翻译复用 `tools/laya-adapter.mjs` 里已经实测验证过的那套具名导出（**该文件只读，不修改**）：
 *   - toLayaRequest    App 数组式 questions → 上游 {state, questions:<id>: {type,instructions,criteria}}（6 档 criteria）
 *   - isDescribeRequest / isReviewRequest / isDeepRequest  三条多模态路由判据
 *   - buildVisionMessages / toAppResponse                  多模态消息体与响应翻译
 *
 * 环境变量（缺 APP_TOKEN 直接拒绝启动）
 * ------------------------------------
 *   RELAY_PORT          监听端口，默认 8787
 *   RELAY_HOST          监听地址，默认 0.0.0.0
 *   APP_TOKEN           **必填**：App 侧填的同一个口令。缺失 → 拒绝启动（否则就是开放代理）
 *   DECISION_BASE_URL   决策模型基地址（默认补 /v1/systemone）
 *   DECISION_MODEL      转发给决策端点的模型名
 *   DECISION_API_KEY    决策端点鉴权
 *   VISION_BASE_URL     OpenAI 兼容多模态端点基地址（默认补 /chat/completions）
 *   VISION_MODEL        多模态模型名
 *   VISION_API_KEY      多模态端点鉴权
 *   VISION_MAX_TOKENS   多模态 max_tokens，默认 8000
 *
 * 三条实测血泪教训（都在下面的实现里）
 * ------------------------------------
 * 1. 推理模型（deepseek-flash 这类）会把 max_tokens 花在 reasoning 上，**偶尔 HTTP 200 但
 *    content 是空串**（实测约 1/4）。所以 `deep_report` 遇到空正文**自动重投一次，最多一次**；
 *    用户已取消（客户端断开）时绝不重投。
 * 2. 非 2xx 时上游通常在 body 里说明原因（`{"error":{"message":"..."}}`）。必须用
 *    `response.text()` 再尝试 `JSON.parse` 读出来 —— 直接 `.json()` 遇到非 JSON 的错误页会抛异常，
 *    原因就丢了。读到的原因会放进响应的 error.message（并脱敏 + 截断）。
 * 3. 日志里**绝不**出现 Key、dataUri、base64。所有出站日志都过 `redactSecrets`；请求体永不落日志。
 *
 * 隐私：图片只在内存中以 dataUri 形式随请求转发，**不写盘、不记日志、不留存**。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  buildVisionMessages,
  isDeepRequest,
  isDescribeRequest,
  isReviewRequest,
  toAppResponse,
  toLayaRequest,
} from '../tools/laya-adapter.mjs';

export const RELAY_NAME = 'outfit-relay';
export const RELAY_VERSION = '1.0.0';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8787;
const DEFAULT_VISION_MAX_TOKENS = 8000;
const DECISION_PATH = '/v1/systemone';
const VISION_PATH = '/chat/completions';

/** 请求体上限：多套穿搭的原图 base64 会比较大，但也不能无限。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** 打分请求超时（与适配器一致，实测够用）。 */
const SCORE_TIMEOUT_MS = 120_000;
/** 多模态请求超时（deep 报告最慢时接近此值）。 */
const VISION_TIMEOUT_MS = 120_000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
};

/* ────────────────────────── 脱敏（隐私红线） ────────────────────────── */

/**
 * 把任何可能出站的文本里的秘密抹掉。**所有** log(...) 与给客户端的错误信息都过这一层：
 * 中转是多人共用的托管服务，一行日志泄漏 Key 就等于把上游账号送人。
 *
 * 覆盖：`sk-` 系 Key、`Bearer xxx`、data URI（含 base64）、以及过长的裸 base64 串。
 */
export function redactSecrets(text) {
  return String(text == null ? '' : text)
    .replace(/data:[^\s"']*;base64,[A-Za-z0-9+/=]+/gi, 'data:***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_~-]{4,}/gi, 'sk-***')
    .replace(/[A-Za-z0-9+/]{64,}={0,2}/g, '<redacted>');
}

/** 默认日志出口：stdout，逐行脱敏（防御性二次保险；调用方也应保证不传秘密）。 */
function defaultLog(line) {
  process.stdout.write(`${redactSecrets(line)}\n`);
}

/* ────────────────────────── 配置 ────────────────────────── */

function trimmed(env, name) {
  const value = env ? env[name] : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

/** 已认识的「完整端点」后缀：用户把整个 URL 填进来时不要再补默认路径。 */
const KNOWN_ENDPOINT_SUFFIXES = [
  '/v1/systemone',
  '/v1/systemone/batch',
  '/ask',
  '/chat/completions',
  '/v1/chat/completions',
];

/**
 * 基地址 → 完整端点 URL。
 * 契约里给的是 `DECISION_BASE_URL` / `VISION_BASE_URL`（基地址），所以默认补上各自的路径；
 * 但运维很容易直接把完整端点粘进来（`.../v1/chat/completions`），那时再补一次就会 404，
 * 所以凡是已经以某个已知端点结尾的就原样使用。
 */
export function resolveEndpoint(baseUrl, defaultPath) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  const lower = base.toLowerCase();
  if (lower.endsWith(String(defaultPath).toLowerCase())) return base;
  if (KNOWN_ENDPOINT_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return base;
  return `${base}${defaultPath}`;
}

/**
 * 读取环境变量 → 配置对象。缺 `APP_TOKEN` **抛错拒绝启动**：
 * 一个没有口令的中转就是任何人都能白嫖的开放代理（还会把上游 Key 暴露给滥用者）。
 *
 * @param {Record<string,string|undefined>} [env] 便于测试注入，默认 process.env
 */
export function readConfig(env = process.env) {
  const appToken = trimmed(env, 'APP_TOKEN');
  if (!appToken) {
    const err = new Error(
      'APP_TOKEN is required: refusing to start. A relay without a passphrase would be an open '
      + 'proxy. Set APP_TOKEN=<shared passphrase> and give the same value to the App.',
    );
    err.code = 'APP_TOKEN_REQUIRED';
    throw err;
  }

  const portRaw = trimmed(env, 'RELAY_PORT');
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    const err = new Error(`RELAY_PORT must be an integer in 0..65535, got "${portRaw}"`);
    err.code = 'RELAY_PORT_INVALID';
    throw err;
  }

  const maxTokensRaw = trimmed(env, 'VISION_MAX_TOKENS');
  const visionMaxTokens = maxTokensRaw ? Number(maxTokensRaw) : DEFAULT_VISION_MAX_TOKENS;
  if (!Number.isFinite(visionMaxTokens) || visionMaxTokens <= 0) {
    const err = new Error(`VISION_MAX_TOKENS must be a positive number, got "${maxTokensRaw}"`);
    err.code = 'VISION_MAX_TOKENS_INVALID';
    throw err;
  }

  const warnings = [];
  const decisionBaseUrl = trimmed(env, 'DECISION_BASE_URL');
  const decisionApiKey = trimmed(env, 'DECISION_API_KEY');
  const decisionModel = trimmed(env, 'DECISION_MODEL');
  const visionBaseUrl = trimmed(env, 'VISION_BASE_URL');
  const visionApiKey = trimmed(env, 'VISION_API_KEY');
  const visionModel = trimmed(env, 'VISION_MODEL');

  if (!decisionBaseUrl) warnings.push('DECISION_BASE_URL is not set: scoring requests will fail with 502.');
  else if (!decisionApiKey) warnings.push('DECISION_API_KEY is not set: the decision upstream will receive no Authorization header.');
  if (!decisionModel) warnings.push('DECISION_MODEL is not set: the relay forwards the model name sent by the App.');
  if (!visionBaseUrl) warnings.push('VISION_BASE_URL is not set: describe_* / review / deep_report will fail with 502.');
  else if (!visionApiKey) warnings.push('VISION_API_KEY is not set: the vision upstream will receive no Authorization header.');
  if (!visionModel) warnings.push('VISION_MODEL is not set: the vision upstream will receive an empty model name.');

  return Object.freeze({
    relay: RELAY_NAME,
    version: RELAY_VERSION,
    host: trimmed(env, 'RELAY_HOST') || DEFAULT_HOST,
    port,
    appToken,
    decision: Object.freeze({
      baseUrl: decisionBaseUrl,
      url: resolveEndpoint(decisionBaseUrl, DECISION_PATH),
      model: decisionModel,
      apiKey: decisionApiKey,
      configured: Boolean(decisionBaseUrl),
      apiKeySet: Boolean(decisionApiKey),
    }),
    vision: Object.freeze({
      baseUrl: visionBaseUrl,
      url: resolveEndpoint(visionBaseUrl, VISION_PATH),
      model: visionModel,
      apiKey: visionApiKey,
      maxTokens: visionMaxTokens,
      configured: Boolean(visionBaseUrl),
      apiKeySet: Boolean(visionApiKey),
    }),
    warnings: Object.freeze(warnings),
  });
}

/* ────────────────────────── HTTP 小工具 ────────────────────────── */

function sendJson(res, status, payload) {
  // 客户端可能已经断开（用户取消）：此时写响应只会触发二次错误，直接放弃。
  if (res.writableEnded || res.destroyed) return;
  const text = JSON.stringify(payload);
  try {
    res.writeHead(status, {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  } catch {
    // 连接已断，无需上报
  }
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('request body too large');
        err.code = 'BODY_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 常量时间口令比较，避免用 `===` 泄漏前缀信息。 */
export function tokenMatches(headerValue, expected) {
  const match = /^Bearer\s+(.+)$/i.exec(String(headerValue == null ? '' : headerValue).trim());
  if (!match || !expected) return false;
  const given = Buffer.from(match[1], 'utf8');
  const want = Buffer.from(String(expected), 'utf8');
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}

/**
 * 客户端断线 → abort 上游请求。
 * `res.writableEnded` 为 true 时是我们自己正常收尾，不算取消。
 */
function abortGate(req, res) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on('aborted', onClose);
  res.on('close', onClose);
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off('aborted', onClose);
      res.off('close', onClose);
    },
  };
}

/* ────────────────────────── 上游调用 ────────────────────────── */

/**
 * POST JSON 到上游，**总是先读 text 再尝试 JSON.parse**（教训 2）。
 * 返回 `{ok, status, json, text, error, timedOut, aborted}` —— 不抛异常，让调用方决定状态码与文案。
 */
async function postJson(url, { headers, body, signal, timeoutMs, fetchImpl }) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return {
      ok: false, status: 0, json: null, text: '',
      error: new Error('no fetch implementation available'),
      timedOut: false, aborted: false,
    };
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json,
      text,
      error: null,
      timedOut: false,
      aborted: Boolean(signal && signal.aborted),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      json: null,
      text: '',
      error: err,
      timedOut,
      aborted: Boolean(signal && signal.aborted) || timedOut,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 从上游失败响应里抠出**它自己给的原因**（教训 2）。读不出来就回落到纯文本片段。
 * 一律脱敏 + 压平 + 截断到 200 字，绝不让 Key 借道错误信息出站。
 */
export function upstreamReason(result) {
  if (!result) return '';
  if (!result.status) {
    const message = result.timedOut
      ? 'upstream timeout'
      : (result.error && result.error.message) || String(result.error || 'upstream unreachable');
    return redactSecrets(message).replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  if (result.json) {
    const j = result.json;
    let message = (j.error && (j.error.message || j.error.detail || j.error.type))
      || j.message
      || j.detail
      || (typeof j.error === 'string' ? j.error : '');
    if (message && typeof message !== 'string') message = JSON.stringify(message);
    if (message) return redactSecrets(String(message)).replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  return redactSecrets(String(result.text || '')).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * 上游失败 → 统一 502（含原因）。
 *
 * 为什么不是把上游状态码原样透传：上游 401 是**中转自己的 Key** 不对，透传给 App 会被理解成
 * "用户口令错"，排查方向全错。统一 502 + 原因文本，App 会显示「服务端出错：Invalid API key」。
 * 原始状态码仍放在 `upstream_status` 字段里供排查。
 */
function upstreamErrorPayload(kind, result) {
  const status = Number.isFinite(result && result.status) ? result.status : 0;
  const reason = upstreamReason(result);
  const base = status
    ? `${kind} upstream HTTP ${status}`
    : `${kind} upstream unreachable`;
  return {
    status: 502,
    payload: {
      error: {
        message: reason ? `${base}: ${reason}` : base,
        upstream_status: status,
      },
    },
  };
}

function toInt(n) {
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function usageOf(usage) {
  const source = usage && typeof usage === 'object' ? usage : {};
  const prompt = toInt(source.prompt_tokens);
  const completion = toInt(source.completion_tokens);
  const total = toInt(source.total_tokens);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total || prompt + completion };
}

/* ────────────────────────── 三条转发通道 ────────────────────────── */

/**
 * 打分：App 数组式 questions（6 维）→ 上游 map（6 档 criteria）→ 上游 map 响应 → App 数组式响应。
 * 复用适配器实测过的翻译，本身不做任何"建议/解释"文本。
 */
export async function forwardScore(config, body, ids, request = {}, deps = {}) {
  if (!config.decision || !config.decision.baseUrl) {
    return { status: 502, payload: { error: { message: 'decision upstream not configured on the relay' } }, attempts: 0 };
  }
  const upstreamBody = toLayaRequest(body, { model: config.decision.model, protocol: 'laya' });
  const result = await postJson(config.decision.url, {
    headers: {
      'Content-Type': 'application/json',
      ...(config.decision.apiKey ? { Authorization: `Bearer ${config.decision.apiKey}` } : {}),
    },
    body: upstreamBody,
    signal: request.signal,
    timeoutMs: SCORE_TIMEOUT_MS,
    fetchImpl: deps.fetchImpl,
  });
  if (!result.ok) return { ...upstreamErrorPayload('decision', result), attempts: 1 };
  // 2xx 但不是预期形状（非 JSON / 没有 answers）时明确失败，绝不回一个空 answers 让上层猜。
  const payload = toAppResponse(result.json, ids);
  if (!payload.answers.length) {
    const detail = upstreamReason(result);
    return {
      status: 502,
      attempts: 1,
      payload: {
        error: {
          message: detail
            ? `decision upstream returned no usable answers: ${detail}`
            : 'decision upstream returned no usable answers',
          upstream_status: result.status,
        },
      },
    };
  }
  return { status: 200, payload, attempts: 1 };
}

function extractContent(json) {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  const content = choice && choice.message && choice.message.content;
  return typeof content === 'string' ? content : '';
}

function toVisionPayload(ids, content, json, vision) {
  const model = (json && typeof json.model === 'string' && json.model) || vision.model || 'vision';
  return {
    model,
    answers: ids.map((id) => ({ id, type: 'text', content, confidence: 0.8 })),
    usage: usageOf(json && json.usage),
  };
}

/**
 * 多模态转发（describe_* / review / deep_report 共用）。
 *
 * 空正文自动重投**只对 deep_report 生效**（`allowEmptyRetry`），因为这是推理模型把预算花在
 * reasoning 上的已知坑（约 1/4），而 describe/review 的空正文属于真实失败，重投只是白花钱。
 * 重投上限 **1 次**；`signal` 已 abort 或 `isCancelled()` 为真时**绝不重投**（用户已经不等了）。
 *
 * @param {object} config 见 readConfig
 * @param {object} request `{answerIds, state, questionText, images, temperature, allowEmptyRetry, signal, isCancelled}`
 */
export async function forwardVision(config, request = {}, deps = {}) {
  const ids = (Array.isArray(request.answerIds) ? request.answerIds : [request.answerIds])
    .filter((id) => typeof id === 'string' && id);
  const label = ids[0] || 'vision';
  const vision = config.vision;
  if (!vision || !vision.baseUrl) {
    return { status: 502, payload: { error: { message: 'vision upstream not configured on the relay' } }, attempts: 0 };
  }
  const images = (Array.isArray(request.images) ? request.images : [])
    .filter((image) => image && typeof image.dataUri === 'string' && image.dataUri && image.id);
  if (!images.length) {
    return { status: 400, payload: { error: { message: `${label} requires images` } }, attempts: 0 };
  }

  // 指令由 App 侧拼好（系统提示 + 上下文 + "只输出 JSON"的约束）—— 中转只转发，不重复维护措辞。
  const messages = buildVisionMessages(request.state, request.questionText);
  messages[0].content = [
    { type: 'text', text: String(messages[0].content || '') },
    ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUri } })),
  ];
  const upstreamBody = {
    model: vision.model,
    messages,
    temperature: Number.isFinite(request.temperature) ? request.temperature : 0,
    max_tokens: vision.maxTokens,
  };
  const headers = {
    'Content-Type': 'application/json',
    ...(vision.apiKey ? { Authorization: `Bearer ${vision.apiKey}` } : {}),
  };

  const cancelled = () => Boolean(request.signal && request.signal.aborted)
    || (typeof request.isCancelled === 'function' && request.isCancelled() === true);

  const maxAttempts = request.allowEmptyRetry === true ? 2 : 1;
  let calls = 0;
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1 && cancelled()) break;
    calls += 1;
    last = await postJson(vision.url, {
      headers,
      body: upstreamBody,
      signal: request.signal,
      timeoutMs: VISION_TIMEOUT_MS,
      fetchImpl: deps.fetchImpl,
    });
    if (!last.ok) return { ...upstreamErrorPayload('vision', last), attempts: calls };
    const content = extractContent(last.json);
    if (content.trim() !== '') {
      return { status: 200, payload: toVisionPayload(ids, content, last.json, vision), attempts: calls };
    }
    if (!request.allowEmptyRetry) break;
    if (attempt >= maxAttempts || cancelled()) {
      (deps.log || defaultLog)(`[relay] ${label}: empty content, no retry (cancelled or exhausted)`);
      break;
    }
    (deps.log || defaultLog)(`[relay] ${label}: empty content, retrying once`);
  }
  // 重投后仍为空：保持 200 + 空正文，让上层按既有的 invalid_input 处理（不假装成功）。
  return { status: 200, payload: toVisionPayload(ids, '', last ? last.json : null, vision), attempts: calls };
}

/* ────────────────────────── 服务 ────────────────────────── */

function healthPayload(config) {
  return {
    ok: true,
    relay: RELAY_NAME,
    version: RELAY_VERSION,
    upstream: {
      decision: {
        configured: config.decision.configured,
        apiKeySet: config.decision.apiKeySet,
        model: config.decision.model || null,
      },
      vision: {
        configured: config.vision.configured,
        apiKeySet: config.vision.apiKeySet,
        model: config.vision.model || null,
        maxTokens: config.vision.maxTokens,
      },
    },
  };
}

/**
 * 建服务（不 listen，便于单测用 listen(0) 选随机端口）。
 * @param {object} config readConfig() 的返回值
 * @param {{log?: (line:string)=>void, fetchImpl?: Function}} [deps]
 */
export function createRelayServer(config, deps = {}) {
  if (!config || typeof config !== 'object' || !config.appToken) {
    const err = new Error(
      'APP_TOKEN is required: refusing to start. A relay without a passphrase would be an open '
      + 'proxy. Set APP_TOKEN=<shared passphrase> and give the same value to the App.',
    );
    err.code = 'APP_TOKEN_REQUIRED';
    throw err;
  }
  const log = typeof deps.log === 'function' ? (line) => deps.log(redactSecrets(line)) : defaultLog;
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch;
  const forwardDeps = { fetchImpl, log };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // web 预览（Expo web）跨域，预检必须放行且**不鉴权**。
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // 健康检查不鉴权：便于托管平台（Render/Railway/Fly）探活。
    if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/health' || url.pathname === '/healthz')) {
      sendJson(res, 200, healthPayload(config));
      return;
    }

    if (url.pathname !== '/ask') {
      sendJson(res, 404, { error: { message: 'not found' } });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { message: 'use POST /ask' } });
      return;
    }

    if (!tokenMatches(req.headers.authorization, config.appToken)) {
      log(`[relay] POST /ask status=401 reason=bad_or_missing_app_token ms=${Date.now() - started}`);
      sendJson(res, 401, { error: { message: 'invalid or missing app token' } });
      return;
    }

    if (typeof fetchImpl !== 'function') {
      log('[relay] POST /ask status=502 reason=no_fetch_impl');
      sendJson(res, 502, { error: { message: 'relay runtime has no fetch implementation' } });
      return;
    }

    const gate = abortGate(req, res);
    try {
      let body;
      try {
        body = JSON.parse((await readBody(req)).toString('utf8'));
      } catch (err) {
        const tooLarge = err && err.code === 'BODY_TOO_LARGE';
        log(`[relay] POST /ask status=${tooLarge ? 413 : 400} reason=bad_body`);
        sendJson(res, tooLarge ? 413 : 400, {
          error: { message: tooLarge ? 'request body too large' : 'request body must be valid JSON' },
        });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        log('[relay] POST /ask status=400 reason=body_not_object');
        sendJson(res, 400, { error: { message: 'request body must be a JSON object' } });
        return;
      }
      const questions = Array.isArray(body.questions) ? body.questions : [];
      if (!questions.length) {
        log('[relay] POST /ask status=400 reason=no_questions');
        sendJson(res, 400, { error: { message: "request body must carry a 'questions' array" } });
        return;
      }
      const ids = questions.map((question) => String((question && question.id) || '')).filter(Boolean);
      const images = Array.isArray(body.images) ? body.images : [];

      /**
       * 路由顺序有讲究：先判三条**多模态**通道（deep → review → describe），剩下的才是打分。
       * 漏判的后果是 deep/review 被打分路径吞掉 —— App 侧表现为「模型返回的内容看不懂」（实测踩过）。
       */
      let mode;
      let result;
      if (isDeepRequest(questions)) {
        mode = 'deep';
        result = await forwardVision(config, {
          answerIds: ids,
          state: body.state,
          questionText: questions[0] && questions[0].question,
          images,
          temperature: 0.2,
          // 推理模型空正文的坑：仅 deep_report 自动重投一次
          allowEmptyRetry: true,
          signal: gate.signal,
          isCancelled: () => gate.signal.aborted,
        }, forwardDeps);
      } else if (isReviewRequest(questions)) {
        mode = 'review';
        result = await forwardVision(config, {
          answerIds: ids,
          state: body.state,
          questionText: questions[0] && questions[0].question,
          images,
          temperature: 0,
          signal: gate.signal,
          isCancelled: () => gate.signal.aborted,
        }, forwardDeps);
      } else if (isDescribeRequest(questions)) {
        mode = 'describe';
        result = await forwardVision(config, {
          answerIds: ids,
          state: body.state,
          questionText: questions[0] && questions[0].question,
          images,
          temperature: 0,
          signal: gate.signal,
          isCancelled: () => gate.signal.aborted,
        }, forwardDeps);
      } else {
        mode = 'score';
        result = await forwardScore(config, body, ids, { signal: gate.signal }, forwardDeps);
      }

      log(
        `[relay] POST /ask mode=${mode} status=${result.status} ms=${Date.now() - started}`
        + ` questions=${ids.length} images=${images.length} upstream_calls=${result.attempts || 0}`,
      );
      sendJson(res, result.status, result.payload);
    } catch (err) {
      log(`[relay] POST /ask status=502 reason=${redactSecrets(err && err.message).slice(0, 160)}`);
      sendJson(res, 502, { error: { message: 'relay internal error' } });
    } finally {
      gate.cleanup();
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

/** 便捷启动（供 main 与测试用）。 */
export function startRelay(config, deps = {}) {
  // 启动日志同样过一层脱敏：模型名之类虽然一般不是秘密，但少一条"万一"的出站通道。
  const log = typeof deps.log === 'function' ? (line) => deps.log(redactSecrets(line)) : defaultLog;
  const server = createRelayServer(config, deps);
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : config.port;
    log(`[relay] listening on http://${config.host}:${actualPort}`);
    log(`[relay] decision upstream: ${config.decision.configured ? 'configured' : 'NOT configured'} model=${config.decision.model || '(from App)'}`);
    log(`[relay] vision upstream: ${config.vision.configured ? 'configured' : 'NOT configured'} model=${config.vision.model || '(empty)'} max_tokens=${config.vision.maxTokens}`);
    log('[relay] app token: set');
  });
  server.on('error', (err) => {
    log(`[relay] FATAL listen failed: ${redactSecrets(err && err.message)}`);
    process.exitCode = 1;
  });
  return server;
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    const config = readConfig();
    for (const warning of config.warnings) defaultLog(`[relay] WARN ${warning}`);
    startRelay(config);
  } catch (err) {
    process.stderr.write(`[relay] FATAL ${redactSecrets(err && err.message)}\n`);
    process.exit(1);
  }
}
