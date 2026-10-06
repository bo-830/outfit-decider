#!/usr/bin/env node
/**
 * tools/laya-adapter.mjs — 出门穿什么 ⇄ laya-serve 之间的协议桥
 *
 * 为什么需要它
 * ------------
 * 本 App 的传输层（`src/engine/api.js` + `docs/SPEC.md` §1.3）实现的是一套**请求/响应用数组**的
 * 约定：请求 `{model, state, questions:[{id,type,question}], images?}`，响应
 * `{model, answers:[{id,type,score,content,confidence}], usage}`。
 *
 * 但真实的本地决策模型（`laya-serve`，即 SPEC 里的 "Laya 本地模式"，也正是 `laya.serve` 文档中
 * 自称的 “TypeSafe Jev /v1/systemone wire protocol”）用的是：
 *   请求  POST /v1/systemone  {model?, state, questions:{ <id>: {type, instructions, criteria} }}
 *   响应  {model, answers:{ <id>: {type:'score', score, probabilities, confidence, legend} }, usage:{input_tokens,output_tokens}}
 * 也就是：questions 是**以 id 为键的对象**、字段叫 `instructions`/`criteria`，answers 同样是对象，
 * 且 usage 的字段名不同。
 *
 * 与其去改 App 里已被 96 个单测与 12 条验收断言钉住的契约，不如在这里做一层**有测试保护的翻译**：
 * 对 App 而言这个适配器就是一个符合 SPEC §1.3 的 JEv/Laya 端点。
 *
 * 用法
 * ----
 *   node tools/laya-adapter.mjs                    # 默认监听 0.0.0.0:8787，转发到 http://127.0.0.1:8000
 *   node tools/laya-adapter.mjs --port 8787 --upstream http://127.0.0.1:8000
 *
 * 环境变量
 * --------
 *   LAYA_UPSTREAM       上游 laya-serve 地址（默认 http://127.0.0.1:8000）
 *   LAYA_ADAPTER_PORT   监听端口（默认 8787）
 *   LAYA_API_KEY        若上游设了 LAYA_API_KEY，这里填同一个值，适配器会带 Bearer 转发
 *   LAYA_MODEL          转发给上游的 model 字段（默认不传，交给 Laya 自己路由）
 *   VISION_BASE_URL     可选：OpenAI 兼容的多模态端点，用于把穿搭照片转成结构化文字描述
 *   VISION_API_KEY      可选：上面的鉴权
 *   VISION_MODEL        可选：模型名，例如 gpt-4o-mini / qwen-vl-max / deepseek-vl2
 *
 * 关于图片转文字
 * --------------
 * Laya 是**纯文本**决策模型（"No text generation, so nothing to parse and nothing to hallucinate"），
 * 它看不了照片。System One 的“图片→结构化文字描述”这一步是一次真正的多模态调用，属于用户要配的
 * **云端视觉模型**；本适配器在配置了 VISION_* 时替 App 完成这一步，未配置时返回
 * `invalid_input` 让 App 走既有的友好提示（「无法识别有效穿搭内容…」），不会假装成功。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 加载项目根的 `.env.local`（已 gitignore，绝不入库）。
 * 真实进程环境变量**优先**——这样部署时可以用环境变量覆盖文件里的值。
 * 没有这个加载器，就必须靠启动脚本export一堆变量，很容易出现
 * 「明明配了却说没配」的排查成本。
 */
