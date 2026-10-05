// tests/helpers/fetchMock.js · 内存 fetch 替身（SPEC §6.1）。
// 行为对齐 tools/mock-jev-server.mjs：describe 返回 fixtures/descriptions，score 返回确定性分数，
// deep 返回 fixtures/deep 的三段式 JSON 字符串；故障注入按请求体 model 字段触发。
//
// 用法：
//   const mock = makeFetchMock({ delayMs: 0, failures: { look3: { status: 500 } } });
//   const api = makeApi({ config, fetchImpl: mock });
//   mock.calls / mock.stats.maxConcurrent

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8' };

export const LOOK_IDS = ['look1', 'look2', 'look3', 'look4'];
export const NUMERALS = ['一', '二', '三', '四'];
export const UNRECOGNIZABLE_TEXT = [
  '整体风格：未清晰显示',
  '上衣：未清晰显示',
  '下装：未清晰显示',
  '鞋履：未清晰显示',
  '配饰：未清晰显示',
  '身材视觉效果：未清晰显示',
  '其他细节：未清晰显示',
].join('\n');

const SCORE_QUESTION_IDS = [
  'overall_score',
  'aesthetic_score',
  'scene_score',
  'figure_score',
  'style_score',
  'practical_score',
];

/** FNV-1a 32 位哈希（与 SPEC §6 的 mock 同算法）。 */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  const source = String(text);
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 确定性分数：同一 (lookId, questionId, state) 必得同一结果，落在 [2.0, 5.0] 且 1 位小数。 */
export function deterministicScore(lookId, questionId, state) {
  const seed = fnv1a(`${lookId}|${questionId}|${state}`);
  return Math.round((2 + (seed % 31) / 10) * 10) / 10;
}

export function deterministicConfidence(lookId, questionId, state) {
  const seed = fnv1a(`conf|${lookId}|${questionId}|${state}`);
  return Math.round((0.8 + (seed % 15) / 100) * 100) / 100;
}

/** 从合成 state 文本里认出这套是 lookN（【穿搭一】→ look1）。 */
export function lookIdFromState(state) {
  const text = typeof state === 'string' ? state : '';
  for (let i = 0; i < NUMERALS.length; i += 1) {
    if (text.includes(`【穿搭${NUMERALS[i]}】`)) return LOOK_IDS[i];
  }
  for (const lookId of LOOK_IDS) if (text.includes(lookId)) return lookId;
  return 'look1';
}

export function loadDescription(lookId) {
  const raw = readFileSync(join(ROOT, 'fixtures', 'descriptions', `${lookId}.json`), 'utf8');
  const parsed = JSON.parse(raw);
  return typeof parsed === 'string' ? parsed : (parsed.text || '');
}

export function loadDeepFixture(name) {
  return JSON.parse(readFileSync(join(ROOT, 'fixtures', 'deep', `${name}.json`), 'utf8'));
}

/** 按实际上传的 lookIds 裁出合法报告（条数 = 套数）。 */
export function deepReportForLookIds(ids) {
  const lookIds = Array.isArray(ids) && ids.length ? ids : ['look1'];
  const two = loadDeepFixture('report-2looks');
  const four = loadDeepFixture('report-4looks');
  const covers = (source) => lookIds.every((id) => source.ranking.some((item) => item.lookId === id));
  const source = covers(two) ? two : (covers(four) ? four : two);
  const ranking = source.ranking.filter((item) => lookIds.includes(item.lookId));
  const details = source.details.filter((item) => lookIds.includes(item.lookId));
  const conclusion = { ...source.conclusion };
  if (!lookIds.includes(conclusion.pick)) conclusion.pick = ranking[0].lookId;
  return { ranking, details, conclusion };
}

/**
 * @param {{
 *   delayMs?: number, timeoutHangMs?: number, healthStatus?: number,
 *   failures?: Record<string, {status?: number, describeEmpty?: boolean, deepEmpty?: boolean}>,
 *   noBatch?: boolean   // true = 不提供 /ask/batch（404），用来验证"回退逐条"这条路径
 * }} options
 */
