// SPEC §3.6 状态机单测：全部 action + 不可变性 + 选择器。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLOW_PHASES,
  SYSTEM_MODES,
  flowReducer,
  initialFlowState,
  normalizeSystemMode,
  selectDeepFor,
  selectRankedLooks,
  selectResultLooks,
} from '../src/core/flow.js';

const reduce = (state, action) => flowReducer(state, action);
const artifact = (lookId) => ({ lookId, mime: 'image/jpeg', base64: 'AAAA', width: 390, height: 520 });
const RANKED = [
  { lookId: 'look1', rank: 1, overall: 4.5, scores: {}, confidences: {}, relevance: [] },
  { lookId: 'look2', rank: 2, overall: 3.5, scores: {}, confidences: {}, relevance: [] },
];
const REPORT = { ranking: [{ lookId: 'look1', stars: 4.5, oneLineReason: 'x' }], details: [], conclusion: {} };

test('initialFlowState 与 SPEC §3.6 一致，且每次 RESET_ALL 得到全新对象', () => {
  assert.deepEqual(FLOW_PHASES, ['idle', 'describing', 'scoring', 'quick_done', 'deep_running', 'deep_done', 'error']);
  assert.equal(initialFlowState.phase, 'idle');
  assert.deepEqual(initialFlowState.userState, { occasion: [], weather: [], style: [], note: '' });
  assert.deepEqual(initialFlowState.question, { builtinId: null, text: '' });
  assert.deepEqual(initialFlowState.artifacts, []);
  assert.equal(initialFlowState.quick, null);
  assert.equal(initialFlowState.deep, null);
  assert.equal(initialFlowState.error, null);
  assert.equal(initialFlowState.weakNetwork, false);
  assert.equal(initialFlowState.compareOpen, false);
  const a = reduce(initialFlowState, { type: 'RESET_ALL' });
  const b = reduce(initialFlowState, { type: 'RESET_ALL' });
  assert.notEqual(a.userState, b.userState, 'RESET_ALL 不得共享 userState 引用');
  assert.notEqual(a.artifacts, initialFlowState.artifacts);
});

test('SET_ARTIFACTS：换图作废本次结果，同图重复设置保留结果', () => {
  const withImages = reduce(initialFlowState, { type: 'SET_ARTIFACTS', artifacts: [artifact('look1')] });
  assert.equal(withImages.artifacts.length, 1);
  const done = reduce(withImages, { type: 'QUICK_DONE', ranked: RANKED, usage: { total_tokens: 1 }, model: 'm' });
  assert.equal(done.phase, 'quick_done');
  const sameAgain = reduce(done, { type: 'SET_ARTIFACTS', artifacts: [artifact('look1')] });
  assert.equal(sameAgain.quick.ranked.length, 2, '同一组图重复设置不丢结果');
  const changed = reduce(done, { type: 'SET_ARTIFACTS', artifacts: [artifact('look1'), artifact('look2')] });
  assert.equal(changed.quick, null);
  assert.equal(changed.deep, null);
  assert.equal(changed.phase, 'idle');
});

test('TOGGLE_STATE / SET_NOTE：上下文变更不改动已有结果', () => {
  const done = reduce(
    reduce(initialFlowState, { type: 'QUICK_DONE', ranked: RANKED, usage: null, model: null }),
    { type: 'TOGGLE_STATE', group: 'occasion', id: 'commute' },
  );
  assert.deepEqual(done.userState.occasion, ['commute']);
  assert.equal(done.quick.ranked.length, 2, '上下文变更不得清空 quick');
  const toggledOff = reduce(done, { type: 'TOGGLE_STATE', group: 'occasion', id: 'commute' });
  assert.deepEqual(toggledOff.userState.occasion, []);
  const ordered = reduce(
    reduce(done, { type: 'TOGGLE_STATE', group: 'style', id: 'youthful' }),
    { type: 'TOGGLE_STATE', group: 'style', id: 'minimal' },
  );
  assert.deepEqual(ordered.userState.style, ['minimal', 'youthful'], '保持枚举顺序');
  const badGroup = reduce(done, { type: 'TOGGLE_STATE', group: 'nope', id: 'commute' });
  assert.deepEqual(badGroup.userState.occasion, ['commute'], '非法 group 不改变状态');
  const noted = reduce(done, { type: 'SET_NOTE', note: 'x'.repeat(260) });
  assert.equal(noted.userState.note.length, 200, 'note 截断到 200');
  assert.deepEqual(reduce(done, { type: 'SET_NOTE' }).userState.note, '');
});

