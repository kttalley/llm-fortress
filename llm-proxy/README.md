# llm-proxy

The only path from the LLM Fortress browser client to inference. The browser calls
`POST /api/chat` and `GET /api/health` on its own origin; nginx routes those here; this
forwards to Ollama. The Ollama URL, the model name and any API key stay on the server.

## What it does

- **Global concurrency cap.** At most `MAX_CONCURRENT` requests (default 4) reach the GPUs
  at once, across every visitor and tab. Up to `MAX_QUEUE` more (default 8) wait up to
  `QUEUE_TIMEOUT_MS` (default 4 s). Anything beyond that gets an immediate `503`, and the
  game uses its scripted lines instead.
- **Per-IP rate limit.** Token bucket, `RATE_PER_MINUTE` (30) with `RATE_BURST` (10). Over
  the limit returns `429`.
- **CORS** limited to `ALLOWED_ORIGINS` (the site plus local dev). Other origins get `403`.
- **Input limits.** Max 20 messages, `MAX_PROMPT_CHARS` total, `max_tokens` and `num_ctx`
  clamped. The client can't choose the model.
- **Optional Groq fallback** when Ollama fails, with `GROQ_API_KEY` held here.
- **Optional upstream secret.** `UPSTREAM_AUTH_HEADER` is sent to Ollama so the GPU host's
  nginx can refuse requests that didn't come through this proxy.

No dependencies. Node 20.12 or newer.

## Run

```sh
cp .env.example .env   # fill in OLLAMA_URL, OLLAMA_MODEL
npm start              # listens on 127.0.0.1:8787
```

nginx (on the host serving the game):

```nginx
location /projects/llm-fortress/api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 75s;
}
```

Local dev: run the proxy, then `npm run dev` at the repo root; Vite forwards
`/projects/llm-fortress/api` to it.

## Lock down the upstream

The proxy only protects the GPUs if Ollama itself isn't reachable from the internet. Bind
Ollama to localhost, or put the GPU host's nginx in front of it and require the
`UPSTREAM_AUTH_HEADER` secret (or an IP allowlist for the proxy host).

## Test

```sh
node ../tests/test-llm-proxy.js   # CORS, rate limit, validation, health (mock upstream)
npm run loadtest                  # 200 concurrent requests against a mock upstream
```

Load test result (Nov 16, 2026, mock upstream at 1.5 s per reply, defaults): the upstream
never saw more than 4 requests at once; 12 requests were served (4 running plus 8 queued);
the other 188 got `503` in about 100 ms.
