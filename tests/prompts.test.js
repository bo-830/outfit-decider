// SPEC §3.2 / §3.4 提示词层单测：描述禁令、合成 state 拼接、6 维问题、维度映射。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEEP_DIMENSION_NAMES,
  DEEP_SYSTEM_PROMPT,
  DEEP_USER_TEMPLATE,
  DESCRIBE_SYSTEM_PROMPT,
  DESCRIBE_USER_PROMPT,
  DESCRIPTION_DIMENSIONS,
  buildDeepUserText,
  buildDescribeQuestions,
  buildScoreQuestions,
  buildSyntheticStateText,
  relevantScoreDimensions,
  scoreRubric,
} from '../src/core/prompts.js';
import { SCORE_QUESTION_IDS } from '../src/core/protocol.js';
import { BUILTIN_QUESTIONS } from '../src/data/options.js';
import { loadDescription } from './helpers/fetchMock.js';

const BANNED = ['好看', '漂亮', '显瘦', '显胖', '建议', '推荐', '因为你', '显得', '完美', '时髦'];

test('描述提示词：只做客观描述、看不清写「未清晰显示」、7 维齐全', () => {
  assert.ok(DESCRIBE_SYSTEM_PROMPT.length > 40);
  assert.ok(DESCRIBE_SYSTEM_PROMPT.includes('未清晰显示'));
  for (const dimension of DESCRIPTION_DIMENSIONS) {
    assert.ok(DESCRIBE_USER_PROMPT.includes(dimension), `描述提示词缺少维度 ${dimension}`);
  }
  assert.equal(DESCRIPTION_DIMENSIONS.length, 7, 'SPEC §3.2 规定 7 个描述维度');
});

test('描述提示词与描述问题不含任何主观评价词（§7 断言 3 前置条件）', () => {
  const describeQuestion = buildDescribeQuestions('look1')[0].question;
  for (const word of BANNED) {
    assert.ok(!DESCRIBE_SYSTEM_PROMPT.includes(word), `系统提示词不该出现 ${word}`);
    assert.ok(!DESCRIBE_USER_PROMPT.includes(word), `用户提示词不该出现 ${word}`);
    assert.ok(!describeQuestion.includes(word), `描述问题不该出现 ${word}`);
  }
  assert.ok(DESCRIBE_SYSTEM_PROMPT.includes('客观'));
});

test('buildDescribeQuestions：单条 text 问题，id 为 describe_{lookId}', () => {
  const questions = buildDescribeQuestions('look3');
  assert.equal(questions.length, 1);
  assert.equal(questions[0].id, 'describe_look3');
  assert.equal(questions[0].type, 'text');
  assert.ok(questions[0].question.includes('上衣'));
  assert.ok(questions[0].question.includes('look3'));
});

test('buildSyntheticStateText：单套结构、段间 \\n\\n、组内换行', () => {
  const text = buildSyntheticStateText({
    descriptions: { look1: loadDescription('look1') },
    userState: { occasion: ['commute', 'date'], weather: ['cool'], style: ['minimal'], note: '' },
    question: { builtinId: 'best_for_occasion', text: '哪套最适合今天的场合？' },
  });
  assert.ok(text.startsWith('【穿搭一】\n整体风格：简约干练的日常通勤搭配'), text.slice(0, 40));
  assert.ok(text.includes('；上衣：米白色圆领针织短袖'), '7 维用「；」串成一行');
  assert.ok(!text.includes('【穿搭二】'));
  assert.ok(text.includes('【我的场合】通勤上班、约会见面\n【我的天气】凉爽\n【我的风格偏好】简约干练'), 'state 组内不空行');
  assert.ok(!text.includes('【补充说明】'), 'note 为空则省略补充说明段');
  assert.ok(text.includes('\n\n【我的问题】哪套最适合今天的场合？'));
  assert.equal(text.split('\n\n').length, 3, '穿搭段 / state 段 / 问题段');
});

test('buildSyntheticStateText：多套中文序号 + 空组省略 + note 保留原文', () => {
  const descriptions = {
    look2: loadDescription('look2'),
    look1: loadDescription('look1'),
    look4: loadDescription('look4'),
  };
  const text = buildSyntheticStateText({
    descriptions,
    userState: { occasion: [], weather: [], style: [], note: '  今天要下雨  ' },
    question: { builtinId: null, text: '' },
  });
  assert.ok(text.includes('【穿搭一】'));
  assert.ok(text.includes('【穿搭二】'));
  assert.ok(text.includes('【穿搭四】'));
  assert.ok(!text.includes('【穿搭三】'), '未提供的套不出现');
  assert.ok(!text.includes('【我的场合】'), '空组省略');
  assert.ok(!text.includes('【我的天气】'));
  assert.ok(!text.includes('【我的风格偏好】'));
  assert.ok(text.includes('【补充说明】今天要下雨'), 'note 去首尾空格后保留');
  assert.ok(!text.includes('【我的问题】'), '未选问题则省略问题段');
  assert.ok(text.indexOf('【穿搭一】') < text.indexOf('【穿搭二】'));
  assert.ok(text.indexOf('【穿搭二】') < text.indexOf('【穿搭四】'));
});

test('buildSyntheticStateText：兼容数组入参与 {text} 包装，空描述被丢弃', () => {
  const asArray = buildSyntheticStateText({ descriptions: [{ lookId: 'look1', text: '整体风格：简约' }] });
  assert.ok(asArray.startsWith('【穿搭一】\n整体风格：简约'));
  const asWrapped = buildSyntheticStateText({ descriptions: { look1: { text: '整体风格：简约' } } });
  assert.equal(asWrapped, asArray);
  assert.equal(buildSyntheticStateText({}), '');
  assert.equal(buildSyntheticStateText({ descriptions: { look1: '   ' } }), '');
});

