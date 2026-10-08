// SPEC §3.10 · 网络层：JEv 云端 / Laya 局域网双模式适配，统一 JSON 契约与错误分类。
// 铁律：API Key 绝不进入异常 message、日志、window.__OD_PROBE__ 或验证报告（用 redactConfig 过一层）。
//
// 超时选型（v1.2 修正）：**不再用"有没有 images"区分**——SPEC §3.7 修正后 System One 的 describe
// 也会带图。改用语义判据：questions 里出现 id='deep_report' → System Two，用 timeoutMs；
// 其余（describe_* / 6 个 score 维度）→ System One，用 quickTimeoutMs；显式传 timeoutMs 优先。

import { buildRequest } from '../core/protocol.js';
import { JEV_ASK_PATH, fromJevAnswers, resolveJevModel, resolveProtocol, toJevRequest } from '../core/jev.js';
import { ERRORS, ERROR_KINDS, errorFor, errorInfo } from '../data/copy.js';

/** SPEC §5.1「重试」列的全局上限：可重试错误自动重投 1 次（退避默认 600ms，rate_limit 用文案里的 2s）。 */
const AUTO_RETRY_MAX = 1;
const AUTO_RETRY_DELAY_MS = 600;

export const DEFAULT_CONFIG = {
  /**
   * 上游是哪一家（决定出站是否带 API Key）。
   * 必须与默认 baseUrl 一致：默认 baseUrl 是**本机适配器**，所以默认也是 `laya`。
   * 之前默认写成 `jev` 而 baseUrl 指向本机 —— 两者矛盾（§3.10b 的一致性检查会报出来）。
   */
  mode: 'laya',
  /**
   * SPEC §3.9c 三档引擎模式。
   *
   * 默认 **`multimodal_only`**（v1.7 变更，原为 `laya_review`）：Laya 实测单独排序
   * 接近掷硬币（2/4），它保留在环里只有配了多模态纠正才有用（4/4）。
   * 既然它的价值必须靠另一个模型兑现，就不该让"跑一个本地服务"成为默认前提 ——
   * 两个 Laya 档位降级为**可选实验**，需要用户显式选择。
   */
  engineMode: 'multimodal_only',
  // 多模态端点与决策模型**分开配置**：laya_review 下「谁看图」和「谁打分」是两个不同的服务。
  visionBaseUrl: '',
  visionModel: '',
  visionApiKey: '',
  // 深度分析实测 15–37 秒（多图更久），原 60s 余量偏紧；放宽避免把"慢"误报成超时。
  visionTimeoutMs: 120000,
  // 视觉模型是否已配在**服务端**（如本机 Laya 适配器用自己的 .env.local 配好）。
  // 只影响设置页的配置闸门顺序，不改变运行时行为。
  visionServerSide: false,
  // 用户显式选择「仍然配置决策模型」（绕过 §3.11c 的视觉先行闸门）。
  // 存在的理由：视觉端点本身出问题时，必须还能配一个可用的决策模型，否则 App 变砖。
  decisionUnlocked: false,
  // 推理模型的输出预算。太小 → reasoning 吃光 → content 空串（HTTP 200），
  // 会被误判成 parse 失败。实测 deepseek-flash 在 4000 时约 1/4 的深度分析
  // 返回空串，提到 8000 后 5/5 通过（见 tools 里的诊断脚本）。
  // 深度分析要输出 ranking+details(每套5维)+conclusion，本身就比纠正更长。
  visionMaxTokens: 8000,
  /**
   * SPEC §3.10d · **故意为空**。
   *
   * 以前默认 `http://127.0.0.1:8787`（本机适配器）—— 对真实手机是**错的地址**
   * （指手机自己），而且电脑的局域网 IP 还会随路由器变化，写死只会误导用户。
   * 空值让界面必须明确要求用户填（`providerMismatch` 会提示）；宁可空着，也不要给错的。
   * 演示/门禁由 `tools/verify.mjs` **显式注入**地址，注入失败会大声失败而不是回落到这里。
   */
  baseUrl: '',
  askPath: '/ask',
  healthPath: '/health',
  model: 'outfit-judge-v1',
  /**
   * SPEC §3.10b · 上游协议。
   *   'auto'    —— 按 baseUrl 主机名判断（api.typesafe.ai → jev），默认值
   *   'jev'     —— 强制 TypeSafe JEv 原生协议（questions 用 map、model 用 jev-latest）
   *   'generic' —— 强制 App 原生数组协议（本机适配器 / 自建对端）
   * 直连 JEv 时必须走 jev，否则数组式 questions 会被对端拒绝。
   */
  protocol: 'auto',
  apiKey: '',
  /**
   * SPEC §3.12 · 中转模式（可选）。
   *
   * 动机：默认形态要求用户自己拿两把上游 Key（决策模型 + 多模态模型），
   * 对非技术用户等于不可用。中转模式下，两把 Key 由**中转服务**持有，
   * App 只填「地址 + 一个口令」。
   *
   * `relayToken` 只存本机，绝不写进代码/日志/验证报告（与 apiKey 同等待遇）。
   */
  relayToken: '',
  // 深度分析走 decision 通道（visionServerSide 形态），所以这条超时必须够长：
  // 实测 15–37s，且 reasoning 预算提高后偏慢的一侧更常见。
  timeoutMs: 120000,
  quickTimeoutMs: 20000,
};

