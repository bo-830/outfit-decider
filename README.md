# 出门穿什么 · outfit-decider

> 出门前站在衣柜前不知道穿哪套？上传 1–4 套穿搭照，**先拿快速分数**，再决定要不要**深度分析**。
> 双引擎：System One 只出分（直觉级极快），System Two 出完整报告（多模态慢思考）。移动端优先。

**技术栈**：Expo SDK 57 · React Native 0.86.3 · React 19.2 · 纯 JS（无 TS 构建步骤）
**契约**：[`docs/SPEC.md`](docs/SPEC.md) 是唯一真源（协议 / 状态机 / 异常 / 隐私不变量 / 验收断言）
**操作手册**：[`docs/RUNBOOK.md`](docs/RUNBOOK.md)（真机扫码、Laya 局域网部署、故障复现）
**视觉规范**：[`docs/DESIGN.md`](docs/DESIGN.md)（设计令牌、11 组对比度实测值、动效参数）

---

## 1. 它解决什么问题

目标用户是**出门前有穿搭选择困难**的人。她真正要的不是"被分析"，而是**在 30 秒内定下来穿哪套**。所以：

- **默认走快的**：提交后立刻跑 System One，只回结构化分数（6 个维度，0–5 分，1 位小数），**不吐任何解释文本**——手机上没人愿意读一大段再自己做决定。
- **想深挖再深挖**：点「深度分析」才调多模态大模型，出三段式报告（综合排名 → 每套详细分析 → 整体建议），语气像靠谱闺蜜。
- **两套结论可以对照**：「双系统同屏对比」把「快速评分」与「深度分析」并排摆出来。

## 2. 双引擎怎么分工

| | System One（快速评分） | System Two（深度分析） |
|---|---|---|
| 路径 | 图 → **结构化纯文字描述** → 决策模型打分 | 原图 + state + question **直接**进多模态大模型 |
| 协议 | 严格 JEv/Laya 纯 JSON：`model` / `state` / `questions` → `model` / `answers` / `usage` | 同一通道，答案类型为 `text`，内容是 JSON 字符串 |
| 输出 | **只有分数**：overall / aesthetic / scene / figure / style / practical，各带 `confidence` | 三段式中文报告：排名 + 每套 5 维评分/优点/不足/建议 + 整体结论与替代搭配 |
| 速度 | 4 套并行（并发上限 4），单套失败不阻塞其余 | 一次调用全部套，慢但深 |
| 语气约束 | 严格客观，**禁止**评价/建议类文本；描述看不清写「未清晰显示」 | 亲切接地气；只基于图片可见内容与用户给的信息，**不臆测**身材/职业 |

两种引擎共用一套请求结构，因此**换引擎不用改代码**，只改设置页的模式与地址：

- **JEv 云端模式** → 用户自配 baseUrl + API Key（`Authorization: Bearer`）
- **Laya 本地模式** → 局域网内自己部署的决策模型，不带 Authorization

## 3. 三分钟跑起来

```powershell
cd C:\博830\vibecoding\outfit-decider

# ① 契约对端（假决策模型，监听 0.0.0.0:8787；真接自己的模型时不需要它）
node tools/mock-jev-server.mjs

# ② 纯逻辑单测 → 期望 tests 89 / pass 89 / fail 0
node --test "tests/**/*.test.js"

# ③ 全链路验收：起 mock → expo export web → headless Chrome 390×844 冒烟 → 截图 + 报告
node tools/verify.mjs
```

> ⚠️ **必须**用 glob 形式。Node v24 下 `node --test tests/` 会报 `Cannot find module ...\tests`
> （v24 把位置参数当测试文件执行，不再展开目录，与中文路径无关）。
> Windows 上 `npm` 被安全策略拦住，请用 `cmd /c "npm install"`。

