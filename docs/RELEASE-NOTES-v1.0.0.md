## 出门穿什么 · Outfit Decider v1.0.0

出门前站在衣柜前挑不定穿哪套 —— 拍 **1–4 套**衣服，选好场合 / 天气 / 风格，App 给出排名与理由。

*Snap 1–4 outfits, pick the occasion / weather / style, and get a ranking with reasons. UI is in Chinese.*

---

## ⚠️ 装上后第一件事：去设置页填一个地址

**默认地址是空的，不填就用不了。** 这是刻意的 —— 以前内置 `http://127.0.0.1:8787`，但那对真机是**错的地址**
（`127.0.0.1` 指手机自己），而且电脑的局域网 IP 还会随路由器变化。内置一个"看起来对"的地址只会误导。

```
设置 → 用哪家的模型打分 →（三选一，见下）
```

不填的话，跑分时会明确报「连不上决策模型地址」，而不是给出一堆错误分数。

*The default endpoint is intentionally empty. A baked-in `127.0.0.1` points at the phone itself on real hardware.*

---

## 三条接模型的路（任选一条）

### 路线 A · 中转服务（最省事，适合给不折腾的人用）

把 `relay/relay-server.mjs` 部署到任意一台能上网的主机。**中转自己持有上游 Key**，
App 只填「地址 + 一个口令」—— 不用把两把 Key 分发给每个用户。

```bash
APP_TOKEN=<你定的口令> \
DECISION_BASE_URL=https://api.typesafe.ai DECISION_MODEL=jev-latest DECISION_API_KEY=<Key> \
VISION_BASE_URL=https://api.deepseek.com/v1 VISION_MODEL=deepseek-flash VISION_API_KEY=<Key> \
node relay/relay-server.mjs
```

