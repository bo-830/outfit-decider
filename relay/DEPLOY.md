# 中转服务 · 部署说明

> `relay/relay-server.mjs` —— 让用户**只填「地址 + 一个口令」**就能用。
> 上游两把 Key（决策模型 + 多模态模型）由中转自己持有，App 永远看不到。

```
App ──POST /ask  (Authorization: Bearer <APP_TOKEN>)──▶ 中转 ──Bearer <上游 Key>──▶ 决策模型 / 多模态模型
```

App 侧的请求/响应契约**一个字都没改**（SPEC §1.3）：
请求 `{model, state, questions:[{id,type,question}], images?:[{id,dataUri}]}`，
响应 `{model, answers:[{id,type,score,content,confidence}], usage:{...}}`。
协议翻译复用 `tools/laya-adapter.mjs` 里实测验证过的那套具名导出（该文件只读，未修改）。

---

## 1. 快速开始（三步）

```bash
# ① 一台能出网的机器（云主机 / 托管平台 / 家里开着的小主机都行）
# ② 设好环境变量（APP_TOKEN 必填，缺了直接拒绝启动）
export APP_TOKEN='你随手编的一个口令，比如 咖啡-9-柠檬'
export DECISION_BASE_URL='https://api.typesafe.ai'
export DECISION_MODEL='jev-latest'
export DECISION_API_KEY='<你的决策模型 Key>'
export VISION_BASE_URL='https://api.deepseek.com/v1'
export VISION_MODEL='deepseek-chat'
export VISION_API_KEY='<你的多模态 Key>'
export RELAY_PORT=8787

# ③ 启动
node relay/relay-server.mjs
```

Windows（PowerShell，一次只对当前窗口生效）：

```powershell
$env:APP_TOKEN='咖啡-9-柠檬'
$env:DECISION_BASE_URL='https://api.typesafe.ai'
$env:DECISION_MODEL='jev-latest'
$env:DECISION_API_KEY='<你的决策模型 Key>'
$env:VISION_BASE_URL='https://api.deepseek.com/v1'
$env:VISION_MODEL='deepseek-chat'
$env:VISION_API_KEY='<你的多模态 Key>'
node relay/relay-server.mjs
```

然后在 App 设置页把「地址」填成 `http://<这台机器的公网IP>:8787`（或域名），「口令」填同一个 `APP_TOKEN`。

> ⚠️ 不要用 `node tools/laya-adapter.mjs` 来当托管中转：它**没有鉴权**，任何人拿到地址就能白嫖你的上游 Key。
> 中转**不读** 项目根的 `.env.local`，只认进程环境变量 —— 托管机上不会有那个文件，也就不会"明明配了却说没配"。

---

## 2. 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `APP_TOKEN` | **是** | — | App 侧填的同一个口令。**缺失/空白 → 拒绝启动**（否则就是开放代理） |
| `RELAY_PORT` | 否 | `8787` | 监听端口；填 `0` 让系统随机分配（启动日志会打印真实端口） |
| `RELAY_HOST` | 否 | `0.0.0.0` | 监听地址；只给本机用可填 `127.0.0.1` |
| `DECISION_BASE_URL` | 否* | — | 决策模型基地址，默认补 `/v1/systemone` |
| `DECISION_MODEL` | 否* | App 传来的名字 | 转发给决策端点的模型名 |
| `DECISION_API_KEY` | 否 | — | 决策端点鉴权（Bearer） |
| `VISION_BASE_URL` | 否* | — | OpenAI 兼容多模态基地址，默认补 `/chat/completions` |
| `VISION_MODEL` | 否* | — | 多模态模型名 |
| `VISION_API_KEY` | 否 | — | 多模态端点鉴权（Bearer） |
| `VISION_MAX_TOKENS` | 否 | `8000` | 多模态 `max_tokens`。**别调小**：推理模型会把预算花在 reasoning 上，给小了会返回 200 但正文是空串 |

\* 不填不会拒绝启动，但对应链路会返回 502 并在启动日志里 `WARN`（方便"先起服务、后配 Key"）。

**地址可以是基地址，也可以是完整端点**（运维常常直接把整条 URL 粘进来）：

