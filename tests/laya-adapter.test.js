// 适配器单测：App(SPEC §1.3 数组式) ⇄ laya-serve(对象式 + criteria 档位) 的双向翻译。
// 纯函数测试，不需要网络与 torch。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCORE_INSTRUCTIONS,
  SCORE_RUBRICS,
  isDescribeRequest,
  sceneOf,
  toAppAnswer,
  toAppResponse,
  toLayaQuestion,
  toLayaRequest,
} from '../tools/laya-adapter.mjs';

const APP_QUESTIONS = [
  { id: 'overall_score', type: 'score', question: '这套穿搭的综合分是多少？' },
  { id: 'aesthetic_score', type: 'score', question: '这套穿搭的整体美观度是多少？' },
  { id: 'scene_score', type: 'score', question: '这套穿搭和我的场合匹配度是多少？' },
  { id: 'figure_score', type: 'score', question: '这套穿搭对我身形的修饰效果是多少？' },
  { id: 'style_score', type: 'score', question: '这套穿搭的风格统一度是多少？' },
  { id: 'practical_score', type: 'score', question: '这套穿搭的场景实用度是多少？' },
];

test('toLayaRequest：questions 数组 → 以 id 为键的对象，且 6 维都带 criteria', () => {
  const out = toLayaRequest({ model: 'x', state: '【穿搭一】…\n\n【我的场合】正式面试', questions: APP_QUESTIONS });

  assert.deepEqual(Object.keys(out.questions), [
    'overall_score', 'aesthetic_score', 'scene_score', 'figure_score', 'style_score', 'practical_score',
  ]);
  for (const id of Object.keys(SCORE_RUBRICS)) {
    assert.equal(out.questions[id].type, 'score');
    assert.equal(out.questions[id].criteria.length, 6, `${id} 必须是 6 档 ⇒ 索引 0..5`);
    assert.deepEqual(out.questions[id].criteria, SCORE_RUBRICS[id]);
  }
  assert.equal(out.state, '【穿搭一】…\n\n【我的场合】正式面试');
  assert.ok(Array.isArray(out.questions) === false, 'Laya 的 questions 必须是对象，不能是数组');
});

test('toLayaRequest：问句用「面向场合」的模板，并把用户问题附在后面', () => {
  const out = toLayaRequest({
    state: '【穿搭一】…\n\n【我的场合】正式面试',
    questions: [{ id: 'scene_score', type: 'score', question: '哪套最适合今天的场合？' }],
  });
  const instructions = out.questions.scene_score.instructions;
  // 场合必须真的被写进问句：实测这一改动把区分度从 0.36 提到 1.59
  assert.ok(instructions.includes('正式面试'), `问句必须包含场合，实际：${instructions}`);
  assert.ok(instructions.includes('适合'), `问句必须是「适合不适合」型，实际：${instructions}`);
  assert.ok(instructions.includes('哪套最适合今天的场合？'), '用户问题不得丢失');
  // 而且不能是那种抽象维度问句——实测它没有分辨力
  assert.ok(!/是多少\？$/.test(instructions), '不得退回「XX 是多少」的抽象问法');
});

test('sceneOf：取「我的场合」里第一个选项；没有场合时用中性说法', () => {
  assert.equal(sceneOf('【我的场合】正式面试、通勤上班'), '正式面试');
  assert.equal(sceneOf('【我的场合】约会见面'), '约会见面');
  assert.equal(sceneOf('完全没有场合字段'), '日常出门');
  assert.equal(sceneOf(''), '日常出门');
});

test('SCORE_INSTRUCTIONS：6 个维度都有模板，且都带 {scene} 占位符（aesthetic/style 允许不带）', () => {
  for (const id of Object.keys(SCORE_RUBRICS)) {
    assert.equal(typeof SCORE_INSTRUCTIONS[id], 'string');
    assert.ok(SCORE_INSTRUCTIONS[id].length > 4, `${id} 的模板太短`);
  }
  for (const id of ['overall_score', 'scene_score', 'practical_score']) {
    assert.ok(SCORE_INSTRUCTIONS[id].includes('{scene}'), `${id} 必须把场合写进问句`);
  }
});

