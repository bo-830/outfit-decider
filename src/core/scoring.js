// SPEC §3.3 · 排序与汇总。纯逻辑层，禁止 import react / react-native / expo。

import { UNRECOGNIZABLE_MARK } from '../data/copy.js';
import { SCORE_QUESTION_IDS, rankLooks as rankLooksCore } from './protocol.js';
import { DESCRIPTION_DIMENSIONS } from './prompts.js';

/**
 * SPEC §3.3 · 与 protocol.rankLooks 同一实现（两侧签名都要在，行为必须一致）。
 * 规则：overall 为 null 的排最后；其余降序；同分按 lookId 升序；返回新数组并追加 rank。
 */
export function rankLooks(rows) {
  return rankLooksCore(rows);
}

/**
 * SPEC §3.3 · 各维度置信度均值 → 0..1；无有效维度（空集）→ 0。
 * 只有"该维度拿到了分数"才计入均值；分数在但 confidence 缺失时按协议默认 0.5 计。
 */
export function computeConfidence(scores, confidences) {
  const scoreMap = scores && typeof scores === 'object' ? scores : {};
  const confMap = confidences && typeof confidences === 'object' ? confidences : {};
  let sum = 0;
  let count = 0;
  for (const id of SCORE_QUESTION_IDS) {
    const value = scoreMap[id];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    let confidence = confMap[id];
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) confidence = 0.5;
    confidence = Math.min(1, Math.max(0, confidence));
    sum += confidence;
    count += 1;
  }
  if (!count) return 0;
  return Math.round((sum / count) * 100) / 100;
}

/**
 * SPEC §3.3 · {best, worst, avg}；只统计有分数的维度。
 * 并列时取 SCORE_QUESTION_IDS 中靠前的维度；无分数 → {best:null, worst:null, avg:0}。
 */
export function summarize(scores) {
  const scoreMap = scores && typeof scores === 'object' ? scores : {};
  let best = null;
  let worst = null;
  let bestValue = -Infinity;
  let worstValue = Infinity;
  let sum = 0;
  let count = 0;
  for (const id of SCORE_QUESTION_IDS) {
    const value = scoreMap[id];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    sum += value;
    count += 1;
    if (value > bestValue) {
      bestValue = value;
      best = id;
    }
    if (value < worstValue) {
      worstValue = value;
      worst = id;
    }
  }
  if (!count) return { best: null, worst: null, avg: 0 };
  return { best, worst, avg: Math.round((sum / count) * 100) / 100 };
}

/**
 * SPEC §3.3 · 质量门槛：结构化描述非空（且不全为「未清晰显示」）且 ≥1 个维度有分数。
 * 支持两种入参：
 * - answers 数组：[{id,type:'text',content}, {id,type:'score',score}]
 * - 对象：{description|text|content, scores}
 */
export function meetsMinQuality(parsedAnswers) {
  if (!parsedAnswers) return false;
  if (typeof parsedAnswers === 'string') return isMeaningfulDescription(parsedAnswers);
  if (Array.isArray(parsedAnswers)) {
    const texts = [];
    let hasScore = false;
    for (const answer of parsedAnswers) {
      if (!answer || typeof answer !== 'object') continue;
      if (answer.type === 'text' && typeof answer.content === 'string') texts.push(answer.content);
      if (answer.type === 'score' && Number.isFinite(answer.score)) hasScore = true;
    }
    return isMeaningfulDescription(texts.join('\n')) && hasScore;
  }
  if (typeof parsedAnswers !== 'object') return false;
  const description = parsedAnswers.description ?? parsedAnswers.text ?? parsedAnswers.content;
  const scores = parsedAnswers.scores;
  let hasScore = false;
  if (Array.isArray(scores)) {
    hasScore = scores.some((value) => typeof value === 'number' && Number.isFinite(value));
  } else if (scores && typeof scores === 'object') {
    hasScore = Object.values(scores).some(
      (value) => (typeof value === 'number' && Number.isFinite(value))
        || (value && typeof value === 'object' && Number.isFinite(value.score)),
    );
  }
  return isMeaningfulDescription(description) && hasScore;
}

/**
 * SPEC §5.1 invalid_input 判定 · 描述是否包含"可信的穿搭事实"。
 * 做法：去掉所有「未清晰显示」、去掉 7 个维度名、去掉「标签：」形式的前缀与标点后，
 * 若仍有内容 → 认为识别到了有效穿搭（部分维度看不清不影响）。
 * 例：7 维全为「未清晰显示」→ false；只有配饰看不清其余有内容 → true。
 */
export function isMeaningfulDescription(text) {
  if (typeof text !== 'string') return false;
  if (!text.trim()) return false;
  const withoutMark = text.split(UNRECOGNIZABLE_MARK).join('');
  const withoutDimensions = withoutMark.replace(DIMENSION_PATTERN, '');
  const withoutLabels = withoutDimensions.replace(/^[^\n：:]{1,20}[：:]/gm, '');
  const rest = withoutLabels.replace(/[\s,，。;；:：、.·\-—_*#>|/\\()[\]（）【】]/g, '');
  return rest.length > 0;
}

const DIMENSION_PATTERN = new RegExp(DESCRIPTION_DIMENSIONS.join('|'), 'g');
