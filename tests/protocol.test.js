// SPEC §3.1 协议层单测：钳制、构造、解析、严格校验、排序。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_LOOKS,
  SCORE_DECIMALS,
  SCORE_QUESTION_IDS,
  buildRequest,
  buildScoreAnswers,
  clampScore,
  isScoreAnswerStrict,
  parseScoreAnswer,
  rankLooks,
  toDataUri,
} from '../src/core/protocol.js';

test('protocol 常量与 SPEC §3.1 一致', () => {
  assert.deepEqual(SCORE_QUESTION_IDS, [
    'overall_score',
    'aesthetic_score',
    'scene_score',
    'figure_score',
    'style_score',
    'practical_score',
  ]);
  assert.equal(MAX_LOOKS, 4);
  assert.equal(SCORE_DECIMALS, 1);
});

test('clampScore：1 位小数 + [0,5] 钳制 + NaN/非数值 → null', () => {
  assert.equal(clampScore(4.46), 4.5);
  assert.equal(clampScore(4.44), 4.4);
  assert.equal(clampScore(3), 3);
  assert.equal(clampScore(0), 0);
  assert.ok(Object.is(clampScore(0), 0), '0 不能是 -0');
  assert.ok(Object.is(clampScore(-0.04), 0), '负数四舍五入到 0 时不能是 -0');
  assert.equal(clampScore(5.9), 5);
  assert.equal(clampScore(6.3), 5);
  assert.equal(clampScore(-2), 0);
  assert.equal(clampScore(NaN), null);
  assert.equal(clampScore(Infinity), null);
  assert.equal(clampScore(-Infinity), null);
  assert.equal(clampScore('4.5'), null);
  assert.equal(clampScore(null), null);
  assert.equal(clampScore(undefined), null);
  assert.equal(clampScore({}), null);
});

test('toDataUri：data:{mime};base64,{base64}', () => {
  assert.equal(toDataUri({ mime: 'image/jpeg', base64: 'AAAA' }), 'data:image/jpeg;base64,AAAA');
  assert.equal(toDataUri({ mime: 'image/webp', base64: '' }), 'data:image/webp;base64,');
  assert.equal(toDataUri({}), 'data:;base64,');
});

test('buildRequest：字段顺序 model→state→questions，浅拷贝不改入参', () => {
  const questions = [{ id: 'overall_score', type: 'score', question: 'q' }];
  const out = buildRequest({ model: 'm1', state: 's1', questions });
  assert.deepEqual(Object.keys(out), ['model', 'state', 'questions']);
  assert.equal(out.model, 'm1');
  assert.equal(out.state, 's1');
  assert.deepEqual(out.questions, questions);
  assert.notEqual(out.questions, questions, 'questions 必须是新数组');
  assert.notEqual(out.questions[0], questions[0], 'question 项必须是副本');
  assert.deepEqual(questions, [{ id: 'overall_score', type: 'score', question: 'q' }]);
  assert.deepEqual(buildRequest(), { model: '', state: '', questions: [] });
});

test('buildScoreAnswers：恒 6 键、缺失为 null、未知 id 忽略、越界钳制', () => {
  const out = buildScoreAnswers([
    { id: 'overall_score', type: 'score', score: 4.5, confidence: 0.86 },
    { id: 'aesthetic_score', type: 'score', score: 6.3 },
    { id: 'scene_score', type: 'score', score: -1, confidence: 1.5 },
    { id: 'unknown_score', type: 'score', score: 3 },
    { id: 'figure_score', type: 'text', score: 4, content: '不是分数' },
  ]);
  assert.deepEqual(Object.keys(out), SCORE_QUESTION_IDS);
  assert.deepEqual(out.overall_score, { score: 4.5, confidence: 0.86 });
  assert.deepEqual(out.aesthetic_score, { score: 5, confidence: 0.5 }, '越界钳制 + 缺省 confidence 0.5');
  assert.deepEqual(out.scene_score, { score: 0, confidence: 1 }, 'confidence 越界钳制到 1');
  assert.equal(out.figure_score, null, 'type=text 不是分数答案');
  assert.equal(out.style_score, null);
  assert.equal(out.practical_score, null);
  assert.equal(out.unknown_score, undefined, '未知 id 不进入结果');
  assert.equal(Object.keys(out).length, 6);
});

test('buildScoreAnswers：同 id 取首个有效项；非数组入参安全', () => {
  const out = buildScoreAnswers([
    { id: 'overall_score', type: 'score', score: 4 },
    { id: 'overall_score', type: 'score', score: 2 },
  ]);
  assert.equal(out.overall_score.score, 4);
  assert.deepEqual(Object.keys(buildScoreAnswers(null)), SCORE_QUESTION_IDS);
  assert.equal(buildScoreAnswers(undefined).overall_score, null);
});