test('toLayaRequest：不带 --model 时不塞 model 字段（交给 Laya 自己路由）', () => {
  const out = toLayaRequest({ state: 's', questions: APP_QUESTIONS });
  assert.ok(!('model' in out), 'MODEL 为空时不应出现 model 字段');
});

test('toLayaQuestion：非评分项退化为三档 score（Laya 不做文本生成）', () => {
  const q = toLayaQuestion({ id: 'custom_reply', type: 'text', question: '哪套更显瘦？' });
  assert.equal(q.type, 'score');
  assert.equal(q.instructions, '哪套更显瘦？');
  assert.deepEqual(q.criteria, ['无法回答', '部分回答', '可以回答']);
});

test('toLayaQuestion：缺 question 文本时回落到维度模板，不产生空 instructions', () => {
  const q = toLayaQuestion({ id: 'overall_score' }, { scene: '通勤上班' });
  assert.ok(q.instructions.length > 0);
  assert.ok(q.instructions.includes('通勤上班'), '没有用户问题时仍须把场合写进去');
});

test('toLayaQuestion：未知 id 的非评分项回落到 id 本身，不产生空 instructions', () => {
  const q = toLayaQuestion({ id: 'custom_reply' });
  assert.equal(q.instructions, 'custom_reply');
  assert.deepEqual(q.criteria, ['无法回答', '部分回答', '可以回答']);
});

test('isDescribeRequest：只在全部是 describe_* 时判定为图片转文字', () => {
  assert.equal(isDescribeRequest([{ id: 'describe_look1' }]), true);
  assert.equal(isDescribeRequest([{ id: 'describe_look1' }, { id: 'describe_look2' }]), true);
  assert.equal(isDescribeRequest([{ id: 'describe_look1' }, { id: 'overall_score' }]), false);
  assert.equal(isDescribeRequest(APP_QUESTIONS), false);
  assert.equal(isDescribeRequest([]), false);
});

test('toAppAnswer：score 索引 → 0..5 分，1 位小数，附 confidence', () => {
  const a = toAppAnswer('overall_score', { type: 'score', score: 4, confidence: 0.87, probabilities: [0, 0, 0, 0, 1, 0] });
  assert.deepEqual(a, { id: 'overall_score', type: 'score', score: 4, confidence: 0.87 });
  assert.equal(Object.prototype.hasOwnProperty.call(a, 'content'), false, '评分项不得带解释性 content');
});

test('toAppAnswer：score=null（超档 abstain）→ 按概率加权回退', () => {
  // 6 档（索引 0..5，max index 5），权重 0.5@3 + 0.5@4 → 索引期望 3.5 → 3.5/5*5 = 3.5
  const a = toAppAnswer('scene_score', { type: 'score', score: null, confidence: 0.4, probabilities: [0, 0, 0, 0.5, 0.5, 0] });
  assert.equal(a.type, 'score');
  assert.equal(a.score, 3.5);
});

test('toAppAnswer：超过 0..5 的原始分被钳制到区间内', () => {
  assert.equal(toAppAnswer('x', { type: 'score', score: 9, probabilities: [0, 0, 0, 0, 0, 1] }).score, 5);
  assert.equal(toAppAnswer('x', { type: 'score', score: -3, probabilities: [1, 0, 0, 0, 0, 0] }).score, 0);
});

test('toAppAnswer：score 一律 1 位小数（避免线上出现 3.666666）', () => {
  const a = toAppAnswer('x', { type: 'score', score: 3.666666, probabilities: [0, 0, 0, 1, 0, 0] });
  assert.equal(a.score, 3.7);
});

test('toAppAnswer：confidence 缺失/越界都被规范化到 [0,1]', () => {
  assert.equal(toAppAnswer('x', { type: 'score', score: 3, probabilities: [0, 0, 0, 1, 0, 0] }).confidence, 0.5);
  assert.equal(toAppAnswer('x', { type: 'score', score: 3, confidence: 7 }).confidence, 1);
  assert.equal(toAppAnswer('x', { type: 'score', score: 3, confidence: -2 }).confidence, 0);
});

