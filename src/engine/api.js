// SPEC §3.10 · 网络层：JEv 云端 / Laya 局域网双模式适配，统一 JSON 契约与错误分类。
// 铁律：API Key 绝不进入异常 message、日志、window.__OD_PROBE__ 或验证报告（用 redactConfig 过一层）。
//
// 超时选型（v1.2 修正）：**不再用"有没有 images"区分**——SPEC §3.7 修正后 System One 的 describe
// 也会带图。改用语义判据：questions 里出现 id='deep_report' → System Two，用 timeoutMs；
// 其余（describe_* / 6 个 score 维度）→ System One，用 quickTimeoutMs；显式传 timeoutMs 优先。

import { buildRequest } from '../core/protocol.js';
import { ERRORS, ERROR_KINDS, errorFor, errorInfo } from '../data/copy.js';

/** SPEC §5.1「重试」列的全局上限：可重试错误自动重投 1 次（退避默认 600ms，rate_limit 用文案里的 2s）。 */
const AUTO_RETRY_MAX = 1;
const AUTO_RETRY_DELAY_MS = 600;

export const DEFAULT_CONFIG = {
  mode: 'jev',
  // SPEC §3.9c 三档引擎模式：laya_only ｜ laya_review（默认）｜ multimodal_only
  engineMode: 'laya_review',
  // 多模态端点与决策模型**分开配置**：laya_review 下「谁看图」和「谁打分」是两个不同的服务。
  visionBaseUrl: '',
  visionModel: '',
  visionApiKey: '',
  visionTimeoutMs: 60000,
  // 视觉模型是否已配在**服务端**（如本机 Laya 适配器用自己的 .env.local 配好）。
  // 只影响设置页的配置闸门顺序，不改变运行时行为。
  visionServerSide: false,
  // 推理模型的输出预算。太小 → reasoning 吃光 → content 空串（HTTP 200），
  // 会被误判成 parse 失败。纠正一次要给 N 套 × 6 维分数，留足余量。
  visionMaxTokens: 4000,
  baseUrl: 'http://127.0.0.1:8787',
  askPath: '/ask',
  healthPath: '/health',
  model: 'outfit-judge-v1',
  apiKey: '',
  timeoutMs: 45000,
  quickTimeoutMs: 20000,
};

/** SPEC §3.9c 合法取值（UI 与校验共用，避免两处硬编码漂移）。 */
export const ENGINE_MODES = ['laya_only', 'laya_review', 'multimodal_only'];

const HEALTH_TIMEOUT_MS = 8000;
const REDACTED_API_KEY = '***';
const NETWORK_CODES = [
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
];

/**
 * SPEC §3.10 · 去尾部 '/'；无 scheme 时补 'http://'；兼容 192.168.1.5:8787 / localhost:8787 这类输入。
 * 空串或只有 scheme 没有主机 → ''（调用方按 network 错误处理）。
 */
export function normalizeBaseUrl(url) {
  if (typeof url !== 'string') return '';
  let value = url.trim().replace(/\/+$/, '');
  if (!value) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/$/.test(value)) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:$/.test(value)) return '';
    value = value.startsWith('//') ? `http:${value}` : `http://${value}`;
  }
  return value;
}

/**
 * SPEC §3.10 · 建立 Api。
 * fetchImpl 可注入（mock / 单测）；未注入时每次调用都重新取 globalThis.fetch。
 */
