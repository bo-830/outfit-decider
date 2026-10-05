// SPEC §3.9b/§3.9c · 多模态纠正与三档引擎模式单测。
//
// 这一层是产品正确性的关键：Laya 判断力不合格（见 laya-service/README.md §4），
// 纠正环节就是用来救这一点的。所以这里要证明：
//   1) 纠正真的能推翻 Laya（且不是玄学，是分数层面的替换）；
//   2) 纠正只输出分数、不产出解释文本（System One 硬约束）；
//   3) 纠正失败时回退 Laya 原分，不清空用户已有结果；
//   4) 三档模式走的路不同，但产出同一个 QuickResult 形状。
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeOrchestrator } from '../src/engine/orchestrator.js';
import { makeReviewSystem, parseReviewScores, hasScoreDelta } from '../src/engine/reviewSystem.js';
import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT } from '../src/core/prompts.js';
import { DEFAULT_CONFIG, makeApi } from '../src/engine/api.js';
import { SCORE_QUESTION_IDS } from '../src/core/protocol.js';

const LOOKS = ['look1', 'look2'];
const artifacts = () => LOOKS.map((lookId) => ({
  lookId,
  mime: 'image/jpeg',
  base64: `BASE64_${lookId}`,
  width: 390,
  height: 520,
}));
const STATE = { occasion: ['interview'], weather: ['cool'], style: ['minimal'], note: '' };
const QUESTION = { builtinId: 'best_for_occasion', text: '哪套最适合今天的场合？' };

/* ────────────────── 造一个「决策模型 + 多模态模型」双端 fetch 替身 ────────────────── */

const DESCRIPTION = '整体风格：简约通勤风；上衣：浅蓝色棉质衬衫；下装：深灰色直筒西裤；'
  + '鞋履：白色板鞋；配饰：银色腕表；身材视觉效果：比例匀称；其他细节：下摆收进裤腰';

/** Laya 侧：所有维度都给同一个分，方便断言「被纠正替换了」。 */
function layaScores(score) {
  return Object.fromEntries(SCORE_QUESTION_IDS.map((id) => [id, score]));
}

/**
 * 双通道 fetch 替身（v1.5 起 describe 也走 vision 通道，替身必须照实模拟）。
 *
 * 通道判定与真实实现一致（SPEC §3.7 v1.5）：
 *   配了多模态端点 → describe 走 /chat/completions 看原图
 *   没配           → describe 退回决策模型的 JEv /ask
 * 所以 vision 侧的替身要按「请客观描述这张穿搭照片」和「纠正」两种指令分别作答。
 *
 * @param {object} options
 *   layaScore    决策模型给的分
 *   reviewJson   纠正指令的返回 content；null 表示返回空串（模拟推理吃光预算）
 *   reviewStatus 多模态响应的 HTTP 状态
 */
function makeDualFetch({
  layaScore = 1.5,
  reviewJson = null,
  reviewStatus = 200,
  describeStatus = 200,
  describeContent = DESCRIPTION,
} = {}) {
  const calls = { decision: [], vision: [] };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    if (/chat\/completions/.test(url)) {
      calls.vision.push({ url, body, headers: init.headers });
      const userMessage = (body.messages || []).find((m) => m && m.role === 'user');
      const raw = userMessage ? userMessage.content : '';
      const text = Array.isArray(raw)
        ? raw.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
        : String(raw || '');
      // 描述指令 vs 纠正指令：前者要求客观描述，后者要求输出 scores JSON。
      // 两者要能分别注入故障——否则"纠正失败"的用例会连描述一起打挂，
      // 测到的就不是 §3.9c 的回退语义了。
      const isDescribe = /客观描述/.test(text);
      const status = isDescribe ? describeStatus : reviewStatus;
      if (status !== 200) {
        return { ok: false, status, json: async () => ({ error: { message: 'boom' } }) };
      }
      const content = isDescribe
        ? describeContent
        : (reviewJson === null ? '' : reviewJson);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vision-test',
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 500, completion_tokens: 60, total_tokens: 560 },
        }),
      };
    }
    calls.decision.push({ url, body });
    if (process.env.OD_DEBUG_REVIEW) {
      // eslint-disable-next-line no-console
      console.log('DECISION CALL ids=', (body.questions || []).map((q) => q.id).join('|'),
        'images=', (body.images || []).length, 'stateLen=', String(body.state || '').length);
    }
    // describe_* 只有在"没配多模态"时才会走到这里；但**纠正**也可能走这里——
    // 当 visionServerSide=true（视觉配置在服务端）时，App 把纠正指令与图片
    // 一起经决策通道发给适配器，由适配器在服务端看图。
    // 用 id==='review' 区分这两种走法。
    const isReview = Array.isArray(body.questions)
      && body.questions.some((q) => q && q.id === 'review');
    if (isReview) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vision-test',
          answers: [{
            id: 'review',
            type: 'text',
            content: reviewJson === null ? '' : reviewJson,
            confidence: 0.8,
          }],
          usage: { prompt_tokens: 500, completion_tokens: 60, total_tokens: 560 },
        }),
      };
    }
    const isDescribe = Array.isArray(body.questions)
      && body.questions.some((q) => String(q.id).startsWith('describe_'));
    const answers = isDescribe
      ? body.questions.map((q) => ({ id: q.id, type: 'text', content: describeContent, confidence: 0.8 }))
      : body.questions.map((q) => ({ id: q.id, type: 'score', score: layaScore, confidence: 0.5, content: '' }));
    return {
      ok: true,
      status: 200,
      json: async () => ({ model: 'laya-test', answers, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    };
  };
  return { fetchImpl, calls };
}

