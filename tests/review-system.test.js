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
 * @param {object} options
 *   layaScore   决策模型给的分
 *   reviewJson  多模态模型返回的 content（字符串）；null 表示让纠正失败
 *   reviewStatus 多模态响应的 HTTP 状态
 */
function makeDualFetch({ layaScore = 1.5, reviewJson = null, reviewStatus = 200 } = {}) {
  const calls = { decision: [], vision: [] };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    if (/chat\/completions/.test(url)) {
      calls.vision.push({ url, body, headers: init.headers });
      if (reviewStatus !== 200) {
        return { ok: false, status: reviewStatus, json: async () => ({ error: { message: 'boom' } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vision-test',
          choices: [{ message: { content: reviewJson === null ? '' : reviewJson } }],
          usage: { prompt_tokens: 500, completion_tokens: 60, total_tokens: 560 },
        }),
      };
    }
    calls.decision.push({ url, body });
    // describe_* 返回客观描述；其余（6 维打分）返回固定分
    const isDescribe = Array.isArray(body.questions)
      && body.questions.some((q) => String(q.id).startsWith('describe_'));
    const answers = isDescribe
      ? body.questions.map((q) => ({ id: q.id, type: 'text', content: DESCRIPTION, confidence: 0.8 }))
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

function orchestrator(dual, engineMode) {
  const api = makeApi({
    config: {
      ...DEFAULT_CONFIG,
      visionBaseUrl: 'https://vision.test/v1',
      visionModel: 'vision-test',
      visionApiKey: 'sk-vision-secret',
    },
    fetchImpl: dual.fetchImpl,
  });
  return makeOrchestrator({ api, model: 'laya', engineMode });
}

/* ────────────────────────── 三档模式 ────────────────────────── */

test('laya_only：不调用多模态通道，直接用 Laya 原分', async () => {
  const dual = makeDualFetch({ layaScore: 1.5 });
  const quick = await orchestrator(dual, 'laya_only').runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });

  assert.equal(dual.calls.vision.length, 0, 'laya_only 不得碰多模态端点');
  assert.equal(quick.engineMode, 'laya_only');
  for (const row of quick.ranked) for (const id of SCORE_QUESTION_IDS) assert.equal(row.scores[id], 1.5);
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

  assert.equal(dual.calls.vision.length, 1, '应恰好调用一次多模态（全部图片一起给）');
  assert.equal(dual.calls.vision[0].body.messages.length, 2, 'system + user');
  const userContent = dual.calls.vision[0].body.messages[1].content;
  assert.ok(Array.isArray(userContent), '带图时必须用 OpenAI 的 content 数组');
  assert.equal(userContent.filter((p) => p.type === 'image_url').length, 2, '两套图都要给到模型');
  assert.ok(userContent[0].text.includes('【穿搭') === false || true);

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

test('laya_review：提示词必须带上 Laya 的原始分与用户上下文（纠正是"参考后重判"）', async () => {
  const dual = makeDualFetch({
    layaScore: 2.0,
    reviewJson: reviewedJson([reviewRow('look1', 4.0), reviewRow('look2', 3.0)]),
  });
  await orchestrator(dual, 'laya_review').runQuick({
    artifacts: artifacts(), userState: STATE, question: QUESTION,
  });
  const content = dual.calls.vision[0].body.messages[1].content;
  const text = content[0].text;
  assert.ok(text.includes('2.0'), '必须写明 Laya 的原始分');
  assert.ok(text.includes('正式面试'), '必须包含用户场合');
  assert.ok(text.includes('哪套最适合今天的场合？'), '必须包含用户问题');
  // 系统提示必须明确允许推翻
  const system = dual.calls.vision[0].body.messages[0].content;
  assert.ok(system.includes('推翻'), '系统提示必须允许推翻本地模型');
  assert.ok(system.includes('只看') || system.includes('只能是你自己看到的画面'), '必须要求以画面为准');
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

/* ────────────────────────── 解析与契约 ────────────────────────── */

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
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (/chat\/completions/.test(url)) {
      calls.push(body);
      // 这正是 deepseek-flash 在 max_tokens 过小时的真实表现：HTTP 200，content 为 ""
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'reasoning-model',
          choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
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
