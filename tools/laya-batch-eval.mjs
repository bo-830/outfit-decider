#!/usr/bin/env node
/**
 * 批处理实测：串行 4 次 /v1/systemone  vs  1 次 /v1/systemone/batch（4 个 state）
 *
 * 为什么要先实测再改代码：批处理的收益完全取决于 Laya 在这台机器上的实现
 * （单 worker + 单次 forward pass 内 collate 多行）。如果收益不明显，就没必要把
 * App 的打分路径改成批处理、引入新的失败模式。
 *
 * 用法：node tools/laya-batch-eval.mjs [--upstream http://127.0.0.1:8000]
 */
const argv = process.argv.slice(2);
const i = argv.indexOf('--upstream');
const UPSTREAM = (i >= 0 && argv[i + 1] ? argv[i + 1] : 'http://127.0.0.1:8000').replace(/\/+$/, '');

const CRITERIA = {
  overall_score: ['完全不适合这个场合', '明显不太合适', '一般，凑合能穿', '比较得体', '很得体', '非常得体'],
  aesthetic_score: ['很不好看', '不太好看', '一般', '比较好看', '很好看', '非常好看'],
  scene_score: ['完全不适合这个场合', '不太适合这个场合', '基本适合这个场合', '比较适合这个场合', '很适合这个场合', '完全契合这个场合'],
  figure_score: ['很拖沓，比例不好', '略显拖沓', '一般', '比较利落', '很利落', '比例非常好'],
  style_score: ['风格很乱', '风格不够统一', '基本统一', '比较统一', '很统一', '风格非常统一'],
  practical_score: ['很不方便', '不太方便', '一般', '比较方便', '很方便', '非常方便省心'],
};

function questions() {
  const out = {};
  for (const [id, criteria] of Object.entries(CRITERIA)) {
    out[id] = { type: 'score', instructions: `正式面试穿这一套，${id.replace('_score', '')}怎么样？`, criteria };
  }
  return out;
}

const LOOKS = [
  '【穿搭一】藏青色修身西装外套与同色西裤；白色真丝衬衫；黑色中跟单鞋；银色腕表。剪裁合体。',
  '【穿搭二】浅蓝色棉质衬衫（合身）；深灰色直筒九分西裤；白色皮质板鞋；细棕色皮带。',
  '【穿搭三】白色纯棉T恤（合身）；深蓝色直筒牛仔裤；白色运动鞋，略旧。',
  '【穿搭四】亮橙色宽松卡通卫衣；花朵运动短裤；磨损旧拖鞋；荧光绿游泳帽。',
];
const SCENE = '\n\n【我的场合】正式面试\n【我的风格偏好】简约干练';
const states = LOOKS.map((text) => `${text}${SCENE}`);

async function post(path, body) {
  const started = Date.now();
  const response = await fetch(`${UPSTREAM}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json, ms: Date.now() - started };
}

function firstScores(answers) {
  const out = {};
  for (const [id, answer] of Object.entries(answers || {})) out[id] = answer.score;
  return out;
}

async function main() {
  console.log(`upstream = ${UPSTREAM}`);
  console.log(`looks = 4，questions = 6\n`);

  // ① 串行：4 次单条请求
  const serialStarted = Date.now();
  const serial = [];
  for (const state of states) {
    const r = await post('/v1/systemone', { state, questions: questions() });
    serial.push(r);
  }
  const serialMs = Date.now() - serialStarted;
  console.log(`① 串行 4 次 /v1/systemone          : ${serialMs} ms  （单次 ${serial.map((r) => r.ms).join('/')}）`);

  // ② 批处理：1 次请求带 4 个 state
  const batch = await post('/v1/systemone/batch', { states, questions: questions() });
  console.log(`② 1 次 /v1/systemone/batch        : ${batch.ms} ms  status=${batch.status}`);
  if (batch.status !== 200) {
    console.log('   batch 失败：', JSON.stringify(batch.json).slice(0, 300));
    return;
  }
  const results = batch.json.results || [];
  console.log(`   results 条数 = ${results.length}（应等于 states 数）`);
  console.log(`   total_usage = ${JSON.stringify(batch.json.total_usage)}`);

  console.log(`\n加速比 = ${(serialMs / batch.ms).toFixed(2)}x`);

  // ③ 一致性：批处理结果必须与串行逐条一致，否则批处理会改变结论
  console.log('\n--- 一致性检查（批处理 vs 串行，逐条比对）---');
  let same = 0;
  results.forEach((result, index) => {
    const a = JSON.stringify(firstScores(result.answers));
    const b = JSON.stringify(firstScores(serial[index] && serial[index].json.answers));
    const ok = a === b;
    if (ok) same += 1;
    console.log(`  state#${index} ${ok ? '一致' : '不一致'}`);
    if (!ok) {
      console.log(`     batch  = ${a}`);
      console.log(`     serial = ${b}`);
    }
  });
  console.log(`\n一致性：${same}/${results.length} ${same === results.length ? 'PASS' : 'FAIL（批处理改变了分数，不能直接替换）'}`);
}

main().catch((err) => {
  console.log(`ERROR ${err.message}`);
  process.exitCode = 1;
});