const reviewedJson = (rows) => JSON.stringify({ scores: rows });
const reviewRow = (lookId, base) => ({
  lookId,
  overall_score: base,
  aesthetic_score: base,
  scene_score: base,
  figure_score: base,
  style_score: base,
  practical_score: base,
});

function orchestrator(dual, engineMode, configPatch = {}) {
  const api = makeApi({
    config: {
      ...DEFAULT_CONFIG,
      visionBaseUrl: 'https://vision.test/v1',
      visionModel: 'vision-test',
      visionApiKey: 'sk-vision-secret',
      ...configPatch,
    },
    fetchImpl: dual.fetchImpl,
  });
  return makeOrchestrator({ api, model: 'laya', engineMode });
}

/** 只统计"纠正"调用（描述类调用不算）。 */
const reviews = (dual) => dual.calls.vision.filter((call) => {
  const raw = call.body.messages[1].content;
  const text = Array.isArray(raw) ? raw.map((p) => p.text || '').join('') : String(raw || '');
  return !/客观描述/.test(text);
});

/* ────────────────────────── 三档模式 ────────────────────────── */

test('laya_only：不发起纠正调用，直接用 Laya 原分（描述仍走 vision 看原图）', async () => {
  const dual = makeDualFetch({ layaScore: 1.5 });
  const quick = await orchestrator(dual, 'laya_only').runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });

  assert.equal(reviews(dual).length, 0, 'laya_only 不得发起纠正调用');
  // SPEC §3.7 v1.5：配了多模态端点时，describe 就应该走 vision 看原图，而不是退到决策模型
  assert.equal(dual.calls.vision.length, artifacts().length, '每套一次描述，且都走 vision 通道');
  assert.equal(quick.engineMode, 'laya_only');
  for (const row of quick.ranked) for (const id of SCORE_QUESTION_IDS) assert.equal(row.scores[id], 1.5);
});

test('§3.7 v1.5 双通道：没配多模态端点时，describe 退回决策模型的 JEv 通道', async () => {
  const dual = makeDualFetch({ layaScore: 2.4 });
  const quick = await orchestrator(dual, 'laya_only', { visionBaseUrl: '', visionModel: '' }).runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });

  assert.equal(dual.calls.vision.length, 0, '没配 vision 时不得碰该通道');
  const describeCalls = dual.calls.decision.filter((c) => Array.isArray(c.body.questions)
    && c.body.questions.some((q) => String(q.id).startsWith('describe_')));
  assert.equal(describeCalls.length, artifacts().length, 'describe 应退回 /ask 通道并按套发请求');
  // 退回通道也要把图带上，否则真实端点看不到画面
  assert.ok(describeCalls.every((c) => Array.isArray(c.body.images) && c.body.images.length === 1));
  assert.equal(quick.ranked.length, 2);
});

