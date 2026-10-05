# AGENTS.md · outfit-decider（出门穿什么）

移动端穿搭决策 App。双引擎：System One 直觉级极速打分（纯结构化 JSON，零解释文本），
System Two 多模态深度推理报告（三段式中文报告）。技术栈 Expo SDK 57 + React Native 0.86。

## 开发环境事实（已实测，勿重复探索）

- Node v24.18.0、npm 11.16.0；**npm registry 已配置为 `https://registry.npmmirror.com`**（国内镜像，装包用普通 `npm install` 即可）。
- PowerShell 禁止执行 `npm.ps1`：**用 `cmd /c "npm install"` 或 `npx.cmd`**，不要直接 `npm`。
- 本机 `C:\Android` 有 platform-tools/build-tools/platforms，JDK 17 可用，但**没有连接设备、没有安装模拟器**。
  因此真机验收走 `npx expo start --lan` + 手机 Expo Go 扫码；自动化验收走 web 端 headless Chrome。
- headless 浏览器验证用工作区里已有的：`C:/博830/vibecoding/格愈/node_modules/puppeteer-core` +
  `C:/Program Files/Google/Chrome/Application/chrome.exe`（固定 390×844 移动端视口）。
- 本机控制台是 GBK：**PowerShell 直接打印中文会乱码**。脚本一律"写 UTF-8 文件 + 用 read 工具看"，
  控制台只输出 ASCII 摘要。这是显示问题，不是文件内容问题。

## 不可违背的产品约束

1. 原始图片**只存在于内存**（base64 data URI），当次处理结束立即清空；任何情况下不写盘、不入库、
   不存历史、不上传第三方。历史记录只保存文字描述与分数。
2. API Key 只存本机（`expo-secure-store`，web 回退 AsyncStorage 并显式提示明文风险），
   绝不写入代码、日志、验证报告或 git。
3. System One 的返回值**只有 JSON 分数**，不得出现任何解释/评价/建议文本。
4. System Two 只基于图片可见内容与用户提供的 state 作答，不臆测身材、职业等未提及信息。
5. 图片转文字的描述只做客观描述，看不清写「未清晰显示」，禁止主观评价。

## 代码约定

- `src/core/**`、`src/data/**` 是**纯逻辑/纯数据**，禁止 import react / react-native / expo，
  这样才能用 `node --test "tests/**/*.test.js"` 直接跑（无需 jest）。
- 唯一的测试缝（seam）是 SPEC 里冻结的纯函数签名 + `node:test`，UI 不做组件级测试。
- 网络调用统一经 `src/engine/api.js`，`fetchImpl` 可注入；`tools/mock-jev-server.mjs` 是契约的对端。
- 所有中文文案集中在 `src/data/copy.js`（引擎/异常文案）与各 screen 内联（界面文案）。

## 取数与验证入口

```
cmd /c "npm install"
node --test "tests/**/*.test.js"        # 纯逻辑单测（注意：node 24 下 `node --test tests/` 会失败，必须用 glob）
node tools/mock-jev-server.mjs          # 契约对端（默认 0.0.0.0:8787）
node tools/verify.mjs                   # 全链路验收：起 mock + expo export web + puppeteer 冒烟
```

任何一个门禁失败都算未完成，不允许"先提交后修"。验收报告写在 `artifacts/verify-report.json`。
