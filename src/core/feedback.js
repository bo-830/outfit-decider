// SPEC §4.1 隐私不变量 + 反馈回路（纯逻辑层，禁止 import react / react-native / expo）。
//
// 目的：现在判断"某个打分档位是否可靠"的唯一依据是 4 组照片的人工对照，样本太小。
// 加入"用户最后穿了哪套"的轻量反馈，才能在真实使用中积累判断依据
// （例如回答"Laya 到底值不值得留"）。
//
// 隐私是硬约束：只存文字与选择，绝不存图片、绝不存 base64、绝不上传任何东西。
// 本文件是全仓库里这条不变量的执行点之一：它没有任何 import 语句、没有任何网络
// 能力，并且所有进入记录/序列化/统计的路径都必须先过 stripImages()。
//
// 记录形状（白名单，键顺序固定）：
//   { lookId, verdict, scoreSnapshot, engineMode, systemMode, at }
//   - verdict        ：FEEDBACK_VERDICTS 之一
//   - scoreSnapshot  ：只保留有限数字（其余键全部丢弃）
//   - engineMode     ：原样存字符串（来自 src/engine/api.js 的 ENGINE_MODES）
//   - systemMode     ：原样存字符串（来自 src/core/flow.js 的 SYSTEM_MODES）
//   - at             ：毫秒时间戳；buildFeedback 缺省取当前时间，parse 时不会重造

export const FEEDBACK_VERDICTS = ['wore', 'not_wore', 'skipped'];

/**
 * 界面文案。按仓库约定中文文案集中在 src/data/copy.js，但本模块不允许修改该文件，
 * 所以把这一小撮文案作为常量放在本模块内导出。
 */
export const FEEDBACK_VERDICT_LABELS = {
  wore: '穿了这套',
  not_wore: '没穿这套',
  skipped: '没参考',
};

/** 缺失/非法的引擎或系统档位统一归到这个桶，避免统计时把条目丢掉 */
export const UNKNOWN_BUCKET = 'unknown';

/* ------------------------------------------------------------ 图片载荷剔除 */

/** 命中即视为图片字段的键名（比较前会去掉 _ - 空格 并转小写） */
const IMAGE_KEYS = new Set([
  'base64',
  'datauri',
  'dataurl',
  'image',
  'images',
  'imagebase64',
  'imagedata',
  'imagedatauri',
  'img',
  'imgdata',
  'imguri',
  'photo',
  'photos',
  'picture',
  'pictures',
  'blob',
  'uri',
  'url',
  'src',
  'file',
  'fileuri',
  'filepath',
  'artifact',
  'artifacts',
  'thumbnail',
  'thumbnailuri',
]);

/** 看起来像 data URI / 长 base64 的字符串（反馈记录里没有合法的这类内容） */
const DATA_URI_RE = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,]/i;
const RAW_BASE64_RE = /^[A-Za-z0-9+/\r\n]{256,}={0,2}$/;

function isImageKey(key) {
  return IMAGE_KEYS.has(String(key).toLowerCase().replace(/[_\-\s]/g, ''));
}

function isImageString(value) {
  if (typeof value !== 'string') return false;
  if (DATA_URI_RE.test(value)) return true;
  if (value.length >= 64 && value.includes(';base64,')) return true;
  if (value.length >= 256 && RAW_BASE64_RE.test(value)) return true;
  return false;
}

const DROP = Symbol('od.feedback.DROP');

function scrub(value) {
  if (typeof value === 'string') return isImageString(value) ? DROP : value;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const clean = scrub(item);
      if (clean !== DROP) out.push(clean);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (isImageKey(key)) continue;
      const clean = scrub(item);
      if (clean !== DROP) out[key] = clean;
    }
    return out;
  }
  return value;
}

/**
 * SPEC §4.1.3 · 递归剔除任何可能混进来的图片字段 / base64 载荷（防御性）。
 *
 * 规则：键名命中图片字段黑名单 → 整个键丢弃；字符串长得像 data URI / 长 base64
 * → 该值丢弃（数组里则跳过该元素）。返回**新对象**，绝不就地修改入参。
 * 非对象入参（null / 字符串 / 数字）返回 null，不抛错。
 */
export function stripImages(record) {
  if (record === null || record === undefined) return null;
  if (typeof record !== 'object') return null;
  const clean = scrub(record);
  return clean === DROP ? null : clean;
}

