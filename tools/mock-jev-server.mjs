#!/usr/bin/env node
/**
 * tools/mock-jev-server.mjs — SPEC §6 契约对端（JEv / Laya 同一套 JSON 契约）
 *
 * 路由：
 *   GET  /health  200 {"ok":true,"model":...,"uptime":n}
 *   GET  /spec    200 §1.3 结构说明 JSON（便于人工核对）
 *   POST /ask     见 SPEC §1.3 + §6
 *
 * 设计要点：
 * - 确定性打分：seed = FNV-1a(`lookId|state|dimId`)，同一输入必得同一输出。
 * - 按请求 questions 的 id/type **逐条**作答；未知 id 不返回（引擎侧应标记 missing）。
 * - 6 种故障注入全部由**请求体 model 字段**触发，无全局开关 → 并发用例互不影响。
 * - describe/deep 内容优先读 fixtures/descriptions/*.json、fixtures/deep/*.json（t-A 的写入范围），
 *   文件缺失/损坏时回退到 tools/fallback-content.mjs 的内置内容，绝不崩。
 * - 带 CORS 头 + OPTIONS 预检：expo web 页面（http://127.0.0.1:8081）跨源调 8787 必需。
 * - stdout 只输出 ASCII（本机控制台 GBK，中文一律只写文件）。
 *
 * 启动：node tools/mock-jev-server.mjs           （PORT=8787 可改，HOST 可改，MOCK_MODEL 可改）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DESCRIBE_DIMENSIONS,
  FALLBACK_DESCRIPTIONS,
  UNRECOGNIZABLE_DESCRIPTION,
  FALLBACK_DEEP_2,
  FALLBACK_DEEP_4,
} from './fallback-content.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DESC_DIR = path.join(ROOT, 'fixtures', 'descriptions');
const DEEP_DIR = path.join(ROOT, 'fixtures', 'deep');

export const LOOK_IDS = ['look1', 'look2', 'look3', 'look4'];
export const SCORE_QUESTION_IDS = [
  'overall_score',
  'aesthetic_score',
  'scene_score',
  'figure_score',
  'style_score',
  'practical_score',
];
export const DEFAULT_MODEL = 'outfit-judge-v1';
export const FAULT_MODELS = [
  'test-auth-fail',
  'test-server-error',
  'test-parse-fail',
  'test-timeout',
  'test-unrecognizable',
  'test-partial-fail',
];

/* ------------------------------------------------------------------ 工具 */

/** FNV-1a 32-bit → unsigned int */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 确定性 [2.0, 5.0] 一位小数分（31 档） */
export function deterministicScore(seed) {
  const h = fnv1a(seed);
  const steps = h % 31; // 0..30
  const v = 2.0 + steps / 10; // 2.0 .. 5.0
  return Math.round(v * 10) / 10;
}

/* ------------------------------------------------ 分数自洽性（二级聚合）
 *
 * 综合分必须与 5 个维度分**自洽**：如果 mock 让 overall 独立随机，就会出现
 * 「综合 5.0，但美观 2.8 / 身材 2.5」这种自相矛盾的展示——本产品的用户正是
 * "有选择困难、想快速定下来"的人，自相矛盾的数字只会让她更不信这个 App。
 *
 * 规则（仍然完全确定性）：
 * 1. 5 个维度分各自用 `lookId|state|维度id` 的 FNV-1a 种子生成；
 * 2. overall = 5 维的**加权平均 + ±0.2 的确定性偏移**，钳到 [2,5]，四舍五入 1 位小数；
 * 3. 权重体现产品意图：用户**选了场合**时 `scene_score` 权重最高（0.34），
 *    因为「哪套适合今天的场合」是最痛的需求；没选场合时 `aesthetic` / `style` 最高。
 *    这样 System One 的排序与 System Two 报告（同样以场合适配度为第一维度）方向一致，
 *    不会出现"A 引擎说这套不适合正式场合、B 引擎却把它排前面"的自相矛盾。
 * 4. 1 位小数下允许并列——并列正是 SPEC §3.3「同分按 lookId 升序」的验证场景，
 *    因此不额外加抖动去回避并列。
 */

/** 参与聚合的 5 个维度（overall 由它们派生，不独立取随机） */
export const SCORE_DIMENSION_IDS = [
  'aesthetic_score',
  'scene_score',
  'figure_score',
  'style_score',
  'practical_score',
];