**手机上看真机效果**：`cmd /c "npx expo start --lan"` → 手机 Expo Go 扫码（详见 [`docs/RUNBOOK.md`](docs/RUNBOOK.md#1-真机验收手机-expo-go-扫码推荐路径)）。

## 4. 目录结构

```
src/core/      纯逻辑层（禁止 import react/react-native/expo，故可被 node 直接测）
               protocol 协议构造与解析 · prompts 提示词与问题 · scoring 排序汇总
               state 上下文与校验 · flow 唯一状态机（纯 reducer）
src/engine/    api 双模式网络层（可注入 fetch）· vision 图→文 · scoreSystem System One
               deepSystem System Two · orchestrator 编排（并发 / 弱网 / 部分失败）
src/data/      options 枚举真源 · copy 全部中文文案
src/screens/   上传 / 结果 / 对比 / 历史 / 设置 / 引导
src/components/ 结果卡、刻度尺、星级、报告卡、横幅等
src/store/     history 仅存文字与分数 · secureKey API Key 本地存储
tests/         10 个测试文件 · 117 个用例 · 纯 node:test（无 jest）
tools/         mock-jev-server 契约对端 · laya-adapter 真实 Laya 适配器 · verify 验收门禁
               laya-{eval,choice-eval,order-eval,chain-eval} Laya 判断力评估 · make-fixtures 夹具生成
fixtures/      结构化描述与 deep 报告样例（黄金样例）
docs/          SPEC（唯一真源）/ DESIGN / RUNBOOK
```

## 5. 验收状态

| 门禁 | 命令 | 结果 |
|---|---|---|
| 纯逻辑单测 | `node --test "tests/**/*.test.js"` | **117 / 117 pass，0 fail** |
| 全链路验收 | `node tools/verify.mjs` | **exit 0，12 / 12 断言 + 2 / 2 附加门禁通过** |
| mock 契约自检 | `node tools/mock-selfcheck.mjs` | **30 / 30 pass**（不需要浏览器） |
| Laya 真实模型评估 | `node tools/laya-chain-eval.mjs` | 见下方「真实 Laya 的实测限制」 |
| 真机（Expo Go + 局域网） | `npx expo start --lan` | 见 RUNBOOK §1（需人工扫码） |

`node tools/verify.mjs` 覆盖的 12 条断言（逐条对应 SPEC §7）：mock 可达（含 `contractSpec` 防冒充）· System One 结构与 1 位小数 ·
**System One 零解释文本** · 结果页降序与 probe 一致 · System Two 三段式齐全 · 同屏对比（读容器自身文本，要求出现真实分数与理由）·
零 console 错误（故障注入产生的网络日志单独计数、不隐藏）· **隐私（storage / probe / 报告三处无图片、无 Key 明文，`leakPoints=[]`）** ·
异常横幅（走**真实 UI 路径**：设置页填 `test-auth-fail` / `test-timeout`）· 历史仅文字与分数 · 截图产物 · 报告自检。

两条附加门禁（不通过即 exit 1，防的是产品级矛盾）：
- **`engine-agreement`**：同一屏里 System One 的第 1 名必须 === 深度报告的 `conclusion.pick` === 深度排名第 1。
  （这条是补出来的：早期版本左栏说「第 4 套第一」、右栏说「第 4 套最差、选第 2 套」，详见 `docs/RUNBOOK.md` 的说明。）
- **`score-coherence`**：每套的综合分必须与它自己的 5 个维度分自洽（按 `lookId` 配对，与排名顺序无关）。

**门禁能红**：做过 5 次缺陷注入（分数丢 1 位小数、描述里混入 `base64`、逆序返回排名、改文案、绕过 sanitizer 写图片字段），
每次都让 `verify.mjs` 变红并 `exit 1`，回滚后恢复全绿。只会在顺境下变绿的门禁等于没有门禁。

## 6. 隐私边界（硬约束）

1. **原图只进内存**，看完即弃；不写盘、不入库、不进历史。历史记录只有文字描述与分数。
2. **API Key 只在你的设备上**：原生走系统钥匙串；web 端无安全存储可用，降级为本地明文并**在界面上明确提示**。
   Key 不出现在代码、日志、验证报告、异常文案或调试探针里（有断言）。
3. **不向第三方上报**：除你在设置页配置的 baseUrl 之外，App 不发任何出网请求（无埋点、无遥测）。
4. Laya 本地模式的数据交互只发生在你的局域网内。

## 8. 真实 Laya 的实测限制（重要，别跳过）

本机已装好真实的 Laya 决策模型（PyPI `laya` 0.3.27，部署在 `..\laya-service\`），
`laya.serve` 自称实现的正是 **TypeSafe Jev `/v1/systemone`** 协议 —— 需求里的 JEv 与 Laya 是同一套协议的两个面。

**基础设施层面全部通过**：协议正确、确定性（同输入同输出）、离线、约 1s 往返、`answer_confidence` 语义正确。

**但它的判断力实测不合格。** 用 App 的真实请求形状（经 `tools/laya-adapter.mjs`）测「明显得体」vs「明显荒谬」
两套穿搭在正式面试场景下的分数差（`node tools/laya-chain-eval.mjs`）：

| 维度 | 得体 | 荒谬（卡通卫衣+运动短裤+拖鞋+游泳帽） | 差值 |
|---|---|---|---|
| overall_score | 1.90 | 1.50 | **+0.40 偏弱** |
| scene_score | 3.40 | 3.60 | **−0.20 方向错** |
| figure_score | 3.30 | 3.30 | **0.00 无差异** |

平均 `answer_confidence` 只有 0.40 —— 模型自己也不确定。
另外三组评估（`laya-eval` / `laya-choice-eval` / `laya-order-eval`）显示：档位文案微调能让 overall 从 3.58 摆到 2.75；
三选一里重复选到同一个位置 4/4；同档次之间的两两比较**不传递**。

**结论**：Laya 适合当**基础设施**（确定性、可离线、可拒绝"都不合适"——这一条它 0.98 置信度敢说），
**不适合当"哪套最好"的权威排序依据**。它是在客服/工单类决策上训练的通用决策模型，
不是时尚评审模型；官方微调手册也承认预训练检查点在自建领域上只有 0.362 准确率。
要可信的穿搭判断，用 System Two 那条多模态大模型的路。详见 `..\laya-service\README.md` §4。

---

## 9. mock 的诚实声明

`tools/mock-jev-server.mjs` 是**测试替身**：分数由 `lookId + state` 的 FNV-1a 哈希按维度生成，**不代表任何真实穿搭评价**，
也不会真的"看懂"照片（描述文案读自 `fixtures/descriptions/*.json`）。

它的设计目标有三个，缺一个都会让门禁失去意义：
1. **包住 SPEC §1.3 的线格式**：score 强制序列化成 1 位小数（`3.0` 而不是 `3`）。
2. **分数自洽**：`overall_score` 由 5 个维度加权聚合而来（选了场合时 `scene_score` 权重最高），
   所以不会出现「综合 5.0 / 美观 2.8」这种自相矛盾的展示。
3. **两个引擎同源**：deep 报告的排名、星级、理由**全部由同一套确定性分数派生**，
   因此深度分析的第 1 名恒等于 System One 的第 1 名。两个引擎用的是结构不同的 `state` 文本，
   所以 mock 先把两种形状投影到同一个规范上下文再哈希——否则同一套会算出两个分数，结论必然打架。

另外还有 6 种故障注入（401 / 5xx / 非 JSON / 超时 / 空内容 / 部分失败）用于驱动异常链路。

换个 state 分数就会变，这是设计如此，不是 bug。**要接真实模型时，把 `tools/mock-jev-server.mjs` 当成参考实现读**：
它演示了本契约要求的请求/响应形状与字段。
