#!/usr/bin/env node
/**
 * tools/verify.mjs — SPEC §7 验收门禁（12 条断言）全链路自动化
 *
 * 流程：起 mock（或复用 8787 上已有的）→ `npx expo export --platform web` → 静态服务 →
 *       puppeteer-core + Chrome 走 390x844@2 → 截图 artifacts/screens/*.png →
 *       写 artifacts/verify-report.json（UTF-8）→ 失败 exit 1。
 *
 * 原则：**不允许假装绿**。任何一条断言拿不到数据或校验不过，都会以 ok:false + 原因进报告，
 * 并计入 assertErrors；报告里同时保留 stepErrors（流程异常）与原始证据片段。
 * 控制台只输出 ASCII 摘要，中文全部写进报告文件（本机控制台 GBK）。
 *
 * 用法：node tools/verify.mjs
 * 常用开关（环境变量）：
 *   OD_SKIP_EXPORT=1   跳过 expo export（dist/ 已存在时快速重跑）
 *   OD_PORT=8081       静态服务起始端口
 *   OD_KEEP_OPEN=1     不关闭浏览器/静态服务（调试用）
 */

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startStaticServer, findFreePort } from './run-expo-web.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const SHOTS = path.join(ARTIFACTS, 'screens');
const LOGS = path.join(ARTIFACTS, 'logs');
const REPORT_PATH = path.join(ARTIFACTS, 'verify-report.json');
const DIST = path.join(ROOT, 'dist');

const MOCK_PORT = 8787;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

const SCORE_IDS = [
  'overall_score',
  'aesthetic_score',
  'scene_score',
  'figure_score',
  'style_score',
  'practical_score',
];
const LOOK_IDS = ['look1', 'look2', 'look3', 'look4'];

/** SPEC §5.1 逐字文案（断言 9 用） */
const COPY = {
  auth: 'API Key 不正确或没有权限，请在设置页检查 API Key 配置',
  timeout: '等待超时了，深度分析在弱网下会更慢，可以先看快速评分',
  weaknet: '当前网络较慢，建议先用快速评分；深度分析可能要多等一会儿',
};

/**
 * 隐私加强断言用的哨兵串：会被真的填进设置页的 API Key 输入框，
 * 之后断言它绝不出现在 probe 序列化结果与验证报告里（SPEC §3.10）。
 */
const API_KEY_SENTINEL = 'od-verify-sentinel-key-9f13c7d2';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ 工具 */

function ensureDirs() {
  for (const d of [ARTIFACTS, SHOTS, LOGS]) fs.mkdirSync(d, { recursive: true });
}

function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 40).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/apikey|api_key|authorization|bearer|token/i.test(k) && !/tokens$/.test(k)) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (value.length > 2000) return `${value.slice(0, 400)}...[truncated ${value.length} chars]`;
    return value;
  }
  return value;
}

async function fetchJson(url, opts = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: '', error: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------- puppeteer */

async function loadPuppeteer() {
  try {
    const mod = await import('puppeteer-core');
    return { puppeteer: mod.default ?? mod, source: 'puppeteer-core (project dep)' };
  } catch (err) {
    const fallback = 'C:/博830/vibecoding/格愈/node_modules/puppeteer-core';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(fallback, 'package.json'), 'utf8'));
      const entry = path.join(fallback, pkg.module || pkg.main);
      const mod = await import(pathToFileURL(entry).href);
      return { puppeteer: mod.default ?? mod, source: `absolute fallback (${entry})` };
    } catch (err2) {
      throw new Error(`cannot load puppeteer-core: ${err.message} / fallback: ${err2.message}`);
    }
  }
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/* ---------------------------------------------------------------- mock */

/** 端口是否空闲（能 listen 就空闲） */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

/**
 * 起契约对端。
 * 首选 8787（= App 的 DEFAULT_CONFIG.baseUrl，最贴近真实默认路径）；
 * 若 8787 已被别的 agent/脚本占用（本项目并行开发时很常见，且对方可能随时退出），
 * 就改用一个**专用空闲端口**，稍后在设置页用 SPEC v1.1 的 `engine-baseurl` 指过去，
 * 这样整轮验收是自洽的，不会被别人掐断。
 */
async function ensureMock(report) {
  const entry = path.join(__dirname, 'mock-jev-server.mjs');
  const dedicated = !(await isPortFree(MOCK_PORT));
  const port = dedicated ? await findFreePort(8790) : MOCK_PORT;
  const baseUrl = `http://127.0.0.1:${port}`;

  const proc = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '0.0.0.0' },
    stdio: 'ignore',
    windowsHide: true,
  });
  let last = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    last = await fetchJson(`${baseUrl}/health`, {}, 2000);
    if (last.status === 200 && last.json?.ok === true) {
      report.env.mock = { url: baseUrl, port, spawned: true, dedicated, health: last.json };
      return { proc, baseUrl, port, dedicated };
    }
  }
  report.env.mock = { url: baseUrl, port, spawned: true, dedicated, error: last?.error || `status ${last?.status}` };
  return { proc, baseUrl, port, dedicated };
}

/* ------------------------------------------------------------ expo export */

function runExpoExport(report) {
  const outLabel = 'dist';
  if (process.env.OD_SKIP_EXPORT === '1' && fs.existsSync(path.join(DIST, 'index.html'))) {
    report.env.expoExport = { mode: 'skipped (OD_SKIP_EXPORT=1)', ok: true };
    return Promise.resolve(true);
  }

  const logPath = path.join(LOGS, 'expo-export.log');
  const cmdline = 'npx expo export --platform web --output-dir dist';

  const attempt = (n) =>
    new Promise((resolve) => {
      const log = fs.createWriteStream(logPath, { flags: n === 1 ? 'w' : 'a' });
      log.write(`\n=== attempt ${n}: ${cmdline} (cwd=${ROOT}) ===\n`);
      const child = spawn(cmdline, {
        cwd: ROOT,
        env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', BROWSER: 'none' },
        shell: true,
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        log.write('\n=== TIMEOUT after 900s, killing ===\n');
        child.kill();
      }, 900000);
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      child.on('close', (code) => {
        clearTimeout(timer);
        log.end(() => resolve(code));
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        log.write(`\n=== spawn error: ${err.message} ===\n`);
        log.end(() => resolve(-1));
      });
    });

  return (async () => {
    let code = await attempt(1);
    if (code !== 0) {
      // 与并发的 Metro/export 抢缓存时偶发失败：等 30s 重试一次（不动配置）
      await sleep(30000);
      code = await attempt(2);
    }
    const ok = code === 0 && fs.existsSync(path.join(DIST, 'index.html'));
    report.env.expoExport = { mode: 'built', ok, exitCode: code, log: path.relative(ROOT, logPath), out: outLabel };
    return ok;
  })();
}

/* ------------------------------------------------------------ 页面辅助 */

async function readProbe(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="probe-json"]');
    if (el) {
      const raw = el.textContent || '';
      try {
        return JSON.parse(raw);
      } catch {
        /* fall through to global */
      }
    }
    return window.__OD_PROBE__ ?? null;
  });
}

/** 读取 probe 里的某个表达式（与 waitProbe 同一套求值方式）。 */
async function probeValue(page, expr) {
  return page.evaluate((src) => {
    const p = window.__OD_PROBE__;
    if (!p) return null;
    try {
      // eslint-disable-next-line no-new-func
      return new Function('p', `return (${src});`)(p);
    } catch {
      return null;
    }
  }, expr);
}

async function waitProbe(page, expr, timeout = 30000) {
  await page.waitForFunction(
    (src) => {
      const p = window.__OD_PROBE__;
      if (!p) return false;
      try {
        // eslint-disable-next-line no-new-func
        return !!new Function('p', `return (${src});`)(p);
      } catch {
        return false;
      }
    },
    { timeout, polling: 200 },
    expr,
  );
}

async function exists(page, selector) {
  return (await page.$(selector)) !== null;
}

async function clickTestId(page, id, timeout = 15000) {
  const sel = `[data-testid="${id}"]`;
  await page.waitForSelector(sel, { timeout });
  try {
    await page.click(sel);
  } catch {
    // 元素被滚动容器裁剪时退化为 DOM click
    await page.$eval(sel, (el) => el.click());
  }
}

/**
 * SPEC §3.13b · 显式选择本次跑哪个系统。
 *
 * 产品默认档是 `deep`，而上传页的 CTA 按当前档位分派 —— 所以任何"想跑 System One"
 * 的步骤都必须先显式切到 quick，否则点下去跑的是 System Two。
 * 选择器不存在时静默跳过（兼容未实现该控件的历史构建），返回是否真的选中。
 */
