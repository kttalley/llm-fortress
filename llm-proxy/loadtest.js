/**
 * Load test for the inference proxy.
 *
 *   node llm-proxy/loadtest.js                 # 200 concurrent requests, mock upstream (safe)
 *   node llm-proxy/loadtest.js --n 500         # more requests
 *   node llm-proxy/loadtest.js --url http://127.0.0.1:8787/api/chat   (http only)
 *        # against a running proxy. Careful: that proxy forwards to real GPUs.
 *
 * In mock mode it starts a fake Ollama that takes UPSTREAM_MS per reply and
 * records how many requests it is serving at once, then starts the proxy
 * in-process pointed at it, with rate limiting relaxed so the test exercises
 * the global concurrency cap rather than the per-IP limit.
 */

import http from 'node:http';
import { createServer, config } from './server.js';

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('n', 200));
const UPSTREAM_MS = Number(arg('upstream-ms', 1500));
let target = arg('url', '');

let upstreamActive = 0, upstreamPeak = 0, upstreamServed = 0;
const servers = [];

if (!target) {
  const mock = http.createServer((req, res) => {
    upstreamActive++; upstreamPeak = Math.max(upstreamPeak, upstreamActive);
    req.resume();
    setTimeout(() => {
      upstreamActive--; upstreamServed++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Urist grumbles about the cold.' } }] }));
    }, UPSTREAM_MS);
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  servers.push(mock);
  const proxy = createServer({
    ollamaUrl: `http://127.0.0.1:${mock.address().port}/v1/chat/completions`,
    ollamaModel: 'mock', groqApiKey: '', ratePerMinute: 1e9, rateBurst: 1e9,
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  servers.push(proxy);
  target = `http://127.0.0.1:${proxy.address().port}/api/chat`;
}

// Client sockets are capped at 100, the way nginx pools upstream connections.
// (Opening 200 at once can overflow macOS's default 128-connection accept
// backlog and produce ECONNRESETs that say nothing about the proxy.)
const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });
function post(url, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', agent, headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(payload);
  });
}

const body = JSON.stringify({ messages: [{ role: 'user', content: 'Say something short.' }], max_tokens: 40 });
const t0 = Date.now();
const results = await Promise.all(Array.from({ length: N }, async () => {
  const s = Date.now();
  try {
    const status = await post(target, body);
    return { status, ms: Date.now() - s };
  } catch (e) {
    return { status: 'error:' + (e.cause?.code || e.cause?.message || e.message), ms: Date.now() - s };
  }
}));
const wall = Date.now() - t0;

const by = {};
for (const r of results) (by[r.status] ||= []).push(r.ms);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
console.log(`\n${N} concurrent requests -> ${target.includes('127.0.0.1') && servers.length ? 'mock upstream' : target}`);
console.log(`cap ${config.maxConcurrent}, queue ${config.maxQueue}, queue timeout ${config.queueTimeoutMs} ms, upstream ${UPSTREAM_MS} ms`);
for (const [status, ms] of Object.entries(by)) {
  console.log(`  ${status}: ${ms.length} requests  (median ${pct(ms, 0.5)} ms, p95 ${pct(ms, 0.95)} ms, max ${Math.max(...ms)} ms)`);
}
if (servers.length) console.log(`  upstream saw at most ${upstreamPeak} at once, served ${upstreamServed} total`);
console.log(`  wall time ${wall} ms\n`);
agent.destroy();
for (const s of servers) s.close();
