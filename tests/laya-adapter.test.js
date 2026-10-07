// 适配器单测：App(SPEC §1.3 数组式) ⇄ laya-serve(对象式 + criteria 档位) 的双向翻译。
// 纯函数测试，不需要网络与 torch。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCORE_INSTRUCTIONS,
  SCORE_RUBRICS,
  buildVisionMessages,
  isDeepRequest,
  isDescribeRequest,
  isReviewRequest,
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

test('toLayaRequest：模型名三档优先级（显式 > 配置 > App 原名）', () => {
  // 这条断言必须用**显式传参**控制模型名，不能依赖"MODEL 为空"这个前提：
  // 适配器导入时会加载开发者的 .env.local，一旦那里写了 LAYA_MODEL，
  // "配置为空"就不成立了 —— 实测就是这么红的。
  const base = { state: 's', questions: APP_QUESTIONS };

  // 1) 显式注入优先（测试用它控制）
  assert.ok(!('model' in toLayaRequest(base, { model: '' })), '显式空字符串 = 不塞 model 字段');
  assert.equal(toLayaRequest(base, { model: 'jev-latest' }).model, 'jev-latest');

  // 2) 都没给时才回落到 App 传来的名字
  const withAppModel = toLayaRequest({ ...base, model: 'outfit-judge-v1' }, { model: '' });
  assert.equal(withAppModel.model, 'outfit-judge-v1', '没配置时传 App 的名字，不偷偷改');

  // 3) 配置有值时以配置为准（此处用显式参数模拟）
  assert.equal(toLayaRequest({ ...base, model: 'app-name' }, { model: 'cfg-name' }).model, 'cfg-name');
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

/* ── 适配器必须认出的三条多模态通道 ──────────────────────────────
   漏判 = 该请求被当成"打分"转发给 Laya，返回分数而不是文本，
   App 侧表现为「模型返回的内容看不懂」或纠正静默失效（deep 与 review 都实测踩过）。 */

test('isDeepRequest：识别 System Two，不与 review / describe 混淆', () => {
  assert.equal(isDeepRequest([{ id: 'deep_report' }]), true);
  assert.equal(isDeepRequest([{ id: 'review' }]), false);
  assert.equal(isDeepRequest([{ id: 'describe_look1' }]), false);
  assert.equal(isDeepRequest(APP_QUESTIONS), false);
  assert.equal(isDeepRequest([]), false);
  assert.equal(isDeepRequest([{ id: 'deep_report' }, { id: 'review' }]), false, '只认单条');
});

test('isReviewRequest：识别多模态纠正，不与 deep 混淆', () => {
  assert.equal(isReviewRequest([{ id: 'review' }]), true);
  assert.equal(isReviewRequest([{ id: 'deep_report' }]), false);
  assert.equal(isReviewRequest([{ id: 'describe_look1' }]), false);
  assert.equal(isReviewRequest(APP_QUESTIONS), false);
});

test('三条多模态通道互斥：同一请求绝不会同时被判成两种', () => {
  const cases = [
    [{ id: 'deep_report' }],
    [{ id: 'review' }],
    [{ id: 'describe_look1' }],
    APP_QUESTIONS,
    [],
  ];
  for (const items of cases) {
    const hits = [isDeepRequest(items), isReviewRequest(items), isDescribeRequest(items)].filter(Boolean).length;
    assert.ok(hits <= 1, `请求 ${JSON.stringify(items).slice(0, 60)} 被判成 ${hits} 种通道`);
  }
});

test('buildVisionMessages：把 App 的完整指令逐字透传（适配器不重写措辞）', () => {
  const instruction = '你是严格的穿搭评审。\n用户上下文：正式面试\n只输出一个 JSON 对象。';
  const messages = buildVisionMessages('ignored-state', instruction);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, instruction, '指令必须逐字透传，保证单一真源');
  assert.equal(buildVisionMessages('from-state', '')[0].content, 'from-state', '无 question 时退回 state');
  assert.ok(buildVisionMessages('', '')[0].content.length > 0, '两者都空时必须有兜底文案');
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

/* ── SPEC §3.10b · JEv 方言（TypeSafe，https://docs.typesafe.ai） ─────────────
   文档关键事实（不是猜的）：
     · POST /v1/systemone，`questions` 是 **map**（id → {type, instructions, criteria}）
     · `criteria` 有序、索引从 0 起；"score 会落在两档之间"（3 档 → score 0..2）
   于是 6 档 criteria **直接对应 0–5**，与 App 的 0–5 一位小数天然对齐，
   不像 Laya 的 3 档需要把 0–2 映射上去。 */

test('JEv 方言：instructions 用 App 原文，criteria 用 6 档（索引即 0–5）', () => {
  const q = toLayaQuestion(
    { id: 'overall_score', type: 'score', question: '正式面试穿这套得体吗？' },
    { protocol: 'jev', scene: '正式面试' },
  );
  assert.equal(q.type, 'score');
  assert.equal(q.criteria.length, 6, 'JEv 用 6 档，score 直接落在 0–5');
  assert.equal(q.criteria[0], '完全不适合这个场合');
  assert.equal(q.criteria[5], '非常得体');
  assert.equal(q.instructions, '正式面试穿这套得体吗？', 'JEv 用 App 原文，不套场合模板');
  assert.ok(!q.instructions.includes('我的问题：'), '不套用 Laya 那套模板拼接');
});

test('JEv 方言：缺 question 文本时回落到模板，不产生空 instructions', () => {
  const q = toLayaQuestion({ id: 'scene_score' }, { protocol: 'jev', scene: '通勤上班' });
  assert.ok(q.instructions.length > 0);
  assert.equal(q.criteria.length, 6);
});

test('Laya 方言不被改动（回归保护）：仍走它的场合模板问法', () => {
  const q = toLayaQuestion(
    { id: 'overall_score', type: 'score', question: '随便' },
    { protocol: 'laya', scene: '正式面试' },
  );
  assert.equal(q.criteria.length, 6, 'SCORE_RUBRICS 本身是 6 档描述');
  assert.ok(q.instructions.includes('得体'), 'Laya 仍走场合模板');
});

test('toLayaRequest：模型名由配置决定；没配就把 App 的名字原样带上（不偷偷改）', () => {
  const laya = toLayaRequest(
    { model: 'outfit-judge-v1', state: 'x', questions: [{ id: 'overall_score', type: 'score', question: '得体吗？' }] },
    { protocol: 'laya', model: '' },
  );
  assert.equal(laya.model, 'outfit-judge-v1');

  // JEv 的模型名（jev-latest）由 tools/use-jev.bat 写进 .env.local 的 LAYA_MODEL，
  // 不在代码里硬编码 —— 这里只保证 JEv 请求形状正确。
  const jevShape = toLayaRequest(
    { state: '【我的场合】正式面试', questions: [{ id: 'overall_score', type: 'score', question: '得体吗？' }] },
    { protocol: 'jev', model: '' },
  );
  assert.equal(jevShape.state, '【我的场合】正式面试');
  assert.equal(Array.isArray(jevShape.questions), false, 'JEv 要求 questions 是 map，不能是数组');
  assert.equal(jevShape.questions.overall_score.type, 'score');
  assert.equal(jevShape.questions.overall_score.criteria.length, 6);
});

test('toLayaRequest：两种方言都产出 map 形状的 questions', () => {
  for (const protocol of ['laya', 'jev']) {
    const req = toLayaRequest({ state: 'x', questions: APP_QUESTIONS }, { protocol });
    assert.equal(Array.isArray(req.questions), false, `${protocol}: questions 必须是 map`);
    assert.deepEqual(Object.keys(req.questions).sort(), APP_QUESTIONS.map((q) => q.id).sort());
  }
});

test('非评分项：两种方言都退化为三档（上游都不做文本生成）', () => {
  for (const protocol of ['laya', 'jev']) {
    const q = toLayaQuestion({ id: 'custom_reply', type: 'text', question: '哪套更显瘦？' }, { protocol });
    assert.equal(q.type, 'score');
    assert.deepEqual(q.criteria, ['无法回答', '部分回答', '可以回答']);
  }
});

