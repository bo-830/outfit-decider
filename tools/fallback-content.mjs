/**
 * tools/fallback-content.mjs
 *
 * mock 服务在 fixtures/descriptions/*.json 与 fixtures/deep/*.json **缺失或损坏**时使用的内置兜底内容。
 * 之所以放在 tools/ 里：fixtures/descriptions 与 fixtures/deep 是 t-A（核心引擎）的写入范围，
 * mock 只读取、不创建；缺失时只要兜底内容与 SPEC §2 / §3.2 / §3.9 的字段口径一致，
 * 契约对端依然可用（t-A 补上 fixture 后会自动优先使用文件内容）。
 *
 * 注意：本文件含中文，必须保持 UTF-8；stdout 不打印这里的内容。
 */

/** 7 个描述维度，顺序与 SPEC §3.2 buildSyntheticStateText 的拼接规则一致 */
export const DESCRIBE_DIMENSIONS = [
  '整体风格',
  '上衣',
  '下装',
  '鞋履',
  '配饰',
  '身材视觉效果',
  '其他细节',
];

/** 结构化描述按 `维度：内容；维度：内容` 单行给出（与 §3.2 示例同形） */
function line(pairs) {
  return DESCRIBE_DIMENSIONS.map((dim, i) => `${dim}：${pairs[i]}`).join('；');
}

/**
 * look1..look4 的兜底结构化描述。
 * 按 SPEC §6 要求：含 7 个维度，且含「未清晰显示」的用例（look3 配饰、look4 其他细节）。
 */
export const FALLBACK_DESCRIPTIONS = {
  look1: line([
    '简约通勤风，线条干净',
    '浅蓝色棉质衬衫，版型微宽松，袖口挽起',
    '深灰色直筒九分西裤',
    '白色低帮皮质板鞋',
    '细棕色皮带与银色表盘腕表',
    '上下身比例匀称，腰线清晰可见',
    '衬衫下摆收进裤腰，整体利落',
  ]),
  look2: line([
    '温柔甜美风，色调整体偏浅',
    '米白色针织开衫，内搭同色吊带',
    '浅粉A字半身长裙，裙摆及小腿中段',
    '米色平底玛丽珍鞋',
    '珍珠耳钉与细链条小挎包',
    '裙长与身高比例协调，视觉重心偏上',
    '开衫袖口有罗纹收口，面料垂坠',
  ]),
  look3: line([
    '酷飒休闲风，深色为主',
    '黑色机车皮衣，内搭白色圆领T恤',
    '深蓝色直筒牛仔裤，裤脚微卷',
    '黑色厚底短靴',
    '配饰：未清晰显示',
    '肩线利落，腰部未收束，视觉上偏直线条',
    '皮衣拉链半开，T恤图案被遮挡看不清',
  ]),
  look4: line([
    '元气少女风，撞色明显',
    '亮黄色短款卫衣，胸前有字母印花',
    '浅蓝色高腰阔腿牛仔裤',
    '白色老爹鞋',
    '斜挎小方包，织带为彩色',
    '高腰提高腰线，腿部视觉占比增加',
    '其他细节：未清晰显示',
  ]),
};

/** 全部维度都「未清晰显示」的描述：SPEC §6 test-unrecognizable 与 §5.1 invalid_input 用 */
export const UNRECOGNIZABLE_DESCRIPTION = line(
  DESCRIBE_DIMENSIONS.map(() => '未清晰显示'),
);

/** System Two 固定 5 个维度名（SPEC §3.9） */
export const DEEP_DIMENSIONS = [
  '场合适配度',
  '美观度',
  '身材友好度',
  '风格统一度',
  '实用舒适度',
];

function detail(lookId, stars, pros, cons, suggestions) {
  return {
    lookId,
    dimensions: DEEP_DIMENSIONS.map((name, i) => ({ name, stars: stars[i] })),
    pros,
    cons,
    suggestions,
  };
}

