// SPEC §3.5 · state 上下文与输入校验。纯逻辑层，禁止 import react / react-native / expo。
// 状态：接口骨架（Lead 冻结签名）。实现由 t-A 负责。

import { notImplemented } from './_todo.js';

export function emptyUserState() { return notImplemented('state.emptyUserState'); }

export function toggle(_list, _id) { return notImplemented('state.toggle'); }

export function validateInput(_input) { return notImplemented('state.validateInput'); }

export function stateSummary(_state) { return notImplemented('state.stateSummary'); }
