// SPEC §5.5 · 决策端点诊断：区分"端点不通"与"端点活着但上游挂了"。
//
// 起因是一次真实故障：Laya 进程僵死，但适配器**照样返回 HTTP 200**，
// 只是 body 里写着 {"ok":true,"upstream":{"ok":false,"detail":"fetch failed"}}。
// 只看状态码会得出"服务正常"的假结论，然后整轮打分失败、报错还看不懂。
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeApi, DEFAULT_CONFIG } from '../src/engine/api.js';

const jsonOnce = (body, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('端点 200 且上游健康 → ok:true', async () => {
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, baseUrl: 'http://127.0.0.1:8787' },
    fetchImpl: jsonOnce({ ok: true, upstream: { ok: true, status: 200, detail: 'ok' } }),
  });
  const d = await api.diagnoseDecisionEndpoint();
  assert.equal(d.ok, true);
  assert.equal(d.kind, 'ok');
});

test('端点 200 但 body 说上游挂了 → ok:false, kind=upstream（这是最坑的一种）', async () => {
  // 真实响应原文就长这样：HTTP 是 200，只有 body 暴露了上游已死
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, baseUrl: 'http://127.0.0.1:8787' },
    fetchImpl: jsonOnce({ ok: true, adapter: 'laya-adapter', upstream: { ok: false, detail: 'fetch failed' } }),
  });
  const d = await api.diagnoseDecisionEndpoint();
  assert.equal(d.ok, false, '不能因为 HTTP 200 就判定健康');
  assert.equal(d.kind, 'upstream');
  assert.match(d.detail, /fetch failed/);
});

test('端点本身不可达 → ok:false, kind=endpoint', async () => {
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, baseUrl: 'http://127.0.0.1:9' },
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const d = await api.diagnoseDecisionEndpoint();
  assert.equal(d.ok, false);
  assert.equal(d.kind, 'endpoint');
});

test('端点返回非 2xx → ok:false, kind=endpoint', async () => {
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, baseUrl: 'http://127.0.0.1:8787' },
    fetchImpl: jsonOnce({ error: 'boom' }, 500),
  });
  const d = await api.diagnoseDecisionEndpoint();
  assert.equal(d.ok, false);
  assert.equal(d.kind, 'endpoint');
  assert.match(d.detail, /500/);
});

test('没有 upstream 字段的普通端点（云端/旧对端）→ 视为健康，不误报', async () => {
  // 关键的反向保护：云端决策模型不会带 upstream 字段，
  // 不能因此判它不健康，否则每次打分前都会被自己的检查挡住。
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, baseUrl: 'https://api.example.com/v1' },
    fetchImpl: jsonOnce({ status: 'ok', model: 'whatever' }),
  });
  const d = await api.diagnoseDecisionEndpoint();
  assert.equal(d.ok, true);
  assert.equal(d.kind, 'ok');
});

test('响应体读不出来（非 JSON / 空体）→ 仍然视为健康', async () => {
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, baseUrl: 'http://127.0.0.1:8787' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    }),
  });
  const d = await api.diagnoseDecisionEndpoint();
  assert.equal(d.ok, true, 'body 解析失败不等于端点是坏的');
});

test('baseUrl 未配置 → ok:false, kind=endpoint（不让它当成健康）', async () => {
  const api = makeApi({
    config: { ...DEFAULT_CONFIG, baseUrl: '' },
    fetchImpl: jsonOnce({ ok: true }),
  });
  const d = await api.diagnoseDecisionEndpoint();
  assert.equal(d.ok, false);
  assert.equal(d.kind, 'endpoint');
});

test('api 暴露 diagnoseDecisionEndpoint（App 的前置检查依赖它）', () => {
  const api = makeApi({ config: { ...DEFAULT_CONFIG }, fetchImpl: jsonOnce({}) });
  assert.equal(typeof api.diagnoseDecisionEndpoint, 'function');
});

/* ── 文案：这两种故障必须各自有明确的指引，不能笼统说"网络问题" ─────────── */

test('copy.ERRORS 为两种端点故障提供了可操作文案', async () => {
  const { errorFor } = await import('../src/data/copy.js');
  const upstream = errorFor('upstream_unreachable');
  assert.match(upstream.message, /没在运行|启动/);
  assert.equal(upstream.retryable, false);

  const endpoint = errorFor('decision_endpoint_unreachable');
  assert.match(endpoint.message, /连不上|检查/);
  assert.equal(endpoint.retryable, false);

  assert.notEqual(upstream.message, endpoint.message, '两种原因不能共用一句话');
});
