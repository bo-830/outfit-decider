#!/usr/bin/env node
/**
 * Laya 在「出门穿什么」场景下的可用性评估（第二轮，已修正 confidence 字段与问句措辞）。
 *
 * 结论备份：
 *   - 绝对分（score 头）对措辞极不稳定：同一输入微调档位文案，overall 从 2.75 摆到 3.58。
 *   - 相对选择（choice 头）稳定且判断力好：0.62~0.76 的 answer_confidence，重复调用完全一致。
 * 因此本评估重点验证 choice 头在**产品真实规模**下是否可用：2/3/4 选一、两两传递性、none 兜底。
 *
 * 用法：node tools/laya-choice-eval.mjs [--upstream http://127.0.0.1:8000]
 */
const argv = process.argv.slice(2);
const i = argv.indexOf('--upstream');
const UPSTREAM = (i >= 0 && argv[i + 1] ? argv[i + 1] : 'http://127.0.0.1:8000').replace(/\/+$/, '');

const LOOKS = {
  GREAT: '【穿搭一】藏青色修身西装外套与同色西裤；白色真丝衬衫（领口平整）；黑色中跟皮质单鞋；银色简约腕表。剪裁合体，线条利落。',
  GOOD: '【穿搭二】浅蓝色棉质衬衫（合身，袖口平整）；深灰色直筒九分西裤（裤线清晰）；白色低帮皮质板鞋；细棕色皮带与银色腕表。腰线清晰，比例匀称。',
  MID: '【穿搭三】白色纯棉短袖T恤（合身）；深蓝色直筒牛仔裤（长度合适）；白色运动鞋，略旧。',
  BAD: '【穿搭四】亮橙色宽松卡通卫衣（下摆外放）；花朵运动短裤；磨损旧拖鞋；荧光绿游泳帽与大串塑料珠链。腰部被卫衣完全遮挡。',
};

const SCENE = '\n\n【我的场合】正式面试\n【我的风格偏好】简约干练';

async function ask(labels, criteria) {
  // 把每套的编号写进 state，让模型能指认（【穿搭一】…），criteria 的键与编号对齐
  const state = labels.map((key) => LOOKS[key]).join('\n\n') + SCENE;
  const response = await fetch(`${UPSTREAM}/v1/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state,
      questions: {
        best: {
          type: 'choice',
          instructions: '这几套穿搭里，哪一套最适合我今天的场合？',
          criteria,
        },
      },
    }),
  });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.answers.best;
}

const pct = (v) => Number(v).toFixed(2);

async function main() {
  console.log('=== 1) 2 / 3 / 4 选一：是否选中明显最好的一套，重复是否一致 ===');
  const cases = [
    ['2选1', ['GOOD', 'BAD'], { GOOD: '浅蓝衬衫+深灰西裤', BAD: '卡通卫衣+运动短裤' }, 'GOOD'],
    ['3选1', ['GOOD', 'BAD', 'MID'], { GOOD: '浅蓝衬衫+深灰西裤', BAD: '卡通卫衣+运动短裤', MID: '白T恤+牛仔裤' }, 'GOOD'],
    ['4选1', ['GREAT', 'GOOD', 'BAD', 'MID'], {
      GREAT: '藏青西装+白衬衫+中跟单鞋', GOOD: '浅蓝衬衫+深灰西裤', BAD: '卡通卫衣+运动短裤', MID: '白T恤+牛仔裤',
    }, 'GREAT'],
  ];
  for (const [name, set, criteria, expected] of cases) {
    const a = await ask(set, criteria);
    const b = await ask(set, criteria);
    const ok = a.choice === expected;
    console.log(`${name}  pick=${String(a.choice).padEnd(6)} expect=${expected.padEnd(6)} ${ok ? 'PASS' : 'FAIL'}  answer_conf=${pct(a.answer_confidence)}  deterministic=${a.choice === b.choice}`);
    console.log(`      probs=${JSON.stringify(a.probabilities)}`);
  }

  console.log('');
  console.log('=== 2) 两两比较的传递性（GREAT>BAD, GOOD>MID, GREAT>MID 必须自洽）===');
  const pair = (x, y) => ask([x, y], { first: LOOKS[x], second: LOOKS[y] });
  const comparisons = [['GREAT', 'BAD'], ['GOOD', 'MID'], ['GREAT', 'MID']];
  const picks = {};
  for (const [x, y] of comparisons) {
    const answer = await pair(x, y);
    const picked = answer.choice === 'first' ? x : y;
    picks[`${x}/${y}`] = picked;
    console.log(`${x.padEnd(6)} vs ${y.padEnd(6)} -> ${String(answer.choice).padEnd(6)} (=${picked})  answer_conf=${pct(answer.answer_confidence)}`);
  }
  const coherent = picks['GREAT/BAD'] === 'GREAT' && picks['GOOD/MID'] === 'GOOD' && picks['GREAT/MID'] === 'GREAT';
  console.log(`传递性: ${coherent ? 'PASS' : 'FAIL'}`);

  console.log('');
  console.log('=== 3) 「都不合适」兜底：只有一套很差时，模型会不会诚实地说 none ===');
  const noneAnswer = await ask(['BAD'], { first: '卡通卫衣+运动短裤+拖鞋', none: '这一套不适合这个场合' });
  console.log(`choice=${String(noneAnswer.choice)} answer_conf=${pct(noneAnswer.answer_confidence)} probs=${JSON.stringify(noneAnswer.probabilities)}`);
  console.log(`判定: ${noneAnswer.choice === 'none' ? 'PASS（会拒绝）' : '注意（没有拒绝，仍选了它）'}`);

  console.log('');
  console.log('=== 4) 四套全不合适的极端情况（应倾向 none）===');
  const allBad = await ask(['BAD'], { first: '卡通卫衣+运动短裤', second: '荧光泳帽配西裤', none: '都不适合' });
  console.log(`choice=${String(allBad.choice)} probs=${JSON.stringify(allBad.probabilities)}`);
}

main().catch((err) => {
  console.log(`ERROR ${err.message}`);
  process.exitCode = 1;
});
