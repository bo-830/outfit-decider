// SPEC §3.10 · 网络层：JEv 云端 / Laya 局域网双模式适配，统一 JSON 契约与错误分类。
// 状态：接口骨架（Lead 冻结签名）。实现由 t-A 负责。
// 铁律：API Key 绝不进入异常 message、日志、window.__OD_PROBE__ 或验证报告（用 redactConfig 过一层）。

import { notImplemented } from '../core/_todo.js';

export const DEFAULT_CONFIG = {
  mode: 'jev',
  baseUrl: 'http://127.0.0.1:8787',
  askPath: '/ask',
  healthPath: '/health',
  model: 'outfit-judge-v1',
  apiKey: '',
  timeoutMs: 45000,
  quickTimeoutMs: 20000,
};

export function normalizeBaseUrl(_url) { return notImplemented('api.normalizeBaseUrl'); }

export function makeApi(_deps) { return notImplemented('api.makeApi'); }

export function classifyError(_err) { return notImplemented('api.classifyError'); }

export function redactConfig(_config) { return notImplemented('api.redactConfig'); }
