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

/* ------------------------------------------- 规范上下文（两套引擎同源的关键）
 *
 * System One 的 score 请求与 System Two 的 deep 请求**state 文本形状不同**：
 *   score: 【穿搭一】\n整体风格：…\n\n【我的场合】通勤上班\n【我的天气】凉爽\n【我的风格偏好】简约干练\n\n【我的问题】…
 *   deep : 我的上下文：通勤上班 · 凉爽 · 简约干练\n\n我的问题：…\n\n请按系统指令要求的 JSON 结构输出报告。
 * 若直接拿 state 原文当种子，两个引擎会对同一套算出**不同的分数**，同一屏上就会出现
 * 「左边说第 4 套第一、右边说第 4 套最差」这种产品级矛盾。
 * 这里把两种形状投影成同一个 canonicalContext（枚举文案唯一，见 SPEC §1.2），
 * 保证 System One 与 System Two 在同一用户上下文下算出完全相同的分与排名。
 */

const OCCASION_LABELS = ['通勤上班', '约会见面', '闺蜜聚餐', '正式面试', '逛街出游', '运动健身'];
const WEATHER_LABELS = ['炎热', '凉爽', '寒冷', '雨天', '大风'];
const STYLE_LABELS = ['简约干练', '温柔甜美', '酷飒休闲', '知性优雅', '元气少女'];

function firstMatch(text, re) {
  const m = re.exec(text);
  return m ? m[1].trim() : '';
}

/** 把任意一种 state 文本投影成 `场合|天气|风格|问题` 规范串（两种模板结果一致） */
export function canonicalContext(state) {
  const s = String(state || '');
  let occasion = firstMatch(s, /【我的场合】([^\n【]*)/);
  let weather = firstMatch(s, /【我的天气】([^\n【]*)/);
  let style = firstMatch(s, /【我的风格偏好】([^\n【]*)/);
  let question = firstMatch(s, /【我的问题】([^\n【]*)/);

  // deep 模板形状：'我的上下文：通勤上班 · 凉爽 · 简约干练'（空组会被 stateSummary 省略，
  // 所以按枚举文案归类 token，而不是按下标猜）
  if (!occasion && !weather && !style) {
    const ctx = firstMatch(s, /我的上下文：([^\n]*)/);
    for (const token of ctx.split('·').map((t) => t.trim()).filter(Boolean)) {
      if (!occasion && OCCASION_LABELS.includes(token)) occasion = token;
      else if (!weather && WEATHER_LABELS.includes(token)) weather = token;
      else if (!style && STYLE_LABELS.includes(token)) style = token;
    }
  }
  if (!question) question = firstMatch(s, /我的问题：([^\n]*)/);

  const norm = (v) => (v && v !== '未指定' ? v.replace(/[、,]/g, '+') : '');
  return {
    occasion: norm(occasion),
    weather: norm(weather),
    style: norm(style),
    question: norm(question),
    key: `${norm(occasion)}|${norm(weather)}|${norm(style)}|${norm(question)}`,
  };
}

/** state 里是否给出了非空场合（两种模板都认） */
export function hasOccasion(state) {
  return canonicalContext(state).occasion !== '';
}

/** 5 个维度分（确定性，且与 System Two 同源） */
export function dimensionScoresFor(lookId, state) {
  const basis = canonicalContext(state).key;
  const out = {};
  for (const dim of SCORE_DIMENSION_IDS) out[dim] = deterministicScore(`${lookId}|${basis}|${dim}`);
  return out;
}