test('buildScoreQuestions：恒 6 条、顺序、类型与口径', () => {
  const questions = buildScoreQuestions({
    userState: { occasion: ['commute'], weather: [], style: [], note: '' },
    question: { builtinId: 'slimmer', text: '哪套更显瘦？' },
  });
  assert.equal(questions.length, 6);
  assert.deepEqual(questions.map((item) => item.id), SCORE_QUESTION_IDS);
  for (const item of questions) {
    assert.equal(item.type, 'score');
    assert.ok(item.question.length > 10);
    assert.ok(item.question.includes('0') && item.question.includes('5'), '必须带 0-5 口径');
    for (const word of ['建议', '推荐', '因为你', '显得', '好看', '漂亮']) {
      assert.ok(!item.question.includes(word), `评分问题不该出现 ${word}`);
    }
  }
});

test('scoreRubric：6 维各有独立口径，未知维度也有兜底', () => {
  const rubrics = SCORE_QUESTION_IDS.map((id) => scoreRubric(id));
  for (const rubric of rubrics) {
    assert.equal(typeof rubric, 'string');
    assert.ok(rubric.includes('0') && rubric.includes('5'));
    assert.ok(rubric.includes('1 位小数'));
  }
  assert.equal(new Set(rubrics).size, SCORE_QUESTION_IDS.length, '6 维口径必须互不相同');
  assert.ok(typeof scoreRubric('nope_score') === 'string');
});

test('relevantScoreDimensions：5 条内置问题映射逐字对齐 SPEC §3.4', () => {
  assert.deepEqual(relevantScoreDimensions({ builtinId: 'best_for_occasion', text: '' }), ['scene_score', 'practical_score']);
  assert.deepEqual(relevantScoreDimensions({ builtinId: 'slimmer', text: '' }), ['figure_score']);
  assert.deepEqual(relevantScoreDimensions({ builtinId: 'photogenic', text: '' }), ['aesthetic_score', 'figure_score']);
  assert.deepEqual(relevantScoreDimensions({ builtinId: 'too_casual', text: '' }), ['scene_score', 'style_score']);
  assert.deepEqual(relevantScoreDimensions({ builtinId: 'style_fit', text: '' }), ['style_score', 'aesthetic_score']);
  assert.equal(BUILTIN_QUESTIONS.length, 5);
});

test('relevantScoreDimensions：自定义文本按关键词命中，未命中 → 全 6 维', () => {
  assert.deepEqual(relevantScoreDimensions({ builtinId: null, text: '哪套更显瘦？' }), ['figure_score']);
  assert.deepEqual(relevantScoreDimensions({ builtinId: null, text: '这套拍照上镜吗' }), ['aesthetic_score']);
  assert.deepEqual(relevantScoreDimensions({ builtinId: null, text: '正式面试能穿吗' }), ['scene_score']);
  assert.deepEqual(relevantScoreDimensions({ builtinId: null, text: '符合我想要的风格吗' }), ['style_score']);
  assert.deepEqual(relevantScoreDimensions({ builtinId: null, text: '走路方便舒服吗' }), ['practical_score']);
  assert.deepEqual(
    relevantScoreDimensions({ builtinId: null, text: '显瘦又上镜，适合正式场合吗' }),
    ['figure_score', 'aesthetic_score', 'scene_score'],
    '多个关键词按映射表顺序返回',
  );
  assert.deepEqual(relevantScoreDimensions({ builtinId: null, text: '今天怎么样' }), SCORE_QUESTION_IDS);
  assert.deepEqual(relevantScoreDimensions({}), SCORE_QUESTION_IDS);
  assert.deepEqual(relevantScoreDimensions(), SCORE_QUESTION_IDS);
});

test('深度提示词：三段式 JSON schema、5 维名、占位符', () => {
  for (const key of ['ranking', 'details', 'conclusion']) {
    assert.ok(DEEP_SYSTEM_PROMPT.includes(key), `深度系统提示词缺少 ${key}`);
  }
  for (const name of DEEP_DIMENSION_NAMES) {
    assert.ok(DEEP_SYSTEM_PROMPT.includes(name), `深度系统提示词缺少维度 ${name}`);
  }
  assert.equal(DEEP_DIMENSION_NAMES.length, 5);
  assert.ok(DEEP_SYSTEM_PROMPT.includes('pros') && DEEP_SYSTEM_PROMPT.includes('cons') && DEEP_SYSTEM_PROMPT.includes('suggestions'));
  assert.ok(DEEP_USER_TEMPLATE.includes('{{STATE}}'));
  assert.ok(DEEP_USER_TEMPLATE.includes('{{QUESTION}}'));
});

test('buildDeepUserText：填充占位符，无残留', () => {
  const text = buildDeepUserText({
    userState: { occasion: ['commute'], weather: ['cool'], style: ['minimal'], note: '' },
    question: { builtinId: 'slimmer', text: '哪套更显瘦？' },
  });
  assert.ok(text.includes('通勤上班 · 凉爽 · 简约干练'));
  assert.ok(text.includes('哪套更显瘦？'));
  assert.ok(!text.includes('{{STATE}}'));
  assert.ok(!text.includes('{{QUESTION}}'));
  const empty = buildDeepUserText({});
  assert.ok(empty.includes('未指定'));
  assert.ok(!empty.includes('{{'));
});