export function makeApi({ config, fetchImpl = globalThis.fetch } = {}) {
  const configRef = config && typeof config === 'object' ? config : {};
  const settings = () => ({ ...DEFAULT_CONFIG, ...configRef });
  const resolveFetch = () => (typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null));

  /**
   * SPEC §5.1「重试」列：network / timeout / rate_limit / server 自动重投 1 次，
   * auth / parse / invalid_input / cancelled 一律不重试（重试也只会得到同样结果或放大计费）。
   * 重试可被调用方的 AbortSignal 立刻打断；不重试时不引入任何额外延迟。
   */
  async function ask(request = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= AUTO_RETRY_MAX; attempt += 1) {
      try {
        return await askOnce(request);
      } catch (err) {
        lastError = err;
        const retryable = err && err.retryable === true && err.kind !== 'cancelled';
        if (!retryable || attempt === AUTO_RETRY_MAX) throw err;
        if (request.signal && request.signal.aborted) throw apiError('cancelled');
        const delay = Number.isFinite(err.retryDelayMs) ? err.retryDelayMs : AUTO_RETRY_DELAY_MS;
        await sleep(delay, request.signal);
        if (request.signal && request.signal.aborted) throw apiError('cancelled');
      }
    }
    throw lastError || apiError('server');
  }

  async function askOnce(request = {}) {
    const cfg = settings();
    const doFetch = resolveFetch();
    const base = normalizeBaseUrl(cfg.baseUrl);
    if (!doFetch || !base) throw apiError('network');

    const { state, questions, images, timeoutMs, signal, model } = request;
    const requestModel = typeof model === 'string' && model ? model : cfg.model;
    const body = buildRequest({ model: requestModel, state: state ?? '', questions });
    const imageList = normalizeImages(images);
    if (imageList.length) body.images = imageList;

    const headers = { 'Content-Type': 'application/json' };
    if (cfg.mode === 'jev') {
      const key = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
      if (key) headers.Authorization = `Bearer ${key}`;
    }

    const url = `${base}${normalizePath(cfg.askPath, DEFAULT_CONFIG.askPath)}`;
    const gate = createAbortGate(signal, pickTimeout(timeoutMs, questions, cfg));

    try {
      let response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: gate.signal,
        });
      } catch (err) {
        throw normalizeFailure(err, gate);
      }

      const status = Number(response && response.status);
      const ok = response && typeof response.ok === 'boolean'
        ? response.ok
        : Number.isFinite(status) && status >= 200 && status < 300;
      if (!ok) {
        // SPEC §5.1 的 server 行专指 5xx。其余非 401/403/429 的 4xx（400 参数错、404 路径错…）
        // 重投一次也只会得到同样结果，只会让用户多等，因此借用 server 文案但**禁止重试**。
        const kind = statusKind(status);
        const clientError = Number.isFinite(status) && status >= 400 && status < 500
          && kind !== 'auth' && kind !== 'rate_limit';
        throw apiError(kind, {
          status: Number.isFinite(status) ? status : 0,
          ...(clientError ? { retryable: false } : {}),
        });
      }

      let data;
      try {
        data = await response.json();
      } catch {
        throw gate.timedOut ? apiError('timeout') : apiError('parse');
      }
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.answers)) {
        throw apiError('parse');
      }
      return {
        model: typeof data.model === 'string' && data.model ? data.model : requestModel,
        answers: data.answers,
        usage: normalizeUsage(data.usage),
      };
    } finally {
      gate.cleanup();
    }
  }

  async function health(request = {}) {
    const cfg = settings();
    const doFetch = resolveFetch();
    const base = normalizeBaseUrl(cfg.baseUrl);
    const started = Date.now();
    if (!doFetch || !base) {
      return { ok: false, ms: 0, detail: errorInfo('network').message };
    }
    const url = `${base}${normalizePath(cfg.healthPath, DEFAULT_CONFIG.healthPath)}`;
    const gate = createAbortGate(request.signal, pickTimeout(request.timeoutMs, null, {
      ...cfg,
      quickTimeoutMs: HEALTH_TIMEOUT_MS,
      timeoutMs: HEALTH_TIMEOUT_MS,
    }));
    try {
      const response = await doFetch(url, { method: 'GET', signal: gate.signal });
      const ms = Date.now() - started;
      const status = Number(response && response.status);
      const ok = response && typeof response.ok === 'boolean'
        ? response.ok
        : Number.isFinite(status) && status >= 200 && status < 300;
      return { ok: !!ok, ms, detail: Number.isFinite(status) ? `HTTP ${status}` : 'HTTP ?' };
    } catch (err) {
      const ms = Date.now() - started;
      const kind = gate.timedOut ? 'timeout' : classifyError(err).kind;
      return { ok: false, ms, detail: errorInfo(kind).message };
    } finally {
      gate.cleanup();
    }
  }

  /**
   * SPEC §3.9b/§3.10 · 多模态通道：走 visionBaseUrl 的 OpenAI 兼容 `/chat/completions`。
   *
   * 为什么单独一条通道而不是复用 ask()：ask() 面对的是决策模型（Laya/JEv），它的
   * questions/answers 是数组式 JSON；而"看图"这件事的行业事实标准是 OpenAI 的
   * chat/completions（system + user[text, image_url]）。把两者混成一条通道会逼着用户
   * 去写一个把 chat 协议翻译成决策协议的中间件——那正是我们想避免的负担。
   *
   * 返回值统一成 {model, answers:[{id,type:'text',content,confidence}], usage}，
   * 因此 vision.js / reviewSystem.js 不需要知道底下是哪家 API。
   */
  async function visionOnce(request = {}) {
    const cfg = settings();
    const doFetch = resolveFetch();
    const base = normalizeBaseUrl(cfg.visionBaseUrl);
    if (!doFetch) throw apiError('network');
    if (!base) throw apiError('vision_unconfigured');

    const { messages, images, timeoutMs, signal, model } = request;
    const requestModel = typeof model === 'string' && model ? model : cfg.visionModel;
    if (!requestModel) throw apiError('vision_unconfigured');

    const content = buildVisionContent(request.content, images);
    const payload = {
      model: requestModel,
      messages: Array.isArray(messages) && messages.length
        ? messages
        : [
            { role: 'system', content: request.system || '' },
            { role: 'user', content },
          ],
      temperature: Number.isFinite(request.temperature) ? request.temperature : 0.2,
      // 推理模型（deepseek-flash / v4-pro 这类）会先消耗 reasoning_tokens，
      // max_tokens 给小了会出现「HTTP 200 但 content 是空串」——看起来像模型没回答，
      // 实际是推理把预算吃光了。所以预算必须给足，且不能依赖服务端默认值。
      max_tokens: Number.isFinite(request.maxTokens) ? request.maxTokens : cfg.visionMaxTokens,
    };

    const headers = { 'Content-Type': 'application/json' };
    const key = typeof cfg.visionApiKey === 'string' ? cfg.visionApiKey.trim() : '';
    if (key) headers.Authorization = `Bearer ${key}`;

    const url = `${base}/chat/completions`;
    const gate = createAbortGate(
      signal,
      Number.isFinite(timeoutMs) ? timeoutMs : cfg.visionTimeoutMs,
    );
    try {
      let response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: gate.signal,
        });
      } catch (err) {
        throw normalizeFailure(err, gate);
      }
      const status = Number(response && response.status);
      const ok = response && typeof response.ok === 'boolean'
        ? response.ok
        : Number.isFinite(status) && status >= 200 && status < 300;
      if (!ok) throw apiError(statusKind(status), { status: Number.isFinite(status) ? status : 0 });

      let data;
      try {
        data = await response.json();
      } catch {
        throw gate.timedOut ? apiError('timeout') : apiError('parse');
      }
      const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
      const text = choice && choice.message && typeof choice.message.content === 'string'
        ? choice.message.content
        : '';
      if (!text) throw apiError('parse');
      const usage = (data && data.usage) || {};
      return {
        model: (data && typeof data.model === 'string' && data.model) || requestModel,
        answers: [{ id: request.answerId || 'vision', type: 'text', content: text, confidence: 0.8 }],
        usage: {
          prompt_tokens: toTokenCount(usage.prompt_tokens),
          completion_tokens: toTokenCount(usage.completion_tokens),
          total_tokens: toTokenCount(usage.total_tokens),
        },
      };
    } finally {
      gate.cleanup();
    }
  }

  /** vision 通道同样按 §5.1 自动重投 1 次（可重试错误）。 */
  async function vision(request = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= AUTO_RETRY_MAX; attempt += 1) {
      try {
        return await visionOnce(request);
      } catch (err) {
        lastError = err;
        const retryable = err && err.retryable === true && err.kind !== 'cancelled';
        if (!retryable || attempt === AUTO_RETRY_MAX) throw err;
        if (request.signal && request.signal.aborted) throw apiError('cancelled');
        const delay = Number.isFinite(err.retryDelayMs) ? err.retryDelayMs : AUTO_RETRY_DELAY_MS;
        await sleep(delay, request.signal);
        if (request.signal && request.signal.aborted) throw apiError('cancelled');
      }
    }
    throw lastError || apiError('server');
  }

  /**
   * SPEC §3.11 v1.6 · 批处理：一次请求给多套打分。
   *
   * 请求形状（App 契约）：`POST {baseUrl}{askPath}/batch` `{model, looks:[{lookId, state, questions}]}`
   * 响应：`{model, looks:[{lookId, model, answers, usage}], usage}`
   *
   * 为什么值得单独一条通道：Laya 侧 `/v1/systemone/batch` 会在**单次 forward pass** 内
   * collate 多行，省掉 N-1 次 HTTP 往返与调度。实测本机 CPU 上加速比约 1.07x
   * （瓶颈是算力不是往返），但批处理**不改变分数**，所以在 GPU / 多并发下是净收益。
   *
   * 失败语义：整批失败按普通错误抛出；调用方负责回退到逐条并行（见 scoreSystem）。
   */
  async function askBatch(request = {}) {
    const cfg = settings();
    const doFetch = resolveFetch();
    const base = normalizeBaseUrl(cfg.baseUrl);
    if (!doFetch || !base) throw apiError('network');

    const { looks, timeoutMs, signal, model } = request;
    const list = Array.isArray(looks) ? looks : [];
    if (!list.length) throw apiError('invalid_input');
    const requestModel = typeof model === 'string' && model ? model : cfg.model;
    const body = {
      model: requestModel,
      looks: list.map((item) => ({
        lookId: item.lookId,
        state: item.state ?? '',
        questions: item.questions,
      })),
    };

    const headers = { 'Content-Type': 'application/json' };
    if (cfg.mode === 'jev') {
      const key = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
      if (key) headers.Authorization = `Bearer ${key}`;
    }

    const url = `${base}${batchPathOf(cfg)}`;
    const gate = createAbortGate(signal, Number.isFinite(timeoutMs) ? timeoutMs : cfg.quickTimeoutMs);
    try {
      let response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: gate.signal,
        });
      } catch (err) {
        throw normalizeFailure(err, gate);
      }
      const status = Number(response && response.status);
      const ok = response && typeof response.ok === 'boolean'
        ? response.ok
        : Number.isFinite(status) && status >= 200 && status < 300;
      if (!ok) throw apiError(statusKind(status), { status: Number.isFinite(status) ? status : 0 });

      let data;
      try {
        data = await response.json();
      } catch {
        throw gate.timedOut ? apiError('timeout') : apiError('parse');
      }
      if (!data || !Array.isArray(data.looks) || !data.looks.length) throw apiError('parse');
      return {
        model: typeof data.model === 'string' && data.model ? data.model : requestModel,
        looks: data.looks,
        usage: normalizeUsage(data.usage),
      };
    } finally {
      gate.cleanup();
    }
  }

  /**
   * 多模态通道是否可用（SPEC §3.9c）。
   * vision.js 用它决定 describe 走哪条通道：配了就走 vision 看原图，没配就退回决策模型的
   * JEv `/ask`。没有这个判断，"只配了本地决策模型"的部署会在第一步就整体失败。
   * 注意：必须在 makeApi 闭包内定义，才能读到 settings()。
   */
  function visionConfigured() {
    const cfg = settings();
    return !!(normalizeBaseUrl(cfg.visionBaseUrl) && cfg.visionModel);
  }

  /** 决策模型（打分）是否已配置：baseUrl 是唯一必需项。 */
  function decisionConfigured() {
    return !!normalizeBaseUrl(settings().baseUrl);
  }

  return { ask, askBatch, health, vision, visionConfigured, decisionConfigured };
}

