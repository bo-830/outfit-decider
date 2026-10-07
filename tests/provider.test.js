// SPEC §3.10b · 供应商选择（JEv 云端 / Laya 本地）与"打分档位"不得互相矛盾。
//
// 起因（用户实测反馈）：设置页同时存在两套控件——
//   · 打分档位（只用本地 / 本地+纠正 / 只用多模态）
//   · 决策模型地址里的「直连 TypeSafe JEv」按钮
// 它们互不相干，于是出现两种怪现象：
//   1) 选了「Laya 本地」还能点「直连 JEv」，一点就把地址改成云端——本地被悄悄覆盖；
//   2) 上面写着"Laya"、实际打分的却是 baseUrl 指向的 JEv——"Laya"那一档也能连上 JEv。
// 现在的契约：**选供应商 = 同时把地址/路径/模型/协议整套填好**。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isJevConfigured,
  jevPreset,
  layaPreset,
  providerMismatch,
  providerOptions,
  providerPreset,
} from '../src/core/provider.js';
import { DEFAULT_CONFIG } from '../src/engine/api.js';
import { resolveProtocol } from '../src/core/jev.js';

test('jevPreset：一次填好协议所需全部字段（地址/路径/模型/协议/模式）', () => {
  const p = jevPreset();
  assert.equal(p.mode, 'jev', '必须同时把 mode 切到 jev，否则与档位矛盾');
  assert.equal(p.baseUrl, 'https://api.typesafe.ai/v1');
  assert.equal(p.askPath, '/systemone');
  assert.equal(p.healthPath, '/systemone');
  assert.equal(p.model, 'jev-latest');
  assert.equal(p.protocol, 'jev');
  // 填完的配置必须真的被判成 JEv
  assert.equal(resolveProtocol(p.baseUrl, p.protocol), 'jev');
});

test('layaPreset：切回本机时必须把 protocol 显式改成 generic（否则形状发错）', () => {
  const p = layaPreset();
  assert.equal(p.mode, 'laya');
  assert.equal(p.baseUrl, 'http://127.0.0.1:8787');
  assert.equal(p.askPath, '/ask');
  assert.equal(p.model, '', '不能把 JEv 的模型别名发给本机');
  // 关键：适配器只懂数组式通用协议；若留着 'jev'，App 会把 map 形状发给它 → 形状对不上
  assert.equal(p.protocol, 'generic');
  assert.notEqual(p.protocol, 'jev');
  assert.equal(resolveProtocol(p.baseUrl, p.protocol), 'generic');
});

test('两个预设都是幂等的：重复点不会漂移', () => {
  assert.deepEqual(jevPreset(), jevPreset());
  assert.deepEqual(layaPreset(), layaPreset());
});

test('providerOptions：按当前配置高亮，且只有一项激活', () => {
  const jev = providerOptions({ ...DEFAULT_CONFIG, ...jevPreset() });
  assert.equal(jev.length, 2);
  assert.equal(jev.filter((o) => o.active).length, 1);
  assert.equal(jev.find((o) => o.id === 'jev').active, true);
  assert.equal(jev.find((o) => o.id === 'laya').active, false);

  const laya = providerOptions({ ...DEFAULT_CONFIG, ...layaPreset() });
  assert.equal(laya.filter((o) => o.active).length, 1);
  assert.equal(laya.find((o) => o.id === 'laya').active, true);
});

test('providerOptions：只认地址也够（用户手填 typesafe 地址时也应高亮云端）', () => {
  const opts = providerOptions({ baseUrl: 'https://api.typesafe.ai/v1', protocol: 'auto' });
  assert.equal(opts.find((o) => o.id === 'jev').active, true, '地址命中即算云端');
});

test('providerMismatch：选「本地」但地址指向云端 → 必须提示', () => {
  const msg = providerMismatch({ mode: 'laya', baseUrl: 'https://api.typesafe.ai/v1', protocol: 'auto' });
  assert.ok(msg.length > 0, '这正是用户遇到的"Laya 档也能连上 JEv"');
  assert.match(msg, /云端/);
});

test('providerMismatch：选「云端」但地址不是 TypeSafe → 也要提示', () => {
  const msg = providerMismatch({ mode: 'jev', baseUrl: 'http://127.0.0.1:8787', protocol: 'generic' });
  assert.ok(msg.length > 0);
  assert.match(msg, /TypeSafe/);
});

test('providerMismatch：一致时不打扰用户', () => {
  assert.equal(providerMismatch({ ...DEFAULT_CONFIG, ...jevPreset() }), '');
  assert.equal(providerMismatch({ ...DEFAULT_CONFIG, ...layaPreset() }), '');
});

test('两个预设 + 一致性检查构成闭环：点一下就消除矛盾', () => {
  // 用户先点了云端、又选了本地档位 → 矛盾
  const conflicted = { ...DEFAULT_CONFIG, ...jevPreset(), mode: 'laya' };
  assert.ok(providerMismatch(conflicted).length > 0, '先确认这是矛盾状态');
  // 点「Laya 本地」后必须完全一致
  const fixed = { ...conflicted, ...layaPreset() };
  assert.equal(providerMismatch(fixed), '');
  assert.equal(resolveProtocol(fixed.baseUrl, fixed.protocol), 'generic');
});

test('providerPreset：按 id 返回整套配置；未知 id 回落到本地（不把云端当地址）', () => {
  assert.deepEqual(providerPreset('jev'), jevPreset());
  assert.deepEqual(providerPreset('laya'), layaPreset());
  assert.deepEqual(providerPreset('whatever'), layaPreset());
});

test('isJevConfigured：协议或地址任一命中都算云端', () => {
  assert.equal(isJevConfigured({ protocol: 'jev' }), true);
  assert.equal(isJevConfigured({ baseUrl: 'https://api.typesafe.ai/v1' }), true);
  assert.equal(isJevConfigured({ protocol: 'generic', baseUrl: 'http://127.0.0.1:8787' }), false);
  assert.equal(isJevConfigured({}), false);
  // 伪装域名不算
  assert.equal(isJevConfigured({ baseUrl: 'https://evil-typesafe.ai/v1' }), false);
});
