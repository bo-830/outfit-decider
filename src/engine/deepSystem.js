// SPEC §3.9 · System Two 深度推理引擎：原图直连多模态大模型，输出三段式报告。
// 一次调用；answers[0].content 是 JSON 字符串；解析失败 → {kind:'parse'}。

import { toDataUri } from '../core/protocol.js';
import { DEEP_DIMENSION_NAMES, DEEP_SYSTEM_PROMPT, buildDeepUserText } from '../core/prompts.js';
import { LOOK_IDS } from '../data/options.js';
import { errorInfo } from '../data/copy.js';

const DEEP_QUESTION_ID = 'deep_report';
const STAR_STEP = 0.5;
const STAR_MAX = 5;

export function makeDeepSystem({ api, model } = {}) {
  async function analyze({ artifacts, userState, question, signal } = {}) {
    const list = (Array.isArray(artifacts) ? artifacts : []).filter((item) => item && item.lookId);
    if (!list.length) throw parseFailure();
    const lookIds = [];
    for (const item of list) if (!lookIds.includes(item.lookId)) lookIds.push(item.lookId);

    const response = await api.ask({
      state: buildDeepUserText({ userState, question }),
      questions: [{ id: DEEP_QUESTION_ID, type: 'text', question: DEEP_SYSTEM_PROMPT }],
      images: list.map((item) => ({ id: item.lookId, dataUri: toDataUri(item) })),
      signal,
      model,
    });

    const answers = response && Array.isArray(response.answers) ? response.answers : [];
    const answer = answers.find((item) => item && item.id === DEEP_QUESTION_ID && typeof item.content === 'string')
      || answers.find((item) => item && item.type === 'text' && typeof item.content === 'string')
      || answers[0];
    const content = answer && typeof answer.content === 'string' ? answer.content : '';
    if (!content.trim()) throw parseFailure();
    return parseDeepReport(content, { lookIds });
  }

  return { analyze };
}

/**
 * SPEC §3.9 · 解析深度报告。
 * - 容忍 ```json 代码块与前后缀文字；
 * - ranking 按 stars 降序（同分按 lookId 升序）；details 顺序与 ranking 一致；
 * - 每套固定 5 个维度名；stars 四舍五入到 0.5 步进并钳制 [0,5]；
 * - pros 2-3 / cons 1-2 / suggestions 1-3；conclusion.pick 必须落在 ranking 内（否则回落第一名）；
 * - 任一段缺失或结构不合规 → 抛 {kind:'parse'}。
 * opts.lookIds：若给出，则丢弃不在本次上传范围内的套。
 */
export function parseDeepReport(rawText, opts = {}) {
  const text = extractJson(rawText);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw parseFailure();
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw parseFailure();

  const allowed = Array.isArray(opts.lookIds) && opts.lookIds.length
    ? new Set(opts.lookIds.filter((id) => typeof id === 'string'))
    : null;

  const rankingRaw = Array.isArray(data.ranking) ? data.ranking : null;
  const detailsRaw = Array.isArray(data.details) ? data.details : null;
  const conclusionRaw = data.conclusion && typeof data.conclusion === 'object' ? data.conclusion : null;
  if (!rankingRaw || !rankingRaw.length || !detailsRaw || !detailsRaw.length || !conclusionRaw) {
    throw parseFailure();
  }

  const ranking = [];
  for (const item of rankingRaw) {
    if (!item || typeof item !== 'object') continue;
    const lookId = typeof item.lookId === 'string' ? item.lookId.trim() : '';
    const stars = clampStars(item.stars);
    const oneLineReason = oneLine(item.oneLineReason);
    if (!lookId || stars === null || !oneLineReason) continue;
    if (allowed && !allowed.has(lookId)) continue;
    if (ranking.some((entry) => entry.lookId === lookId)) continue;
    ranking.push({ lookId, stars, oneLineReason });
  }
  if (!ranking.length) throw parseFailure();
  ranking.sort((a, b) => (b.stars - a.stars) || compareId(a.lookId, b.lookId));

  const details = ranking.map((ranked) => {
    const raw = detailsRaw.find((item) => item && typeof item === 'object' && item.lookId === ranked.lookId);
    if (!raw) throw parseFailure();
    const starsByName = new Map();
    for (const dimension of (Array.isArray(raw.dimensions) ? raw.dimensions : [])) {
      if (!dimension || typeof dimension !== 'object') continue;
      const name = typeof dimension.name === 'string' ? dimension.name.trim() : '';
      const stars = clampStars(dimension.stars);
      if (!name || stars === null || starsByName.has(name)) continue;
      starsByName.set(name, stars);
    }
    const dimensions = [];
    for (const name of DEEP_DIMENSION_NAMES) {
      if (!starsByName.has(name)) throw parseFailure();
      dimensions.push({ name, stars: starsByName.get(name) });
    }
    const pros = stringList(raw.pros);
    const cons = stringList(raw.cons);
    const suggestions = stringList(raw.suggestions);
    if (pros.length < 2 || cons.length < 1 || suggestions.length < 1) throw parseFailure();
    return {
      lookId: ranked.lookId,
      dimensions,
      pros: pros.slice(0, 3),
      cons: cons.slice(0, 2),
      suggestions: suggestions.slice(0, 3),
    };
  });

  const alternatives = stringList(conclusionRaw.alternatives).slice(0, 2);
  const reason = oneLine(conclusionRaw.reason);
  const tip = oneLine(conclusionRaw.tip);
  if (!alternatives.length || !reason || !tip) throw parseFailure();
  const pickCandidate = typeof conclusionRaw.pick === 'string' ? conclusionRaw.pick.trim() : '';
  const pick = ranking.some((entry) => entry.lookId === pickCandidate)
    ? pickCandidate
    : ranking[0].lookId;

  return {
    ranking,
    details,
    conclusion: { pick, reason, alternatives, tip },
  };
}