test('SET_QUESTION / CLEAR_QUESTION：内置问题自动补文案', () => {
  const picked = reduce(initialFlowState, { type: 'SET_QUESTION', builtinId: 'slimmer', text: '' });
  assert.deepEqual(picked.question, { builtinId: 'slimmer', text: '哪套更显瘦？' });
  const custom = reduce(initialFlowState, { type: 'SET_QUESTION', builtinId: null, text: '这套能见客户吗' });
  assert.deepEqual(custom.question, { builtinId: null, text: '这套能见客户吗' });
  const unknownBuiltin = reduce(initialFlowState, { type: 'SET_QUESTION', builtinId: 'nope', text: 'x' });
  assert.deepEqual(unknownBuiltin.question, { builtinId: null, text: 'x' });
  assert.deepEqual(reduce(picked, { type: 'CLEAR_QUESTION' }).question, { builtinId: null, text: '' });
});

test('RUN_QUICK_START / SET_DESCRIPTIONS / QUICK_DONE 的阶段推进', () => {
  const started = reduce(initialFlowState, { type: 'RUN_QUICK_START' });
  assert.equal(started.phase, 'describing');
  assert.equal(started.quick, null);
  assert.equal(started.error, null);
  const described = reduce(started, { type: 'SET_DESCRIPTIONS', descriptions: { look1: '整体风格：简约' } });
  assert.equal(described.phase, 'scoring');
  assert.deepEqual(described.descriptions, { look1: '整体风格：简约' });
  const done = reduce(described, { type: 'QUICK_DONE', ranked: RANKED, usage: { total_tokens: 9 }, model: 'm1' });
  assert.equal(done.phase, 'quick_done');
  assert.deepEqual(done.quick, {
    ranked: RANKED,
    usage: { total_tokens: 9 },
    model: 'm1',
    // v1.5 §3.9c：结论来源字段必须随结果留存，未提供时显式落 null/false
    engineMode: null,
    reviewModel: null,
    reviewedAt: null,
    reviewFailed: false,
    reviewErrorKind: null,
    reviewChanged: null,
    reviewFailedLooks: null,
  });
  const tolerant = reduce(described, { type: 'QUICK_DONE' });
  assert.equal(tolerant.quick.ranked.length, 0);
  assert.equal(tolerant.quick.usage, null);
  assert.equal(tolerant.quick.model, null);
  assert.equal(tolerant.quick.engineMode, null);
  assert.equal(tolerant.quick.reviewFailed, false, '缺字段时不得是 undefined（界面要能直接读）');
});

test('QUICK_DONE：引擎档位与纠正状态随结果留存，供结果页如实标注（§3.9c）', () => {
  const done = reduce(initialFlowState, {
    type: 'QUICK_DONE',
    ranked: RANKED,
    usage: null,
    model: 'laya',
    engineMode: 'laya_review',
    reviewModel: 'deepseek-flash',
    reviewedAt: 1700000000000,
    reviewFailed: false,
    reviewChanged: ['look1', 'look2'],
  });
  assert.equal(done.quick.engineMode, 'laya_review');
  assert.equal(done.quick.reviewModel, 'deepseek-flash');
  assert.equal(done.quick.reviewedAt, 1700000000000);
  assert.deepEqual(done.quick.reviewChanged, ['look1', 'look2']);

  // 纠正失败：必须记下原因，界面才能说明"显示的是本地模型判断"
  const failed = reduce(initialFlowState, {
    type: 'QUICK_DONE',
    ranked: RANKED,
    engineMode: 'laya_review',
    reviewFailed: true,
    reviewErrorKind: 'vision_unconfigured',
  });
  assert.equal(failed.quick.reviewFailed, true);
  assert.equal(failed.quick.reviewErrorKind, 'vision_unconfigured');

  // 界面层可能叫 reviewChange；两个名字都要收，避免命名漂移丢数据
  const alias = reduce(initialFlowState, { type: 'QUICK_DONE', ranked: RANKED, reviewChange: ['look3'] });
  assert.deepEqual(alias.quick.reviewChanged, ['look3']);
});

