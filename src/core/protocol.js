// SPEC §3.1 · JEv / Laya 线上协议：构造、解析、校验、排序。
// 本文件属纯逻辑层：禁止 import react / react-native / expo。

export const SCORE_QUESTION_IDS = [
  'overall_score',
  'aesthetic_score',
  'scene_score',
  'figure_score',
  'style_score',
  'practical_score',
];
export const MAX_LOOKS = 4;
export const SCORE_DECIMALS = 1;

const SCORE_MIN = 0;
const SCORE_MAX = 5;
const DEFAULT_CONFIDENCE = 0.5;

/**
 * SPEC §3.1 · 四舍五入到 1 位小数并钳制到 [0,5]；NaN / 非数值 → null。
 * 越界值按"钳制"处理（6.3 → 5，-2 → 0），NaN / 字符串 / Infinity 视为无效。
 */
export function clampScore(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const factor = 10 ** SCORE_DECIMALS;
  const rounded = Math.round(n * factor) / factor;
  const clamped = Math.min(SCORE_MAX, Math.max(SCORE_MIN, rounded));
  return clamped === 0 ? 0 : clamped; // 归一化 -0
}

/** SPEC §1.1 派生 · toDataUri(artifact) === `data:${mime};base64,${base64}` */
export function toDataUri(artifact) {
  const mime = artifact && typeof artifact.mime === 'string' ? artifact.mime : '';
  const base64 = artifact && typeof artifact.base64 === 'string' ? artifact.base64 : '';
  return `data:${mime};base64,${base64}`;
}

/**
 * SPEC §3.6 v1.7 · 把新选的图**追加**到已有列表上（分次选图的正确语义）。
 *
 * 为什么抽成纯函数：这正是用户实测"加了第二套就把第一套顶掉"的地方，
 * 必须有直接单测覆盖，而不是只靠"读代码觉得对"。
 *
 * 规则：
 *  - 新图从 `LOOK_IDS[existing.length]` 起继续编号，绝不复用已占用的 lookId；
 *  - 已有条目**原样保留**（顺序不变），追加在末尾；
 *  - 超出 maxLooks 的部分丢弃；
 *  - 已满时返回 null，调用方据此提示"已选满"，而不是静默替换。
 *
 * @param {Array} existing 当前已选（元素含 lookId）
 * @param {Array} incoming 本次新选的种子（不含 lookId，或含无用的 lookId）
 * @param {Array<string>} lookIds 可用编号池，如 ['look1','look2','look3','look4']
 * @param {number} maxLooks 上限
 * @returns {{artifacts: Array}|null} null = 没有可追加的（已满或本次为空）
 */
export function appendArtifacts(existing, incoming, lookIds, maxLooks) {
  const list = Array.isArray(existing) ? existing.filter((item) => item && item.lookId) : [];
  const ids = Array.isArray(lookIds) ? lookIds : [];
  const cap = Number.isFinite(maxLooks) ? maxLooks : ids.length;

  if (list.length >= cap) return null; // 已满：交给界面提示，绝不替换已有内容

  const seeds = (Array.isArray(incoming) ? incoming : []).filter(Boolean);
  const free = ids.slice(list.length, cap);
  const added = [];
  for (let i = 0; i < seeds.length && i < free.length; i += 1) {
    added.push({ ...seeds[i], lookId: free[i] });
  }
  if (!added.length) return null;

  return { artifacts: [...list, ...added].slice(0, cap) };
}

/**
 * SPEC §1.3 请求体 · 严格字段顺序 model → state → questions，浅拷贝，不改入参。
 */
export function buildRequest({ model, state, questions } = {}) {
  const list = Array.isArray(questions)
    ? questions.map((q) => (q && typeof q === 'object' ? { ...q } : q))
    : [];
  return {
    model: typeof model === 'string' ? model : model == null ? '' : String(model),
    state: typeof state === 'string' ? state : state == null ? '' : String(state),
    questions: list,
  };
}

/**
 * SPEC §3.1 · 响应 answers → { overall_score: {score, confidence} | null, ... }。
 * 恒返回 6 个键；未知 id 忽略；缺失 / 非法项为 null；同 id 重复取首个有效项。
 */
export function buildScoreAnswers(answers) {
  const out = {};
  for (const id of SCORE_QUESTION_IDS) out[id] = null;
  if (!Array.isArray(answers)) return out;
  for (const raw of answers) {
    const parsed = parseScoreAnswer(raw);
    if (!parsed) continue;
    if (!SCORE_QUESTION_IDS.includes(parsed.id)) continue;
    if (out[parsed.id] !== null) continue;
    out[parsed.id] = { score: parsed.score, confidence: parsed.confidence };
  }
  return out;
}

/**
 * SPEC §3.1 · 宽松解析（用于把模型输出接到内部结构）。
 * - id 必须是非空字符串，type 必须是 'score'；
 * - score 必须是有限数值，越界钳制到 [0,5]、四舍五入 1 位小数；
 * - confidence 缺省 0.5，越界钳制到 [0,1]；
 * - 任何不满足的消息返回 null（不抛错）。
 */
export function parseScoreAnswer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  if (raw.type !== 'score') return null;
  const score = clampScore(raw.score);
  if (score === null) return null;
  let confidence = raw.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) confidence = DEFAULT_CONFIDENCE;
  confidence = Math.min(1, Math.max(0, confidence));
  return { id, score, confidence };
}

/**
 * SPEC §1.3 严格校验 · raw 是否**完全**满足 score answer 的全部约束：
 * id 非空字符串、type='score'、score ∈ [0,5] 且已是 1 位小数、confidence（若给出）∈ [0,1]。
 * 与 parseScoreAnswer 的差别：这里的越界值不钳制，直接判 false。
 */
export function isScoreAnswerStrict(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return false;
  if (raw.type !== 'score') return false;
  const { score } = raw;
  if (typeof score !== 'number' || !Number.isFinite(score)) return false;
  if (score < SCORE_MIN || score > SCORE_MAX) return false;
  const factor = 10 ** SCORE_DECIMALS;
  if (Math.round(score * factor) / factor !== score) return false;
  if (raw.confidence !== undefined && raw.confidence !== null) {
    const c = raw.confidence;
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) return false;
  }
  return true;
}

/**
 * SPEC §3.1 / §3.3 · 排序：overall 为 null 的排最后；其余按 overall 降序；
 * 同分按 lookId 升序（look1..look4）；返回新数组，每项追加 rank（1-based）。
 * 入参可以是 {lookId, scores:{overall_score}} 或已带 overall 字段的行。
 */
export function rankLooks(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const decorated = list.map((row, index) => ({
    row,
    index,
    id: row && typeof row.lookId === 'string' ? row.lookId : '',
    overall: overallOf(row),
  }));
  decorated.sort((a, b) => {
    if (a.overall === null && b.overall === null) return compareLookId(a, b);
    if (a.overall === null) return 1;
    if (b.overall === null) return -1;
    if (b.overall !== a.overall) return b.overall - a.overall;
    return compareLookId(a, b);
  });
  return decorated.map((item, i) => ({ ...item.row, rank: i + 1 }));
}

function compareLookId(a, b) {
  if (a.id === b.id) return a.index - b.index;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return a.index - b.index;
}

function overallOf(row) {
  if (!row || typeof row !== 'object') return null;
  const raw = (row.scores && row.scores.overall_score) ?? row.overall;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}