/** SPEC §3.9 · 用于校验的字面量 schema 对象（每次返回独立副本，测试用）。 */
export function deepReportSchema() {
  const starSchema = { type: 'number', minimum: 0, maximum: STAR_MAX, multipleOf: STAR_STEP };
  const textSchema = { type: 'string', minLength: 1 };
  return {
    type: 'object',
    required: ['ranking', 'details', 'conclusion'],
    additionalProperties: true,
    properties: {
      ranking: {
        type: 'array',
        minItems: 1,
        maxItems: LOOK_IDS.length,
        items: {
          type: 'object',
          required: ['lookId', 'stars', 'oneLineReason'],
          additionalProperties: true,
          properties: {
            lookId: { type: 'string', enum: [...LOOK_IDS] },
            stars: starSchema,
            oneLineReason: textSchema,
          },
        },
      },
      details: {
        type: 'array',
        minItems: 1,
        maxItems: LOOK_IDS.length,
        items: {
          type: 'object',
          required: ['lookId', 'dimensions', 'pros', 'cons', 'suggestions'],
          additionalProperties: true,
          properties: {
            lookId: { type: 'string', enum: [...LOOK_IDS] },
            dimensions: {
              type: 'array',
              minItems: DEEP_DIMENSION_NAMES.length,
              maxItems: DEEP_DIMENSION_NAMES.length,
              items: {
                type: 'object',
                required: ['name', 'stars'],
                additionalProperties: true,
                properties: {
                  name: { type: 'string', enum: [...DEEP_DIMENSION_NAMES] },
                  stars: starSchema,
                },
              },
            },
            pros: { type: 'array', minItems: 2, maxItems: 3, items: textSchema },
            cons: { type: 'array', minItems: 1, maxItems: 2, items: textSchema },
            suggestions: { type: 'array', minItems: 1, maxItems: 3, items: textSchema },
          },
        },
      },
      conclusion: {
        type: 'object',
        required: ['pick', 'reason', 'alternatives', 'tip'],
        additionalProperties: true,
        properties: {
          pick: { type: 'string', enum: [...LOOK_IDS] },
          reason: textSchema,
          alternatives: { type: 'array', minItems: 1, maxItems: 2, items: textSchema },
          tip: textSchema,
        },
      },
    },
  };
}

function extractJson(rawText) {
  let text = typeof rawText === 'string' ? rawText.trim() : '';
  text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return text;
  return text.slice(start, end + 1);
}

function clampStars(value) {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null;
  const stepped = Math.round(numeric / STAR_STEP) * STAR_STEP;
  const clamped = Math.min(STAR_MAX, Math.max(0, stepped));
  return clamped === 0 ? 0 : Math.round(clamped * 10) / 10;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function oneLine(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function compareId(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function parseFailure() {
  const info = errorInfo('parse');
  const err = new Error(info.message);
  err.kind = 'parse';
  err.action = info.action;
  err.retryable = false;
  return err;
}