function loadLocalEnv() {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const file = path.join(root, '.env.local');
    if (!fs.existsSync(file)) return {};
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

const LOCAL_ENV = loadLocalEnv();
const env = (name) => (process.env[name] !== undefined && process.env[name] !== ''
  ? process.env[name]
  : LOCAL_ENV[name]);

/** 项目根（用于读取 fixtures 兜底描述）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const UPSTREAM = (argValue('upstream', env('LAYA_UPSTREAM') || 'http://127.0.0.1:8000')).replace(/\/+$/, '');
const PORT = Number(argValue('port', env('LAYA_ADAPTER_PORT') || 8787));
const HOST = argValue('host', env('LAYA_ADAPTER_HOST') || '0.0.0.0');
const UPSTREAM_KEY = env('LAYA_API_KEY') || '';
const MODEL = env('LAYA_MODEL') || '';
const VISION_BASE_URL = (env('VISION_BASE_URL') || '').replace(/\/+$/, '');
const VISION_API_KEY = env('VISION_API_KEY') || '';
const VISION_MODEL = env('VISION_MODEL') || '';
const VISION_MAX_TOKENS = Number(env('VISION_MAX_TOKENS') || 4000);

const SCORE_MIN = 0;
const SCORE_MAX = 5;

/* ────────────────────────── 请求翻译 ────────────────────────── */

/**
 * 把 App 的 6 个评分维度翻成 Laya 的 `criteria`（有序档位列表，索引即分值）。
 *
 * 措辞是**实测调出来的**，不要随手改回「XX 是多少分」那种问法：
 * 同一条输入，问法换成面向人、面向场合的「适合不适合」，区分度从 0.36 提升到 1.59
 * （见 tools/laya-eval.mjs 的 GOOD/BAD/MID 对照）。原因是 Laya 是通用决策模型，
 * 抽象维度问句（「场景实用度是多少」）会给它过低的信息量，而「穿这套去面试得体吗」
 * 才是它被训练来回答的那类判断。
 */
export const SCORE_RUBRICS = {
  overall_score: ['完全不适合这个场合', '明显不太合适', '一般，凑合能穿', '比较得体', '很得体', '非常得体'],
  aesthetic_score: ['很不好看', '不太好看', '一般', '比较好看', '很好看', '非常好看'],
  scene_score: ['完全不适合这个场合', '不太适合这个场合', '基本适合这个场合', '比较适合这个场合', '很适合这个场合', '完全契合这个场合'],
  figure_score: ['很拖沓，比例不好', '略显拖沓', '一般', '比较利落', '很利落', '比例非常好'],
  style_score: ['风格很乱', '风格不够统一', '基本统一', '比较统一', '很统一', '风格非常统一'],
  practical_score: ['很不方便', '不太方便', '一般', '比较方便', '很方便', '非常方便省心'],
};

/**
 * 每个维度的问句模板。`{scene}` 会被替换成用户选中的场合文案（没有就退化为「日常出门」）。
 * 同样是实测结论：把场合写进问句里，模型才能做出场合相关的判断。
 */
export const SCORE_INSTRUCTIONS = {
  overall_score: '{scene}穿这一套，整体得体吗？',
  aesthetic_score: '这一套搭配看起来好看吗？',
  scene_score: '这一套适合穿着去{scene}吗？',
  figure_score: '这一套穿上身后，身形看起来利落、比例好吗？',
  style_score: '这一套的单品之间风格统一吗？',
  practical_score: '这一套{scene}穿着方便、省心吗？',
};

const SCORE_IDS = Object.keys(SCORE_RUBRICS);

/** 场合里的第一个（或唯一一个）选项，用于填进问句；没有场合就用中性说法。 */
export function sceneOf(stateText) {
  const match = String(stateText || '').match(/【我的场合】\s*([^\n]+)/);
  if (!match) return '日常出门';
  const first = match[1].split(/[、,，·]/)[0].trim();
  return first || '日常出门';
}

/** App 的 question 项 → Laya 的 {type, instructions, criteria}。 */
export function toLayaQuestion(item, context = {}) {
  const id = String(item && item.id ? item.id : '');
  const scene = context.scene || '日常出门';
  if (SCORE_IDS.includes(id)) {
    const template = SCORE_INSTRUCTIONS[id] || '{scene}穿这一套得体吗？';
    // App 传来的 question 文本作为补充上下文附在后面，保留用户自定义问题的信息
    const extra = String(item && item.question ? item.question : '').trim();
    const instructions = `${template.replace('{scene}', scene)}`.trim();
    return {
      type: 'score',
      instructions: extra && !instructions.includes(extra) ? `${instructions}（我的问题：${extra}）` : instructions,
      criteria: SCORE_RUBRICS[id],
    };
  }
  // 非评分项（图片描述、自填问题的文字回答）：Laya 不做文本生成，
  // 用三档 score 表达“能/不能/不确定”，由上层决定怎么用。
  return {
    type: 'score',
    instructions: String(item && item.question ? item.question : '').trim() || id,
    criteria: ['无法回答', '部分回答', '可以回答'],
  };
}

/** App 请求体 → Laya 请求体。 */
export function toLayaRequest(body) {
  const questions = {};
  const incoming = Array.isArray(body && body.questions) ? body.questions : [];
  const context = { scene: sceneOf(body && body.state) };
  for (const item of incoming) {
    if (!item || !item.id) continue;
    questions[String(item.id)] = toLayaQuestion(item, context);
  }
  const out = { state: body && body.state !== undefined ? body.state : '', questions };
  if (MODEL) out.model = MODEL;
  return out;
}

/** 判断这次请求是不是「图片转文字」（App 的 describe_* 约定）。 */
export function isDescribeRequest(items) {
  return Array.isArray(items)
    && items.length > 0
    && items.every((item) => item && String(item.id).startsWith('describe_'));
}

/**
 * 判断这次请求是不是**多模态纠正**（App 的 `review` 约定）。
 *
 * 为什么必须在这里识别：`visionServerSide` 形态下 App 没有自己的视觉端点，
 * 商家把纠正指令 + 图片经决策通道发过来。若适配器认不出它，
 * 就会把纠正请求当成"4 套 × 6 维打分"转发给 Laya，
 * 结果既拿不到纠正分数（App 侧表现为 reviewFailed=parse），又白烧一遍打分算力。
 * 实测就是踩了这个坑：3 组照片的纠正全部静默失败。
 */
export function isReviewRequest(items) {
  return Array.isArray(items)
    && items.length === 1
    && items[0]
    && String(items[0].id) === 'review';
}

/**
 * 判断这次请求是不是 **System Two 深度分析**（App 的 `deep_report` 约定）。
 *
 * 和 review 同样的原因：不识别就会被当成打分请求转发给 Laya，返回分数而不是报告，
 * App 解析失败并报「模型返回的内容看不懂」——**这正是用户实测遇到的那条报错**。
 */
export function isDeepRequest(items) {
  return Array.isArray(items)
    && items.length === 1
    && items[0]
    && String(items[0].id) === 'deep_report';
}

/**
 * 多模态请求（describe / review / deep）→ 视觉端点的消息体。
 *
 * question 里带着 App 侧拼好的**完整指令**（系统提示 + 用户上下文 + 输出格式约束），
 * 适配器不重复维护这些措辞（单一真源），只负责把指令与图片一起送到视觉端点。
 */
export function buildVisionMessages(stateText, questionText) {
  const instruction = (typeof questionText === 'string' && questionText.trim())
    ? questionText.trim()
    : (typeof stateText === 'string' ? stateText.trim() : '');
  return [
    {
      role: 'user',
      content: instruction || '请依据图片给出结构化结果，严格只输出规定的 JSON。',
    },
  ];
}

/* ────────────────────────── 响应翻译 ────────────────────────── */

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n) => Math.min(SCORE_MAX, Math.max(SCORE_MIN, n));

