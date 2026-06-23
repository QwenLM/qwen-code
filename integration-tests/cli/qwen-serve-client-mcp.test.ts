/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen serve` daemon — reverse tool channel (issue #5626, Phase 2),
 * end-to-end against a REAL `qwen --acp` child.
 *
 * The Chrome extension cannot be a listening MCP server: it hosts MCP tools
 * that the agent (running inside the daemon's ACP child) reaches by carrying
 * `mcp_message` JSON-RPC frames over the daemon WS. This test boots a real
 * daemon (with `QWEN_SERVE_CLIENT_MCP_OVER_WS=1`), connects a headless `ws`
 * client standing in for the extension, and exercises the full round-trip
 * WITHOUT any LLM turn:
 *
 *   1. `initialize` the ACP WS connection.
 *   2. `session/new` → spawns the real ACP child; the child's session
 *      `McpClientManager` binds `sendSdkMcpMessage` to the
 *      `qwen/control/client_mcp/message` ext-method (child → parent).
 *   3. `mcp_register { server }` → the serve provider adds an SDK-type runtime
 *      MCP server in the child; the child runs the MCP `initialize` /
 *      `tools/list` handshake, which round-trips back over the WS as
 *      `mcp_message` frames.
 *   4. The test answers those frames with a canned catalog (one tool).
 *   5. Assert the daemon acks `mcp_registered { toolCount: 1 }` AND the
 *      child's tool registry surfaces the client-hosted tool at
 *      `GET /workspace/mcp/<server>/tools`.
 *
 * Tool DISCOVERY needs no model completion — only session creation + the
 * registration handshake. The model side is backed by a local
 * OpenAI-compatible fake so the daemon boots without API keys; no prompt is
 * ever sent here.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startFakeOpenAIServer, type FakeOpenAIServer } from '../fake-openai-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN =
  process.env['TEST_CLI_PATH'] ??
  path.resolve(__dirname, '../../packages/cli/dist/index.js');
const TOKEN = 'client-mcp-integ-secret';
const REPO_ROOT = path.resolve(__dirname, '../..');

// WS upgrade + child spawn need `pgrep`-free POSIX teardown only; the suite is
// platform-agnostic, but daemon SIGTERM teardown is cleaner on POSIX. Keep it
// running everywhere `ws` works.
const SKIP = process.platform === 'win32';
const describeMaybe = SKIP ? describe.skip : describe;

let daemon: ChildProcess;
let port = 0;
let base = '';
let fakeServer: FakeOpenAIServer;
let homeDir = '';

beforeAll(async () => {
  if (SKIP) return;
  fakeServer = await startFakeOpenAIServer(() => ({
    content: 'unused — this suite never prompts',
  }));
  homeDir = mkdtempSync(path.join(tmpdir(), 'qwen-serve-client-mcp-home-'));
  daemon = spawn(
    process.execPath,
    [
      CLI_BIN,
      'serve',
      '--port',
      '0',
      '--token',
      TOKEN,
      '--hostname',
      '127.0.0.1',
      '--workspace',
      REPO_ROOT,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: homeDir,
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: fakeServer.baseUrl,
        OPENAI_MODEL: 'fake-model',
        QWEN_MODEL: 'fake-model',
        // Reverse tool channel opt-in (the contract is still gated).
        QWEN_SERVE_CLIENT_MCP_OVER_WS: '1',
      },
    },
  );
  let stderr = '';
  daemon.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString();
    if (process.env['DEBUG_CLIENT_MCP']) process.stderr.write(c);
  });
  port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    const bootTimer = setTimeout(
      () => reject(new Error(`daemon boot timeout\nstderr=${stderr}`)),
      15_000,
    );
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        daemon.stdout?.off('data', onData);
        clearTimeout(bootTimer);
        resolve(Number(m[1]));
      }
    };
    daemon.stdout!.on('data', onData);
    daemon.once('exit', (c) => {
      clearTimeout(bootTimer);
      reject(new Error(`daemon exited with ${c}\nstderr=${stderr}`));
    });
  });
  base = `http://127.0.0.1:${port}`;
}, 40_000);

afterAll(async () => {
  if (!SKIP && daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
    await new Promise((r) => {
      const t = setTimeout(() => {
        try {
          daemon.kill('SIGKILL');
        } catch {
          /* gone */
        }
        r(undefined);
      }, 5_000);
      daemon.once('exit', () => {
        clearTimeout(t);
        r(undefined);
      });
    });
  }
  await fakeServer?.close();
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
}, 15_000);