| 你填的 | 实际请求 |
| --- | --- |
| `https://api.typesafe.ai` | `https://api.typesafe.ai/v1/systemone` |
| `https://api.typesafe.ai/v1/systemone` | 原样使用 |
| `https://api.deepseek.com/v1` | `https://api.deepseek.com/v1/chat/completions` |
| `https://x.example/v1/chat/completions` | 原样使用 |

---

## 3. 接口契约

### `GET /health` —— 不需要鉴权（便于托管平台探活）

```json
{"ok":true,"relay":"outfit-relay","version":"1.0.0","upstream":{
  "decision":{"configured":true,"apiKeySet":true,"model":"fake-decision"},
  "vision":{"configured":true,"apiKeySet":true,"model":"fake-vision","maxTokens":8000}}}
```

只报"配没配"和模型名，**不暴露上游 URL、不暴露 Key**（这是公网可匿名访问的端点）。
`/healthz` 等价。健康检查不探上游，避免探活被慢上游拖成假故障。

### `POST /ask` —— 需要 `Authorization: Bearer <APP_TOKEN>`

- 口令缺失 / 错误 → `401 {"error":{"message":"invalid or missing app token"}}`，**不会碰上游**。
- 请求体形状与 App 完全一致（见上）。不是 JSON / 没有 `questions` → 400。
- 四条链路按 `questions` 的语义自动路由（判据复用适配器，顺序：deep → review → describe → 打分）：

| 判据 | 去向 | 说明 |
| --- | --- | --- |
| `questions = [{id:'deep_report',…}]` | 多模态 `/chat/completions` | 深度报告；**空正文自动重投一次** |
| `questions = [{id:'review',…}]` | 多模态 | 纠正；`temperature: 0` |
| 所有 id 以 `describe_` 开头 | 多模态 | 图片→文字；缺 `images` → 400 |
| 其余（6 维打分等） | 决策端点 `/v1/systemone` | App 数组式 questions → 上游 id 为键的 map，6 档 criteria |

- 上游非 2xx → 中转回 **502**，并把**上游自己给的原因**放进 `error.message`
  （如 `decision upstream HTTP 401: Invalid API key`，附 `upstream_status` 字段）。
  原因用 `response.text()` 再尝试 `JSON.parse` 读取，非 JSON 的错误页也不会丢。
- 上游地址不可达 / 超时 → 502 `decision upstream unreachable: …`。
- 响应头带 CORS（`Access-Control-Allow-Origin: *`，放行 `Authorization`），`OPTIONS` 预检 204 且不鉴权 —— 手机端不需要，但 `expo web` 预览需要。

### `deep_report` 空正文重投（实测的坑，别删）

推理模型偶尔返回 **HTTP 200 但 `content` 是空串**（实测约 1/4）。中转对 `deep_report`
**自动重投一次，且最多一次**；两次都空则如实返回空正文，让 App 走既有的"没识别出有效内容"提示——
**不假装成功**。describe / review 的空正文属于真实失败，不重投（重投只是白花钱）。
客户端断开（用户取消）时**绝不重投**，并且会立刻 abort 正在飞的上游请求。

---

## 4. 真实进程验收记录（本仓库实测）

命令与输出均为本机实跑原样，**端口是随机空闲端口**（不占 8787/8000）。

### 4.1 缺 `APP_TOKEN` 必须拒绝启动

```bash
$ node relay/relay-server.mjs
[relay] FATAL APP_TOKEN is required: refusing to start. A relay without a passphrase would be an open proxy. Set APP_TOKEN=<shared passphrase> and give the same value to the App.
EXIT=1
```

### 4.2 假上游（临时代码，**不入库**；下面这段直接存成 `fake-upstream.mjs` 即可复现）