test('RUN_QUICK_START 重新跑会清掉旧 deep，RUN_DEEP_START 保留 quick', () => {
  const afterQuick = reduce(initialFlowState, { type: 'QUICK_DONE', ranked: RANKED, usage: null, model: null });
  const afterDeep = reduce(afterQuick, { type: 'DEEP_DONE', report: REPORT, lookId: 'look1' });
  assert.equal(afterDeep.phase, 'deep_done');
  const deepStarted = reduce(afterDeep, { type: 'RUN_DEEP_START' });
  assert.equal(deepStarted.phase, 'deep_running');
  assert.equal(deepStarted.quick.ranked.length, 2, '深度分析不得清掉快速评分（§4.2 同屏对比）');
  assert.equal(deepStarted.deep.look1, REPORT, '已完成的报告保留');
  const requick = reduce(afterDeep, { type: 'RUN_QUICK_START' });
  assert.equal(requick.deep, null, '重跑快速评分会作废旧深度报告');
  assert.equal(requick.phase, 'describing');
});

test('QUICK_FAIL / DEEP_FAIL / SET_ERROR / CLEAR_ERROR', () => {
  const failed = reduce(initialFlowState, { type: 'QUICK_FAIL', error: { kind: 'network', message: 'x' }, lookId: null });
  assert.equal(failed.phase, 'error');
  assert.equal(failed.error.kind, 'network');
  assert.equal(failed.error.lookId, null);
  const partial = reduce(initialFlowState, { type: 'QUICK_FAIL', error: { kind: 'timeout' }, lookId: 'look3' });
  assert.equal(partial.error.lookId, 'look3');
  const quick = reduce(initialFlowState, { type: 'QUICK_DONE', ranked: RANKED, usage: null, model: null });
  const deepFail = reduce(quick, { type: 'DEEP_FAIL', error: { kind: 'server' }, lookId: 'look2' });
  assert.equal(deepFail.phase, 'error');
  assert.equal(deepFail.quick.ranked.length, 2, '深度失败不丢已出的分数');
  assert.equal(deepFail.error.lookId, 'look2');
  assert.equal(reduce(deepFail, { type: 'CLEAR_ERROR' }).phase, 'quick_done', '清错回到有数据的那一相');
  assert.equal(reduce(deepFail, { type: 'CLEAR_ERROR' }).error, null);
  const deepDone = reduce(deepFail, { type: 'DEEP_DONE', report: REPORT, lookId: 'look1' });
  const cleared = reduce(reduce(deepDone, { type: 'SET_ERROR', error: { kind: 'parse' } }), { type: 'CLEAR_ERROR' });
  assert.equal(cleared.phase, 'deep_done');
  assert.equal(reduce(initialFlowState, { type: 'CLEAR_ERROR' }).phase, 'idle');
  assert.equal(reduce(initialFlowState, { type: 'SET_ERROR', error: null }).error, null);
  assert.equal(reduce(initialFlowState, { type: 'SET_ERROR', error: 'boom' }).error.message, 'boom');
});

