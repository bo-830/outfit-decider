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

> **为什么不用 `expo run:android`（原生构建）**：Gradle 直接拒绝本项目——
> `Your project path contains non-ASCII characters`。项目在 `C:\博830\...`，`博` 就是那个字符，
> 且用 junction 给个 ASCII 路径**也没用**（Node 的 `require.resolve` 会解析回真实路径）。
> 本项目需要的原生模块（image-picker / secure-store / async-storage / safe-area-context）
> **Expo Go 全部内置**，所以走 Expo Go 没有任何功能损失。原生构建仅当你日后要加自定义原生模块时才有必要，
> 那时必须先把项目移到纯 ASCII 路径。

**前提**：手机与本机在同一 Wi-Fi；手机装了 Expo Go（SDK 57）。工作区已备 `Expo-Go-57.0.9.apk`。

```powershell
cd C:\博830\vibecoding\outfit-decider
cmd /c "npx expo start --lan"
```

1. 终端会出现二维码，同时打印形如 `exp://10.63.1.253:8081` 的局域网地址。
   **这个 IP 是 DHCP 分配的，会变**（已实测变过三次：`192.168.1.4` → `192.168.73.231` → `10.63.1.253`），
   所以别记死，每次看终端或跑 `tools\start-outfit-decider.bat` 打印的值。
2. 手机用 **Expo Go 扫码**（Android 用 Expo Go 内扫码；iOS 用系统相机扫码后跳转）。
3. 首次会请求**相册权限**——允许后即可选 1–4 张穿搭照。
4. 验收动作：
   - 选 1–4 张图 → 点选「场合 / 天气 / 风格偏好」→ 默认档位是**深度分析**，直接点底部按钮即可；
     想只要分数就切到「快速评分」。
   - 预期：出「N 套排名」，按综合分从高到低，每套 6 维分数；第 1 名带「今天穿这套」吊牌
   - 只跑「深度分析」时：出「N 套深度排名」+ 来源说明，星级降序，无「双系统对比」开关
   - 切到「历史」→ 应只有文字描述与分数（**没有图片**）
   - 切到「设置」→ 点「测试连接」→ 应显示真实耗时与连通状态

**真机连不上服务时怎么排查**（手机需要能访问你电脑的 8787 与 8081）：

1. 服务都监听 `0.0.0.0`（不是 `127.0.0.1`），所以局域网可达——先用手机浏览器打开
   `http://<你的局域网IP>:8787/health`，能看到 `{"ok":true,...}` 就说明通了。
2. **打不开 → 先查本机防火墙是否拦了入站连接。**（**实测本机已有放行规则**，所以通常不是这个原因，
   但换机器/换 Node 安装位置后要重新确认。）
   先看是否已有规则：
   ```powershell
   Get-NetFirewallApplicationFilter |
     Where-Object { $_.Program -match 'node|python' } |
     ForEach-Object { $_.Program } | Select-Object -Unique
   ```
   本机现状：`node.exe`（覆盖适配器 8787 与 Metro 8081）与
   `...\dsh-primary-runtime\...\python.exe`（覆盖 Laya 8000）**都已有 Allow 入站规则**，
   且正是当前实际运行的进程路径。
   没有规则时才需要**管理员** PowerShell 放行：
   ```powershell
   foreach ($p in 8787,8000,8081) {
     New-NetFirewallRule -DisplayName "outfit-decider $p" -Direction Inbound -Protocol TCP -LocalPort $p -Action Allow
   }
   ```
   **8081 必须一起放行**：它是 Metro 打包服务，只放 8787 的话 Expo Go 能打开 App 外壳，
   但**永远拉不到 JS bundle**，表现为卡在启动页——很容易被误判成 App 的问题。
3. 注意：**`http://127.0.0.1:8787` 在手机上指的是手机自己**，真机必须填电脑的局域网 IP。
4. **Android 模拟器**：它连局域网 IP 通常不通，要用宿主机别名 `http://10.0.2.2:8787`。
   `app.json` 已设 `usesCleartextTraffic: true`，所以明文 HTTP 不会被 Android 9+ 拦掉。
   **更省事的做法是 `adb reverse`**（推荐）：它把模拟器的 localhost 映射到本机，
   于是 App 里**默认的** `127.0.0.1:8787` 直接可用，什么都不用改：
   ```powershell
   foreach ($p in 8081,8787,8000) { adb reverse tcp:$p tcp:$p }   # 8081 必带，否则拉不到 bundle
   adb shell am start -a android.intent.action.VIEW -d "exp://127.0.0.1:8081" host.exp.exponent
   ```
   `tools\start-outfit-decider.bat emulator` 会把上面这套连同 AVD 启动、Expo Go 版本校验一起做完。

