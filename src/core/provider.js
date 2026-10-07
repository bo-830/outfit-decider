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
 */
export function layaPreset() {
  return {
    mode: 'laya',
    baseUrl: 'http://127.0.0.1:8787',
    askPath: '/ask',
    healthPath: '/health',
    model: '',
    protocol: 'generic',
  };
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
  const jev = jevPreset();
  const laya = layaPreset();
  const isJev = isJevConfigured(config);
  return [
    {
      id: 'jev',
      label: 'JEv 云端',
      hint: 'TypeSafe JEv 云端，带 API Key',
      active: isJev,
      filled: `已切到 JEv 云端：${jev.baseUrl}${jev.askPath}`,
    },
    {
      id: 'laya',
      label: 'Laya 本地',
      hint: '本机 / 局域网，需电脑常驻',
      active: !isJev,
      filled: `已切回本机：${laya.baseUrl}`,
    },
  ];
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
  return '';
}

/** 点某个供应商时应写入的整套配置。 */
export function providerPreset(id) {
  return id === 'jev' ? jevPreset() : layaPreset();
}
