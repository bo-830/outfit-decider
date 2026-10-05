// SPEC §3.5 · state 上下文与输入校验。纯逻辑层，禁止 import react / react-native / expo。

import { HINTS } from '../data/copy.js';
import { ENUM_ORDER, labelsOf } from '../data/options.js';
import { MAX_LOOKS } from './protocol.js';

/** SPEC §1.1 · 每次返回全新对象，避免共享引用被意外改写。 */
export function emptyUserState() {
  return { occasion: [], weather: [], style: [], note: '' };
}

/**
 * SPEC §3.5 · 选中则移除、未选则追加；保持枚举顺序（occasion→weather→style 的声明顺序），去重。
 * 未知 id 排在有序列项之后（保持相对插入顺序）。
 */
export function toggle(list, id) {
  const current = Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
  const exists = current.includes(id);
  const next = exists ? current.filter((item) => item !== id) : [...current, id];
  const unique = [];
  for (const item of next) if (!unique.includes(item)) unique.push(item);
  return unique
    .map((item, index) => ({ item, index, order: ENUM_ORDER[item] ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => (a.order === b.order ? a.index - b.index : a.order - b.order))
    .map((entry) => entry.item);
}

/**
 * SPEC §3.5 / §5.3 ·
 * - 无图 → ok=false，missing 含 'images'，hint「先选 1-4 张穿搭照片吧」
 * - >4 张 → ok=false，hint「一次最多 4 套穿搭哦」
 * - 无场合且无问题 → ok=true 但 hint 提示补充，不阻塞
 * - 只有 1 套 → ok=true，hint 提示两套以上才能比出高下
 */
export function validateInput({ artifacts, state, question } = {}) {
  const list = Array.isArray(artifacts) ? artifacts.filter(Boolean) : [];
  const current = state && typeof state === 'object' ? state : emptyUserState();
  const missing = [];
  const hints = [];

  const hasImages = list.length > 0;
  if (!hasImages) {
    missing.push('images');
    hints.push(HINTS.missingImages);
  }
  if (list.length > MAX_LOOKS) hints.push(HINTS.tooManyImages);

  const occasion = Array.isArray(current.occasion) ? current.occasion.filter(Boolean) : [];
  const questionText = typeof (question && question.text) === 'string' ? question.text.trim() : '';
  if (hasImages) {
    if (occasion.length === 0 && questionText === '') hints.push(HINTS.needContext);
    if (list.length === 1) hints.push(HINTS.oneLook);
  }

  const ok = hasImages && list.length <= MAX_LOOKS;
  return { ok, missing, hints, canRunQuick: ok, canRunDeep: ok };
}

/** SPEC §3.5 · '通勤上班 · 凉爽 · 简约干练'（空组省略，用 ' · ' 连接）。 */
export function stateSummary(state) {
  const current = state && typeof state === 'object' ? state : {};
  const groups = [current.occasion, current.weather, current.style]
    .map((ids) => labelsOf(ids).join('、'))
    .filter((text) => text !== '');
  return groups.join(' · ');
}