```js
import http from 'node:http';
import fs from 'node:fs';

const PORT_FILE = process.env.PORT_FILE;
function send(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = JSON.parse(raw); } catch { json = null; }
    process.stdout.write(`[fake-upstream] ${req.method} ${req.url} bytes=${raw.length} auth=${req.headers.authorization ? 'present' : 'absent'}\n`);
    if (req.url.startsWith('/v1/systemone')) {
      const questions = (json && json.questions) || {};
      const answers = {};
      for (const id of Object.keys(questions)) answers[id] = { type: 'score', score: 4, confidence: 0.5, answer_confidence: 0.66 };
      send(res, 200, { model: 'fake-decision', answers, usage: { input_tokens: 11, output_tokens: 22 } });
      return;
    }
    if (req.url.startsWith('/chat/completions')) {
      send(res, 200, { model: 'fake-vision', choices: [{ message: { content: '整体风格：休闲；上衣：白衬衫；下装：深色长裤' } }],
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } });
      return;
    }
    send(res, 404, { error: { message: 'not found' } });
  });
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(PORT_FILE, String(server.address().port));
  process.stdout.write(`[fake-upstream] listening on http://127.0.0.1:${server.address().port}\n`);
});
```

### 4.3 起假上游 + 起 relay（真进程）

```powershell
$env:PORT_FILE = "$env:TEMP\relay-verify\upstream.port"
Start-Process node -ArgumentList "$env:TEMP\relay-verify\fake-upstream.mjs"   # 端口由内核分配，写入 PORT_FILE

$env:APP_TOKEN          = 'demo-passphrase-2026'
$env:RELAY_PORT         = '0'            # 0 = 随机空闲端口，启动日志打印真实端口
$env:RELAY_HOST         = '127.0.0.1'
$env:DECISION_BASE_URL  = $upBase
$env:DECISION_MODEL     = 'fake-decision'
$env:DECISION_API_KEY   = 'sk-demo-decision-key-123456'
$env:VISION_BASE_URL    = $upBase
$env:VISION_MODEL       = 'fake-vision'
$env:VISION_API_KEY     = 'sk-demo-vision-key-123456'
Start-Process node -ArgumentList 'relay\relay-server.mjs' -WorkingDirectory . -RedirectStandardOutput relay.out
```

本次实跑拿到的地址（每次不同，以启动日志为准）：

```
[relay] listening on http://127.0.0.1:50500
[relay] decision upstream: configured model=fake-decision
[relay] vision upstream: configured model=fake-vision max_tokens=8000
[relay] app token: set
```

假上游：`http://127.0.0.1:50487`

请求体（UTF-8 存成两个文件，`curl --data-binary "@文件"` 读取，避免 GBK 控制台把中文打坏）：

`ask-score.json` —— 6 维打分：

```json
{
  "model": "outfit-decider",
  "state": "【穿搭一】\n整体风格：休闲\n上衣：白衬衫\n下装：深色长裤\n\n【我的场合】正式面试",
  "questions": [
    { "id": "overall_score", "type": "score", "question": "这套穿搭的整体得分是多少？" },
    { "id": "aesthetic_score", "type": "score", "question": "这套穿搭的美观度是多少？" },
    { "id": "scene_score", "type": "score", "question": "这套穿搭和我的场合匹配吗？" },
    { "id": "figure_score", "type": "score", "question": "这套穿搭对身形修饰如何？" },
    { "id": "style_score", "type": "score", "question": "这套穿搭风格统一吗？" },
    { "id": "practical_score", "type": "score", "question": "这套穿搭方便吗？" }
  ]
}
```

`ask-describe.json` —— 图片转文字（dataUri 换成真实图片即可）：

```json
{
  "model": "outfit-decider",
  "state": "（本次只做图片客观描述，无用户上下文）",
  "questions": [
    { "id": "describe_look1", "type": "text", "question": "请客观描述这张穿搭照片。" }
  ],
  "images": [
    { "id": "look1", "dataUri": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }
  ]
}
```

### 4.4 curl 验证

```bash
# ① /health —— 不带任何口令
curl.exe -s http://127.0.0.1:50500/health
```
```json
{"ok":true,"relay":"outfit-relay","version":"1.0.0","upstream":{"decision":{"configured":true,"apiKeySet":true,"model":"fake-decision"},"vision":{"configured":true,"apiKeySet":true,"model":"fake-vision","maxTokens":8000}}}
```
`HTTP 200`

```bash
# ② /ask —— 不带口令（中文请求体存成 UTF-8 文件，避免 GBK 控制台把中文打坏）
curl.exe -s -X POST http://127.0.0.1:50500/ask -H "Content-Type: application/json" --data-binary "@ask-score.json"
```
```json
{"error":{"message":"invalid or missing app token"}}
```
`HTTP 401`（错口令 `Bearer wrong-token` 同样 401）

