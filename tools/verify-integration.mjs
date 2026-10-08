// 集成验证：拍摄引导 / 反馈按钮 / 中转面板 是否真的渲染，以及渐进结果是否不挡用户。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const puppeteerDir = 'C:/博830/vibecoding/格愈/node_modules/puppeteer-core';
const { default: puppeteer } = await import(`file:///${puppeteerDir}/lib/esm/puppeteer/puppeteer-core.js`);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const server = (await import('node:http')).createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url;
  const file = path.join(ROOT, 'dist', url.split('?')[0]);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

/* 一个假决策端点：6 维打分 + describe 文本，让快跑真能出结果 */
const upstream = (await import('node:http')).createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
  };
  // 浏览器对跨源 POST(JSON) 会先发 OPTIONS 预检；不答它请求就根本发不出去（实测踩过）
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(data || '{}'); } catch { body = {}; }
    const isDescribe = (body.questions || []).some((q) => String(q.id).startsWith('describe_'));
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({
      model: 'mock',
      answers: isDescribe
        ? (body.questions || []).map((q) => ({ id: q.id, type: 'text', content: '整体风格：简约；上衣：衬衫；下装：西裤；鞋履：皮鞋；配饰：无；身材视觉效果：匀称；其他细节：无', confidence: 0.8 }))
        : (body.questions || []).map((q) => ({ id: q.id, type: 'score', score: 4.0, confidence: 0.7 })),
      usage: { total_tokens: 10 },
    }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamPort = upstream.address().port;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
// 不要猜失败原因：把控制台与页面上的错误原样打出来
const consoleMsgs = [];
page.on('console', (m) => { if (m.type() === 'error') consoleMsgs.push(m.text().slice(0, 200)); });
page.on('requestfailed', (r) => consoleMsgs.push(`REQFAIL ${r.url().slice(0, 90)} ${r.failure()?.errorText || ''}`));
const requests = [];
page.on('request', (r) => { if (r.method() === 'POST') requests.push(r.url()); });

const setField = (id, v) => page.evaluate((testid, val) => {
  const el = document.querySelector(`[data-testid="${testid}"]`);
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}, id, v);

const has = (id) => page.evaluate((t) => !!document.querySelector(`[data-testid="${t}"]`), id);

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-testid="probe-json"]', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));

const steps = [];
const check = (name, ok, detail = '') => steps.push([name, !!ok, detail]);

/* ① 拍摄引导在上传页 */
check('上传页有拍摄引导面板', await has('shot-guide'));
await page.click('[data-testid="shot-guide-toggle"]').catch(() => {});
await new Promise((r) => setTimeout(r, 400));
check('拍摄引导可展开（展开后有内容）', await has('shot-guide-body'));

/* ② 设置页有中转面板 */
await page.click('[data-testid="tab-settings"]').catch(() => {});
await new Promise((r) => setTimeout(r, 800));
const unlock = await page.$('[data-testid="decision-gate-unlock"]');
if (unlock) { await unlock.click(); await new Promise((r) => setTimeout(r, 400)); }
check('设置页有中转面板', await has('relay-config'));
check('中转面板有地址输入', await has('relay-baseurl'));
check('中转面板有口令输入', await has('relay-token'));
check('中转面板有测试按钮', await has('btn-test-relay'));

/* ③ 配好地址 + 选一个**不需要视觉端点**的档位，跑快速评分 */
// 默认档位是 multimodal_only（要视觉模型），本脚本没有视觉替身，
// 所以显式选「本地模型直接打分」——它只用决策端点，正好对应上面的假上游。
// testID 用的是连字符（engine-mode-laya-only），不是下划线 —— 实测踩过
const modeBtn = await page.$('[data-testid="engine-mode-laya-only"]');
if (modeBtn) {
  await modeBtn.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await new Promise((r) => setTimeout(r, 300));
  await modeBtn.click();
  await new Promise((r) => setTimeout(r, 400));
} else {
  console.log('[diag] 找不到 engine-mode-laya-only');
}
await setField('engine-baseurl', `http://127.0.0.1:${upstreamPort}`);
await new Promise((r) => setTimeout(r, 400));
await page.click('[data-testid="tab-capture"]').catch(() => {});
await new Promise((r) => setTimeout(r, 400));

await page.evaluate(() => {
  if (typeof window.__OD_SET_ARTIFACTS__ === 'function') {
    window.__OD_SET_ARTIFACTS__([{ base64: 'AAAA', mime: 'image/jpeg' }, { base64: 'BBBB', mime: 'image/jpeg' }]);
  }
});
await new Promise((r) => setTimeout(r, 400));
const quickBtn = await page.$('[data-testid="system-mode-quick"]');
if (quickBtn) { await quickBtn.click(); await new Promise((r) => setTimeout(r, 300)); }
await page.click('[data-testid="submit-quick"]').catch(() => {});
await new Promise((r) => setTimeout(r, 6000));

const ranked = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="probe-json"]');
  try { const p = JSON.parse(el.textContent); return (p.quick && p.quick.ranked) ? p.quick.ranked.length : 0; } catch { return -1; }
});
check('快速评分真的出了结果', ranked > 0, `ranked=${ranked}`);
check('结果页有反馈按钮（wore）', await has('feedback-look1-wore'));
check('结果页有反馈按钮（not_wore）', await has('feedback-look1-not_wore'));

/* ④ 点反馈 → 落盘且不含图片 */
await page.click('[data-testid="feedback-look1-wore"]').catch(() => {});
await new Promise((r) => setTimeout(r, 800));
const fb = await page.evaluate(() => {
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k && k.includes('feedback')) return localStorage.getItem(k);
  }
  return null;
});
check('反馈已落盘', !!fb, String(fb).slice(0, 90));
check('反馈里不含图片载荷', !!fb && !/base64|data:image|AAAA|BBBB/.test(fb), String(fb).slice(0, 90));

console.log('\n=== 集成验证 ===');
let bad = 0;
for (const [name, ok, detail] of steps) {
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail && !ok ? `  (${detail})` : ''}`);
}
if (bad) {
  const diag = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="probe-json"]');
    let probe = null;
    try { probe = el ? JSON.parse(el.textContent) : null; } catch { probe = null; }
    const byId = (t) => { const e = document.querySelector(`[data-testid="${t}"]`); return e ? (e.textContent || '').trim().slice(0, 140) : null; };
    return {
      errors: probe && probe.errors,
      phase: probe && probe.phase,
      lastRequest: probe && probe.lastRequest,
      errorBanner: byId('error-banner'),
      // 结果页/上传页实际状态
      tab: document.querySelector('[data-testid="tab-result"]') ? 'has-tabs' : '?',
      bodyHas: Array.from(document.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid')).slice(0, 40),
    };
  });
  console.log('\n--- probe ---');
  console.log('  errors =', JSON.stringify(diag.errors));
  console.log('  phase  =', JSON.stringify(diag.phase));
  console.log('  lastRequest =', JSON.stringify(diag.lastRequest));
  console.log('  error-banner =', JSON.stringify(diag.errorBanner));
  console.log('  页面上的 testID =', diag.bodyHas.join(', '));
  console.log('\n--- POST 请求 ---');
  for (const u of requests.slice(0, 8)) console.log('  ' + u.slice(0, 110));
  console.log('\n--- console errors ---');
  for (const m of consoleMsgs.slice(0, 8)) console.log('  ' + m);
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);

await browser.close();
server.close();
upstream.close();
process.exit(bad === 0 ? 0 : 1);
