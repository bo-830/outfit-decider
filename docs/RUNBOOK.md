# RUNBOOK · 出门穿什么（outfit-decider）

本文件是**交付与验收的操作手册**：怎么在本机跑起来、怎么在真机上看、怎么接你自己的 JEv 云端 / Laya 本地决策模型、以及每个门禁命令的确切预期输出。

> 项目根目录：`C:\博830\vibecoding\outfit-decider`
> 所有命令在项目根执行；**Windows PowerShell 下 `npm` 脚本被安全策略拦住，必须用 `cmd /c "npm ..."` 或 `npx.cmd`。**

---

## 0. 三分钟上手（本机自证）

```powershell
cd C:\博830\vibecoding\outfit-decider
cmd /c "npm install"                 # 已装可跳过；用的是国内镜像 registry.npmmirror.com

# ① 契约对端（假决策模型，监听 0.0.0.0:8787）
node tools/mock-jev-server.mjs       # 另开一个终端常驻，或后台跑

# ② 纯逻辑单测
node --test "tests/**/*.test.js"     # 预期 tests 89 / pass 89 / fail 0
```
> ⚠️ 必须用 glob 形式。Node v24 下 `node --test tests/`（目录形式）会报 `Cannot find module ...\tests`，
> 因为 v24 把位置参数当测试文件执行、不再展开目录。这是实测结论，不是配置问题。

```powershell
# ③ 全链路验收（起 mock → expo export web → headless Chrome 390×844 冒烟 → 截图 + 报告）
node tools/verify.mjs                # 预期 exit 0、assertions 12/12
```

产物：
| 路径 | 内容 |
|---|---|
| `artifacts/verify-report.json` | 12 条断言的逐条结果 + 证据（真实响应、storage dump、DOM 顺序、截图清单） |
| `artifacts/screens/*.png` | capture / result / compare / settings / history / 故障态截图（390×844 @2x） |
| `artifacts/logs/` | expo export 与单测的原始日志 |

---

## 1. 真机验收：手机 Expo Go 扫码（推荐路径）

**前提**：手机与本机在同一 Wi-Fi；手机装了 Expo Go（SDK 57）。工作区已备 `Expo-Go-57.0.9.apk`。

```powershell
cd C:\博830\vibecoding\outfit-decider
cmd /c "npx expo start --lan"
```

1. 终端会出现二维码，同时打印形如 `exp://192.168.x.x:8081` 的局域网地址（本机当前 IPv4 之一为 `192.168.1.4`）。
2. 手机用 **Expo Go 扫码**（Android 用 Expo Go 内扫码；iOS 用系统相机扫码后跳转）。
3. 首次会请求**相册权限**——允许后即可选 1–4 张穿搭照。
4. 验收动作：
   - 选 4 张图 → 点选「场合 / 天气 / 风格偏好」→ 点底部「开始快速评分」
   - 预期：出「4 套排名」，按综合分从高到低，每套 6 维分数；第 1 名带「今天穿这套」吊牌
   - 点任意一套的「深度分析」→ 出三段式报告；打开「双系统同屏对比」→ 左右两栏并排
   - 切到「历史」→ 应只有文字描述与分数（**没有图片**）
   - 切到「设置」→ 点「测试连接」→ 应显示真实耗时与连通状态

**真机连不上 mock 时怎么排查**（手机需要能访问你电脑的 8787 端口）：
1. mock 默认监听 `0.0.0.0:8787`（不是 `127.0.0.1`），所以局域网可达——先用手机浏览器打开 `http://192.168.1.4:8787/health`，能看到 `{"ok":true,...}` 就说明通了。
2. 打不开 → 本机防火墙拦了 Node 的入站连接。放行方式（管理员 PowerShell）：
   ```powershell
   New-NetFirewallRule -DisplayName "outfit-decider mock 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow
   ```
3. 注意：**`http://127.0.0.1:8787` 在手机上指的是手机自己**，真机必须填电脑的局域网 IP（`192.168.x.x`）。

---

## 2. 接你自己的决策模型

设置页三个字段决定一切：

| 字段 | 说明 |
|---|---|
| 引擎模式 | **JEv 云端**（带 API Key 鉴权）/ **Laya 本地**（局域网，不带 Authorization） |
| baseUrl | 直接填 `192.168.1.5:8787` 也行，会自动补 `http://` 并去掉尾部 `/` |
| askPath / healthPath | 默认 `/ask` / `/health` |
| model | 逐字透传给服务端，**不做白名单**（异常场景靠它触发，见 §4） |
| API Key | 仅 JEv 模式使用；存 `expo-secure-store`（原生）。**Web 端降级存 AsyncStorage，界面会明确提示明文风险** |

### 2.1 Laya 本地模型：分步部署引导（首次使用时应看到同一份内容）

1. **在你打算长期开着的那台电脑上**部署 Laya 决策模型（可以就是你现在这台）。
2. 让它监听 `0.0.0.0:8787`（而不是只监听 `127.0.0.1`），否则手机连不上。
3. 查这台电脑的局域网 IP：
   ```powershell
   Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
   ```
4. 手机与电脑连**同一个 Wi-Fi**。
5. 在本 App「设置」页：模式选 **Laya 本地**，baseUrl 填 `http://<上一步的 IP>:8787`。
6. 点「测试连接」：显示 `HTTP 200` 与真实耗时即连通；失败会给出具体原因（连不上 / 超时 / 鉴权 / 服务端错误）。
7. 若第 6 步失败：先用手机浏览器打开 `http://<IP>:8787/health` 排除网络与防火墙问题，再回到第 2 步检查监听地址。

