# SPEC · 出门穿什么（outfit-decider）唯一真源

> 本文件是并行开发的**唯一契约**。任何实现前必须先读本文件；实现与本文件冲突时，以本文件的签名为准；
> 需要改契约时由 Lead 改本文件并提交，不得各自改代码后不回写契约。

版本：v1.6（v1 = Phase 0 冻结；v1.1 §2.1 三个设置页 testID；v1.2 §7.0 门禁命令形式；
v1.3 §3.7 describe 必须带图、§2.1 `ranked[].scores`；v1.4 §5.1 重试口径与时间预期；
v1.5 §3.9b 多模态纠正、§3.9c 三档引擎模式；v1.6 §3.11b 批处理打分、§3.11c 设置页配置顺序；
v1.7 §3.13b 用户自选 System One / System Two） · 适用范围：`src/core/**`、`src/data/**`、`src/engine/**`、`src/store/**`、
`src/ui/theme.js`、`src/components/**`、`src/screens/**`、`App.jsx`、`tools/**`、`tests/**`

---

## 0. 术语

| 术语 | 含义 |
|---|---|
| **look** | 一套穿搭（= 用户上传的一张图），最多 4 套，`lookId ∈ {look1..look4}` |
| **state** | 用户上下文：场合 / 天气 / 风格偏好（可多选）+ 自由补充文本 |
| **question** | 用户问题：内置 4 条一键问题 + 自定义输入 |
| **System One** | 快速决策：图 → 结构化文字 → 决策模型打分 → **纯 JSON 分数**，无任何解释文本 |
| **System Two** | 深度推理：原图 + state + question 直接进多模态大模型 → 三段式中文报告 |
| **JEv 模式** | 云端模式：用户自配 baseUrl + API Key 的 TypeSafe API |
| **Laya 模式** | 本地模式：用户局域网内自己部署的决策模型（同一套 JSON 契约） |

---

## 1. 数据模型

### 1.1 输入

```js
/** @typedef {'look1'|'look2'|'look3'|'look4'} LookId */

// 图片只在内存存在，绝不落盘
/** @typedef {{
 *   lookId: LookId,
 *   mime: string,          // 'image/jpeg' | 'image/png' | 'image/webp'
 *   base64: string,        // 纯 base64（不带 data: 前缀）
 *   width: number, height: number
 * }} ImageArtifact */
// 派生：toDataUri(artifact) === `data:${mime};base64,${base64}`

/** @typedef {{
 *   occasion: OccasionId[],   // 0..6 个
 *   weather: WeatherId[],     // 0..5 个
 *   style: StyleId[],         // 0..4 个
 *   note: string              // 自由补充，可为空字符串，trim 后长度 ≤ 200
 * }} UserState */

/** @typedef {{
 *   builtinId: BuiltinQuestionId | null,  // 命中内置问题时非空
 *   text: string                          // 完整问题文本；命中内置问题时 = 该条内置文案
 * }} UserQuestion */
```

### 1.2 枚举（唯一真源，`src/data/options.js` 必须与此逐字一致）

```js
export const OCCASIONS = [
  { id: 'commute',    label: '通勤上班' },
  { id: 'date',       label: '约会见面' },
  { id: 'friends',    label: '闺蜜聚餐' },
  { id: 'interview',  label: '正式面试' },
  { id: 'shopping',   label: '逛街出游' },
  { id: 'sport',      label: '运动健身' },
];

export const WEATHERS = [
  { id: 'hot',    label: '炎热' },
  { id: 'cool',   label: '凉爽' },
  { id: 'cold',   label: '寒冷' },
  { id: 'rainy',  label: '雨天' },
  { id: 'windy',  label: '大风' },
];

export const STYLES = [
  { id: 'minimal',  label: '简约干练' },
  { id: 'sweet',    label: '温柔甜美' },
  { id: 'cool',     label: '酷飒休闲' },
  { id: 'elegant',  label: '知性优雅' },
  { id: 'youthful', label: '元气少女' },
];

export const BUILTIN_QUESTIONS = [
  { id: 'best_for_occasion', label: '哪套最适合今天的场合？', text: '哪套最适合今天的场合？' },
  { id: 'slimmer',           label: '哪套更显瘦？',           text: '哪套更显瘦？' },
  { id: 'photogenic',        label: '哪套拍照更上镜？',       text: '哪套拍照更上镜？' },
  { id: 'too_casual',        label: '这套会不会太随意？',     text: '这套会不会太随意？' },
  { id: 'style_fit',         label: '哪套更符合我想要的风格？', text: '哪套更符合我想要的风格？' },
];
```

### 1.3 JEv / Laya 协议（**双方共用的唯一线上结构**）

请求体（`POST {baseUrl}{askPath}`，默认 `askPath = '/ask'`）：

```json
{
  "model": "string, 必填",
  "state": "string, 必填（见 §3.2 拼接规则）",
  "questions": [
    { "id": "string", "type": "score|text", "question": "string（含评分指令与 0-5 分级口径）" }
  ]
}
```

响应体：

