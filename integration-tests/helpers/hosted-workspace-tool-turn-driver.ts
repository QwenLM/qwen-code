/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { HostedHarnessProcess, waitUntil } from './hosted-harness-process.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  tenantId: string;
  storeUrl: string;
  brokerUrl: string;
  sessions: Array<{
    sessionId: string;
    workspaceId: string;
    directory: string;
  }>;
};
const starts = new Map<string, number>();
let releaseWarm!: () => void;
const warmGate = new Promise<void>((resolve) => {
  releaseWarm = resolve;
});
let warmPending = false;
let loseStatus = false;
let droppedStart = false;
const proxy = createServer(async (req, res) => {
  try {
    if (req.url?.endsWith('/runtimes:warm')) {
      warmPending = true;
      await warmGate;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const isStart = req.url?.endsWith(':start');
    if (isStart) starts.set(req.url!, (starts.get(req.url!) ?? 0) + 1);
    const response = await fetch(new URL(req.url!, config.brokerUrl), {
      method: req.method,
      headers: {
        Authorization: 'Bearer hosted-tools-broker-token',
        'Content-Type': 'application/json',
      },
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok)
      console.error(`Broker ${req.url}: ${response.status} ${text}`);
    if (isStart && !droppedStart) {
      droppedStart = true;
      res.destroy();
      return;
    }
    if (loseStatus && (isStart || req.method === 'GET')) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'runtime_broker_execution_unknown' }));
    } else {
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(text);
    }
  } catch (cause) {
    res.writeHead(503);
    res.end(String(cause));
  }
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address();
assert(address && typeof address !== 'string');
let current = 'TEXT_ONLY';
let modelCalls = 0;
const model = await startFakeOpenAIServer(({ body }) => {
  modelCalls++;
  const tools = body['tools'] as Array<{ function: { name: string } }>;
  assert.deepEqual(tools.map((tool) => tool.function.name).sort(), [
    'edit',
    'read_file',
    'write_file',
  ]);
  const messages = body['messages'] as Array<{
    role: string;
    content: unknown;
    tool_call_id?: string;
    tool_calls?: Array<{ id: string }>;
  }>;
  const lastPrompt = messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      JSON.stringify(message.content).includes(current),
  );
  assert(lastPrompt >= 0);
  const receipts = messages
    .slice(lastPrompt + 1)
    .filter((message) => message.role === 'tool');
  if (current.startsWith('RUN_TOOLS')) {
    if (!receipts.length)
      return {
        content: 'Preparing the Workspace file.',
        toolCalls: [
          fakeToolCall(
            'write_file',
            { file_path: 'proof.txt', content: 'before' },
            'write-proof',
          ),
        ],
      };
    if (receipts.length === 1)
      return {
        toolCalls: [
          fakeToolCall('read_file', { file_path: 'proof.txt' }, 'read-proof'),
          fakeToolCall(
            'edit',
            {
              file_path: 'proof.txt',
              old_string: 'before',
              new_string: 'after',
            },
            'edit-proof',
          ),
        ],
      };
    assert.deepEqual(
      receipts.map((message) => message.tool_call_id),
      ['write-proof', 'read-proof', 'edit-proof'],
    );
    assert.match(JSON.stringify(receipts[0].content), /Successfully created/);
    assert.match(JSON.stringify(receipts[1].content), /before/);
    assert.match(
      JSON.stringify(receipts[2].content),
      /has been updated.*after/s,
    );
    return { content: 'TOOLS_DONE', reasoning: 'PRIVATE_REASONING_MARKER' };
  }
  if (current === 'SHELL_REFUSAL')
    return {
      toolCalls: [
        fakeToolCall('run_shell_command', { command: 'touch refused-shell' }),
      ],
    };
  if (current === 'UNKNOWN_WRITE')
    return {
      toolCalls: [
        fakeToolCall('write_file', {
          file_path: 'unknown.txt',
          content: 'one effect',
        }),
      ],
    };
  if (current === 'HISTORY_CHECK') {
    const previousCalls = messages
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.id);
    const previousReceipts = messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id);
    assert.deepEqual(previousReceipts, previousCalls);
    assert.equal(previousReceipts.length, 3);
  }
  return { content: 'TEXT_DONE' };
});
const cli = new HostedHarnessProcess();
let sessionId = '';
let clientId = '';
async function json(
  route: string,
  body?: unknown,
  expected = 200,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await cli.request(route, {
    method,
    headers: { ...cli.headers(clientId), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expected, text);
  return text ? JSON.parse(text) : undefined;
}
async function prompt(text: string, expectedState = 'end_turn') {
  current = text;
  const blocks = [{ type: 'text', text }];
  const promptId = randomUUID();
  await json(
    `/session/${sessionId}/prompt`,
    {
      promptId,
      prompt: blocks,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(blocks)).digest('hex')}`,
    },
    202,
  );
  await waitUntil(
    async () => !(await json(`/session/${sessionId}/status`)).hasActivePrompt,
  );
  const status = await json(`/session/${sessionId}/status`);
  assert.equal(status.recoveryBlocked, expectedState === 'blocked', cli.output);
  const events: Array<{
    type: string;
    promptId?: string;
    data: {
      stopReason?: string;
      record?: {
        message?: {
          parts?: Array<{
            functionCall?: { id?: string };
            functionResponse?: { id?: string };
          }>;
        };
      };
    };
  }> = [];
  let cursor = '0';
  while (true) {
    const page = await json(
      `/session/${sessionId}/transcript?cursor=${cursor}&limit=256`,
    );
    events.push(...page.events);
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  const terminal = events.filter(
    (event) => event.promptId === promptId && event.type.startsWith('turn_'),
  );
  if (expectedState === 'blocked') assert.equal(terminal.length, 0);
  else {
    assert.equal(terminal.length, 1, JSON.stringify(events) + cli.output);
    assert.equal(
      terminal[0].type,
      expectedState === 'error' ? 'turn_error' : 'turn_complete',
      cli.output,
    );
    if (expectedState !== 'error')
      assert.equal(terminal[0].data.stopReason, expectedState);
  }
  return events;
}
try {
  await cli.start(model.baseUrl, {
    extraArgs: [
      '--managed-runtime-broker-url',
      `http://127.0.0.1:${address.port}`,
      '--managed-runtime-broker-token',
      'hosted-tools-broker-token',
    ],
  });
  await writeFile(path.join(cli.root, 'proof.txt'), 'decoy');
  for (const [index, session] of config.sessions.entries()) {
    sessionId = session.sessionId;
    const connection = {
      baseUrl: config.storeUrl,
      tenantId: config.tenantId,
      workspaceId: session.workspaceId,
      writerId: cli.bootId,
      leaseDurationMs: 60_000,
    };
    const created = await json('/session', {
      sessionId,
      sessionScope: 'thread',
      managedSessionStore: connection,
      toolProfile: 'hosted-workspace-files/1',
    });
    clientId = created.clientId;
    if (index === 0) {
      await prompt('TEXT_ONLY');
      assert(warmPending, 'Warmup was not started alongside inference');
      assert.equal(starts.size, 0);
      releaseWarm();
    }
    const toolEvents = await prompt(`RUN_TOOLS_${index}`);
    const replayParts = toolEvents.flatMap(
      (event) => event.data.record?.message?.parts ?? [],
    );
    const replayCalls = replayParts.flatMap((part) =>
      part.functionCall ? [part.functionCall.id] : [],
    );
    assert.deepEqual(replayCalls, ['write-proof', 'read-proof', 'edit-proof']);
    assert.deepEqual(
      replayParts.flatMap((part) =>
        part.functionResponse ? [part.functionResponse.id] : [],
      ),
      replayCalls,
    );
    assert(
      !JSON.stringify(
        toolEvents.filter((event) => event.type === 'session_update'),
      ).includes('PRIVATE_REASONING_MARKER'),
    );
    assert.equal(
      await readFile(path.join(session.directory, 'proof.txt'), 'utf8'),
      'after',
    );
    assert.equal(
      await readFile(path.join(cli.root, 'proof.txt'), 'utf8'),
      'decoy',
    );
    await prompt('SHELL_REFUSAL', 'error');
    await json(`/session/${sessionId}/detach`, {}, 204);
    await json(
      `/session/${sessionId}/load`,
      { managedSessionStore: connection },
      409,
    );
    const loaded = await json(`/session/${sessionId}/load`, {
      managedSessionStore: connection,
      toolProfile: 'hosted-workspace-files/1',
    });
    clientId = loaded.clientId;
    await prompt('HISTORY_CHECK');
    if (index === 1) {
      loseStatus = true;
      const before = modelCalls;
      await prompt('UNKNOWN_WRITE', 'blocked');
      assert.equal(modelCalls, before + 1);
      const blocks = [{ type: 'text', text: 'must stay blocked' }];
      await json(
        `/session/${sessionId}/prompt`,
        {
          promptId: randomUUID(),
          prompt: blocks,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(blocks)).digest('hex')}`,
        },
        409,
      );
      await json(`/session/${sessionId}/detach`, {}, 204);
      await json(
        `/session/${sessionId}/load`,
        {
          managedSessionStore: connection,
          toolProfile: 'hosted-workspace-files/1',
        },
        409,
      );
    } else await json(`/session/${sessionId}/detach`, {}, 204);
  }
  assert(droppedStart);
  assert.equal(starts.size, 7);
  assert([...starts.values()].every((count) => count === 1));
  console.log(
    'HOSTED_WORKSPACE_TOOLS_OK: two Workspaces, parallel warmup, two tool rounds, lost start ACK, replay, Shell refusal, unknown blocking',
  );
} catch (cause) {
  console.error(cli.output);
  throw cause;
} finally {
  releaseWarm();
  await cli.close();
  await model.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
