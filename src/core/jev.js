// SPEC §3.10b · TypeSafe JEv 协议（App 直连时用）——禁止 import react/react-native/expo。
//
// 为什么需要这个模块：适配器（tools/laya-adapter.mjs）能让 App 经本机中转用 JEv，
// 但"没有电脑"的用户必须让 **App 自己** 直连 https://api.typesafe.ai。两者需要同一套
// 请求形状与档位定义，所以把它放成纯逻辑共享模块，而不是在适配器里再写一份。
//
// 官方文档（https://docs.typesafe.ai）确认的事实，不是推测：
//   · POST https://api.typesafe.ai/v1/systemone
//   · 头 `Authorization: Bearer <API_KEY>`，`Content-Type: application/json`
//   · 请求体 `{ state, model, questions }`，其中 **`questions` 是 map**（id → Question）
//   · Question = `{ type, instructions, criteria }`；`criteria` 是**有序**档位数组、索引从 0 起
//   · "score 会落在两档之间"（3 档 → 0..2）
//   · 模型别名 `jev-latest`
//   · **No text generation** —— 只答 choice / score / noul（所以它做不了 describe，见 §3.9b）

/** 官方模型别名。 */
export const JEV_MODEL = 'jev-latest';

/** JEv 的 System One 端点（相对 baseUrl）。 */
export const JEV_ASK_PATH = '/systemone';

/**
 * 已知**不属于** JEv 的模型名：本机 Laya（`laya`）与 App 的通用默认占位（`outfit-judge-v1`）。
 * 直接点 JEv 时这些名字没有意义，发过去必然 400。
 */
const NON_JEV_MODEL_NAMES = new Set(['', 'laya', 'outfit-judge-v1']);

/**
 * 决定发给 JEv 的模型名。
 *
 * 为什么不能简单地"用户填什么就发什么"：老版本把 `model` 持久化过（实测存的是 `laya`），
 * 升级后用户切到直连 JEv，那个旧名字会被一直带过去 → 400。
 * 而 `jev-latest` 是文档规定的别名，任何 JEv 端点都认。
 * 所以：**已知的非 JEv 名字 → 换成官方别名**；用户自己填的其它名字 → 尊重。
 */
export function resolveJevModel(configuredModel) {
  const name = typeof configuredModel === 'string' ? configuredModel.trim() : '';
  return NON_JEV_MODEL_NAMES.has(name) ? JEV_MODEL : name;
}

/** 上游主机名特征：命中即认为在跟 TypeSafe JEv 说话。 */
const JEV_HOST_RE = /(^|\.)typesafe\.ai$/i;

/**
 * 是否应该按 JEv 协议发请求。
 *
 * 显式配置优先（`protocol` 为 'jev'/'generic'）；为 'auto' 或缺省时按主机名判断
 * （`api.typesafe.ai`）。**不做更聪明的猜测**：猜错会静默发错形状，比要求用户明确更难查。
 */
export function resolveProtocol(baseUrl, configured) {
  if (configured === 'jev') return 'jev';
  if (configured === 'generic') return 'generic';
  let host = '';
  try {
    host = new URL(String(baseUrl || '')).hostname;
  } catch {
    return 'generic';
  }
  return JEV_HOST_RE.test(host) ? 'jev' : 'generic';
}

/**
 * 6 个评分维度的**有序档位**（索引即分值 0–5）。
 *
 * 措辞是实测调出来的，别改回「XX 是多少分」那种问法：同一条输入，换成面向人／场合的
 * 「适合不适合」，区分度从 0.36 提升到 1.59（见 tools/laya-eval.mjs 的 GOOD/BAD/MID 对照）。
 *
 * 对 JEv 而言 6 档尤其合适：文档说 score 是"档位谱上的位置、可落在两档之间"，
 * 所以 6 档正好给出 0–5 且天然支持 App 要求的 1 位小数 —— **不需要任何映射**
 * （而本机 Laya 只有 3 档，才需要把 0–2 映射上去）。
 */
export const SCORE_RUBRICS = {
  overall_score: ['完全不适合这个场合', '明显不太合适', '一般，凑合能穿', '比较得体', '很得体', '非常得体'],
  aesthetic_score: ['很不好看', '不太好看', '一般', '比较好看', '很好看', '非常好看'],
  scene_score: ['完全不适合这个场合', '不太适合这个场合', '基本适合这个场合', '比较适合这个场合', '很适合这个场合', '完全契合这个场合'],
  figure_score: ['很拖沓，比例不好', '略显拖沓', '一般', '比较利落', '很利落', '比例非常好'],
  style_score: ['风格很乱', '风格不够统一', '基本统一', '比较统一', '很统一', '风格非常统一'],
  practical_score: ['很不方便', '不太方便', '一般', '比较方便', '很方便', '非常方便省心'],
};