```json
{
  "model": "string",
  "answers": [
    { "id": "string", "type": "score|text", "score": 4.5, "content": "string", "confidence": 0.86 }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

- `type: 'score'`：必须有 `score`，数值区间 `[0, 5]`，**保留 1 位小数**；`confidence` 数值区间 `[0,1]`，缺省填 `0.5`。
- `type: 'text'`：必须有 `content` 字符串；`score` 允许缺省。
- 未知 `id` 的答案忽略；缺失的答案 → 该答案标记 `missing`，不计入总分（见 §3.3）。
- 鉴权（仅 JEv 模式）：`Authorization: Bearer {apiKey}`；Laya 模式不带 `Authorization`。
- 健康检查：`GET {baseUrl}{healthPath}`（默认 `/health`），2xx 视为可达。

---

## 2. 屏幕与交互（移动端）

4 个 Tab（顶部横向可滚动），外加结果页为 Tab1 的推进态：

| id | 标题 | 内容 |
|---|---|---|
| `capture` | 上传 | 1–4 图选择/预览/删除 + state 三组 chips + 问题区 + 底部主 CTA「开始快速评分」 |
| `result` | 结果 | System One 排序卡片；每张卡下方「深度分析」入口；双系统同屏对比区 |
| `history` | 历史 | 仅文字描述与分数的记录列表，可删除单条 / 清空 |
| `settings` | 设置 | 引擎模式（JEv 云端 / Laya 本地）、baseUrl、askPath、healthPath、model、API Key、连接测试、隐私说明 |
| `help` | 引导 | Laya 局域网部署分步指引 + 连接测试指引 + 弱网说明（设置页内入口，非独立 Tab） |

**默认流程**：提交 → 立即跑 System One → 出分数排序；点某张卡「深度分析」→ 跑 System Two → 该套报告展开；
「双系统同屏对比」开关打开时，两栏并列并打标「快速评分」「深度分析」。

### 2.1 必须存在的 DOM/测试锚点（web 冒烟脚本依赖，不得改名）

| 锚点 | 位置 |
|---|---|
| `testID="tab-capture" / "tab-result" / "tab-history" / "tab-settings"` | 顶部 Tab |
| `testID="pick-images"` | 选图按钮 |
| `testID="look-item"`（每张图一个） | 已选图列表 |
| `testID="chip-occasion-{id}" / "chip-weather-{id}" / "chip-style-{id}"` | 状态 chips |
| `testID="state-note"` | 自由补充输入框 |
| `testID="chip-question-{id}"` | 内置问题 chips |
| `testID="question-input"` | 自定义问题输入框 |
| `testID="submit-quick"` | 主 CTA |
| `testID="result-card"`（每套一个，`data-rank` 属性为名次） | 结果卡片 |
| `testID="score-value"` / `testID="dim-row"` | 分数与维度行 |
| `testID="deep-run"` / `testID="deep-report"` | 深度分析按钮 / 报告 |
| `testID="compare-toggle"` / `testID="compare-view"` | 同屏对比开关 / 对比容器 |
| `testID="banner-error"` / `testID="banner-weaknet"` | 错误横幅 / 弱网横幅 |
| `testID="history-item"` / `testID="history-empty"` | 历史记录项 / 空态 |
| `testID="engine-mode-jev"` / `"engine-mode-laya"` / `"btn-test-conn"` / `"test-conn-result"` | 设置页：模式切换 / 测试连接 / 结果 |
| `testID="engine-model"` / `"engine-baseurl"` / `"engine-apikey"` | 设置页：模型名 / baseUrl / API Key 输入框（v1.1 新增，供 verify.mjs 走真实 UI 路径驱动异常场景；model 必须可自由输入任意字符串，不得做白名单或下拉限定） |
| `testID="engine-mode-laya-only"` / `"engine-mode-laya-review"` / `"engine-mode-multimodal-only"` | 设置页：三档引擎模式切换（v1.5，§3.9c） |
| `testID="engine-vision-baseurl"` / `"engine-vision-model"` / `"engine-vision-key"` | 设置页：多模态端点（describe 与纠正用），与决策模型分开配置 |
| `testID="vision-server-side"` / `"vision-readiness"` | 设置页（v1.6）：视觉模型已配在服务端 / 就绪状态标记 |
| `testID="decision-gate-hint"` / `"decision-gate-jump"` | 设置页（v1.6）：决策模型的配置闸门提示与跳转（视觉未就绪时禁用决策组） |
| `testID="system-mode-quick"` / `"system-mode-deep"` / `"system-mode-both"` | 选图页（v1.7）：用户自选跑 System One / System Two / 两个都要 |
| `testID="engine-badge"` | 结果页：本次结论来自哪一档引擎（文案见 §3.9c） |
| `testID="probe-json"` | 隐藏节点（`<Text>` 或 `<div>`），内容 = `window.__OD_PROBE__` 的 JSON 序列化，供冒烟脚本读取 |
| `window.__OD_PROBE__` | 运行状态探针：`{ ready, tab, looks, quick: {ranked: [{lookId, rank, overall, scores}]}, deep, errors: [], lastRequest: {...} | null, privacy: { imageInStorage: bool } }`。`ranked[].scores` 为 6 维分数（v1.3 补入契约，供冒烟脚本仅凭 probe 即可交叉校验；权威证据仍是线上响应 + DOM 的 6 行 `dim-row`） |

> 说明：`react-native-web` 会把 `testID` 渲染成 `data-testid`，冒烟脚本按 `[data-testid="..."]` 选择。
> `window.__OD_PROBE__` 由 `App.jsx` 在每次状态变化后同步（web 平台才挂载，原生忽略）。

---

## 3. 模块契约（函数签名冻结，实现必须逐字一致）

### 3.1 `src/core/protocol.js`

```js
export const SCORE_QUESTION_IDS = ['overall_score','aesthetic_score','scene_score','figure_score','style_score','practical_score'];
export const MAX_LOOKS = 4;
export const SCORE_DECIMALS = 1;

export function clampScore(n)                        // → 数字，四舍五入到 1 位小数，钳制到 [0,5]；NaN/非数值返回 null
export function toDataUri({ mime, base64 })          // → 'data:image/jpeg;base64,...'
export function buildRequest({ model, state, questions })    // → {model, state, questions}（严格字段顺序，浅拷贝）
export function buildScoreAnswers(answers)           // → { overall_score: {score, confidence}, ... } 缺失项为 null
export function rankLooks(rows)                      // → 排序后的新数组，见 §3.3
export function parseScoreAnswer(raw)                // → { id, score, confidence } | null（严格校验）
export function isScoreAnswerStrict(raw)             // → bool：raw 是否满足 §1.3 的 score 全部约束
```

### 3.2 `src/core/prompts.js`

```js
export const DESCRIBE_SYSTEM_PROMPT  // string：图片转文字的系统指令
export const DESCRIBE_USER_PROMPT    // string：图片转文字的用户指令（含 7 个描述维度）
export const DEEP_SYSTEM_PROMPT      // string：System Two 的系统指令（含三段式 JSON schema 与语气要求）
export const DEEP_USER_TEMPLATE      // string：含 {{STATE}} / {{QUESTION}} 占位符