/** 批处理路径：在 askPath 后加 /batch（askPath='/ask' → '/ask/batch'）。 */
function batchPathOf(cfg) {
  const ask = normalizePath(cfg.askPath, DEFAULT_CONFIG.askPath);
  return `${ask.replace(/\/+$/, '')}/batch`;
}

/** 把文本 + 图片组装成 OpenAI 多模态 content 数组（无图时退化为纯文本，兼容纯文本端点）。 */
function buildVisionContent(text, images) {
  const list = normalizeImages(images);
  const body = typeof text === 'string' ? text : '';
  if (!list.length) return body;
  return [
    { type: 'text', text: body },
    ...list.map((image) => ({ type: 'image_url', image_url: { url: image.dataUri } })),
  ];
}

function toTokenCount(value) {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** SPEC §3.10 · 统一错误分类 → {kind, message, action, retryable}（message 只来自 copy，绝不回显原始错误）。 */
export function classifyError(err) {
  const kind = detectKind(err);
  const info = errorInfo(kind);
  return {
    kind,
    message: info.message,
    action: info.action,
    retryable: info.retryable === true,
  };
}

/** SPEC §3.10 · 去掉 apiKey 的副本（写日志 / 报告 / probe 前必须过这一层）。 */
export function redactConfig(config) {
  const source = config && typeof config === 'object' ? config : {};
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey : '';
  return { ...source, apiKey: apiKey ? REDACTED_API_KEY : '' };
}

function detectKind(err) {
  if (!err || typeof err !== 'object') return 'server';
  if (typeof err.kind === 'string' && ERROR_KINDS.includes(err.kind)) return err.kind;

  const status = Number(err.status ?? err.statusCode ?? (err.response && err.response.status));
  if (Number.isFinite(status) && status > 0) return statusKind(status);

  const code = typeof err.code === 'string' ? err.code : '';
  if (NETWORK_CODES.includes(code)) return 'network';

  const name = typeof err.name === 'string' ? err.name : '';
  if (name === 'AbortError') return 'cancelled';
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'SyntaxError') return 'parse';
  if (name === 'TypeError') return 'network';

  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  if (message.includes('fetch failed') || message.includes('socket') || message.includes('network')) return 'network';
  if (message.includes('json') || message.includes('unexpected token')) return 'parse';
  if (message.includes('timed out') || message.includes('timeout')) return 'timeout';
  return 'server';
}

