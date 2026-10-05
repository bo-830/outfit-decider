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
    // 先判「纠正是否可能生效」（App 自带端点，或视觉配置在服务端）。
    // 用 visionReady 而不是 visionConfigured：后者只回答"App 有没有自己的端点"，
    // 服务端形态下为 false，会导致明明能纠正却报 vision_unconfigured。
    const ready = typeof api.visionReady === 'function'
      ? api.visionReady()
      : (typeof api.visionConfigured === 'function' ? api.visionConfigured() : true);
    if (!ready) throw errorFor('vision_unconfigured');
    if (process.env.OD_DEBUG_REVIEW) {
      process.stdout.write(`[review] ready=${ready} endpoint=${typeof api.visionEndpointConfigured === 'function' ? api.visionEndpointConfigured() : '?'} artifacts=${(artifacts || []).length}\n`);
    }
    const list = (Array.isArray(artifacts) ? artifacts : []).filter((item) => item && item.lookId);
    if (!list.length) throw errorFor('invalid_input');

    const ids = Array.isArray(lookIds) && lookIds.length ? lookIds : list.map((item) => item.lookId);
    const promptText = typeof prompt === 'string' ? prompt : '';
    const images = list
      .map((item) => ({ id: item.lookId, dataUri: item.dataUri || artifactDataUri(item) }))
      .filter((item) => typeof item.dataUri === 'string' && item.dataUri.startsWith('data:'));

    let response;
    // 走哪条通道，判据是"App 有没有**自己的**多模态端点"，**不是**"有没有图"：
    // 服务端形态（visionServerSide）下 App 有图但必须把图发给决策端点（适配器在服务端看图）。
    // 之前这里误用 images.length 作判据，导致服务端形态去打 chat/completions 而报
    // vision_unconfigured（本轮实测抓到的真实缺陷）。
    const hasOwnEndpoint = typeof api.visionEndpointConfigured === 'function'
      ? api.visionEndpointConfigured()
      : (typeof api.visionConfigured === 'function' ? api.visionConfigured() : false);

    if (hasOwnEndpoint && images.length) {
      // 形态 A：App 自己就配了多模态端点 → 直接走 vision 看原图
      response = await api.vision({
        system: REVIEW_SYSTEM_PROMPT,
        content: prompt,
        answerId: 'review',
        images,
        temperature: 0,
        signal,
      });
    } else {
      // 形态 B：视觉配置在**服务端**（如本机 Laya 适配器读自己的 .env.local 调多模态模型）。
      // 此时 App 侧没有 visionBaseUrl，但把图随决策通道的请求体一起发给适配器，
      // 由适配器在服务端完成看图与纠正。**图必须照发**——否则服务端也无从判断。
      if (typeof api.ask !== 'function') throw errorFor('server');
      const carry = list
        .map((item) => {
          const dataUri = item.dataUri || artifactDataUri(item);
          return dataUri ? { id: item.lookId, dataUri } : null;
        })
        .filter(Boolean);
      if (!carry.length) throw errorFor('server');
      response = await api.ask({
        state: prompt,
        // 用一条 text 型问题承载纠正指令：结果在 answers[0].content。
        // id 固定为 'review'，且把整段纠正指令放进 question —— 对端（适配器/mock）
        // 靠这个 id 就能认出"这是纠正请求，不是打分请求"，从而走多模态分支。
        questions: [{ id: 'review', type: 'text', question: prompt }],
        images: carry,
        signal,
      });
    }

    const answer = (response && Array.isArray(response.answers) ? response.answers : [])[0];
    const raw = answer && typeof answer.content === 'string' ? answer.content : '';
    if (process.env.OD_DEBUG_REVIEW) {
      process.stdout.write(`[review] answers=${(response && response.answers || []).length} answerId=${answer && answer.id} rawLen=${raw.length}\n`);
      process.stdout.write(`[review] raw=${raw.slice(0, 300).replace(/\n/g, ' ')}\n`);
    }
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
/**
 * 解析纠正输出。**必须容忍真实模型实际给出的形状变体**，否则纠正会静默失效。
 *
 * 实测（DeepSeek-flash 看 4 张真实照片）它给的是「按 lookId 嵌套 + 中文维度名」：
 *   {"look1":{"整体得分":4.6,"美观度":4.4,"场合适配度":5.0,...},"look2":{...}}
 * 而契约里写的是 `{scores:[{lookId, overall_score, ...}]}`。只认后者的话，
 * 每一轮纠正都会走 parse 失败回退——正是本文件此前的问题（3 组照片的纠正全被丢弃）。
 *
 * 因此这里把几种等价形状都归一化到 `{lookId: {六维英文键}}`：
 *   1) {scores:[{lookId, overall_score,...}]}          ← 契约形状
 *   2) {lookId: {整体得分/overall_score/...}}          ← 实测形状
 *   3) [{lookId, ...}]                                 ← 裸数组
 * 未知维度名与越界值照旧丢弃；六维不齐的套不采纳（宁可回退，也不给半套分数）。
 */
