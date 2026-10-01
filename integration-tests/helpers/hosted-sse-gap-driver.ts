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

type Frame = { id: number; event: string; data: Record<string, unknown> };
class Observer {
  frames: Frame[] = [];
  controller = new AbortController();
  task?: Promise<void>;
  failure?: unknown;

  async start(surface: 'public' | 'web', after?: number) {
    const response = await fetch(
      new URL(
        surface === 'public'
          ? `/v1/agents/sessions/${sessionId}/events?stream=true&after=0`
          : '/api/agent/web-shell/v1/events/stream',
        config.storeUrl,
      ),
      {
        method: surface === 'public' ? 'GET' : 'POST',
        headers: {
          ...headers,
          Accept: 'text/event-stream',
          ...(surface === 'public' && after !== undefined
            ? { 'Last-Event-ID': String(after) }
            : {}),
        },
        ...(surface === 'web'
          ? { body: JSON.stringify({ sessionId, afterSequence: after ?? 0 }) }
          : {}),
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(45_000),
        ]),
      },
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-type') ?? '',
      /text\/event-stream/,
    );
    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader();
    this.task = (async () => {
      let pending = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += value;
          let end: number;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const block = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const lines = block.split('\n');
            const data = lines
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            const id = lines
              .find((line) => line.startsWith('id:'))
              ?.slice(3)
              .trim();
            assert.match(id ?? '', /^\d+$/);
            const frame = {
              id: Number(id),
              event:
                lines
                  .find((line) => line.startsWith('event:'))
                  ?.slice(6)
                  .trim() ?? '',
              data: JSON.parse(data) as Record<string, unknown>,
            };
            assert.equal(
              frame.id,
              frame.data['sequence'],
              'SSE id must equal payload sequence',
            );
            assert.equal(frame.event, frame.data['type']);
            this.frames.push(frame);
          }
        }
      } catch (cause) {
        if (!this.controller.signal.aborted) this.failure = cause;
      } finally {
        reader.releaseLock();
      }
    })();
  }

  async through(sequence: number) {
    await waitUntil(() => {
      if (this.failure) throw this.failure;
      return this.frames.some((frame) => frame.id >= sequence);
    }, 10_000);
  }

  async close() {
    this.controller.abort();
    await this.task;
    if (this.failure) throw this.failure;
  }
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
const observers = [
  new Observer(),
  new Observer(),
  new Observer(),
  new Observer(),
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
  await Promise.all([publicBefore.start('public'), webBefore.start('web')]);
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
  await Promise.all([publicBefore.close(), webBefore.close()]);
  assert.deepEqual(
    publicBefore.frames.map((frame) => frame.id),
    [1],
  );
  assert.deepEqual(
    webBefore.frames.map((frame) => frame.id),
    [1],
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
    publicAfter.start('public', publicBefore.frames.at(-1)!.id),
    webAfter.start('web', webBefore.frames.at(-1)!.id),
  ]);
  await Promise.all([publicAfter.through(2), webAfter.through(2)]);
  assert.deepEqual(
    publicAfter.frames.map((frame) => frame.id),
    [2],
    'Public cursor replay',
  );
  assert.deepEqual(
    webAfter.frames.map((frame) => frame.id),
    [2],
    'WebShell cursor replay',
  );
  await evidence('release');
  await Promise.all([publicAfter.through(3), webAfter.through(3)]);
  await Promise.all([publicAfter.close(), webAfter.close()]);
  const ledger: Array<Record<string, unknown>> = await evidence('ledger');
  const publicFrames = [...publicBefore.frames, ...publicAfter.frames];
  const webFrames = [...webBefore.frames, ...webAfter.frames];
  for (const [surface, frames] of [
    ['public', publicFrames],
    ['web', webFrames],
  ] as const) {
    const expected = ledger.map((row) => {
      const fields: Record<string, unknown> = {
        schema_version: row['schema_version'],
        projection_version: row['projection_version'],
        sequence: row['sequence_id'],
        event_id: row['event_id'],
        session_id: row['session_id'],
        turn_id: row['turn_id'],
        item_id: row['item_id'],
        content_part_id: row['content_part_id'],
        type: row['event_type'],
        created_at:
          surface === 'public'
            ? Math.floor(Number(row['created_at']) / 1000)
            : row['created_at'],
        data: JSON.parse(String(row['data_json'])),
        terminal: Boolean(row['terminal']),
      };
      return Object.fromEntries(
        Object.entries(fields)
          .filter(([, value]) => value !== null)
          .map(([key, value]) => [
            surface === 'web'
              ? key.replace(/_([a-z])/g, (_, letter: string) =>
                  letter.toUpperCase(),
                )
              : key,
            value,
          ]),
      );
    });
    assert.deepEqual(
      frames.map((frame) => frame.id),
      [1, 2, 3],
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
    return transcript.coveredSequence === 3;
  });
  assert.equal(transcript.lastSequence, 3);
  assert.equal(transcript.hasMore, false);
  assert.equal(transcript.coveredSequence, 3);
  assert.equal(
    transcript.items
      .flatMap((item: { content: Array<{ text: string }> }) =>
        item.content.map((part) => part.text),
      )
      .join(''),
    'FG6e tool finished once.',
  );
  assert.deepEqual(
    transcript.events,
    webFrames
      .filter((frame) => frame.event !== 'item.output_text.delta')
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