/**
 * Laya 的 `probabilities` 有两种形状，必须都吃：
 * - score 题 → 数组，索引 i 对应 criteria[i]，长度 = 档位数
 * - choice 题 → 以「标签」为键的对象（实测 {"GOOD":0.62,"BAD":0.38}）
 */
function probabilitiesOf(answer) {
  const p = answer && answer.probabilities;
  if (Array.isArray(p)) return { array: p.filter((v) => typeof v === 'number'), object: null };
  if (p && typeof p === 'object') {
    const entries = Object.entries(p).filter(([, v]) => typeof v === 'number');
    if (entries.length) return { array: null, object: entries };
  }
  return { array: null, object: null };
}

/**
 * 取「答案置信度」。
 *
 * 这里必须优先用 `answer_confidence`：Laya 同时给出 `confidence`（基于熵，衡量的是**决策**有多确定）
 * 与 `answer_confidence`（落在所选答案上的概率质量，衡量的是**这个答案**有多可信）。
 * 官方文档明确说 LangChain / CrewAI / LlamaIndex 三个包装器都按 `answer_confidence` 设阈值，
 * 而不是按熵置信度。实测同一响应里两者可以差一个数量级（0.043 vs 0.6214），
 * 用错字段会把「模型很确定」误报成「模型几乎在瞎猜」。
 */
