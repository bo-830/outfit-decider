// SPEC §3.2 · 提示词与请求问题构造。纯逻辑层，禁止 import react / react-native / expo。
// 硬约束：描述类提示词只允许客观描述，看不清写「未清晰显示」，禁止主观评价词。

import { CN_NUMERALS, labelsOf, lookIndex } from '../data/options.js';
import { UNRECOGNIZABLE_MARK } from '../data/copy.js';
import { SCORE_QUESTION_IDS } from './protocol.js';
import { stateSummary } from './state.js';

/** 结构化描述的 7 个维度（顺序即输出顺序，SPEC §3.2 合成文本也用它）。 */
export const DESCRIPTION_DIMENSIONS = [
  '整体风格',
  '上衣',
  '下装',
  '鞋履',
  '配饰',
  '身材视觉效果',
  '其他细节',
];

/** 6 个评分维度的中文名（深度的 5 维是它的子集）。 */
export const SCORE_DIMENSION_LABELS = {
  overall_score: '整体得分',
  aesthetic_score: '美观度',
  scene_score: '场合适配度',
  figure_score: '身材友好度',
  style_score: '风格统一度',
  practical_score: '实用舒适度',
};

/** 深度报告的固定 5 维。 */
export const DEEP_DIMENSION_NAMES = [
  '场合适配度',
  '美观度',
  '身材友好度',
  '风格统一度',
  '实用舒适度',
];

export const DESCRIBE_SYSTEM_PROMPT = [
  '你是穿搭照片的客观记录员，只转录照片里真实可见的衣物与搭配事实。',
  '必须遵守：',
  '1. 只写照片中看得见的信息，不做优劣判断、不表达主观感受、不写引导性结论、不补充照片里看不到的内容。',
  `2. 分不清、看不清或被遮挡的部位，一律写「${UNRECOGNIZABLE_MARK}」，不得猜测、不得编造。`,
  '3. 固定输出 7 行，每行格式为「维度名：内容」，维度名与顺序不得改动，不要输出任何多余文字。',
  '4. 每行用短句罗列可见事实：颜色 / 材质 / 版型 / 长度 / 图案 / 鞋型 / 饰品位置等。',
  '5. 不描述人物长相、身份、职业、年龄，也不给身高体重等照片无法确认的数据。',
].join('\n');

export const DESCRIBE_USER_PROMPT = [
  '请描述这张穿搭照片，严格按下面 7 个维度各输出一行，格式「维度名：内容」：',
  '整体风格：',
  '上衣：',
  '下装：',
  '鞋履：',
  '配饰：',
  '身材视觉效果：',
  '其他细节：',
].join('\n');

export const DEEP_SYSTEM_PROMPT = [
  '你是资深的穿搭顾问。基于用户上传的穿搭照片与其自述上下文，输出一份中文深度分析报告。',
  '只依据照片中可见的衣着事实与用户提供的文字上下文作答，绝不臆测文中未提及的身材、职业、年龄、收入或场合。',
  '语气要求：直接、具体、可执行；先给结论，再给依据；每句话都落到照片里看得到或用户说过的细节上；不使用浮夸营销语，也不重复用户的措辞凑字数。',
  '严格只输出一个 JSON 对象（不要 markdown 代码块、不要任何前后缀），结构如下：',
  '{',
  '  "ranking": [ { "lookId": "look1", "stars": 4.5, "oneLineReason": "一句话说明它排在这里的原因" } ],',
  '  "details": [',
  '    {',
  '      "lookId": "look1",',
  '      "dimensions": [',
  '        { "name": "场合适配度", "stars": 4.5 },',
  '        { "name": "美观度", "stars": 4.0 },',
  '        { "name": "身材友好度", "stars": 4.5 },',
  '        { "name": "风格统一度", "stars": 4.0 },',
  '        { "name": "实用舒适度", "stars": 3.5 }',
  '      ],',
  '      "pros": ["具体优点一", "具体优点二"],',
  '      "cons": ["具体不足一"],',
  '      "suggestions": ["具体改法一"]',
  '    }',
  '  ],',
  '  "conclusion": { "pick": "look1", "reason": "为什么是它", "alternatives": ["备选建议"], "tip": "一条最关键的出门提示" }',
  '}',
  '约束：',
  '- ranking 覆盖全部上传的套数，按 stars 从高到低排列；stars 取值 0-5，可用 0.5 步进。',
  '- details 的顺序与 ranking 一致；每套固定上面 5 个维度名，不得新增、改名或省略。',
  '- 每套 pros 2-3 条、cons 1-2 条、suggestions 1-3 条，每条不超过 40 字，且必须写出具体部位或具体做法。',
  '- conclusion.pick 必须是 ranking 中出现过的 lookId；alternatives 1-2 条；tip 一条。',
].join('\n');

