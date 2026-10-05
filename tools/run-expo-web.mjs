#!/usr/bin/env node
/**
 * tools/run-expo-web.mjs — 把 `npx expo export --platform web` 的产物（默认 dist/）挂到本地静态服务，
 * 供 puppeteer 以 http://127.0.0.1:<port>/ 打开（SPEC §7 的端到端验收用）。
 *
 * 用法：
 *   node tools/run-expo-web.mjs                 # dist/ → http://127.0.0.1:8081
 *   node tools/run-expo-web.mjs --port 8090 --root dist
 *
 * 也可以作为模块使用：`import { startStaticServer, findFreePort } from './run-expo-web.mjs'`
 * （verify.mjs 就是这么用的，避免起两个进程）。
 *
 * stdout 只输出 ASCII。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/** 找一个可用端口（从 start 开始向上试） */
export async function findFreePort(start = 8081, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const port = start + i;
    // eslint-disable-next-line no-await-in-loop
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`no free port in range ${start}..${start + tries - 1}`);
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/**
 * 起静态服务。
 * @returns {Promise<{url:string, port:number, root:string, close:()=>Promise<void>}>}
 */
export function startStaticServer({ root = path.join(PROJECT_ROOT, 'dist'), port = 8081, host = '127.0.0.1' } = {}) {
  const rootAbs = path.resolve(root);
  const indexHtml = path.join(rootAbs, 'index.html');

  const server = http.createServer((req, res) => {
    const target = safeJoin(rootAbs, req.url || '/');
    if (!target) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const sendFile = (file) => {
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      });
    };
    fs.stat(target, (err, st) => {
      if (!err && st.isFile()) {
        sendFile(target);
        return;
      }
      if (!err && st.isDirectory()) {
        const idx = path.join(target, 'index.html');
        if (fs.existsSync(idx)) {
          sendFile(idx);
          return;
        }
      }
      // SPA/静态导出回退：无扩展名的路径一律回 index.html
      if (!path.extname(target) && fs.existsSync(indexHtml)) {
        sendFile(indexHtml);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        url: `http://${host}:${actual}/`,
        port: actual,
        root: rootAbs,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const argOf = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const root = path.resolve(PROJECT_ROOT, argOf('--root', 'dist'));
  const port = Number(argOf('--port', 8081));
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    process.stderr.write(`no index.html under ${root} -- run "npx expo export --platform web" first\n`);
    process.exit(1);
  }
  startStaticServer({ root, port })
    .then((s) => {
      process.stdout.write(`static server on ${s.url} root=${s.root}\n`);
    })
    .catch((err) => {
      process.stderr.write(`static server failed: ${err.message}\n`);
      process.exit(1);
    });
}
