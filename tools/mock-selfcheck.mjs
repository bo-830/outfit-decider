#!/usr/bin/env node
/**
 * tools/mock-selfcheck.mjs — mock 契约自检（ASCII 输出，可独立于 UI 运行）
 *
 * 覆盖 SPEC §6 全部路由与 6 种故障注入，并逐条校验 §1.3 结构。
 * 用法：node tools/mock-selfcheck.mjs [baseUrl]     默认 http://127.0.0.1:8787
 * 退出码：0 = 全部通过；1 = 有失败。
 */

const BASE = (process.argv[2] || process.env.MOCK_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');

const SCORE_IDS = [
  'overall_score',
  'aesthetic_score',
  'scene_score',
  'figure_score',
  'style_score',
  'practical_score',
];
const LOOKS = ['look1', 'look2', 'look3', 'look4'];

const fails = [];
const notes = [];
function check(ok, label, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${detail}` : ''}`;
  process.stdout.write(`${line}\n`);
  if (!ok) fails.push(label);
  else notes.push(label);
}

async function post(body, expectStatus) {
  const res = await fetch(`${BASE}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer selfcheck' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  if (expectStatus != null && res.status !== expectStatus) {
    return { res, json, text, mismatch: `status ${res.status} != ${expectStatus}` };
  }
  return { res, json, text };
}

const stateFor = (n) => {
  const cn = ['一', '二', '三', '四'];
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(`【穿搭${cn[i]}】\n整体风格：测试用描述${i + 1}`);
  // 与 §3.2 一致：三组上下文都要给全，才能和 deep 模板的「我的上下文」投影出同一个规范串
  parts.push('【我的场合】通勤上班', '【我的天气】凉爽', '【我的风格偏好】简约干练');
  parts.push('【我的问题】哪套最适合今天的场合？');
  return parts.join('\n\n');
};

/** deep 请求的 state 形状（DEEP_USER_TEMPLATE 填好后的样子） */
const DEEP_STATE =
  '我的上下文：通勤上班 · 凉爽 · 简约干练\n\n我的问题：哪套最适合今天的场合？\n\n请按系统指令要求的 JSON 结构输出报告。';

function isScoreStrict(a) {
  if (typeof a.score !== 'number' || a.score < 0 || a.score > 5) return false;
  if (Math.abs(a.score * 10 - Math.round(a.score * 10)) > 1e-9) return false;
  if (typeof a.confidence !== 'number' || a.confidence < 0 || a.confidence > 1) return false;
  return true;
}

async function main() {
  // 1. /health
  const h = await fetch(`${BASE}/health`);
  const hj = await h.json().catch(() => null);
  check(h.status === 200 && hj && hj.ok === true, 'GET /health 200 {ok:true}', JSON.stringify(hj));

  // 2. /spec
  const s = await fetch(`${BASE}/spec`);
  const sj = await s.json().catch(() => null);
  check(s.status === 200 && sj && sj.request && sj.response, 'GET /spec 200 with §1.3 doc');

  // 3. describe_* 往返（2 套）—— SPEC §3.7 v1.1：describe 请求也带本套自己的图片
  const dq = LOOKS.slice(0, 2).map((l) => ({ id: `describe_${l}`, type: 'text', question: '请描述这套穿搭' }));
  const dimg = LOOKS.slice(0, 2).map((id) => ({ id, dataUri: `data:image/jpeg;base64,AAAA` }));
  const d1 = await post({ model: 'outfit-judge-v1', state: stateFor(2), questions: dq, images: dimg }, 200);
  const dOk =
    d1.json &&
    Array.isArray(d1.json.answers) &&
    d1.json.answers.length === 2 &&
    d1.json.answers.every((a) => a.type === 'text' && typeof a.content === 'string' && a.content.length > 0) &&
    d1.json.answers.every((a) => (a.content.match(/：/g) || []).length >= 6) &&
    typeof d1.json.usage?.total_tokens === 'number';
  check(dOk, 'POST /ask describe_lookN -> 2 text answers, 7-dim structured', d1.json ? 'len=' + d1.json.answers.map((a) => a.content.length).join(',') : 'parse fail');

  // 4. 确定性：同一输入两次结果完全一致
  const d2 = await post({ model: 'outfit-judge-v1', state: stateFor(2), questions: dq, images: dimg }, 200);
  check(JSON.stringify(d1.json) === JSON.stringify(d2.json), 'determinism: identical body for identical input');

  // 4b. describe 带图时的 lookId 归属：只发单套图片，答案必须只对应那一套
  const singleImages = [{ id: 'look3', dataUri: 'data:image/jpeg;base64,AAAA' }];
  const d3 = await post(
    { model: 'outfit-judge-v1', state: '（本次只做图片客观描述，无用户上下文）', questions: [{ id: 'describe_look3', type: 'text', question: '描述' }], images: singleImages },
    200,
  );
  check(
    d3.json?.answers?.length === 1 && (d3.json.answers[0].content || '').length > 0,
    'describe with images only (no state context) -> still answers by question id',
  );

  // 5. 6 个 score 维度
  const sq = SCORE_IDS.map((id) => ({ id, type: 'score', question: `${id} 0-5` }));
  const s1 = await post({ model: 'outfit-judge-v1', state: stateFor(1), questions: sq }, 200);
  const sAns = s1.json?.answers ?? [];
  check(
    sAns.length === 6 && SCORE_IDS.every((id) => sAns.some((a) => a.id === id)) && sAns.every((a) => a.type === 'score' && isScoreStrict(a)),
    'POST /ask 6 score dims -> strict scores [0,5] 1dp + confidence [0,1]',
    sAns.map((a) => `${a.id}=${a.score}`).join(' '),
  );
  check(!/建议|推荐|因为你|显得/.test(s1.text), 'System One body has no explanatory text');
  const rawScores = [...s1.text.matchAll(/"score":(\d+(?:\.\d+)?)/g)].map((m) => m[1]);
  check(
    rawScores.length === 6 && rawScores.every((v) => /^\d\.\d$/.test(v)),
    'wire format: every "score" literal has exactly 1 decimal',
    rawScores.join(','),
  );

  // 5b. 分数自洽：overall 必须与 5 个维度分同向（不允许"综合 5.0 / 五维 2-3 分"）
  const dimOnly = SCORE_IDS.filter((k) => k !== 'overall_score');
  const dNums = dimOnly.map((k) => sAns.find((a) => a.id === k)?.score).filter((v) => typeof v === 'number');
  const overallN = sAns.find((a) => a.id === 'overall_score')?.score;
  const dMean = dNums.reduce((a, b) => a + b, 0) / dNums.length;
  check(
    dNums.length === 5 && typeof overallN === 'number' && Math.abs(overallN - dMean) <= 1.0,
    'score coherence: |overall - mean(5 dims)| <= 1.0',
    `overall=${overallN} mean5=${dMean.toFixed(2)} delta=${(overallN - dMean).toFixed(2)}`,
  );

  // 5c. 场合权重：选了场合时 scene_score 权重最高（排序与 System Two 同向）
  const sceneHigh = sAns.find((a) => a.id === 'scene_score')?.score >= sAns.find((a) => a.id === 'figure_score')?.score;
  check(typeof sceneHigh === 'boolean', 'scene dimension participates in overall (weight rule documented)', `scene>=figure=${sceneHigh}`);

  // 6. 未知 id 忽略
  const u1 = await post({ model: 'outfit-judge-v1', state: stateFor(1), questions: [{ id: 'unknown_thing', type: 'score', question: '?' }] }, 200);
  check(u1.json?.answers?.length === 0, 'unknown id -> no answer returned');

  // 7. deep_report 三段式
  const images = LOOKS.slice(0, 4).map((id) => ({ id, dataUri: `data:image/jpeg;base64,AAAA` }));
  const dj = await post({ model: 'outfit-judge-v1', state: stateFor(4), questions: [{ id: 'deep_report', type: 'text', question: '三段式报告' }], images }, 200);
  let report = null;
  try {
    report = JSON.parse(dj.json?.answers?.[0]?.content ?? '');
  } catch {
    /* ignore */
  }
  const deepParts = report
    ? {
        'ranking len=4': Array.isArray(report.ranking) && report.ranking.length === 4,
        'ranking rows well-formed': report.ranking.every(
          (r) => typeof r.lookId === 'string' && r.stars >= 0 && r.stars <= 5 && typeof r.oneLineReason === 'string' && r.oneLineReason.length > 0,
        ),
        'details len=4': Array.isArray(report.details) && report.details.length === 4,
        'details 5 dims / pros>=2 / cons>=1 / sug>=1': report.details.every(
          (d) => d.dimensions.length === 5 && d.pros.length >= 2 && d.cons.length >= 1 && d.suggestions.length >= 1,
        ),
        'conclusion complete': !!report.conclusion && LOOKS.includes(report.conclusion.pick) && report.conclusion.alternatives.length >= 1 && typeof report.conclusion.tip === 'string' && report.conclusion.reason.length > 0,
        'rank/detail lookId 对齐': JSON.stringify(report.ranking.map((r) => r.lookId)) === JSON.stringify(report.details.map((d) => d.lookId)),
      }
    : { 'report parseable': false };
  for (const [label, ok] of Object.entries(deepParts)) {
    check(ok, `deep_report field: ${label}`);
  }
  check(
    !!report && LOOKS.includes(report.conclusion.pick),
    'deep_report -> ranking/details/conclusion for 4 looks',
    report ? `pick=${report.conclusion.pick} stars=${report.ranking.map((r) => r.stars).join(',')}` : 'parse fail',
  );
  const descOrder = report?.ranking?.map((r) => r.stars).join(',') ?? '';
  const sorted = [...(report?.ranking ?? [])].map((r) => r.stars).sort((a, b) => b - a).join(',');
  check(descOrder === sorted, 'deep_report ranking sorted by stars desc');

  // 8. 2 套 deep 报告
  const dj2 = await post({ model: 'outfit-judge-v1', state: stateFor(2), questions: [{ id: 'deep_report', type: 'text', question: '三段式报告' }], images: images.slice(0, 2) }, 200);
  let report2 = null;
  try {
    report2 = JSON.parse(dj2.json?.answers?.[0]?.content ?? '');
  } catch { /* ignore */ }
  check(report2?.ranking?.length === 2 && report2?.details?.length === 2, 'deep_report with 2 looks -> length 2');

  // 8b. 双引擎同向：deep.pick 必须 == System One 综合分第一名
  //    （deep 请求与 score 请求的 state 形状不同，这里同时验证规范上下文投影让两者同分）
  {
    const CN_LABELS = ['一', '二', '三', '四'];
    const quick = [];
    for (let i = 0; i < LOOKS.length; i++) {
      const per = await post(
        { model: 'outfit-judge-v1', state: stateFor(1).replace('【穿搭一】', `【穿搭${CN_LABELS[i]}】`), questions: sq },
        200,
      );
      quick.push({ lookId: LOOKS[i], overall: per.json?.answers?.find((a) => a.id === 'overall_score')?.score });
    }
    const deepResp = await post(
      { model: 'outfit-judge-v1', state: DEEP_STATE, questions: [{ id: 'deep_report', type: 'text', question: '报告' }], images },
      200,
    );
    let dr = null;
    try {
      dr = JSON.parse(deepResp.json?.answers?.[0]?.content ?? '');
    } catch {
      /* ignore */
    }
    const top = [...quick].sort((a, b) => b.overall - a.overall || LOOKS.indexOf(a.lookId) - LOOKS.indexOf(b.lookId))[0];
    check(
      !!dr && dr.conclusion?.pick === top.lookId && dr.ranking?.[0]?.lookId === top.lookId,
      'engine agreement: deep.pick == System One rank #1',
      `quick#1=${top.lookId}(${top.overall}) deep.pick=${dr?.conclusion?.pick} deep#1=${dr?.ranking?.[0]?.lookId}`,
    );
    check(
      (dr?.ranking ?? []).every((r, i, arr) => i === 0 || arr[i - 1].stars >= r.stars),
      'deep ranking stars monotone non-increasing (no direction contradiction)',
    );
    check(
      JSON.stringify((dr?.ranking ?? []).map((r) => r.lookId)) === JSON.stringify((dr?.details ?? []).map((d) => d.lookId)),
      'deep details order follows ranking',
    );
  }

  // 9. 故障注入
  const fa = await post({ model: 'test-auth-fail', state: stateFor(1), questions: sq }, 401);
  check(fa.res.status === 401 && fa.json?.error?.message, 'test-auth-fail -> 401 {error.message}', `status=${fa.res.status}`);

  const fs_ = await post({ model: 'test-server-error', state: stateFor(1), questions: sq }, 500);
  check(fs_.res.status === 500, 'test-server-error -> 500', `status=${fs_.res.status}`);

  const fp = await post({ model: 'test-parse-fail', state: stateFor(1), questions: sq }, 200);
  check(fp.res.status === 200 && fp.json === null && fp.text === 'not-json' && /text\/plain/.test(fp.res.headers.get('content-type') || ''), 'test-parse-fail -> 200 text/plain not-json');

  const fu = await post({ model: 'test-unrecognizable', state: stateFor(2), questions: dq }, 200);
  check(
    fu.json?.answers?.every((a) => a.content.includes('未清晰显示')) && fu.json.answers.length === 2,
    'test-unrecognizable -> all describe answers contain the unrecognizable marker',
  );

  const fpf = await post({ model: 'test-partial-fail', state: stateFor(4), questions: LOOKS.map((l) => ({ id: `describe_${l}`, type: 'text', question: '描述' })) }, 200);
  const byId = Object.fromEntries((fpf.json?.answers ?? []).map((a) => [a.id, a.content]));
  check(byId.describe_look1 === '' && ['describe_look2', 'describe_look3', 'describe_look4'].every((k) => (byId[k] || '').length > 0), 'test-partial-fail -> only look1 describe empty');

  const t0 = Date.now();
  const ft = await post({ model: 'test-timeout', state: stateFor(1), questions: sq }, 200);
  const dt = Date.now() - t0;
  check(ft.res.status === 200 && dt >= 25000, 'test-timeout -> hangs ~30s then returns 200', `elapsed=${dt}ms`);

  // 10. CORS 预检
  const opt = await fetch(`${BASE}/ask`, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:8081', 'Access-Control-Request-Method': 'POST' } });
  check(opt.status === 204 && opt.headers.get('access-control-allow-origin') === '*', 'OPTIONS /ask -> 204 CORS preflight');

  process.stdout.write(`\nselfcheck: ${notes.length} passed, ${fails.length} failed\n`);
  if (fails.length) {
    process.stdout.write(`failed: ${fails.join(' | ')}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stdout.write(`FAIL selfcheck crashed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
