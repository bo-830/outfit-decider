// SPEC §3.6 · 唯一状态机（纯 reducer）。禁止 import react / react-native / expo。
//
// 语义约定（SPEC 未逐条写明处，此处定死，UI 与测试都以此为准）：
// 1. 只有 SET_ARTIFACTS / RESET_RUN / RESET_ALL 会改动 artifacts；换图会作废本次结果。
// 2. TOGGLE_STATE / SET_NOTE / SET_QUESTION / CLEAR_QUESTION 只改上下文，不动已有结果。
// 3. QUICK_FAIL / DEEP_FAIL / SET_ERROR → phase='error'（quick 结果保留，供结果页继续展示）。
// 4. CLEAR_ERROR 回到有数据的那一相：deep 有 → 'deep_done'；quick 有 → 'quick_done'；否则 'idle'。
// 5. RESET_RUN 按 §4.1 清空图片引用与结果，保留 descriptions 与用户上下文。

import { BUILTIN_QUESTIONS } from '../data/options.js';
import { emptyUserState, toggle } from './state.js';

/**
 * SPEC §3.13 v1.7 · 用户这次要跑哪个系统。
 *
 * 两个系统是**并列**的：System One 出 6 维分数，System Two 出三段式深度报告；
 * 深度分析自带排序、不依赖快速分，所以必须允许单独跑（用户明确提出）。
 *
 * 非法/缺失值一律回退 'quick'：需求原文要求默认优先走 System One，且它最便宜；
 * 宁可跑便宜的那个，也不要因为一个错值而什么都不跑。
 */
export const SYSTEM_MODES = ['quick', 'deep', 'both'];

export function normalizeSystemMode(value) {
  return SYSTEM_MODES.includes(value) ? value : 'quick';
}

export const FLOW_PHASES = [
  'idle',
  'describing',
  'scoring',
  'quick_done',
  'deep_running',
  'deep_done',
  'error',
];

export const initialFlowState = {
  phase: 'idle',
  artifacts: [],
  userState: emptyUserState(),
  question: { builtinId: null, text: '' },
  descriptions: {},
  quick: null,
  deep: null,
  error: null,
  weakNetwork: false,
  compareOpen: false,
};

const STATE_GROUPS = ['occasion', 'weather', 'style'];
const NOTE_MAX_LENGTH = 200;

export function flowReducer(state, action) {
  const current = state && typeof state === 'object' ? state : initialFlowState;
  const type = action && action.type;

  switch (type) {
    case 'SET_ARTIFACTS': {
      // 语义：**替换**为给定的整份图片列表（调用方负责把"追加"算好再传进来）。
      // 分次选图的追加逻辑在 App.jsx（它能看到当前 artifacts 与已用 lookId）；
      // 这里只管状态一致性：换图会作废本次结果与描述。
      const artifacts = Array.isArray(action.artifacts) ? action.artifacts.slice() : [];
      // 临时诊断：区分"调用方没累加"和"累加了却被别处覆盖"。稳定后删除。
      console.log(
        `[ODSET] in=${artifacts.length} ids=${artifacts.map((a) => a && a.lookId).join(',')} `
        + `prev=${Array.isArray(current.artifacts) ? current.artifacts.length : 0} phase=${current.phase}`,
      );
      const changed = !sameLookIds(current.artifacts, artifacts);
      if (!changed) return { ...current, artifacts };
      return {
        ...current,
        artifacts,
        descriptions: {},
        quick: null,
        deep: null,
        error: null,
        phase: 'idle',
      };
    }

    case 'TOGGLE_STATE': {
      const group = STATE_GROUPS.includes(action.group) ? action.group : null;
      if (!group) return { ...current };
      const userState = current.userState && typeof current.userState === 'object'
        ? current.userState
        : emptyUserState();
      return {
        ...current,
        userState: { ...userState, [group]: toggle(userState[group], action.id) },
      };
    }

    case 'SET_NOTE': {
      const userState = current.userState && typeof current.userState === 'object'
        ? current.userState
        : emptyUserState();
      // SPEC §1.1「trim 后长度 ≤ 200」：先按字符上限截断（防超长），**不在这里 trim**。
      // 原因：输入框是受控 multiline，逐键 dispatch SET_NOTE，若在此 trim 则用户永远打不出
      // 空格/换行（尾随空白被实时吃掉）。真正的 trim 发生在消费端（buildSyntheticStateText /
      // validateInput / 发送前的 stateSummary），那里按「trim 后长度」校验。
      const note = typeof action.note === 'string'
        ? action.note.slice(0, NOTE_MAX_LENGTH)
        : '';
      return { ...current, userState: { ...userState, note } };
    }

    case 'SET_QUESTION': {
      const builtin = BUILTIN_QUESTIONS.find((item) => item.id === action.builtinId) || null;
      const text = typeof action.text === 'string' && action.text !== ''
        ? action.text
        : (builtin ? builtin.text : '');
      return { ...current, question: { builtinId: builtin ? builtin.id : null, text } };
    }

    case 'CLEAR_QUESTION':
      return { ...current, question: { builtinId: null, text: '' } };

    case 'RUN_QUICK_START':
      return {
        ...current,
        phase: 'describing',
        descriptions: {},
        quick: null,
        deep: null,
        error: null,
      };

    case 'SET_DESCRIPTIONS':
      return {
        ...current,
        phase: 'scoring',
        descriptions: { ...(action.descriptions || {}) },
      };

    case 'QUICK_DONE':
      return {
        ...current,
        phase: 'quick_done',
        quick: {
          ranked: Array.isArray(action.ranked) ? action.ranked : [],
          usage: action.usage || null,
          model: action.model || null,
          // SPEC §3.9c：结论来源必须随结果一起留存，**不能**在渲染时读当前配置——
          // 用户跑完再改设置档位，旧结果就会被错误地标成新档位（等于说谎）。
          engineMode: action.engineMode || null,
          reviewModel: action.reviewModel || null,
          reviewedAt: action.reviewedAt || null,
          // 纠正失败时 §3.9c 约定回退到 Laya 原分，界面必须能如实说明这一点
          reviewFailed: action.reviewFailed === true,
          reviewErrorKind: action.reviewErrorKind || null,
          // orchestrator 用 reviewChanged，界面层可能叫 reviewChange；两个都收，避免命名漂移
          reviewChanged: action.reviewChanged || action.reviewChange || null,
          reviewFailedLooks: action.reviewFailedLooks || null,
        },
        error: null,
      };

    case 'QUICK_FAIL':
      return { ...current, phase: 'error', error: withLookId(action.error, action.lookId) };

    case 'RUN_DEEP_START':
      return {
        ...current,
        phase: 'deep_running',
        error: null,
        deep: current.deep && typeof current.deep === 'object' ? { ...current.deep } : {},
      };

    case 'DEEP_DONE':
      return {
        ...current,
        phase: 'deep_done',
        deep: { ...(current.deep || {}), [action.lookId]: action.report },
        error: null,
      };

    case 'DEEP_FAIL':
      return { ...current, phase: 'error', error: withLookId(action.error, action.lookId) };

    case 'SET_ERROR':
      return { ...current, phase: 'error', error: withLookId(action.error, action.lookId) };

    case 'CLEAR_ERROR':
      return { ...current, phase: settlePhase(current), error: null };

    case 'SET_WEAK':
      return { ...current, weakNetwork: action.flag === true };

    case 'TOGGLE_COMPARE':
      return { ...current, compareOpen: !current.compareOpen };

    case 'RESET_RUN':
      return {
        ...current,
        phase: 'idle',
        artifacts: [],
        descriptions: { ...(current.descriptions || {}) },
        quick: null,
        deep: null,
        error: null,
      };

    case 'RESET_ALL':
      return freshInitialState();

    default:
      return { ...current };
  }
}

