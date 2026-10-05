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
      const artifacts = Array.isArray(action.artifacts) ? action.artifacts.slice() : [];
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
      const note = typeof action.note === 'string' ? action.note.slice(0, NOTE_MAX_LENGTH) : '';
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
