// SPEC §3.1 补充 · 分数越界检测（纯逻辑层，禁止 import react / react-native / expo）。
//
// 要解决的问题：protocol.clampScore() 会把越界原始分**静默**夹到 [0,5]
// （8 → 5、-3 → 0）。一旦模型整体按 1–10 或 0–100 的量表打分，用户会看到一片
// 贴边的 5 分，却完全不知道这一轮结果不可信。本模块提供"先判断、再决定是否夹"
// 的纯函数：上层在调用 clampScore **之前**先跑 auditScores，判定整轮越界就改报
// 解析错误（parse）并重试，而不是照单全收。
//
// 关键约定：入参必须是**原始分**（clamp 之前的值）。本模块自己不做任何钳制，
// 也不会把越界值"修正"成合法值 —— 它只负责如实报告。

export const SCORE_MIN = 0;
export const SCORE_MAX = 5;

/**
 * 默认越界比例阈值：0.2。
 *
 * 为什么是 0.2，而不是 0.5：
 * - System One 一轮固定 6 个维度。阈值取 0.5 意味着要 4/6 个值越界才拒绝，
 *   而"模型整体偏高一档"（6 个维度里有 2~3 个超过 5）恰恰是最常见的事故形态，
 *   也正是"用户看到一片 5 分"的成因 —— 0.5 会把它整轮放过。
 * - 取 0.1 又过敏感：单个维度越界（1/6 ≈ 0.167 已经超过 0.1）就会导致整轮重试，
 *   而单点越界更可能是四舍五入或个别维度口径不同；一次重试 = 一次完整 API 调用，
 *   代价明显大于容忍一个坏值。
 * - 0.2 ≈ "超过五分之一"：6 维下需要至少 2 个越界值（2/6 ≈ 0.333）才拒绝，
 *   即要求"成片越界"而不是"个别毛刺"；而真正的量纲错配（1–10 / 0–100 / 负数域）
 *   越界比例通常接近 0.5~1，召回不受影响。
 */
export const OUTLIER_RATIO_THRESHOLD = 0.2;

/** 边界值兜底：非有限数值一律回退到默认量表，避免 NaN 比较导致静默放过 */
function normalizeBound(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 从条目里取**原始分**。支持两种形状（上层接线时不必先把数据摊平）：
 * - 数字本身：`8`
 * - 对象：`{ id, score }` 或 `{ id, value }`
 * 取不到有限数值 → null（表示"这条压根不是分数"，不参与越界统计）。
 */
function rawValueOf(item) {
  if (typeof item === 'number') return item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const candidate = item.score !== undefined ? item.score : item.value;
  return typeof candidate === 'number' ? candidate : null;
}

/** 越界条目的 id：优先用条目自带的 id，缺失时回退下标（保证 outliers 恒有 id 字段）。 */
function idOf(item, index) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const { id } = item;
    if (typeof id === 'string' && id.trim()) return id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  }
  return String(index);
}

/**
 * SPEC §3.1 补充 · 统计**原始分**越界的条数（必须在 clampScore 之前调用）。
 *
 * @param {Array<number|{id?:string,score?:number,value?:number}>} items 原始分条目
 * @param {{max?:number,min?:number}} [bounds] 量表边界，默认 [0,5]
 * @returns {{ok:boolean, outliers:Array<{id:string,value:number}>, total:number,
 *            outlierCount:number, ratio:number}}
 *   - `outliers`     ：越界条目 `{id, value}`，value 是**原始值**（未夹过）
 *   - `total`        ：参与审计的条目数（= items.length；非数值条目也算一条，
 *                      因为它们同样"没有可用的合法分"）
 *   - `outlierCount` ：原始值不在 [min,max] 内的条数
 *   - `ratio`        ：outlierCount / total，total 为 0 时是 0（不做四舍五入，
 *                      保留全精度，避免舍入把比较推过阈值）
 *   - `ok`           ：**没有任何值越界**（严格口径）。注意：`ok=false` 只说明
 *                      "发生过越界"，是否整轮拒绝请用 shouldRejectScores(audit)
 *                      按比例判定，不要直接用 ok（否则一个 5.2 也会触发重试）。
 *
 * 容错：不存在 `items` / 非数组 / 元素为 null、NaN、字符串、对象缺 score 等一律
 * 安全跳过，绝不抛错；越界值恰好等于边界（0 或 5）**不算**越界。
 */