const DIMENSION_ALIASES = {
  overall_score: ['overall_score', 'overall', '综合', '综合分', '整体', '整体得分', '总体', '总体得分'],
  aesthetic_score: ['aesthetic_score', 'aesthetic', '美观', '美观度', '审美'],
  scene_score: ['scene_score', 'scene', '场合', '场合分', '场合适配度', '场景', '场景分', '场合适配'],
  figure_score: ['figure_score', 'figure', '身材', '身材分', '身材友好度', '身形', '身材修饰'],
  style_score: ['style_score', 'style', '风格', '风格分', '风格统一度', '风格统一'],
  practical_score: ['practical_score', 'practical', '实用', '实用分', '实用舒适度', '实用性', '舒适'],
};

/** 在一条记录里按别名找出某维度的原始值（大小写与空白不敏感）。 */
function pickDimension(row, questionId) {
  const aliases = DIMENSION_ALIASES[questionId] || [questionId];
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[String(key).trim().toLowerCase().replace(/\s+/g, '')] = value;
  }
  for (const alias of aliases) {
    const key = alias.trim().toLowerCase().replace(/\s+/g, '');
    if (normalized[key] !== undefined) return normalized[key];
  }
  return undefined;
}

/** 把任意受支持形状归一化成 [{lookId, row}]。 */
function normalizeReviewRows(json) {
  if (!json) return [];
  const rows = [];
  if (Array.isArray(json)) {
    for (const item of json) if (item && typeof item === 'object') rows.push(item);
    return rows;
  }
  if (Array.isArray(json.scores)) {
    for (const item of json.scores) if (item && typeof item === 'object') rows.push(item);
    return rows;
  }
  // 形状 2：以 lookId 为键的对象。值必须是对象，否则不是我们在找的结构。
  for (const [key, value] of Object.entries(json)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      rows.push({ lookId: key, ...value });
    }
  }
  return rows;
}

export function parseReviewScores(rawText, lookIds) {
  const ids = Array.isArray(lookIds) ? lookIds.filter((id) => typeof id === 'string') : [];
  const json = extractJson(rawText);
  const candidates = normalizeReviewRows(json);
  if (!candidates.length) throw errorFor('parse');

  const allow = new Set(ids);
  const out = {};
  for (const row of candidates) {
    if (!row || typeof row !== 'object') continue;
    const lookId = typeof row.lookId === 'string' ? row.lookId : '';
    if (!allow.has(lookId)) continue;
    const scores = {};
    for (const key of SCORE_QUESTION_IDS) {
      const value = clampScore(pickDimension(row, key));
      if (value !== null) scores[key] = value;
    }
    // 只有 6 维齐全才接受这一套：半套分数会让排序在不同维度上取不同来源
    if (Object.keys(scores).length === SCORE_QUESTION_IDS.length) out[lookId] = scores;
  }
  if (!Object.keys(out).length) throw errorFor('parse');
  return out;
}

/** 从可能带 markdown 围栏或前后缀的文本里抠出第一个完整 JSON（对象**或数组**）。 */
function extractJson(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  // 既有对象也有数组形状：分别按首尾括号取，取更长的那段
  const objStart = raw.indexOf('{');
  const objEnd = raw.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) candidates.push(raw.slice(objStart, objEnd + 1));
  const arrStart = raw.indexOf('[');
  const arrEnd = raw.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) candidates.push(raw.slice(arrStart, arrEnd + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      // 数组也是合法输入（模型可能直接给一组记录）
      if (parsed && typeof parsed === 'object') return parsed;
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
