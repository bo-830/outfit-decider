// SPEC §3.11 · 编排：System One（describe → score）与 System Two（多模态一次调用）。
//
// 弱网判定（§5.2）：首个 describe 耗时 > weakThresholdMs（默认 6000ms），或连续 2 次 timeout。
// 命中后：后续每条 onProgress 都带 weakNetwork:true，并额外回调一次 onWeakNet；
// runQuick 的返回值追加 weakNetwork 字段，供 App dispatch {type:'SET_WEAK'}。
//
// 说明：deps 在 SPEC 冻结的 {api, model, concurrency} 之外接受可选注入
// （now / weakThresholdMs / onWeakNet），便于用假时钟确定性测试弱网；不传时行为不变。

import { makeDeepSystem } from './deepSystem.js';
import { makeScoreSystem } from './scoreSystem.js';
import { makeVisionEngine } from './vision.js';
import { isMeaningfulDescription } from '../core/scoring.js';
import { UNRECOGNIZABLE } from '../data/copy.js';

const DEFAULT_WEAK_THRESHOLD_MS = 6000;

export function makeOrchestrator({
  api,
  model,
  concurrency = 4,
  now = Date.now,
  weakThresholdMs = DEFAULT_WEAK_THRESHOLD_MS,
  onWeakNet,
} = {}) {
  const vision = makeVisionEngine({ api, model });
  const scorer = makeScoreSystem({ api, model });
  const deepEngine = makeDeepSystem({ api, model });

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

    notify(onProgress, { stage: 'scoring', done: 0, total });
    const quick = await scorer.scoreLooks({
      artifacts: list,
      descriptions,
      userState,
      question,
      signal,
      onProgress: ({ done: scored, total: scoringTotal }) => {
        notify(onProgress, { stage: 'scoring', done: scored, total: scoringTotal });
      },
    });

    for (const failure of quick.failures || []) noteOutcome(failure.kind);
    return { ...quick, weakNetwork };
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
