// SPEC §3.9b · 多模态纠正（System One 的分数校正）。
//
// 背景：本机真实 Laya 作为**基础设施**合格（确定性、协议正确、离线、约 1s），
// 但作为**穿搭评审**不合格（实测「得体」vs「荒谬」综合分只差 0.4，场合适配度方向还是反的）。
// 所以保留 Laya 在环，再用一个**能直接看原图**的多模态模型纠正它的分数。
//
// 关键：纠正模型必须看原图，不能只看 describe 产出的文字描述——那份描述正是 Laya 打分的输入，
// 只看文字等于继承同一个视觉来源，无法纠正视觉层面的误判。
//
// 输出严格只有分数（6 维、0-5、1 位小数），不产出任何解释性文本，
// 因此 System One「只出分不出解释」的硬约束仍然成立。

import { SCORE_QUESTION_IDS, clampScore, toDataUri } from '../core/protocol.js';
import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT } from '../core/prompts.js';
import { errorFor } from '../data/copy.js';

const SCORE_KEY_SET = new Set(SCORE_QUESTION_IDS);

export function makeReviewSystem({ api } = {}) {
  /**
   * 用多模态模型重新判断各套的 6 维分数。
   *
   * 两种调用形态：
   *   A) `review({..., base})` —— 自己构造提示词（标准路径）
   *   B) `reviewWithPrompt({prompt, images, lookIds, base})` —— 用调用方**提前构造好**的提示词。
   *      存在的理由：纠正只需要「图片 + 描述 + Laya 原始分」，而 Laya 原始分在提示词里只是参考文本。
   *      让调用方在 Laya 打分的同时就把纠正请求发出去，两者并行，能省掉一整段串行等待
   *      （实测 describe 约 8s、Laya 打分约 1.4s、纠正约 5s，串行 vs 并行的差别很实在）。
   *
   * @returns Promise<{
   *   scores: Record<string, Record<string, number>>,   // lookId → 6 维分数
   *   model: string, usage: object, reviewedAt: number, changed: string[],
   * }>
   */
  async function review({ artifacts, descriptions, userState, question, base, signal } = {}) {
    const list = (Array.isArray(artifacts) ? artifacts : []).filter((item) => item && item.lookId);
    if (!list.length) throw errorFor('invalid_input');
    const lookIds = list.map((item) => item.lookId);
    const prompt = buildReviewPrompt({ userState, question, base, lookIds, descriptions });
    return reviewWithPrompt({ prompt, artifacts: list, lookIds, base, signal });
  }

  /** 形态 B：提示词由调用方提供（用于与 Laya 打分并行）。 */
  async function reviewWithPrompt({ prompt, artifacts, lookIds, base, signal } = {}) {
    if (!api || typeof api.vision !== 'function') throw errorFor('server');
    // 必须显式校验多模态通道已配置：否则 api.vision 会因缺少 baseUrl 而抛 network，
    // 更糟的是**在某些实现对端上会被当成普通打分请求**（实测：未配 vision 时
    // 这 4 次纠正请求会退化成 6 维打分请求打到决策模型，白花一倍算力还不报错）。
    // §3.9c 要求这种情形明确报 vision_unconfigured，让界面能指路到设置页。
    if (typeof api.visionConfigured === 'function' && !api.visionConfigured()) {
      throw errorFor('vision_unconfigured');
    }
    const list = (Array.isArray(artifacts) ? artifacts : []).filter((item) => item && item.lookId);
    if (!list.length) throw errorFor('invalid_input');

    // 关键：纠正**必须**带图。artifact 允许只带 {mime, base64}（reducer 里的形状），
    // 也允许已带 dataUri。这里统一成 dataUri；若一张都组不出来，直接判 server——
    // 绝不能退化成"只看文字"的假纠正：文字描述正是 Laya 打分的输入，
    // 只看文字等于继承同一个视觉来源，纠正就失去意义了。
    const images = list
      .map((item) => ({ id: item.lookId, dataUri: item.dataUri || artifactDataUri(item) }))
      .filter((item) => typeof item.dataUri === 'string' && item.dataUri.startsWith('data:'));
    if (!images.length) throw errorFor('server');

    const ids = Array.isArray(lookIds) && lookIds.length ? lookIds : list.map((item) => item.lookId);
    const response = await api.vision({
      system: REVIEW_SYSTEM_PROMPT,
      content: prompt,
      answerId: 'review',
      images,
      temperature: 0,
      signal,
    });
    const answer = (response && Array.isArray(response.answers) ? response.answers : [])[0];
    const raw = answer && typeof answer.content === 'string' ? answer.content : '';
    if (!raw.trim()) throw errorFor('parse');

    const scores = parseReviewScores(raw, ids);
    const changed = ids.filter((lookId) => hasScoreDelta(base, scores, lookId));
    return {
      scores,
      model: response.model,
      usage: response.usage,
      reviewedAt: Date.now(),
      changed,
      imageCount: images.length,
    };
  }

  return { review, reviewWithPrompt };
}

/** {mime, base64} → data URI；缺任一项返回 ''（调用方据此判失败，不再往下走）。 */
function artifactDataUri(artifact) {
  if (!artifact || typeof artifact.base64 !== 'string' || !artifact.base64) return '';
  if (typeof artifact.mime !== 'string' || !artifact.mime) return '';
  return toDataUri(artifact);
}

/**
 * 解析纠正输出。容错但不放水：
 * - 允许 ```json 代码块包裹、允许前后有说明文字（模型偶尔会加）；
 * - 但缺维度、越界、lookId 不在本次上传范围内 → 一律丢弃该套（宁可回退 Laya 原分，也不编造）。
 */
export function parseReviewScores(rawText, lookIds) {
  const ids = Array.isArray(lookIds) ? lookIds.filter((id) => typeof id === 'string') : [];
  const json = extractJson(rawText);
  if (!json || !Array.isArray(json.scores)) throw errorFor('parse');

  const allow = new Set(ids);
  const out = {};
  for (const row of json.scores) {
    if (!row || typeof row !== 'object') continue;
    const lookId = typeof row.lookId === 'string' ? row.lookId : '';
    if (!allow.has(lookId)) continue;
    const scores = {};
    for (const key of SCORE_QUESTION_IDS) {
      const value = clampScore(row[key]);
      if (value !== null) scores[key] = value;
    }
    // 只有 6 维齐全才接受这一套：半套分数会让排序在不同维度上取不同来源
    if (Object.keys(scores).length === SCORE_QUESTION_IDS.length) out[lookId] = scores;
  }
  if (!Object.keys(out).length) throw errorFor('parse');
  return out;
}

/** 从可能带 markdown 围栏或前后缀的文本里抠出第一个完整 JSON 对象。 */
function extractJson(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // 继续试下一个候选
    }
  }
  return null;
}

/** 纠正是否真的改变了这一套的分数（用于 UI 标注与评估取证）。 */
export function hasScoreDelta(base, reviewed, lookId) {
  const baseScores = base && base.byLook && base.byLook[lookId] ? base.byLook[lookId].scores : null;
  const nextScores = reviewed ? reviewed[lookId] : null;
  if (!baseScores || !nextScores) return true;
  return SCORE_QUESTION_IDS.some((key) => !sameScore(baseScores[key], nextScores[key]));
}

function sameScore(a, b) {
  const left = clampScore(a);
  const right = clampScore(b);
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) < 0.05;
}
