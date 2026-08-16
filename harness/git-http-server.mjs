// Minimal smart-HTTP git server: wraps `git http-backend` and books every byte
// it puts on the wire, so an arm's re-fetch cost is measured, not asserted.
//
// GIT_PROJECT_ROOT  bare repos live here (<root>/<owner>/<repo>.git)
// LEDGER            JSONL ledger path (one line per request + per driver mark)
// RATE_BPS          throttle in bytes/sec applied to the response body (0 = off)
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const ROOT = process.env.GIT_PROJECT_ROOT;
const PORT = Number(process.env.PORT || 8080);
const LEDGER = process.env.LEDGER;
const RATE = Number(process.env.RATE_BPS || 0);
// The driver can raise the throttle mid-run (a file, re-read per request) so
// only the phase under measurement pays the slow-link penalty.
const RATE_FILE = process.env.RATE_FILE || '';
function currentRate() {
  if (!RATE_FILE) return RATE;
  try {
    return Number(fs.readFileSync(RATE_FILE, 'utf8').trim()) || 0;
  } catch {
    return RATE;
  }
}

const log = (o) => fs.appendFileSync(LEDGER, JSON.stringify(o) + '\n');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__mark') {
    log({ kind: 'mark', label: url.searchParams.get('label'), t: Date.now() });
    res.end('ok');
    return;
  }
  if (url.pathname === '/__quit') {
    res.end('bye');
    setTimeout(() => process.exit(0), 50);
    return;
  }

  const started = Date.now();
  const rate = currentRate();
  const env = {
    PATH: process.env.PATH,
    GIT_PROJECT_ROOT: ROOT,
    GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: req.method,
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.slice(1),
    REMOTE_ADDR: req.socket.remoteAddress || '127.0.0.1',
    REMOTE_USER: 'runner',
    SERVER_PROTOCOL: 'HTTP/1.1',
    CONTENT_TYPE: req.headers['content-type'] || '',
    CONTENT_LENGTH: req.headers['content-length'] || '',
    HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '',
    // Without this git falls back to protocol v0 and the transfer shape
    // stops matching what a real fetch does.
    GIT_PROTOCOL: req.headers['git-protocol'] || '',
  };

  const child = spawn('git', ['http-backend'], { env });
  let reqBytes = 0;
  req.on('data', (c) => {
    reqBytes += c.length;
  });
  req.pipe(child.stdin);
  child.stdin.on('error', () => {});

  let head = Buffer.alloc(0);
  let headersDone = false;
  let respBytes = 0;
  const queue = [];
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      let chunk = queue.shift();
      if (rate > 0) {
        // Pace the body at RATE bytes/sec in 64 KiB slices.
        const SLICE = 65536;
        for (let off = 0; off < chunk.length; off += SLICE) {
          const part = chunk.subarray(off, Math.min(off + SLICE, chunk.length));
          res.write(part);
          respBytes += part.length;
          await sleep((part.length / rate) * 1000);
        }
      } else {
        res.write(chunk);
        respBytes += chunk.length;
      }
    }
    draining = false;
  }

  child.stdout.on('data', (c) => {
    if (!headersDone) {
      head = Buffer.concat([head, c]);
      const sep = head.indexOf('\r\n\r\n') !== -1 ? '\r\n\r\n' : '\n\n';
      const i = head.indexOf(sep);
      if (i === -1) return;
      const rawHeaders = head.subarray(0, i).toString('utf8');
      const rest = head.subarray(i + sep.length);
      let status = 200;
      for (const line of rawHeaders.split(/\r?\n/)) {
        const m = /^([^:]+):\s*(.*)$/.exec(line);
        if (!m) continue;
        if (m[1].toLowerCase() === 'status') status = parseInt(m[2], 10) || 200;
        else res.setHeader(m[1], m[2]);
      }
      res.writeHead(status);
      headersDone = true;
      if (rest.length) queue.push(rest);
    } else {
      queue.push(c);
    }
    drain();
  });

  child.on('close', async (code) => {
    while (draining || queue.length) await sleep(5);
    res.end();
    log({
      kind: 'req',
      t: started,
      ms: Date.now() - started,
      method: req.method,
      path: url.pathname,
      query: url.search.slice(1),
      reqBytes,
      respBytes,
      exit: code,
      rate,
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(`${LEDGER}.ready`, String(PORT));
  console.log(`git-http-server on ${PORT} root=${ROOT} rate=${RATE}`);
});
