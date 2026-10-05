// SPEC §3.7 · 图片 → 结构化纯文字描述（System One 第 1 步）。
// 描述只允许客观事实；空描述 → {kind:'invalid_input'}。
//
// v1.2 修正（§3.7）：describe 必须把这一套自己的图带上，否则真实端点下模型看不到画面。
//
// v1.5 双通道（重要，这是两种部署都能跑起来的关键）：
//   A) 配了多模态端点（visionBaseUrl + visionModel）→ **走 vision 通道看原图**。
//      这才是"图片转文字"的本义：用能看图的模型描述画面。
//   B) 没配多模态端点 → 退回决策模型的 JEv `/ask` 通道（把图随请求体带上，
//      由对端决定怎么处理）。这样"只配了本地决策模型"的部署依然可用，
//      而不是整个 System One 直接报错。
// 两种通道产出同一种 {lookId, text}，上层无需分支。

import { buildDescribeQuestions, DESCRIBE_SYSTEM_PROMPT, DESCRIPTION_DIMENSIONS } from '../core/prompts.js';
import { toDataUri } from '../core/protocol.js';
import { invalidInputError, UNRECOGNIZABLE_MARK } from '../data/copy.js';

/** §3.7 要求"state 传空描述占位"：给一个非空的中性占位串，避免对端把空串判成缺字段。 */
const DESCRIBE_STATE_PLACEHOLDER = '（本次只做图片客观描述，无用户上下文）';

/** 走 vision 通道时的用户指令：复用 SPEC §3.2 的七个描述维度。 */
const VISION_DESCRIBE_INSTRUCTION = [
  '请客观描述这张穿搭照片。',
  `按这七个维度分点写，每行一个，用「维度：内容」的格式：${DESCRIPTION_DIMENSIONS.join('、')}。`,
  `分不清或被遮挡的部位，一律写「${UNRECOGNIZABLE_MARK}」，不得猜测、不得编造。`,
  '只写你在画面里真实看到的事实，不要评价好看与否，不要给建议。',
].join('\n');

export function makeVisionEngine({ api, model } = {}) {
  /**
   * App 是否**能自己**发 image_url 请求（决定 describe 走哪条通道）。
   * 注意必须是 visionEndpointConfigured 而不是 visionReady：
   * 服务端形态（visionServerSide）下 App 没有自己的端点 → 必须退回决策通道，
   * 由适配器在服务端看图。用错判据会让 describe 直接抛 vision_unconfigured（实测踩过）。
   */
  function hasVisionChannel() {
    if (!api) return false;
    if (typeof api.visionEndpointConfigured === 'function') return api.visionEndpointConfigured();
    return !!(typeof api.vision === 'function' && api.visionConfigured && api.visionConfigured());
  }

  /**
   * 描述一套穿搭。
   *
   * `knownText`：调用方**已经拿到**的描述。命中时直接复用，不再发请求。
   * 存在的理由（性能）：describe 阶段本身已经为每套产出过一份描述，纠正阶段构造提示词时
   * 若再调一次，就会为同一张图重复付费、重复等待（实测每套多一次视觉调用）。
   * 传入已有描述可以彻底消掉这部分重复。
   */
  async function describeLook({ artifact, lookId, signal, knownText } = {}) {
    if (!api) throw invalidInputError();
    const cached = typeof knownText === 'string' ? knownText.trim() : '';
    if (cached) return { lookId, text: cached };
    const text = hasVisionChannel()
      ? await describeViaVision({ api, artifact, lookId, signal })
      : await describeViaDecision({ api, artifact, lookId, model, signal });
    if (!text) throw invalidInputError();
    return { lookId, text };
  }

  return { describeLook, hasVisionChannel };
}

/** 通道 A：多模态端点直接看原图 → 结构化描述。 */
async function describeViaVision({ api, artifact, lookId, signal }) {
  const images = describeImages(artifact, lookId);
  if (!images.length) throw invalidInputError();
  const response = await api.vision({
    system: DESCRIBE_SYSTEM_PROMPT,
    content: VISION_DESCRIBE_INSTRUCTION,
    answerId: `describe_${lookId}`,
    images,
    temperature: 0,
    signal,
  });
  const answer = pickAnswer(response, `describe_${lookId}`);
  return answer;
}

/** 通道 B：决策模型的 JEv `/ask`（图随请求体带上，由对端处理）。 */
async function describeViaDecision({ api, artifact, lookId, model, signal }) {
  if (typeof api.ask !== 'function') throw invalidInputError();
  const response = await api.ask({
    state: DESCRIBE_STATE_PLACEHOLDER,
    questions: buildDescribeQuestions(lookId),
    images: describeImages(artifact, lookId),
    signal,
    model,
  });
  return pickAnswer(response, `describe_${lookId}`);
}

/** 从响应里取文字答案：优先按 id，其次第一个 text 型，最后第一个答案。 */
function pickAnswer(response, expectedId) {
  const answers = response && Array.isArray(response.answers) ? response.answers : [];
  const answer = answers.find((item) => item && item.id === expectedId)
    || answers.find((item) => item && item.type === 'text')
    || answers[0];
  const text = answer && typeof answer.content === 'string' ? answer.content.trim() : '';
  return text || '';
}

/** 只带这一套自己的图；artifact 缺 base64/mime 时退化为空数组（对端仍可据 question.id 作答）。 */
function describeImages(artifact, lookId) {
  if (!artifact || typeof artifact.base64 !== 'string' || !artifact.mime) return [];
  return [{ id: lookId, dataUri: toDataUri(artifact) }];
}