export function buildDescribeQuestions(lookId)      // → [{id:`describe_${lookId}`, type:'text', question}] 长度 1
export function buildSyntheticStateText({ descriptions, userState, question })
// → string：见下方拼接规则
export function buildScoreQuestions({ userState, question })
// → [{id,type:'score',question} x 6]，**顺序恒为 SCORE_QUESTION_IDS 的顺序**
export function scoreRubric(questionId)             // → string：该维度的 0-5 分级口径（可被测试断言）
export function buildDeepUserText({ userState, question })   // → string：填充 DEEP_USER_TEMPLATE
export function relevantScoreDimensions({ builtinId, text }) // → string[]：内置问题→维度映射，见 §3.4
```

**`buildSyntheticStateText` 拼接规则（严格按此顺序，段间用 `\n\n`）**：

```
【穿搭一】
整体风格：…；上衣：…；下装：…；鞋履：…；配饰：…；身材视觉效果：…；其他细节：…

【穿搭二】(按需)

【我的场合】通勤上班、约会见面
【我的天气】凉爽
【我的风格偏好】简约干练
【补充说明】用户自由输入原文

【我的问题】用户完整问题文本
```

空组省略对应行；`note` 为空则省略「补充说明」段。多套时每套一段，序号用中文数字（一/二/三/四）。

### 3.3 `src/core/scoring.js`

```js
export function rankLooks(rows)
// 输入 [{lookId, scores:{overall_score:number|null,...}, rank?, ...}]
// 规则：overall_score 为 null 的排最后；否则按 overall_score 降序；同分按 lookId 升序（look1..look4）。
// 返回新数组，每项追加 rank（1-based）。
export function computeConfidence(scores, confidences)   // → 0..1，各维度置信度均值；空集 → 0
export function summarize(scores)                        // → { best: dimId, worst: dimId, avg: number }
export function meetsMinQuality(parsedAnswers)           // → bool：结构化描述非空且 ≥1 维度有分数
```

### 3.4 内置问题 → 评分维度映射（`relevantScoreDimensions`）

| 内置问题 | 维度 |
|---|---|
| `best_for_occasion` | `scene_score`, `practical_score` |
| `slimmer` | `figure_score` |
| `photogenic` | `aesthetic_score`, `figure_score` |
| `too_casual` | `scene_score`, `style_score` |
| `style_fit` | `style_score`, `aesthetic_score` |
| 自定义文本 | 按关键词命中：显瘦/瘦→figure；上镜/拍照/照片→aesthetic；场合/面试/正式/随意→scene；风格→style；实用/方便/舒适/走路→practical；未命中→全部 6 维 |
| 未选择问题 | 全部 6 维 |

**注意**：无论映射结果如何，`buildScoreQuestions` **恒返回 6 个问题**（§System One 规范要求）。
映射结果仅用于：① UI 高亮"与你问题最相关"的维度；② 排序主键仍是 `overall_score`。

### 3.5 `src/core/state.js`

```js
export function emptyUserState()                     // → {occasion:[],weather:[],style:[],note:''}
export function toggle(list, id)                     // → 新数组，选中则移除，未选则追加（保持枚举顺序，去重）
export function validateInput({ artifacts, state, question })
// → { ok: boolean, missing: string[], hints: string[], canRunQuick: boolean, canRunDeep: boolean }
// 规则：无图 → ok=false, missing 含 'images'，hint '先选 1-4 张穿搭照片吧'
//       occasion 与 question.text 同时为空 → ok=true 但 hints 提示补充场合或问题，不阻塞
//       >4 张图 → ok=false, hint '一次最多 4 套穿搭哦'
export function stateSummary(state)                  // → '通勤上班 · 凉爽 · 简约干练'（空组省略，用 ' · ' 连接）
```

### 3.6 `src/core/flow.js`（唯一状态机，纯 reducer）

```js
export const FLOW_PHASES = ['idle','describing','scoring','quick_done','deep_running','deep_done','error'];
export const initialFlowState = {
  phase: 'idle', artifacts: [], userState: emptyUserState(), question: {builtinId:null, text:''},
  descriptions: {}, quick: null, deep: null, error: null, weakNetwork: false, compareOpen: false,
};
export function flowReducer(state, action)           // → 新 state（不修改入参）
export function selectRankedLooks(state)             // → state.quick?.ranked ?? []
export function selectDeepFor(state, lookId)         // → 该套 deep 报告 | null
```

**action 类型**（全部必须实现，测试逐条覆盖）：

```
{type:'SET_ARTIFACTS', artifacts}      {type:'TOGGLE_STATE', group:'occasion'|'weather'|'style', id}
{type:'SET_NOTE', note}                {type:'SET_QUESTION', builtinId, text}
{type:'CLEAR_QUESTION'}                {type:'RUN_QUICK_START'}
{type:'SET_DESCRIPTIONS', descriptions} {type:'QUICK_DONE', ranked, usage, model}
{type:'QUICK_FAIL', error, lookId|null} {type:'RUN_DEEP_START'}
{type:'DEEP_DONE', report, lookId}      {type:'DEEP_FAIL', error, lookId}
{type:'SET_ERROR', error}               {type:'CLEAR_ERROR'}
{type:'SET_WEAK', flag}                 {type:'TOGGLE_COMPARE'}
{type:'RESET_RUN'}                      {type:'RESET_ALL'}
```

### 3.7 `src/engine/vision.js`

```js
export function makeVisionEngine({ api, model })     // → { describeLook({artifact, lookId, signal}): Promise<{lookId, text}> }
// 用 api.ask 发 {questions: buildDescribeQuestions(lookId), images: [{id: lookId, dataUri: toDataUri(artifact)}]}，
// state 传一个**非空的中性占位串**（避免对端把空串判成缺字段）；
// 返回值取 answers[0].content，trim 后为空 → 抛 {kind:'invalid_input'}
```

> **v1.2 修正（重要）**：`describe` **必须带上本套自己的那张图**。System One 第一步的产品定义就是
> 「调用多模态能力把照片转成结构化纯文字描述」，不带图在真实端点下模型看不到画面。
> 只带当前这一套（`images` 长度 1，`id === lookId`），不要一次把 4 张都传进去。
> `artifact` 缺 `mime`/`base64` 时退化为 `images: []`（对端仍可据 `question.id` 作答）。
> 因此「请求里有没有 `images`」**不能**再用来区分 describe 与 deep —— 两者都带图，
> 判据一律用 `questions[].id`（`describe_*` vs `deep_report`）。

### 3.8 `src/engine/scoreSystem.js`

```js
export function makeScoreSystem({ api, model })      // → { scoreLooks({artifacts, descriptions, userState, question, signal}): Promise<QuickResult> }
/** QuickResult = {
 *   model, usage, ranked: RankedLook[], byLook: Record<LookId, {scores, confidences}>,
 *   ids: LookId[]            // 参与评分的套
 * } */
