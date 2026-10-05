// SPEC §3.2 · 提示词与请求问题构造。纯逻辑层，禁止 import react / react-native / expo。
// 状态：接口骨架（Lead 冻结签名）。实现由 t-A 负责。

import { notImplemented } from './_todo.js';

export const DESCRIBE_SYSTEM_PROMPT = '';
export const DESCRIBE_USER_PROMPT = '';
export const DEEP_SYSTEM_PROMPT = '';
export const DEEP_USER_TEMPLATE = '';

export function buildDescribeQuestions(_lookId) { return notImplemented('prompts.buildDescribeQuestions'); }

export function buildSyntheticStateText(_input) { return notImplemented('prompts.buildSyntheticStateText'); }

export function buildScoreQuestions(_input) { return notImplemented('prompts.buildScoreQuestions'); }

export function scoreRubric(_questionId) { return notImplemented('prompts.scoreRubric'); }

export function buildDeepUserText(_input) { return notImplemented('prompts.buildDeepUserText'); }

export function relevantScoreDimensions(_input) { return notImplemented('prompts.relevantScoreDimensions'); }
