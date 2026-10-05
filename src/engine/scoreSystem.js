// SPEC §3.8 · System One 打分引擎：并行调用决策模型，返回 6 维分数与降序排名。
// 硬约束：输出只有分数（数字与维度 id），不得生成任何解释性 / 评价性 / 建议性字段。

import {
  SCORE_QUESTION_IDS,
  buildScoreAnswers,
  rankLooks,
} from '../core/protocol.js';
import { buildScoreQuestions, buildSyntheticStateText, normalizeDescriptions, relevantScoreDimensions } from '../core/prompts.js';
import { isMeaningfulDescription } from '../core/scoring.js';
import { ERROR_KINDS, UNRECOGNIZABLE, errorInfo } from '../data/copy.js';

const LOOK_CONCURRENCY = 4;

export function makeScoreSystem({ api, model } = {}) {
  /**
   * SPEC §3.8 · 每套一次 ask（并发上限 4）。单套失败 → 该套 overall=null，不阻塞其他套。
   */
  async function scoreLooks({ artifacts, descriptions, userState, question, signal, onProgress } = {}) {
    const list = (Array.isArray(artifacts) ? artifacts : []).filter((item) => item && item.lookId);
    const ids = [];
    for (const item of list) if (!ids.includes(item.lookId)) ids.push(item.lookId);

    const descriptionMap = {};
    for (const entry of normalizeDescriptions(descriptions)) descriptionMap[entry.lookId] = entry.text;

    const relevance = relevantScoreDimensions({
      builtinId: question && question.builtinId ? question.builtinId : null,
      text: question && typeof question.text === 'string' ? question.text : '',
    });
    const questions = buildScoreQuestions({ userState, question });
    const results = new Map();
    let done = 0;

    const tasks = ids.map((lookId) => async () => {
      const description = descriptionMap[lookId] || '';
      try {
        if (!isMeaningfulDescription(description)) {
          results.set(lookId, { ok: false, kind: 'invalid_input' });
          return;
        }
        if (signal && signal.aborted) {
          results.set(lookId, { ok: false, kind: 'cancelled' });
          return;
        }
        const state = buildSyntheticStateText({
          descriptions: { [lookId]: description },
          userState,
          question,
        });
        const response = await api.ask({ state, questions, signal, model });
        const byId = buildScoreAnswers(response && response.answers);
        const scores = {};
        const confidences = {};
        for (const id of SCORE_QUESTION_IDS) {
          scores[id] = byId[id] ? byId[id].score : null;
          confidences[id] = byId[id] ? byId[id].confidence : null;
        }
        if (SCORE_QUESTION_IDS.every((id) => scores[id] === null)) {
          results.set(lookId, { ok: false, kind: 'parse' });
          return;
        }
        results.set(lookId, {
          ok: true,
          scores,
          confidences,
          usage: response && response.usage ? response.usage : null,
          model: response && response.model ? response.model : null,
        });
      } catch (err) {
        results.set(lookId, { ok: false, kind: (err && err.kind) || 'server' });
      } finally {
        done += 1;
        if (typeof onProgress === 'function') onProgress({ done, total: ids.length });
      }
    });

    await runWithLimit(tasks, LOOK_CONCURRENCY);

    const rows = ids.map((lookId) => {
      const result = results.get(lookId) || { ok: false, kind: 'server' };
      const scores = {};
      const confidences = {};
      for (const id of SCORE_QUESTION_IDS) {
        scores[id] = result.ok ? result.scores[id] : null;
        confidences[id] = result.ok ? result.confidences[id] : null;
      }
      return { lookId, scores, confidences, relevance: [...relevance] };
    });

    const ranked = rankLooks(rows).map((row) => ({
      lookId: row.lookId,
      rank: row.rank,
      overall: row.scores.overall_score,
      scores: row.scores,
      confidences: row.confidences,
      relevance: row.relevance,
    }));

    const byLook = {};
    for (const row of rows) byLook[row.lookId] = { scores: row.scores, confidences: row.confidences };

    const failures = ids.map((lookId) => results.get(lookId)).filter((r) => r && !r.ok);
    if (ids.length > 0 && failures.length === ids.length) {
      const hard = failures.find((item) => item.kind && item.kind !== 'invalid_input');
      if (hard) throw failureOf(hard.kind);
      throw invalidInput();
    }

    return {
      model: firstModel(results) || (typeof model === 'string' ? model : null),
      usage: sumUsage(results),
      ranked,
      byLook,
      ids,
      descriptions: { ...descriptionMap },
      failures: ids
        .map((lookId) => ({ lookId, result: results.get(lookId) }))
        .filter((item) => !item.result || !item.result.ok)
        .map((item) => ({ lookId: item.lookId, kind: (item.result && item.result.kind) || 'server' })),
    };
  }

  return { scoreLooks };
}

function compareIds(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function firstModel(results) {
  for (const result of results.values()) if (result && result.ok && result.model) return result.model;
  return null;
}

function sumUsage(results) {
  const total = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const result of results.values()) {
    if (!result || !result.ok || !result.usage) continue;
    total.prompt_tokens += numberOrZero(result.usage.prompt_tokens);
    total.completion_tokens += numberOrZero(result.usage.completion_tokens);
    total.total_tokens += numberOrZero(result.usage.total_tokens);
  }
  return total;
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function failureOf(kind) {
  if (kind === 'invalid_input') return invalidInput();
  const resolved = ERROR_KINDS.includes(kind) ? kind : 'server';
  const info = errorInfo(resolved);
  const err = new Error(info.message);
  err.kind = resolved;
  err.action = info.action;
  err.retryable = info.retryable === true;
  return err;
}

function invalidInput() {
  const err = new Error(UNRECOGNIZABLE);
  err.kind = 'invalid_input';
  err.action = '换图';
  err.retryable = false;
  return err;
}

async function runWithLimit(tasks, limit) {
  const queue = tasks.slice();
  const size = Math.max(1, Math.min(limit, queue.length || 1));
  const workers = [];
  for (let i = 0; i < size; i += 1) {
    workers.push((async () => {
      while (queue.length) {
        const task = queue.shift();
        await task();
      }
    })());
  }
  await Promise.all(workers);
}