### 1.1 模拟器（`tools\start-outfit-decider.bat emulator`）

一条命令做完全部：启动 AVD → 等 `sys.boot_completed` → **校验 Expo Go 版本** →
`adb reverse` → 拉起 App。

### 1.2 设置页到底填什么（重启后也一样）

**这些值会持久化**（`PERSISTED_CONFIG_KEYS`），所以正常只需填一次，重启不用重填。

| 字段 | 模拟器 | 真机 |
|---|---|---|
| 决策 baseUrl | `http://127.0.0.1:8787`（**默认值，别改**） | `http://<脚本打印的LAN IP>:8787` |
| 决策模型名 | `outfit-judge-v1`（默认） | 同左 |
| askPath / healthPath | `/ask`、`/health`（默认） | 同左 |
| API Key | **留空** | **留空** |
| 能看图的模型 | **留空**，勾上「已配在服务端」 | 同左 |

两个"随便填也行"的原因（都已在代码里核实）：
- **模型名不影响打分**：适配器**不把 App 传来的 model 转发给 Laya**（`LAY A_MODEL` 默认不传，
  交给 Laya 自己路由），所以它只是个显示标签。
- **Key 可以留空**：适配器**不校验入站鉴权**（`UPSTREAM_KEY` 只用于它调 Laya 的出站方向）。

**唯一会过期的是 baseUrl，而且只因为 LAN IP 会变。** App 会把旧地址一直存着、
**自己不会报警**。所以 `.bat` 每次运行都会：

1. 检测当前 LAN IP；
2. 与项目根下 `.last-lan-ip.txt`（上次记录，已 gitignore）比较；
3. **变了就醒目打印**旧值、新值、以及"去设置页把 baseUrl 改成 http://<新IP>:8787"；
4. 没变则安静通过（不会误报）。

模拟器不受影响 —— 它走 `adb reverse`，所以 baseUrl 恒为默认的 `127.0.0.1:8787`。

### 1.3 服务挂了怎么判断、怎么恢复

**症状**：App 里打分/分析失败；手机浏览器打不开 `http://<LAN IP>:8787/health`。

**第一步：确认到底哪个服务挂了。** 有个会误导人的细节 ——
**适配器在上游（Laya）挂掉时仍然返回 HTTP 200**：

```json
{"ok":true,"adapter":"laya-adapter","upstream":{"ok":false,"detail":"fetch failed"}, ...}
```

所以**判断健康要看 `upstream.ok`，不是 HTTP 状态码**。只看 200 会得出"服务正常"的假结论，
然后整轮打分失败、报错全是看不懂的 network/server（实测就这么踩过）。

**第二步：App 已经会自己识别这两种情况**（SPEC §5.5）。打分/分析前先做一次很轻的探测：

| 探测结果 | App 提示 |
|---|---|
| 端点 200 且 `upstream.ok=false` | 「决策模型服务没在运行（或刚退出）。请先启动它，再重新分析」 |
| 端点不可达 / 非 2xx | 「连不上决策模型地址。请检查地址是否正确、以及服务是否已启动」 |
| 端点是云端、没有 `upstream` 字段 | 视为健康，**不误报** |

**第三步：恢复。** 脚本是**幂等**的，直接再跑一次，它只启动缺的那些：

```powershell
tools\start-outfit-decider.bat          # 真机
tools\start-outfit-decider.bat emulator # 模拟器
tools\start-outfit-decider.bat stop     # 收工（按 PID + 端口精确停，不误杀其他 node）
```

**持久性要说清楚**：服务以**分离进程**启动（无 `/k` 控制台窗口），stdout/stderr 落在
`.run\*.log`，所以"为什么死了"有据可查。但它们**不是 Windows 服务**：
正常双击运行能活过窗口关闭，但**会话注销或强制杀进程树仍会带走它们（实测验证过）**。
真正的保障是"脚本幂等、随手重跑"，而不是"它永远不会死"。

两个**实测踩过的坑**：

1. **Expo Go 版本必须与项目 SDK 一致。** 模拟器里装的是 SDK 58 而项目是 SDK 57 时，
   报 `Project is incompatible with this version of Expo Go`——**看起来像网络问题，其实不是**。
   脚本会用工作区里的 `Expo-Go-57.0.9.apk` 自动重装。
   （APK 路径与目标版本写在脚本顶部的 `EXPO_GO_APK` / `EXPO_GO_SDK`。）
2. **模拟器里的 `127.0.0.1` 是模拟器自己**，LAN IP 通常也不通 →
   靠 `adb reverse` 解决，这样 baseUrl 用默认值即可。