/** 选了场合：场合适配度权重最高 */
const WEIGHTS_WITH_OCCASION = {
  scene_score: 0.34,
  aesthetic_score: 0.2,
  style_score: 0.16,
  figure_score: 0.16,
  practical_score: 0.14,
};
/** 没选场合：美观与风格偏好优先 */
const WEIGHTS_NO_OCCASION = {
  aesthetic_score: 0.28,
  style_score: 0.28,
  scene_score: 0.16,
  figure_score: 0.16,
  practical_score: 0.12,
};

/** state 里是否给出了非空的【我的场合】行（§3.2：空组会被省略） */
export function hasOccasion(state) {
  const m = /【我的场合】([^\n]*)/.exec(state || '');
  return !!(m && m[1].trim());
}

/** 5 个维度分（确定性） */
export function dimensionScoresFor(lookId, state) {
  const out = {};
  for (const dim of SCORE_DIMENSION_IDS) out[dim] = deterministicScore(`${lookId}|${state}|${dim}`);
  return out;
}

/** overall = 加权平均(5 维) + 确定性小偏移，钳到 [2,5] 并保留 1 位小数 */
export function composeOverallScore(lookId, state, dims) {
  const w = hasOccasion(state) ? WEIGHTS_WITH_OCCASION : WEIGHTS_NO_OCCASION;
  let acc = 0;
  let wsum = 0;
  for (const dim of SCORE_DIMENSION_IDS) {
    acc += dims[dim] * w[dim];
    wsum += w[dim];
  }
  const weightedMean = acc / wsum;
  const offset = ((fnv1a(`${lookId}|${state}|overall_score`) % 41) - 20) / 100; // -0.20 .. +0.20
  const v = Math.min(5, Math.max(2, weightedMean + offset));
  return Math.round(v * 10) / 10;
}

/** 确定性 [0.5, 0.9] 两位小数置信度 */
export function deterministicConfidence(seed) {
  const h = fnv1a(`${seed}#conf`);
  return Math.round((0.5 + (h % 41) / 100) * 100) / 100;
}

const CN_LOOK = { 一: 'look1', 二: 'look2', 三: 'look3', 四: 'look4' };

/** 从 questions 的 id、state 文本、images 中推断本次请求涉及哪些 lookId */
export function resolveLookIds({ questions = [], state = '', images = [] }) {
  const found = [];
  const push = (id) => {
    if (LOOK_IDS.includes(id) && !found.includes(id)) found.push(id);
  };
  for (const q of questions) {
    const m = /look([1-4])/.exec(String(q?.id ?? ''));
    if (m) push(`look${m[1]}`);
  }
  const re = /【穿搭([一二三四])】/g;
  let mm;
  while ((mm = re.exec(state)) !== null) push(CN_LOOK[mm[1]]);
  if (Array.isArray(images)) {
    for (const img of images) {
      const m = /look([1-4])/.exec(String(img?.id ?? ''));
      if (m) push(`look${m[1]}`);
    }
  }
  return found;
}

/** 单个问题归属的 lookId；无法判定时回退 fallback */
function questionLookId(q, ctx, fallback = 'look1') {
  const idm = /look([1-4])/.exec(String(q?.id ?? ''));
  if (idm) return `look${idm[1]}`;
  const fromState = resolveLookIds(ctx);
  if (fromState.length === 1) return fromState[0];
  if (fromState.length > 1) {
    // state 里多套且 id 没带 lookId：按已出题顺序轮转（每套 6 个 score 维度）
    const idx = Math.floor((q?.__i ?? 0) / SCORE_QUESTION_IDS.length);
    return fromState[Math.min(idx, fromState.length - 1)];
  }
  return fallback;
}

/** 文件读取（带 mtime 缓存），失败返回 null */
const fileCache = new Map();
function readTextFile(abs) {
  try {
    const st = fs.statSync(abs);
    const hit = fileCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    const text = fs.readFileSync(abs, 'utf8');
    fileCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, text });
    return text;
  } catch {
    return null;
  }
}

/** 容错解析 JSON 文件 */
function readJsonFile(abs) {
  const raw = readTextFile(abs);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 从多种可能形态里抽出描述文本：string | {text|description|content|desc|describe} | {维度:值,...} */
function extractDescription(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : null;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((v) => (typeof v === 'string' ? v : v?.text ?? v?.content ?? ''))
      .filter(Boolean);
    return parts.length ? parts.join('；') : null;
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'description', 'content', 'desc', 'describe', 'answer', 'result']) {
      const got = extractDescription(value[key]);
      if (got) return got;
    }
    const keys = Object.keys(value);
    if (keys.length && keys.every((k) => DESCRIBE_DIMENSIONS.includes(k))) {
      return DESCRIBE_DIMENSIONS.map((d) => `${d}：${String(value[d])}`).join('；');
    }
    // 形如 {look1: {...}, look2: {...}} 的整包：交由上层按键取
  }
  return null;
}