/** RankedLook = {
 *   lookId, rank, overall: number|null,
 *   scores: {overall_score,aesthetic_score,scene_score,figure_score,style_score,practical_score}, // number|null
 *   confidences: {同键}, relevance: string[]   // relevantScoreDimensions 的输出
 * } */
// 4 套并行（并发上限 4），单套失败 → 该套 overall=null 且不阻塞其他套（partial fail 允许）
```

### 3.9 `src/engine/deepSystem.js`
```js
export function makeDeepSystem({ api, model })       // → { analyze({artifacts, userState, question, signal}): Promise<DeepReport> }
// 一次调用（多模态：图片经 §4.3 的 images 通道传入），answers[0].type==='text'，content 为 JSON 字符串
export function parseDeepReport(rawText)             // → DeepReport（解析失败抛 {kind:'parse'}）
export function deepReportSchema()                   // → 用于校验的字面量 schema 对象（测试用）
```

```js
/** DeepReport = {
 *   ranking: [{lookId, stars: number(0-5, 支持 .5), oneLineReason: string}],  // 按 stars 降序，长度=套数
 *   details: [{lookId, dimensions: [{name, stars}],   // 固定 5 维：场合适配度/美观度/身材友好度/风格统一度/实用舒适度
 *              pros: string[2..3], cons: string[1..2], suggestions: string[1..3]}],  // 顺序与 ranking 一致
 *   conclusion: { pick: LookId, reason: string, alternatives: string[1..2], tip: string}
 * } */
```

### 3.9b `src/engine/reviewSystem.js`（v1.5 新增 · 多模态纠正）

**为什么要有它**：实测本机真实 Laya（见 `..\laya-service\README.md` §4）对穿搭的**判断力不达标**——
「得体的面试穿搭」与「卡通卫衣+短裤+拖鞋+游泳帽」的综合分只差 0.4，且"场合适配度"方向是反的。
但 Laya 作为**基础设施**是合格的（确定性、协议正确、离线、约 1s）。所以保留它当 System One 的打分引擎，
再用一个**能看原图的**多模态模型去纠正它的分数。

**关键设计约束**：纠正模型**必须直接看原图**，不能只看 `describe` 产出的文字描述——
那份描述就是 Laya 打分的输入，只看文字等于继承同一个视觉来源，无法纠正视觉层面的误判。

```js
export function makeReviewSystem({ api, model })     // → { review({artifacts, descriptions, userState, question, base, signal}): Promise<QuickResult> }
// 一次调用（多模态：全部图片经 §4.3 images 通道传入），answers[0].type==='text'，content 为 JSON 字符串
export function parseReviewScores(rawText, lookIds)  // → { [lookId]: {overall_score,...} }（解析失败抛 {kind:'parse'}）
export function buildReviewPrompt({ userState, question, base, lookIds })  // → string（纠正指令 + Laya 原始分）
export function hasScoreDelta(base, reviewed, lookId)     // → bool：纠正是否真的改变了这套的分数
```

**纠正输出契约（`content` 必须是这个 JSON，禁止任何解释性文本）**：

```json
{ "scores": [ { "lookId": "look1",
               "overall_score": 2.1, "aesthetic_score": 3.4, "scene_score": 1.8,
               "figure_score": 3.0, "style_score": 2.6, "practical_score": 3.9 } ] }
```

- 规则：6 个维度全都必须给；0–5、保留 1 位小数；`lookId` 必须属于本次上传的套。
- **允许推翻 Laya**：提示词明确要求"判断依据只能是你自己看到的画面"，
  Laya 的分数只作为参考，不得为了让两者一致而妥协。
- 返回类型仍是 `QuickResult`（§3.8 同构），因此排序、UI、历史、对比全部复用，不新增展示路径。

### 3.9c 三档引擎模式（v1.5 新增）

`DEFAULT_CONFIG.engineMode`：

| 值 | 流程 | 何时用 |
|---|---|---|
| `laya_only` | 视觉模型 describe → Laya 打分 | 纯本地、不花钱；用于验证本地模型/离线场景 |
| `laya_review`（**默认**） | describe → Laya 打分 → 多模态纠正 | 默认路径：结果最准，仍保留 Laya 在环 |
| `multimodal_only` | 视觉模型 describe（仅展示用）→ 多模态直接打分，**不经过 Laya** | 对比两种判断、或本地模型不可用时 |

- 三档都产出**同一个** `QuickResult` 形状，UI 与门禁不需要分支。
- 结果页必须标注本次用的是哪一档（`testID="engine-badge"`），
  因为同一套图在三档下可能给出不同分数，用户有权知道结论来自谁。
- `laya_review` 下若纠正调用失败 → **回退**到 Laya 原始分，并置 `reviewFailed=true`
  （不能让一次网络故障把用户已有结果清空）；`SET_WEAK` 与错误横幅照旧。
- `reviewedAt` 与 `reviewModel` 记入 `QuickResult`，供历史与探针取证。

### 3.10 `src/engine/api.js`

```js
export const DEFAULT_CONFIG = {
  mode: 'jev',                        // 'jev' | 'laya'（决策模型连接方式）
  engineMode: 'laya_review',          // 'laya_only' | 'laya_review' | 'multimodal_only'（§3.9c）
  visionBaseUrl: '',                  // 可选：OpenAI 兼容多模态端点（describe 与纠正用）
  visionModel: '',                    // 可选：多模态模型名
  baseUrl: 'http://127.0.0.1:8787',
  askPath: '/ask', healthPath: '/health',
  model: 'outfit-judge-v1',
  apiKey: '',                         // 仅 JEv
  timeoutMs: 45000, quickTimeoutMs: 20000,
};
export function normalizeBaseUrl(url)   // → 去尾部 '/'；无 scheme 时补 'http://'；同时兼容 192.168.1.5:8787 这类输入
export function makeApi({ config, fetchImpl = globalThis.fetch })  // → Api
/** Api = {
 *   ask({state, questions, images, timeoutMs, signal, model}): Promise<{model, answers, usage}>,
 *   health({timeoutMs, signal}): Promise<{ok: boolean, ms: number, detail: string}>,
 *   vision({state, questions, images, timeoutMs, signal}): Promise<{model, answers, usage}>   // v1.5：走 visionBaseUrl
 * } */
