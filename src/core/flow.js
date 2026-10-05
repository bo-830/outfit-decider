// SPEC §3.6 · 唯一状态机（纯 reducer）。禁止 import react / react-native / expo。
// 状态：接口骨架（Lead 冻结签名）。实现由 t-A 负责。

import { notImplemented } from './_todo.js';

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
  userState: { occasion: [], weather: [], style: [], note: '' },
  question: { builtinId: null, text: '' },
  descriptions: {},
  quick: null,
  deep: null,
  error: null,
  weakNetwork: false,
  compareOpen: false,
};

export function flowReducer(_state, _action) { return notImplemented('flow.flowReducer'); }

export function selectRankedLooks(_state) { return notImplemented('flow.selectRankedLooks'); }

export function selectDeepFor(_state, _lookId) { return notImplemented('flow.selectDeepFor'); }