function statusKind(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'server';
}

/** SPEC §5.1 的错误分类；`extra.retryable` 可用于按具体状态码收紧重试（如 400/404 不重试）。 */
function apiError(kind, extra = {}) {
  return errorFor(kind, extra);
}

function normalizeFailure(err, gate) {
  if (err && typeof err === 'object' && typeof err.kind === 'string' && ERROR_KINDS.includes(err.kind)) {
    return err;
  }
  if (gate.timedOut) return apiError('timeout');
  if (gate.callerAborted) return apiError('cancelled');
  return apiError(classifyError(err).kind);
}

function normalizePath(path, fallback) {
  const value = typeof path === 'string' && path.trim() ? path.trim() : fallback;
  return value.startsWith('/') ? value : `/${value}`;
}

/**
 * 超时预算：显式 timeoutMs 优先；否则按问题语义选——
 * 含 deep_report（System Two）→ cfg.timeoutMs；其余（System One describe/score）→ cfg.quickTimeoutMs。
 */
function pickTimeout(timeoutMs, questions, cfg) {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs;
  const isDeep = Array.isArray(questions)
    && questions.some((question) => question && question.id === 'deep_report');
  const preferred = isDeep ? cfg.timeoutMs : cfg.quickTimeoutMs;
  if (typeof preferred === 'number' && Number.isFinite(preferred) && preferred > 0) return preferred;
  return DEFAULT_CONFIG.timeoutMs;
}

