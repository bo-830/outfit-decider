// SPEC §3.1 · JEv / Laya 线上协议：构造、解析、校验、排序。
// 本文件属纯逻辑层：禁止 import react / react-native / expo。
// 状态：接口骨架（由 Lead 冻结签名）。实现由 t-A 负责，实现时删除 `notImplemented` 调用。

import { notImplemented } from './_todo.js';

export const SCORE_QUESTION_IDS = [
  'overall_score',
  'aesthetic_score',
  'scene_score',
  'figure_score',
  'style_score',
  'practical_score',
];
export const MAX_LOOKS = 4;
export const SCORE_DECIMALS = 1;

export function clampScore(_n) { return notImplemented('protocol.clampScore'); }

export function toDataUri(_artifact) { return notImplemented('protocol.toDataUri'); }

export function buildRequest(_input) { return notImplemented('protocol.buildRequest'); }

export function buildScoreAnswers(_answers) { return notImplemented('protocol.buildScoreAnswers'); }

export function parseScoreAnswer(_raw) { return notImplemented('protocol.parseScoreAnswer'); }

export function isScoreAnswerStrict(_raw) { return notImplemented('protocol.isScoreAnswerStrict'); }

export function rankLooks(_rows) { return notImplemented('protocol.rankLooks'); }
