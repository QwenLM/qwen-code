/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan C "CDP tunnel" end-to-end acceptance (issue #5626).
 *
 * Proves the REAL daemon `/cdp` path works with a MOCK extension standing in for
 * chrome.debugger (no real Chrome): a Node mock connects `/acp` and answers
 * `cdp_command` frames with page-domain CDP, then puppeteer connects to `/cdp`
 * and runs `page.evaluate(() => 1 + 1)`. PASS = evaluate === 2 through the real
 * daemon /cdp + emulator + reverse-link.
 *
 * puppeteer-core + ws load from the spike's node_modules; the daemon/CLI are the
 * real built artifacts.
 *
 * Run:
 *   node packages/cli/src/serve/cdp-tunnel/acceptance/cdp-tunnel-acceptance.mjs
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SPIKE_DIR = '/tmp/planc-spike';
const spikeRequire = createRequire(`${SPIKE_DIR}/package.json`);
const puppeteer = spikeRequire('puppeteer-core');
const { WebSocket } = spikeRequire('ws');

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
  puppeteerConnected: false,
  pages: 0,
  evaluate: null,
  error: null,
};

function log(...args) {
  console.error('[accept]', ...args);
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

    ws.on('open', () => {
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

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
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
    });

    ws.on('error', (err) => {
      if (!resolved) rejectConn(err);
    });
    ws.on('close', () => log('mock-ext: /acp closed'));
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

    // 3. puppeteer connects to the REAL daemon /cdp and drives the page.
    log('puppeteer.connect', WS_CDP);
    const browser = await puppeteer.connect({
      browserWSEndpoint: WS_CDP,
      protocolTimeout: 20_000,
    });
    out.puppeteerConnected = true;
    log('puppeteer connected');

    const pages = await browser.pages();
    out.pages = pages.length;
    log('pages:', pages.length);

    if (pages[0]) {
      out.evaluate = await pages[0]
        .evaluate(() => 1 + 1)
        .catch((e) => 'EVAL-ERR:' + e.message);
      log('page.evaluate(() => 1 + 1) =>', out.evaluate);
    }

    await browser.disconnect();
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
    out.puppeteerConnected &&
    out.pages > 0 &&
    out.evaluate === 2;

  console.log('\n=== PLAN C /cdp ACCEPTANCE RESULT ===');
  console.log(JSON.stringify(out, null, 2));
  console.log(
    `\nACCEPTANCE: ${pass ? 'PASS' : 'FAIL'} — page.evaluate(() => 1 + 1) === ${out.evaluate} through the REAL daemon /cdp + emulator + reverse-link to the mock extension`,
  );
  process.exit(pass ? 0 : 1);
}

main();
