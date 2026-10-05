// SPEC §3.5 / §5.3 输入校验单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyUserState, stateSummary, toggle, validateInput } from '../src/core/state.js';
import { HINTS } from '../src/data/copy.js';

const ARTIFACT = (lookId) => ({ lookId, mime: 'image/jpeg', base64: 'AAAA', width: 390, height: 520 });
const looks = (n) => Array.from({ length: n }, (_, index) => ARTIFACT(`look${index + 1}`));

test('emptyUserState：每次全新对象', () => {
  const a = emptyUserState();
  assert.deepEqual(a, { occasion: [], weather: [], style: [], note: '' });
  assert.notEqual(a, emptyUserState());
  assert.notEqual(a.occasion, emptyUserState().occasion);
});

test('toggle：增删、枚举保序、去重、不改入参', () => {
  assert.deepEqual(toggle([], 'sweet'), ['sweet']);
  assert.deepEqual(toggle(['sweet'], 'sweet'), []);
  assert.deepEqual(toggle(['sweet', 'minimal'], 'cool'), ['minimal', 'sweet', 'cool'], '按枚举顺序排列');
  assert.deepEqual(toggle(['minimal', 'minimal'], 'cool'), ['minimal', 'cool'], '去重');
  assert.deepEqual(toggle(['minimal'], 'zzz_unknown'), ['minimal', 'zzz_unknown'], '未知 id 追加在末尾');
  const input = ['minimal'];
  toggle(input, 'cool');
  assert.deepEqual(input, ['minimal'], '不得修改入参');
  assert.deepEqual(toggle(null, 'hot'), ['hot'], '容错非数组入参');
});

test('validateInput：四类分支', () => {
  const noImage = validateInput({ artifacts: [], state: emptyUserState(), question: { builtinId: null, text: '' } });
  assert.equal(noImage.ok, false);
  assert.deepEqual(noImage.missing, ['images']);
  assert.equal(noImage.hints[0], HINTS.missingImages);
  assert.equal(noImage.canRunQuick, false);
  assert.equal(noImage.canRunDeep, false);

  const tooMany = validateInput({ artifacts: looks(5), state: emptyUserState(), question: { builtinId: null, text: '' } });
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.hints.includes(HINTS.tooManyImages));
  assert.equal(tooMany.canRunQuick, false);
  assert.equal(tooMany.canRunDeep, false);

  const oneLookNoContext = validateInput({ artifacts: looks(1), state: emptyUserState(), question: { builtinId: null, text: '' } });
  assert.equal(oneLookNoContext.ok, true, '缺上下文不阻塞（§5.3）');
  assert.deepEqual(oneLookNoContext.missing, []);
  assert.deepEqual(oneLookNoContext.hints, [HINTS.needContext, HINTS.oneLook]);
  assert.equal(oneLookNoContext.canRunQuick, true);
  assert.equal(oneLookNoContext.canRunDeep, true);

  const onlyQuestion = validateInput({
    artifacts: looks(2),
    state: emptyUserState(),
    question: { builtinId: 'slimmer', text: '哪套更显瘦？' },
  });
  assert.equal(onlyQuestion.ok, true);
  assert.deepEqual(onlyQuestion.hints, [], '有问题文本就不提示补场合');

  const oneLookWithOccasion = validateInput({
    artifacts: looks(1),
    state: { occasion: ['commute'], weather: [], style: [], note: '' },
    question: { builtinId: null, text: '' },
  });
  assert.deepEqual(oneLookWithOccasion.hints, [HINTS.oneLook]);

  const fourLooksNoContext = validateInput({ artifacts: looks(4), state: emptyUserState(), question: { builtinId: null, text: '' } });
  assert.equal(fourLooksNoContext.ok, true);
  assert.deepEqual(fourLooksNoContext.hints, [HINTS.needContext]);

  const ok = validateInput({
    artifacts: looks(4),
    state: { occasion: ['commute'], weather: ['cool'], style: [], note: '' },
    question: { builtinId: null, text: '' },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.hints, []);

  assert.equal(validateInput({}).ok, false, '无参不抛错');
  assert.equal(validateInput({ artifacts: [null, undefined] }).ok, false, '假图不算图');
});

test('stateSummary：空组省略、中文 label、未知 id 忽略', () => {
  assert.equal(
    stateSummary({ occasion: ['commute'], weather: ['cool'], style: ['minimal'], note: '' }),
    '通勤上班 · 凉爽 · 简约干练',
  );
  assert.equal(stateSummary({ occasion: [], weather: ['cold'], style: [], note: '' }), '寒冷');
  assert.equal(stateSummary({}), '');
  assert.equal(stateSummary(null), '');
  assert.equal(stateSummary({ occasion: ['nope'], weather: [], style: [] }), '');
  assert.equal(
    stateSummary({ occasion: ['commute', 'date'], weather: [], style: [], note: 'x' }),
    '通勤上班、约会见面',
    'note 不进入 summary',
  );
});
