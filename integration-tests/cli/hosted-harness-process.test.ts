/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIHandler,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import {
  HostedHarnessProcess,
  HOSTED_TOKEN,
  waitUntil,
} from '../helpers/hosted-harness-process.js';
import { startHostedSessionStore } from '../helpers/hosted-session-store.js';

interface Event {
  v: number;
  id: number;
  type: string;
  promptId?: string;
  data: {
    stopReason?: string;
    code?: string;
    update?: { content: { text: string } };
  };
}
interface Receipt {
  promptId: string;
  lastEventId: number;
  eventEpoch: string;
}
let cli: HostedHarnessProcess;
let model: FakeOpenAIServer | undefined;
let store: Awaited<ReturnType<typeof startHostedSessionStore>> | undefined;
let sessionId: string;
let clientId: string;
let releaseModel: (() => void) | undefined;

afterEach(async ({ task }) => {
  releaseModel?.();
  releaseModel = undefined;
  const urls = [cli?.baseUrl, store?.baseUrl, model?.baseUrl].filter(
    (url): url is string => !!url,
  );
  if (task.result?.state === 'fail')
    console.error({
      pid: cli?.child?.pid,
      exitCode: cli?.child?.exitCode,
      signal: cli?.child?.signalCode,
      modelRequests: model?.requests.length,
      output: cli?.output,
      storeFailures: store?.failures,
    });
  try {
    await cli?.close();
  } finally {
    try {
      await store?.close();
    } finally {
      await model?.close();
      store = undefined;
      model = undefined;
    }
  }
  if (cli?.child)
    expect(cli.child.exitCode !== null || cli.child.signalCode !== null).toBe(
      true,
    );
  if (cli?.root) expect(existsSync(cli.root)).toBe(false);
  for (const url of urls) await assertPortReleased(url);
});

async function start(
  handler: FakeOpenAIHandler = () => ({ content: 'HOSTED_REPLY' }),
) {
  cli = new HostedHarnessProcess();
  clientId = '';
  model = await startFakeOpenAIServer(handler);
  await cli.start(model.baseUrl);
  sessionId = randomUUID();
  store = await startHostedSessionStore(sessionId);
}

function connection() {
  return {
    baseUrl: store!.baseUrl,
    tenantId: 'tenant',
    workspaceId: 'workspace',
    writerId: cli.bootId,
    leaseDurationMs: 60_000,
  };
}