/** 每个维度的问句模板。`{scene}` 替换成用户选中的场合（没有就退化成「日常出门」）。 */
export const SCORE_INSTRUCTIONS = {
  overall_score: '{scene}穿这一套，整体得体吗？',
  aesthetic_score: '这一套搭配看起来好看吗？',
  scene_score: '这一套适合穿着去{scene}吗？',
  figure_score: '这一套穿上身后，身形看起来利落、比例好吗？',
  style_score: '这一套的单品之间风格统一吗？',
  practical_score: '这一套{scene}穿着方便、省心吗？',
};

export const SCORE_IDS = Object.keys(SCORE_RUBRICS);

/** 从 state 文本里取第一个场合（与适配器的 sceneOf 同一口径）。 */
export function sceneOf(stateText) {
  const match = String(stateText || '').match(/【我的场合】\s*([^\n]+)/);
  if (!match) return '日常出门';
  const first = match[1].split(/[、,，·]/)[0].trim();
  return first || '日常出门';
}

/**
 * App 的数组式 questions → JEv 要求的 **map**。
 *
 * App 侧发的是 `[{id,type,question}]`，JEv 要的是 `{ id: {type,instructions,criteria} }`。
 * 这层转换就是"App 直连 JEv"必须做的事；经适配器时由适配器做同一件事。
 *
 * - 评分维度：`criteria` 用 6 档档位，`instructions` 用 App 的问题原文
 *   （JEv 是指令型模型，原文最忠实；不为它套用那套为 Laya 调出来的模板措辞）。
 * - 非评分项（如 describe_*）：JEv **不做文本生成**，无法生成描述。
 *   这里仍然产出合法的 score 形状，让对端能作答而不是直接报错；
 *   真正的"看不了图"由上层在发起前拦住（§3.9b 的 vision 通道检查）。
 */
export function toJevQuestions(items, options = {}) {
  const scene = options.scene || '日常出门';
  const out = {};
  const incoming = Array.isArray(items) ? items : [];
  for (const item of incoming) {
    if (!item || !item.id) continue;
    const id = String(item.id);
    const asked = String(item && item.question ? item.question : '').trim();
    if (SCORE_IDS.includes(id)) {
      out[id] = {
        type: 'score',
        instructions: asked || (SCORE_INSTRUCTIONS[id] || `${scene}穿这一套得体吗？`).replace('{scene}', scene),
        criteria: SCORE_RUBRICS[id],
      };
    } else {
      // 非评分项：用档位表达"能不能回答"，与适配器同口径，避免产生非法请求体
      out[id] = {
        type: 'score',
        instructions: asked || id,
        criteria: ['无法回答', '部分回答', '可以回答'],
      };
    }
  }
  return out;
}

/**
 * App 请求体 → JEv 请求体。
 * 保持字段顺序 state → model → questions（与 §1.3 的"严格字段顺序"约定一致）。
 */
export function toJevRequest({ state, model, questions } = {}) {
  return {
    state: typeof state === 'string' ? state : state == null ? '' : String(state),
    model: typeof model === 'string' && model ? model : JEV_MODEL,
    questions: toJevQuestions(questions, { scene: sceneOf(state) }),
  };
}

/** JEv 响应里 answers 是 map；取出来并归一化成 App 的数组式 answers。 */
export function fromJevAnswers(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return [];
  const out = [];
  for (const [id, value] of Object.entries(answers)) {
    if (!value || typeof value !== 'object') continue;
    const type = typeof value.type === 'string' ? value.type : 'score';
    const rawScore = typeof value.score === 'number' ? value.score : null;
    const item = {
      id,
      type,
      // 0–5 一位小数钳制；越界与非法值一律给 null，不编造分数
      score: rawScore === null ? null : Math.min(5, Math.max(0, Math.round(rawScore * 10) / 10)),
      // 文档：score/choice/noul 都返回 confidence；缺省给 null 而不是假造 0.5
      confidence: typeof value.confidence === 'number' ? value.confidence : null,
    };
    if (type === 'choice') {
      item.content = typeof value.choice === 'string' ? value.choice : null;
    }
    out.push(item);
  }
  return out;
}
