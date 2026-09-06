/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan C real-Chrome local verification (issue #5626).
 *
 * Connects a direct CDP JSON-RPC client to a RUNNING daemon's `/cdp` and reads
 * the user's REAL active tab through the extension's `chrome.debugger`. Unlike
 * `cdp-tunnel-acceptance.mjs` (mock extension, no browser), this needs a real
 * Chrome with the extension loaded.
 *
 * Prereqs:
 *   1. Build: `npm run build` (cli + extension).
 *   2. Start the daemon with the tunnel on:
 *        QWEN_SERVE_CDP_TUNNEL_OVER_WS=1 QWEN_SERVE_CLIENT_MCP_OVER_WS=1 \
 *          npm start -- serve --port 4170 --hostname 127.0.0.1 --no-web \
 *          --workspace <abs-repo> --allow-origin chrome-extension://<ext-id>
 *   3. chrome://extensions → Load unpacked →
 *        packages/chrome-extension/dist/extension
 *   4. Open the extension's "Service Worker" DevTools to keep the worker awake
 *      (until the extension ships a chrome.alarms keepalive), and have a normal
 *      page as the active tab.
 *
 * Run: `node packages/cli/src/serve/cdp-tunnel/acceptance/real-tab.mjs`
 * PASS = it prints your real tab's url/title/body (a debugger banner appears).
 */

const WS = process.env.WS || `ws://127.0.0.1:${process.env.PORT || 4170}/cdp`;
const out = {
  connected: false,
  pages: 0,
  url: null,
  title: null,
  bodyText: null,
  error: null,
};

function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket connection failed: ${url}`));
    };
    const cleanup = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
    };
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
  });
}

async function messageDataToString(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return await data.text();
  }
  return String(data);
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Set();
    ws.addEventListener('message', (event) => {
      void this.handleMessage(event.data);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    this.ws.send(JSON.stringify(frame));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for CDP response id=${id}`));
      }, 25_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  waitForEvent(predicate, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.eventWaiters.delete(waiter);
          reject(new Error('timeout waiting for CDP event'));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.eventWaiters.add(waiter);
    });
  }

  async handleMessage(data) {
    let frame;
    try {
      frame = JSON.parse(await messageDataToString(data));
    } catch {
      return;
    }

    if (frame.id !== undefined && this.pending.has(frame.id)) {
      const pending = this.pending.get(frame.id);
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.error) {
        pending.reject(new Error(JSON.stringify(frame.error)));
      } else {
        pending.resolve(frame.result);
      }
    }

    for (const waiter of [...this.eventWaiters]) {
      if (!waiter.predicate(frame)) continue;
      clearTimeout(waiter.timer);
      this.eventWaiters.delete(waiter);
      waiter.resolve(frame);
    }
  }
}

async function getPageSession(client) {
  await client.send('Browser.getVersion');
  await client.send('Target.setDiscoverTargets', { discover: true });

  const tabAttached = client.waitForEvent(
    (frame) =>
      frame.method === 'Target.attachedToTarget' &&
      frame.params?.targetInfo?.type === 'tab',
  );
  await client.send('Target.setAutoAttach', {
    autoAttach: true,
    flatten: true,
    waitForDebuggerOnStart: false,
  });
  const tabSessionId = (await tabAttached).params.sessionId;

  const pageAttached = client.waitForEvent(
    (frame) =>
      frame.method === 'Target.attachedToTarget' &&
      frame.sessionId === tabSessionId &&
      frame.params?.targetInfo?.type === 'page',
  );
  await client.send(
    'Target.setAutoAttach',
    {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
    },
    tabSessionId,
  );
  return (await pageAttached).params.sessionId;
}

async function evaluate(client, sessionId, expression) {
  const result = await client.send(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    sessionId,
  );
  return result?.result?.value;
}

try {
  console.log('[real-tab] connecting direct CDP client to', WS);
  const ws = await connectWebSocket(WS);
  const client = new CdpClient(ws);
  out.connected = true;
  const pageSessionId = await getPageSession(client);
  out.pages = 1;
  out.url = await evaluate(client, pageSessionId, 'document.location.href');
  out.title = await evaluate(client, pageSessionId, 'document.title');
  out.bodyText = await evaluate(
    client,
    pageSessionId,
    "document.body?.innerText?.slice(0, 240) || '(no body text)'",
  );
  ws.close();
} catch (e) {
  out.error = e.message;
}

console.log('\n=== REAL-CHROME /cdp RESULT ===');
console.log(JSON.stringify(out, null, 2));
console.log(
  '\nREAL-TAB READ:',
  out.connected &&
    out.pages > 0 &&
    typeof out.title === 'string' &&
    !out.title.startsWith('TITLE-ERR')
    ? 'PASS — read your real tab'
    : out.error
      ? `FAIL — ${out.error}`
      : 'FAIL',
);
process.exit(0);