test('toAppAnswer：noul 概率 → 是/否文字，且置信度随确定性上升', () => {
  assert.deepEqual(toAppAnswer('q', { type: 'noul', noul: 0.9 }), { id: 'q', type: 'text', content: '是', confidence: 0.8 });
  assert.deepEqual(toAppAnswer('q', { type: 'noul', noul: 0.1 }), { id: 'q', type: 'text', content: '否', confidence: 0.8 });
  assert.equal(toAppAnswer('q', { type: 'noul', noul: 0.5 }).confidence, 0);
});

test('toAppAnswer：choice → 文字回答，缺 confidence 时取最大概率', () => {
  const a = toAppAnswer('q', { type: 'choice', choice: 'billing', probabilities: [0.1, 0.75, 0.15] });
  assert.deepEqual(a, { id: 'q', type: 'text', content: 'billing', confidence: 0.75 });
});

test('toAppAnswer：结构不认识时返回 null（宁可漏答，也不编造）', () => {
  assert.equal(toAppAnswer('q', null), null);
  assert.equal(toAppAnswer('q', { type: 'unknown', x: 1 }), null);
  assert.equal(toAppAnswer('q', { type: 'score' }), null, '既无 score 也无概率 → 不给分');
  assert.equal(toAppAnswer('q', { type: 'noul', noul: 'yes' }), null, '非数值 noul 不猜');
});

test('toAppResponse：answers 对象 → 数组，且按请求顺序、缺项跳过', () => {
  const out = toAppResponse({
    model: 'english',
    answers: {
      overall_score: { type: 'score', score: 4, confidence: 0.9 },
      scene_score: { type: 'score', score: 5, confidence: 0.8 },
    },
    usage: { input_tokens: 120, output_tokens: 6 },
  }, ['overall_score', 'aesthetic_score', 'scene_score']);

  assert.deepEqual(out.answers.map((a) => a.id), ['overall_score', 'scene_score'], '缺项应跳过而不是补 0');
  assert.equal(out.answers[0].score, 4);
});

test('toAppResponse：usage 字段改名并算出 total_tokens', () => {
  const out = toAppResponse({ answers: {}, usage: { input_tokens: 120, output_tokens: 6 } }, []);
  assert.deepEqual(out.usage, { prompt_tokens: 120, completion_tokens: 6, total_tokens: 126 });
  const empty = toAppResponse({ answers: {} }, []);
  assert.deepEqual(empty.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('toAppResponse：model 缺失时回落到 routing.model，再回落到 laya', () => {
  assert.equal(toAppResponse({ answers: {}, routing: { model: 'multilingual' } }, []).model, 'multilingual');
  assert.equal(toAppResponse({ answers: {} }, []).model, 'laya');
});

test('端到端形状：App 请求 → Laya 请求 → Laya 响应 → App 响应', () => {
  const appReq = {
    model: 'outfit-judge-v1',
    state: '【穿搭一】整体风格：简约通勤风；上衣：浅蓝衬衫\n\n【我的场合】通勤上班',
    questions: APP_QUESTIONS,
  };
  const layaReq = toLayaRequest(appReq);
  assert.equal(Object.keys(layaReq.questions).length, 6);

  // 模拟 laya-serve 的真实返回：索引分 + 概率 + legend
  const layaRes = {
    model: 'outfit-judge-v1',
    answers: Object.fromEntries(Object.keys(SCORE_RUBRICS).map((id, i) => [id, {
      type: 'score',
      score: 5 - (i % 3),
      probabilities: [0, 0, 0, 0, 0, 1],
      confidence: 0.7 + i * 0.01,
      legend: Object.fromEntries(SCORE_RUBRICS[id].map((label, index) => [String(index), label])),
    }])),
    usage: { input_tokens: 210, output_tokens: 6 },
    routing: { model: 'english' },
  };
  const appRes = toAppResponse(layaRes, Object.keys(SCORE_RUBRICS));

  assert.equal(appRes.answers.length, 6);
  for (const answer of appRes.answers) {
    assert.equal(answer.type, 'score');
    assert.ok(Number.isInteger(answer.score) || Math.round(answer.score * 10) === answer.score * 10);
    assert.ok(answer.score >= 0 && answer.score <= 5);
    assert.ok(answer.confidence >= 0 && answer.confidence <= 1);
  }
  assert.equal(appRes.model, 'outfit-judge-v1');
  assert.equal(appRes.usage.total_tokens, 216);
});
