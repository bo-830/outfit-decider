// 产品硬约束的静态 + 端到端断言：
// 1) System One 输出只有分数（零解释文本）；
// 2) src/core、src/data 是纯逻辑层（无 react / react-native / expo 依赖）；
// 3) 我方范围内没有 notImplemented 残留；
// 4) fixtures 合法且描述只做客观描述；
// 5) 结果对象不带任何图片载荷。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG, makeApi } from '../src/engine/api.js';
import { makeOrchestrator } from '../src/engine/orchestrator.js';
import { SCORE_QUESTION_IDS } from '../src/core/protocol.js';
import { DESCRIPTION_DIMENSIONS } from '../src/core/prompts.js';
import { UNRECOGNIZABLE_MARK } from '../src/data/copy.js';
import { loadDescription, makeFetchMock } from './helpers/fetchMock.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOOKS = ['look1', 'look2', 'look3', 'look4'];
const ARTIFACT = (lookId) => ({
  lookId,
  mime: 'image/jpeg',
  base64: `BASE64_${lookId}`,
  width: 390,
  height: 520,
});
const STATE = { occasion: ['commute'], weather: ['cool'], style: ['minimal'], note: '' };
const QUESTION = { builtinId: 'slimmer', text: '哪套更显瘦？' };
const EXPLANATORY = /建议|推荐|因为你|显得|好看|漂亮|理由|评价|结论|解释/;
const EXPLANATORY_KEY = /reason|comment|advice|explain|suggestion|content|text|summary|note|desc/i;
const BANNED_DESCRIPTION_WORDS = ['好看', '漂亮', '显瘦', '显胖', '建议', '推荐', '因为你', '显得', '完美', '时髦'];

/** 跑一次真实的 System One（4 套），并同时抓下请求与响应。 */
async function runQuickWithCapture() {
  const mock = makeFetchMock();
  const responses = [];
  const capturing = async (url, init) => {
    const response = await mock(url, init);
    responses.push({ url: String(url), body: JSON.parse(init.body), payload: await response.clone().json() });
    return response;
  };
  const api = makeApi({ config: { ...DEFAULT_CONFIG, model: DEFAULT_CONFIG.model }, fetchImpl: capturing });
  const orchestrator = makeOrchestrator({ api, model: DEFAULT_CONFIG.model });
  const quick = await orchestrator.runQuick({
    artifacts: LOOKS.map(ARTIFACT),
    userState: STATE,
    question: QUESTION,
  });
  return { quick, requests: mock.calls, responses };
}

test('System One 输出零解释文本：score answer 只有 id/type/score/confidence', async () => {
  const { responses } = await runQuickWithCapture();
  const scoreResponses = responses.filter((entry) => entry.body.questions.every((item) => item.type === 'score'));
  assert.equal(scoreResponses.length, 4, '应有 4 次 System One 打分调用');
  for (const entry of scoreResponses) {
    assert.ok(entry.payload.answers.length > 0);
    for (const answer of entry.payload.answers) {
      assert.equal(answer.type, 'score');
      assert.deepEqual(
        Object.keys(answer).sort(),
        ['confidence', 'id', 'score', 'type'],
        `score answer 不得带任何解释字段：${JSON.stringify(answer)}`,
      );
      assert.ok(SCORE_QUESTION_IDS.includes(answer.id));
      assert.equal(typeof answer.score, 'number');
      assert.equal(Math.round(answer.score * 10) / 10, answer.score, '分数必须 1 位小数');
      assert.ok(answer.score >= 0 && answer.score <= 5);
      for (const value of Object.values(answer)) {
        if (typeof value === 'string') {
          assert.ok(!EXPLANATORY.test(value), `score answer 的字符串不得是解释文本：${value}`);
        }
      }
    }
  }
});

test('System One 输出零解释文本：请求里没有任何 text 型问题，结果对象没有解释性键', async () => {
  const { quick, requests } = await runQuickWithCapture();
  const scoreRequests = requests.filter(
    (call) => Array.isArray(call.body.questions) && call.body.questions.some((item) => item.id === 'overall_score'),
  );
  assert.equal(scoreRequests.length, 4);
  for (const call of scoreRequests) {
    assert.equal(call.body.questions.length, 6);
    assert.ok(call.body.questions.every((item) => item.type === 'score'), 'System One 只允许 score 型问题');
    assert.ok(!call.body.questions.some((item) => item.type === 'text'), 'System One 不得夹带文字型问题');
  }

  const output = {
    model: quick.model,
    usage: quick.usage,
    ranked: quick.ranked,
    byLook: quick.byLook,
    ids: quick.ids,
    failures: quick.failures,
  };
  for (const row of quick.ranked) {
    assert.deepEqual(Object.keys(row).sort(), ['confidences', 'lookId', 'overall', 'rank', 'relevance', 'scores']);
    for (const key of Object.keys(row)) {
      assert.ok(!EXPLANATORY_KEY.test(key), `ranked 行不得出现解释性字段 ${key}`);
    }
  }
  for (const [lookId, entry] of Object.entries(quick.byLook)) {
    assert.deepEqual(Object.keys(entry).sort(), ['confidences', 'scores']);
    assert.ok(LOOKS.includes(lookId));
    for (const key of Object.keys(entry.scores)) assert.ok(SCORE_QUESTION_IDS.includes(key));
  }
  for (const value of collectStrings(output)) {
    assert.ok(!EXPLANATORY.test(value), `System One 输出里不得出现解释性文本：${value}`);
  }
  assert.ok(!EXPLANATORY.test(JSON.stringify(output)), '整个输出对象通过正则扫描');
});