/** 兜底深度报告（2 套）。字段严格按 SPEC §3.9。 */
export const FALLBACK_DEEP_2 = {
  ranking: [
    { lookId: 'look2', stars: 4.5, oneLineReason: '浅色针织配A字长裙，通勤与约会都稳妥，整体最协调。' },
    { lookId: 'look1', stars: 4, oneLineReason: '衬衫配西裤干净利落，正式度够但如果想更出彩略显保守。' },
  ],
  details: [
    detail(
      'look2',
      [4.5, 4.5, 4.5, 4.5, 4],
      ['色调整体统一，浅色系对肤色友好', 'A字裙摆对下半身包容度好', '针织开衫能应对室内外温差'],
      ['长裙在雨天容易沾湿下摆'],
      ['换一双同色系中跟鞋可提升正式度', '把内搭换成高领可增加层次'],
    ),
    detail(
      'look1',
      [4.5, 3.5, 4, 4.5, 4.5],
      ['衬衫加西裤是通勤的安全牌', '白鞋降低了整体的刻板感'],
      ['上装偏宽松时腰线会被弱化'],
      ['把袖子挽到小臂中段更显精神', '加一条细腰带明确腰线'],
    ),
  ],
  conclusion: {
    pick: 'look2',
    reason: '两套都能满足日常场合，look2 在色彩协调度与身材包容度上更好，出错的概率最低。',
    alternatives: ['想更正式就选 look1，衬衫配西裤的成熟度更高'],
    tip: '出发前把开衫下摆两侧往里收一点，腰线会更清楚。',
  },
};

/** 兜底深度报告（4 套）。 */
export const FALLBACK_DEEP_4 = {
  ranking: [
    { lookId: 'look2', stars: 4.5, oneLineReason: '浅色针织配A字长裙，通勤与聚会都稳妥，整体最协调。' },
    { lookId: 'look4', stars: 4, oneLineReason: '高腰阔腿裤加短卫衣，比例最好，上镜效果突出。' },
    { lookId: 'look1', stars: 3.5, oneLineReason: '衬衫西裤干净利落，正式度足够但个性偏弱。' },
    { lookId: 'look3', stars: 3, oneLineReason: '皮衣牛仔裤很酷，但下装偏厚重，长时间行走舒适度一般。' },
  ],
  details: [
    detail('look2', [4.5, 4.5, 4.5, 4.5, 4],
      ['色调整体统一，浅色系对肤色友好', 'A字裙摆对下半身包容度好', '针织开衫能应对室内外温差'],
      ['长裙在雨天容易沾湿下摆'],
      ['换一双同色系中跟鞋可提升正式度']),
    detail('look4', [4, 4.5, 4.5, 4, 3.5],
      ['高腰设计明显提高腰线', '撞色搭配在照片里很抓眼', '阔腿版型对腿型包容'],
      ['阔腿裤裤脚偏长，容易踩到'],
      ['裤脚改到脚踝上方会更利落', '印花卫衣配纯色包可以降低花哨感']),
    detail('look1', [4.5, 3.5, 4, 4.5, 4.5],
      ['衬衫加西裤是通勤的安全牌', '白鞋降低了整体的刻板感'],
      ['上装偏宽松时腰线会被弱化'],
      ['把袖子挽到小臂中段更显精神']),
    detail('look3', [3.5, 4, 3.5, 4, 3],
      ['皮衣肩线利落，气场足', '深色系显瘦效果明显'],
      ['短靴加厚底在长时间行走时偏累'],
      ['把T恤换成纯色可减少杂乱', '配饰看不清，建议换成小体量银色耳饰']),
  ],
  conclusion: {
    pick: 'look2',
    reason: '四套里 look2 的场合适配面最广，色彩与廓形都最协调，换场合也不容易出错。',
    alternatives: ['要拍照上镜选 look4', '想酷一点选 look3'],
    tip: '把针织开衫最上面一颗扣子解开，领口线条会更舒展。',
  },
};