async function json<T>(
  route: string,
  body?: unknown,
  expected = 200,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await cli.request(route, {
    method,
    headers: { ...cli.headers(clientId), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(expected);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function open(load = false) {
  const created = await json<{ sessionId: string; clientId: string }>(
    load ? `/session/${sessionId}/load` : '/session',
    {
      sessionId,
      sessionScope: 'thread',
      managedSessionStore: connection(),
    },
  );
  expect(created.sessionId).toBe(sessionId);
  clientId = created.clientId;
}

function payload(text: string) {
  const prompt = [{ type: 'text', text }];
  return {
    prompt,
    promptId: randomUUID(),
    payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
  };
}

async function submit(body: ReturnType<typeof payload>) {
  const receipt = await json<Receipt>(
    `/session/${sessionId}/prompt`,
    body,
    202,
  );
  expect(receipt.promptId).toBe(body.promptId);
  return receipt;
}

async function settled() {
  await waitUntil(
    async () =>
      !(
        await json<{ hasActivePrompt: boolean }>(`/session/${sessionId}/status`)
      ).hasActivePrompt,
  );
  expect(store!.failures).toEqual([]);
  return (await json<{ events: Event[] }>(`/session/${sessionId}/transcript`))
    .events;
}

function expectNoTools(request: Record<string, unknown>) {
  expect(
    request.tools === undefined ||
      request.tools === null ||
      (Array.isArray(request.tools) && request.tools.length === 0),
    'Hosted model request must not advertise tools',
  ).toBe(true);
}

function assertCompleted(events: Event[], promptId: string, text: string) {
  const visible = events.filter((event) => event.promptId === promptId);
  expect(visible.map((event) => event.type)).toEqual([
    'session_update',
    'turn_complete',
  ]);
  expect(visible[0].data.update?.content.text).toBe(text);
  expect(visible[1].data.stopReason).toBe('end_turn');
}

async function replay(after: number, epoch: string, last: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await cli.request(`/session/${sessionId}/events`, {
      headers: {
        ...cli.headers(clientId),
        'Last-Event-ID': String(after),
        'X-Qwen-Event-Epoch': epoch,
      },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-qwen-event-epoch')).toBe(epoch);
    reader = response.body!.getReader();
    const events: Event[] = [];
    const decoder = new TextDecoder();
    let buffer = '';
    while (events.at(-1)?.id !== last) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = JSON.parse(
          frame
            .split('\n')
            .find((line) => line.startsWith('data: '))!
            .slice(6),
        ) as Event;
        expect(frame).toContain(`id: ${event.id}\n`);
        expect(frame).toContain(`event: ${event.type}\n`);
        events.push(event);
      }
    }
    return events;
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    clearTimeout(timer);
  }
}

async function assertPortReleased(url: string) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(new URL(url).port), '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// This branch's Hosted Harness requires a Runtime Broker and serves Managed
// tools; these gates cover main's no-Broker, no-tool session module, which the
// branch does not wire. The branch's hosted flows run in
// scripts/run-managed-hosted-runtime-e2e.ts (SDK Java daemon E2E job).
describe.skip(
  'Hosted packaged no-tool process',
  { timeout: 90_000, retry: 0 },
  () => {
    it('initializes a fresh canonical Session and replays committed text without duplicate inference', async () => {
      await start();
      await open();
      const body = payload('FRESH_PROMPT');
      const receipt = await submit(body);
      const events = await settled();
      expect(model!.requests.length).toBe(1);
      expectNoTools(model!.requests[0].body);
      expect(
        JSON.stringify(model!.requests[0].body.messages).includes(
          'FRESH_PROMPT',
        ),
        'fresh prompt reaches the model',
      ).toBe(true);
      const visible = events.filter(
        (event) => event.promptId === body.promptId,
      );
      expect(visible.map((event) => event.type)).toEqual([
        'session_update',
        'turn_complete',
      ]);
      expect(visible[0].data.update?.content.text).toBe('HOSTED_REPLY');
      expect(visible[1].data.stopReason).toBe('end_turn');
      const committed = (await store!.scan()).events;
      expect(events.map((event) => event.id)).toEqual(
        committed.map((event) => event.sequence),
      );
      const message = committed.find(
        (event) => event.sequence === visible[0].id,
      )!;
      expect(message).toMatchObject({
        kind: 'message.committed',
        payload: { role: 'assistant' },
      });
      expect(
        JSON.parse(
          (
            await store!.readResource(
              message.payload.contentRef as unknown as ManagedSessionDurableRef,
            )
          ).toString(),
        ),
      ).toMatchObject({
        sessionId,
        daemonPromptId: body.promptId,
        message: { role: 'model', parts: [{ text: 'HOSTED_REPLY' }] },
      });
      expect(
        committed.find((event) => event.sequence === visible[1].id),
      ).toMatchObject({
        kind: 'turn.settled',
        payload: {
          turnId: body.promptId,
          outcome: 'completed',
          stopReason: 'end_turn',
        },
      });
      expect(await submit(body)).toEqual(receipt);
      expect(
        await replay(
          receipt.lastEventId,
          receipt.eventEpoch,
          events.at(-1)!.id,
        ),
      ).toEqual(events.filter((event) => event.id > receipt.lastEventId));
      expect(
        await replay(visible[0].id, receipt.eventEpoch, events.at(-1)!.id),
      ).toEqual(events.filter((event) => event.id > visible[0].id));
      expect(model!.requests.length).toBe(1);
      await json(`/session/${sessionId}/detach`, {}, 204);
      expect(store!.seals).toBe(1);
      await open(true);
      await json(`/session/${sessionId}`, undefined, 204, 'DELETE');
      expect(store!.seals).toBe(2);
      await open(true);
      const loadedPrompt = payload('AFTER_LOAD');
      await submit(loadedPrompt);
      assertCompleted(await settled(), loadedPrompt.promptId, 'HOSTED_REPLY');
      expect(model!.requests.length).toBe(2);
      expect(
        JSON.stringify(model!.requests[1].body.messages).includes(
          'HOSTED_REPLY',
        ),
        'completed history survives load',
      ).toBe(true);
    });

    it.each(['failed', 'cancelled'] as const)(
      'omits %s A through successful B and C while retaining completed history',
      async (outcome) => {
        const held = new Promise<void>((resolve) => {
          releaseModel = resolve;
        });
        await start(({ requestIndex }) =>
          requestIndex === 0
            ? outcome === 'failed'
              ? { errorContent: 'DETERMINISTIC_FAILURE' }
              : {
                  contentChunks: ['PARTIAL'],
                  holdAfterChunks: 1,
                  holdUntil: held,
                }
            : { content: `REPLY_${requestIndex}` },
        );
        await open();
        const a = payload('UNANSWERED_A');
        await submit(a);
        await waitUntil(() => model!.requests.length === 1);
        if (outcome === 'cancelled')
          await json(`/session/${sessionId}/cancel`, {}, 204);
        const events = await settled();
        const terminal = events.find(
          (event) =>
            event.promptId === a.promptId && event.type.startsWith('turn_'),
        );
        expect(terminal).toMatchObject(
          outcome === 'failed'
            ? { type: 'turn_error', data: { code: 'hosted_turn_failed' } }
            : { type: 'turn_complete', data: { stopReason: 'cancelled' } },
        );
        releaseModel!();
        for (const text of ['SUCCESS_B', 'NEXT_C']) {
          const body = payload(text);
          await submit(body);
          assertCompleted(
            await settled(),
            body.promptId,
            text === 'SUCCESS_B' ? 'REPLY_1' : 'REPLY_2',
          );
          const request = model!.requests.at(-1)!.body;
          expectNoTools(request);
          expect(
            JSON.stringify(request.messages).includes('UNANSWERED_A'),
            'unanswered A must not reappear',
          ).toBe(false);
          expect(
            JSON.stringify(request.messages).includes(text),
            'current prompt reaches the model',
          ).toBe(true);
        }
        expect(model!.requests.length).toBe(3);
        expect(
          JSON.stringify(model!.requests[2].body.messages).includes(
            'SUCCESS_B',
          ),
          'C history: SUCCESS_B',
        ).toBe(true);
        expect(
          JSON.stringify(model!.requests[2].body.messages).includes('REPLY_1'),
          'C history: REPLY_1',
        ).toBe(true);
        expect(
          JSON.stringify(model!.requests[2].body.messages).includes('PARTIAL'),
          'C history: PARTIAL',
        ).toBe(false);
      },
    );

    it('refuses a model-requested shell without local tools or a filesystem side effect', async () => {
      await start(() => ({
        toolCalls: [
          fakeToolCall('run_shell_command', {
            command: `echo forbidden > "${path.join(cli.root, 'forbidden-marker')}"`,
          }),
        ],
      }));
      await open();
      const body = payload('TRY_SHELL');
      await submit(body);
      expect(
        (await settled()).filter((event) => event.promptId === body.promptId),
      ).toEqual([
        expect.objectContaining({
          type: 'turn_error',
          data: expect.objectContaining({ code: 'hosted_turn_failed' }),
        }),
      ]);
      expect(model!.requests.length).toBe(1);
      expectNoTools(model!.requests[0].body);
      expect(cli.output).toContain(
        'Hosted Harness no-tool turn refused a tool call',
      );
      expect(existsSync(path.join(cli.root, 'forbidden-marker'))).toBe(false);
    });

    it('enforces authentication, protocol, boot identity, storage and private HTTP/WebSocket boundaries', async () => {
      await start();
      for (const headers of [
        new Headers(),
        new Headers({ Authorization: 'Bearer wrong' }),
      ]) {
        expect(
          (await cli.request('/session', { method: 'POST', headers })).status,
        ).toBe(401);
      }
      expect(
        (
          await cli.request('/session', {
            method: 'POST',
            headers: { Authorization: `Bearer ${HOSTED_TOKEN}` },
          })
        ).status,
      ).toBe(426);
      expect(
        (
          await cli.request('/session', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${HOSTED_TOKEN}`,
              'X-Qwen-Harness-Protocol-Version': '1',
            },
          })
        ).status,
      ).toBe(400);
      const stale = await cli.request('/session', {
        method: 'POST',
        headers: { ...cli.headers(), 'X-Qwen-Harness-Boot-Id': randomUUID() },
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        code: 'hosted_harness_generation_mismatch',
      });
      for (const route of [
        '/',
        '/workspaces',
        '/sessions',
        '/acp',
        '/mcp',
        '/session/unknown/shell',
      ]) {
        expect((await cli.request(route)).status).toBe(404);
      }
      const ws = new WebSocket(cli.baseUrl.replace('http:', 'ws:') + '/acp', {
        headers: cli.headers(),
        handshakeTimeout: 5_000,
      });
      try {
        expect(
          await new Promise<string>((resolve) => {
            ws.once('open', () => resolve('opened'));
            ws.once('unexpected-response', (_request, response) => {
              response.resume();
              resolve(`http ${response.statusCode}`);
            });
            ws.once('error', (error) => resolve(error.message));
          }),
        ).toMatch(/404/);
      } finally {
        ws.on('error', () => undefined);
        ws.terminate();
      }
      await store!.close();
      await json(
        '/session',
        {
          sessionId,
          sessionScope: 'thread',
          managedSessionStore: connection(),
        },
        503,
      );
      expect(model!.requests.length).toBe(0);
    });

    it('portable startup: binds loopback and cleans up after an assertion failure', async () => {
      await start();
      const urls = [cli.baseUrl, store!.baseUrl, model!.baseUrl];
      await expect(
        (async () => {
          try {
            expect(false, 'injected assertion failure').toBe(true);
          } finally {
            await cli.close();
            await store!.close();
            await model!.close();
          }
        })(),
      ).rejects.toThrow('injected assertion failure');
      expect(
        cli.child!.exitCode !== null || cli.child!.signalCode !== null,
      ).toBe(true);
      expect(existsSync(cli.root)).toBe(false);
      for (const url of urls) await assertPortReleased(url);
    });

    it('portable startup: refuses non-loopback and reaps a startup timeout', async () => {
      cli = new HostedHarnessProcess();
      await expect(
        cli.start('http://127.0.0.1:9/v1', { hostname: '0.0.0.0' }),
      ).rejects.toThrow('requires a loopback');
      expect(existsSync(cli.root)).toBe(false);
      cli = new HostedHarnessProcess();
      await expect(
        cli.start('http://127.0.0.1:9/v1', {
          startupTimeout: 100,
          args: ['-e', 'setInterval(() => {}, 1000)'],
        }),
      ).rejects.toThrow('Timed out');
      expect(
        cli.child!.exitCode !== null || cli.child!.signalCode !== null,
      ).toBe(true);
      expect(existsSync(cli.root)).toBe(false);
    });
  },
);