function answerConfidence(answer) {
  const candidates = [
    answer && answer.answer_confidence,
    answer && answer.confidence,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Laya answer → App answer。
 * - score：索引 → 0..5 分。Laya 也可返回带小数的加权分；两者都按 1 位小数输出。
 *   注意 `score === null` 表示“超出档位范围”（abstain），此时退回按概率加权；仍无值则丢弃该答案。
 * - noul：是/否概率 → 文字回答。
 * - choice：取概率最高的标签作为文字回答。
 */
export function toAppAnswer(id, answer) {
  if (!answer || typeof answer !== 'object') return null;
  const { array: probs, object: probEntries } = probabilitiesOf(answer);

  if (answer.type === 'score') {
    let raw = typeof answer.score === 'number' && Number.isFinite(answer.score) ? answer.score : null;
    if (raw === null && probs && probs.length) {
      // 加权期望：把“索引”当分值用
      raw = probs.reduce((sum, p, index) => sum + p * index, 0);
    }
    if (raw === null) return null;
    const scale = probs && probs.length > 1 ? probs.length - 1 : SCORE_MAX;
    const scaled = scale === SCORE_MAX ? raw : (raw / scale) * SCORE_MAX;
    return {
      id,
      type: 'score',
      score: round1(clamp(scaled)),
      confidence: normalizeConfidence(answerConfidence(answer)),
    };
  }

  if (answer.type === 'noul') {
    const p = typeof answer.noul === 'number' && Number.isFinite(answer.noul) ? answer.noul : null;
    if (p === null) return null;
    const explicit = answerConfidence(answer);
    return {
      id,
      type: 'text',
      content: p >= 0.5 ? '是' : '否',
      confidence: normalizeConfidence(explicit === null ? Math.abs(p - 0.5) * 2 : explicit),
    };
  }

  if (answer.type === 'choice') {
    const label = answer.choice;
    if (typeof label !== 'string' || !label) return null;
    let conf = answerConfidence(answer);
    if (conf === null && probEntries && probEntries.length) {
      conf = Math.max(...probEntries.map(([, v]) => v));
    }
    if (conf === null && probs && probs.length) conf = Math.max(...probs);
    return { id, type: 'text', content: label, confidence: normalizeConfidence(conf) };
  }

  return null;
}

function normalizeConfidence(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, Number(value)));
}

/** Laya 响应体 → App 响应体（answers 数组化、usage 改名、补 content 占位）。 */
export function toAppResponse(layaBody, requestedIds) {
  const answersObj = (layaBody && layaBody.answers) || {};
  const answers = [];
  for (const id of requestedIds) {
    const converted = toAppAnswer(id, answersObj[id]);
    if (converted) answers.push(converted);
  }
  const usage = (layaBody && layaBody.usage) || {};
  const model = (layaBody && layaBody.model)
    || (layaBody && layaBody.routing && layaBody.routing.model)
    || 'laya';
  return {
    model: String(model),
    answers,
    usage: {
      prompt_tokens: toInt(usage.input_tokens),
      completion_tokens: toInt(usage.output_tokens),
      total_tokens: toInt(usage.input_tokens) + toInt(usage.output_tokens),
    },
  };
}