test('laya_review（默认档）：多模态推翻 Laya 的分数，排序随之重算', async () => {
  // Laya 给两套都打 1.5（这正是实测中它的表现：好/坏几乎不分）
  const dual = makeDualFetch({
    layaScore: 1.5,
    reviewJson: reviewedJson([reviewRow('look1', 4.8), reviewRow('look2', 1.2)]),
  });
  const quick = await orchestrator(dual, 'laya_review').runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });

  assert.equal(reviews(dual).length, 1, '应恰好发起一次纠正调用（全部图片一起给）');
  const review = reviews(dual)[0];
  assert.equal(review.body.messages.length, 2, 'system + user');
  const userContent = review.body.messages[1].content;
  assert.ok(Array.isArray(userContent), '带图时必须用 OpenAI 的 content 数组');
  assert.equal(userContent.filter((p) => p.type === 'image_url').length, 2, '两套图都要给到模型');

  // 纠正后的分数必须生效，而不是被 Laya 的 1.5 覆盖
  assert.equal(quick.byLook.look1.scores.overall_score, 4.8);
  assert.equal(quick.byLook.look2.scores.overall_score, 1.2);
  // 排序按纠正后的 overall 降序
  assert.deepEqual(quick.ranked.map((r) => r.lookId), ['look1', 'look2']);
  assert.equal(quick.ranked[0].rank, 1);
  assert.equal(quick.reviewModel, 'vision-test');
  assert.ok(Number.isFinite(quick.reviewedAt));
  assert.deepEqual(quick.reviewChanged.slice().sort(), ['look1', 'look2']);
});

test('laya_review：纠正提示词带上 Laya 原始分、用户上下文与场景，且允许画面推翻', async () => {
  const dual = makeDualFetch({
    layaScore: 2.0,
    reviewJson: reviewedJson([reviewRow('look1', 4.0), reviewRow('look2', 3.0)]),
  });
  await orchestrator(dual, 'laya_review').runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });
  const review = reviews(dual)[0];
  const userContent = review.body.messages[1].content;
  const text = Array.isArray(userContent) ? userContent[0].text : String(userContent);
  assert.ok(text.includes('正式面试'), '必须包含用户场合');
  assert.ok(text.includes('哪套最适合今天的场合？'), '必须包含用户问题，纠正是针对用户问题的');
  // laya_review 是**串行**档：Laya 分数已算出，所以提示词必须带上原始分供参考
  assert.ok(text.includes('本地决策模型的原始判断'), '必须写明这是本地模型的原始判断');
  assert.ok(text.includes('2.0'), '必须带上 Laya 的原始分（全部维度同为 2.0）');
  // 系统提示必须明确允许推翻，并强调以画面为准
  const system = review.body.messages[0].content;
  assert.ok(system.includes('推翻'), '系统提示必须允许推翻本地模型');
  assert.ok(system.includes('只能是你自己看到的画面'), '必须要求以画面为准');
});

test('multimodal_only：提示词必须说明"没有提供本地模型分数"（而不是留一段空白）', async () => {
  const dual = makeDualFetch({ reviewJson: reviewedJson([reviewRow('look1', 4.0), reviewRow('look2', 3.0)]) });
  await orchestrator(dual, 'multimodal_only').runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });
  const review = reviews(dual)[0];
  const userContent = review.body.messages[1].content;
  const text = Array.isArray(userContent) ? userContent[0].text : String(userContent);
  assert.ok(text.includes('没有提供本地模型的分数'), '必须显式说明没有本地分可参考');
  assert.ok(!text.includes('本地决策模型的原始判断'), '不得声称带了本地原始分');
});

test('review()（串行形态）：能拿到 base 时，提示词里必须写明 Laya 的原始分', async () => {
  const dual = makeDualFetch({ reviewJson: reviewedJson([reviewRow('look1', 4.0)]) });
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, visionBaseUrl: 'https://vision.test/v1', visionModel: 'vision-test' },
    fetchImpl: dual.fetchImpl,
  });
  const system = makeReviewSystem({ api });
  await system.review({
    artifacts: artifacts(),
    descriptions: { look1: '客观记录', look2: '客观记录' },
    userState: STATE,
    question: QUESTION,
    base: { byLook: { look1: { scores: layaScores(2.0) }, look2: { scores: layaScores(3.5) } } },
  });
  const review = reviews(dual)[0];
  const userContent = review.body.messages[1].content;
  const text = Array.isArray(userContent) ? userContent[0].text : String(userContent);
  assert.ok(text.includes('本地决策模型的原始判断'), '必须写明这是本地模型的原始判断');
  assert.ok(text.includes('2.0') && text.includes('3.5'), '两套的原始分都要带上');
});