**明文 HTTP 说明**：局域网内用 `http://` 是可行的（Android 9+ 对明文有默认限制，本项目已在 `app.json` 申请明文放行；
若你的模型走公网，请用 `https://` 或隧道，别把 Key 与图片明文暴露在公网链路上）。

### 2.2 协议（对端必须满足，SPEC §1.3 是唯一真源）

请求 `POST {baseUrl}{askPath}`：
```json
{"model":"...","state":"...","questions":[{"id":"overall_score","type":"score","question":"..."}]}
```
响应：
```json
{"model":"...","answers":[{"id":"overall_score","type":"score","score":4.3,"content":"","confidence":0.86}],"usage":{...}}
```
要么让你的服务端按这个形状回，**要么把 `tools/mock-jev-server.mjs` 当成参考实现改**——它已经是本契约的对端。

---

## 3. 弱网与异常（可复现）

| 场景 | 怎么复现 | 预期 |
|---|---|---|
| 连不上 | 设置页 baseUrl 改成 `http://10.255.255.1:9`，评分 | 错误横幅「连不上决策模型，请检查网络或本地模型地址是否正确」 |
| 鉴权失败 | JEv 模式 + 任意错误 Key（或 model 填 `test-auth-fail`） | 「API Key 不正确或没有权限，请在设置页检查 API Key 配置」+「去设置页」 |
| 超时 → 弱网 | model 填 `test-timeout`，并把 mock 的挂起时间压短：`MOCK_TIMEOUT_MS=1000 node tools/mock-jev-server.mjs` | 「等待超时了…」+ 弱网横幅「当前网络较慢，建议先用快速评分」 |
| 识别不出穿搭 | model 填 `test-unrecognizable` | 「无法识别有效穿搭内容，请上传清晰的穿搭照片哦」 |
| 部分失败 | model 填 `test-partial-fail` | 只有第 1 套失败，其余 3 套正常出分；失败套显示「这套没看清，点这里单独重试」 |
| 返回不是 JSON | model 填 `test-parse-fail` | 「模型返回的内容看不懂，请重试一次」 |

> 引擎侧的超时/退避语义有 node 单测覆盖（`tests/api.test.js`）；上表用于**界面链路**的人工复核。

### 3.1 自动重试（SPEC §5.1「重试」列的落地）

`network` / `timeout` / `rate_limit` / `server` 这四类错误会**自动重投 1 次**（退避 600ms，`rate_limit` 用文案里的 2s），
`auth` / `parse` / `invalid_input` / `cancelled` **绝不重试**（重试只会得到同样结果，或让用户白等、白计费）。
重试可被取消立刻打断。

**对时间预期的诚实说明**：System One 的单次预算是 20s，加上自动重试 1 次，最坏情况会到 ~40s。
所以界面上写的「约 10 秒」是**顺境下的估算**，并已标注「网络不好会自动重试一次，可能要久一点」。
弱网时横幅会立刻改为推荐「先看快速评分」，不要让它看起来像卡死。

---

## 4. mock 数据的诚实声明（别把它当真实评审结果）

`tools/mock-jev-server.mjs` 是**测试替身**，它的分数是按 `lookId + state + 维度` 做 FNV-1a 哈希生成的**伪随机数**（同输入必得同输出，便于复现），
**不代表任何真实穿搭评价**，也不会真的"看懂"照片（describe 文案读自 `fixtures/descriptions/*.json`）。

它的设计目标是：① 包住 SPEC §1.3 的线格式（含 score 强制 1 位小数）；② 让各维度分与综合分**自洽**（综合分由 5 维加权聚合而来，场合维度权重最高）；③ 提供可复现的故障注入。
**换个 state 分数就会变，这是设计如此，不是 bug。**

---

## 5. 隐私（可自行复核）

| 承诺 | 怎么自己验证 |
|---|---|
| 原始图片只进内存、看完即弃 | 跑一次评分后看「历史」：只有文字描述与分数，没有图片；`node tools/verify.mjs` 的报告里 `evidence.storage` 会 dump 全部 storage 键值 |
| 不留存原图 | 图片从未写入任何 storage：报告中断言 storage 不含 `data:image` / `base64` |
| API Key 只在你的设备上 | 原生存 `expo-secure-store`（Keystore / Keychain）；**web 端无安全存储可用，降级为 localStorage 明文，界面会明确写出「当前设备只能用明文存储」**。报告里 `keyEntered=true`（确实输入过 Key）同时 `storage` 与 `window.__OD_PROBE__` 中均无 Key 明文、`od.config.v1` 内也无 Key 字段 |
| 不上传第三方 | 除你在设置页配置的 baseUrl 之外，App 不发任何出网请求（无埋点、无遥测） |

---

## 6. 门禁与"红得起"（防止假绿）

```
cmd /c "npm test"        # = node --test "tests/**/*.test.js"  → 期望 89/0
cmd /c "npm run verify"  # = node tools/verify.mjs              → 期望 exit 0、12/12
cmd /c "npm run gate"    # 两者串联
```

一个只会在顺境下变绿的门禁等于没有门禁。本项目的验证包含**故障注入路径**（401 / 超时 / 非 JSON / 空内容 / 部分失败），
且 `artifacts/verify-report.json` 会明示本次故障注入走的是**真实 UI 路径**还是请求拦截，不允许"用拦截伪造通过"而不说明。
