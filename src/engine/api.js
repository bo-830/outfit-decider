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
  baseUrl: 'http://127.0.0.1:8787',
  askPath: '/ask',
  healthPath: '/health',
  model: 'outfit-judge-v1',
  apiKey: '',
  timeoutMs: 45000,
  quickTimeoutMs: 20000,
};

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
      if (!ok) throw apiError(statusKind(status), { status: Number.isFinite(status) ? status : 0 });

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

  return { ask, health };
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
