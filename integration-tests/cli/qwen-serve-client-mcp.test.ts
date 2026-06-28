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
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

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

// Sentinel embedded in the tool-call test's prompt. The fake model only emits a
// `chrome_read_page` tool call when it sees this marker AND the conversation
// does not yet carry a tool result — so the discovery test (which never
// prompts) and any other turn keep getting a plain assistant reply.
const READ_PAGE_PROMPT_SENTINEL = 'CLIENT_MCP_CALL_READ_PAGE';
const FINAL_ASSISTANT_TEXT = 'done — read the page';
// The agent registers MCP tools under their fully-qualified
// `mcp__<server>__<tool>` name (see `DiscoveredMCPTool`), and a tool call must
// use the EXACT registered name to resolve in the tool registry. A real model
// is handed this fully-qualified name in the tool declarations / via ToolSearch,
// so the fake model emits it verbatim. The reverse channel still forwards the
// bare `chrome_read_page` to the client-hosted server (the prefix is the
// agent-side registry id, stripped before the MCP `tools/call`).
const CLIENT_MCP_SERVER = 'chrome-tools';
const READ_PAGE_TOOL_NAME = `mcp__${CLIENT_MCP_SERVER}__chrome_read_page`;

beforeAll(async () => {
  if (SKIP) return;
  // Two-step mock conversation for the reverse-channel tools/call test:
  //   turn 1 (prompt carries the sentinel, no tool result yet) → emit a
  //           `chrome_read_page` tool_call so the agent drives the client-hosted
  //           MCP tool over the reverse WS channel;
  //   turn 2 (the tool result has been fed back) → a normal final assistant
  //           message, ending the turn.
  // Branching on whether `messages` already contains a tool result keeps the
  // mock stateless across retries; the request counter is left to the harness.
  fakeServer = await startFakeOpenAIServer(({ body }) => {
    const messages = JSON.stringify(body['messages'] ?? []);
    const wantsReadPage = messages.includes(READ_PAGE_PROMPT_SENTINEL);
    const hasToolResult =
      messages.includes('"role":"tool"') || messages.includes('"tool_call_id"');
    if (wantsReadPage && !hasToolResult) {
      return { toolCalls: [fakeToolCall(READ_PAGE_TOOL_NAME, {})] };
    }
    if (wantsReadPage && hasToolResult) {
      return { content: FINAL_ASSISTANT_TEXT };
    }
    return { content: 'unused — this suite only prompts in the tools/call test' };
  });
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

/** Canned text the client-hosted `chrome_read_page` tool returns on a call. */
const READ_PAGE_RESULT_TEXT = '<page markdown> hello from the chrome extension';

/**
 * A canned client-hosted MCP server: answers the daemon's reverse-channel
 * frames. Covers the discovery handshake (`initialize` / `tools/list` / ...)
 * AND an actual `tools/call` of `chrome_read_page`, returning a canned MCP
 * `CallToolResult`. `onReadPageCall` (when provided) records that the call
 * reached this stand-in extension over the reverse channel, with the args the
 * agent forwarded.
 */
function answerHandshakeFrame(
  frame: {
    id: string;
    server: string;
    payload: {
      id?: number | string;
      method?: string;
      params?: { name?: string; arguments?: unknown };
    };
  },
  onReadPageCall?: (args: unknown) => void,
): { type: 'mcp_message'; id: string; server: string; payload: unknown } | undefined {
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
    case 'tools/call': {
      // The reverse channel delivered a real model-driven tool call. Echo back
      // a canned MCP CallToolResult, exactly as the extension would after
      // reading the live page.
      const toolName = payload.params?.name;
      if (toolName !== 'chrome_read_page') {
        return {
          type: 'mcp_message',
          id: frame.id,
          server: frame.server,
          payload: {
            jsonrpc: '2.0',
            id: payload.id,
            error: { code: -32602, message: `unknown tool: ${String(toolName)}` },
          },
        };
      }
      onReadPageCall?.(payload.params?.arguments);
      result = {
        content: [{ type: 'text', text: READ_PAGE_RESULT_TEXT }],
      };
      break;
    }
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

  // FULL reverse-channel loop, end-to-end: this test drives the genuine
  // model→agent→tools/call→reverse-WS→ws-client→result path and asserts the
  // tool result is consumed by the agent's turn.
  //
  // The session-scoping fix (#5626) makes the runtime-added client-hosted MCP
  // server reach the PER-SESSION tool registry, not just the bootstrap one:
  //
  //   • `mcp_register` → `workspaceMcpRuntimeAdd` adds the server to the
  //     BOOTSTRAP/workspace Config (so discovery + `GET /workspace/mcp/.../tools`
  //     see it) AND fans the add out to every active session's manager
  //     (packages/cli/src/acp-integration/acpAgent.ts), binding THAT session's
  //     `sendSdkMcpMessage` (the `__clientMcpOverWs` reverse path).
  //   • A session created LATER also inherits the bootstrap Config's runtime MCP
  //     servers in `newSessionConfig` before `config.initialize()`.
  //
  // So a model-driven `tools/call` for `chrome_read_page` now resolves in the
  // session registry, crosses the reverse WS channel to this stand-in
  // extension, returns a `CallToolResult`, and the agent's turn consumes it.
  //
  // This test does session/new THEN mcp_register (the "register after a session
  // already exists" timing), exercising the fan-out path specifically.
  it('drives a model→agent tools/call of chrome_read_page over the reverse WS channel and consumes the result', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    // Records every reverse-channel `tools/call` frame the stand-in extension
    // saw, plus the forwarded arguments — this is the model→agent→child→parent→WS
    // path the discovery test never exercises.
    const readPageCalls: unknown[] = [];

    const acpReplies = new Map<number, Record<string, unknown>>();
    let registeredAck: Record<string, unknown> | undefined;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg['type'] === 'mcp_message') {
        // Same canned client-hosted MCP server as the discovery test, now also
        // answering `tools/call`. Record `chrome_read_page` invocations so the
        // assertions below can prove the reverse round-trip fired.
        const reply = answerHandshakeFrame(
          msg as unknown as {
            id: string;
            server: string;
            payload: {
              id?: number | string;
              method?: string;
              params?: { name?: string; arguments?: unknown };
            };
          },
          (args) => readPageCalls.push(args),
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

    // 1. initialize + 2. session/new (real ACP child) — identical to discovery.
    ws.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );
    await waitForAcp(1);
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
      ?.sessionId as string;
    expect(typeof sessionId).toBe('string');

    // 3. mcp_register chrome-tools + wait for the ack (tool discovered).
    ws.send(JSON.stringify({ type: 'mcp_register', server: 'chrome-tools' }));
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
    expect(
      registeredAck,
      `expected mcp_registered, got ${JSON.stringify(registeredAck)}`,
    ).toMatchObject({ type: 'mcp_registered', server: 'chrome-tools' });
    expect(registeredAck?.['toolCount']).toBe(1);

    // 4. Pin the session to `yolo` so the model-emitted tool call auto-approves
    // (no human in the loop on the WS) — otherwise a `permission_request` would
    // stall the turn forever. Matches the daemon's intended "extension drives
    // tools unattended" posture.
    const modeRes = await fetch(`${base}/session/${sessionId}/approval-mode`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ mode: 'yolo' }),
    });
    expect(modeRes.status).toBe(200);

    // 5. Drive a real prompt over REST. The fake model returns a
    // `chrome_read_page` tool_call on this turn (see beforeAll), so the agent
    // must invoke the client-hosted tool through the reverse WS channel.
    const promptRes = await fetch(`${base}/session/${sessionId}/prompt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        prompt: [
          {
            type: 'text',
            text: `${READ_PAGE_PROMPT_SENTINEL}: read the current browser page and summarize it.`,
          },
        ],
      }),
    });
    expect(promptRes.status).toBe(202);
    const { promptId, lastEventId } = (await promptRes.json()) as {
      promptId: string;
      lastEventId: number;
    };
    expect(typeof promptId).toBe('string');

    // 6. Subscribe to the session SSE stream from the cursor BEFORE this turn so
    // no tool_call / tool_call_update / turn_complete frame is missed. Collect
    // until `turn_complete` for THIS promptId (or timeout).
    const sseAbort = new AbortController();
    const events: Array<{ type: string; data: unknown }> = [];
    const sseDone = (async () => {
      const res = await fetch(`${base}/session/${sessionId}/events`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'text/event-stream',
          'Last-Event-ID': String(lastEventId),
        },
        signal: sseAbort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE open failed: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Parse complete SSE frames (separated by a blank line).
          let sep: number;
          while ((sep = buf.indexOf('\n\n')) !== -1) {
            const rawFrame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            let evType = 'message';
            const dataLines: string[] = [];
            for (const line of rawFrame.split('\n')) {
              if (line.startsWith('event:')) evType = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            }
            if (dataLines.length === 0) continue; // heartbeat / comment
            let parsed: unknown;
            try {
              parsed = JSON.parse(dataLines.join('\n'));
            } catch {
              continue;
            }
            const env = parsed as { type?: string; data?: unknown };
            events.push({ type: env.type ?? evType, data: env.data });
            const isTurnComplete =
              (env.type ?? evType) === 'turn_complete' &&
              (env.data as { promptId?: string })?.promptId === promptId;
            if (isTurnComplete) return;
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    })();

    // 7. Wait for the turn to complete (consuming the tool result) or time out.
    let timedOut = false;
    await Promise.race([
      sseDone,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, 40_000),
      ),
    ]);
    sseAbort.abort();
    await sseDone.catch(() => {});
    if (timedOut) {
      // A timeout (vs. a clean turn_complete) usually means the model call never
      // reached the fake server — most often a localhost-bypassing HTTP proxy in
      // the dev env. Surface the request count + event trace for triage.
      throw new Error(
        `timeout waiting for turn_complete; fakeReqs=${fakeServer.requests.length} ` +
          `readPageCalls=${readPageCalls.length} ` +
          `events=${JSON.stringify(
            events.map((e) => ({
              t: e.type,
              u: (e.data as { update?: { sessionUpdate?: string; status?: string } })
                ?.update?.sessionUpdate,
              s: (e.data as { update?: { status?: string } })?.update?.status,
            })),
          )}`,
      );
    }

    // Collect the tool-call lifecycle the agent surfaced for THIS turn.
    const toolCallUpdates = events.filter(
      (e) =>
        e.type === 'session_update' &&
        ((e.data as { update?: { sessionUpdate?: string } })?.update
          ?.sessionUpdate === 'tool_call' ||
          (e.data as { update?: { sessionUpdate?: string } })?.update
            ?.sessionUpdate === 'tool_call_update'),
    );
    const readPageUpdate = toolCallUpdates.find((e) => {
      const u = (e.data as { update?: Record<string, unknown> })?.update ?? {};
      const meta = u['_meta'] as { toolName?: string } | undefined;
      const contentText = JSON.stringify(u['content'] ?? '');
      return (
        meta?.toolName === 'chrome_read_page' ||
        contentText.includes('chrome_read_page') ||
        String(u['title'] ?? '').includes('chrome_read_page')
      );
    });

    // ── The model→agent dispatch fired ──────────────────────────────────────
    // The model emitted a `chrome_read_page` tool call (the fake server saw the
    // prompt) and the agent surfaced a tool_call(_update) for it — i.e. the
    // prompt is wired through to the agent's tool dispatcher for the
    // client-hosted tool name.
    expect(fakeServer.requests.length).toBeGreaterThanOrEqual(1);
    expect(
      readPageUpdate,
      `expected a tool_call(_update) naming chrome_read_page; ` +
        `events=${JSON.stringify(events.map((e) => e.type))}`,
    ).toBeDefined();

    // ── SUCCESS PATH (session-scoped runtime MCP — #5626) ───────────────────
    // (a) The stand-in extension RECEIVED the reverse `tools/call`: the agent
    // resolved `chrome_read_page` in the SESSION registry, bound the session's
    // `sendSdkMcpMessage`, and the frame crossed the WS to this client.
    expect(
      readPageCalls.length,
      `expected the reverse tools/call to reach the ws client; ` +
        `updates=${JSON.stringify(
          toolCallUpdates.map(
            (e) => (e.data as { update?: { status?: string } })?.update?.status,
          ),
        )}`,
    ).toBeGreaterThanOrEqual(1);
    // The model emitted args `{}`, forwarded verbatim over the reverse channel.
    expect(typeof readPageCalls[0]).toBe('object');

    // (b) The agent CONSUMED the result — the tool call reached `completed`.
    const completed = toolCallUpdates.some(
      (e) =>
        (e.data as { update?: { status?: string } })?.update?.status ===
        'completed',
    );
    expect(
      completed,
      `expected a completed tool_call_update for chrome_read_page; ` +
        `statuses=${JSON.stringify(
          toolCallUpdates.map(
            (e) => (e.data as { update?: { status?: string } })?.update?.status,
          ),
        )}`,
    ).toBe(true);

    // (c) The turn ended cleanly (the agent fed the tool result back to the
    // model, which returned its final assistant message).
    const turnComplete = events.find(
      (e) =>
        e.type === 'turn_complete' &&
        (e.data as { promptId?: string })?.promptId === promptId,
    );
    expect(turnComplete, 'expected a turn_complete for this prompt').toBeDefined();

    ws.close();
  }, 90_000);
});