function toInt(n) {
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/* ────────────────────────── 图片转文字（可选） ────────────────────────── */

/**
 * describe（图片 → 结构化纯文字描述）的消息体。
 * 严格复用 SPEC §3.2 的描述维度与「只客观描述」的约束，措辞与 App 侧 prompt 一致。
 */
export function buildDescribeMessages(stateText, questionText) {
  return [
    {
      role: 'system',
      content: [
        '你是穿搭照片的客观记录员，只转录照片里真实可见的衣物与搭配事实。',
        '禁止任何主观评价、打分或建议（不许出现“好看/显瘦/建议/推荐”这类词）。',
        '分不清或被遮挡的部位，一律写「未清晰显示」，不得猜测、不得编造。',
        `按这七个维度分点描述，每行一个，用「维度：内容」的格式：整体风格、上衣、下装、鞋履、配饰、身材视觉效果、其他细节。`,
      ].join('\n'),
    },
    { role: 'user', content: questionText || '请客观描述这张穿搭照片。' },
  ];
}

/* ────────────────────────── HTTP 服务 ────────────────────────── */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * describe_* 走视觉端点；未配置则**退回夹具兜底描述**。
 *
 * 为什么需要兜底：App 侧 SPEC §3.7 v1.5 会把 describe 路由到"能看图的模型"，
 * 但只配了本地 Laya、没配视觉端点的部署同样是合法配置（用 `laya_only` 档）。
 * 那种情况下如果这里直接返回空答案，App 会在第一步就整体失败。
 * 注意：夹具兜底的内容是**固定的示例描述**，不是真的看懂了照片——
 * 所以会在 state 里显式标注，用户与日志都不会误以为它看过图。
 */
async function handleDescribe(body) {
  const ids = body.questions.map((q) => String(q.id));
  const images = Array.isArray(body.images) ? body.images : [];
  const image = images[0] || null;

  // ① 配了视觉端点 → 真的看图
  if (VISION_BASE_URL) {
    if (!image || !image.dataUri) {
      return { status: 400, payload: { error: { message: 'no image provided' } } };
    }
    const messages = buildDescribeMessages(body.state, body.questions[0] && body.questions[0].question);
    messages[1].content = [
      { type: 'text', text: (body.questions[0] && body.questions[0].question) || '请客观描述这张穿搭照片。' },
      { type: 'image_url', image_url: { url: image.dataUri } },
    ];
    const result = await fetchJson(
      `${VISION_BASE_URL}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(VISION_API_KEY ? { Authorization: `Bearer ${VISION_API_KEY}` } : {}),
        },
        body: JSON.stringify({ model: VISION_MODEL, messages, temperature: 0.2, max_tokens: VISION_MAX_TOKENS }),
      },
      60000,
    );
    if (result.status < 200 || result.status >= 300 || !result.json) {
      return { status: 502, payload: { error: { message: `vision upstream HTTP ${result.status}` } } };
    }
    const content = result.json.choices
      && result.json.choices[0]
      && result.json.choices[0].message
      && result.json.choices[0].message.content;
    const usage = result.json.usage || {};
    return {
      status: 200,
      payload: {
        model: VISION_MODEL,
        answers: ids.map((id) => ({
          id,
          type: 'text',
          content: typeof content === 'string' ? content : '',
          confidence: 0.8,
        })),
        usage: {
          prompt_tokens: toInt(usage.prompt_tokens),
          completion_tokens: toInt(usage.completion_tokens),
          total_tokens: toInt(usage.total_tokens),
        },
      },
    };
  }

  // ② 没配视觉端点 → 夹具兜底（显式标注，不假装看过图）
  const lookIds = ids.map((id) => (id.match(/look[1-4]/) || ['look1'])[0]);
  return {
    status: 200,
    payload: {
      model: 'fixture-fallback',
      answers: ids.map((id, index) => ({
        id,
        type: 'text',
        content: `（占位描述：未配置能看图的模型，以下为固定示例，不代表真实照片内容）\n${fallbackDescription(lookIds[index])}`,
        confidence: 0.3,
      })),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  };
}

/** 夹具兜底描述：复用 fixtures/descriptions 的四个样例，缺文件时给通用描述。 */
function fallbackDescription(lookId) {
  const file = path.join(ROOT, 'fixtures', 'descriptions', `${lookId}.json`);
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof parsed === 'string') return parsed;
      if (parsed && typeof parsed.text === 'string') return parsed.text;
      if (parsed && typeof parsed.content === 'string') return parsed.content;
    }
  } catch {
    // 读不到就用下面的通用描述
  }
  return '整体风格：未清晰显示；上衣：未清晰显示；下装：未清晰显示；'
    + '鞋履：未清晰显示；配饰：未清晰显示；身材视觉效果：未清晰显示；其他细节：未清晰显示';
}

/** App 请求体 → Laya 批处理请求体（states 数组，其余与单条一致）。 */
export function toLayaBatchRequest(body) {
  const states = (Array.isArray(body && body.looks) ? body.looks : [])
    .map((look) => (look && typeof look.state === 'string' ? look.state : ''));
  const questions = {};
  const first = (Array.isArray(body && body.looks) ? body.looks : [])[0];
  const incoming = first && Array.isArray(first.questions) ? first.questions : [];
  const context = { scene: sceneOf(states[0]) };
  for (const item of incoming) {
    if (!item || !item.id) continue;
    questions[String(item.id)] = toLayaQuestion(item, context);
  }
  const out = { states, questions };
  if (MODEL) out.model = MODEL;
  return out;
}

/**
 * Laya 批处理响应 → App 批处理响应。
 * Laya 保证 `results` 与 `states` 同序，本函数按索引回填 lookId，
 * 并校验条数；条数不符就报错，绝不把结果错配到别的穿上（错配比失败更糟）。
 */
export function toAppBatchResponse(layaBody, lookIds) {
  const results = Array.isArray(layaBody && layaBody.results) ? layaBody.results : [];
  if (results.length !== lookIds.length) {
    const err = new Error(`batch result count mismatch: ${results.length} != ${lookIds.length}`);
    err.kind = 'parse';
    throw err;
  }
  const usage = (layaBody && layaBody.total_usage) || {};
  const looks = lookIds.map((lookId, index) => {
    const one = toAppResponse(results[index], Object.keys(SCORE_RUBRICS));
    return { lookId, model: one.model, answers: one.answers, usage: one.usage };
  });
  return {
    model: looks[0] ? looks[0].model : 'laya',
    looks,
    usage: {
      prompt_tokens: toInt(usage.input_tokens),
      completion_tokens: toInt(usage.output_tokens),
      total_tokens: toInt(usage.input_tokens) + toInt(usage.output_tokens),
    },
  };
}

/**
 * 多模态直通（describe / review / deep 共用）：把指令 + 图片送到视觉端点，
 * 把模型返回的文本原样回给 App（answers[0].content）。
 *
 * 关键点：
 *  - 指令由 App 侧拼好（含系统提示、上下文与"只输出 JSON"的约束），适配器只转发，
 *    不重复维护措辞（单一真源）；
 *  - **图必须带上**：这三条链路都是"以自己看到的画面作答"，没有图就毫无意义；
 *  - 未配置视觉端点时**明确失败**（502），绝不用 Laya 的打分冒充多模态结果——
 *    那会让 App 以为拿到了报告/纠正分（实测踩过：review 与 deep 都被当成打分转发给 Laya）。
 */
async function forwardToVision({ answerId, state, questionText, images, temperature }) {
  if (!VISION_BASE_URL) {
    return { status: 502, payload: { error: { message: 'vision not configured' } } };
  }
  if (!Array.isArray(images) || !images.length) {
    return { status: 400, payload: { error: { message: `${answerId} requires images` } } };
  }
  const messages = buildVisionMessages(state, questionText);
  messages[0].content = [
    { type: 'text', text: String(messages[0].content) },
    ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUri } })),
  ];
  const result = await fetchJson(
    `${VISION_BASE_URL}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(VISION_API_KEY ? { Authorization: `Bearer ${VISION_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages,
        temperature: Number.isFinite(temperature) ? temperature : 0,
        // 推理模型会把预算花在 reasoning 上：给小了会返回 HTTP 200 但 content 为空串
        // （实测 deepseek-flash 的坑）。deep 报告比纠正更长，所以这里给足。
        max_tokens: VISION_MAX_TOKENS,
      }),
    },
    120000,
  );
  if (result.status < 200 || result.status >= 300 || !result.json) {
    return { status: 502, payload: { error: { message: `vision upstream HTTP ${result.status}` } } };
  }
  const choice = result.json.choices && result.json.choices[0];
  const content = choice && choice.message && choice.message.content;
  const usage = result.json.usage || {};
  return {
    status: 200,
    payload: {
      model: VISION_MODEL,
      answers: [{
        id: answerId,
        type: 'text',
        content: typeof content === 'string' ? content : '',
        confidence: 0.8,
      }],
      usage: {
        prompt_tokens: toInt(usage.prompt_tokens),
        completion_tokens: toInt(usage.completion_tokens),
        total_tokens: toInt(usage.total_tokens),
      },
    },
  };
}

/** 多模态纠正（`review`）。 */
function handleReview(body) {
  const question = body.questions[0];
  return forwardToVision({
    answerId: 'review',
    state: body.state,
    questionText: question && question.question,
    images: Array.isArray(body.images) ? body.images : [],
    temperature: 0,
  });
}

/** System Two 深度分析（`deep_report`）。 */
function handleDeep(body) {
  const question = body.questions[0];
  return forwardToVision({
    answerId: 'deep_report',
    state: body.state,
    questionText: question && question.question,
    images: Array.isArray(body.images) ? body.images : [],
    temperature: 0.2,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
    let upstream = { ok: false, detail: 'unreachable' };
    try {
      const r = await fetchJson(`${UPSTREAM}/health`, {
        headers: UPSTREAM_KEY ? { Authorization: `Bearer ${UPSTREAM_KEY}` } : {},
      }, 5000);
      upstream = { ok: r.status === 200, status: r.status, detail: (r.json && r.json.status) || r.text.slice(0, 120) };
    } catch (err) {
      upstream = { ok: false, detail: String(err && err.message ? err.message : err) };
    }
    sendJson(res, 200, {
      ok: true,
      adapter: 'laya-adapter',
      upstream,
      vision: VISION_BASE_URL ? { configured: true, model: VISION_MODEL } : { configured: false },
    });
    return;
  }

  /**
   * 批处理入口（SPEC §3.11 v1.6）：把 N 套的 6 维打分合并成**一次**上游调用。
   * Laya 的 /v1/systemone/batch 在单次 forward pass 内 collate 多行，省掉 N-1 次往返与调度。
   * 注意：实测在这台 CPU 机器上加速比只有约 1.07x（瓶颈是算力不是往返），
   * 真正收益在 GPU 或多并发场景；但批处理**不改变分数**（实测 4/4 逐条一致），所以可安全启用。
   */
  if (req.method === 'POST' && (url.pathname === '/ask/batch' || url.pathname === '/v1/systemone/batch')) {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      sendJson(res, 400, { error: { message: 'request body must be valid JSON' } });
      return;
    }
    const looks = Array.isArray(body.looks) ? body.looks : [];
    if (!looks.length) {
      sendJson(res, 400, { error: { message: "request body must carry a 'looks' array" } });
      return;
    }
    const started = Date.now();
    try {
      const layaBody = toLayaBatchRequest(body);
      const r = await fetchJson(`${UPSTREAM}/v1/systemone/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(UPSTREAM_KEY ? { Authorization: `Bearer ${UPSTREAM_KEY}` } : {}),
        },
        body: JSON.stringify(layaBody),
      }, 180000);
      if (r.status < 200 || r.status >= 300 || !r.json) {
        process.stdout.write(`[adapter] /ask/batch -> upstream ${r.status} ms=${Date.now() - started}\n`);
        sendJson(res, r.status || 502, { error: { message: `upstream HTTP ${r.status}` } });
        return;
      }
      const payload = toAppBatchResponse(r.json, looks.map((look) => String(look.lookId)));
      process.stdout.write(`[adapter] /ask/batch -> 200 looks=${looks.length} ms=${Date.now() - started}\n`);
      sendJson(res, 200, payload);
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      process.stdout.write(`[adapter] /ask/batch ERROR ${message.slice(0, 160)}\n`);
      sendJson(res, err && err.kind === 'parse' ? 502 : 502, { error: { message: 'batch failed' } });
    }
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/ask' || url.pathname === '/v1/systemone')) {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      sendJson(res, 400, { error: { message: 'request body must be valid JSON' } });
      return;
    }
    const questions = Array.isArray(body.questions) ? body.questions : [];
    if (!questions.length) {
      sendJson(res, 400, { error: { message: "request body must carry a 'questions' array" } });
      return;
    }
    const started = Date.now();
    try {
      // 顺序有讲究：先判 deep / review / describe 这三条**多模态**通道，
      // 剩下的才是"打分"（转发给 Laya）。任何一条漏判都会被打分路径吞掉，
      // 表现为 App 报「模型返回的内容看不懂」（deep 与 review 都实测踩过）。
      // 用顺序 if 而不是嵌套三元，避免以后再加通道时改错括号。
      let result;
      if (isDeepRequest(questions)) {
        result = await handleDeep(body);
      } else if (isReviewRequest(questions)) {
        result = await handleReview(body);
      } else if (isDescribeRequest(questions)) {
        result = await handleDescribe(body);
      } else {
        const layaBody = toLayaRequest(body);
        const r = await fetchJson(`${UPSTREAM}/v1/systemone`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(UPSTREAM_KEY ? { Authorization: `Bearer ${UPSTREAM_KEY}` } : {}),
          },
          body: JSON.stringify(layaBody),
        }, 120000);
        if (r.status < 200 || r.status >= 300 || !r.json) {
          result = { status: r.status || 502, payload: { error: { message: `upstream HTTP ${r.status}` } } };
        } else {
          result = {
            status: 200,
            payload: toAppResponse(r.json, questions.map((q) => String(q.id))),
          };
        }
      }
      // 只打 ASCII 摘要：本机控制台是 GBK，直接打中文会乱码
      process.stdout.write(
        `[adapter] ${url.pathname} -> ${result.status} questions=${questions.length} ms=${Date.now() - started}\n`,
      );
      sendJson(res, result.status, result.payload);
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      process.stdout.write(`[adapter] ERROR ${message.slice(0, 160)}\n`);
      sendJson(res, 502, { error: { message: 'upstream unreachable' } });
    }
    return;
  }

  sendJson(res, 404, { error: { message: 'not found' } });
});

export { server, UPSTREAM, PORT, HOST };

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain || process.env.LAYA_ADAPTER_START === '1') {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`laya-adapter listening on http://${HOST}:${PORT} -> ${UPSTREAM}\n`);
    process.stdout.write(`vision: ${VISION_BASE_URL ? `${VISION_MODEL} @ ${VISION_BASE_URL}` : 'not configured (describe_* will return empty)'}\n`);
  });
}
