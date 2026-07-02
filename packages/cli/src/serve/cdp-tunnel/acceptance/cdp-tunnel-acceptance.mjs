/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan C "CDP tunnel" end-to-end acceptance (issue #5626).
 *
 * Proves the REAL daemon `/cdp` path works with a MOCK extension standing in for
 * chrome.debugger (no real Chrome): a Node mock connects `/acp` and answers
 * `cdp_command` frames with page-domain CDP, then a direct CDP JSON-RPC client
 * connects to `/cdp` and runs `Runtime.evaluate`. PASS = evaluate === 2 through
 * the real daemon /cdp + emulator + reverse-link.
 *
 * Run:
 *   node packages/cli/src/serve/cdp-tunnel/acceptance/cdp-tunnel-acceptance.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
// repo root = .../packages/cli/src/serve/cdp-tunnel/acceptance -> up 6
const REPO_ROOT = resolve(__dirname, '../../../../../..');

const HOST = '127.0.0.1';
const PORT = 9710;
const BASE = `http://${HOST}:${PORT}`;
const WS_ACP = `ws://${HOST}:${PORT}/acp`;
const WS_CDP = `ws://${HOST}:${PORT}/cdp`;
const SERVER_NAME = 'chrome-tools';
const ACP_INIT_ID = 'mock-ext-acp-init';

const out = {
  daemonHealthy: false,
  mockExtRegistered: false,
  cdpAttached: false,
  cdpClientConnected: false,
  pages: 0,
  evaluate: null,
  error: null,
};

function log(...args) {
  console.error('[accept]', ...args);
}

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
      }, 20_000);
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

async function driveCdpEndpoint() {
  const ws = await connectWebSocket(WS_CDP);
  const client = new CdpClient(ws);
  out.cdpClientConnected = true;

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
  const pageSessionId = (await pageAttached).params.sessionId;

  const result = await client.send(
    'Runtime.evaluate',
    { expression: '1 + 1', returnByValue: true },
    pageSessionId,
  );
  out.pages = 1;
  out.evaluate = result?.result?.value;
  ws.close();
}

/** Page-domain CDP answer, copied from /tmp/planc-spike/mock-cdp.mjs. */
function pageDomainAnswer(method, params) {
  switch (method) {
    case 'Page.createIsolatedWorld':
      return { executionContextId: 2 };
    case 'Runtime.callFunctionOn':
    case 'Runtime.evaluate': {
      const fn =
        (params && (params.functionDeclaration || params.expression)) || '';
      const value = /title|innerText|textContent/i.test(fn)
        ? { type: 'string', value: 'Mock Page' }
        : { type: 'number', value: 2 };
      return { result: value };
    }
    case 'Page.getFrameTree':
      return {
        frameTree: {
          frame: {
            id: 'FRAME-1',
            loaderId: 'L1',
            url: 'https://example.com/',
            domainAndRegistry: 'example.com',
            securityOrigin: 'https://example.com',
            mimeType: 'text/html',
            secureContextType: 'Secure',
            crossOriginIsolatedContextType: 'NotIsolated',
            gatedAPIFeatures: [],
          },
          childFrames: [],
        },
      };
    case 'Page.getNavigationHistory':
      return {
        currentIndex: 0,
        entries: [
          {
            id: 1,
            url: 'https://example.com/',
            userTypedURL: 'https://example.com/',
            title: 'Mock Page',
            transitionType: 'typed',
          },
        ],
      };
    default:
      return {};
  }
}

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.status === 200) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * The MOCK EXTENSION: connect /acp, ACP initialize, mcp_register, then service
 * cdp_attach / cdp_command frames by answering page-domain CDP.
 */
