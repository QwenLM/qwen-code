/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { HostedHarnessProcess, waitUntil } from './hosted-harness-process.js';
import { SseObserver, projectEvents } from './hosted-sse-observer.js';

const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, 'utf8')) as {
  tenantId: string;
  storeUrl: string;
  brokerUrl: string;
  statusGateUrl: string;
  sessions: Array<{
    sessionId: string;
    workspaceId: string;
    directory: string;
  }>;
};
const session = config.sessions[0];
const sessionId = session.sessionId;
const promptId = randomUUID();
const proof = path.join(session.directory, 'proof.txt');
const cli = new HostedHarnessProcess();
const operations: string[] = [];
let clientId = '';
let modelCalls = 0;
let proxyFailure: unknown;
const headers = {
  'X-Qwen-Tenant-Id': config.tenantId,
  'Content-Type': 'application/json',
};

async function privateJson(route: string, body?: unknown, expected = 200) {
  const response = await cli.request(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...cli.headers(clientId), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expected, text + cli.output);
  return text ? JSON.parse(text) : undefined;
}

async function api(route: string, body?: unknown) {
  const response = await fetch(new URL(route, config.storeUrl), {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function evidence(phase: string, body = {}) {
  if (proxyFailure) throw proxyFailure;
  const response = await fetch(
    new URL(`/sse-gap/${phase}`, config.statusGateUrl),
    {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

const proxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, config.brokerUrl);
    const operation =
      req.method === 'GET' ? 'status' : url.pathname.split(':').at(-1)!;
    operations.push(operation);
    if (operation === 'start') await writeFile(`${proof}.read-gate`, '');
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: 'Bearer hosted-tools-broker-token',
        'Content-Type': 'application/json',
      },
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await upstream.text();
    assert.equal(upstream.status, 200, text);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(text);
  } catch (cause) {
    proxyFailure = cause;
    res.destroy();
  }
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address();
assert(address && typeof address !== 'string');
const model = await startFakeOpenAIServer(() => {
  modelCalls++;
  assert(modelCalls <= 2, 'SSE reconnect must not restart inference');
  return modelCalls === 1
    ? {
        toolCalls: [
          fakeToolCall(
            'edit',
            {
              file_path: 'proof.txt',
              old_string: 'x',
              new_string: 'xx',
              replace_all: true,
            },
            'effect',
          ),
        ],
      }
    : { content: 'FG6e tool finished once.' };
});
const observerOpts = {
  sessionId,
  storeUrl: config.storeUrl,
  tenantId: config.tenantId,
  timeoutMs: 45_000,
};
const observers = [
  new SseObserver({ ...observerOpts, surface: 'public' }),
  new SseObserver({ ...observerOpts, surface: 'web' }),
  new SseObserver({ ...observerOpts, surface: 'public' }),
  new SseObserver({ ...observerOpts, surface: 'web' }),
];
const [publicBefore, webBefore, publicAfter, webAfter] = observers;

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
  const created = await privateJson('/session', {
    sessionId,
    sessionScope: 'thread',
    toolProfile: 'hosted-workspace-files/1',
    managedSessionStore: {
      baseUrl: config.storeUrl,
      tenantId: config.tenantId,
      workspaceId: session.workspaceId,
      writerId: cli.bootId,
      leaseDurationMs: 60_000,
    },
  });
  clientId = created.clientId;
  await evidence('start', {
    created,
    baseUrl: cli.baseUrl,
    bootId: cli.bootId,
    promptId,
  });
  await Promise.all([publicBefore.start(), webBefore.start()]);
  await Promise.all([publicBefore.through(1), webBefore.through(1)]);
  const prompt = [{ type: 'text', text: 'Perform the edit once.' }];
  await privateJson(
    `/session/${sessionId}/prompt`,
    {
      promptId,
      prompt,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    },
    202,
  );
  await waitUntil(() => {
    if (proxyFailure) throw proxyFailure;
    return existsSync(`${proof}.read-entered`);
  });
  assert((await lstat(proof)).isFile());
  assert.equal(await readFile(proof, 'utf8'), 'x');
  assert.equal(
    (await privateJson(`/session/${sessionId}/status`)).hasActivePrompt,
    true,
  );
  await evidence('entered');
  // The committed tool intent publishes the in-progress tool update before
  // the tool body runs.
  await Promise.all([publicBefore.through(2), webBefore.through(2)]);
  await Promise.all([publicBefore.close(), webBefore.close()]);
  assert.deepEqual(
    publicBefore.frames.map((frame) => frame.id),
    [1, 2],
  );
  assert.deepEqual(
    webBefore.frames.map((frame) => frame.id),
    [1, 2],
  );
  await unlink(`${proof}.read-gate`);
  await waitUntil(
    async () =>
      !(await privateJson(`/session/${sessionId}/status`)).hasActivePrompt,
  );
  await waitUntil(async () => (await evidence('held')).held);
  await evidence('finished');
  assert.equal(await readFile(proof, 'utf8'), 'xx');
  assert.equal(modelCalls, 2);
  await Promise.all([
    publicAfter.start(publicBefore.frames.at(-1)!.id),
    webAfter.start(webBefore.frames.at(-1)!.id),
  ]);
  await Promise.all([publicAfter.through(4), webAfter.through(4)]);
  assert.deepEqual(
    publicAfter.frames.map((frame) => frame.id),
    [3, 4],
    'Public cursor replay',
  );
  assert.deepEqual(
    webAfter.frames.map((frame) => frame.id),
    [3, 4],
    'WebShell cursor replay',
  );
  await evidence('release');
  await Promise.all([publicAfter.through(5), webAfter.through(5)]);
  await Promise.all([publicAfter.close(), webAfter.close()]);
  const ledger: Array<Record<string, unknown>> = await evidence('ledger');
  const publicFrames = [...publicBefore.frames, ...publicAfter.frames];
  const webFrames = [...webBefore.frames, ...webAfter.frames];
  const toolProgress = publicFrames
    .filter((frame) => frame.event === 'item.tool_call.updated')
    .map((frame) => frame.data['data'] as Record<string, unknown>);
  assert.deepEqual(
    toolProgress.map((update) => [
      update['toolCallId'],
      update['name'],
      update['status'],
    ]),
    [
      ['effect', 'edit', 'in_progress'],
      ['effect', 'edit', 'completed'],
    ],
  );
  assert.equal(toolProgress[0]['itemId'], toolProgress[1]['itemId']);
  for (const [surface, frames] of [
    ['public', publicFrames],
    ['web', webFrames],
  ] as const) {
    const expected = projectEvents(ledger, surface);
    assert.deepEqual(
      frames.map((frame) => frame.id),
      [1, 2, 3, 4, 5],
      `${surface} no gaps or duplicates`,
    );
    assert.deepEqual(
      frames.map((frame) => frame.data),
      expected,
      `${surface} exact SQL projection`,
    );
  }
  const events = await api(
    `/v1/agents/sessions/${sessionId}/events?after=0&limit=100`,
  );
  assert.deepEqual(
    events.data,
    publicFrames.map((frame) => frame.data),
  );
  let transcript = await api('/api/agent/web-shell/v1/transcript/query', {
    sessionId,
    limit: 100,
  });
  await waitUntil(async () => {
    transcript = await api('/api/agent/web-shell/v1/transcript/query', {
      sessionId,
      limit: 100,
    });
    return transcript.coveredSequence === 5;
  });
  assert.equal(transcript.lastSequence, 5);
  assert.equal(transcript.hasMore, false);
  assert.equal(transcript.coveredSequence, 5);
  const toolItems = transcript.items.filter(
    (item: { type: string }) => item.type === 'tool_call',
  );
  assert.equal(toolItems.length, 1);
  assert.equal(toolItems[0].itemId, toolProgress[0]['itemId']);
  assert.equal(toolItems[0].status, 'completed');
  assert.equal(toolItems[0].attributes.toolCallId, 'effect');
  assert.equal(
    transcript.items
      .flatMap((item: { content?: Array<{ text?: string }> }) =>
        (item.content ?? []).map((part) => part.text ?? ''),
      )
      .join(''),
    'FG6e tool finished once.',
  );
  // Progress frames materialize as transcript items, not transcript events.
  const itemFrames = new Set([
    'item.output_text.delta',
    'item.tool_call.updated',
  ]);
  assert.deepEqual(
    transcript.events,
    webFrames
      .filter((frame) => !itemFrames.has(frame.event))
      .map((frame) => frame.data),
  );
  assert.equal(
    await readFile(path.join(cli.root, 'proof.txt'), 'utf8'),
    'decoy',
  );
  assert.equal(modelCalls, 2);
  for (const operation of ['acquire', 'prepare', 'start', 'release'])
    assert.equal(
      operations.filter((value) => value === operation).length,
      1,
      operation,
    );
  assert.equal(operations.filter((value) => value === 'cancel').length, 0);
  const report = {
    promptId,
    modelCalls,
    operations,
    publicIds: publicFrames.map((frame) => frame.id),
    webIds: webFrames.map((frame) => frame.id),
  };
  await writeFile(`${configPath}.results`, JSON.stringify([report]));
  console.log('HOSTED_SSE_GAP_OK', JSON.stringify(report));
} catch (cause) {
  console.error(cli.output, operations);
  throw cause;
} finally {
  await Promise.allSettled(observers.map((observer) => observer.close()));
  await cli.close();
  await model.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