/** SPEC §3.6 · state.quick?.ranked ?? [] */
export function selectRankedLooks(state) {
  const ranked = state && state.quick && state.quick.ranked;
  return Array.isArray(ranked) ? ranked : [];
}

/** SPEC §3.6 · 该套的深度报告 | null */
export function selectDeepFor(state, lookId) {
  const deep = state && state.deep;
  if (!deep || typeof deep !== 'object') return null;
  return deep[lookId] || null;
}

/**
 * SPEC §3.13b v1.7 · 结果页要展示的"套"列表 —— **优先 System One，缺失时回落到 System Two**。
 *
 * 为什么需要它：用户可以直接只跑深度分析（`systemMode='deep'`），那时 `flow.quick` 是空的，
 * 而深度报告挂在结果卡片里、卡片又只按 `flow.quick.ranked` 渲染 →
 * 跑完 deep 却看到「还没有分数」的空态（实测缺口）。
 *
 * 回落时把深度报告的 `stars`（0-5，System Two 的判断）映射成卡片的 `overall` 显示值。
 * **必须同时把 `source` 标成 'deep'**，让界面如实标注"这个结论来自深度分析"，
 * 绝不能让它看起来像是 System One 的六维分（那会混淆两个系统的口径）。
 */
export function selectResultLooks(state) {
  const quickRanked = selectRankedLooks(state);
  if (quickRanked.length) return quickRanked;

  const reports = state && state.deep;
  if (!reports || typeof reports !== 'object') return [];

  // 以各报告自己的 ranking 定序与定星（报告自带排序，不依赖 quick）
  const seen = new Set();
  const looks = [];
  for (const lookId of Object.keys(reports)) {
    const report = reports[lookId];
    if (!report || typeof report !== 'object' || seen.has(lookId)) continue;
    seen.add(lookId);

    let stars = null;
    const ranking = Array.isArray(report.ranking) ? report.ranking : [];
    const row = ranking.find((item) => item && item.lookId === lookId) || ranking[0];
    if (row && Number.isFinite(row.stars)) stars = row.stars;

    looks.push({
      lookId,
      rank: null, // 下面按 stars 重排后再填
      overall: stars,
      scores: {}, // 深度分析没有六维分，不伪造
      relevance: null,
      source: 'deep',
    });
  }
  if (!looks.length) return [];

  // 与 SPEC §3.3 同口径：按分数降序，null 最后，同分按 lookId 升序
  looks.sort((a, b) => {
    const av = a.overall === null ? -1 : a.overall;
    const bv = b.overall === null ? -1 : b.overall;
    if (bv !== av) return bv - av;
    return String(a.lookId).localeCompare(String(b.lookId));
  });
  return looks.map((look, index) => ({ ...look, rank: index + 1 }));
}

function freshInitialState() {
  return {
    phase: 'idle',
    artifacts: [],
    userState: emptyUserState(),
    question: { builtinId: null, text: '' },
    descriptions: {},
    quick: null,
    deep: null,
    error: null,
    weakNetwork: false,
    compareOpen: false,
  };
}

function settlePhase(state) {
  if (state.deep && Object.keys(state.deep).length) return 'deep_done';
  if (state.quick) return 'quick_done';
  return 'idle';
}

function withLookId(error, lookId) {
  const base = error && typeof error === 'object'
    ? { ...error }
    : (error == null ? null : { kind: 'server', message: String(error) });
  if (base === null) return null;
  return { ...base, lookId: lookId === undefined ? null : lookId };
}

function sameLookIds(a, b) {
  const left = Array.isArray(a) ? a.map((item) => item && item.lookId) : [];
  const right = Array.isArray(b) ? b.map((item) => item && item.lookId) : [];
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}
