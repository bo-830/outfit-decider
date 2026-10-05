#!/usr/bin/env node
/**
 * 顺序敏感性测试：同一组穿搭，只调换出现顺序，看 Laya 的选择是否跟着顺序走。
 *
 * 为什么这条对产品是致命的：如果「哪套最好」这个答案会随上传顺序改变，
 * 那么用户换一张图的顺序就会看到不同结论 —— 排序就不可信，双引擎对比也失去意义。
 *
 * 用法：node tools/laya-order-eval.mjs [--upstream http://127.0.0.1:8000]
 */
const argv = process.argv.slice(2);
const i = argv.indexOf('--upstream');
const UPSTREAM = (i >= 0 && argv[i + 1] ? argv[i + 1] : 'http://127.0.0.1:8000').replace(/\/+$/, '');

// 三套「都好但档次不同」的穿搭：西装 > 衬衫西裤 > 白T牛仔裤
const TEXT = {
  SUIT: '藏青色修身西装外套与同色西裤；白色真丝衬衫（领口平整）；黑色中跟皮质单鞋；银色简约腕表。剪裁合体，线条利落。',
  SHIRT: '浅蓝色棉质衬衫（合身，袖口平整）；深灰色直筒九分西裤（裤线清晰）；白色低帮皮质板鞋；细棕色皮带与银色腕表。',
  TEE: '白色纯棉短袖T恤（合身）；深蓝色直筒牛仔裤（长度合适）；白色运动鞋，略旧。',
};
const NUMS = ['一', '二', '三', '四'];
const SCENE = '\n\n【我的场合】正式面试\n【我的风格偏好】简约干练';

/** 按给定顺序拼 state，并返回「编号 → 款式键」的映射（用于确认模型选中的到底是哪一款）。 */
function buildState(order) {
  const state = order
    .map((key, index) => `【穿搭${NUMS[index]}】${TEXT[key]}`)
    .join('\n\n') + SCENE;
  const criteria = Object.fromEntries(order.map((key, index) => [`look${NUMS[index]}`, TEXT[key]]));
  return { state, criteria, map: Object.fromEntries(order.map((key, index) => [`look${NUMS[index]}`, key])) };
}

async function ask(order) {
  const { state, criteria, map } = buildState(order);
  const response = await fetch(`${UPSTREAM}/v1/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state,
      questions: {
        best: { type: 'choice', instructions: '这几套穿搭里，哪一套最适合我今天的场合？', criteria },
      },
    }),
  });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const answer = body.answers.best;
  return { chosenKey: map[answer.choice], raw: answer.choice, confidence: answer.answer_confidence };
}

async function main() {
  const orders = [
    ['SUIT', 'SHIRT', 'TEE'],
    ['TEE', 'SHIRT', 'SUIT'],
    ['SHIRT', 'SUIT', 'TEE'],
    ['SHIRT', 'TEE', 'SUIT'],
  ];
  const results = [];
  for (const order of orders) {
    const result = await ask(order);
    results.push({ order: order.join('>'), ...result });
    console.log(`顺序 ${order.join(' > ').padEnd(22)} 选中=${String(result.chosenKey).padEnd(6)} (${result.raw})  answer_conf=${Number(result.confidence).toFixed(2)}`);
  }

  const picks = new Set(results.map((r) => r.chosenKey));
  console.log('');
  console.log('--- verdict ---');
  console.log(`不同顺序下选中的款式集合: {${[...picks].join(', ')}}`);
  console.log(`顺序稳定性: ${picks.size === 1 ? 'PASS（始终选同一款）' : `FAIL（随顺序改变，共 ${picks.size} 种答案）`}`);

  // 首位置偏置检查：是不是总选第一个？
  const firstPosHits = results.filter((r, index) => r.raw === `look${NUMS[0]}`).length;
  console.log(`首位置命中: ${firstPosHits}/${results.length}${firstPosHits === results.length ? '  ← 疑似位置偏置：总是选第一套' : ''}`);
}

main().catch((err) => {
  console.log(`ERROR ${err.message}`);
  process.exitCode = 1;
});
