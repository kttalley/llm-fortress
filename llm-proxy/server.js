/**
 * LLM Fortress inference proxy
 *
 * The only path from the browser to inference. The browser never sees the
 * Ollama URL or any API key; it calls POST /api/chat and GET /api/health here.
 *
 * - Forwards to Ollama's OpenAI-compatible chat endpoint (URL and model from
 *   server-side env only).
 * - Global concurrency cap across every tab and visitor (default 4) with a
 *   short bounded queue. When the queue is full, or a request waits too long,
 *   it gets a fast 503 so the game falls back to its scripted lines.
 * - Per-IP token-bucket rate limit (429 when exceeded).
 * - CORS limited to the site origin plus local dev origins.
 * - Optional Groq fallback with the key held here, never in the client.
 * - Optional shared-secret header to the upstream, so the GPU host's nginx
 *   can refuse anything that didn't come through this proxy.
 *
 * No dependencies: Node's built-in http and fetch. Node 20.12+ (for
 * process.loadEnvFile); without it, set the env vars another way.
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';

try { process.loadEnvFile?.(new URL('.env', import.meta.url)); } catch { /* no .env file is fine */ }

const env = process.env;
const int = (v, d) => (Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : d);

export const config = {
  port: int(env.PORT, 8787),
  host: env.HOST || '127.0.0.1',
  ollamaUrl: env.OLLAMA_URL || '',           // e.g. https://gpu-host/v1/chat/completions
  ollamaModel: env.OLLAMA_MODEL || '',
  upstreamAuthHeader: env.UPSTREAM_AUTH_HEADER || '', // e.g. "X-Proxy-Token: <secret>"
  groqApiKey: env.GROQ_API_KEY || '',
  groqModel: env.GROQ_MODEL || 'llama-3.1-8b-instant',
  maxConcurrent: int(env.MAX_CONCURRENT, 4),
  maxQueue: int(env.MAX_QUEUE, 8),
  queueTimeoutMs: int(env.QUEUE_TIMEOUT_MS, 4000),
  upstreamTimeoutMs: int(env.UPSTREAM_TIMEOUT_MS, 60000),
  ratePerMinute: int(env.RATE_PER_MINUTE, 30),
  rateBurst: int(env.RATE_BURST, 10),
  trustProxy: env.TRUST_PROXY === '1',
  allowedOrigins: (env.ALLOWED_ORIGINS ||
    'https://design.kristiantalley.com,http://localhost:5173,http://localhost:4173')
    .split(',').map(s => s.trim()).filter(Boolean),
  maxBodyBytes: int(env.MAX_BODY_BYTES, 64 * 1024),
  maxPromptChars: int(env.MAX_PROMPT_CHARS, 24000),
  maxTokensCap: int(env.MAX_TOKENS_CAP, 512),
  numCtxCap: int(env.NUM_CTX_CAP, 8192),
};

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ---------------------------------------------------------------- limiter

/** Global concurrency gate with a bounded FIFO queue. */
export function createGate({ maxConcurrent, maxQueue, queueTimeoutMs }) {
  let active = 0;
  const queue = [];
  const stats = { served: 0, rejectedFull: 0, rejectedTimeout: 0, peakActive: 0, peakQueue: 0 };

  function release() {
    active--;
    const next = queue.shift();
    if (next) { clearTimeout(next.timer); active++; stats.peakActive = Math.max(stats.peakActive, active); next.resolve(true); }
  }

  /** Resolves true with a slot held (call release when done), or false on overflow/timeout. */
  function acquire() {
    if (active < maxConcurrent) {
      active++; stats.peakActive = Math.max(stats.peakActive, active);
      return Promise.resolve(true);
    }
    if (queue.length >= maxQueue) { stats.rejectedFull++; return Promise.resolve(false); }
    return new Promise(resolve => {
      const entry = { resolve };
      entry.timer = setTimeout(() => {
        const i = queue.indexOf(entry);
        if (i >= 0) queue.splice(i, 1);
        stats.rejectedTimeout++;
        resolve(false);
      }, queueTimeoutMs);
      queue.push(entry);
      stats.peakQueue = Math.max(stats.peakQueue, queue.length);
    });
  }

  return { acquire, release, stats, state: () => ({ active, queued: queue.length }) };
}

