#!/usr/bin/env node
/**
 * 端到端区分度评估：用**适配器**（也就是 App 真正会走的那条路）测同一个请求形状下，
 * 「明显得体」与「明显荒谬」两套穿搭拿到的分数差。
 *
 * 这个脚本的意义：前面的 laya-eval.mjs / laya-choice-eval.mjs 是直接打 Laya 原生协议，
 * 而这里是打 `tools/laya-adapter.mjs`，用的是 App 真实发出的 SPEC §1.3 数组形状 ——
 * 所以它测的是**产品实际链路**上的判断力，而不是某个孤立接口的能力。
 *
 * 用法：
 *   1) 先起 laya-serve:      C:\博830\vibecoding\laya-service\start-laya.cmd
 *   2) 再起适配器:            cmd /c "npm run laya"
 *   3) node tools/laya-chain-eval.mjs [--adapter http://127.0.0.1:8787]
 */
const argv = process.argv.slice(2);
const i = argv.indexOf('--adapter');
const ADAPTER = (i >= 0 && argv[i + 1] ? argv[i + 1] : 'http://127.0.0.1:8787').replace(/\/+$/, '');

const SCORE_IDS = ['overall_score', 'aesthetic_score', 'scene_score', 'figure_score', 'style_score', 'practical_score'];
const LABEL = {
  overall_score: '哪套最适合今天的场合？',
  aesthetic_score: '哪套更上镜好看？',
  scene_score: '这套会不会太随意？',
  figure_score: '哪套更显瘦利落？',
  style_score: '哪套更符合我想要的风格？',
  practical_score: '哪套更实用省心？',
};

const LOOKS = {
  得体: '浅蓝色棉质衬衫（合身，袖口平整）；深灰色直筒九分西裤（裤线清晰）；白色低帮皮质板鞋；细棕色皮带与银色腕表；腰线清晰，比例匀称',
  荒谬: '亮橙色宽松卡通卫衣（下摆外放）；花朵运动短裤（及膝）；磨损旧拖鞋；荧光绿游泳帽与大串塑料珠链；腰部被卫衣完全遮挡',
  普通: '白色纯棉短袖T恤（合身）；深蓝色直筒牛仔裤（长度合适）；白色运动鞋，略旧；上下身比例正常',
};

async function score(lookText) {
  const state = `【穿搭一】${lookText}\n\n【我的场合】正式面试\n【我的天气】凉爽\n【我的风格偏好】简约干练\n\n【我的问题】哪套最适合今天的场合？`;
  const body = {
    model: 'laya',
    state,
    questions: SCORE_IDS.map((id) => ({ id, type: 'score', question: LABEL[id] })),
  };
  const started = Date.now();
  const response = await fetch(`${ADAPTER}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${JSON.stringify(json).slice(0, 160)}`);
  const out = {};
  for (const answer of json.answers) out[answer.id] = { score: answer.score, confidence: answer.confidence };
  return { scores: out, ms: Date.now() - started, model: json.model };
}

const f = (n) => Number(n).toFixed(2);

async function main() {
  const results = {};
  for (const [name, text] of Object.entries(LOOKS)) {
    const first = await score(text);
    const second = await score(text);
    results[name] = { first, second };
    const deterministic = JSON.stringify(first.scores) === JSON.stringify(second.scores);
    console.log(`${name}  ms=${String(first.ms).padStart(5)} model=${first.model} deterministic=${deterministic}`);
    console.log(`     ${Object.entries(first.scores).map(([k, v]) => `${k.replace('_score', '')}=${f(v.score)}/${f(v.confidence)}`).join(' ')}`);
  }

  console.log('');
  console.log('--- 区分度（得体 − 荒谬，正数才有意义）---');
  const deltas = [];
  for (const id of SCORE_IDS) {
    const good = results.得体.first.scores[id].score;
    const bad = results.荒谬.first.scores[id].score;
    const delta = good - bad;
    deltas.push({ id, delta });
    const verdict = delta >= 1.0 ? 'PASS' : delta > 0 ? '偏弱' : 'FAIL(方向错)';
    console.log(`${id.padEnd(17)} 得体=${f(good)} 荒谬=${f(bad)} delta=${f(delta)}  ${verdict}`);
  }
  const overallDelta = deltas.find((d) => d.id === 'overall_score').delta;
  console.log('');
  console.log(`综合判定: overall delta=${f(overallDelta)} → ${overallDelta >= 1.0 ? '有可用区分度' : '区分度不足，不适合作为权威排序依据'}`);

  const avg = (name) => {
    const values = Object.values(results[name].first.scores).map((v) => v.confidence);
    return values.reduce((a, b) => a + b, 0) / values.length;
  };
  console.log(`平均 answer_confidence: 得体=${f(avg('得体'))} 荒谬=${f(avg('荒谬'))} 普通=${f(avg('普通'))}`);
}

main().catch((err) => {
  console.log(`ERROR ${err.message}`);
  process.exitCode = 1;
});