/** 取某 lookId 的结构化描述（优先 fixture，缺失回退内置） */
export function descriptionFor(lookId) {
  const parsed = readJsonFile(path.join(DESC_DIR, `${lookId}.json`));
  if (parsed) {
    const direct = extractDescription(parsed);
    if (direct) return direct;
    const nested = extractDescription(parsed[lookId]);
    if (nested) return nested;
  }
  return FALLBACK_DESCRIPTIONS[lookId] ?? FALLBACK_DESCRIPTIONS.look1;
}

/* --------------------------------------------------- 深度报告（§3.9） */

const DEEP_DIM_NAMES = ['场合适配度', '美观度', '身材友好度', '风格统一度', '实用舒适度'];

function normalizeStars(n, fallback) {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  const clamped = Math.max(0, Math.min(5, Math.round(v * 2) / 2));
  return clamped;
}

function normalizeDetail(raw, lookId) {
  const dims = Array.isArray(raw?.dimensions) ? raw.dimensions : [];
  const byName = new Map(dims.map((d) => [String(d?.name ?? ''), d?.stars]));
  const dimensions = DEEP_DIM_NAMES.map((name, i) => ({
    name,
    stars: normalizeStars(byName.get(name), [4, 4, 4, 4, 4][i]),
  }));
  const pros = (Array.isArray(raw?.pros) ? raw.pros : []).filter((s) => typeof s === 'string' && s.trim());
  const cons = (Array.isArray(raw?.cons) ? raw.cons : []).filter((s) => typeof s === 'string' && s.trim());
  const suggestions = (Array.isArray(raw?.suggestions) ? raw.suggestions : []).filter(
    (s) => typeof s === 'string' && s.trim(),
  );
  while (pros.length < 2) pros.push('与用户提供的场合基本匹配');
  while (cons.length < 1) cons.push('整体没有明显问题，细节还能再打磨');
  while (suggestions.length < 1) suggestions.push('保持现在的搭配即可');
  return {
    lookId,
    dimensions,
    pros: pros.slice(0, 3),
    cons: cons.slice(0, 2),
    suggestions: suggestions.slice(0, 3),
  };
}

function fallbackDeepFor(sortedIds) {
  const four = ['look1', 'look2', 'look3', 'look4'];
  const isFour = sortedIds.length === 4 && four.every((id) => sortedIds.includes(id));
  return isFour ? FALLBACK_DEEP_4 : FALLBACK_DEEP_2;
}

/**
 * 构造与请求 lookIds 严格对齐的深度报告：
 * ranking 长度 === lookIds 长度且按 stars 降序；details 顺序与 ranking 一致；pick ∈ lookIds。
 * 优先读 fixtures/deep/report-{n}looks.json（t-A 写入），失败回退内置。
 */
export function buildDeepReport(lookIds) {
  const wanted = lookIds.length ? [...lookIds] : ['look1', 'look2'];
  let base = readJsonFile(path.join(DEEP_DIR, `report-${wanted.length}looks.json`));
  if (base && !base.ranking) base = base.report ?? base.deep ?? base.data ?? null;
  if (!base) {
    for (const name of ['report-4looks.json', 'report-2looks.json']) {
      const alt = readJsonFile(path.join(DEEP_DIR, name));
      if (alt?.ranking) {
        base = alt;
        break;
      }
    }
  }
  if (!base) base = fallbackDeepFor(wanted);

  const baseRanking = Array.isArray(base?.ranking) ? base.ranking : [];
  const baseDetails = Array.isArray(base?.details) ? base.details : [];

  const scoreOf = (id) => {
    const row = baseRanking.find((r) => r?.lookId === id);
    return {
      stars: normalizeStars(row?.stars, 3.5),
      // SPEC §3.9：ranking 行的理由字段名恒为 oneLineReason
      oneLineReason:
        (typeof row?.oneLineReason === 'string' && row.oneLineReason.trim()) ||
        '这套与你的场合和偏好基本吻合，可以作为备选。',
    };
  };

  const ranking = wanted
    .map((lookId) => ({ lookId, ...scoreOf(lookId) }))
    .sort((a, b) => b.stars - a.stars || LOOK_IDS.indexOf(a.lookId) - LOOK_IDS.indexOf(b.lookId));

  const details = ranking.map((row) => {
    const raw = baseDetails.find((d) => d?.lookId === row.lookId);
    return normalizeDetail(raw, row.lookId);
  });

  const baseConclusion = base?.conclusion ?? {};
  const pick = wanted.includes(baseConclusion.pick) ? baseConclusion.pick : ranking[0].lookId;
  const alternatives = (Array.isArray(baseConclusion.alternatives) ? baseConclusion.alternatives : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, 2);
  const others = ranking.filter((r) => r.lookId !== pick).map((r) => r.lookId);
  if (!alternatives.length && others.length) {
    alternatives.push(`想换个感觉可以试 ${others[0]}`);
  }

  return {
    ranking,
    details,
    conclusion: {
      pick,
      reason:
        (typeof baseConclusion.reason === 'string' && baseConclusion.reason.trim()) ||
        '综合场合、比例与风格统一度，这套是本次最稳的选择。',
      alternatives: alternatives.length ? alternatives : ['其余几套也都能穿，只是适配面窄一些'],
      tip:
        (typeof baseConclusion.tip === 'string' && baseConclusion.tip.trim()) ||
        '出门前把容易起皱的位置顺一下，整体会更精神。',
    },
  };
}