test('multimodal_only：完全不经过 Laya 打分，只由多模态给分', async () => {
  const dual = makeDualFetch({
    layaScore: 1.5,
    reviewJson: reviewedJson([reviewRow('look1', 3.3), reviewRow('look2', 4.4)]),
  });
  const quick = await orchestrator(dual, 'multimodal_only').runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });

  // 仍然只发了 describe（1 套 1 次），没有任何 6 维打分请求打到决策模型
  const scoreCalls = dual.calls.decision.filter((c) => Array.isArray(c.body.questions)
    && c.body.questions.some((q) => q.id === 'overall_score'));
  assert.equal(scoreCalls.length, 0, 'multimodal_only 不得请求 Laya 打分');
  assert.equal(quick.byLook.look1.scores.overall_score, 3.3);
  assert.deepEqual(quick.ranked.map((r) => r.lookId), ['look2', 'look1']);
  assert.equal(quick.engineMode, 'multimodal_only');
});

/* ────────────────────────── 失败回退 ────────────────────────── */

test('laya_review：多模态失败 → 回退 Laya 原分，不清空结果（§3.9c）', async () => {
  const dual = makeDualFetch({ layaScore: 2.6, reviewStatus: 500 });
  const quick = await orchestrator(dual, 'laya_review').runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });

  assert.equal(quick.reviewFailed, true);
  assert.equal(quick.reviewErrorKind, 'server');
  for (const row of quick.ranked) assert.equal(row.scores.overall_score, 2.6, '回退到 Laya 原分');
  assert.equal(quick.ranked.length, 2, '结果不得被清空');
});

test('laya_review：多模态返回垃圾 → 按 parse 失败回退（不编造分数）', async () => {
  const dual = makeDualFetch({ layaScore: 3.1, reviewJson: '抱歉，我无法完成这个请求' });
  const quick = await orchestrator(dual, 'laya_review').runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });
  assert.equal(quick.reviewFailed, true);
  assert.equal(quick.reviewErrorKind, 'parse');
  for (const row of quick.ranked) assert.equal(row.scores.overall_score, 3.1);
});

test('multimodal_only：多模态失败 → 直接报错（没有可回退的分数）', async () => {
  const dual = makeDualFetch({ reviewStatus: 500 });
  await assert.rejects(
    () => orchestrator(dual, 'multimodal_only').runQuick({
      artifacts: artifacts(), userState: STATE, question: QUESTION,
    }),
    (err) => err.kind === 'server',
  );
});

test('未配置多模态端点 → 报 vision_unconfigured，并给出配置指引（不静默降级）', async () => {
  const dual = makeDualFetch({ reviewJson: reviewedJson([reviewRow('look1', 4.0)]) });
  const api = makeApi({ config: { ...DEFAULT_CONFIG, visionBaseUrl: '', visionModel: '' }, fetchImpl: dual.fetchImpl });
  const quick = await makeOrchestrator({ api, model: 'laya', engineMode: 'laya_review' }).runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });
  // laya_review 下回退到 Laya 原分，但原因必须是"没配置"而不是"网络问题"
  assert.equal(quick.reviewFailed, true);
  assert.equal(quick.reviewErrorKind, 'vision_unconfigured');
});