/** overall = 加权平均(5 维) + 确定性小偏移，钳到 [2,5] 并保留 1 位小数 */
export function composeOverallScore(lookId, state, dims) {
  const basis = canonicalContext(state).key;
  const w = hasOccasion(state) ? WEIGHTS_WITH_OCCASION : WEIGHTS_NO_OCCASION;
  let acc = 0;
  let wsum = 0;
  for (const dim of SCORE_DIMENSION_IDS) {
    acc += dims[dim] * w[dim];
    wsum += w[dim];
  }
  const weightedMean = acc / wsum;
  const offset = ((fnv1a(`${lookId}|${basis}|overall_score`) % 41) - 20) / 100; // -0.20 .. +0.20
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

function fallbackDeepFor(sortedIds) {
  const four = ['look1', 'look2', 'look3', 'look4'];
  const isFour = sortedIds.length === 4 && four.every((id) => sortedIds.includes(id));
  return isFour ? FALLBACK_DEEP_4 : FALLBACK_DEEP_2;
}

/* ------------------------------------------------- 深度报告（§3.9，分数派生）
 *
 * 产品级要求：System One 与 System Two 在**同一用户上下文**下必须给出同向结论。
 * 因此 deep 报告的排名不再照搬静态 fixture（那会导致"左栏说第 4 套第一、
 * 右栏说第 4 套最差"），而是：
 *   1. 用与 System One **完全相同的种子与聚合公式**算出每套的 5 维分与 overall；
 *   2. ranking 顺序 = overall 降序、同分 lookId 升序（与 §3.3 逐字一致），
 *      所以 deep 的第一名恒等于 System One 的第一名；
 *   3. stars 由 overall 在本次集合内的相对位置**单调**映射到 2.5–4.5（0.5 步进）；
 *   4. oneLineReason 由该套**真实最强/最弱维度**生成，不会出现"给它低分却夸它"；
 *   5. details 顺序跟随 ranking，5 个维度名与顺序恒定（§3.9 schema 不破）。
 * fixtures/deep/*.json 仍作为**文案片段来源**（pros/cons/suggestions 的具体措辞），
 * 但只在该片段不与派生强弱冲突时采用；缺文件时用内置兜底文案。
 */

const DEEP_DIM_ORDER = [
  ['场合适配度', 'scene_score'],
  ['美观度', 'aesthetic_score'],
  ['身材友好度', 'figure_score'],
  ['风格统一度', 'style_score'],
  ['实用舒适度', 'practical_score'],
];
const DIM_LABEL = Object.fromEntries(DEEP_DIM_ORDER.map(([name, key]) => [key, name]));

/** 贴到 0.5 步进并钳到 [0,5] */
function clampHalf(v) {
  return Math.max(0, Math.min(5, Math.round(v * 2) / 2));
}

function detailOf(baseDetails, lookId) {
  return baseDetails.find((d) => d?.lookId === lookId) ?? null;
}

const SCENE_WORDS =
  /场合|正式|面试|通勤|约会|聚餐|出游|健身|餐厅|客户|随意|上班|会议|商务|礼服|见人|社交/;

export function buildDeepReport(lookIds, state = '') {
  const wanted = lookIds.length ? [...lookIds] : ['look1', 'look2'];

  // 1) 与 System One 同源：同样的种子基准、同样的聚合公式
  const scored = wanted.map((lookId) => {
    const dims = dimensionScoresFor(lookId, state);
    return { lookId, dims, overall: composeOverallScore(lookId, state, dims) };
  });

  // 2) 排序规则与 §3.3 一致 → 与 System One 的第一名必然相同
  scored.sort((a, b) => b.overall - a.overall || LOOK_IDS.indexOf(a.lookId) - LOOK_IDS.indexOf(b.lookId));

  // 3) stars：按 overall 相对位置单调映射（2.5..4.5，0.5 步进）
  const overalls = scored.map((r) => r.overall);
  const lo = Math.min(...overalls);
  const hi = Math.max(...overalls);
  const starsFor = (o) => (hi === lo ? 4 : clampHalf(2.5 + 2 * ((o - lo) / (hi - lo))));

  const occasion = hasOccasion(state);

  // 4) 由真实维度强弱生成一句话理由
  const reasonFor = (row, isPick) => {
    const entries = SCORE_DIMENSION_IDS.map((d) => ({ d, v: row.dims[d], label: DIM_LABEL[d] }));
    const best = entries.reduce((a, b) => (b.v > a.v ? b : a));
    const worst = entries.reduce((a, b) => (b.v < a.v ? b : a));
    const scene = row.dims.scene_score;
    if (isPick) {
      const fit = occasion
        ? scene >= 4
          ? '，和今天的场合最合拍'
          : scene <= 3.2
            ? '，场合上不算最抢眼，但整体平衡度最好'
            : '，各方面都不拖后腿'
        : '，配色与轮廓最协调';
      return `${best.label}最突出（${best.v.toFixed(1)} 分）${fit}。`;
    }
    if (occasion && scene <= 3.2) {
      return `${best.label}不错（${best.v.toFixed(1)} 分），但正式度偏弱（场合 ${scene.toFixed(1)} 分），今天的场合不太占优。`;
    }
    return `${best.label}不错（${best.v.toFixed(1)} 分），但${worst.label}偏弱（${worst.v.toFixed(1)} 分）。`;
  };

  // 5) 文案片段：优先 fixture，且丢弃与派生强弱冲突的场合类 caveat
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
  const baseDetails = Array.isArray(base?.details) ? base.details : [];

  const ranking = scored.map((row, i) => ({
    lookId: row.lookId,
    // SPEC §3.9：ranking 行的理由字段名恒为 oneLineReason
    stars: starsFor(row.overall),
    oneLineReason: reasonFor(row, i === 0),
  }));

  const details = scored.map((row) => {
    const raw = detailOf(baseDetails, row.lookId);
    const entries = SCORE_DIMENSION_IDS.map((d) => ({ d, v: row.dims[d], label: DIM_LABEL[d] }));
    const best = entries.reduce((a, b) => (b.v > a.v ? b : a));
    const worst = entries.reduce((a, b) => (b.v < a.v ? b : a));

    let pros = (Array.isArray(raw?.pros) ? raw.pros : []).filter((s) => typeof s === 'string' && s.trim());
    let cons = (Array.isArray(raw?.cons) ? raw.cons : []).filter((s) => typeof s === 'string' && s.trim());
    let suggestions = (Array.isArray(raw?.suggestions) ? raw.suggestions : []).filter(
      (s) => typeof s === 'string' && s.trim(),
    );
    // 与派生分冲突的场合类文本直接丢弃（避免"第一名旁边写正式场合不合适"）
    if (row.dims.scene_score >= 4) {
      cons = cons.filter((s) => !SCENE_WORDS.test(s));
      suggestions = suggestions.filter((s) => !SCENE_WORDS.test(s));
    }
    // 不足则用维度事实补齐，保证 §3.9 的条数下限
    while (pros.length < 2) {
      pros.push(
        pros.length === 0
          ? `${best.label}是这套最强的一项（${best.v.toFixed(1)} 分）`
          : `${entries[1].label}也有 ${entries[1].v.toFixed(1)} 分，整体不塌`,
      );
    }
    while (cons.length < 1) cons.push(`${worst.label}只有 ${worst.v.toFixed(1)} 分，是这套最弱的一环`);
    while (suggestions.length < 1) suggestions.push(`优先补强${worst.label}，换一件更贴合的单品整体会更稳`);

    return {
      lookId: row.lookId,
      dimensions: DEEP_DIM_ORDER.map(([name, key]) => ({ name, stars: clampHalf(row.dims[key]) })),
      pros: pros.slice(0, 3),
      cons: cons.slice(0, 2),
      suggestions: suggestions.slice(0, 3),
    };
  });

  // 6) conclusion.pick 恒等于 ranking 第一名（= System One 第一名）
  const pick = ranking[0].lookId;
  const pickRow = scored[0];
  const pickEntries = SCORE_DIMENSION_IDS.map((d) => ({ d, v: pickRow.dims[d], label: DIM_LABEL[d] }));
  const pickWorst = pickEntries.reduce((a, b) => (b.v < a.v ? b : a));
  const pickBest = pickEntries.reduce((a, b) => (b.v > a.v ? b : a));
  // 用户可见文案用「第 N 套」，不要露出 lookN 这种内部 id
  const cnLabel = (id) => `第 ${LOOK_IDS.indexOf(id) + 1} 套`;
  const others = ranking.slice(1, 3).map((r) => r.lookId);
  const alternatives = others.map(
    (id) => `想换个感觉可以看 ${cnLabel(id)}（深度评分 ${ranking.find((r) => r.lookId === id).stars} 星）`,
  );

  return {
    ranking,
    details,
    conclusion: {
      pick,
      reason: occasion
        ? `四套里${cnLabel(pick)}的综合分最高（${pickRow.overall.toFixed(1)} 分），${pickBest.label}最突出（${pickBest.v.toFixed(1)} 分），和今天的场合方向一致。`
        : `四套里${cnLabel(pick)}的综合分最高（${pickRow.overall.toFixed(1)} 分），${pickBest.label}最突出（${pickBest.v.toFixed(1)} 分），整体最协调。`,
      alternatives: alternatives.length ? alternatives : ['其余几套也都能穿，只是适配面窄一些'],
      tip: `出发前优先处理${pickWorst.label}这一项（本次 ${pickWorst.v.toFixed(1)} 分），调整最小、收益最明显。`,
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
  // 分数派生：mock 的 deep 排名与 System One 同源，保证两个引擎同向
  const report = buildDeepReport(lookIds, ctx.state ?? '');
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

    /**
     * SPEC §3.9b 的多模态通道对端：OpenAI 兼容的 /chat/completions。
     * 让 laya_review 档的「纠正」步骤能**离线**被端到端验收，不必每次烧真模型的额度。
     * 输出严格遵守纠正契约：只回 {"scores":[...]} 这一个 JSON，没有解释文字。
     */
    if (req.method === 'POST' && url.pathname === '/chat/completions') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: { message: 'invalid json body' } });
        return;
      }
      const model = typeof body.model === 'string' && body.model ? body.model : 'mock-vision';

      if (model === 'test-vision-fail') {
        sendJson(res, 500, { error: { message: 'vision upstream failed' } });
        return;
      }
      if (model === 'test-vision-garbage') {
        sendJson(res, 200, {
          model,
          choices: [{ message: { content: '抱歉，我无法完成这个请求。' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        return;
      }

      // 从 user content 里把 lookId 抠出来（content 可能是数组，第一项是 text）
      const userMessage = Array.isArray(body.messages)
        ? body.messages.find((m) => m && m.role === 'user')
        : null;
      const rawContent = userMessage ? userMessage.content : '';
      const promptText = Array.isArray(rawContent)
        ? rawContent.filter((part) => part && part.type === 'text').map((part) => part.text).join('\n')
        : String(rawContent || '');
      const imageParts = Array.isArray(rawContent)
        ? rawContent.filter((part) => part && part.type === 'image_url')
        : [];
      const lookIds = [...new Set(promptText.match(/look[1-4]/g) || [])].sort();

      // 关键：**故意把分数与 Laya 的原始分拉开**，这样门禁才能证明「纠正真的生效了」，
      // 而不是"纠正返回什么都没人看"。分数仍然确定性（同输入同输出）且自洽
      // （overall 由 5 维加权得来），避免出现「综合 5.0 / 美观 2.8」那种自相矛盾。
      const rows = lookIds.map((lookId) => {
        const dims = SCORE_DIMENSION_IDS.filter((id) => id !== 'overall_score');
        const scores = {};
        for (const id of dims) {
          // 用与 Laya 不同的种子前缀，保证两套引擎的数不一样
          scores[id] = deterministicScore(`review|${lookId}|${id}`);
        }
        // 权重按产品意图：场合适配度最高（与 System One 的口径一致，避免两个引擎方向相反）
        const weights = {
          aesthetic_score: 0.22, scene_score: 0.34, figure_score: 0.18, style_score: 0.14, practical_score: 0.12,
        };
        const overall = dims.reduce((sum, id) => sum + scores[id] * weights[id], 0);
        scores.overall_score = Math.round(overall * 10) / 10;
        // 按固定顺序输出（overall 在最前），保证线上字段顺序稳定
        // 注意：SCORE_DIMENSION_IDS 只含 5 个非 overall 维度，必须显式补上 overall
        const ordered = {};
        for (const id of ['overall_score', ...dims]) ordered[id] = scores[id];
        return { lookId, ...ordered };
      });
      sendJson(res, 200, {
        model,
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ scores: rows }) } }],
        usage: {
          prompt_tokens: Math.max(1, promptText.length),
          completion_tokens: 40 + rows.length * 20,
          total_tokens: Math.max(1, promptText.length) + 40 + rows.length * 20,
        },
        mock: { imageCount: imageParts.length, lookIds },
      });
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
