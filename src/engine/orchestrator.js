// SPEC §3.11 · 编排：System One（describe → score）与 System Two（多模态一次调用）。
//
// 弱网判定（§5.2）：首个 describe 耗时 > weakThresholdMs（默认 6000ms），或连续 2 次 timeout。
// 命中后：后续每条 onProgress 都带 weakNetwork:true，并额外回调一次 onWeakNet；
// runQuick 的返回值追加 weakNetwork 字段，供 App dispatch {type:'SET_WEAK'}。
//
// 说明：deps 在 SPEC 冻结的 {api, model, concurrency} 之外接受可选注入
// （now / weakThresholdMs / onWeakNet），便于用假时钟确定性测试弱网；不传时行为不变。

import { makeDeepSystem } from './deepSystem.js';
import { makeReviewSystem } from './reviewSystem.js';
import { makeScoreSystem } from './scoreSystem.js';
import { makeVisionEngine } from './vision.js';
import { rankLooks } from '../core/protocol.js';
import { isMeaningfulDescription } from '../core/scoring.js';
import { relevantScoreDimensions } from '../core/prompts.js';
import { invalidInputError } from '../data/copy.js';

const DEFAULT_WEAK_THRESHOLD_MS = 6000;

/** SPEC §3.9c 三档引擎模式。 */
export const ENGINE_MODES = ['laya_only', 'laya_review', 'multimodal_only'];
const DEFAULT_ENGINE_MODE = 'laya_review';