test('SET_WEAK / TOGGLE_COMPARE', () => {
  const weak = reduce(initialFlowState, { type: 'SET_WEAK', flag: true });
  assert.equal(weak.weakNetwork, true);
  assert.equal(reduce(weak, { type: 'SET_WEAK', flag: false }).weakNetwork, false);
  assert.equal(reduce(initialFlowState, { type: 'SET_WEAK', flag: 'yes' }).weakNetwork, false, '仅 true 生效');
  const compared = reduce(initialFlowState, { type: 'TOGGLE_COMPARE' });
  assert.equal(compared.compareOpen, true);
  assert.equal(reduce(compared, { type: 'TOGGLE_COMPARE' }).compareOpen, false);
});

test('RESET_RUN：清图片引用与结果，保留 descriptions 与用户上下文（§4.1）', () => {
  let state = reduce(initialFlowState, { type: 'SET_ARTIFACTS', artifacts: [artifact('look1'), artifact('look2')] });
  state = reduce(state, { type: 'TOGGLE_STATE', group: 'weather', id: 'rainy' });
  state = reduce(state, { type: 'SET_NOTE', note: '带伞' });
  state = reduce(state, { type: 'SET_DESCRIPTIONS', descriptions: { look1: '整体风格：简约' } });
  state = reduce(state, { type: 'QUICK_DONE', ranked: RANKED, usage: null, model: null });
  state = reduce(state, { type: 'DEEP_DONE', report: REPORT, lookId: 'look1' });
  const reset = reduce(state, { type: 'RESET_RUN' });
  assert.deepEqual(reset.artifacts, [], '图片引用必须清空（隐私不变量）');
  assert.equal(reset.quick, null);
  assert.equal(reset.deep, null);
  assert.equal(reset.phase, 'idle');
  assert.deepEqual(reset.descriptions, { look1: '整体风格：简约' }, 'descriptions 按 §4.1 保留');
  assert.deepEqual(reset.userState.weather, ['rainy']);
  assert.equal(reset.userState.note, '带伞');
});

test('RESET_ALL：回到初始状态（含用户上下文）', () => {
  let state = reduce(initialFlowState, { type: 'SET_ARTIFACTS', artifacts: [artifact('look1')] });
  state = reduce(state, { type: 'TOGGLE_STATE', group: 'occasion', id: 'date' });
  state = reduce(state, { type: 'SET_WEAK', flag: true });
  state = reduce(state, { type: 'TOGGLE_COMPARE' });
  const reset = reduce(state, { type: 'RESET_ALL' });
  assert.deepEqual(reset, {
    phase: 'idle',
    artifacts: [],
    userState: { occasion: [], weather: [], style: [], note: '' },
    question: { builtinId: null, text: '' },
    descriptions: {},
    quick: null,
    deep: null,
    error: null,
    weakNetwork: false,
    compareOpen: false,
  });
});

test('未知 action 返回等价新对象，不抛错、不改入参', () => {
  const next = reduce(initialFlowState, { type: 'NOT_AN_ACTION' });
  assert.notEqual(next, initialFlowState);
  assert.deepEqual(next, initialFlowState);
  assert.deepEqual(reduce(undefined, { type: 'RESET_ALL' }).phase, 'idle');
});