export function auditScores(items, { max = SCORE_MAX, min = SCORE_MIN } = {}) {
  const list = Array.isArray(items) ? items : [];
  const upper = normalizeBound(max, SCORE_MAX);
  const lower = normalizeBound(min, SCORE_MIN);

  const outliers = [];
  for (let index = 0; index < list.length; index += 1) {
    const value = rawValueOf(list[index]);
    // NaN / ±Infinity：不是"越界分"而是"无效分"，交给协议层按 null 处理，
    // 这里不把它们计成越界（否则模型偶发吐一个 NaN 就会误判整轮量纲错配）。
    if (value === null || !Number.isFinite(value)) continue;
    if (value > upper || value < lower) outliers.push({ id: idOf(list[index], index), value });
  }

  const total = list.length;
  const outlierCount = outliers.length;
  const ratio = total > 0 ? outlierCount / total : 0;
  return { ok: outlierCount === 0, outliers, total, outlierCount, ratio };
}

/** 从 audit 里取比例；audit 形状不合法时返回 null（表示"无法判定"） */
function ratioOf(audit) {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return null;
  if (typeof audit.ratio === 'number' && Number.isFinite(audit.ratio)) return audit.ratio;
  const { total, outlierCount } = audit;
  if (
    typeof total === 'number' && Number.isFinite(total) && total > 0
    && typeof outlierCount === 'number' && Number.isFinite(outlierCount)
  ) {
    return outlierCount / total;
  }
  return null;
}

/**
 * SPEC §3.1 补充 · 越界比例**超过**阈值即判定解析异常（应报 parse 让上层重试）。
 *
 * 语义定死：用严格大于（`ratio > threshold`）。恰好等于阈值不算"超过"，
 * 所以 6 维下 1/6 ≈ 0.167 不拒绝，恰好 1/5 = 0.2 也不拒绝。
 *
 * @param {object|Array} audit auditScores 的返回值；容错：直接传原始条目数组也可以
 *        （内部现算一遍），避免"传错形状 → 恒 false → 永不拒绝"的静默失效。
 * @param {{ratioThreshold?:number}} [options] 比例阈值，默认 OUTLIER_RATIO_THRESHOLD(0.2)；
 *        非法值（NaN / 负数 / 非数字）回退默认阈值。
 * @returns {boolean}
 */
export function shouldRejectScores(audit, { ratioThreshold = OUTLIER_RATIO_THRESHOLD } = {}) {
  const threshold =
    typeof ratioThreshold === 'number' && Number.isFinite(ratioThreshold) && ratioThreshold >= 0
      ? ratioThreshold
      : OUTLIER_RATIO_THRESHOLD;
  const source = Array.isArray(audit) ? auditScores(audit) : audit;
  const ratio = ratioOf(source);
  if (ratio === null) return false; // 无法判定 → 不拒绝（宁可照旧夹制，也不误伤正常轮次）
  return ratio > threshold;
}

/**
 * SPEC §3.1 补充 · 直接审计**上游原始 answers**（App 契约的 `[{id,type,score,...}]`）。
 *
 * 这两行的存在理由：调用方必须审计**未经 clamp 的原值**，
 * 而 `parseScoreAnswer` / `buildScoreAnswers` 内部已经调了 `clampScore`
 * （`src/core/protocol.js`）—— 一旦走完那两步，8 就变成 5、-3 变成 0，
 * 越界证据就没了。所以这里从原始 answers 直接取 `score`，绕开 clamp。
 *
 * @param {Array} rawAnswers 上游返回的原始 answers 数组
 * @returns {{audit:object, reject:boolean, detail:string}}
 *   `reject=true` 表示这是一轮"量纲错配"（比例超阈值），上层应报 parse 并重试，
 *   而不是把一堆贴边的 5 分当成正常结果展示给用户。
 */
export function guardRawAnswers(rawAnswers, { ratioThreshold = OUTLIER_RATIO_THRESHOLD } = {}) {
  const list = Array.isArray(rawAnswers) ? rawAnswers : [];
  const items = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    items.push({ id, score: item.score });
  }
  const audit = auditScores(items);
  const reject = shouldRejectScores(audit, { ratioThreshold });
  const detail = reject
    ? `分数越界比例 ${Math.round(audit.ratio * 100)}%（${audit.outlierCount}/${audit.total}），疑似量纲错配`
    : '';
  return { audit, reject, detail };
}