```bash
# ③ /ask —— 带口令 + 6 维打分 → 决策端点
curl.exe -s -X POST http://127.0.0.1:50500/ask \
  -H "Content-Type: application/json" -H "Authorization: Bearer demo-passphrase-2026" \
  --data-binary "@ask-score.json"
```
```json
{"model":"fake-decision","answers":[{"id":"overall_score","type":"score","score":4,"confidence":0.66},{"id":"aesthetic_score","type":"score","score":4,"confidence":0.66},{"id":"scene_score","type":"score","score":4,"confidence":0.66},{"id":"figure_score","type":"score","score":4,"confidence":0.66},{"id":"style_score","type":"score","score":4,"confidence":0.66},{"id":"practical_score","type":"score","score":4,"confidence":0.66}],"usage":{"prompt_tokens":11,"completion_tokens":22,"total_tokens":33}}
```
`HTTP 200`

```bash
# ④ /ask —— 带口令 + describe（带图）→ 多模态端点
curl.exe -s -X POST http://127.0.0.1:50500/ask \
  -H "Content-Type: application/json" -H "Authorization: Bearer demo-passphrase-2026" \
  --data-binary "@ask-describe.json"
```
```json
{"model":"fake-vision","answers":[{"id":"describe_look1","type":"text","content":"整体风格：休闲；上衣：白衬衫；下装：深色长裤","confidence":0.8}],"usage":{"prompt_tokens":5,"completion_tokens":6,"total_tokens":11}}
```
`HTTP 200`

### 4.5 上游侧与日志侧（同一次实跑）

```
[fake-upstream] POST /v1/systemone        bytes=966 auth=present     ← 打分走了决策端点，且带上了中转自己的 Key
[fake-upstream] POST /chat/completions    bytes=298 auth=present     ← describe 走了多模态端点
--- relay log ---
[relay] POST /ask status=401 reason=bad_or_missing_app_token ms=0
[relay] POST /ask status=401 reason=bad_or_missing_app_token ms=0
[relay] POST /ask mode=score status=200 ms=31 questions=6 images=0 upstream_calls=1
[relay] POST /ask mode=describe status=200 ms=6 questions=1 images=1 upstream_calls=1
RELAY_STDERR_EMPTY=True
LOG_PURITY=PASS                 ← 日志里没有 Key / base64 / dataUri / APP_TOKEN
UPSTREAM_AUTH_HEADER_SEEN=True  ← 上游确实收到了鉴权头（值不落日志）
UPSTREAM_LOG_HAS_KEY=NO
```

（`UPSTREAM_AUTH_HEADER_SEEN` 只报告"有没有"这个布尔量；假上游本身也不打印 Key 值。）

### 4.6 单测

```bash
node --test tests/relay.test.js       # 25/25 绿
node --test "tests/**/*.test.js"      # Node v24 必须用 glob，目录形式会失败
```

`tests/relay.test.js` 覆盖：缺 `APP_TOKEN` 拒绝启动；口令缺失/错误 → 401 且不碰上游；
三类请求各自路由（并断言"打分不碰多模态、多模态不碰决策端点"）；deep 空正文**重投一次且最多一次**、
describe 空正文不重投、用户取消不重投（含真实断开客户端）；上游非 2xx 原因透传（含非 JSON 错误页）
与 Key 脱敏；`/health` 免鉴权 + CORS；请求体校验；**日志不含 Key/dataUri/base64**。

---

## 5. 部署到托管平台

通用要求：**能出网**、支持**环境变量**、暴露一个 HTTP 端口。

- **Render / Railway / Fly.io**：新建 Web Service，启动命令 `node relay/relay-server.mjs`，
  把第 2 节的环境变量填进控制台，`RELAY_PORT` 用平台注入的 `$PORT`（这三个平台都会给 `PORT`；
  如果平台只认 `PORT`，就设 `RELAY_PORT=$PORT`）。
- **Docker**：
  ```dockerfile
  FROM node:24-alpine
  WORKDIR /app
  COPY relay/ ./relay/
  COPY tools/laya-adapter.mjs ./tools/laya-adapter.mjs   # 中转依赖它的具名导出
  ENV RELAY_HOST=0.0.0.0 RELAY_PORT=8787
  EXPOSE 8787
  CMD ["node", "relay/relay-server.mjs"]
  ```
  注意 `tools/laya-adapter.mjs` **必须一起带进镜像**（中转 import 它的纯函数）。它只依赖 Node 内置模块，无需 `npm install`。