test('reducer 纯函数：深冻结状态上跑全部 action 不抛错', () => {
  const deepFreeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
  };
  const frozen = deepFreeze({
    ...initialFlowState,
    artifacts: [{ lookId: 'look1', base64: 'AAAA' }],
    userState: { occasion: ['commute'], weather: [], style: [], note: '' },
    question: { builtinId: 'slimmer', text: '哪套更显瘦？' },
    descriptions: { look1: '整体风格：简约' },
    quick: { ranked: RANKED, usage: null, model: null },
    deep: { look1: REPORT },
  });
  const actions = [
    { type: 'SET_ARTIFACTS', artifacts: [] },
    { type: 'SET_ARTIFACTS', artifacts: [{ lookId: 'look1' }] },
    { type: 'TOGGLE_STATE', group: 'occasion', id: 'commute' },
    { type: 'TOGGLE_STATE', group: 'weather', id: 'rainy' },
    { type: 'SET_NOTE', note: 'x' },
    { type: 'SET_QUESTION', builtinId: 'style_fit', text: '' },
    { type: 'CLEAR_QUESTION' },
    { type: 'RUN_QUICK_START' },
    { type: 'SET_DESCRIPTIONS', descriptions: { look2: '整体风格：酷' } },
    { type: 'QUICK_DONE', ranked: RANKED, usage: null, model: null },
    { type: 'QUICK_FAIL', error: { kind: 'network' }, lookId: null },
    { type: 'RUN_DEEP_START' },
    { type: 'DEEP_DONE', report: REPORT, lookId: 'look2' },
    { type: 'DEEP_FAIL', error: { kind: 'timeout' }, lookId: 'look2' },
    { type: 'SET_ERROR', error: { kind: 'auth' } },
    { type: 'CLEAR_ERROR' },
    { type: 'SET_WEAK', flag: true },
    { type: 'TOGGLE_COMPARE' },
    { type: 'RESET_RUN' },
    { type: 'RESET_ALL' },
  ];
  for (const action of actions) {
    const next = reduce(frozen, action);
    assert.ok(next && typeof next === 'object', `${action.type} 必须返回对象`);
    assert.notEqual(next, frozen, `${action.type} 必须返回新对象`);
    assert.equal(next.compareOpen, action.type === 'TOGGLE_COMPARE' ? true : frozen.compareOpen);
  }
  assert.deepEqual(frozen.userState.occasion, ['commute'], '入参未被修改');
  assert.equal(frozen.quick.ranked.length, 2);
});

test('selectRankedLooks / selectDeepFor', () => {
  assert.deepEqual(selectRankedLooks(initialFlowState), []);
  assert.deepEqual(selectRankedLooks({ quick: { ranked: RANKED } }), RANKED);
  assert.deepEqual(selectRankedLooks({ quick: {} }), []);
  assert.deepEqual(selectRankedLooks(null), []);
  assert.equal(selectDeepFor({ deep: { look1: REPORT } }, 'look1'), REPORT);
  assert.equal(selectDeepFor({ deep: { look1: REPORT } }, 'look3'), null);
  assert.equal(selectDeepFor({}, 'look1'), null);
  assert.equal(selectDeepFor(null, 'look1'), null);
});

/* ── SPEC §3.13 v1.7 · 用户自选跑哪个系统（不再强制先 System One） ─────── */

test('normalizeSystemMode：三档都认，非法值一律回退 quick', () => {
  assert.equal(normalizeSystemMode('quick'), 'quick');
  assert.equal(normalizeSystemMode('deep'), 'deep');
  assert.equal(normalizeSystemMode('both'), 'both');
  // 回退语义：宁可跑最便宜的 System One，也不要因为一个错值而什么都不跑
  assert.equal(normalizeSystemMode(undefined), 'quick');
  assert.equal(normalizeSystemMode(null), 'quick');
  assert.equal(normalizeSystemMode(''), 'quick');
  assert.equal(normalizeSystemMode('DEEP'), 'quick', '大小写不匹配 → 回退，不做隐式转换');
  assert.equal(normalizeSystemMode('two'), 'quick');
  assert.equal(normalizeSystemMode(0), 'quick');
  assert.equal(normalizeSystemMode({}), 'quick');
});

test('normalizeSystemMode：任何输入都只可能得到 SYSTEM_MODES 里的值', () => {
  const inputs = ['quick', 'deep', 'both', 'laya', 'one', 1, true, [], {}, NaN, undefined, null];
  for (const input of inputs) {
    assert.ok(SYSTEM_MODES.includes(normalizeSystemMode(input)), `${String(input)} 返回了非法档位`);
  }
});

/* ── SPEC §3.13b · deep-only 时结果页要展示什么 ─────────────────── */

