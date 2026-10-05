// SPEC §1.2 · 枚举唯一真源。id 与 label 必须与 SPEC §1.2 逐字一致，不得改写。
// 本文件属纯数据层：禁止 import react / react-native / expo（node --test 直接跑）。

export const OCCASIONS = [
  { id: 'commute', label: '通勤上班' },
  { id: 'date', label: '约会见面' },
  { id: 'friends', label: '闺蜜聚餐' },
  { id: 'interview', label: '正式面试' },
  { id: 'shopping', label: '逛街出游' },
  { id: 'sport', label: '运动健身' },
];

export const WEATHERS = [
  { id: 'hot', label: '炎热' },
  { id: 'cool', label: '凉爽' },
  { id: 'cold', label: '寒冷' },
  { id: 'rainy', label: '雨天' },
  { id: 'windy', label: '大风' },
];

export const STYLES = [
  { id: 'minimal', label: '简约干练' },
  { id: 'sweet', label: '温柔甜美' },
  { id: 'cool', label: '酷飒休闲' },
  { id: 'elegant', label: '知性优雅' },
  { id: 'youthful', label: '元气少女' },
];

export const BUILTIN_QUESTIONS = [
  { id: 'best_for_occasion', label: '哪套最适合今天的场合？', text: '哪套最适合今天的场合？' },
  { id: 'slimmer', label: '哪套更显瘦？', text: '哪套更显瘦？' },
  { id: 'photogenic', label: '哪套拍照更上镜？', text: '哪套拍照更上镜？' },
  { id: 'too_casual', label: '这套会不会太随意？', text: '这套会不会太随意？' },
  { id: 'style_fit', label: '哪套更符合我想要的风格？', text: '哪套更符合我想要的风格？' },
];

/** 三组 state chips 的枚举表，键名与 UserState 字段一致。 */
export const STATE_GROUPS = {
  occasion: OCCASIONS,
  weather: WEATHERS,
  style: STYLES,
};

/** 最多 4 套穿搭，lookId 顺序即上传顺序。 */
export const LOOK_IDS = ['look1', 'look2', 'look3', 'look4'];

/** 【穿搭一】…【穿搭四】用的中文序号。 */
export const CN_NUMERALS = ['一', '二', '三', '四'];

/** id → 枚举内序号（toggle 保序用）。未知 id 不在表内。 */
export const ENUM_ORDER = (() => {
  const order = {};
  let i = 0;
  for (const group of [OCCASIONS, WEATHERS, STYLES]) {
    for (const item of group) order[item.id] = i++;
  }
  return order;
})();

/** 取某个枚举项的 label；未知返回 ''。 */
export function labelOf(id) {
  for (const group of [OCCASIONS, WEATHERS, STYLES]) {
    for (const item of group) if (item.id === id) return item.label;
  }
  return '';
}

/** 把 id 数组转成 label 数组（跳过未知 id，保持入参顺序）。 */
export function labelsOf(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.map(labelOf).filter((label) => label !== '');
}

/** lookId → 1..4；非法返回 0。 */
export function lookIndex(lookId) {
  const index = LOOK_IDS.indexOf(lookId);
  return index < 0 ? 0 : index + 1;
}

/** 内置问题 id → 该条内置文案；未命中返回 null。 */
export function builtinQuestion(builtinId) {
  return BUILTIN_QUESTIONS.find((q) => q.id === builtinId) || null;
}