/** A canned client-hosted MCP server: answers the daemon's handshake frames. */
function answerHandshakeFrame(frame: {
  id: string;
  server: string;
  payload: { id?: number | string; method?: string };
}): { type: 'mcp_message'; id: string; server: string; payload: unknown } | undefined {
  const { payload } = frame;
  if (payload.id === undefined || payload.id === null) return undefined; // notification
  let result: unknown;
  switch (payload.method) {
    case 'initialize':
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: frame.server, version: '0.0.1' },
      };
      break;
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'chrome_read_page',
            description: 'Read the current page text',
            inputSchema: {
              type: 'object',
              properties: { selector: { type: 'string' } },
            },
          },
        ],
      };
      break;
    case 'prompts/list':
      result = { prompts: [] };
      break;
    case 'resources/list':
      result = { resources: [] };
      break;
    default:
      return {
        type: 'mcp_message',
        id: frame.id,
        server: frame.server,
        payload: {
          jsonrpc: '2.0',
          id: payload.id,
          error: { code: -32601, message: `method not found: ${payload.method}` },
        },
      };
  }
  return {
    type: 'mcp_message',
    id: frame.id,
    server: frame.server,
    payload: { jsonrpc: '2.0', id: payload.id, result },
  };
}

describeMaybe('qwen serve — reverse tool channel (client-hosted MCP over WS)', () => {
  it('discovers a client-hosted tool end-to-end via the ACP child', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    // Demux: ACP JSON-RPC replies (by id) and client-MCP frames (by type).
    const acpReplies = new Map<number, Record<string, unknown>>();
    let registeredAck: Record<string, unknown> | undefined;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['type'] === 'mcp_message') {
        const reply = answerHandshakeFrame(
          msg as unknown as {
            id: string;
            server: string;
            payload: { id?: number | string; method?: string };
          },
        );
        if (reply) ws.send(JSON.stringify(reply));
        return;
      }
      if (msg['type'] === 'mcp_registered' || msg['type'] === 'mcp_error') {
        registeredAck = msg;
        return;
      }
      if (typeof msg['id'] === 'number') {
        acpReplies.set(msg['id'] as number, msg);
      }
    });

    const waitForAcp = (id: number, timeoutMs = 20_000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          const r = acpReplies.get(id);
          if (r) return resolve(r);
          if (Date.now() - started > timeoutMs)
            return reject(new Error(`timeout waiting for ACP reply id=${id}`));
          setTimeout(tick, 25);
        };
        tick();
      });

    // 1. initialize
    ws.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );
    await waitForAcp(1);

    // 2. session/new — spawns the real ACP child + binds the session manager's
    // sendSdkMcpMessage to the client_mcp/message ext-method.
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: REPO_ROOT },
      }),
    );
    const sessionReply = await waitForAcp(2, 30_000);
    const sessionId = (sessionReply['result'] as { sessionId?: string })
      ?.sessionId;
    expect(typeof sessionId).toBe('string');

    // 3. mcp_register — provider adds an SDK-type runtime server in the child;
    // the child's discovery handshake round-trips back over THIS WS.
    ws.send(JSON.stringify({ type: 'mcp_register', server: 'chrome-tools' }));

    // 4. wait for the registration ack (proves the child discovered the tool).
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (registeredAck) return resolve();
        if (Date.now() - started > 25_000)
          return reject(new Error('timeout waiting for mcp_registered'));
        setTimeout(tick, 25);
      };
      tick();
    });

    // A surprising `mcp_error` here means the round-trip broke somewhere in the
    // child → parent → WS chain; surface its code/message for triage.
    expect(
      registeredAck,
      `expected mcp_registered, got ${JSON.stringify(registeredAck)}`,
    ).toMatchObject({ type: 'mcp_registered', server: 'chrome-tools' });
    expect(registeredAck?.['toolCount']).toBe(1);

    // 5. Secondary confirm: the child's tool registry surfaces the tool via the
    // workspace MCP tools route (REST, separate from the WS).
    const toolsRes = await fetch(`${base}/workspace/mcp/chrome-tools/tools`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(toolsRes.status).toBe(200);
    const toolsBody = (await toolsRes.json()) as {
      tools?: Array<{ name?: string; serverToolName?: string }>;
    };
    // Tool names may be server-prefixed in the registry; match the raw tool id
    // against both the registered `name` and the un-prefixed `serverToolName`.
    const hasReadPage = (toolsBody.tools ?? []).some(
      (t) =>
        t.serverToolName === 'chrome_read_page' ||
        (t.name ?? '').includes('chrome_read_page'),
    );
    expect(hasReadPage).toBe(true);

    ws.close();
  }, 60_000);
});