test('selectResultLooks：有快速分时原样返回（不动 System One 的口径）', () => {
  const state = reduce(initialFlowState, {
    type: 'QUICK_DONE',
    ranked: [{ lookId: 'look1', rank: 1, overall: 4.2, scores: { overall_score: 4.2 } }],
    usage: null,
    model: 'm',
  });
  const looks = selectResultLooks(state);
  assert.equal(looks.length, 1);
  assert.equal(looks[0].overall, 4.2);
  assert.equal(looks[0].source, undefined, '有 quick 时不得被标成 deep');
});

test('selectResultLooks：只有深度报告时回落到 System Two，并标注 source=deep', () => {
  // 这是"用户直接选深度分析"的那一轮：flow.quick 为空，但报告齐全。
  // 修复前结果页会显示「还没有分数」空态（实测缺口）。
  const report = {
    ranking: [
      { lookId: 'look1', stars: 4.5, oneLineReason: 'a' },
      { lookId: 'look2', stars: 2, oneLineReason: 'b' },
    ],
    details: [],
    conclusion: { pick: 'look1' },
  };
  let state = reduce(initialFlowState, { type: 'DEEP_DONE', report, lookId: 'look1' });
  state = reduce(state, { type: 'DEEP_DONE', report, lookId: 'look2' });

  const looks = selectResultLooks(state);
  assert.equal(looks.length, 2, 'deep-only 也要给出套列表，不能是空态');
  assert.deepEqual(looks.map((l) => l.lookId), ['look1', 'look2'], '按星级降序');
  assert.deepEqual(looks.map((l) => l.rank), [1, 2]);
  assert.equal(looks[0].overall, 4.5, '要用报告的 stars 作为显示分');
  assert.equal(looks[1].overall, 2);
  assert.equal(looks[0].source, 'deep', '必须如实标注来源，别让它看起来像六维分');
  assert.deepEqual(looks[0].scores, {}, '深度分析没有六维分，不得伪造');
});

test('selectResultLooks：没有任何结果时返回空数组（让空态正常出现）', () => {
  assert.deepEqual(selectResultLooks(initialFlowState), []);
  assert.deepEqual(selectResultLooks(null), []);
  assert.deepEqual(selectResultLooks({}), []);
  assert.deepEqual(selectResultLooks({ deep: {} }), []);
});

test('selectResultLooks：报告缺 ranking / stars 非数值时排到末尾，不抛错', () => {
  let state = reduce(initialFlowState, { type: 'DEEP_DONE', report: { ranking: [], details: [], conclusion: {} }, lookId: 'look1' });
  state = reduce(state, { type: 'DEEP_DONE', report: { ranking: [{ lookId: 'look2', stars: 3 }], details: [], conclusion: {} }, lookId: 'look2' });
  const looks = selectResultLooks(state);
  assert.equal(looks.length, 2);
  assert.equal(looks[0].lookId, 'look2', '有星级的排前面');
  assert.equal(looks[1].overall, null, '没有星级 → null，不编造分数');
});

test('SET_ARTIFACTS 是"替换"语义：追加必须由调用方算好再传（防"分次选图互相冲掉"）', () => {
  const one = [{ lookId: 'look1', mime: 'image/jpeg', base64: 'a' }];
  const two = [...one, { lookId: 'look2', mime: 'image/jpeg', base64: 'b' }];
  const afterFirst = flowReducer(initialFlowState, { type: 'SET_ARTIFACTS', artifacts: one });
  assert.equal(afterFirst.artifacts.length, 1);
  // 传整份 → 得到整份（App.jsx 负责把已有的拼进来，这就是"分次选图"的正确接法）
  const afterSecond = flowReducer(afterFirst, { type: 'SET_ARTIFACTS', artifacts: two });
  assert.equal(afterSecond.artifacts.length, 2);
  assert.deepEqual(afterSecond.artifacts.map((a) => a.lookId), ['look1', 'look2']);
  // 只传新的那个 → 就是替换（旧图消失）；这正是"只能上传一张"的成因，故需测试固定该语义
  const replaced = flowReducer(afterSecond, { type: 'SET_ARTIFACTS', artifacts: one });
  assert.deepEqual(replaced.artifacts.map((a) => a.lookId), ['look1']);
});