export function makeFetchMock(options = {}) {
  const calls = [];
  const stats = { total: 0, inFlight: 0, maxConcurrent: 0 };
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 0;
  const healthStatus = Number.isFinite(options.healthStatus) ? options.healthStatus : 200;
  const timeoutHangMs = Number.isFinite(options.timeoutHangMs) ? options.timeoutHangMs : 30000;
  const failures = { ...(options.failures || {}) };
  const noBatch = options.noBatch === true;
  let scenario = options.scenario || 'normal';

  async function fetchImpl(url, init = {}) {
    const method = String(init.method || 'GET').toUpperCase();
    let body = null;
    if (typeof init.body === 'string' && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    calls.push({ url: String(url), method, headers: init.headers || {}, body });
    stats.total += 1;
    stats.inFlight += 1;
    stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.inFlight);
    try {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/health')) {
        await wait(delayMs, init.signal);
        if (healthStatus >= 400) return jsonResponse({ error: 'down' }, healthStatus);
        return jsonResponse({ ok: true, model: 'mock-model', uptime: 1 });
      }
      if (!pathname.endsWith('/ask') && !pathname.endsWith('/ask/batch')) {
        await wait(delayMs, init.signal);
        return new Response('not found', { status: 404, headers: TEXT_HEADERS });
      }
      if (pathname.endsWith('/ask/batch')) {
        if (noBatch) {
          await wait(delayMs, init.signal);
          return new Response('not found', { status: 404, headers: TEXT_HEADERS });
        }
        return await handleBatch(body, init.signal);
      }
      return await handleAsk(body, init.signal);
    } finally {
      stats.inFlight -= 1;
    }
  }

  async function handleAsk(body, signal) {
    const model = body && body.model;
    if (model === 'test-auth-fail') {
      await wait(delayMs, signal);
      return jsonResponse({ error: { message: 'invalid api key' } }, 401);
    }
    if (model === 'test-server-error') {
      await wait(delayMs, signal);
      return jsonResponse({ error: { message: 'boom' } }, 500);
    }
    if (model === 'test-parse-fail') {
      await wait(delayMs, signal);
      return new Response('not-json', { status: 200, headers: TEXT_HEADERS });
    }
    if (model === 'test-timeout') {
      await wait(timeoutHangMs, signal);
      return jsonResponse(payloadFor(body, model));
    }
    await wait(delayMs, signal);

    const questions = Array.isArray(body && body.questions) ? body.questions : [];
    const images = Array.isArray(body && body.images) ? body.images : [];
    const lookId = lookIdFor(body, questions, images);
    const failure = failures[lookId];
    if (failure && Number.isFinite(failure.status)) {
      return jsonResponse({ error: { message: 'injected failure' } }, failure.status);
    }
    return jsonResponse(payloadFor(body, model, failure));
  }

  /**
   * 批处理对端（SPEC §3.11 v1.6）：一次请求给多套打分。
   * 每套复用与之相同的 payloadFor，因此批处理与逐条的分数**完全一致** ——
   * 这正是"批处理不改变结论"这条性质可被测试断言的前提。
   */
  async function handleBatch(body, signal) {
    const model = body && body.model;
    if (model === 'test-batch-fail') {
      await wait(delayMs, signal);
      return jsonResponse({ error: { message: 'batch unsupported' } }, 500);
    }
    if (model === 'test-auth-fail' || model === 'test-server-error') {
      await wait(delayMs, signal);
      return jsonResponse({ error: { message: 'injected' } }, model === 'test-auth-fail' ? 401 : 500);
    }
    await wait(delayMs, signal);
    const looks = Array.isArray(body && body.looks) ? body.looks : [];
    const out = looks.map((look) => {
      const state = typeof (look && look.state) === 'string' ? look.state : '';
      const questions = look && Array.isArray(look.questions) ? look.questions : [];
      const lookId = look && look.lookId ? String(look.lookId) : 'look1';
      const failure = failures[lookId] || {};
      const payload = payloadFor({ state, questions, model }, model, failure);
      return {
        lookId,
        model: payload.model,
        answers: payload.answers,
        usage: { prompt_tokens: body ? state.length : 0, completion_tokens: payload.answers.length * 4, total_tokens: 0 },
      };
    });
    return jsonResponse({
      model: model || 'mock-model',
      looks: out,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  function payloadFor(body, model, failure = {}) {
    const questions = Array.isArray(body && body.questions) ? body.questions : [];
    const state = body && typeof body.state === 'string' ? body.state : '';
    const images = Array.isArray(body && body.images) ? body.images : [];
    const requestModel = body && body.model ? body.model : 'mock-model';

    if (questions.some((item) => item && item.id === 'deep_report')) {
      const ids = images.map((image) => image && image.id).filter((id) => LOOK_IDS.includes(id));
      const content = failure.deepEmpty ? '' : JSON.stringify(deepReportForLookIds(ids));
      return {
        model: requestModel,
        answers: [{ id: 'deep_report', type: 'text', content, confidence: 0.9 }],
        usage: { prompt_tokens: 1200, completion_tokens: 600, total_tokens: 1800 },
      };
    }

    const answers = questions.map((question) => {
      const id = question && question.id;
      if (question && question.type === 'text') {
        const describedLook = String(id).startsWith('describe_') ? String(id).slice('describe_'.length) : 'look1';
        let content = loadDescription(describedLook);
        if (model === 'test-unrecognizable') content = UNRECOGNIZABLE_TEXT;
        if (model === 'test-partial-fail' && describedLook === 'look1') content = '';
        if (failure.describeEmpty) content = '';
        return { id, type: 'text', content, confidence: 0.9 };
      }
      if (!SCORE_QUESTION_IDS.includes(id)) {
        return { id, type: 'score', score: 3.0, confidence: 0.5 };
      }
      const lookId = lookIdFromState(state);
      return {
        id,
        type: 'score',
        score: deterministicScore(lookId, id, state),
        confidence: deterministicConfidence(lookId, id, state),
      };
    });

    return {
      model: requestModel,
      answers,
      usage: { prompt_tokens: 300, completion_tokens: 60, total_tokens: 360 },
    };
  }

  fetchImpl.calls = calls;
  fetchImpl.stats = stats;
  fetchImpl.setScenario = (next) => {
    scenario = next;
  };
  fetchImpl.getScenario = () => scenario;
  fetchImpl.setFailure = (lookId, failure) => {
    failures[lookId] = failure;
  };
  fetchImpl.reset = () => {
    calls.length = 0;
    stats.total = 0;
    stats.maxConcurrent = 0;
  };
  return fetchImpl;
}

function lookIdFor(body, questions, images) {
  const describe = questions.find((item) => item && typeof item.id === 'string' && item.id.startsWith('describe_'));
  if (describe) {
    const candidate = describe.id.slice('describe_'.length);
    if (LOOK_IDS.includes(candidate)) return candidate;
  }
  const image = images.find((item) => item && LOOK_IDS.includes(item.id));
  if (image) return image.id;
  return lookIdFromState(body && body.state);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function abortError() {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

function wait(ms, signal) {
  if (!ms) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    return Promise.resolve();
  }
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(resolveWait, ms);
    if (signal && typeof signal.addEventListener === 'function') {
      const onAbort = () => {
        clearTimeout(timer);
        rejectWait(abortError());
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