- **systemd / PM2**：`node relay/relay-server.mjs`，环境变量写 `Environment=` / `ecosystem.config.js`。
- **反向代理（Nginx）**：记得 `proxy_set_header Authorization $http_authorization;`，
  并把 `proxy_read_timeout` 调到 ≥ 180s（deep 报告很慢）。
- **HTTPS**：App 在真机（iOS/Android）上访问明文 HTTP 可能被系统拦；生产请挂 TLS。

**给别人用之前**：口令换成长一点的一次性字符串；每个用户（或每台设备）一个 `APP_TOKEN` 更好排查；
上游 Key 建议做成**限额 Key**，万一口令泄漏损失可控。

---

## 6. 隐私与安全红线

1. 图片只在**内存**里以 dataUri 随请求转发，**不写盘、不入库、不留存**；进程退出即消失。
2. 日志里**绝不**出现 Key / `APP_TOKEN` / dataUri / base64。所有出站日志过 `redactSecrets`
   （`sk-***`、`Bearer ***`、`data:***`、≥64 字符的裸 base64 一律抹掉），**始终不记录请求体**。
3. 给 App 的错误信息同样脱敏：上游若把 Key 回显在错误里，用户看到的也是 `sk-***`。
4. App 永远拿不到上游 Key；上游请求头由中转在服务端拼上。
5. `/health` 是唯一免鉴权端点，只暴露"配没配 + 模型名"，不含 URL 与任何凭据。
6. 非 2xx 一律回 502 而不是透传上游状态码：上游 401 是**中转自己的 Key** 不对，透传会让 App 误报成"你的口令错"。

---

## 7. 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动即 `FATAL APP_TOKEN is required` | 没设 `APP_TOKEN`（或只设了空白）。这是有意的门禁 |
| App 报 401 | App 里的口令和 `APP_TOKEN` 不一致（注意首尾空格） |
| `/ask` 502 `decision upstream HTTP 401: Invalid API key` | 中转的 `DECISION_API_KEY` 不对/过期 |
| `/ask` 502 `vision upstream HTTP 404: …` | `VISION_BASE_URL` 填错（例如多填了一段路径）；基地址与完整端点都支持，看第 2 节的表 |
| `/ask` 502 `decision upstream unreachable: …` | 出网被防火墙拦 / 地址写错 / 上游挂了 |
| deep 报告偶尔是空的 | 推理模型把预算花在 reasoning 上。已自动重投一次；仍空就该调大 `VISION_MAX_TOKENS` 或换模型 |
| 启动日志 `WARN … not set` | 对应链路还没配，不致命；配好重启即可 |
| web 预览跨域报错 | 中转已放行 `*` + `Authorization`；若是自建反代，别把 CORS 头吃掉 |

---

## 8. 已知限制（诚实清单）

1. **没有速率限制 / 配额**：`APP_TOKEN` 泄漏等于上游额度被白嫖。要给别人长期用，请在反代或平台上加限流。
2. **单口令共享**：所有用户共用一个 `APP_TOKEN`，日志里无法区分是谁在调（也就无法按人计量）。
3. **`/health` 不探上游**：只反映配置，不代表上游此刻可达。要探活请自己调一次 `/ask`。
4. **决策端点方言固定为 laya/JEv 那套（`/v1/systemone` + 6 档 criteria）**：这是适配器实测过的形状；
   若上游是别的方言，需要在 `resolveEndpoint`/`toLayaRequest` 处扩展（本任务契约未要求）。
5. **无持久化、无队列**：进程重启不影响正确性，但也没有重试队列（重试由 App 和 deep 的单次重投负责）。
6. 请求体上限 **32MB**（整个 body 读进内存后转发，不落盘），超限回 413；4 套原图的 base64 通常远小于此。
7. 本仓库整体单测门禁 `node --test "tests/**/*.test.js"` 目前有 16 条失败，全部集中在
   `tests/review-system.test.js` / `tests/engines.test.js` / `tests/invariants.test.js`
   （正在被并行任务修改的 `src/engine/api.js` 等文件），与本中转服务无关；
   `tests/relay.test.js` 单独跑 25/25 全绿。