function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((image) => image && typeof image === 'object')
    .map((image) => {
      const id = typeof image.id === 'string' && image.id
        ? image.id
        : (typeof image.lookId === 'string' ? image.lookId : '');
      let dataUri = typeof image.dataUri === 'string' ? image.dataUri : '';
      if (!dataUri && typeof image.base64 === 'string' && image.base64) {
        dataUri = `data:${image.mime || 'image/jpeg'};base64,${image.base64}`;
      }
      return { id, dataUri };
    })
    .filter((image) => image.id && image.dataUri);
}

function normalizeUsage(usage) {
  const source = usage && typeof usage === 'object' ? usage : {};
  const prompt = toCount(source.prompt_tokens);
  const completion = toCount(source.completion_tokens);
  const total = toCount(source.total_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion,
  };
}

function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 可被 AbortSignal 打断的退避等待（取消时立即返回，不阻塞调用方）。 */
function sleep(ms, signal) {
  const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (!delay) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delay);
    function finish() {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', finish);
      }
      resolve();
    }
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener('abort', finish, { once: true });
    }
  });
}

function createAbortGate(signal, timeoutMs) {
  const controller = new AbortController();
  const gate = {
    signal: controller.signal,
    timedOut: false,
    callerAborted: false,
    cleanup,
  };
  let timer = null;
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      gate.timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  const onAbort = () => {
    gate.callerAborted = true;
    controller.abort();
  };
  if (signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort);
  }
  function cleanup() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort);
    }
  }
  return gate;
}
