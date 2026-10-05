// SPEC §3.7 · 图片 → 结构化纯文字描述（System One 第 1 步）。
// 描述只允许客观事实；空描述 → {kind:'invalid_input'}。
//
// v1.2 修正（SPEC §3.7）：System One 的第一步本来就是"调用多模态能力把照片转成结构化文字"，
// 因此 describe 必须把这一套的图片带上（images:[{id, dataUri}]），否则真实端点下模型看不到图。
// mock 通过 question.id / state 段头 / images[].id 三者任一都能定位到是哪一套，带图不影响既有契约。

import { buildDescribeQuestions } from '../core/prompts.js';
import { toDataUri } from '../core/protocol.js';
import { invalidInputError } from '../data/copy.js';

/** §3.7 要求"state 传空描述占位"：给一个非空的中性占位串，避免对端把空串判成缺字段。 */
const DESCRIBE_STATE_PLACEHOLDER = '（本次只做图片客观描述，无用户上下文）';

export function makeVisionEngine({ api, model } = {}) {
  async function describeLook({ artifact, lookId, signal } = {}) {
    if (!api || typeof api.ask !== 'function') throw invalidInputError();
    const response = await api.ask({
      state: DESCRIBE_STATE_PLACEHOLDER,
      questions: buildDescribeQuestions(lookId),
      images: describeImages(artifact, lookId),
      signal,
      model,
    });
    const answers = response && Array.isArray(response.answers) ? response.answers : [];
    const expectedId = `describe_${lookId}`;
    const answer = answers.find((item) => item && item.id === expectedId)
      || answers.find((item) => item && item.type === 'text')
      || answers[0];
    const text = answer && typeof answer.content === 'string' ? answer.content.trim() : '';
    if (!text) throw invalidInputError();
    return { lookId, text };
  }

  return { describeLook };
}

/** 只带这一套自己的图；artifact 缺 base64/mime 时退化为空数组（对端仍可据 question.id 作答）。 */
function describeImages(artifact, lookId) {
  if (!artifact || typeof artifact.base64 !== 'string' || !artifact.mime) return [];
  return [{ id: lookId, dataUri: toDataUri(artifact) }];
}