/** Per-key token bucket. */
export function createRateLimiter({ ratePerMinute, rateBurst }) {
  const buckets = new Map();
  const refillPerMs = ratePerMinute / 60000;
  return function allow(key, now = Date.now()) {
    let b = buckets.get(key);
    if (!b) { b = { tokens: rateBurst, at: now }; buckets.set(key, b); }
    b.tokens = Math.min(rateBurst, b.tokens + (now - b.at) * refillPerMs);
    b.at = now;
    if (buckets.size > 10000) { // keep memory bounded
      for (const [k, v] of buckets) if (v.tokens >= rateBurst) buckets.delete(k);
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

// ---------------------------------------------------------------- helpers

function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  if (config.trustProxy) {
    const real = req.headers['x-real-ip'];
    if (real) return String(real);
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > config.maxBodyBytes) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/** Validate and clamp the client payload. Returns { body } or { error }. */
export function sanitize(input) {
  const msgs = Array.isArray(input?.messages) ? input.messages : null;
  if (!msgs || msgs.length === 0 || msgs.length > 20) return { error: 'messages must be a non-empty array (max 20)' };
  let chars = 0;
  for (const m of msgs) {
    if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') {
      return { error: 'each message needs role system|user|assistant and string content' };
    }
    chars += m.content.length;
  }
  if (chars > config.maxPromptChars) return { error: `prompt too long (max ${config.maxPromptChars} chars)` };
  const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const stop = Array.isArray(input.stop) ? input.stop.filter(s => typeof s === 'string').slice(0, 4) : undefined;
  return {
    body: {
      messages: msgs.map(m => ({ role: m.role, content: m.content })),
      max_tokens: num(input.max_tokens, 1, config.maxTokensCap, 100),
      temperature: num(input.temperature, 0, 2, 0.8),
      top_p: num(input.top_p, 0, 1, 0.9),
      stop: stop && stop.length ? stop : undefined,
      numCtx: num(input.num_ctx, 512, config.numCtxCap, 4096),
    },
  };
}

async function callUpstream(url, headers, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload), signal: controller.signal });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const data = await r.json();
    return { content: data.choices?.[0]?.message?.content?.trim() || '', usage: data.usage };
  } finally {
    clearTimeout(timer);
  }
}

function upstreamHeaders() {
  const h = {};
  const i = config.upstreamAuthHeader.indexOf(':');
  if (i > 0) h[config.upstreamAuthHeader.slice(0, i).trim()] = config.upstreamAuthHeader.slice(i + 1).trim();
  return h;
}

async function generate(b) {
  if (config.ollamaUrl && config.ollamaModel) {
    try {
      const out = await callUpstream(config.ollamaUrl, upstreamHeaders(), {
        model: config.ollamaModel, messages: b.messages, max_tokens: b.max_tokens, temperature: b.temperature,
        top_p: b.top_p, stop: b.stop, stream: false, think: false, options: { num_ctx: b.numCtx },
      });
      return { ...out, provider: 'ollama' };
    } catch (e) {
      console.warn(`[proxy] ollama failed: ${e.message}`);
    }
  }
  if (config.groqApiKey) {
    try {
      const out = await callUpstream(GROQ_URL, { Authorization: `Bearer ${config.groqApiKey}` }, {
        model: config.groqModel, messages: b.messages, max_tokens: b.max_tokens, temperature: b.temperature, stop: b.stop,
      });
      return { ...out, provider: 'groq' };
    } catch (e) {
      console.warn(`[proxy] groq failed: ${e.message}`);
    }
  }
  return null;
}

let healthCache = { at: 0, value: null };
async function health() {
  if (Date.now() - healthCache.at < 10000 && healthCache.value) return healthCache.value;
  let ollama = false;
  if (config.ollamaUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const r = await fetch(config.ollamaUrl.replace(/\/chat\/completions\/?$/, '/models'), { headers: upstreamHeaders(), signal: controller.signal });
      ollama = r.ok;
    } catch { ollama = false; } finally { clearTimeout(timer); }
  }
  const value = ollama ? { available: true, provider: 'ollama' }
    : config.groqApiKey ? { available: true, provider: 'groq' }
    : { available: false, provider: null };
  healthCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------- server

export function createServer(overrides = {}) {
  Object.assign(config, overrides);
  const gate = createGate(config);
  const allow = createRateLimiter(config);
  const generateImpl = overrides.generateImpl || generate;

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const originOk = !origin || config.allowedOrigins.includes(origin);
    const cors = origin && originOk
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }
      : {};
    if (!originOk) return send(res, 403, { error: 'origin not allowed' });
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    const path = (req.url || '').split('?')[0].replace(/\/+$/, '');

    if (req.method === 'GET' && path.endsWith('/api/health')) {
      return send(res, 200, { ...(await health()), ...gate.state() }, cors);
    }

    if (req.method === 'POST' && path.endsWith('/api/chat')) {
      if (!allow(clientIp(req))) return send(res, 429, { error: 'rate limited' }, { ...cors, 'Retry-After': '10' });
      let input;
      try { input = await readJson(req); } catch (e) { return send(res, e.status || 400, { error: e.message }, cors); }
      const { body, error } = sanitize(input);
      if (error) return send(res, 400, { error }, cors);

      const got = await gate.acquire();
      if (!got) return send(res, 503, { error: 'busy' }, { ...cors, 'Retry-After': '5' });
      try {
        const out = await generateImpl(body);
        gate.stats.served++;
        if (!out) return send(res, 502, { error: 'no provider available' }, cors);
        return send(res, 200, { choices: [{ message: { role: 'assistant', content: out.content } }], usage: out.usage, provider: out.provider }, cors);
      } catch (e) {
        return send(res, 502, { error: 'generation failed' }, cors);
      } finally {
        gate.release();
      }
    }

    return send(res, 404, { error: 'not found' }, cors);
  });
  server.gate = gate;
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`[proxy] listening on http://${config.host}:${config.port} | cap ${config.maxConcurrent}, queue ${config.maxQueue}, ` +
      `ollama ${config.ollamaUrl ? 'configured' : 'NOT configured'}, groq ${config.groqApiKey ? 'configured' : 'off'}`);
  });
}