调试时注意：`adb shell input tap` 对**系统相册选择器**（另一个 App 的窗口）经常不生效，
截图会一模一样；这不是 App 的问题，别据此判断点击失败。

---

## 2. 接你自己的决策模型

### 2.00 App **直连** TypeSafe JEv（没有电脑也能用）

设置页有一键预设：点 **「直连 TypeSafe JEv（无需电脑）」**，它会填好四项：

```
baseUrl  = https://api.typesafe.ai/v1
askPath  = /systemone
model    = jev-latest
protocol = jev
```

你只需再填自己的 API Key（https://console.typesafe.ai/keys）并点「保存 Key」。
也可以走 `tools\use-jev.bat` 经本机适配器中转（见 §2.0），两者不冲突。

**App 会自动做的翻译**（所以你不必管形状）：App 发的是 `questions` 数组，
而 JEv 要的是 map（`id → {type,instructions,criteria}`）；命中 `typesafe.ai` 时
由 `src/core/jev.js` 转换，并把响应的 map `answers` 归一化回数组。
6 档 criteria 正好对应 0–5，**无需档位映射**（本机 Laya 的 3 档才需要）。

⚠️ **直连 JEv 必须另配一个能看图的模型。**
JEv 文档写明 **"No text generation"** —— 它只答 choice/score/noul，
做不了「图片 → 7 行描述」这一步，而打分依赖描述。
所以直连 JEv 且未配视觉模型时，App 会明确报「还没配置能看照片的模型…」，
而不是硬跑出 0 分。配置方式：设置页「能看图的模型」填一个 OpenAI 兼容的多模态端点
（如 `https://api.deepseek.com/v1` + `deepseek-flash` + 你的 Key）。

⚠️ **web 预览下直连会被 CORS 拦**（浏览器限制）。手机上 RN 的 fetch 不执行 CORS，
所以移动端正常、web 预览受限；web 上验证请走本机适配器（§2.0）。

### 2.0 切到 TypeSafe JEv（经本机适配器，一条命令）

```powershell
tools\use-jev.bat          # 切到 JEv
tools\use-jev.bat laya     # 切回本机 Laya
```

它只改 `.env.local` 里三个 `LAYA_*` 键（**不碰 App 的任何设置**），然后打印 App 该填什么。
改完重启适配器：`stop-outfit-decider.bat` → `start-outfit-decider.bat`。

**App 设置页填**：baseUrl 仍指适配器（真机 `http://<LAN IP>:8787`、模拟器 `http://127.0.0.1:8787`），
askPath `/ask`、healthPath `/health`，**模型名 `jev-latest`**，**API Key 留空**。

**为什么 Key 不填在 App 里**：App **从不直连 JEv**。App 发的是 `questions` **数组**，
而 JEv 文档要求 **map**（`id → {type, instructions, criteria}`）；这层翻译在适配器里，
Key 也只留在本机 `.env.local`，绝不下发到手机。

**要真正跑起来还需一行 Key**（没有它上游返回 401/403，这是预期而非故障）：

```
LAYA_API_KEY=<你的 TypeSafe key>      # https://console.typesafe.ai/keys
```

加进 `.env.local` 后重跑 `tools\use-jev.bat`。JEv 模式下 `/health` 只判断主机可达，
并把 401/403 标成 `authRequired: true` —— 不会把"缺 Key"假报成"服务挂了"。

**已验证到哪一步**（没 Key 时能验的都验了）：

```
适配器日志: laya-adapter listening on http://0.0.0.0:8787 -> https://api.typesafe.ai
[adapter] /ask -> 403 questions=6 ms=834
```

即请求形状被接受、真的抵达 `api.typesafe.ai/v1/systemone`，只因缺 Key 被拒。

设置页三个字段决定一切：

| 字段 | 说明 |
|---|---|
| 引擎模式 | **JEv 云端**（带 API Key 鉴权）/ **Laya 本地**（局域网，不带 Authorization） |
| baseUrl | 直接填 `192.168.1.5:8787` 也行，会自动补 `http://` 并去掉尾部 `/` |
| askPath / healthPath | 默认 `/ask` / `/health` |
| model | 逐字透传给服务端，**不做白名单**（异常场景靠它触发，见 §4） |
| API Key | 仅 JEv 模式使用；存 `expo-secure-store`（原生）。**Web 端降级存 AsyncStorage，界面会明确提示明文风险** |

### 2.0 接本机已部署的 Laya（实测可用，含一个必须知道的限制）

本机已装好真实的 Laya 决策模型（不是 mock）：

