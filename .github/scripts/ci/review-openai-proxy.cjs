const http = require('node:http');
const { Readable } = require('node:stream');
const { timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');

const base = new URL(process.env.UPSTREAM_BASE_URL);
const basePath = base.pathname.replace(/\/+$/, '');
const token = process.env.PROXY_TOKEN;
const upstreamKey = process.env.UPSTREAM_API_KEY_FILE
  ? fs.readFileSync(process.env.UPSTREAM_API_KEY_FILE, 'utf8').trim()
  : process.env.UPSTREAM_API_KEY;
const portFile = process.env.OPENAI_PROXY_PORT_FILE;
if (!token || !upstreamKey) {
  console.error(
    'review-openai-proxy: PROXY_TOKEN and an upstream key are required',
  );
  process.exit(1);
}
const tokenBuf = Buffer.from(String(token));
const timeoutMs = Number(process.env.OPENAI_PROXY_TIMEOUT_MS || 600_000);
function bearerMatches(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length));
  return (
    presented.length === token.length &&
    presented.length > 0 &&
    timingSafeEqual(presented, tokenBuf)
  );
}
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  try {
    // npm is bundled in the proxy image; its pinned Undici supplies Node
    // fetch's proxy dispatcher. Runner egress settings arrive explicitly.
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require(
      process.env.UNDICI_MODULE ||
        '/usr/local/lib/node_modules/npm/node_modules/undici',
    );
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch (error) {
    console.error('Cannot configure proxy egress:', error.message);
    process.exit(1);
  }
}
const server = http.createServer(async (req, res) => {
  const incoming = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && incoming.pathname === '/__health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  const target = new URL(base.origin);
  let path = incoming.pathname;
  if (path.startsWith('/v1/')) path = path.slice(3);
  if (basePath && basePath !== '/') path = `${basePath}${path}`;
  target.pathname = path;
  target.search = incoming.search;
  if (req.method !== 'POST' || !target.pathname.endsWith('/chat/completions')) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!bearerMatches(req.headers.authorization)) {
    res.writeHead(401);
    res.end();
    return;
  }
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('content-length');
  headers.set('authorization', `Bearer ${upstreamKey}`);
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: req,
      duplex: 'half',
      signal: controller.signal,
    });
    res.writeHead(
      upstream.status,
      Object.fromEntries(
        [...upstream.headers].filter(
          ([key]) =>
            ![
              'content-encoding',
              'content-length',
              'connection',
              'transfer-encoding',
            ].includes(key),
        ),
      ),
    );
    if (!upstream.body) {
      clearTimeout(timer);
      res.end();
      return;
    }
    // Re-arm after the headers so an upstream that flushes headers then stalls
    // before the first byte still trips the budget (R1-16).
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const body = Readable.fromWeb(upstream.body);
    body.on('data', () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), timeoutMs);
    });
    body.on('end', () => clearTimeout(timer));
    body.on('error', () => res.destroy());
    res.on('close', () => {
      clearTimeout(timer);
      controller.abort();
    });
    body.pipe(res);
  } catch {
    clearTimeout(timer);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
});
server.listen(Number(process.env.OPENAI_PROXY_PORT ?? 8080), '0.0.0.0', () => {
  if (portFile) {
    fs.writeFileSync(portFile, String(server.address().port), { mode: 0o600 });
  }
});