test('parseScoreAnswer：宽松解析与非法输入', () => {
  assert.deepEqual(
    parseScoreAnswer({ id: 'overall_score', type: 'score', score: 4.5, confidence: 0.86 }),
    { id: 'overall_score', score: 4.5, confidence: 0.86 },
  );
  assert.deepEqual(
    parseScoreAnswer({ id: 'x', type: 'score', score: 7 }),
    { id: 'x', score: 5, confidence: 0.5 },
  );
  assert.deepEqual(
    parseScoreAnswer({ id: 'x', type: 'score', score: 0.04, confidence: -3 }),
    { id: 'x', score: 0, confidence: 0 },
  );
  assert.equal(parseScoreAnswer({ id: 'x', type: 'score', score: '4' }), null);
  assert.equal(parseScoreAnswer({ id: 'x', type: 'score', score: NaN }), null);
  assert.equal(parseScoreAnswer({ id: 'x', type: 'text', score: 4 }), null);
  assert.equal(parseScoreAnswer({ id: '', type: 'score', score: 4 }), null);
  assert.equal(parseScoreAnswer({ type: 'score', score: 4 }), null);
  assert.equal(parseScoreAnswer(null), null);
  assert.equal(parseScoreAnswer([]), null);
  assert.equal(parseScoreAnswer('4'), null);
});

test('isScoreAnswerStrict：完全合规才 true（越界/多小数/坏 confidence 都 false）', () => {
  assert.equal(isScoreAnswerStrict({ id: 'a', type: 'score', score: 4.5 }), true);
  assert.equal(isScoreAnswerStrict({ id: 'a', type: 'score', score: 0 }), true);
  assert.equal(isScoreAnswerStrict({ id: 'a', type: 'score', score: 5 }), true);
  assert.equal(isScoreAnswerStrict({ id: 'a', type: 'score', score: 4.5, confidence: 1 }), true);
  assert.equal(isScoreAnswerStrict({ id: 'a', type: 'score', score: 4.55 }), false, '多于 1 位小数');
  assert.equal(isScoreAnswerStrict({ id: 'a', type: 'score', score: 5.1 }), false);
  assert.equal(isScoreAnswerStrict({ id: 'a', type: 'score', score: -0.5 }), false);
  assert.equal(isScoreAnswerStrict({ id: 'a', type: 'score', score: '4.5' }), false);
  assert.equal(isScoreAnswerStrict({ id: 'a', type: 'score', score: 4.5, confidence: 1.2 }), false);
  assert.equal(isScoreAnswerStrict({ id: 'a', type: 'text', score: 4.5 }), false);
  assert.equal(isScoreAnswerStrict({ id: '', type: 'score', score: 4.5 }), false);
  assert.equal(isScoreAnswerStrict({ id: 'a', type: 'score', score: 4.5, confidence: null }), true);
  assert.equal(isScoreAnswerStrict(null), false);
});

test('rankLooks：降序、null 垫底、同分 lookId 升序、rank 1-based、不改入参', () => {
  const rows = [
    { lookId: 'look2', scores: { overall_score: 4 } },
    { lookId: 'look1', scores: { overall_score: null } },
    { lookId: 'look3', scores: { overall_score: 4 } },
    { lookId: 'look4', scores: { overall_score: 4.5 } },
  ];
  const ranked = rankLooks(rows);
  assert.deepEqual(ranked.map((row) => row.lookId), ['look4', 'look2', 'look3', 'look1']);
  assert.deepEqual(ranked.map((row) => row.rank), [1, 2, 3, 4]);
  assert.notEqual(ranked, rows, '必须返回新数组');
  assert.deepEqual(rows.map((row) => row.lookId), ['look2', 'look1', 'look3', 'look4'], '入参顺序不变');
  assert.equal(rows[0].rank, undefined, '入参不得被追加 rank');
});

test('rankLooks：支持已带 overall 的行与被 NaN 污染的分数', () => {
  const ranked = rankLooks([
    { lookId: 'look1', overall: 3 },
    { lookId: 'look2', scores: { overall_score: NaN } },
    { lookId: 'look3', scores: { overall_score: 3.5 } },
  ]);
  assert.deepEqual(ranked.map((row) => row.lookId), ['look3', 'look1', 'look2']);
});

test('rankLooks：空输入安全', () => {
  assert.deepEqual(rankLooks([]), []);
  assert.deepEqual(rankLooks(null), []);
});