/** SPEC §3.9c 合法取值（UI 与校验共用，避免两处硬编码漂移）。 */
export const ENGINE_MODES = ['laya_only', 'laya_review', 'multimodal_only'];

/**
 * 需要用户自备本地 Laya 服务的档位（**实验性**）。
 * 实测：`laya_only` 单独排序 2/4 接近掷硬币；`laya_review` 4/4 但收益来自多模态纠正，
 * 代价是必须常驻一个本地服务。所以默认不使用它们，界面上如实标注"实验性"。
 */
export const EXPERIMENTAL_ENGINE_MODES = ['laya_only', 'laya_review'];

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

    /**
     * SPEC §3.10b · 直连 TypeSafe JEv 时用它的原生协议。
     *
     * 为什么不"只填个地址就行"：App 侧发的是 `questions` **数组**，
     * 而 JEv 文档要求 **map**（id → {type,instructions,criteria}）—— 形状不同，必须转换。
     * 经本机适配器时由适配器转；直连时由这里转（共用 src/core/jev.js 的同一套定义）。
     */
    const protocol = resolveProtocol(base, cfg.protocol);
    const isJev = protocol === 'jev';
    /**
     * 模型名：直连 JEv 时把"已知的非 JEv 名字"（本机 laya / 通用默认占位）换成官方别名
     * jev-latest —— 老版本把 `model` 持久化过，切过来会把旧名字一直带过去，必然 400。
     * 用户自己填的其它名字一律尊重，不猜。
     */
    const effectiveModel = isJev && !model
      ? resolveJevModel(cfg.model)
      : requestModel;
    const body = isJev
      ? toJevRequest({ state: state ?? '', model: effectiveModel, questions })
      : buildRequest({ model: effectiveModel, state: state ?? '', questions });
    // JEv 不做文本生成、也不接受图片：带上 images 只会让对端困惑（§3.9b 已在上层拦住）
    if (!isJev) {
      const imageList = normalizeImages(images);
      if (imageList.length) body.images = imageList;
    }

    const headers = { 'Content-Type': 'application/json' };
    /**
     * 鉴权优先级（§3.12）：**中转口令优先**，其次才是直连上游的 Key。
     *
     * 中转模式下上游的两把 Key 在服务端，App 手里只有口令 —— 两者不该同时出现，
     * 但万一用户从直连切到中转、旧 Key 还留在配置里，必须让口令胜出，
     * 否则会把上游 Key 当成口令发给中转（既认证失败，又平白泄漏了一把 Key）。
     */
    const relayToken = typeof cfg.relayToken === 'string' ? cfg.relayToken.trim() : '';
    if (relayToken) {
      headers.Authorization = `Bearer ${relayToken}`;
    } else if (isJev || cfg.mode === 'jev') {
      // JEv 必须带 Bearer Key；generic 沿用原口径（mode==='jev' 时带上配置的 Key）
      const key = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
      if (key) headers.Authorization = `Bearer ${key}`;
    }

    /**
     * 端点路径：用户**显式改过** askPath 就以他为准；仍是默认值时才按协议取默认
     * （JEv → /systemone，generic → /ask）。否则直连 JEv 会打到 /ask 上（实测踩过）。
     */
    const askPathCustomized = typeof cfg.askPath === 'string'
      && cfg.askPath.trim()
      && cfg.askPath.trim() !== DEFAULT_CONFIG.askPath;
    const defaultAsk = isJev ? JEV_ASK_PATH : DEFAULT_CONFIG.askPath;
    const url = `${base}${normalizePath(askPathCustomized ? cfg.askPath : defaultAsk, defaultAsk)}`;
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
        // 重投一次也只会得到同样结果，只会让用户多等，因此**禁止重试**。
        const kind = statusKind(status);
        const clientError = Number.isFinite(status) && status >= 400 && status < 500
          && kind !== 'auth' && kind !== 'rate_limit';
        // 把对端自己给的原因读出来（读不到就算了），否则用户只看到笼统文案
        let detail = '';
        try {
          if (response && typeof response.text === 'function') detail = upstreamDetailFrom(await response.text());
        } catch {
          detail = '';
        }
        throw apiError(kind, {
          status: Number.isFinite(status) ? status : 0,
          ...(clientError || kind === 'endpoint_rejected' ? { retryable: false } : {}),
          ...(detail ? { upstreamDetail: detail } : {}),
        });
      }

      let data;
      try {
        data = await response.json();
      } catch {
        throw gate.timedOut ? apiError('timeout') : apiError('parse');
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw apiError('parse');

      /**
       * JEv 的 `answers` 是 **map**（文档：每个 question id 一个答案），
       * 而 App 全链路用的是数组。这里把 map 归一化成数组，
       * 让上层（scoreSystem / deepSystem / reviewSystem）完全不必知道对端是谁。
       */
      const answers = isJev
        ? fromJevAnswers(data.answers)
        : data.answers;
      if (!Array.isArray(answers)) throw apiError('parse');
      // JEv 若返回空 answers，说明一个问题都没被回答 —— 明确报 parse 而不是"成功但没分"
      if (isJev && !answers.length) throw apiError('parse');
      return {
        model: typeof data.model === 'string' && data.model ? data.model : requestModel,
        answers,
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
    const isJev = resolveProtocol(base, cfg.protocol) === 'jev';
    /**
     * JEv 没有公开的 health 端点（文档只有 POST /v1/systemone）。
     * 所以退一步：探 systemone 端点，并把 **401/403 视为"可达且服务活着"**。
     * 没带 Key 时把鉴权需求报成"服务挂了"是假警报 —— 直连用户本来就可能在配好 Key 前先探一次。
     */
    const url = isJev
      ? `${base}${JEV_ASK_PATH}`
      : `${base}${normalizePath(cfg.healthPath, DEFAULT_CONFIG.healthPath)}`;
    const gate = createAbortGate(request.signal, pickTimeout(request.timeoutMs, null, {
      ...cfg,
      quickTimeoutMs: HEALTH_TIMEOUT_MS,
      timeoutMs: HEALTH_TIMEOUT_MS,
    }));
    try {
      const response = await doFetch(url, { method: isJev ? 'POST' : 'GET', signal: gate.signal });
      const ms = Date.now() - started;
      const status = Number(response && response.status);
      const httpOk = response && typeof response.ok === 'boolean'
        ? response.ok
        : Number.isFinite(status) && status >= 200 && status < 300;
      const authRequired = isJev && (status === 401 || status === 403);
      const ok = !!httpOk || authRequired;
      const detail = authRequired
        ? `HTTP ${status}（可达，需要 API Key）`
        : (Number.isFinite(status) ? `HTTP ${status}` : 'HTTP ?');
      return { ok, ms, detail, authRequired: authRequired || undefined };
    } catch (err) {
      const ms = Date.now() - started;
      const kind = gate.timedOut ? 'timeout' : classifyError(err).kind;
      return { ok: false, ms, detail: errorInfo(kind).message };
    } finally {
      gate.cleanup();
    }
  }

  /**
   * SPEC §5.5 · 决策端点是否**真的能干活**（不只是"HTTP 200"）。
   *
   * 为什么需要它：本机适配器在上游（Laya）挂掉时**仍然返回 HTTP 200**，只是响应体里写着
   * `{"ok":true,"upstream":{"ok":false,"detail":"fetch failed"}}`。
   * 只看状态码会得出"服务正常"的假结论，然后整轮打分全部失败、报错还是一堆看不懂的
   * network/server —— 用户测得出来"连不上"却不知道为什么（实测踩过）。
   *
   * 因此这里在健康探测之外，**额外读一次响应体里的 upstream 字段**：
   *   - 端点不可达 / 非 2xx            → ok:false, kind:'endpoint'
   *   - 200 但 body 明说 upstream 挂了  → ok:false, kind:'upstream'
   *   - 200 且没有 upstream 字段        → ok:true（云端端点/旧对端不带这个字段，属正常）
   *
   * 绝不因为探测本身失败就阻断用户的正常流程之外的判断：调用方决定怎么用。
   */
  async function diagnoseDecisionEndpoint(request = {}) {
    const cfg = settings();
    const doFetch = resolveFetch();
    const base = normalizeBaseUrl(cfg.baseUrl);
    if (!doFetch || !base) {
      return { ok: false, kind: 'endpoint', detail: 'baseUrl 未配置' };
    }
    const isJev = resolveProtocol(base, cfg.protocol) === 'jev';
    const url = isJev
      ? `${base}${JEV_ASK_PATH}`
      : `${base}${normalizePath(cfg.healthPath, DEFAULT_CONFIG.healthPath)}`;
    const gate = createAbortGate(request.signal, pickTimeout(request.timeoutMs, null, {
      ...cfg,
      quickTimeoutMs: HEALTH_TIMEOUT_MS,
      timeoutMs: HEALTH_TIMEOUT_MS,
    }));
    try {
      const response = await doFetch(url, { method: isJev ? 'POST' : 'GET', signal: gate.signal });
      const status = Number(response && response.status);
      const httpOk = response && typeof response.ok === 'boolean'
        ? response.ok
        : Number.isFinite(status) && status >= 200 && status < 300;
      /**
       * JEv 没有 Key 时返回 401/403 —— 那证明**主机可达、端点正确**，
       * 只差一个 Key。把它当成"连不上"会误报（实测：用户在设置页刚点完预设、
       * 还没保存 Key 时，整条打分链会被前置检查直接拦掉，而且文案指向错误的排查方向）。
       */
      if (isJev && (status === 401 || status === 403)) {
        return {
          ok: true,
          kind: 'ok',
          detail: `HTTP ${status}（端点可达，需要 API Key）`,
          authRequired: true,
        };
      }
      if (!httpOk) {
        return { ok: false, kind: 'endpoint', detail: `HTTP ${Number.isFinite(status) ? status : '?'}` };
      }
      // 读 body 只为看 upstream（本机适配器会明说上游挂了）；读不出来不影响"端点是活的"
      let body = null;
      try {
        if (response && typeof response.json === 'function') body = await response.json();
      } catch {
        body = null;
      }
      const upstream = body && typeof body === 'object' ? body.upstream : null;
      if (upstream && upstream.ok === false) {
        return {
          ok: false,
          kind: 'upstream',
          detail: String(upstream.detail || 'upstream not reachable'),
        };
      }
      return { ok: true, kind: 'ok', detail: 'ok' };
    } catch (err) {
      const kind = gate.timedOut ? 'timeout' : classifyError(err).kind;
      return { ok: false, kind: 'endpoint', detail: errorInfo(kind).message };
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
      if (!ok) await throwForBadStatus(response, status);

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
    // 与 askOnce 同口径：中转口令优先（§3.12）
    const batchRelayToken = typeof cfg.relayToken === 'string' ? cfg.relayToken.trim() : '';
    if (batchRelayToken) {
      headers.Authorization = `Bearer ${batchRelayToken}`;
    } else if (cfg.mode === 'jev') {
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
      if (!ok) {
        // SPEC §5.1 的 server 行专指 5xx。其余非 401/403/429 的 4xx（400 参数错、404 路径错…）
        // 重投一次也只会得到同样结果，只会让用户多等，因此借用文案但**禁止重试**。
        const kind = statusKind(status);
        const clientError = Number.isFinite(status) && status >= 400 && status < 500
          && kind !== 'auth' && kind !== 'rate_limit';
        let detail = '';
        try {
          if (response && typeof response.text === 'function') detail = upstreamDetailFrom(await response.text());
        } catch {
          detail = '';
        }
        throw apiError(kind, {
          status: Number.isFinite(status) ? status : 0,
          ...(clientError || kind === 'endpoint_rejected' ? { retryable: false } : {}),
          ...(detail ? { upstreamDetail: detail } : {}),
        });
      }

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
   * App 侧是否**自己**配了多模态端点（visionBaseUrl + visionModel 都非空）。
   *
   * 语义边界很重要，别和下面的 visionReady 混：
   *   - 本函数只回答"App 能不能自己直接发起 image_url 请求" → 决定 describe/纠正**走哪条通道**。
   *   - 服务端形态（visionServerSide）下 App 没有自己的端点，所以这里是 false，
   *     describe/纠正会经决策通道发给适配器，由适配器在服务端看图。
   */
  function visionEndpointConfigured() {
    const cfg = settings();
    return !!(normalizeBaseUrl(cfg.visionBaseUrl) && cfg.visionModel);
  }

  /**
   * 纠正是否**可能生效**：App 自带端点，**或**视觉配置在服务端（`visionServerSide`）。
   *
   * 这个判据供"设置页闸门"与"要不要尝试纠正"使用，**不要**拿它去决定走哪条通道——
   * 服务端形态下它的值为 true，但 App 并没有可直接调用的 vision 端点。
   * （这两个语义被混用一次，就造成了"设置页解锁、describe 却抛 vision_unconfigured"的分裂。）
   */
  function visionReady() {
    const cfg = settings();
    if (cfg.visionServerSide === true) return true;
    return visionEndpointConfigured();
  }

  /** 决策模型（打分）是否已配置：baseUrl 是唯一必需项。 */
  function decisionConfigured() {
    return !!normalizeBaseUrl(settings().baseUrl);
  }

  /**
   * 当前决策端点是不是**直连 TypeSafe JEv**（§3.10b）。
   * vision.js 用它判断"能不能指望决策端点产出文字描述"：JEv 不做文本生成，
   * 所以直连且没有视觉端点时必须明确报 vision_unconfigured，而不是静默降级。
   */
  function isJevDirect() {
    const cfg = settings();
    return resolveProtocol(normalizeBaseUrl(cfg.baseUrl), cfg.protocol) === 'jev';
  }

  return {
    ask,
    askBatch,
    health,
    diagnoseDecisionEndpoint,
    vision,
    visionConfigured: visionEndpointConfigured,
    visionEndpointConfigured,
    visionReady,
    decisionConfigured,
    isJevDirect,
  };
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
  /**
   * 对端给了具体原因时，把它附在文案后面 —— 否则用户只看到「决策模型服务出错了」，
   * 无法判断到底是 Key 错、模型名不存在还是路径写错（实测踩过）。
   * 只附一行、且上游详情已在 upstreamDetailFrom 里脱敏（sk-***）。
   */
  const detail = typeof err?.upstreamDetail === 'string' ? err.upstreamDetail.trim() : '';
  const message = detail ? `${info.message}（对端说：${detail}）` : info.message;
  return {
    kind,
    message,
    action: info.action,
    retryable: info.retryable === true,
  };
}

/**
 * SPEC §3.10 · 去掉密钥副本（写日志 / 报告 / probe 前必须过这一层）。
 *
 * `relayToken` 与 `apiKey`、`visionApiKey` **同等对待**：它们都是"泄漏即被白嫖/被盗用"的凭据。
 * §3.12 的中转口令尤其危险 —— 拿到它就能用我们的上游额度。
 */
export function redactConfig(config) {
  const source = config && typeof config === 'object' ? config : {};
  const out = { ...source };
  for (const field of ['apiKey', 'visionApiKey', 'relayToken']) {
    const value = typeof source[field] === 'string' ? source[field] : '';
    out[field] = value ? REDACTED_API_KEY : '';
  }
  return out;
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
  // 其余 4xx：是"我们的请求不对"（Key 权限、模型名不存在、路径错、参数错），
  // 不是服务端故障。归成 server 会把用户引向错误的排查方向（实测踩过）。
  if (status >= 400 && status < 500) return 'endpoint_rejected';
  return 'server';
}

/**
 * 从对端的错误响应里抠出**它自己给的原因**，用来替换/补充笼统文案。
 *
 * 为什么重要：HTTP 非 2xx 时对端通常会在 body 里说清楚原因
 * （如 `{"error":{"message":"Invalid API key"}}`、`{"message":"model not found"}`）。
 * 以前这些全被丢掉，用户只看到「决策模型服务出错了，请稍后再试」，
 * 查日志也无从下手 —— 实测：JEv 的 403 就因此被显示成"决策模型服务出错"。
 *
 * 只取一小段纯文本，绝不回显 Key；读不出来就返回空串。
 */
function upstreamDetailFrom(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return '';
  let msg = '';
  try {
    const parsed = JSON.parse(raw);
    msg = (parsed && parsed.error && (parsed.error.message || parsed.error.detail))
      || (parsed && (parsed.message || parsed.detail || parsed.error))
      || '';
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
  } catch {
    msg = raw;
  }
  msg = String(msg).replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***').replace(/\s+/g, ' ').trim();
  return msg.slice(0, 160);
}

/**
 * 非 2xx → 抛出带对端原因的错误。
 * 两条通道（决策模型 / 多模态端点）共用，保证错误信息口径一致：
 * 都带 `status`，并在能读出对端说明时附上 `upstreamDetail`。
 */
async function throwForBadStatus(response, status) {
  let detail = '';
  try {
    if (response && typeof response.text === 'function') detail = upstreamDetailFrom(await response.text());
  } catch {
    detail = '';
  }
  throw apiError(statusKind(status), {
    status: Number.isFinite(status) ? status : 0,
    ...(detail ? { upstreamDetail: detail } : {}),
  });
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
