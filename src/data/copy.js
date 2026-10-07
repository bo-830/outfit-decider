// SPEC §5.1 / §5.2 / §5.3 / §5.4 · 引擎侧中文文案唯一出口。
// 本文件属纯数据层：禁止 import react / react-native / expo。
// message 字段必须与 SPEC §5.1 的中文文案逐字一致（verify 会做包含断言）。

/** 无法识别有效穿搭内容（§5.1 invalid_input） */
export const UNRECOGNIZABLE = '无法识别有效穿搭内容，请上传清晰的穿搭照片哦';

/** 描述里表示"看不清"的固定标记（§5.1 invalid_input 判定 + 描述规范）。 */
export const UNRECOGNIZABLE_MARK = '未清晰显示';

/** 弱网横幅（§5.2） */
export const WEAK_NETWORK = '当前网络较慢，建议先用快速评分；深度分析可能要多等一会儿';

/** 部分失败时单套重试文案（§5.4） */
export const PARTIAL_FAIL_RETRY = '这套没看清，点这里单独重试';

/** 输入不全的提示（§5.3，不阻塞） */
export const HINTS = {
  missingImages: '先选 1-4 张穿搭照片吧',
  tooManyImages: '一次最多 4 套穿搭哦',
  needContext: '补一句场合或问题，我会评得更准',
  oneLook: '只有一套也可以，但两套以上才能帮你比出哪套更好',
};

/**
 * 错误分类表（SPEC §5.1）。
 * message = 用户可见中文文案；action = 用户可做的动作；retryable = 是否值得重试。
 * cancelled 按 SPEC「不展示，静默」处理：message/action 为空串，silent=true，界面不得展示。
 */
export const ERRORS = {
  network: {
    message: '连不上决策模型，请检查网络或本地模型地址是否正确',
    action: '检查设置页地址 / 切快速评分',
    retryable: true,
    silent: false,
  },
  timeout: {
    message: '等待超时了，深度分析在弱网下会更慢，可以先看快速评分',
    action: '重试 / 切 System One',
    retryable: true,
    silent: false,
  },
  auth: {
    message: 'API Key 不正确或没有权限，请在设置页检查 API Key 配置',
    action: '去设置页',
    retryable: false,
    silent: false,
  },
  rate_limit: {
    message: '请求太频繁了，歇一会儿再试',
    action: '稍后重试',
    retryable: true,
    retryDelayMs: 2000,
    silent: false,
  },
  server: {
    message: '决策模型服务出错了，请稍后再试或检查本地模型日志',
    action: '稍后重试',
    retryable: true,
    silent: false,
  },
  parse: {
    message: '模型返回的内容看不懂，请重试一次',
    action: '重试',
    retryable: false,
    silent: false,
  },
  // v1.5：laya_review 需要「能看图的模型」，而它是独立于决策模型的另一条通道。
  // 未配置时不能说成"网络问题"，否则用户会去查网线。必须直接指向配置项。
  vision_unconfigured: {
    message: '还没配置能看照片的模型，请到设置页填写多模态模型地址与模型名',
    action: '去设置页',
    retryable: false,
    silent: false,
  },
  // SPEC §5.5 · 决策端点活着、但它背后的上游（本机 Laya）挂了。
  // 单独一档的理由：这种情形对端**仍然返回 HTTP 200**，只是 body 里 upstream.ok=false。
  // 不单独报的话，用户看到的是整轮失败 + 一堆看不懂的 network/server 文案，
  // 根本不知道真正该做的是"把 Laya 起起来"（实测踩过）。
  upstream_unreachable: {
    message: '决策模型服务没在运行（或刚退出）。请先启动它，再重新分析',
    action: '看启动说明',
    retryable: false,
    silent: false,
  },
  decision_endpoint_unreachable: {
    message: '连不上决策模型地址。请检查地址是否正确、以及服务是否已启动',
    action: '去设置页',
    retryable: false,
    silent: false,
  },
  invalid_input: {
    message: '无法识别有效穿搭内容，请上传清晰的穿搭照片哦',
    action: '换图',
    retryable: false,
    silent: false,
  },
  cancelled: {
    message: '',
    action: '',
    retryable: false,
    silent: true,
  },
};

/** 全部合法 kind（classifyError 的取值域）。 */
export const ERROR_KINDS = Object.keys(ERRORS);

/** 取某 kind 的文案；未知 kind 回落到 server。 */
export function errorInfo(kind) {
  return ERRORS[kind] || ERRORS.server;
}

/**
 * 构造带统一文案的错误对象（AGENTS.md 代码约定：引擎/异常中文文案只允许来自本文件）。
 * 各引擎模块不得再手写 `new Error('…中文…')` + 自填 kind/action/retryable。
 */
export function errorFor(kind, extra = {}) {
  const info = errorInfo(kind);
  const err = new Error(info.message);
  err.kind = ERRORS[kind] ? kind : 'server';
  err.action = info.action;
  err.retryable = !!info.retryable;
  if (info.retryDelayMs !== undefined) err.retryDelayMs = info.retryDelayMs;
  if (info.silent) err.silent = true;
  return Object.assign(err, extra);
}

/** `invalid_input`（图片无法识别出有效穿搭内容）的便捷构造器。 */
export function invalidInputError(extra = {}) {
  return errorFor('invalid_input', extra);
}