test('visionServerSide=true → 判据就绪，且纠正改走决策通道带图（实测踩过的分裂）', async () => {
  // 本机 Laya 适配器形态：视觉配置在**服务端**（适配器读自己的 .env.local），
  // App 侧没有 visionBaseUrl/visionModel。这里直测两个单元契约，
  // 而不是走整条 orchestrator（替身的通道识别会干扰，见下方注释）。
  const ready = makeApi({
    config: { ...DEFAULT_CONFIG, visionBaseUrl: '', visionModel: '', visionServerSide: true },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  // ① 判据必须认 visionServerSide，否则设置页解锁了、纠正却会放弃（真实发生的分裂）
  assert.equal(ready.visionReady(), true, 'visionServerSide 必须算"纠正可能生效"');
  // ② 但"App 有没有自己的端点"仍必须是 false —— describe 据此退回决策通道，
  //    由适配器在服务端看图。这两个语义混用一次就造成了 vision_unconfigured 分裂。
  assert.equal(ready.visionEndpointConfigured(), false, 'App 侧确实没有自己的端点');
  assert.equal(ready.visionConfigured(), false, 'visionConfigured 是端点语义，不能算服务端形态');

  // ③ 服务端形态下纠正必须经决策通道、且**必须带图**（否则服务端也无从判断）
  const calls = [];
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, visionBaseUrl: '', visionModel: '', visionServerSide: true },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body || '{}');
      calls.push({ url: String(url), body });
      const isReview = (body.questions || []).some((q) => q && q.id === 'review');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vision-test',
          answers: isReview
            ? [{ id: 'review', type: 'text', content: reviewedJson([reviewRow('look1', 4.6)]), confidence: 0.8 }]
            : [],
          usage: {},
        }),
      };
    },
  });
  const system = makeReviewSystem({ api });
  const result = await system.reviewWithPrompt({
    prompt: '纠正指令',
    artifacts: artifacts(['look1']),
    lookIds: ['look1'],
    base: null,
  });

  const reviewCall = calls.find((c) => (c.body.questions || []).some((q) => q && q.id === 'review'));
  assert.ok(reviewCall, '纠正确实发出了请求');
  assert.ok(!/chat\/completions/.test(reviewCall.url), 'App 没有自己的端点 → 不得打 chat/completions');
  // 本文件的 artifacts() 返回 2 套（LOOKS = look1/look2）；
  // 图必须**全部**随决策通道发出（缺一套服务端就少看一套）
  assert.equal(reviewCall.body.images.length, 2, '必须把图随决策通道一起发出');
  assert.ok(reviewCall.body.images.every((img) => typeof img.dataUri === 'string' && img.dataUri.startsWith('data:')));
  assert.equal(reviewCall.body.images[0].id, 'look1');
  assert.equal(result.scores.look1.overall_score, 4.6, '纠正结果要被解析出来');
});

/* ────────────────────────── 解析与契约 ────────────────────────── */

test('parseReviewScores：必须吃下真实模型给的「按 lookId 嵌套 + 中文维度名」形状', () => {
  // 这是 DeepSeek-flash 看真实照片时**实际**返回的形状（实测抓到的原文）。
  // 之前只认 {scores:[...]}，导致每一轮纠正都走 parse 失败回退、被静默丢弃。
  const realShape = JSON.stringify({
    look1: { 整体得分: 4.6, 美观度: 4.4, 场合适配度: 5.0, 身材友好度: 4.1, 风格统一度: 4.8, 实用舒适度: 4.2 },
    look2: { 整体得分: 1.5, 美观度: 2.6, 场合适配度: 0.8, 身材友好度: 3.0, 风格统一度: 1.8, 实用舒适度: 3.2 },
  });
  const scores = parseReviewScores(realShape, ['look1', 'look2']);
  assert.equal(scores.look1.overall_score, 4.6);
  assert.equal(scores.look1.scene_score, 5.0, '场合适配度 要映射到 scene_score');
  assert.equal(scores.look1.figure_score, 4.1, '身材友好度 要映射到 figure_score');
  assert.equal(scores.look2.overall_score, 1.5);
  assert.equal(scores.look2.scene_score, 0.8);
});

test('parseReviewScores：裸数组与英文键混用也要能归一化', () => {
  const mixed = JSON.stringify([
    { lookId: 'look1', overall: 4.0, aesthetic: 3.5, scene: 4.2, figure: 3.1, style: 3.9, practical: 4.4 },
  ]);
  const scores = parseReviewScores(mixed, ['look1']);
  assert.equal(scores.look1.overall_score, 4.0);
  assert.equal(scores.look1.scene_score, 4.2);
  assert.equal(scores.look1.practical_score, 4.4);
});