```powershell
# 一键起两个服务（两个窗口）
C:\博830\vibecoding\outfit-decider\tools\start-all.cmd

# 或者分开起：
C:\博830\vibecoding\laya-service\start-laya.cmd      # ① 决策模型 0.0.0.0:8000（加载约 30–60s）
cd C:\博830\vibecoding\outfit-decider
cmd /c "npm run laya"                                 # ② 协议适配器 0.0.0.0:8787
```

`start-all.cmd` 会自动起 laya-serve（新窗口）、等 20s、再起适配器。

**适配器会自己读取项目根的 `.env.local`**（已 gitignore，绝不入库），所以多模态端点与 Key
只需配一次、由适配器在服务端使用。设置页填：

| 字段 | 值 |
|---|---|
| 引擎模式 | **Laya 本地** |
| baseUrl | `http://127.0.0.1:8787`（手机填电脑局域网 IP，如 `http://192.168.1.4:8787`） |
| askPath / healthPath | `/ask` / `/health`（默认值即可） |
| model | 留空或随意；适配器让 Laya 自己路由检查点 |

> **设置页里「能看图的模型」那一组在直连本机适配器时可以不填。**
> 因为适配器已经用 `.env.local` 里的 `VISION_*` 在服务端完成了图片描述与纠正；
> 只有当你让 App **绕过适配器直连 DeepSeek** 时，才需要在设置页填 vision baseUrl/model/key。

**为什么不能把 baseUrl 直接指向 8000**：① 协议形状不同（Laya 的 `questions`/`answers` 是对象、
字段叫 `instructions`/`criteria`）；② `laya-serve` 不返回 CORS 头，浏览器端会被同源策略拦掉。
适配器（`tools/laya-adapter.mjs`）同时解决这两件事，并在未配视觉端点时用夹具占位描述兜底
（会显式标注"占位描述"，不假装看过图）。

> ⚠️ **务必读** `C:\博830\vibecoding\laya-service\README.md` §4：
> 本机 Laya **单独**判断穿搭的能力实测不合格（得体 vs 荒谬的综合分差只有 0.4，场场合适配度方向还是反的）。
> 所以本项目用「Laya 打分 + 多模态纠正」的分工，并把「结论来自谁」标在结果页上。
> 复现命令：`node tools/laya-chain-eval.mjs`（Laya 单独）与 `node tools/laya-real-review-eval.mjs`（含纠正）。

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

**三种对端，按需要选一个：**

| 对端 | 用途 | 启动 |
|---|---|---|
| `tools/mock-jev-server.mjs` | 测试替身（分数是哈希造的，6 种故障注入），跑验收门禁用 | `node tools/mock-jev-server.mjs` |
| `tools/laya-adapter.mjs` | 接**真实** Laya 决策模型（翻译 + CORS） | `cmd /c "npm run laya"`（需先起 laya-serve） |
| 你自己的服务端 | 直接按上面的形状实现 | — |

要自己实现，要么按这个形状回，**要么把 `tools/mock-jev-server.mjs` 当参考实现改**——它已经是本契约的对端。

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
cmd /c "npm test"        # = node --test "tests/**/*.test.js"  → 期望 151/0
cmd /c "npm run verify"  # = node tools/verify.mjs              → 期望 exit 0、12/12
cmd /c "npm run gate"    # 两者串联
```

> ⚠️ **跑 `verify.mjs` 之前必须先关掉自己的 Laya 服务（8000 / 8787）。**
> 否则 App 的默认 baseUrl（`http://127.0.0.1:8787`）会命中**你那个真实适配器**，
> 验收脚本的请求被它截走（例如 deep 报告请求拿到的是 Laya 的 score 答案），
> 门禁会以一堆看不懂的方式**假红**——我为此白查了很久。
> 关服务：`Get-NetTCPConnection -LocalPort 8787 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`
> （8000 同理）。verify 会自己拉起它需要的 mock。

一个只会在顺境下变绿的门禁等于没有门禁。本项目的验证包含**故障注入路径**（401 / 超时 / 非 JSON / 空内容 / 部分失败），
且 `artifacts/verify-report.json` 会明示本次故障注入走的是**真实 UI 路径**还是请求拦截，不允许"用拦截伪造通过"而不说明。

### 6.1 设置页的"视觉先行"闸门与门禁的关系（§3.11c）

设置页默认要求**先配能看图的模型**，之后决策模型组才可编辑。验收脚本不依赖外部视觉端点，
所以它走的是 `decision-gate-unlock`「仍然配置决策模型」这条**显式临时解锁**路径（这也是那条自救路径的实战用例）。
如果你改了闸门行为，记得同步 `tools/verify.mjs` 里那一步，否则 API Key 会存不进去、`keyPersisted` 变 false。