export function makeOrchestrator({
  api,
  model,
  engineMode = DEFAULT_ENGINE_MODE,
  concurrency = 4,
  now = Date.now,
  weakThresholdMs = DEFAULT_WEAK_THRESHOLD_MS,
  onWeakNet,
} = {}) {
  const vision = makeVisionEngine({ api, model });
  const scorer = makeScoreSystem({ api, model });
  const reviewer = makeReviewSystem({ api, model });
  const deepEngine = makeDeepSystem({ api, model });
  const mode = ENGINE_MODES.includes(engineMode) ? engineMode : DEFAULT_ENGINE_MODE;

  let weakNetwork = false;
  let timeoutStreak = 0;
  let firstDescribeMeasured = false;

  function notify(onProgress, payload) {
    if (typeof onProgress !== 'function') return;
    const event = weakNetwork ? { ...payload, weakNetwork: true } : { ...payload };
    try {
      onProgress(event);
    } catch {
      // 进度回调是 UI 侧代码，异常不得影响主流程
    }
  }

  function raiseWeak(reason) {
    if (weakNetwork) return;
    weakNetwork = true;
    if (typeof onWeakNet === 'function') {
      try {
        onWeakNet({ reason });
      } catch {
        // 同上
      }
    }
  }

  function noteOutcome(kind) {
    if (kind === 'timeout') {
      timeoutStreak += 1;
      if (timeoutStreak >= 2) raiseWeak('timeout_streak');
      return;
    }
    timeoutStreak = 0;
  }

  /** SPEC §4.2 路径 A · describe（并行）→ score。 */
  async function runQuick({ artifacts, userState, question, onProgress, signal } = {}) {
    const list = (Array.isArray(artifacts) ? artifacts : []).filter((item) => item && item.lookId);
    const total = list.length;
    if (!total) throw invalidInput();

    const descriptions = {};
    const failures = [];
    let done = 0;

    const tasks = list.map((item) => async () => {
      const startedAt = now();
      try {
        const described = await vision.describeLook({ artifact: item, lookId: item.lookId, signal });
        descriptions[item.lookId] = described.text;
        if (isMeaningfulDescription(described.text)) noteOutcome('ok');
      } catch (err) {
        failures.push(err);
        noteOutcome(err && err.kind);
      } finally {
        const elapsed = now() - startedAt;
        if (!firstDescribeMeasured) {
          firstDescribeMeasured = true;
          if (elapsed > weakThresholdMs) raiseWeak('slow_describe');
        }
        done += 1;
        const payload = { stage: 'describing', done, total, lookId: item.lookId };
        if (descriptions[item.lookId]) payload.text = descriptions[item.lookId];
        notify(onProgress, payload);
      }
    });

    await runWithLimit(tasks, concurrency);

    const recognizable = Object.values(descriptions).filter((text) => isMeaningfulDescription(text));
    if (!recognizable.length) {
      const hard = failures.find((err) => err && err.kind && err.kind !== 'invalid_input');
      if (hard) throw hard;
      throw invalidInput();
    }

    // SPEC §3.9c 分档：
    //   multimodal_only → **完全不经过 Laya 打分**（describe 只为展示客观记录）
    //   laya_only       → 只用 Laya 原分
    //   laya_review     → Laya 打分后再由多模态纠正
    let quick;
    if (mode === 'multimodal_only') {
      notify(onProgress, { stage: 'scoring', done: 0, total });
      quick = await applyJudgment({
        quick: null,
        list,
        descriptions,
        userState,
        question,
        signal,
        onProgress,
      });
      notify(onProgress, { stage: 'scoring', done: total, total });
    } else {
      notify(onProgress, { stage: 'scoring', done: 0, total });
      quick = await scorer.scoreLooks({
        artifacts: list,
        descriptions,
        userState,
        question,
        signal,
        onProgress: ({ done: scored, total: scoringTotal }) => {
          notify(onProgress, { stage: 'scoring', done: scored, total: scoringTotal });
        },
      });

      if (mode === 'laya_review') {
        notify(onProgress, { stage: 'reviewing', done: 0, total: 1 });
        quick = await applyJudgment({
          quick,
          list,
          descriptions,
          userState,
          question,
          signal,
          onProgress,
        });
        notify(onProgress, { stage: 'reviewing', done: 1, total: 1 });
      }
    }

    for (const failure of quick.failures || []) noteOutcome(failure.kind);
    return { ...quick, engineMode: mode, weakNetwork };
  }

  /**
   * SPEC §3.9c · 用多模态模型给出（或纠正）6 维分数。
   *
   * `laya_review`：以 Laya 的原始分为**参考**重新判断，纠正失败则回退原分（不能因一次故障清空用户结果）。
   * `multimodal_only`：完全不用 Laya，直接由多模态模型给分（describe 仍用于展示客观记录）。
   */
  async function applyJudgment({ quick, list, descriptions, userState, question, signal, onProgress }) {
    // multimodal_only 进门时 quick 为 null（还没打过 Laya）
    const base = mode === 'laya_review' ? quick : null;
    try {
      const reviewed = await reviewer.review({
        artifacts: list, descriptions, userState, question, base, signal,
      });
      if (mode === 'multimodal_only') {
        // 全量替换：连"哪几套参与评估"都以多模态结果为准
        const scoresByLook = new Map(Object.entries(reviewed.scores));
        const rows = list
          .filter((item) => scoresByLook.has(item.lookId))
          .map((item) => ({ lookId: item.lookId, scores: scoresByLook.get(item.lookId) }));
        if (!rows.length) throw invalidInput();
        return {
          ...rebuildQuick({ rows, descriptions, question, previous: quick || {} }),
          model: reviewed.model,
          usage: reviewed.usage,
          reviewModel: reviewed.model,
          reviewedAt: reviewed.reviewedAt,
          reviewedLooks: Object.keys(reviewed.scores),
          reviewChanged: Object.keys(reviewed.scores),
        };
      }
      return {
        ...mergeReviewedScores({ quick, reviewed, descriptions, question }),
        reviewModel: reviewed.model,
        reviewedAt: reviewed.reviewedAt,
        reviewedLooks: Object.keys(reviewed.scores),
        reviewChanged: reviewed.changed,
      };
    } catch (err) {
      // 纠正失败不清空已有结果；弱网/错误分类照旧上报，由 UI 决定怎么提示
      noteOutcome(err && err.kind);
      if (typeof onProgress === 'function') {
        onProgress({ stage: 'reviewing', done: 1, total: 1, failed: true, kind: (err && err.kind) || 'server' });
      }
      // 没有可回退的分数时（multimodal_only）必须如实报错
      if (!quick) throw err;
      return { ...quick, reviewFailed: true, reviewErrorKind: (err && err.kind) || 'server' };
    }
  }

  /** 用纠正后的分数重建整份 QuickResult（排序、overall、置信度、relevance 全部重算）。 */
  function mergeReviewedScores({ quick, reviewed, descriptions, question }) {
    const rows = quick.ids.map((lookId) => {
      const next = reviewed.scores[lookId];
      const previous = quick.byLook[lookId] || { scores: {}, confidences: {} };
      return { lookId, scores: next || previous.scores, confidences: previous.confidences };
    });
    return rebuildQuick({ rows, descriptions, question, previous: quick });
  }

  function rebuildQuick({ rows, descriptions, question, previous }) {
    const relevance = relevantScoreDimensions({
      builtinId: question && question.builtinId ? question.builtinId : null,
      text: question && typeof question.text === 'string' ? question.text : '',
    });
    const ranked = rankLooks(rows.map((row) => ({ ...row, relevance: [...relevance] }))).map((row) => ({
      lookId: row.lookId,
      rank: row.rank,
      overall: row.scores.overall_score,
      scores: row.scores,
      confidences: row.confidences || {},
      relevance: row.relevance,
    }));
    const byLook = {};
    for (const row of rows) byLook[row.lookId] = { scores: row.scores, confidences: row.confidences || {} };
    return {
      ...previous,
      ranked,
      byLook,
      ids: rows.map((row) => row.lookId),
      descriptions: { ...(previous.descriptions || {}), ...(descriptions || {}) },
    };
  }

  /** SPEC §3.9 · System Two 一次多模态调用。 */
  async function runDeep({ artifacts, userState, question, onProgress, signal } = {}) {
    const total = (Array.isArray(artifacts) ? artifacts : []).filter((item) => item && item.lookId).length;
    notify(onProgress, { stage: 'deep', done: 0, total });
    try {
      const report = await deepEngine.analyze({ artifacts, userState, question, signal });
      notify(onProgress, { stage: 'deep', done: 1, total });
      return report;
    } catch (err) {
      noteOutcome(err && err.kind);
      notify(onProgress, { stage: 'deep', done: 1, total, failed: true });
      throw err;
    }
  }

  /**
   * 同屏对比用：先跑快速评分，再跑深度分析。
   * quick 失败会抛出；deep 失败不抛，返回 {quick, deep: null, deepError}，避免丢掉已经拿到的分数。
   */
  async function runBoth(args = {}) {
    const quick = await runQuick(args);
    let deep = null;
    let deepError = null;
    try {
      deep = await runDeep(args);
    } catch (err) {
      deepError = err;
    }
    return { quick, deep, deepError, weakNetwork };
  }

  return { runQuick, runDeep, runBoth };
}

function invalidInput() {
  return invalidInputError();
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