test('parseReviewScores：中文形状里六维不齐的套仍要拒绝（不给半套）', () => {
  const partial = JSON.stringify({ look1: { 整体得分: 4.6, 美观度: 4.4 } });
  assert.throws(() => parseReviewScores(partial, ['look1']), (err) => err.kind === 'parse');
});

test('parseReviewScores：容错 markdown 围栏与前后缀', () => {
  const good = parseReviewScores(
    '```json\n' + reviewedJson([reviewRow('look1', 4.5)]) + '\n```',
    ['look1'],
  );
  assert.equal(good.look1.overall_score, 4.5);

  const chatty = parseReviewScores(
    `好的，这是我的判断：\n${reviewedJson([reviewRow('look1', 3.0)])}\n希望有帮助！`,
    ['look1'],
  );
  assert.equal(chatty.look1.overall_score, 3.0);
});

test('parseReviewScores：6 维不齐 / 越界 / 未知 lookId 一律丢弃（宁可回退也不编造）', () => {
  // 缺一个维度 → 整条丢
  const partial = { lookId: 'look1', overall_score: 4.0, aesthetic_score: 4.0, scene_score: 4.0, figure_score: 4.0, style_score: 4.0 };
  assert.throws(() => parseReviewScores(JSON.stringify({ scores: [partial] }), ['look1']), (err) => err.kind === 'parse');

  // 未知 lookId → 丢
  assert.throws(
    () => parseReviewScores(JSON.stringify({ scores: [reviewRow('look9', 4.0)] }), ['look1']),
    (err) => err.kind === 'parse',
  );

  // 越界分数被钳制到 [0,5] 且保留 1 位小数
  const clamped = parseReviewScores(JSON.stringify({ scores: [reviewRow('look1', 9)] }), ['look1']);
  assert.equal(clamped.look1.overall_score, 5);
});

test('parseReviewScores：非 JSON / 空 JSON 必须抛 parse', () => {
  for (const input of ['', '   ', 'no json here', '{"other":1}', '[]', 'null']) {
    assert.throws(() => parseReviewScores(input, ['look1']), (err) => err.kind === 'parse', `输入 ${JSON.stringify(input)}`);
  }
});

test('hasScoreDelta：能识别"纠正是否真的改了分数"', () => {
  const base = { byLook: { look1: { scores: layaScores(1.5) } } };
  assert.equal(hasScoreDelta(base, { look1: layaScores(1.5) }, 'look1'), false, '完全相同 → 没改');
  assert.equal(hasScoreDelta(base, { look1: layaScores(1.6) }, 'look1'), true, '有差异 → 改了');
  // 只有一个维度不同也算改了
  const oneDim = { look1: { ...layaScores(1.5), scene_score: 4.0 } };
  assert.equal(hasScoreDelta(base, oneDim, 'look1'), true);
});

/* ────────────────── 产品硬约束：纠正也不能产出解释文本 ────────────────── */

test('System One 硬约束在纠正后仍成立：没有任何解释性文本进入结果', async () => {
  const EXPLANATORY = /建议|推荐|因为你|显得|好看|漂亮|理由|评价|结论|解释/;
  const dual = makeDualFetch({
    layaScore: 2.0,
    // 模型多嘴：JSON 外面裹了说明文字——解析层必须只取 JSON，说明文字不得进入结果
    reviewJson: `这一套很适合正式面试，建议保留：${reviewedJson([reviewRow('look1', 4.2), reviewRow('look2', 2.8)])}`,
  });
  const quick = await orchestrator(dual, 'laya_review').runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });

  for (const row of quick.ranked) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ['confidences', 'lookId', 'overall', 'rank', 'relevance', 'scores'],
      'ranked 行不得出现解释性字段',
    );
  }
  const serialized = JSON.stringify({ ranked: quick.ranked, byLook: quick.byLook });
  assert.ok(!EXPLANATORY.test(serialized), `结果不得含解释性文本：${serialized.slice(0, 200)}`);
  assert.ok(!serialized.includes('建议保留'), '模型多写的说明文字不得进入结果');
});