test('System One 结果对象不带任何图片载荷（隐私不变量 §4.1）', async () => {
  const { quick } = await runQuickWithCapture();
  const serialized = JSON.stringify(quick);
  assert.ok(!serialized.includes('data:image'), '结果不得包含 data URI');
  assert.ok(!serialized.includes('base64'), '结果不得包含 base64 字段或内容');
  assert.ok(!serialized.includes('BASE64_look1'), '结果不得回显图片内容');
  for (const value of collectStrings(quick)) {
    assert.ok(!/^data:/.test(value));
  }
});

test('src/core 与 src/data 是纯逻辑层：不得 import react / react-native / expo', () => {
  const files = [
    ...listFiles(join(ROOT, 'src', 'core')),
    ...listFiles(join(ROOT, 'src', 'data')),
  ];
  assert.ok(files.length >= 7, `应扫描到 core/data 的源文件，实际 ${files.length}`);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.ok(!/from\s+['"](react|react-native|react-native-[\w-]+|expo|expo-[\w-]+)['"]/.test(source), `${file} 不得依赖 UI 运行时`);
    assert.ok(!/require\(['"](react|react-native|expo)/.test(source), `${file} 不得 require UI 运行时`);
    assert.ok(!/\bwindow\b|\bdocument\b/.test(source), `${file} 不得触碰浏览器全局对象`);
  }
});

test('我方范围内无 notImplemented 残留（_todo.js 除外）', () => {
  const files = [
    ...listFiles(join(ROOT, 'src', 'core')),
    ...listFiles(join(ROOT, 'src', 'data')),
    ...listFiles(join(ROOT, 'src', 'engine')),
  ];
  for (const file of files) {
    if (file.endsWith('_todo.js')) continue;
    const source = readFileSync(file, 'utf8');
    assert.ok(!/notImplemented\s*\(/.test(source), `${file} 仍有 notImplemented 调用`);
    assert.ok(!/from\s+['"][^'"]*_todo\.js['"]/.test(source), `${file} 仍 import _todo.js`);
  }
});

test('fixtures/descriptions：4 个文件、7 维齐全、含「未清晰显示」用例、描述无主观评价词', () => {
  const dir = join(ROOT, 'fixtures', 'descriptions');
  const names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(names, ['look1.json', 'look2.json', 'look3.json', 'look4.json']);
  let hasUnclearCase = false;
  for (const lookId of LOOKS) {
    const raw = readFileSync(join(dir, `${lookId}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.lookId, lookId);
    assert.equal(typeof parsed.text, 'string');
    const text = parsed.text;
    for (const dimension of DESCRIPTION_DIMENSIONS) {
      assert.ok(new RegExp(`${dimension}\\s*[:：]`).test(text), `${lookId} 缺少维度 ${dimension}`);
    }
    if (text.includes(UNRECOGNIZABLE_MARK)) hasUnclearCase = true;
    for (const word of BANNED_DESCRIPTION_WORDS) {
      assert.ok(!text.includes(word), `${lookId} 的描述含主观评价词「${word}」`);
    }
  }
  assert.ok(hasUnclearCase, 'SPEC §6 要求 fixtures 里含「未清晰显示」的用例');
});

test('fixtures/deep：两个报告都是可解析的三段式（且与引擎口径一致）', () => {
  for (const name of ['report-2looks', 'report-4looks']) {
    const raw = readFileSync(join(ROOT, 'fixtures', 'deep', `${name}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.ranking) && parsed.ranking.length >= 2);
    assert.ok(Array.isArray(parsed.details) && parsed.details.length === parsed.ranking.length);
    assert.ok(parsed.conclusion && typeof parsed.conclusion.pick === 'string');
    for (const item of parsed.ranking) {
      assert.ok(item.oneLineReason.length > 0);
      assert.equal(Math.round(item.stars * 2) / 2, item.stars, 'stars 必须 0.5 步进');
    }
  }
});

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

test('描述 fixture 与合成 state 的联动（mock 判据锚点）', () => {
  for (const lookId of LOOKS) {
    assert.ok(loadDescription(lookId).length > 20);
  }
});