export function classifyError(err)   // → {kind, message, action, retryable}
export function redactConfig(config) // → 去掉 apiKey 的副本（写日志/报告前必须过这一层）
```

> **多模态端点走独立通道**：`visionBaseUrl` / `visionModel` 与决策模型的 `baseUrl` **分开配置**，
> 因为「谁看图」和「谁打分」在 `laya_review` 下是**两个不同的服务**。
> 未配置 `visionBaseUrl` 时，`describe` 与纠正都不可用 → 该请求按 §5.1 报错并给出配置指引，
> **不静默降级成假分数**。

- `images` 通道：`images: [{id:'look1', dataUri}]`。**System One 的 describe 与 System Two 都会使用**（v1.2 修正，见 §3.7）：
  describe 只带当前一套（长度 1），System Two 带全部套；JEv/Laya 双方都接受该字段（mock 亦支持）。
- 错误 `kind` 枚举与中文文案见 §5.1。
- **API Key 绝不出现在异常 message、日志、`window.__OD_PROBE__` 和验证报告中**。

### 3.11 `src/engine/orchestrator.js`

```js
export function makeOrchestrator({ api, model, concurrency = 4 })   // → Orchestrator
/** Orchestrator = {
 *   runQuick({artifacts, userState, question, onProgress, signal}): Promise<QuickResult>,
 *   runDeep({artifacts, userState, question, onProgress, signal}): Promise<DeepReport>,
 *   runBoth(...): Promise<{quick, deep}>       // 供同屏对比一次跑完
 * } */
// runQuick 内部：先并行 describe 全部套（onProgress({stage:'describing', done, total})），
// 再调 scoreSystem（onProgress({stage:'scoring', done, total})）。
// 全部套都无法识别 → 抛 {kind:'invalid_input', message: copy.UNRECOGNIZABLE}（§5.1 文案）
```

### 3.11b 批处理打分（v1.6 新增）

**动机**：`scoreSystem` 原本对每套发一次 `/ask`（4 套 = 4 次往返）。Laya 的
`/v1/systemone/batch` 能在**单次 forward pass** 内 collate 多行，因此值得合并。

```js
// src/engine/api.js
api.askBatch({ looks: [{ lookId, state, questions }], timeoutMs?, signal? })
//   → POST {baseUrl}{askPath}/batch   body {model, looks:[{lookId, state, questions}]}
//   → {model, looks:[{lookId, model, answers, usage}], usage}
```

规则：
- **一次请求覆盖全部可打分的套**；`api.askBatch` 不存在或整批失败时**自动回退逐条并行**（并发上限 4）。
  回退是必需的：对端可能不支持批处理（旧 mock、第三方实现），一处不兼容不该拖垮整轮评分。
- 探测代价：对端没有该路由时会先吃一个 404（实测 1 次额外往返）。这是自知成本，不是缺陷。
- 只有 ≥2 套可打分时才批处理（1 套时批处理没有意义）。
- **批处理不得改变结论**：Laya 保证 `results` 与 `states` 同序；适配器按索引回填 `lookId`，
  且**校验条数**——条数不符直接报错，绝不把结果错配到别的穿上（错配比失败更糟）。
- 描述为空的套不进入批处理（不发请求，直接判 `invalid_input`）。

**实测取舍（必须如实记录）**：本机 CPU 上串行 3745ms vs 批处理 3508ms，**加速比仅 1.07x**
（`tools/laya-batch-eval.mjs`）。瓶颈是 Laya 的 CPU 算力，不是 HTTP 往返。
批处理**不改变分数**（4/4 逐条一致），所以在 GPU 或多并发下才是净收益。
**在代码注释与 README 里都不要把它说成"大幅提速"。**

### 3.11c 设置页的配置顺序（v1.6 新增）

**先配「能看图的模型」，再配「决策模型」**。理由：`laya_review` 架构下没有视觉模型就没有纠正，
用户拿到的正是实测判断力不合格的本地分（见 §3.9b）。所以视觉组在决策组之前，
且视觉未就绪时**决策组整体禁用**。

**闸门按档位条件化**（否则 `laya_only` 会被自己的提示打脸——那一档会显示「当前档位用不到这一组」，
却又把决策组锁死，等于让纯本地模式无法使用）：

```
needsVision    = engineMode !== 'laya_only'     // laya_review（默认）与 multimodal_only 都为 true
decisionLocked = needsVision && !visionReady
```

- `laya_only` → 不锁决策组；从 `laya_only` 切回 `laya_review` → **立刻重新上锁**（闸门是活的）。
- 「已就绪」判据：`visionBaseUrl` 与 `visionModel` 均非空（trim 后）**或** `visionServerSide === true`。
- `visionServerSide`（`DEFAULT_CONFIG`）用于**直连本机 Laya 适配器**的场景：
  适配器已用自己的 `.env.local` 在服务端配好视觉模型，用户不应被迫在手机里重复填 Key。
  该开关只影响设置页闸门，**不改变运行时行为**；若勾错而服务端其实没配，
  退化路径仍是既有的 `vision_unconfigured` 回退 + 结果页「纠正未生效」旁注。
  **因此该复选框旁边必须写明这个信号**（"勾选后若服务端其实没配置，结果页会提示纠正未生效"），
  让用户知道勾错了会看到什么，而不是要求额外做一次服务端探测。
- **必须留一条自救路径**：视觉端点本身出问题时（Key 错、服务不通、模型下线），
  用户仍要能配一个可用的决策模型，否则 App 变砖。所以禁用之外必须有**显式临时解锁**：
  `decisionUnlocked`（`DEFAULT_CONFIG`）→ `decisionLocked = needsVision && !visionReady && !decisionUnlocked`。
  - 默认仍按顺序（未配视觉 → 决策组不可编辑，视觉上明确降级）。
  - `decision-gate-unlock`「仍然配置决策模型」→ 写 `decisionUnlocked: true` → 立即解锁且**能保存 Key**。
  - 解锁后 `decision-gate-hint` 换成弱说明 `decision-gate-unlocked-note`，并给 `decision-gate-relock`「恢复按顺序配置」。
  - 视觉就绪（含 `visionServerSide`）时 `decisionUnlocked` 自动失效（无需手动清）。
  - 这条不是为了绕过顺序，而是为了让"视觉先行"不变成单点故障。
- 新增锚点：`decision-gate-hint`、`decision-gate-jump`、`vision-server-side`、`vision-readiness`、
  `decision-gate-unlock`、`decision-gate-relock`、`decision-gate-unlocked-note`。

### 3.12 `src/store/history.js`

```js
export const HISTORY_KEY = 'od.history.v1';
export const HISTORY_LIMIT = 30;
export function appendHistory(record, storage)   // → Promise<Record[]>；超限截断为最新 30 条
export function loadHistory(storage)             // → Promise<Record[]>
export function removeHistory(id, storage)
export function clearHistory(storage)
/** Record = {
 *   id: string,              // `${tsAt}-${random}`
 *   tsAt: number,            // Date.now()
 *   stateSummary: string,
 *   question: string,
 *   looks: [{lookId, description, scores, rank}]   // **只有文字与分数，绝不含 base64/uri/图片字段**
 *   deepSummary: {pick: LookId, oneLineReasons: string[]} | null
 * } */