App 设置页 →「或者：用中转服务」→ 填地址与口令 → 点「测试中转」。
部署方式（Docker / Nginx / 托管平台）见 [`relay/DEPLOY.md`](https://github.com/bo-830/outfit-decider/blob/main/relay/DEPLOY.md)。

### 路线 B · 直连 TypeSafe JEv（不需要电脑）

设置页点「JEv 云端」一键填好，再填你自己的 [TypeSafe API Key](https://console.typesafe.ai/keys)。

> **但你还必须另外配一个"能看图的模型"。** JEv 官方文档原话是 *No text generation*
> （只答 choice/score/noul），而快速评分的第一步是「图片 → 文字描述」，这一环 JEv 做不了。
> 设置页「能看图的模型」填一个 OpenAI 兼容端点（如 `https://api.deepseek.com/v1` + `deepseek-flash`）。
> 不配会明确报错，不会静默出错分。

### 路线 C · 自建 Laya 本地引擎（实验性）

[Laya](https://github.com/NandhaKishorM/laya) 是开源的**非自回归 System 1 决策引擎**（Apache 2.0，可完全自托管）：
一次前向传播回答类型化问题，**不生成文本**，所以既没有解析、也没有幻觉。

四步：装 `laya[serve]` → 起 HTTP 服务（`:8000`）→ 起协议适配器 `node tools/laya-adapter.mjs`（`:8787`）
→ App 设置页点「Laya 本地」并填电脑的**局域网 IP**。

完整步骤（含环境变量表、排查表）见 [README §7](https://github.com/bo-830/outfit-decider#7-laya-本地引擎配置实验性)。

> **但请先想清楚要不要跑它。** 我们自己的实测：Laya 单独排序方向正确率 **2/4**（接近掷硬币）；
> `laya_review`（本地打分 + 多模态纠正）**4/4**，但那个收益来自**多模态纠正**，
> 代价是你得常驻一台电脑。**所以 Laya 是可选实验档，不是必经环节** —— 嫌麻烦用 A 或 B 就够了。

---

## 隐私（硬约束，不是宣传语）

| 承诺 | 落地方式 |
|---|---|
| 原图**只进内存**，看完即弃 | base64 只存在内存；不写盘、不入库、不进历史 |
| 历史只存**文字与分数** | 无图片字段，有测试断言盯着 |
| API Key / 口令**只存本机** | 原生存系统钥匙串（SecureStore）；web 降级明文并**在界面上明确提示** |
| **无埋点、无遥测** | 除你配置的地址外，App 不发任何出网请求 |
| System One **零解释文本** | 只回 JSON 分数，不生成评价或建议文案 |

---

## 两个引擎

| | System One · 快速评分 | System Two · 深度分析 |
|---|---|---|
| 输出 | 6 个维度分数，**只有数字** | 三段式中文报告（排名 / 逐套维度 / 结论） |
| 速度 | 秒级 | 15–37 秒 |
| 维度 | `overall` `aesthetic` `scene` `figure` `style` `practical`（0–5，一位小数） | 星级 + 理由 |

「两个都要」模式下**快速排名先出来**，深度报告在后台补 —— 不用对着进度页干等 20–40 秒。
深度分析失败**也不会顶掉你已经看到的排名**。

---

## 下载校验

| | |
|---|---|
| 文件 | `outfit-decider-1.0.1.apk` |
| 大小 | 67.05 MB (70,305,028 字节) |
| SHA-256 | `4a2ea3d571c02ba129be2cc11c3d972398e47ea3c14913da3570ad87bad8cfa8` |

```bash
# 校验下载是否完整
sha256sum outfit-decider-1.0.1.apk
# Windows PowerShell:
Get-FileHash .\outfit-decider-1.0.1.apk -Algorithm SHA256
```

---

## 技术信息

| | |
|---|---|
| 包名 | `com.outfitdecider.app` |
| versionCode / versionName | `1` / `1.0.0` |
| minSdk / targetSdk | `24` (Android 7.0) / `36` |
| 签名 | APK Signature Scheme **v2**（`apksigner verify` 通过） |
| 构建方式 | EAS Build `preview` profile（`buildType: apk`），Expo SDK 57 / React Native 0.86 |
| 权限 | `CAMERA` `INTERNET` `READ_MEDIA_IMAGES` `READ_EXTERNAL_STORAGE`（+ 若干库自带：`VIBRATE` `USE_BIOMETRIC` 等） |

> **本版本刻意不含 `RECORD_AUDIO`。** 这个 App 只选照片、从不录音；权限是 `expo-image-picker`
> 默认加的（它为录视频准备），已通过 `microphonePermission: false` 移除，并用 `aapt2 dump badging`
> 核对过实际产物。

---

## 已知限制（先说清楚）

- **首次必须配地址**（见上），不做开箱即用。
- **Laya 档位是实验性的**，且需要一台电脑常驻。
- **中转服务没有限流 / 配额**：口令泄漏 = 上游额度被白嫖。生产请在反向代理加限流。
- **直连 JEv 仍需另配视觉模型**（JEv 不生成文本）。
- **Web 预览下直连 `api.typesafe.ai` 会被 CORS 拦**（移动端 RN 的 fetch 不执行 CORS，不受影响）。
- 深度分析 15–37 秒；已做渐进结果，但等待本身存在。
- 本轮两个 APK（1.0.0 与 1.0.1）versionCode 都是 `1` —— 因为当时 `preview` profile 没开
  `autoIncrement`。**已修**：后续构建会自动递增，不会再撞号。

---

## 出处

源码、规格与使用手册：**https://github.com/bo-830/outfit-decider**

- [`docs/SPEC.md`](https://github.com/bo-830/outfit-decider/blob/main/docs/SPEC.md) — 协议 / 状态机 / 异常 / 隐私不变量（唯一真源）
- [`docs/RUNBOOK.md`](https://github.com/bo-830/outfit-decider/blob/main/docs/RUNBOOK.md) — 真机扫码、Laya 部署、故障复现
- [`relay/DEPLOY.md`](https://github.com/bo-830/outfit-decider/blob/main/relay/DEPLOY.md) — 中转服务部署

第三方：[TypeSafe JEv](https://docs.typesafe.ai)（商业服务）、[Laya](https://github.com/NandhaKishorM/laya)（Apache 2.0）。

---

*First installable Android build. Everything above is in Chinese; the short version: install the APK, then
open Settings and point it at a model — see the README for the three options. Photos never leave memory,
keys never leave your device.*