async function selectSystemMode(page, mode) {
  const id = `system-mode-${mode}`;
  if (!(await exists(page, `[data-testid="${id}"]`))) return false;
  await clickTestId(page, id);
  // 等选中态落地，避免紧接着的 CTA 点击读到旧档位
  await page
    .waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true';
      },
      { timeout: 5000 },
      `[data-testid="${id}"]`,
    )
    .catch(() => {});
  await sleep(250);
  return true;
}

async function textOf(page, selector) {
  try {
    return await page.$eval(selector, (el) => (el.innerText || el.textContent || '').trim());
  } catch {
    return null;
  }
}

async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await sleep(500);
  await page.screenshot({ path: file, type: 'png' });
  return file;
}

async function readStorage(page) {
  return page.evaluate(() => {
    const out = {};
    for (const storeName of ['localStorage', 'sessionStorage']) {
      try {
        const store = window[storeName];
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          out[`${storeName}:${k}`] = store.getItem(k);
        }
      } catch {
        /* ignore */
      }
    }
    return out;
  });
}

async function pickImages(page, files) {
  const chooserPromise = page.waitForFileChooser({ timeout: 20000 }).catch(() => null);
  await clickTestId(page, 'pick-images');
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.accept(files);
    return 'filechooser';
  }
  const input = await page.$('input[type="file"]');
  if (input) {
    await input.uploadFile(...files);
    return 'input[type=file]';
  }
  throw new Error('no file chooser and no input[type=file] found');
}