// storage 抽象：{ getItem(k), setItem(k,v), removeItem(k) }；损坏数据 → 返回 []，不得抛错
```

### 3.13 `src/store/secureKey.js`

```js
export const KEY_STORAGE = 'od.apikey.v1';
export function saveApiKey(key)     // native → expo-secure-store；web → AsyncStorage 并置 secure:false
export function loadApiKey()        // → Promise<{key, secure: boolean}>
export function clearApiKey()
export function isSecureStorageAvailable()   // → Promise<bool>
```

### 3.13b 用户自选跑哪个系统（v1.7 新增）

**两个系统是并列的，不是串行流程。** System One 出 6 维分数，System Two 出三段式深度报告，
且深度分析**自带排序**、不依赖快速分，因此必须允许单独跑。用户明确提出：
「system one 和 system two 应该让用户自己选择，而不是先 system one 再 system two」。

契约：

```js
// src/core/flow.js（纯逻辑，可单测）
export const SYSTEM_MODES = ['quick', 'deep', 'both'];
export function normalizeSystemMode(value);   // -> 'quick' | 'deep' | 'both'，非法值回退 'quick'
```

- 选图页 CTA 上方给三档选择：`system-mode-quick` / `system-mode-deep` / `system-mode-both`。
- **默认 `'deep'`**（v1.7 修订，用户 2026-10-06 决定）：用户要的是"看结论"，深度分析自带排序
  与理由，打开即可用；快速评分仍是一档之遥。这**取代**了最早"默认优先 System One"的口径。
- `normalizeSystemMode` 的非法值回退仍是 **`'quick'`**（那是"值坏了"的兜底，不是界面默认值）：
  两者语义不同——界面默认是产品选择，兜底是"宁可跑最便宜的也别什么都不跑"。
- 分派规则：
  - `quick` → 只跑 System One（`submit-quick` 的 testID 与主文案保持不变，验收依赖它）；
  - `deep` → 只跑 System Two，**对所有已选图片跑一次**（`startDeep(null)`），报告分发到每套；
    不需要先有快速分；
  - `both` → 先 System One，**成功后**再自动接 System Two。
- 结果页必须同时支持"只有 quick"和"只有 deep"两种状态：deep-only 时用
  `selectResultLooks`（§3.6）回落到深度报告自己的星级，并如实标注来源；此时不渲染"双系统对比"。
- **`deep` 必须有图**：无图时 CTA 禁用，提示要说清"深度分析需要先选照片"（不能用通用话术）。
- `deep` 档的加载文案必须与 `quick` 区分（深度分析实测约 18–25 秒，比快速慢一个量级）。
- `normalizeSystemMode` 非法值回退 `'quick'`：宁可跑最便宜的那个，也不要因为一个错值什么都不跑。

### 3.14 `src/ui/theme.js`（视觉令牌，`docs/DESIGN.md` 与之逐字对应）

```js
export const colors = { bg, surface, surfaceAlt, border, primary, primarySoft, accent,
                        text, textDim, success, warn, danger, starOn, starOff };
