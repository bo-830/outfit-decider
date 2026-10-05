/**
 * src/store/history.js — SPEC §3.12 历史记录（纯逻辑，禁止 import react/react-native/expo）
 *
 * 隐私不变量（SPEC §4.1）：历史里**只允许文字与分数**，绝不出现 base64 / data URI / 图片字段。
 * 所有写库路径都必须先过 `assertNoImagePayload`。
 *
 * 存储顺序：数组按时间**升序**（最新一条在末尾），超出 `HISTORY_LIMIT` 时从头部截断，
 * 即「保留最新 30 条」。界面若要「最新在上」自行 reverse。
 *
 * storage 抽象：`{ getItem(k), setItem(k,v), removeItem(k) }`（AsyncStorage / 内存替身 / localStorage 皆可）。
 * 任何读取异常（无数据、坏 JSON、非数组）一律返回 `[]`，不抛错。
 */

export const HISTORY_KEY = 'od.history.v1';
export const HISTORY_LIMIT = 30;

/* ---------------------------------------------------- 图片载荷检测（§4.1.3） */

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
  'photo',
  'photos',
  'picture',
  'blob',
  'uri',
  'url',
  'src',
  'file',
  'fileuri',
  'filepath',
  'artifact',
  'artifacts',
]);

/** 看起来像 base64 / data URI 的字符串（历史记录里没有合法的长 base64） */
const DATA_URI_RE = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,]/i;
const RAW_BASE64_RE = /^[A-Za-z0-9+/\r\n]{256,}={0,2}$/;

function isImageKey(key) {
  return IMAGE_KEYS.has(String(key).toLowerCase().replace(/[_\-\s]/g, ''));
}

function isImageString(value) {
  const s = String(value);
  if (DATA_URI_RE.test(s)) return true;
  if (s.length >= 256 && RAW_BASE64_RE.test(s)) return true;
  if (s.length >= 64 && /;base64,/.test(s)) return true;
  return false;
}

const DROP = Symbol('od.DROP');

function sanitize(value, path, violations) {
  if (typeof value === 'string') {
    if (isImageString(value)) {
      violations.push(path);
      return DROP;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const out = [];
    value.forEach((item, i) => {
      const r = sanitize(item, `${path}[${i}]`, violations);
      if (r !== DROP) out.push(r);
    });
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const p = `${path}.${k}`;
      if (isImageKey(k)) {
        violations.push(p);
        continue;
      }
      const r = sanitize(v, p, violations);
      if (r !== DROP) out[k] = r;
    }
    return out;
  }
  return value;
}

/**
 * SPEC §4.1.3：丢弃记录中的图片字段并记一条 warning。
 *
 * 返回值 = **清洗后的记录本体**（可直接当 record 用），同时挂两个**不可枚举**诊断属性：
 *   - `ok`         : boolean，无命中为 true
 *   - `violations` : string[]，被丢弃字段的路径（如 `$.looks[0].uri`）
 * 不可枚举 → 不会被 JSON.stringify 写进存储。
 */
export function assertNoImagePayload(record) {
  const violations = [];
  const result = sanitize(record === undefined ? null : record, '$', violations);
  const clean = result === DROP ? {} : result;
  if (violations.length) {
    // 只输出 ASCII，避免控制台编码问题；不打印任何字段内容
    console.warn(`[od.history] dropped image payload field(s): ${violations.join(', ')}`);
  }
  Object.defineProperty(clean, 'ok', { value: violations.length === 0, enumerable: false });
  Object.defineProperty(clean, 'violations', { value: violations, enumerable: false });
  return clean;
}

/* ------------------------------------------------------------ Record 规整 */

function fnv1aHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

function text(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function normalizeLook(raw) {
  const look = raw && typeof raw === 'object' ? raw : {};
  const scores = look.scores && typeof look.scores === 'object' && !Array.isArray(look.scores) ? look.scores : {};
  const normalizedScores = {};
  for (const [k, v] of Object.entries(scores)) {
    normalizedScores[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return {
    lookId: text(look.lookId),
    description: text(look.description),
    scores: normalizedScores,
    rank: typeof look.rank === 'number' && Number.isFinite(look.rank) ? look.rank : null,
  };
}

function normalizeDeepSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const reasons = Array.isArray(raw.oneLineReasons)
    ? raw.oneLineReasons.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim())
    : [];
  return { pick: text(raw.pick), oneLineReasons: reasons };
}

/** 把任意输入规整成 SPEC §3.12 的 Record（字段白名单，杜绝意外泄漏） */
export function normalizeRecord(raw) {
  const record = raw && typeof raw === 'object' ? raw : {};
  const tsAt = typeof record.tsAt === 'number' && Number.isFinite(record.tsAt) ? record.tsAt : Date.now();
  const id =
    typeof record.id === 'string' && record.id
      ? record.id
      : // 缺失 id（历史遗留/损坏数据）时用「时间戳 + 内容哈希」补一个**稳定** id：
        // 同一份数据多次 load 得到同一个 id，removeHistory(id) 才不会失效。
        `${tsAt}-${fnv1aHex(JSON.stringify(record))}`;
  const looks = Array.isArray(record.looks) ? record.looks.map(normalizeLook) : [];
  return {
    id,
    tsAt,
    stateSummary: text(record.stateSummary),
    question: text(record.question),
    looks,
    deepSummary: normalizeDeepSummary(record.deepSummary),
  };
}

/** 便捷构造器：保证 id 形如 `${tsAt}-${random}`（SPEC §3.12） */
export function makeHistoryRecord({ stateSummary = '', question = '', looks = [], deepSummary = null, tsAt } = {}) {
  const at = typeof tsAt === 'number' && Number.isFinite(tsAt) ? tsAt : Date.now();
  return normalizeRecord({
    id: `${at}-${randomSuffix()}`,
    tsAt: at,
    stateSummary,
    question,
    looks,
    deepSummary,
  });
}

/* ---------------------------------------------------------------- 读写 API */

/**
 * 追加一条记录 → Promise<Record[]>（追加后的完整列表，已截断到最新 30 条）。
 * 入参 record 会先过 `assertNoImagePayload` 再规整为白名单字段。
 */
export async function appendHistory(record, storage) {
  const list = await loadHistory(storage);
  const clean = assertNoImagePayload(record);
  const entry = normalizeRecord(clean);
  const next = [...list, entry].slice(-HISTORY_LIMIT);
  await storage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

/** 读取全部记录 → Promise<Record[]>；无数据/坏数据一律 [] */
export async function loadHistory(storage) {
  try {
    const raw = await storage.getItem(HISTORY_KEY);
    if (raw == null || raw === '') return [];
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r && typeof r === 'object' && !Array.isArray(r))
      .map(normalizeRecord)
      .slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** 删除单条 → Promise<Record[]>（删除后的列表） */
export async function removeHistory(id, storage) {
  const list = await loadHistory(storage);
  const next = list.filter((r) => r.id !== id);
  await storage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

/** 清空 → Promise<void> */
export async function clearHistory(storage) {
  await storage.removeItem(HISTORY_KEY);
}

export default {
  HISTORY_KEY,
  HISTORY_LIMIT,
  assertNoImagePayload,
  normalizeRecord,
  makeHistoryRecord,
  appendHistory,
  loadHistory,
  removeHistory,
  clearHistory,
};
