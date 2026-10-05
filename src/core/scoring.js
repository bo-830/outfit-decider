// SPEC §3.3 · 排序与汇总。纯逻辑层，禁止 import react / react-native / expo。
// 状态：接口骨架（Lead 冻结签名）。实现由 t-A 负责。

import { notImplemented } from './_todo.js';

export function rankLooks(_rows) { return notImplemented('scoring.rankLooks'); }

export function computeConfidence(_scores, _confidences) { return notImplemented('scoring.computeConfidence'); }

export function summarize(_scores) { return notImplemented('scoring.summarize'); }

export function meetsMinQuality(_parsedAnswers) { return notImplemented('scoring.meetsMinQuality'); }