/* ------------------------------------------------------------ 应答构造 */

/** 同一次请求内按 lookId 缓存 5 维分数，保证 overall 与维度用的是同一组值 */
function scoresForLook(ctx, lookId) {
  if (!ctx.__dims) ctx.__dims = new Map();
  const key = `${lookId}|${ctx.state ?? ''}`;
  if (!ctx.__dims.has(key)) ctx.__dims.set(key, dimensionScoresFor(lookId, ctx.state ?? ''));
  return ctx.__dims.get(key);
}

function buildScoreAnswer(q, ctx) {
  const lookId = questionLookId(q, ctx);
  const id = String(q?.id ?? '');
  let score;
  if (SCORE_DIMENSION_IDS.includes(id)) {
    // 5 个维度：独立种子（确定性）
    score = scoresForLook(ctx, lookId)[id];
  } else if (id === 'overall_score') {
    // 综合分：由上面 5 维加权聚合而来，保证与维度分自洽（见 composeOverallScore 注释）
    score = composeOverallScore(lookId, ctx.state, scoresForLook(ctx, lookId));
  } else {
    // 其它自定义 score 维度：退回独立确定性分数
    score = deterministicScore(`${lookId}|${ctx.state ?? ''}|${id}`);
  }
  return {
    id: q.id,
    type: 'score',
    score,
    // SPEC §7.3：System One 响应不得含解释性文本 → content 恒为空串（无展示价值）
    content: '',
    confidence: deterministicConfidence(`${lookId}|${ctx.state ?? ''}|${id}`),
  };
}

function buildDescribeAnswer(q, ctx) {
  const lookId = questionLookId(q, ctx);
  let text;
  if (ctx.model === 'test-unrecognizable') {
    text = UNRECOGNIZABLE_DESCRIPTION;
  } else if (ctx.model === 'test-partial-fail' && lookId === 'look1') {
    text = '';
  } else {
    text = descriptionFor(lookId);
  }
  return {
    id: q.id,
    type: 'text',
    content: text,
    confidence: deterministicConfidence(`describe|${lookId}|${ctx.state ?? ''}`),
  };
}

function buildDeepAnswer(q, ctx) {
  const lookIds = resolveLookIds(ctx);
  const report = buildDeepReport(lookIds);
  return {
    id: q.id,
    type: 'text',
    content: JSON.stringify(report),
    confidence: 0.9,
  };
}

function buildAnswers(questions, ctx) {
  const out = [];
  questions.forEach((q, i) => {
    const qq = { ...q, __i: i };
    const id = String(q?.id ?? '');
    if (id === 'deep_report' || id.startsWith('deep_')) {
      out.push(buildDeepAnswer(qq, ctx));
      return;
    }
    if (id.startsWith('describe_')) {
      out.push(buildDescribeAnswer(qq, ctx));
      return;
    }
    if (SCORE_QUESTION_IDS.includes(id) || /(^|_)score$/.test(id)) {
      out.push(buildScoreAnswer(qq, ctx));
      return;
    }
    // 未知 id：SPEC §1.3「未知 id 的答案忽略」→ 不返回该条
  });
  return out;
}

/* --------------------------------------------------------------- HTTP */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
  'Access-Control-Max-Age': '600',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...CORS_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), JSON_HEADERS);
}

const SCORE_SENTINEL = '__OD_FIXED__';

