// Inference proxy smoke test
// Run with: node tests/test-llm-proxy.js
//
// Proves, against a mock upstream (no real GPUs involved):
//  (a) CORS: the site origin and local dev origins are allowed; others get 403
//  (b) per-IP rate limit returns 429 once the burst is spent
//  (c) bad payloads are rejected with 400, and max_tokens is clamped
//  (d) the client never sends a model; the proxy supplies it from env
//  (e) health reports the provider without exposing the upstream URL

import http from 'node:http';
import { createServer, sanitize } from '../llm-proxy/server.js';

let passed = 0, failed = 0;
const check = (name, ok) => { ok ? passed++ : failed++; console.log(`${ok ? '✓' : '✗'} ${name}`); };

let lastUpstreamBody = null;
const mock = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => (raw += c));
  req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(200); return res.end('{"data":[]}'); }
    lastUpstreamBody = JSON.parse(raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: ' Hello from the mock. ' } }] }));
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const upstream = `http://127.0.0.1:${mock.address().port}/v1/chat/completions`;

const proxy = createServer({ ollamaUrl: upstream, ollamaModel: 'test-model', groqApiKey: '', ratePerMinute: 1, rateBurst: 3 });
await new Promise(r => proxy.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${proxy.address().port}`;
const chat = (body, origin = 'https://design.kristiantalley.com') =>
  fetch(`${base}/projects/llm-fortress/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
const msg = { messages: [{ role: 'user', content: 'hi' }] };

// (a) CORS
let r = await chat(msg);
check('site origin allowed, 200', r.status === 200);
check('CORS header echoes the site origin', r.headers.get('access-control-allow-origin') === 'https://design.kristiantalley.com');
const data = await r.json();
check('response uses OpenAI shape, trimmed', data.choices?.[0]?.message?.content === 'Hello from the mock.');
check('provider reported', data.provider === 'ollama');
// (d)
check('model comes from server env', lastUpstreamBody?.model === 'test-model');
check('num_ctx forwarded as Ollama option', lastUpstreamBody?.options?.num_ctx === 4096);
r = await chat(msg, 'https://evil.example');
check('foreign origin rejected with 403', r.status === 403);

// (b) rate limit: burst 3, one used above; two more pass, the next is 429
await chat(msg); await chat(msg);
r = await chat(msg);
check('429 after burst is spent', r.status === 429);

// (c) validation (pure function, so the rate limit does not interfere)
check('empty messages rejected', !!sanitize({ messages: [] }).error);
check('bad role rejected', !!sanitize({ messages: [{ role: 'tool', content: 'x' }] }).error);
check('oversized prompt rejected', !!sanitize({ messages: [{ role: 'user', content: 'x'.repeat(30000) }] }).error);
check('max_tokens clamped to cap', sanitize({ ...msg, max_tokens: 99999 }).body.max_tokens === 512);
check('client-sent model is ignored', !('model' in sanitize({ ...msg, model: 'gpt-huge' }).body));

// (e) health
r = await fetch(`${base}/projects/llm-fortress/api/health`, { headers: { Origin: 'http://localhost:5173' } });
const h = await r.json();
check('health ok via ollama', h.available === true && h.provider === 'ollama');
check('health does not leak the upstream URL', !JSON.stringify(h).includes('127.0.0.1'));

proxy.close(); mock.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