function startMockExtension() {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(WS_ACP);
    let resolved = false;

    ws.addEventListener('open', () => {
      log('mock-ext: /acp open; sending ACP initialize');
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: ACP_INIT_ID,
          method: 'initialize',
          // Identify as the CDP bridge so the daemon's clientInfo.name gate
          // registers this mock extension (mirrors the real extension).
          params: { clientInfo: { name: 'qwen-cdp-bridge', version: '1.0.0' } },
        }),
      );
    });

    ws.addEventListener('message', (event) => {
      void handleMessage(event.data);
    });

    async function handleMessage(data) {
      let msg;
      try {
        msg = JSON.parse(await messageDataToString(data));
      } catch {
        return;
      }

      // ACP initialize ack -> register our MCP server and resolve. The CDP path
      // doesn't depend on mcp_registered (the daemon binds the bridge on the
      // first inbound `cdp_*` frame); `mcp_register` just mirrors the real
      // extension's sequence.
      if (msg.id === ACP_INIT_ID && ('result' in msg || 'error' in msg)) {
        if (msg.error) {
          rejectConn(new Error('ACP initialize failed'));
          return;
        }
        log('mock-ext: ACP initialized; mcp_register', SERVER_NAME);
        ws.send(JSON.stringify({ type: 'mcp_register', server: SERVER_NAME }));
        if (!resolved) {
          resolved = true;
          out.mockExtRegistered = true;
          resolveConn(ws);
        }
        return;
      }

      if (msg.type === 'mcp_registered' && msg.server === SERVER_NAME) {
        log('mock-ext: mcp_registered');
        return;
      }

      // --- CDP tunnel frames from the daemon ---
      if (msg.type === 'cdp_attach') {
        out.cdpAttached = true;
        log('mock-ext: cdp_attach -> cdp_attached');
        ws.send(
          JSON.stringify({
            type: 'cdp_attached',
            id: msg.id,
            url: 'https://example.com/',
            title: 'Mock Page',
          }),
        );
        return;
      }

      if (msg.type === 'cdp_command') {
        const { id, method, params } = msg;
        log(`mock-ext: cdp_command <- ${method} (id=${id})`);
        // Runtime.enable: ack + emit executionContextCreated (a real Chrome
        // emits this automatically; the mock synthesizes it so page.evaluate
        // can resolve a context).
        if (method === 'Runtime.enable') {
          ws.send(JSON.stringify({ type: 'cdp_result', id, result: {} }));
          ws.send(
            JSON.stringify({
              type: 'cdp_event',
              method: 'Runtime.executionContextCreated',
              params: {
                context: {
                  id: 1,
                  origin: 'https://example.com',
                  name: '',
                  uniqueId: 'u1',
                  auxData: {
                    frameId: 'FRAME-1',
                    isDefault: true,
                    type: 'default',
                  },
                },
              },
            }),
          );
          return;
        }
        const result = pageDomainAnswer(method, params);
        ws.send(JSON.stringify({ type: 'cdp_result', id, result }));
        return;
      }
      // ignore other /acp traffic
    }

    ws.addEventListener('error', () => {
      if (!resolved) rejectConn(new Error('mock extension WebSocket failed'));
    });
    ws.addEventListener('close', () => log('mock-ext: /acp closed'));
  });
}

async function main() {
  const workspace = mkdtempSync(`${tmpdir()}/planc-ws-`);
  log('repo root:', REPO_ROOT);
  log('workspace:', workspace);

  // 1. Start the REAL daemon with the flags on.
  const daemon = spawn(
    'npm',
    [
      'start',
      '--',
      'serve',
      '--port',
      String(PORT),
      '--hostname',
      HOST,
      '--no-web',
      '--workspace',
      workspace,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        QWEN_SERVE_CDP_TUNNEL_OVER_WS: '1',
        QWEN_SERVE_CLIENT_MCP_OVER_WS: '1',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );

  const cleanup = () => {
    try {
      daemon.kill('SIGTERM');
    } catch {
      /* gone */
    }
  };
  process.on('exit', cleanup);

  try {
    log('waiting for /health ...');
    out.daemonHealthy = await waitForHealth();
    if (!out.daemonHealthy)
      throw new Error('daemon /health never returned 200');
    log('daemon healthy');

    // 2. Mock extension connects + registers over /acp.
    const extWs = await startMockExtension();

    // 3. A direct CDP client connects to the REAL daemon /cdp and drives the page.
    log('direct CDP connect', WS_CDP);
    await driveCdpEndpoint();
    log('Runtime.evaluate 1 + 1 =>', out.evaluate);

    extWs.close();
  } catch (e) {
    out.error = e.message;
    log('ERROR:', e.message);
  } finally {
    cleanup();
  }

  const pass =
    out.daemonHealthy &&
    out.mockExtRegistered &&
    out.cdpClientConnected &&
    out.pages > 0 &&
    out.evaluate === 2;

  console.log('\n=== PLAN C /cdp ACCEPTANCE RESULT ===');
  console.log(JSON.stringify(out, null, 2));
  console.log(
    `\nACCEPTANCE: ${pass ? 'PASS' : 'FAIL'} — Runtime.evaluate 1 + 1 === ${out.evaluate} through the REAL daemon /cdp + emulator + reverse-link to the mock extension`,
  );
  process.exit(pass ? 0 : 1);
}

main();