export const DEEP_USER_TEMPLATE = [
  '我的上下文：{{STATE}}',
  '',
  '我的问题：{{QUESTION}}',
  '',
  '请按系统指令要求的 JSON 结构输出报告。',
].join('\n');

/** SPEC §3.7 · 图片描述问题，长度恒为 1。 */
export function buildDescribeQuestions(lookId) {
  const index = lookIndex(lookId);
  const label = index ? `第 ${index} 套穿搭（${lookId}）` : `穿搭（${lookId}）`;
  return [
    {
      id: `describe_${lookId}`,
      type: 'text',
      question: `${DESCRIBE_USER_PROMPT}\n本图是${label}。只输出这 7 行描述，不要输出任何解释或多余文字。`,
    },
  ];
}

/**
 * SPEC §3.2 · 合成 state 文本（段间 '\n\n'，空组省略对应行）：
 * 【穿搭一】\n整体风格：…；上衣：…；…\n\n【我的场合】…\n【我的天气】…\n…\n\n【我的问题】…
 * descriptions 支持 Record<LookId, string|{text}> 或 [{lookId, text}] 或 string[]。
 */
export function buildSyntheticStateText({ descriptions, userState, question } = {}) {
  const blocks = [];

  for (const entry of normalizeDescriptions(descriptions)) {
    const index = lookIndex(entry.lookId) || blocks.length + 1;
    const numeral = CN_NUMERALS[index - 1] || String(index);
    blocks.push(`【穿搭${numeral}】\n${renderDescription(entry.text)}`);
  }

  const stateLines = [];
  const occasion = labelsOf(userState && userState.occasion).join('、');
  const weather = labelsOf(userState && userState.weather).join('、');
  const style = labelsOf(userState && userState.style).join('、');
  const note = typeof (userState && userState.note) === 'string' ? userState.note.trim() : '';
  if (occasion) stateLines.push(`【我的场合】${occasion}`);
  if (weather) stateLines.push(`【我的天气】${weather}`);
  if (style) stateLines.push(`【我的风格偏好】${style}`);
  if (note) stateLines.push(`【补充说明】${note}`);
  if (stateLines.length) blocks.push(stateLines.join('\n'));

  const questionText = typeof (question && question.text) === 'string' ? question.text.trim() : '';
  if (questionText) blocks.push(`【我的问题】${questionText}`);

  return blocks.join('\n\n');
}

/**
 * SPEC §3.2 / §3.4 · 恒返回 6 个 score 问题，顺序恒为 SCORE_QUESTION_IDS 的顺序。
 * 相关问题只影响 UI 高亮，不影响本函数长度。
 */
export function buildScoreQuestions({ userState, question } = {}) {
  return SCORE_QUESTION_IDS.map((id) => ({
    id,
    type: 'score',
    question: [
      `${SCORE_DIMENSION_LABELS[id]}：结合 state 中这套穿搭的客观描述与我的上下文打分。`,
      scoreRubric(id),
      '只输出分数本身，不要输出任何文字说明。',
    ].join('\n'),
  }));
}

/** SPEC §3.2 · 该维度的 0-5 分级口径（可被测试断言）。 */
export function scoreRubric(questionId) {
  const anchor = RUBRIC_ANCHORS[questionId] || '该维度与我的场合、天气、风格偏好及问题的契合程度。';
  return `口径：${anchor} 打分标尺：0=完全不适合；1=很不合适；2=不太合适；3=一般；4=合适；5=非常合适。保留 1 位小数，允许 0.5 步进。`;
}

/** SPEC §3.2 · 填充 DEEP_USER_TEMPLATE。 */
export function buildDeepUserText({ userState, question } = {}) {
  const summary = stateSummary(userState) || '未指定';
  const note = typeof (userState && userState.note) === 'string' ? userState.note.trim() : '';
  const stateText = note ? `${summary}；补充说明：${note}` : summary;
  const questionText = typeof (question && question.text) === 'string' && question.text.trim()
    ? question.text.trim()
    : '没有特别的问题，请指出哪套最合适以及最需要注意的一点。';
  return DEEP_USER_TEMPLATE
    .split('{{STATE}}').join(stateText)
    .split('{{QUESTION}}').join(questionText);
}

/**
 * SPEC §3.4 · 内置问题 → 维度映射；自定义文本按关键词命中；未命中/未选择 → 全部 6 维。
 * 返回维度 id 数组（非空），顺序为映射表顺序。
 */