/** 把 storage 里的历史记录解析出来（键名含 od.history.v1） */
function pickHistory(dump) {
  const entry = Object.entries(dump || {}).find(([k]) => k.includes('od.history.v1'));
  if (!entry) return [];
  try {
    const v = JSON.parse(entry[1]);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 轮询 storage，直到出现匹配的键（AsyncStorage 写入是异步的） */
async function pollStorage(page, { attempts = 12, intervalMs = 500, match = 'od.history.v1' } = {}) {
  let last = {};
  for (let i = 0; i < attempts; i++) {
    // eslint-disable-next-line no-await-in-loop
    last = await readStorage(page);
    if (Object.keys(last).some((k) => k.includes(match))) return last;
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
  return last;
}

/**
 * 轮询 banner-error 的**文本**直到命中期望文案（而不是只等元素出现）。
 * 只等元素会出现"上一轮的旧 banner 还在 → 立刻命中 → 拿到旧文案"的假红/假绿，
 * 这是 #9 在对抗式复核里偶发 timeout=false 的根因。
 * 返回 {text, elapsedMs, matched}，elapsed 会写进报告，便于判断窗口是否给够。
 */
async function waitBannerText(page, mustInclude, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    last = await textOf(page, '[data-testid="banner-error"]');
    if (typeof last === 'string' && last.includes(mustInclude)) {
      return { text: last, elapsedMs: Date.now() - t0, matched: true };
    }
    if (Date.now() - t0 >= timeoutMs) {
      return { text: last, elapsedMs: Date.now() - t0, matched: false };
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(300);
  }
}

/** 往受控输入框里填值（React 受控组件必须用真实键盘事件） */
async function setInputValue(page, testId, value) {
  const sel = `[data-testid="${testId}"]`;
  await page.waitForSelector(sel, { timeout: 15000 });
  // 关键：禁用的输入框会让下面的点击/打字**静默无效**，调用方却以为注入成功——
  // 那会产出"假证据"（本轮 §3.11c 的闸门就制造过这个陷阱）。
  // 所以这里先查 DOM 的 disabled/aria-disabled，禁用就直接抛错。
  const disabled = await page.$eval(sel, (el) => {
    const tag = el.tagName;
    const nativeDisabled = el.disabled === true || (tag === 'INPUT' && el.readOnly === true);
    return nativeDisabled || el.getAttribute('aria-disabled') === 'true';
  }).catch(() => false);
  if (disabled) throw new Error(`input ${testId} is disabled`);

  await page.click(sel, { clickCount: 3 });
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  if (value) await page.keyboard.type(value, { delay: 8 });
  await sleep(200);

  // 回读一次：值没变说明注入其实没生效（比上面的 disabled 更兜底）
  const actual = await page.$eval(sel, (el) => (el.value === undefined ? el.textContent : el.value)).catch(() => null);
  if (value && actual !== value && !String(actual || '').includes(value)) {
    throw new Error(`input ${testId} did not take the value (got ${JSON.stringify(String(actual || '').slice(0, 40))})`);
  }
}

/** 跑纯逻辑单测（node 24 下必须用 glob，目录形式会失败），返回真实 pass/fail 数 */
function runUnitTests() {
  return new Promise((resolve) => {
    const cmdline = 'node --test "tests/**/*.test.js"';
    const logPath = path.join(LOGS, 'unit-tests.log');
    const log = fs.createWriteStream(logPath, { flags: 'w' });
    const child = spawn(cmdline, { cwd: ROOT, shell: true, windowsHide: true, env: process.env });
    let buf = '';
    const timer = setTimeout(() => child.kill(), 300000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      log.write(d);
    });
    child.stderr.on('data', (d) => {
      buf += d.toString();
      log.write(d);
    });
    const done = (result) => log.end(() => resolve(result));
    child.on('close', (code) => {
      clearTimeout(timer);
      // node:test 的两种输出格式都要兼容：TAP `# pass 12` / spec `ℹ pass 12`
      const num = (label) => {
        const m = buf.match(new RegExp(`^\\s*(?:#|\\u2139)\\s*${label}\\s+(\\d+)`, 'm'));
        return m ? Number(m[1]) : -1;
      };
      done({
        command: cmdline,
        exitCode: code,
        pass: num('pass'),
        fail: num('fail'),
        total: num('tests'),
        log: path.relative(ROOT, logPath),
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ command: cmdline, exitCode: -1, pass: -1, fail: -1, total: -1, error: err.message });
    });
  });
}

/* ---------------------------------------------------------------- main */

async function main() {
  ensureDirs();
  const startedAt = Date.now();
  const report = {
    ok: false,
    spec: 'docs/SPEC.md §7',
    startedAt: nowIso(),
    finishedAt: null,
    durationMs: 0,
    env: { node: process.version, platform: `${os.platform()} ${os.arch()}`, cwd: ROOT },
    assertions: [],
    assertErrors: [],
    extras: [],
    extraErrors: [],
    consoleErrors: 0,
    pageErrors: 0,
    consoleErrorDetails: [],
    pageErrorDetails: [],
    resourceErrors: [],
    thirdPartyWarnings: [],
    consoleWarnings: [],
    stepErrors: [],
    screenshots: {},
    evidence: {},
  };

  const state = {
    mockOk: false,
    probe: null,
    probeReady: false,
    domRanks: null,
    cardDims: null,
    __faultPhase: false,
    scoreExchanges: [],
    deepExchanges: [],
    compareText: null,
    compareLabels: { quick: false, deep: false },
    deepDomPresent: false,
    storage: {},
    history: [],
    historyAfterQuick: [],
    historyAfterTab: {},
    // 时序正确的 Key 隐私取证（Lead 要求）：保存后 / 运行中 / 结束后
    keyEntered: false,
    keyPersisted: false,
    keyStorageAfterSave: {},
    keyStorageFinal: {},
    consoleTexts: [],
    allExchanges: [],
    authBanner: null,
    timeoutBanner: null,
    weaknetBanner: null,
    screenshots: [],
  };

  let mockProc = null;
  let server = null;
  let browser = null;
  let puppeteerInfo = null;
  let mockBase = MOCK_BASE;

  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      const msg = `${name}: ${err && err.message ? err.message : String(err)}`;
      report.stepErrors.push(msg);
      process.stdout.write(`[step-error] ${name}\n`);
      return null;
    }
  };

  try {
    /* 1. mock */
    const mock = await step('start mock', async () => {
      const r = await ensureMock(report);
      return r;
    });
    mockProc = mock?.proc ?? null;
    mockBase = mock?.baseUrl ?? MOCK_BASE;
    state.mockBase = mockBase;
    state.mockDedicated = !!mock?.dedicated;
    const health = await step('mock health', () => fetchJson(`${mockBase}/health`, {}, 5000));
    // 确认对面是**我们的** mock（/spec 契约结构），端口上别的服务不能冒充断言 1
    const mockSpec = await step('mock spec', () => fetchJson(`${mockBase}/spec`, {}, 5000));
    const contractSpec = Array.isArray(mockSpec?.json?.scoreQuestionIds) && mockSpec.json.scoreQuestionIds.length === 6;
    state.mockOk = health?.status === 200 && health.json?.ok === true && contractSpec;
    state.contractSpec = contractSpec;
    report.evidence.mockHealth = health ? { status: health.status, body: health.json } : null;
    report.evidence.mockContractSpec = contractSpec;
    report.evidence.mockBase = mockBase;

    /* 2. expo export */
    const exported = await step('expo export', () => runExpoExport(report));

    /* 3. static server */
    const port = await findFreePort(Number(process.env.OD_PORT || 8081));
    server = await step('static server', () => startStaticServer({ root: DIST, port }));
    report.env.webUrl = server?.url ?? null;

    /* 4. puppeteer */
    const { puppeteer, source } = await loadPuppeteer();
    puppeteerInfo = source;
    report.env.puppeteer = source;
    const chrome = findChrome();
    report.env.chrome = chrome;
    if (!chrome) throw new Error('Chrome executable not found');
    if (!exported || !server) throw new Error('export or static server unavailable; skipping browser phase');

    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--hide-scrollbars',
        '--window-size=390,844',
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(30000);

    /* 4a. 监听 */
    page.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();
      const loc = (msg.location && msg.location().url) || '';
      // 全量 console 文本只在内存里累积，用于「Key 明文是否进过日志」的取证（不写进报告，避免膨胀）
      state.consoleTexts.push(`${type}: ${text}`);
      if (type === 'error') {
        if (/^Failed to load resource/i.test(text)) {
          // 浏览器自己打的网络层日志（含 404 favicon 与我们故意注入的 401），
          // 不是 App 调用 console.error —— 单独计数，但完整记录在报告里，不隐藏
          report.resourceErrors.push({
            text,
            url: loc,
            duringFaultInjection: !!state.__faultPhase,
          });
        } else if (/favicon|apple-touch-icon|\.map$/i.test(loc)) {
          report.thirdPartyWarnings.push({ type, text, url: loc });
        } else {
          report.consoleErrorDetails.push({ text, url: loc });
        }
      } else if (type === 'warning') {
        if (/DevTools|Download the React/i.test(text)) report.thirdPartyWarnings.push({ type, text, url: loc });
        else report.consoleWarnings.push({ type, text, url: loc });
      }
    });
    page.on('pageerror', (err) => {
      report.pageErrors += 1;
      report.pageErrorDetails.push({ text: String(err && err.message ? err.message : err) });
    });
    page.on('requestfailed', (req) => {
      const url = req.url();
      report.thirdPartyWarnings.push({ type: 'requestfailed', text: `${req.failure()?.errorText}`, url });
    });

    const exchanges = [];
    state.allExchanges = exchanges;

    /**
     * 从请求 state 文本里认出是哪一套（【穿搭一】…【穿搭四】）。
     * 批处理下 request.state 不存在（每套的 state 在 looks[] 里），但展开后的 per-look 记录
     * 会带上 lookId，所以这只是**兜底**路径。
     */
    function lookIdFromStateText(stateText) {
      const hit = String(stateText || '').match(/【穿搭\s*([一二三四1234])】/);
      if (!hit) return null;
      const index = ['一', '二', '三', '四'].indexOf(hit[1]);
      const digit = Number(hit[1]);
      if (index >= 0) return `look${index + 1}`;
      if (Number.isFinite(digit) && digit >= 1 && digit <= 4) return `look${digit}`;
      return null;
    }

    /**
     * 批处理请求 → 「某一套自己的」请求形状（state + questions）。
     * `score-coherence` 是靠请求 state 里的【穿搭N】段头认 lookId 的，
     * 批处理把多套塞在一个 body 里，所以必须还原成单套形状，否则那条交叉校验会认不出（本轮踩过）。
     */
    function lookRequestsOf(batchRequest, lookId) {
      const looks = Array.isArray(batchRequest?.looks) ? batchRequest.looks : [];
      const hit = looks.find((look) => look && String(look.lookId) === String(lookId));
      const fallback = looks[0];
      const chosen = hit || fallback || {};
      return {
        model: batchRequest?.model,
        state: chosen.state,
        questions: chosen.questions,
        images: chosen.images,
        _fromBatch: true,
      };
    }
    page.on('response', async (res) => {
      const url = res.url();
      // v1.6 起打分走批处理：/ask/batch 必须和 /ask 一起被记录，
      // 否则 scoreExchanges 恒为 0，#2/#3 的形状断言会**假红**（本轮踩过）。
      if (!/\/ask(\/batch)?(\?|$)/.test(url)) return;
      const entry = {
        url,
        status: res.status(),
        contentType: res.headers()['content-type'] || '',
        isBatch: /\/ask\/batch(\?|$)/.test(url),
      };
      const reqData = res.request()?.postData?.();
      if (reqData) {
        try {
          entry.request = JSON.parse(reqData);
        } catch {
          entry.request = { _raw: reqData.slice(0, 200) };
        }
      }
      // 鉴权头只记掩码形态：既证明 Key 确实随请求发出，又绝不让明文进报告
      const auth = res.request()?.headers?.()?.authorization;
      if (auth) entry.authHeaderMasked = String(auth).replace(/^(Bearer)\s+\S+/i, '$1 ***');
      try {
        entry.raw = await res.text();
        try {
          entry.body = JSON.parse(entry.raw);
        } catch {
          /* not json */
        }
      } catch (err) {
        entry.readError = String(err && err.message ? err.message : err);
      }

      // 批处理请求体里没有顶层 questions：每套各自带一份，取第一套的代表形状
      const firstLook = Array.isArray(entry.request?.looks) ? entry.request.looks[0] : null;
      const qs = Array.isArray(entry.request?.questions)
        ? entry.request.questions
        : (firstLook && Array.isArray(firstLook.questions) ? firstLook.questions : null);
      if (Array.isArray(qs)) {
        entry.kind = qs.some((q) => String(q?.id || '').startsWith('describe_'))
          ? 'describe'
          : qs.length && String(qs[0]?.id) === 'deep_report'
            ? 'deep'
            : qs.every((q) => q?.type === 'score')
              ? 'score'
              : 'other';
      }
      exchanges.push(entry);
      if (entry.kind === 'score') {
        if (entry.isBatch && Array.isArray(entry.body?.looks)) {
          // 批处理：一次响应对应多套。**只**记录展开后的"一套一份答案"，
          // 不要再把批处理本身也 push 进 scoreExchanges —— 否则数量翻倍（本轮踩过），
          // 而 #2/#3 要的是"每套恰好一条打分记录"。
          for (const look of entry.body.looks) {
            const perLook = {
              url: `${url}#${look.lookId}`,
              status: entry.status,
              contentType: entry.contentType,
              isBatch: true,
              lookId: look.lookId,
              // request 里保留**该套自己的 state 与 questions**，让靠 state 段头找 lookId 的
              // 交叉校验（score-coherence）在批处理下依然成立
              request: lookRequestsOf(entry.request, look.lookId),
              body: { model: look.model, answers: look.answers, usage: look.usage },
              raw: JSON.stringify({ model: look.model, answers: look.answers, usage: look.usage }),
            };
            exchanges.push(perLook);
            state.scoreExchanges.push(perLook);
          }
          state.batchRequests = (state.batchRequests || 0) + 1;
        } else {
          state.scoreExchanges.push(entry);
        }
      }
      if (entry.kind === 'deep') state.deepExchanges.push(entry);
    });

    /* 5. 首屏 + capture 截图 */
    await step('goto app', async () => {
      await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await waitProbe(page, 'p.ready === true', 60000);
      state.probeReady = true;
    });
    await step('capture screenshot', async () => {
      state.screenshots.push(await shot(page, 'capture'));
    });

    /* 6. 选图（4 套 fixture） */
    const imageFiles = LOOK_IDS.map((id) => path.join(ROOT, 'fixtures', 'images', `${id}.jpg`));
    const missingImages = imageFiles.filter((f) => !fs.existsSync(f));
    if (missingImages.length) throw new Error(`missing fixtures: ${missingImages.join(', ')}`);
    await step('pick images', async () => {
      // §7.11 · 分次选图必须**累加**，不能互相冲掉。
      // 先单独选 1 张，再选其余 3 张 —— 这正是用户实测"只能上传一张"的路径。
      // 之前 pickImages 直接替换全部 artifacts，第二次选图会把第一次的冲掉；
      // 而一次性 uploadFile(4 张) 是测不出这个 bug 的（它本来就走一次替换）。
      const first = imageFiles.slice(0, 1);
      const rest = imageFiles.slice(1);
      await pickImages(page, first);
      await waitProbe(page, '(Array.isArray(p.looks) ? p.looks.length : p.looks) >= 1', 30000);
      const afterFirst = await probeValue(page, '(Array.isArray(p.looks) ? p.looks.length : p.looks)');
      await pickImages(page, rest);
      await waitProbe(page, '(Array.isArray(p.looks) ? p.looks.length : p.looks) >= 4', 30000);
      const afterSecond = await probeValue(page, '(Array.isArray(p.looks) ? p.looks.length : p.looks)');
      state.pickAccumulated = {
        afterFirst: Number(afterFirst),
        afterSecond: Number(afterSecond),
      };
      report.evidence.imagePicker = 'input[type=file] x2 (sequential)';
    });

    /* 7. 状态 chips + 内置问题 */
    await step('select chips', async () => {
      await clickTestId(page, 'chip-occasion-commute');
      await clickTestId(page, 'chip-weather-cool');
      await clickTestId(page, 'chip-style-minimal');
      await clickTestId(page, 'chip-question-best_for_occasion');
      await sleep(200);
      state.screenshots.push(await shot(page, 'capture'));
    });

    /* 7b. 保存 API Key +（必要时）把 baseUrl 指向本轮自有的 mock —— 都必须在跑评分**之前**：
           前者才能证明「Key 在 web 上确实落进 od.apikey.v1」且「运行期间没泄漏」；
           后者保证 8787 被别的 agent 占用时本轮验收依然自洽。 */
    await step('settings: baseUrl + api key (before scoring)', async () => {
      await clickTestId(page, 'tab-settings');
      await sleep(500);

      // SPEC §3.11c：设置页默认"视觉先行"——视觉未就绪时决策组不可编辑。
      // 本轮验收不依赖外部视觉端点，所以走**显式临时解锁**（这正是那条自救路径的实战用例）。
      // 不加这一步的话：engine-apikey 被禁用 → Key 存不进去 → #8 的 keyPersisted 会红，
      // 而且 engine-baseurl 会被"静默注入失败却记为已注入"（假证据）。
      if (await exists(page, '[data-testid="decision-gate-unlock"]')) {
        try {
          await clickTestId(page, 'decision-gate-unlock');
          await sleep(300);
        } catch (err) {
          report.stepErrors.push(`decision-gate-unlock failed: ${err.message}`);
        }
      }

      /**
       * SPEC §3.10d：App 的 `baseUrl` 默认值是**空**的（故意 —— 默认 127.0.0.1 对真机
       * 是错的地址，而且电脑 IP 会变）。所以门禁**必须显式注入**本轮 mock 的地址，
       * 不能再依赖"回落到 127.0.0.1:8787"那条老路径。
       *
       * 注入失败必须**大声失败**：以前它会静默回落，于是 baseUrl 为空却仍然
       * 记为已注入（假证据），下游断言拿到的是一轮根本没发出请求的运行。
       */
      try {
        await setInputValue(page, 'engine-baseurl', mockBase);
        state.baseUrlInjected = true;
      } catch (err) {
        state.baseUrlInjected = false;
        report.stepErrors.push(`FATAL engine-baseurl 注入失败（baseUrl 默认为空，不能回落）: ${err.message}`);
      }
      if (!state.baseUrlInjected) {
        throw new Error('engine-baseurl 注入失败：baseUrl 默认是空值，没有可回落的默认地址');
      }

      /**
       * SPEC §3.9c v1.7：产品默认档已改为 `multimodal_only`（Laya 降级为可选实验），
       * 而那一档需要**能看图的模型**才能出分。本轮验收用 mock 只提供决策端点，
       * 所以必须显式选「仅本地直接打分」这一档，否则 System One 根本不会产出六维分，
       * #2/#3/#10 会集体红（实测就是这样发现的）。
       *
       * 这一步也顺带覆盖了"实验档可选"这个新行为。
       */
      await clickTestId(page, 'engine-mode-laya-only');
      await sleep(300);

      await setInputValue(page, 'engine-apikey', API_KEY_SENTINEL);      state.keyEntered = true;
      await clickTestId(page, 'btn-save-key');
      await sleep(400);
      state.keyStorageAfterSave = await pollStorage(page, { attempts: 10, intervalMs: 400, match: 'od.apikey.v1' });
      state.keyPersisted = Object.entries(state.keyStorageAfterSave).some(
        ([k, v]) => k.includes('od.apikey.v1') && v === API_KEY_SENTINEL,
      );
      await clickTestId(page, 'tab-capture');
      await sleep(300);
    });

    /* 8. 跑 System One */
    await step('run quick', async () => {
      // SPEC §3.13b：上传页的 CTA 会按当前档位分派，而**产品默认档是 deep**。
      // 所以这一步必须先显式切到 quick，否则点下去跑的是 System Two，
      // probe.quick 永远不出现 -> 这里会 90s 超时（实测踩过）。
      await selectSystemMode(page, 'quick');
      await clickTestId(page, 'submit-quick');
      await waitProbe(page, 'p.quick && Array.isArray(p.quick.ranked) && p.quick.ranked.length > 0', 90000);
      await waitProbe(page, "p.tab === 'result' || p.quick", 15000);
    });

    /* 9. 结果页证据 */
    await step('result evidence', async () => {
      // 结果页是 tab1 的推进态：主动切一次 tab-result，避免依赖自动跳转
      try {
        await clickTestId(page, 'tab-result', 6000);
      } catch {
        /* 没有独立 tab 就继续 */
      }
      await page.waitForSelector('[data-testid="result-card"]', { timeout: 30000 });
      await sleep(400);
      state.domRanks = await page.$$eval('[data-testid="result-card"]', (els) =>
        els.map((e) => e.getAttribute('data-rank')),
      );
      // 每张卡的维度行与分数（§7.2「每套恰好 6 个维度」在 DOM 侧的证据）
      state.cardDims = await page.$$eval('[data-testid="result-card"]', (els) =>
        els.map((el) => ({
          rank: el.getAttribute('data-rank'),
          dimRows: el.querySelectorAll('[data-testid="dim-row"]').length,
          scores: [...el.querySelectorAll('[data-testid="score-value"]')].map((n) => (n.textContent || '').trim()),
        })),
      );
      state.screenshots.push(await shot(page, 'result'));
      state.historyAfterQuick = await pollStorage(page);
    });

    /* 10. System Two */
    await step('run deep', async () => {
      await clickTestId(page, 'deep-run');
      await page.waitForSelector('[data-testid="deep-report"]', { timeout: 90000 });
      state.deepDomPresent = true;
      await sleep(600);
    });

    /* 11. 同屏对比（断言 6 的证据必须严格来自 compare-view 容器自身） */
    await step('compare view', async () => {
      await clickTestId(page, 'compare-toggle');
      await page.waitForSelector('[data-testid="compare-view"]', { timeout: 30000 });
      await sleep(700);
      // 容器自身的 textContent（不是整页、不是父级）
      state.compareText = await page.$eval('[data-testid="compare-view"]', (el) => el.textContent || '');
      state.compareHtmlLen = state.compareText.length;
      // 让对比区完整入镜：按元素边界单独截一张
      try {
        const el = await page.$('[data-testid="compare-view"]');
        if (el) {
          state.compareBox = await el.boundingBox();
          const p = path.join(SHOTS, 'compare-view.png');
          await el.screenshot({ path: p, type: 'png' });
          state.screenshots.push(p);
          state.compareViewShot = path.relative(ROOT, p);
        }
      } catch (err) {
        report.stepErrors.push(`compare-view element screenshot: ${err.message}`);
      }
      await sleep(300);
      state.screenshots.push(await shot(page, 'compare'));
    });

    /* 12. 历史 */
    await step('history tab', async () => {
      await clickTestId(page, 'tab-history');
      await sleep(600);
      state.screenshots.push(await shot(page, 'history'));
      state.historyAfterTab = await pollStorage(page);
    });

    /* 13. 设置（截图。API Key 已在 7b 保存过） */
    await step('settings tab', async () => {
      await clickTestId(page, 'tab-settings');
      await sleep(600);
      state.screenshots.push(await shot(page, 'settings'));
    });

    /* 14. 存储隐私 dump */
    await step('storage dump', async () => {
      state.storage = await readStorage(page);
    });

    /* 15. probe 快照 */
    await step('probe snapshot', async () => {
      state.probe = await readProbe(page);
    });

    /* 16. 异常注入（§7.9）：**优先走设置页真实 UI 路径**（SPEC v1.1 的 engine-model），
           UI 路径不可用时才退化为 CDP 请求拦截改写 model；实际路径写进报告。 */
    await step('fault injection', async () => {
      state.__faultPhase = true;
      const handler = (req) => {
        const inject = state.__injectModel;
        if (inject && req.method() === 'POST' && /\/ask(\/batch)?(\?|$)/.test(req.url())) {
          try {
            const body = JSON.parse(req.postData() || '{}');
            body.model = inject;
            req.continue({ postData: JSON.stringify(body) });
            return;
          } catch {
            /* fall through */
          }
        }
        req.continue().catch(() => {});
      };
      const enableInterception = async () => {
        if (state.__interceptionOn) return;
        state.__interceptionOn = true;
        await page.setRequestInterception(true);
        page.on('request', handler);
      };
      const runQuickExpectBanner = async (expectedCopy, timeoutMs) => {
        await clickTestId(page, 'tab-capture');
        await sleep(300);
        // 同上：默认档是 deep，这里要的是 System One 的异常横幅，必须显式切档
        await selectSystemMode(page, 'quick');
        await clickTestId(page, 'submit-quick');
        return waitBannerText(page, expectedCopy, timeoutMs);
      };
      const setModelViaUi = async (model) => {
        await clickTestId(page, 'tab-settings');
        await sleep(400);
        await setInputValue(page, 'engine-model', model);
        state.modelInputAvailable = true;
      };

      const path_ = [];

      // --- auth ---（窗口给足：UI 路径 + 兜底路径各 90s）
      try {
        await setModelViaUi('test-auth-fail');
        const r = await runQuickExpectBanner(COPY.auth, 90000);
        state.authBanner = r.text;
        state.authElapsedMs = r.elapsedMs;
        if (r.matched) path_.push('ui(engine-model=test-auth-fail)');
      } catch (err) {
        report.stepErrors.push(`auth via settings UI: ${err.message}`);
      }
      if (!state.authBanner || !state.authBanner.includes(COPY.auth)) {
        await enableInterception();
        state.__injectModel = 'test-auth-fail';
        const r = await runQuickExpectBanner(COPY.auth, 90000);
        state.authBanner = r.text;
        state.authElapsedMs = r.elapsedMs;
        path_.push('intercept(model=test-auth-fail)');
      }
      state.screenshots.push(await shot(page, 'error-auth'));

      // --- timeout + weaknet ---（20s 超时 × 可能重试 1 次，窗口给到 180s）
      try {
        await setModelViaUi('test-timeout');
        const r = await runQuickExpectBanner(COPY.timeout, 180000);
        state.timeoutBanner = r.text;
        state.timeoutElapsedMs = r.elapsedMs;
        if (r.matched) path_.push('ui(engine-model=test-timeout)');
      } catch (err) {
        report.stepErrors.push(`timeout via settings UI: ${err.message}`);
      }
      if (!state.timeoutBanner || !state.timeoutBanner.includes(COPY.timeout)) {
        await enableInterception();
        state.__injectModel = 'test-timeout';
        const r = await runQuickExpectBanner(COPY.timeout, 180000);
        state.timeoutBanner = r.text;
        state.timeoutElapsedMs = r.elapsedMs;
        path_.push('intercept(model=test-timeout)');
      }
      try {
        const t0 = Date.now();
        await page.waitForSelector('[data-testid="banner-weaknet"]', { timeout: 90000 });
        state.weaknetBanner = await textOf(page, '[data-testid="banner-weaknet"]');
        state.weaknetElapsedMs = Date.now() - t0;
      } catch {
        state.weaknetBanner = null;
      }
      state.screenshots.push(await shot(page, 'error-timeout'));
      state.storageFinal = await readStorage(page);
      state.probeAfterFaults = await readProbe(page);
      state.__injectModel = null;
      state.faultPath = path_.join(' -> ');
      state.__faultPhase = false;
    });

    /* 17. mock 是否活到了最后（共享端口上别的进程可能中途退出，必须留下证据） */
    await step('mock alive at end', async () => {
      const still = await fetchJson(`${mockBase}/health`, {}, 5000);
      state.mockAliveAtEnd = still.status === 200 && still.json?.ok === true;
      if (!state.mockAliveAtEnd) report.stepErrors.push('mock died during the browser phase (shared port 8787?)');
    });

    /* 最后一步 · §7.11 挑图窗口内"失焦"不得清空已选图片。
       这是"加第二套顶掉第一套"的真正成因：Android 打开相册会让 App 进入 background，
       而失焦处理器把 artifacts 清空 → 追加读到 0 张 → 新图被当成整份列表写入。
       web 不经过相册，天然测不到，所以用 __OD_SET_PICKING__ / __OD_SIMULATE_BLUR__ 测试缝。
       注意：本步会**故意清空图片**，所以必须放在所有依赖图片的步骤之后。 */
    await step('blur guard during pick', async () => {
      const before = await probeValue(page, '(Array.isArray(p.looks) ? p.looks.length : p.looks)');

      // ① 进入"正在挑照片"窗口 → 失焦必须被豁免，已选图片保留
      const exempted = await page.evaluate(() => {
        if (typeof window.__OD_SET_PICKING__ !== 'function') return 'missing';
        window.__OD_SET_PICKING__(true);
        return window.__OD_SIMULATE_BLUR__();
      });
      await sleep(200);
      const afterExempt = await probeValue(page, '(Array.isArray(p.looks) ? p.looks.length : p.looks)');

      // ② 退出窗口（相册已返回）→ 失焦必须照常清空（隐私不变量不许被削弱）
      const cleared = await page.evaluate(() => {
        if (typeof window.__OD_SET_PICKING__ !== 'function') return 'missing';
        window.__OD_SET_PICKING__(false);
        return window.__OD_SIMULATE_BLUR__();
      });
      await sleep(300);
      const afterClear = await probeValue(page, '(Array.isArray(p.looks) ? p.looks.length : p.looks)');
      state.blurGuard = {
        before: Number(before),
        exempted,
        afterExempt: Number(afterExempt),
        cleared,
        afterClear: Number(afterClear),
      };
    });

    report.evidence.exchangeSummary = exchanges.map((e) => ({
      kind: e.kind,
      status: e.status,
      answers: Array.isArray(e.body?.answers) ? e.body.answers.length : 0,
    }));
  } catch (err) {
    report.stepErrors.push(`fatal: ${err && err.message ? err.message : String(err)}`);
  } finally {
    // 证据收集放在 finally：即使中途 fatal，也要留下已经拿到的现场
    try {
      report.evidence.scoreResponses = state.scoreExchanges.map((e) => redact({ status: e.status, raw: e.raw }));
      report.evidence.deepResponses = state.deepExchanges.map((e) => redact({ status: e.status, raw: e.raw }));
      report.evidence.probe = redact(state.probe);
      report.evidence.storageKeys = Object.keys(state.storage);
      report.evidence.storage = redact(state.storage);
      report.evidence.history = redact(state.history);
      report.evidence.domRanks = state.domRanks;
      report.evidence.cardDims = state.cardDims;
      report.evidence.compareViewShot = state.compareViewShot || null;
      report.evidence.mockAliveAtEnd = state.mockAliveAtEnd ?? null;
      report.evidence.compareText = state.compareText;
      report.evidence.authBanner = state.authBanner;
      report.evidence.timeoutBanner = state.timeoutBanner;
      report.evidence.weaknetBanner = state.weaknetBanner;
      report.evidence.faultPath = state.faultPath || null;
      report.evidence.faultTimingMs = {
        auth: state.authElapsedMs ?? null,
        timeout: state.timeoutElapsedMs ?? null,
        weaknet: state.weaknetElapsedMs ?? null,
      };
      report.evidence.baseUrlInjected = !!state.baseUrlInjected;
      report.evidence.modelInputAvailable = !!state.modelInputAvailable;
      report.evidence.imagePicker = report.evidence.imagePicker || null;
      // #13 的原始测量值必须进报告：断言详情是结论，这里是可以自己复核的过程数据。
      report.evidence.pickAccumulated = state.pickAccumulated || null;
      report.screenshots = Object.fromEntries(state.screenshots.map((f) => [path.basename(f, '.png'), path.relative(ROOT, f)]));
    } catch (e2) {
      report.stepErrors.push(`evidence collection failed: ${e2.message}`);
    }
    if (!process.env.OD_KEEP_OPEN) {
      try {
        if (browser) await browser.close();
      } catch {
        /* ignore */
      }
      try {
        if (server) await server.close();
      } catch {
        /* ignore */
      }
      if (mockProc && !mockProc.killed) {
        try {
          mockProc.kill();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /* ------------------------------------------------------- 断言评估 */

  // 附加（不参与 §7 的 12 条门禁，但真实记录）：纯逻辑单测
  // 注意 node 24 下 `node --test tests/`（目录）必然失败，必须用 glob
  const unitTests = await runUnitTests();
  report.tests = unitTests;
  report.extras.push({
    id: 'unit-tests',
    gating: false, // 纯逻辑单测由 package.json 的 gate 脚本单独把关，这里只如实记录
    ok: unitTests.exitCode === 0 && unitTests.fail === 0 && unitTests.pass > 0,
    detail: `${unitTests.command} -> pass=${unitTests.pass} fail=${unitTests.fail} exit=${unitTests.exitCode} log=${unitTests.log}`,
  });

  const A = [];
  const add = (n, id, spec, ok, detail) => A.push({ n, id, spec, ok: !!ok, detail: detail == null ? '' : String(detail) });
  const probe = state.probe || {};
  const ranked = Array.isArray(probe.quick?.ranked) ? probe.quick.ranked : [];
  const lookIdsFromProbe = (() => {
    const looks = probe.looks;
    if (Array.isArray(looks)) {
      const ids = looks.map((l) => (typeof l === 'string' ? l : l?.lookId || l?.id)).filter(Boolean);
      if (ids.length) return ids;
    }
    return ranked.map((r) => r.lookId).filter(Boolean);
  })();

  // 1 mock 可达（且确认对面是符合 §6 契约的 mock，不是端口上别的服务）
  add(
    1,
    'mock-health',
    '§7.1',
    state.mockOk,
    state.mockOk
      ? `GET /health 200 ${JSON.stringify(report.evidence.mockHealth?.body)} contractSpec=true`
      : `health=${JSON.stringify(report.evidence.mockHealth)} contractSpec=${state.contractSpec}（8787 上可能被其它进程占用）`,
  );

  // 2 System One 结构（§7.2）
  // 权威来源是 §3.8 的 QuickResult.ranked：线上证据 = 每套一份 6 维严格 score 响应；
  // probe.ranked = UI 侧镜像（§2.1 未规定其元素字段，因此只要带 scores 就一并严格校验，缺失不判违约）。
  {
    const overallOk = ranked.length > 0 && ranked.every((r) => {
      if (r.overall === null || r.overall === undefined) return true;
      return typeof r.overall === 'number' && r.overall >= 0 && r.overall <= 5 && Math.abs(r.overall * 10 - Math.round(r.overall * 10)) < 1e-9;
    });
    const probeScoresOk = ranked.every((r) => {
      const s = r?.scores;
      if (!s || typeof s !== 'object') return true; // 未暴露就不判违约
      if (SCORE_IDS.filter((k) => k in s).length !== 6) return false;
      return SCORE_IDS.every((k) => {
        const v = s[k];
        if (v === null) return r.overall === null;
        return typeof v === 'number' && v >= 0 && v <= 5 && Math.abs(v * 10 - Math.round(v * 10)) < 1e-9;
      });
    });
    const nonNull = ranked.filter((r) => r.overall !== null && r.overall !== undefined);
    const descOk = nonNull.every((r, i) => i === 0 || nonNull[i - 1].overall >= r.overall);
    const wireOk =
      state.scoreExchanges.length > 0 &&
      state.scoreExchanges.every(
        (e) =>
          e.status === 200 &&
          Array.isArray(e.body?.answers) &&
          e.body.answers.length === 6 &&
          e.body.answers.every(
            (a) =>
              a.type === 'score' &&
              typeof a.score === 'number' &&
              a.score >= 0 &&
              a.score <= 5 &&
              Math.abs(a.score * 10 - Math.round(a.score * 10)) < 1e-9,
          ),
      );
    // allLooksScored 必须**按 lookId** 判定，不能拿请求条数和套数比：
    // scoreExchanges 是按套展开的（批处理时由一次请求展开成 N 条），
    // 而且界面可能再跑一轮（单套重试 / 复跑），条数本来就会多于套数。
    const scoredLookIds = new Set(
      state.scoreExchanges
        .map((e) => e.lookId || lookIdFromStateText(e.request?.state))
        .filter(Boolean),
    );
    const missingLookIds = ranked.map((r) => r.lookId).filter((id) => !scoredLookIds.has(id));
    const allLooksScored = ranked.length > 0 && missingLookIds.length === 0;
    const allLooksScoredDetail = allLooksScored
      ? 'every look has a score'
      : `missing=${missingLookIds.join(',')}`;
    add(
      2,
      'system-one-structure',
      '§7.2',
      overallOk && probeScoresOk && descOk && wireOk && allLooksScored,
      `ranked=${ranked.length} scoreExchanges=${state.scoreExchanges.length} (batch=${state.batchRequests || 0}) ` +
        `overall=[${ranked.map((r) => r.overall).join(',')}] ` +
        `overallOk=${overallOk} probeScoresOk=${probeScoresOk} desc=${descOk} wire6dims1dp=${wireOk} ` +
        `allLooksScored=${allLooksScored}(${allLooksScoredDetail})`,
    );

    // 附加（非门禁）：DOM 每张卡的维度行数，作为「6 维确实渲染出来」的旁证
    const cardDims = state.cardDims || [];
    report.extras.push({
      id: 'dom-dim-rows',
      gating: false, // §2.1 未规定每卡必须渲染 6 行，仅作旁证
      ok: cardDims.length > 0 && cardDims.every((c) => c.dimRows === 6),
      detail: `cards=[${cardDims.map((c) => `rank${c.rank}:dimRows=${c.dimRows},scores=${c.scores.length}`).join(' | ')}]`,
    });
  }

  // 3 System One 无解释文本
  {
    const forbidden = /建议|推荐|因为你|显得/;
    const texts = state.scoreExchanges.map((e) => e.raw || '');
    const allScore = state.scoreExchanges.every(
      (e) => Array.isArray(e.body?.answers) && e.body.answers.every((a) => a.type === 'score'),
    );
    const noExtraContent = state.scoreExchanges.every(
      (e) => Array.isArray(e.body?.answers) && e.body.answers.every((a) => !a.content || String(a.content).trim() === ''),
    );
    const noForbidden = texts.every((t) => !forbidden.test(t));
    add(
      3,
      'system-one-no-prose',
      '§7.3',
      state.scoreExchanges.length > 0 && allScore && noExtraContent && noForbidden,
      `exchanges=${state.scoreExchanges.length} allScore=${allScore} noContent=${noExtraContent} noForbiddenWords=${noForbidden}`,
    );
  }

  // 4 结果页按降序渲染（§7.4）
  // ⚠ 语义边界（t-A 对抗式复核确认）：本断言只验「DOM 卡片顺序 == probe.ranked 数组顺序」，
  //    **不验排序正确性**——如果引擎把 ranked 整体逆序返回，DOM 会同步变成 [4,3,2,1]，
  //    此时 #4 仍然 PASS，真正抓到错误的是 #2 的 desc 判据。
  //    排序正确性归 #2 负责，不要把 #4 当排序证据。
  {
    const domRanks = state.domRanks || [];
    const probeRanks = ranked.map((r) => (r.rank == null ? '' : String(r.rank)));
    const domOk = domRanks.length > 0 && domRanks.length === probeRanks.length;
    const sameOrder = domOk && domRanks.every((v, i) => v === probeRanks[i]);
    add(
      4,
      'result-order',
      '§7.4',
      sameOrder,
      `dom=[${domRanks.join(',')}] probe=[${probeRanks.join(',')}] scope=render-matches-probe (ordering correctness is #2)`,
    );
  }

  // 5 System Two 结构
  {
    const rawDeep = state.deepExchanges.find((e) => e.body?.answers?.[0]?.content)?.body?.answers?.[0]?.content;
    let deep = null;
    try {
      deep = rawDeep ? JSON.parse(rawDeep) : null;
    } catch {
      deep = null;
    }
    const starsOk =
      deep &&
      deep.ranking.every((r) => typeof r.stars === 'number' && r.stars >= 0 && r.stars <= 5) &&
      deep.details.every((d) => d.dimensions.every((x) => typeof x.stars === 'number' && x.stars >= 0 && x.stars <= 5));
    const shapeOk =
      deep &&
      Array.isArray(deep.ranking) &&
      deep.ranking.length > 0 &&
      Array.isArray(deep.details) &&
      deep.details.length === deep.ranking.length &&
      deep.ranking.every((r) => typeof r.lookId === 'string' && typeof r.oneLineReason === 'string') &&
      deep.details.every((d) => d.pros.length >= 2 && d.cons.length >= 1 && d.suggestions.length >= 1) &&
      deep.details.every((d) => d.dimensions.length === 5) &&
      deep.conclusion &&
      typeof deep.conclusion.reason === 'string' &&
      Array.isArray(deep.conclusion.alternatives) &&
      deep.conclusion.alternatives.length >= 1 &&
      typeof deep.conclusion.tip === 'string';
    const pickIds = deep ? deep.ranking.map((r) => r.lookId) : [];
    const pickOk = deep ? pickIds.includes(deep.conclusion.pick) || LOOK_IDS.includes(deep.conclusion.pick) : false;
    state.deepReport = deep;
    add(
      5,
      'system-two-report',
      '§7.5',
      !!(shapeOk && starsOk && pickOk && state.deepDomPresent),
      `wireReport=${!!deep} domReport=${state.deepDomPresent} ranking=${deep?.ranking?.length ?? 0} starsOk=${!!starsOk} pick=${deep?.conclusion?.pick ?? '-'} pickOk=${pickOk}`,
    );
  }

  // 6 同屏对比（§7.6）—— 严格限定在 compare-view 容器自身，且必须含**真实内容**，
  //   否则「只有两个标题」也会假过。
  {
    const raw = state.compareText || '';
    const text = raw.replace(/\s+/g, '');
    const hasQuick = text.includes('快速评分');
    const hasDeep = text.includes('深度分析');
    state.compareLabels = { quick: hasQuick, deep: hasDeep };
    // 快速评分侧：至少出现一个真实的 overall 分数（1 位小数）
    const overalls = ranked.map((r) => (typeof r.overall === 'number' ? r.overall.toFixed(1) : null)).filter(Boolean);
    const quickContent = overalls.some((v) => text.includes(v));
    // 深度分析侧：至少出现一句真实的 oneLineReason（来自线上 deep 报告）
    const reasons = ((state.deepReport && state.deepReport.ranking) || [])
      .map((r) => String(r.oneLineReason || '').replace(/\s+/g, ''))
      .filter((s) => s.length >= 6);
    const deepContent = reasons.some((s) => text.includes(s));
    const hasSetLabel = /第\d+套/.test(text);
    add(
      6,
      'compare-view',
      '§7.6',
      hasQuick && hasDeep && quickContent && deepContent,
      `containerLen=${raw.length} quickLabel=${hasQuick} deepLabel=${hasDeep} quickScore=${quickContent} deepReason=${deepContent} setLabel=${hasSetLabel} shot=${state.compareViewShot || '-'}`,
    );
  }

  // 6b 附加门禁：分数自洽（防「综合 5.0 但五维 2-3 分」这类展示矛盾回归）
  //
  // 配对规则：**按 lookId 配对**。lookId 取自该次 score 请求 state 里的 `【穿搭N】`
  // （§3.2 的拼接规则保证每套自己的 state 只带自己的段头），
  // 与 `answers` 数组下标无关、与 `ranked` 的排列顺序无关。
  // 因此"逆序返回 ranked"这类缺陷**不会**在这里误报——只有某套自己的
  // overall 与它自己的 5 维不自洽时才会红。
  {
    const CN_LOOK = { 一: 'look1', 二: 'look2', 三: 'look3', 四: 'look4' };
    const lookIdFromState = (s) => {
      const m = /【穿搭([一二三四])】/.exec(s || '');
      return m ? CN_LOOK[m[1]] : null;
    };
    const dimIds = SCORE_IDS.filter((k) => k !== 'overall_score');
    const byLook = new Map();
    state.scoreExchanges.forEach((e, i) => {
      const answers = Object.fromEntries((e.body?.answers || []).map((a) => [a.id, a.score]));
      const dimensions = {};
      for (const d of dimIds) dimensions[d] = typeof answers[d] === 'number' ? answers[d] : null;
      const nums = Object.values(dimensions).filter((v) => typeof v === 'number');
      const mean = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null;
      const overall = typeof answers.overall_score === 'number' ? answers.overall_score : null;
      const delta = overall != null && mean != null ? Math.round((overall - mean) * 100) / 100 : null;
      const lookId = lookIdFromState(e.request?.state) || `unknown${i + 1}`;
      byLook.set(lookId, {
        lookId,
        overall,
        dimensions,
        mean,
        delta,
        consistent: delta != null && Math.abs(delta) <= 1.0,
      });
    });
    const rows = [...byLook.values()].sort((a, b) => a.lookId.localeCompare(b.lookId));
    // 交叉核对（集合层面、与顺序无关）：线上 score 的整套 lookId 必须与 probe.ranked 出现的完全一致
    const wireLooks = [...byLook.keys()].sort().join(',');
    const probeLooks = ranked
      .map((r) => r.lookId)
      .filter(Boolean)
      .sort()
      .join(',');
    const lookSetMatches = rows.length > 0 && wireLooks === probeLooks;
    state.scoreCoherence = rows;
    report.evidence.scoreCoherence = rows;
    report.extras.push({
      id: 'score-coherence',
      gating: true,
      ok: rows.length > 0 && rows.every((r) => r.consistent) && lookSetMatches,
      detail:
        rows.map((r) => `${r.lookId}: overall=${r.overall} mean5=${r.mean} delta=${r.delta} ok=${r.consistent}`).join(' | ') +
        ` || pairing=byLookId(orderIndependent) lookSetMatches=${lookSetMatches}`,
    });
  }

  // 6c 附加门禁：双引擎结论必须同向
  // 产品级矛盾（左栏「第 4 套第一」/ 右栏「第 4 套最差，选第 2 套」）若回归，这里立刻变红。
  // mock 的 deep 排名由与 System One 同源的分派生，因此 quick#1 必须恒等于 deep.pick。
  {
    const quickTop = ranked[0]?.lookId ?? null;
    const deepPick = state.deepReport?.conclusion?.pick ?? null;
    const deepTop = state.deepReport?.ranking?.[0]?.lookId ?? null;
    const ok = !!quickTop && !!deepPick && quickTop === deepPick && deepPick === deepTop;
    report.evidence.engineAgreement = { quickTop, deepPick, deepTop, agree: ok };
    report.extras.push({
      id: 'engine-agreement',
      gating: true,
      ok,
      detail: `quick#1=${quickTop} deep.pick=${deepPick} deep.ranking#1=${deepTop} agree=${ok}`,
    });
  }

  // 7 console/页面错误（§7.7：只算"我们自己的代码"；浏览器网络层日志单独记录）
  {
    report.consoleErrors = report.consoleErrorDetails.length;
    const ok = report.consoleErrors === 0 && report.pageErrors === 0;
    const injected = report.resourceErrors.filter((e) => e.duringFaultInjection).length;
    add(
      7,
      'no-console-errors',
      '§7.7',
      ok,
      `appConsoleErrors=${report.consoleErrors} pageErrors=${report.pageErrors} ` +
        `resourceErrors=${report.resourceErrors.length}(injectedFaults=${injected}, favicon/other=${report.resourceErrors.length - injected}) ` +
        `thirdParty=${report.thirdPartyWarnings.length}`,
    );
  }

  // 8 隐私（§7.8 + Lead 加强版）：图片载荷与 API Key 明文都不许出现在 storage / probe / 报告 / 日志
  const privacyState = { reportNoApiKey: null };
  const collectLeakPoints = () => {
    const points = [];
    const scan = (label, text) => {
      if (text && String(text).includes(API_KEY_SENTINEL)) points.push(label);
    };
    scan('probe', `${JSON.stringify(state.probe ?? null)}${JSON.stringify(state.probeAfterFaults ?? null)}`);
    scan('console', state.consoleTexts.join('\n'));
    scan('pageErrors', JSON.stringify(report.pageErrorDetails));
    scan('stepErrors', JSON.stringify(report.stepErrors));
    scan(
      'exchanges',
      JSON.stringify(
        (state.allExchanges || []).map((e) => ({ request: e.request, raw: e.raw, auth: e.authHeaderMasked })),
      ),
    );
    scan('evidence', JSON.stringify(report.evidence));
    if (privacyState.reportNoApiKey === false) points.push('report');
    return points;
  };
  const evaluatePrivacy = () => {
    const dump = JSON.stringify(state.storage || {});
    const probeText = `${JSON.stringify(state.probe ?? null)}${JSON.stringify(state.probeAfterFaults ?? null)}`;
    const noDataUri = !dump.includes('data:image');
    const noBase64 = !dump.includes('base64');
    const probeFlag = probe?.privacy?.imageInStorage === false;
    const probeNoImage = !probeText.includes('data:image');
    const probeNoBase64 = !probeText.includes('base64');
    const probeNoKey = !probeText.includes(API_KEY_SENTINEL);
    const reportNoKey = privacyState.reportNoApiKey !== false;
    // 网页端降级路径必须真的把 Key 落进 od.apikey.v1（反假绿：改坏了这里会暴露）
    const keyPersisted = state.keyPersisted === true;
    // 规则：apiKey 只允许出现在 od.apikey.v1，禁止混进 od.config.v1 对象
    const configEntry = Object.entries(state.storage || {}).find(([k]) => k.includes('od.config.v1'));
    let configHasApiKey = false;
    if (configEntry) {
      try {
        const cfg = JSON.parse(configEntry[1]);
        configHasApiKey = JSON.stringify(cfg).includes(API_KEY_SENTINEL) || Object.keys(cfg).some((k) => /apikey/i.test(k));
      } catch {
        configHasApiKey = /apikey/i.test(String(configEntry[1]));
      }
    }
    const leakPoints = collectLeakPoints();
    return {
      ok:
        noDataUri &&
        noBase64 &&
        probeFlag &&
        probeNoImage &&
        probeNoBase64 &&
        probeNoKey &&
        reportNoKey &&
        keyPersisted &&
        !configHasApiKey &&
        leakPoints.length === 0,
      detail:
        `storage[noDataUri=${noDataUri} noBase64=${noBase64}] ` +
        `probe[imageInStorage=${probe?.privacy?.imageInStorage} noDataUri=${probeNoImage} noBase64=${probeNoBase64} noApiKey=${probeNoKey}] ` +
        `key[keyEntered=${state.keyEntered} keyPersisted=${keyPersisted} inConfigV1=${configHasApiKey}] ` +
        `report[noApiKey=${reportNoKey}] leakPoints=[${leakPoints.join(',')}]`,
    };
  };
  {
    const p8 = evaluatePrivacy();
    add(8, 'privacy-storage-probe-report', '§7.8', p8.ok, p8.detail);
    report.evidence.keyPersisted = state.keyPersisted === true;
    report.evidence.keyEntered = state.keyEntered === true;
    report.evidence.keyStorageAfterSaveKeys = Object.keys(state.keyStorageAfterSave || {});
    state.__evaluatePrivacy = evaluatePrivacy;
  }

  // 9 异常路径
  {
    const authOk = typeof state.authBanner === 'string' && state.authBanner.includes(COPY.auth);
    const timeoutOk = typeof state.timeoutBanner === 'string' && state.timeoutBanner.includes(COPY.timeout);
    const weakOk = typeof state.weaknetBanner === 'string' && state.weaknetBanner.length > 0;
    add(
      9,
      'error-banners',
      '§7.9',
      authOk && timeoutOk && weakOk,
      `auth=${authOk}(${state.authElapsedMs ?? '-'}ms) timeout=${timeoutOk}(${state.timeoutElapsedMs ?? '-'}ms) weaknet=${weakOk}(${state.weaknetElapsedMs ?? '-'}ms) ` +
        `path=${state.faultPath || '-'} authText=${JSON.stringify((state.authBanner || '').slice(0, 30))} timeoutText=${JSON.stringify((state.timeoutBanner || '').slice(0, 30))}`,
    );
  }

  // 10 历史
  {
    const afterDeep = pickHistory(state.storage);
    const afterTab = pickHistory(state.historyAfterTab);
    const afterQuick = pickHistory(state.historyAfterQuick);
    const records = afterDeep.length ? afterDeep : afterTab.length ? afterTab : afterQuick;
    state.history = records;
    const countOk = records.length === 1;
    const looksOk = records.every(
      (r) =>
        Array.isArray(r.looks) &&
        r.looks.length > 0 &&
        r.looks.every((l) => typeof l.description === 'string' && l.description.trim().length > 0),
    );
    const noImageFields = !/data:image|base64|"uri"|"dataUri"/.test(JSON.stringify(records));
    add(
      10,
      'history-record',
      '§7.10',
      countOk && looksOk && noImageFields,
      `count=${records.length} (afterQuick=${afterQuick.length}, afterTab=${afterTab.length}, afterDeep=${afterDeep.length}) looksDescOk=${looksOk} noImageFields=${noImageFields}`,
    );
  }

  // 11 截图
  {
    const need = ['capture', 'result', 'compare', 'history', 'settings'];
    const present = need.filter((n) => fs.existsSync(path.join(SHOTS, `${n}.png`)));
    const sized = present.every((n) => fs.statSync(path.join(SHOTS, `${n}.png`)).size > 1024);
    add(11, 'screenshots', '§7.11', present.length === need.length && sized, `present=[${present.join(',')}] of [${need.join(',')}]`);
  }

  // 12 报告（自检：写盘后回读）
  report.assertions = A;
  report.assertErrors = A.filter((a) => !a.ok).map((a) => `#${a.n} ${a.id}: ${a.detail}`);
  report.ok = report.assertErrors.length === 0;
  report.finishedAt = nowIso();
  report.durationMs = Date.now() - startedAt;
  report.assertions = A;

  let selfCheck = false;
  try {
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    const reportText = fs.readFileSync(REPORT_PATH, 'utf8');
    // 报告本身也不许出现 API Key 明文（§3.10）——把它并入断言 8 后重算
    privacyState.reportNoApiKey = !reportText.includes(API_KEY_SENTINEL);
    const idx8 = A.findIndex((a) => a.n === 8);
    if (idx8 >= 0 && typeof state.__evaluatePrivacy === 'function') {
      const p = state.__evaluatePrivacy();
      A[idx8].ok = p.ok;
      A[idx8].detail = p.detail;
    }
    const back = JSON.parse(reportText);
    selfCheck =
      Array.isArray(back.assertErrors) &&
      typeof back.consoleErrors === 'number' &&
      Array.isArray(back.assertions) &&
      back.assertions.length >= 11;
  } catch (err) {
    report.stepErrors.push(`report write failed: ${err.message}`);
  }
  add(12, 'report-written', '§7.12', selfCheck, `${path.relative(ROOT, REPORT_PATH)} selfCheck=${selfCheck} consoleErrors=${report.consoleErrors}`);

  // #13 · 分次选图必须累加（用户实测"只能上传一张"的那条路径）。
  // 一次性 uploadFile(4 张) 测不出这个 bug，所以上面刻意拆成 1 张 + 3 张两次。
  {
    const acc = state.pickAccumulated || { afterFirst: null, afterSecond: null };
    const ok = acc.afterFirst === 1 && Number(acc.afterSecond) >= 4;
    add(
      13,
      'pick-accumulates',
      '§7.11',
      ok,
      `分次选图：第 1 次后=${acc.afterFirst} 张，第 2 次后=${acc.afterSecond} 张（必须累加，不得被后一次冲掉）`,
    );
  }

  // #14 · 挑图窗口内"失焦"不得清空已选图片（SPEC §4.1.2 + §7.11）。
  // 这是"加第二套顶掉第一套"的真正成因：Android 打开相册会让 App 进入 background，
  // 而失焦处理器把 artifacts 清空了 —— 于是追加读到 0 张、新图被当成整份列表写入。
  // web 不经过相册，天然测不到，所以靠 __OD_SIMULATE_BLUR__ 测试缝显式验证。
  {
    const r = state.blurGuard || {};
    const ok = Number(r.before) > 0
      && r.exempted === 'exempted'
      && Number(r.afterExempt) === Number(r.before)
      && r.cleared === 'cleared'
      && Number(r.afterClear) === 0;
    add(
      14,
      'blur-during-pick-keeps-images',
      '§7.11',
      ok,
      `失焦前=${r.before} 张；挑图窗口内失焦=${r.exempted} → ${r.afterExempt} 张（应不变）；`
        + `窗口外失焦=${r.cleared} → ${r.afterClear} 张（应清空）`,
    );
  }
  report.assertions = A;
  report.assertErrors = A.filter((a) => !a.ok).map((a) => `#${a.n} ${a.id}: ${a.detail}`);
  report.extraErrors = report.extras.filter((e) => !e.ok).map((e) => `${e.id}: ${e.detail}`);
  report.gatingExtraErrors = report.extras.filter((e) => e.gating && !e.ok).map((e) => `${e.id}: ${e.detail}`);
  report.ok = report.assertErrors.length === 0 && report.gatingExtraErrors.length === 0;
  report.durationMs = Date.now() - startedAt;
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  /* ------------------------------------------------------------- 摘要 */
  process.stdout.write(`puppeteer: ${puppeteerInfo}\n`);
  process.stdout.write(`web: ${report.env.webUrl || '-'}  mock: ${report.env.mock?.spawned ? 'spawned' : 'reused'}\n`);
  process.stdout.write(`fault path: ${state.faultPath || '-'}\n`);
  process.stdout.write(`unit tests: pass=${unitTests.pass} fail=${unitTests.fail} exit=${unitTests.exitCode}\n`);
  for (const a of report.assertions) {
    process.stdout.write(`${a.ok ? 'PASS' : 'FAIL'} #${a.n} ${a.id} :: ${a.detail}\n`);
  }
  for (const e of report.extras) {
    process.stdout.write(`${e.ok ? 'PASS' : 'FAIL'} ext ${e.id}${e.gating ? ' (gating)' : ''} :: ${e.detail}\n`);
  }
  if (report.stepErrors.length) {
    process.stdout.write(`stepErrors (${report.stepErrors.length}):\n`);
    for (const s of report.stepErrors) process.stdout.write(`  - ${s}\n`);
  }
  process.stdout.write(
    `report: ${path.relative(ROOT, REPORT_PATH)}  ok=${report.ok}  assertions=${report.assertions.filter((a) => a.ok).length}/${report.assertions.length}  ` +
      `gatingExtras=${report.extras.filter((e) => e.gating && e.ok).length}/${report.extras.filter((e) => e.gating).length}  ` +
      `consoleErrors=${report.consoleErrors}  pageErrors=${report.pageErrors}\n`,
  );

  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  // 兜底：即使 main 自身崩了，也要留下报告，绝不"静默失败"
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(
      REPORT_PATH,
      `${JSON.stringify(
        {
          ok: false,
          spec: 'docs/SPEC.md §7',
          finishedAt: nowIso(),
          assertErrors: [`fatal: ${err && err.message ? err.message : String(err)}`],
          consoleErrors: -1,
          pageErrors: -1,
          assertions: [],
          stepErrors: [String(err && err.stack ? err.stack : err)],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch {
    /* ignore */
  }
  process.stdout.write(`FAIL verify crashed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