/**
 * SPEC §1.3 要求 score「保留 1 位小数」。JSON.stringify(3.0) 输出 `3`，
 * 数值等价但线格式不满足"1 位小数"，故把 score 字段强制序列化成 `3.0` 形态。
 * 生成结果仍是合法 JSON（JSON.parse 回来与原数值全等）。
 */
export function stringifyFixedScores(obj) {
  const text = JSON.stringify(obj, (key, value) =>
    key === 'score' && typeof value === 'number' ? `${SCORE_SENTINEL}${value.toFixed(1)}` : value,
  );
  return text.replace(/"__OD_FIXED__(\d+\.\d)"/g, '$1');
}

function sendAskJson(res, status, obj) {
  send(res, status, stringifyFixedScores(obj), JSON_HEADERS);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const SPEC_DOC = {
  version: 'v1',
  protocol: 'JEv / Laya shared wire format (SPEC §1.3)',
  request: {
    method: 'POST',
    path: '/ask',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {apiKey} (JEv only)' },
    body: {
      model: 'string, required',
      state: 'string, required (SPEC §3.2 拼接规则)',
      questions: [{ id: 'string', type: 'score|text', question: 'string' }],
      images: [{ id: 'lookN', dataUri: 'data:image/jpeg;base64,...' }],
    },
  },
  response: {
    model: 'string',
    answers: [
      { id: 'string', type: 'score|text', score: 'number [0,5] 1 decimal (score only)', content: 'string', confidence: 'number [0,1], default 0.5' },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  },
  scoreQuestionIds: SCORE_QUESTION_IDS,
  describeQuestionIdPattern: 'describe_lookN',
  deepQuestionId: 'deep_report',
  faults: FAULT_MODELS,
  endpoints: { health: 'GET /health', spec: 'GET /spec', ask: 'POST /ask' },
};

export function createMockServer() {
  const startedAt = Date.now();
  const serverModel = process.env.MOCK_MODEL || DEFAULT_MODEL;
  const timeoutMs = Number(process.env.MOCK_TIMEOUT_MS || 30000);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      sendJson(res, 200, {
        ok: true,
        model: serverModel,
        uptime: Math.round((Date.now() - startedAt) / 1000),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/spec') {
      sendJson(res, 200, SPEC_DOC);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/ask') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: { message: 'invalid json body' } });
        return;
      }
      if (!body || !Array.isArray(body.questions)) {
        sendJson(res, 400, { error: { message: 'questions array required' } });
        return;
      }

      const model = typeof body.model === 'string' && body.model ? body.model : serverModel;

      // ---- 故障注入（按 model 字段，无全局开关） ----
      if (model === 'test-auth-fail') {
        sendJson(res, 401, { error: { message: 'invalid api key' } });
        process.stdout.write(`[mock] ${route} model=test-auth-fail -> 401\n`);
        return;
      }
      if (model === 'test-server-error') {
        sendJson(res, 500, { error: { message: 'internal model error' } });
        process.stdout.write(`[mock] ${route} model=test-server-error -> 500\n`);
        return;
      }
      if (model === 'test-parse-fail') {
        send(res, 200, 'not-json', { 'Content-Type': 'text/plain; charset=utf-8' });
        process.stdout.write(`[mock] ${route} model=test-parse-fail -> 200 text/plain\n`);
        return;
      }
      if (model === 'test-timeout') {
        process.stdout.write(`[mock] ${route} model=test-timeout -> hang ${timeoutMs}ms\n`);
        await new Promise((r) => setTimeout(r, timeoutMs));
      }

      const ctx = {
        model,
        state: typeof body.state === 'string' ? body.state : '',
        images: Array.isArray(body.images) ? body.images : [],
      };
      const answers = buildAnswers(body.questions, ctx);
      const stateLen = ctx.state.length;
      const payload = {
        model,
        answers,
        usage: {
          prompt_tokens: 64 + stateLen,
          completion_tokens: 16 * answers.length,
          total_tokens: 64 + stateLen + 16 * answers.length,
        },
      };
      sendAskJson(res, 200, payload);
      process.stdout.write(
        `[mock] ${route} model=${model} q=${body.questions.length} a=${answers.length} stateLen=${stateLen} images=${ctx.images.length}\n`,
      );
      return;
    }

    sendJson(res, 404, { error: { message: `no route for ${route}` } });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '0.0.0.0';
  const server = createMockServer();
  server.listen(port, host, () => {
    process.stdout.write(`mock listening on ${host}:${port}\n`);
  });
  server.on('error', (err) => {
    process.stderr.write(`[mock] listen error: ${err.code || err.message}\n`);
    process.exit(1);
  });
}