test('buildReviewPrompt：每套都点名，且写清 6 个维度', () => {
  const prompt = buildReviewPrompt({
    userState: STATE,
    question: QUESTION,
    base: { byLook: { look1: { scores: layaScores(2.0) }, look2: { scores: layaScores(3.0) } } },
    lookIds: ['look1', 'look2'],
    descriptions: { look1: DESCRIPTION },
  });
  assert.ok(prompt.includes('第 1 套') && prompt.includes('第 2 套'));
  assert.ok(prompt.includes('整体得分') && prompt.includes('场合适配度'));
  assert.ok(/look1/.test(prompt) && /look2/.test(prompt));
});

test('REVIEW_SYSTEM_PROMPT：要求只输出 JSON、且明确禁止解释文字', () => {
  assert.ok(REVIEW_SYSTEM_PROMPT.includes('只输出一个 JSON'));
  assert.ok(REVIEW_SYSTEM_PROMPT.includes('不要任何解释文字'));
});

test('vision 通道：API Key 只进 Authorization，绝不进请求体', async () => {
  const dual = makeDualFetch({ reviewJson: reviewedJson([reviewRow('look1', 4.0)]) });
  await orchestrator(dual, 'laya_review').runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });
  const call = dual.calls.vision[0];
  assert.equal(call.headers.Authorization, 'Bearer sk-vision-secret');
  assert.ok(!JSON.stringify(call.body).includes('sk-vision-secret'), 'Key 绝不能出现在请求体里');
});

test('makeReviewSystem：无 api.vision 时按 server 失败，不静默返回空分数', async () => {
  const system = makeReviewSystem({ api: { ask: async () => ({}) } });
  await assert.rejects(
    () => system.review({ artifacts: artifacts(), base: null }),
    (err) => err.kind === 'server',
  );
});

/* ───── 真实端点踩过的坑：推理模型 content 为空串（HTTP 仍是 200） ───── */

test('纠正：模型只回了空 content（推理吃光预算）→ 判 parse 失败，不产出假分数', async () => {
  const calls = { vision: 0 };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    if (/chat\/completions/.test(url)) {
      calls.vision += 1;
      const userMessage = (body.messages || []).find((m) => m && m.role === 'user');
      const raw = userMessage ? userMessage.content : '';
      const text = Array.isArray(raw)
        ? raw.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
        : String(raw || '');
      const isDescribe = /客观描述/.test(text);
      // 关键：只有**纠正**那一步返回空串。描述必须正常，否则整轮 runQuick 会比我这一步先失败，
      // 测到的就不是"纠正返回空"这个真实故障了。
      // 空串正是 deepseek-flash 在 max_tokens 过小时的实测表现：HTTP 200，content 为 ""。
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'reasoning-model',
          choices: [{ message: { role: 'assistant', content: isDescribe ? DESCRIPTION : '' }, finish_reason: isDescribe ? 'stop' : 'length' }],
          usage: { prompt_tokens: 200, completion_tokens: 200, total_tokens: 400 },
        }),
      };
    }
    const isDescribe = Array.isArray(body.questions)
      && body.questions.some((q) => String(q.id).startsWith('describe_'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'laya',
        answers: isDescribe
          ? body.questions.map((q) => ({ id: q.id, type: 'text', content: DESCRIPTION, confidence: 0.8 }))
          : body.questions.map((q) => ({ id: q.id, type: 'score', score: 2.2, confidence: 0.5, content: '' })),
        usage: {},
      }),
    };
  };
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, visionBaseUrl: 'https://v.test/v1', visionModel: 'reasoning-model' },
    fetchImpl,
  });
  const quick = await makeOrchestrator({ api, model: 'laya', engineMode: 'laya_review' }).runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });
  assert.equal(quick.reviewFailed, true);
  assert.equal(quick.reviewErrorKind, 'parse');
  for (const row of quick.ranked) assert.equal(row.scores.overall_score, 2.2, '必须回退 Laya 原分，不得出现空分');
});

test('vision 通道：请求体必须带足 max_tokens（实测过小会导致 content 空串）', async () => {
  const dual = makeDualFetch({ reviewJson: reviewedJson([reviewRow('look1', 4.0)]) });
  await orchestrator(dual, 'laya_review').runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });
  const body = dual.calls.vision[0].body;
  assert.ok(Number.isFinite(body.max_tokens), '必须显式给 max_tokens');
  assert.ok(body.max_tokens >= 1000, `预算太小会被 reasoning 吃光，实际 ${body.max_tokens}`);
});