export function relevantScoreDimensions({ builtinId, text } = {}) {
  if (builtinId && BUILTIN_DIMENSION_MAP[builtinId]) {
    return [...BUILTIN_DIMENSION_MAP[builtinId]];
  }
  const source = typeof text === 'string' ? text : '';
  const hits = [];
  for (const rule of KEYWORD_DIMENSION_RULES) {
    if (rule.keywords.some((keyword) => source.includes(keyword))) hits.push(rule.dimension);
  }
  if (hits.length) return hits;
  return [...SCORE_QUESTION_IDS];
}

const RUBRIC_ANCHORS = {
  overall_score: '整体观感与当天目标的综合契合程度。',
  aesthetic_score: '配色、比例与细节的协调程度。',
  scene_score: '与所做场合的正式度、着装惯例的契合程度。',
  figure_score: '版型对身形的修饰效果与上下身比例的呈现。',
  style_score: '与所选风格偏好的一致程度。',
  practical_score: '活动便利性、舒适度与当天天气的适应性。',
};

const BUILTIN_DIMENSION_MAP = {
  best_for_occasion: ['scene_score', 'practical_score'],
  slimmer: ['figure_score'],
  photogenic: ['aesthetic_score', 'figure_score'],
  too_casual: ['scene_score', 'style_score'],
  style_fit: ['style_score', 'aesthetic_score'],
};

const KEYWORD_DIMENSION_RULES = [
  { dimension: 'figure_score', keywords: ['显瘦', '瘦'] },
  { dimension: 'aesthetic_score', keywords: ['上镜', '拍照', '照片'] },
  { dimension: 'scene_score', keywords: ['场合', '面试', '正式', '随意'] },
  { dimension: 'style_score', keywords: ['风格'] },
  { dimension: 'practical_score', keywords: ['实用', '方便', '舒适', '走路'] },
];

/** descriptions 归一化为 [{lookId, text}]，按 lookId 升序，丢弃空文本。 */
export function normalizeDescriptions(descriptions) {
  const entries = [];
  if (Array.isArray(descriptions)) {
    descriptions.forEach((item, index) => {
      if (typeof item === 'string') {
        entries.push({ lookId: `look${index + 1}`, text: item });
        return;
      }
      if (item && typeof item === 'object') {
        const lookId = typeof item.lookId === 'string' ? item.lookId : `look${index + 1}`;
        entries.push({ lookId, text: textOf(item) });
      }
    });
  } else if (descriptions && typeof descriptions === 'object') {
    for (const [lookId, value] of Object.entries(descriptions)) {
      entries.push({ lookId, text: typeof value === 'string' ? value : textOf(value) });
    }
  }
  return entries
    .filter((entry) => entry.text.trim() !== '')
    .sort((a, b) => compareLookIds(a.lookId, b.lookId));
}

/** 单套描述 → 规范化的 7 维度行；解析不出维度时原样保留。 */
export function renderDescription(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return UNRECOGNIZABLE_MARK;
  const fields = parseDescriptionFields(raw);
  const parts = DESCRIPTION_DIMENSIONS
    .filter((dimension) => fields[dimension])
    .map((dimension) => `${dimension}：${fields[dimension]}`);
  if (!parts.length) return raw;
  return parts.join('；');
}

/**
 * 从描述文本中抽取「维度名：内容」的 7 个字段。
 *
 * 关键点：**不能**用 `；` 当值的分隔符——描述正文里本来就允许出现 `；`（例如
 * 「上衣：…袖口挽起；有口袋」）。若用 `[^\n；;]*` 取值，遇到含 `；` 的正文会被从中间截断。
 * 因此这里以「下一个维度名」或换行作为值的边界，并把 `；` 留在值内。这样
 * `renderDescription` 用 `；` 拼接后仍能反解析回来（幂等）。
 */
export function parseDescriptionFields(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  for (const dimension of DESCRIPTION_DIMENSIONS) {
    const others = DESCRIPTION_DIMENSIONS.filter((item) => item !== dimension);
    const boundary = others.length ? `|(?=${others.join('|')}\\s*[:：])` : '';
    const pattern = new RegExp(`${dimension}\\s*[:：]\\s*([^\\n]*?)(?=\\n${boundary}|$)`, 's');
    const match = text.match(pattern);
    const value = match && match[1] ? match[1].trim() : '';
    if (value) out[dimension] = value.replace(/[；;]\s*$/, '').trim();
  }
  return out;
}

function textOf(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (typeof value.description === 'string') return value.description;
  return '';
}

function compareLookIds(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