export const space = { xs:4, sm:8, md:12, lg:16, xl:24 };  export const radius = { sm:8, md:14, lg:20, pill:999 };
export const font = { h1, h2, body, small, tiny, score };   // 字号对象
export const motion = { fast:150, base:250, slow:400 };
```

---

## 4. 三条不可违背的数据流

### 4.1 隐私不变量（有对应测试）
1. `ImageArtifact` 只存在于 `flowReducer.artifacts` 与组件 `useRef`；**不写入 AsyncStorage、不写文件、不进历史**。
2. 运行结束（`QUICK_DONE` / `DEEP_DONE` / `RESET_RUN`）后，`descriptions` 保留，`artifacts` 由 `RESET_RUN` 清空；
   App 失焦（`AppState` 非 active）时清空图片引用。
   **例外（v1.7 修订，必须）**：**"正在挑选照片"期间不得清空**。
   打开系统相册会让 App 进入 background（相册是另一个 Activity），那**不是**用户离开了 App；
   若照清不误，相册返回后追加逻辑会读到 0 张、把新图当成整份列表写入 ——
   表现就是"加第二套会把第一套顶掉"，且**第一次选图看不出问题**（本来就从 0 开始）。
   实现为 `pickingRef`：仅在 `launchImageLibraryAsync` 的 try/finally 窗口内豁免，
   其余任何非 active 一律照常清空，隐私不变量不被削弱。
   该行为由门禁 #14 覆盖（`__OD_SET_PICKING__` / `__OD_SIMULATE_BLUR__` 测试缝：
   窗口内失焦 → 保留；窗口外失焦 → 清空）。
3. `appendHistory` 前的记录必须过 `assertNoImagePayload(record)`（在 `history.js` 内实现并导出），
   命中则丢弃图片字段并记一条 warning。
4. 冒烟脚本在运行后 dump 全部 storage 键值，断言不含 `data:image` 与 `base64`。

### 4.2 默认流程（路径 A）
```
submit → RUN_QUICK_START → (describing → scoring) → QUICK_DONE(ranked 降序) → 结果页
用户点「深度分析」 → RUN_DEEP_START → DEEP_DONE → 该套报告展开
compareOpen=true → 同屏两栏：[快速评分] 分数卡 | [深度分析] 报告
```

### 4.3 System Two 图片通道
图片以 `images: [{id, dataUri}]` 随请求体发送（多模态原生输入，不做图片转文字中转）。
mock 服务据 `images` 长度与 `state` 文本决定"看"到几套。

---

## 5. 异常处理（4 条规范逐条落点）

### 5.1 错误分类表（`src/data/copy.js` 必须逐字包含这些文案）

| kind | 触发 | 中文文案 | 用户可做的动作 | 重试 |
|---|---|---|---|---|
| `network` | fetch reject / DNS / 连接被拒 | 连不上决策模型，请检查网络或本地模型地址是否正确 | 检查设置页地址 / 切快速评分 | 是（1 次） |
| `timeout` | 超过 timeoutMs | 等待超时了，深度分析在弱网下会更慢，可以先看快速评分 | 重试 / 切 System One | 是（1 次） |
| `auth` | 401 / 403 | API Key 不正确或没有权限，请在设置页检查 API Key 配置 | 去设置页 | 否 |
| `rate_limit` | 429 | 请求太频繁了，歇一会儿再试 | 稍后重试 | 是（1 次，退避 2s） |
| `server` | 5xx | 决策模型服务出错了，请稍后再试或检查本地模型日志 | 稍后重试 | 是（1 次） |
| `parse` | 响应非 JSON / 缺字段 / 校验失败 | 模型返回的内容看不懂，请重试一次 | 重试 | 否 |
| `vision_unconfigured` | `laya_review` 下未配置 `visionBaseUrl` / `visionModel` | **还没配置能看照片的模型，请到设置页填写多模态模型地址与模型名** | 去设置页 | 否 |
| `invalid_input` | 图片无有效穿搭内容（描述全空或全为「未清晰显示」） | **无法识别有效穿搭内容，请上传清晰的穿搭照片哦** | 换图 | 否 |
| `cancelled` | AbortController 主动取消 | （不展示，静默） | — | 否 |

**重试的实现口径（v1.4 补充，落地在 `src/engine/api.js`）**：
- 自动重投 **1 次**，退避 600ms；`rate_limit` 用文案里的 `retryDelayMs`（2000ms）。重试可被调用方的 AbortSignal 立刻打断。
- `auth` / `parse` / `invalid_input` / `cancelled` **绝不重试**；`health()` 也不重试（只探测一次）。
- **4xx 收紧**：`server` 行的语义是 5xx。非 401/403/429 的 4xx（400 参数错、404 路径错…）沿用 server 文案，
  但强制 `retryable=false` —— 重投只会得到同样结果，白白让用户多等。
- **代价要如实告知用户**：单次预算是 quick 20s / deep 45s，加上一次重试意味着最坏情况约 2 倍。
  因此界面上「约 10 秒」已标注为顺境估算并写明「网络不好会自动重试一次」；弱网横幅负责把用户导向快速评分。
  这是「失败即重试」与「先给分数」之间的取舍：选择了前者（网络抖动下成功率更高），但必须把时间预期说清楚。

### 5.2 弱网（规范 4）
首个 `describe` 请求耗时 > 6000ms，或连续 2 次 `timeout` → `{type:'SET_WEAK', flag:true}` →
结果显示 `testID="banner-weaknet"`：**「当前网络较慢，建议先用快速评分；深度分析可能要多等一会儿」**。
弱网横幅提供一键切 System One。

### 5.3 输入不全（规范 3）
`validateInput` 返回 `ok=true` 但 `hints` 非空时，capture 页在 CTA 上方展示提示，**不阻塞**：
- 无场合且无问题 → 「补一句场合或问题，我会评得更准」
- 只有 1 套图 → 「只有一套也可以，但两套以上才能帮你比出哪套更好」

### 5.4 部分失败
4 套中部分套失败：成功的正常出分，失败套在结果页显示「这套没看清，点这里单独重试」（可单独重跑该套）。
全部失败才走 `invalid_input`。

---

## 6. mock 服务契约（`tools/mock-jev-server.mjs`）

| 路由 | 行为 |
|---|---|
| `GET /health` | `200 {"ok":true,"model":"<model>","uptime":n}` |
| `GET /spec` | `200` 返回本 SPEC 中 §1.3 的结构说明 JSON（便于人工核对） |
| `POST /ask` | 见下 |

行为规则：
- 监听 `0.0.0.0:8787`（`PORT` 环境变量可改），响应体 `Content-Type: application/json; charset=utf-8`。
- **确定性打分**：以 `lookId + state 文本` 的 FNV-1a 哈希为种子生成 `[2.0, 5.0]` 的一位小数分数，同一输入必得同一输出（可重复验证）。
- 按请求 `questions` 的 `id`/`type` 逐条作答：
  - `describe_*`（type=text）→ 返回一段**结构化描述**（含 7 个维度、含「未清晰显示」的用例），来自 `fixtures/descriptions/*.json`；
  - 6 个 score 维度 → 确定性分数 + confidence；
  - System Two（`questions[0].id === 'deep_report'`）→ 返回**三段式合法 JSON 字符串**（从 `fixtures/deep/*.json` 读，含 ranking/details/conclusion 全字段）。
- 故障注入（都用**请求体字段**触发，便于 puppeteer 场景化；**不允许**用全局开关影响并发用例）：
  - `"model": "test-auth-fail"` → `401 {"error":{"message":"invalid api key"}}`
  - `"model": "test-server-error"` → `500`
  - `"model": "test-parse-fail"` → `200` 返回 `not-json`（`Content-Type: text/plain`）
  - `"model": "test-timeout"` → 挂起后返回（用于弱网/超时提示）；**挂起时长由 `MOCK_TIMEOUT_MS` 环境变量控制，默认 30000**。
    注意：System One 的 describe/score 走 `quickTimeoutMs`（默认 20s），System Two 走 `timeoutMs`（默认 45s）；
    浏览器端跑 §7 断言 9 时把 `MOCK_TIMEOUT_MS` 压到 **1000**（否则要么等 20s、要么比 20s 预算还长而永不超时）。
    引擎侧的超时/退避语义由 `tests/api.test.js` 的 node 单测负责，浏览器端只验证 UI 提示链路。
  - `"model": "test-unrecognizable"` → describe 答案 content 全为「未清晰显示」
  - `"model": "test-partial-fail"` → 只有 `look1` 的 describe 为空 content，其余正常
- 启动后 stdout 打印 ASCII：`mock listening on 0.0.0.0:8787`。

### 6.1 fixtures

```
fixtures/descriptions/look1.json … look4.json     # 结构化描述文本（7 维度）
fixtures/deep/report-2looks.json  report-4looks.json
fixtures/images/look1.jpg … look4.jpg             # 390×520 JPEG（Pillow 生成，纯色+简单形状，体积 < 20KB）
tests/helpers/fetchMock.js                        # 内存 fetch 替身，按 URL/body 返回上面这些 fixture
```

---

## 7. 验收断言清单（`node tools/verify.mjs` 必须逐条产出）

### 7.0 门禁命令形式（v1.2 修正 · 环境实测）

Node v24.18.0 下 `node --test tests/`（目录形式）**必然失败**：v24 把位置参数当测试文件执行，
不再展开目录，报 `Cannot find module ...\tests`。已在纯 ASCII 目录复现，与中文路径无关。
因此全仓库统一使用 glob 形式：

```
node --test "tests/**/*.test.js"      # 单测（cwd = 项目根）
node tools/verify.mjs                 # 全链路验收
```

`package.json` 的 `test` / `gate` 脚本已是 glob 形式；`verify.mjs` 若要跑单测也必须用 glob，
并在报告里记录真实 pass/fail 数。

### 7.1 断言清单

1. `mock` 可达：`GET /health` 200。
2. System One：`ranked` 非空、按 `overall` 降序、每套恰好 6 个维度且全部 ∈ [0,5] 且为 1 位小数。
3. System One 响应体中**无解释性文本**：所有 answer `type==='score'`，无多余 `content` 用于展示（正则断言不含"建议/推荐/因为你/显得"）。
4. 结果页按降序渲染：DOM 中 `[data-testid="result-card"]` 的 `data-rank` 序列 == probe 中 ranked 顺序。
5. System Two：报告三段齐全（ranking/details/conclusion），stars ⊆ [0,5]、pros ≥2、cons ≥1、suggestions ≥1、pick ∈ lookIds。
6. 同屏对比：`compareOpen` 后 `[data-testid="compare-view"]` 内同时存在「快速评分」与「深度分析」两个标签。
7. `console.error === 0` 且 `pageerror === 0`（我们自己的代码；第三方 warning 单独计数记录）。
8. 隐私：storage dump 不含 `data:image` / `base64`；probe 里 `privacy.imageInStorage === false`；
   **且 `JSON.stringify(window.__OD_PROBE__)` 不含 `data:image`、`base64`、API Key 明文**（v1.1 加强）。
9. 异常：`test-auth-fail` → `banner-error` 文案命中 §5.1 `auth`；`test-timeout` 路径 → 命中 `timeout` 且出现 `banner-weaknet`。
   **优先走真实 UI 路径**（设置页 `engine-model` 填 `test-auth-fail` 等），请求拦截仅作备用，
   报告须写明本次实际走的是哪条路径。
10. 历史：跑完一次后 history 有 1 条，`looks[].description` 非空、无图片字段。
11. 截图产物存在：`artifacts/screens/{capture,result,compare,history,settings}.png`。
12. 报告写 `artifacts/verify-report.json`（UTF-8），字段含 `assertErrors: []`、`consoleErrors: 0`。
13. **分次选图必须累加**（v1.7）：先选 1 张、再选其余 3 张，`p.looks` 必须是 1 → 4，
    不得被后一次冲掉。**必须拆成两次调用**：一次性上传 4 张是测不出这个 bug 的
    （那本来就走一次替换），而用户实测"只能上传一张"正是这条路径。
14. **挑图窗口内失焦不得清空已选图片**（v1.7）：窗口内失焦 → 张数不变；
    窗口外失焦 → 张数归零（隐私不变量不许被削弱）。
    web 验收不经过相册、天然测不到，所以用 `__OD_SET_PICKING__` / `__OD_SIMULATE_BLUR__`
    测试缝显式覆盖。**这是"加第二套顶掉第一套"的真正成因**——
    没有它，前两条断言即使在 web 全绿，原生上依然是坏的。

---

## 8. 明确的非目标

- 不做账号、云同步、社交分享、iOS 原生构建、APK 打包。
- 不做真实 JEv/Laya 端点联调（以 mock + 契约样例替代）；不做流式输出。
- 不给 UI 写组件级自动化测试（只用 §7 的端到端冒烟 + 纯逻辑单测）。
- 不引入除 §依赖清单之外的任何新依赖（要加先改本 SPEC）。