/* ------------------------------------------------------------------ 规整器 */

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** verdict 校验 + 归一化（大小写 / 首尾空白）；非法 → null */
function normalizeVerdict(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return FEEDBACK_VERDICTS.includes(normalized) ? normalized : null;
}

/** scoreSnapshot 白名单：只保留有限数字，丢弃字符串/对象/数组/NaN/Infinity */
function normalizeScores(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** 引擎/系统档位：非空字符串原样保留（trim 后），其余 → null（不校验取值，保持解耦） */
function modeOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * SPEC §4.1 · 构造一条反馈记录。verdict 非法（含缺失、非字符串、不在枚举内）→ null；
 * 其余字段一律按白名单规整，最后过一遍 stripImages()（纵深防御）。
 *
 * @param {{lookId?:string, verdict:string, scoreSnapshot?:object,
 *          engineMode?:string, systemMode?:string, at?:number}} [input]
 * @returns {object|null}
 */
export function buildFeedback({
  lookId,
  verdict,
  scoreSnapshot,
  engineMode,
  systemMode,
  at,
} = {}) {
  const cleanVerdict = normalizeVerdict(verdict);
  if (!cleanVerdict) return null;
  return stripImages({
    lookId: text(lookId),
    verdict: cleanVerdict,
    scoreSnapshot: normalizeScores(scoreSnapshot),
    engineMode: modeOf(engineMode),
    systemMode: modeOf(systemMode),
    at: typeof at === 'number' && Number.isFinite(at) ? at : Date.now(),
  });
}

/** 解析路径的规整：与 buildFeedback 同形，但**不重造时间戳**（缺 at 就是 null） */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const verdict = normalizeVerdict(raw.verdict);
  if (!verdict) return null; // 脏条目：跳过，不抛错
  return stripImages({
    lookId: text(raw.lookId),
    verdict,
    scoreSnapshot: normalizeScores(raw.scoreSnapshot),
    engineMode: modeOf(raw.engineMode),
    systemMode: modeOf(raw.systemMode),
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : null,
  });
}

/* ---------------------------------------------------------------- 读写 API */

/**
 * SPEC §4.1 · 解析反馈列表，**极度容错**：非法 JSON、非数组、脏条目一律安全降级。
 * 已经不是字符串时按数组直接规整（便于测试与内存态复用）。
 *
 * @param {string|Array|*} raw
 * @returns {Array<object>} 只含合法条目，顺序不变；无法解析 → []
 */
export function parseFeedbackList(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const clean = normalizeEntry(entry);
    if (clean) out.push(clean);
  }
  return out;
}

/**
 * SPEC §4.1 · 序列化反馈列表：先规整再 JSON.stringify，
 * 保证 `parseFeedbackList(serializeFeedbackList(list))` 与规整后的 list 等价，
 * 且不会把任何白名单外的字段写进存储。非数组/非法 JSON 入参 → '[]'。
 */
export function serializeFeedbackList(list) {
  return JSON.stringify(parseFeedbackList(list));
}

/**
 * SPEC §4.1 · 汇总：`{total, byVerdict, byEngineMode, bySystemMode}`，
 * 用于将来判断"哪些档位更可靠"（例如只看 wore 的那批用了哪个引擎）。
 *
 * - `byVerdict` 恒包含全部 3 个 verdict 键（缺失为 0），方便界面直接渲染；
 * - 缺失/空的 engineMode、systemMode 归入 'unknown'，保证分桶计数不丢条目；
 * - 入参可以是 JSON 字符串、数组或脏数据，内部先走 parseFeedbackList。
 */
export function feedbackSummary(list) {
  const entries = parseFeedbackList(list);
  const byVerdict = {};
  for (const verdict of FEEDBACK_VERDICTS) byVerdict[verdict] = 0;
  const byEngineMode = {};
  const bySystemMode = {};

  for (const entry of entries) {
    byVerdict[entry.verdict] += 1;
    bump(byEngineMode, entry.engineMode || UNKNOWN_BUCKET);
    bump(bySystemMode, entry.systemMode || UNKNOWN_BUCKET);
  }

  return { total: entries.length, byVerdict, byEngineMode, bySystemMode };
}

/**
 * 计数自增。用 defineProperty 而不是 `bag[key] = n`：反馈列表可能来自被篡改的
 * 持久化数据，`__proto__` 这类键名在普通赋值下会走原型 setter 而不是记成字段。
 */
function bump(bag, key) {
  const next = (Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : 0) + 1;
  Object.defineProperty(bag, key, {
    value: next,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
