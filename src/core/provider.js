// SPEC §3.10b · **用哪家的模型打分**（JEv 云端 / Laya 本地）——纯逻辑，禁止 import react/expo。
//
// 为什么单独一个模块：设置页同时存在两套控件
//   · 打分档位（只用本地 / 本地+纠正 / 只用多模态）
//   · 供应商（JEv 云端 / Laya 本地）
// 它们曾经互不相干，于是出现两种怪现象（用户实测反馈）：
//   1) 选了「Laya 本地」还能点「直连 TypeSafe JEv」，一点就把地址改成云端——本地被悄悄覆盖；
//   2) 上面写着"Laya"、实际打分的却是 baseUrl 指向的 JEv——"Laya"那一档也能连上 JEv。
// 现在的契约：**选供应商 = 同时把地址/路径/模型/协议整套填好**，两者不可能再矛盾。
//
// 放 src/core 而不是 SettingsScreen.jsx，是因为这里必须能被 node --test 直接跑
//（`.jsx` 在 node 下无法解析，测试也拿不到这些纯函数）。

import { resolveProtocol } from './jev.js';

/** JEv 云端：依据官方文档 https://docs.typesafe.ai（端点 /v1/systemone、别名 jev-latest）。 */
export function jevPreset() {
  return {
    mode: 'jev',
    baseUrl: 'https://api.typesafe.ai/v1',
    askPath: '/systemone',
    healthPath: '/systemone',
    model: 'jev-latest',
    protocol: 'jev',
  };
}

/**
 * Laya 本地：走本机适配器。
 *
 * `protocol: 'generic'` 是**必须的**（不是冗余）：适配器对 App 说的是数组式通用协议，
 * 若留着 `'jev'`，App 会把 JEv 的 map 形状直接发给适配器，形状就对不上了。
 * 同理清空模型名，避免把 `jev-latest` 发给本机。
 *
 * 关于 baseUrl：**故意不写死**。真机上 `127.0.0.1` 指的是手机自己，而电脑的局域网 IP
 * 会随路由器重新分配（实测在 192.168.1.4 / 192.168.73.231 / 10.63.1.253 之间变过）。
 * 写死一个"看起来对"的地址只会让用户以为配好了却连不上。
 * 所以这里返回空串，由 `applyLayaProvider()` 决定复用哪个地址、或提示用户去填。
 *
 * `visionServerSide: false`：本地档位下**视觉模型由 App 自己配**。
 * 适配器只做协议桥，勾了"已配在服务端"而服务端其实没有时，纠正会静默失效。
 */
export function layaPreset() {
  return {
    mode: 'laya',
    baseUrl: '',
    askPath: '/ask',
    healthPath: '/health',
    model: '',
    protocol: 'generic',
    visionServerSide: false,
  };
}

/** 本地地址是否值得记住/复用（排除 JEv 云端与真机上等于"手机自己"的 127.0.0.1）。 */
export function isUsableLocalBaseUrl(url) {
  const text = String(url || '').trim();
  if (!text) return false;
  if (resolveProtocol(text, 'auto') === 'jev') return false;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(text)) return false;
  return true;
}

/**
 * 切到「Laya 本地」时实际写入的配置。
 *
 * 关键行为：**优先复用用户填过的局域网地址**（`localBaseUrl`），而不是覆盖成默认值；
 * 都没有时保持为空，让用户去填 —— 宁可空着提示，也不要给一个错的地址。
 */
export function applyLayaProvider(config = {}) {
  const remembered = String(config.localBaseUrl || '').trim();
  const current = String(config.baseUrl || '').trim();
  const baseUrl = isUsableLocalBaseUrl(remembered)
    ? remembered
    : (isUsableLocalBaseUrl(current) ? current : '');
  return { ...layaPreset(), baseUrl };
}

/**
 * 切到 JEv 云端时写入的配置：先把当前本地地址记进 `localBaseUrl`，
 * 这样来回切换不会丢掉用户填过的局域网 IP。
 */
export function applyJevProvider(config = {}) {
  const current = String(config.baseUrl || '').trim();
  const next = { ...jevPreset() };
  if (isUsableLocalBaseUrl(current)) next.localBaseUrl = current;
  return next;
}

/** 按供应商 id 返回要写入的整套配置（点一次就一致，不会互相矛盾）。 */
export function providerPreset(id, config = {}) {
  return id === 'jev' ? applyJevProvider(config) : applyLayaProvider(config);
}

/**
 * 当前配置是否指向 TypeSafe JEv（协议显式声明，或地址命中）。
 *
 * 复用 `resolveProtocol` 而不是自己写正则：它按**主机名**判断
 * （`api.typesafe.ai` 算、`evil-typesafe.ai` / `typesafe.ai.evil.com` 不算）。
 * 自己写 `/typesafe\.ai/` 会被伪装域名骗到 —— 单测已盯住这条。
 */
export function isJevConfigured(config = {}) {
  return resolveProtocol(config.baseUrl, config.protocol) === 'jev';
}

/** 供应商两选一：按当前配置高亮，**恒有且只有一项**激活。 */
export function providerOptions(config = {}) {
  const isJev = isJevConfigured(config);
  const remembered = String(config.localBaseUrl || '').trim();
  return [
    {
      id: 'jev',
      label: 'JEv 云端',
      hint: 'TypeSafe JEv 云端，带 API Key',
      active: isJev,
    },
    {
      id: 'laya',
      label: 'Laya 本地',
      hint: '本机 / 局域网，需电脑常驻',
      active: !isJev,
      // 地址是用户自己填的（IP 会变），所以这里不写死默认值
      filled: isUsableLocalBaseUrl(remembered)
        ? `已切回本机：${remembered}`
        : '已切回本机：请填电脑的局域网地址',
    },
  ];
}

/** 是否是"指向本机自己"的环回地址（127.0.0.1 / localhost）。 */
export function isLoopbackBaseUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(String(url || '').trim());
}

/**
 * 本地地址的可用性问题；可用时返回空串。
 *
 * 分三种情况，因为**后果和修法都不同**：
 *   1. 空        —— 还没填，真机上必然连不上；
 *   2. 环回地址  —— 模拟器/`adb reverse` 可用，**真机上等于指向手机自己**，最迷惑人的一种；
 *   3. 其它      —— 局域网地址，可用（但可能随路由器变化）。
 * 只靠"能不能连上"是发现不了第 2 种的：用户会以为配好了。
 */
export function localAddressIssue(config = {}) {
  const raw = String(config.baseUrl || '').trim();
  if (!raw) {
    return '还没填电脑的地址。真机上不能填 127.0.0.1（那指手机自己），要填电脑的局域网 IP（如 http://192.168.1.20:8787）；它可能随路由器变化，变了就改这里。';
  }
  if (isLoopbackBaseUrl(raw)) {
    return '当前地址是 127.0.0.1，只有模拟器能用（或真机做过 adb reverse）。真机请改成电脑的局域网 IP（如 http://192.168.1.20:8787）——它可能随路由器变化，变了就改这里。';
  }
  return '';
}

/**
 * 档位与供应商不一致时给出提示，一致时返回空串（不打扰用户）。
 *
 * 这正是用户遇到的两个怪现象：选了「本地」地址却是云端，或反之。
 */
export function providerMismatch(config = {}) {
  const isJev = isJevConfigured(config);
  if (config.mode === 'laya' && isJev) {
    return '当前选的是「Laya 本地」，但地址指向 JEv 云端 —— 打分其实走云端。点上面的「Laya 本地」可一键对齐。';
  }
  if (config.mode === 'jev' && !isJev) {
    return '当前选的是「JEv 云端」，但地址不是 TypeSafe —— 打分其实走你填的地址。点上面的「JEv 云端」可一键对齐。';
  }
  // 本地档位：地址本身可能不可用（空 / 环回），这时也必须说清楚
  if (config.mode === 'laya') return localAddressIssue(config);
  return '';
}
