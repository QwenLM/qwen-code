/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import * as stdio from '../utils/stdioHelpers.js';

const state = vi.hoisted(() => ({
  root: '',
  model: vi.fn(async (_input: { signal: AbortSignal }) => ({
    text: 'hello back',
    model: 'test-model',
  })),
}));

vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js',
  () => ({
    HTTP_MANAGED_SESSION_STORE_CONTRACT: { maxInlineResourceBytes: 64 * 1024 },
    createHttpManagedSessionStores: (options: {
      sessionKey: { tenantId: string; workspaceId: string; sessionId: string };
    }) => ({
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: options.sessionKey.sessionId,
        transcriptPath: path.join(
          state.root,
          `${options.sessionKey.sessionId}.jsonl`,
        ),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: options.sessionKey,
      }),
      close: async () => undefined,
    }),
  }),
);
vi.mock('./hosted-harness-model.js', () => ({
  runHostedHarnessTextTurn: state.model,
}));

const BOOT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROMPT_ID = '33333333-3333-4333-8333-333333333333';

function app() {
  const result = express();
  result.use(express.json());
  const contract = createHostedHarnessContract(
    `sha256:${'a'.repeat(64)}`,
    BOOT_ID,
  );
  installHostedHarnessContractMiddleware(result, contract);
  registerHostedHarnessSessionRoutes(result, contract, state.root);
  return result;
}

function headers<T extends supertest.Test>(request: T): T {
  return request
    .set('X-Qwen-Harness-Protocol-Version', '1')
    .set('X-Qwen-Harness-Boot-Id', BOOT_ID);
}

function store() {
  return {
    baseUrl: 'http://store.test',
    tenantId: 'tenant',
    workspaceId: 'workspace',
    writerId: BOOT_ID,
    leaseDurationMs: 60_000,
  };
}

describe('Hosted Harness no-tool session', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.model.mockReset();
    state.model.mockImplementation(async () => ({
      text: 'hello back',
      model: 'test-model',
    }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(state.root, { recursive: true, force: true });
  });

  it('distinguishes strict create and load outcomes', async () => {
    const server = app();
    const missing = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(missing.status).toBe(404);

    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    const exists = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(exists.status).toBe(409);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('allows only one concurrent attachment for a session ID', async () => {
    const server = app();
    const create = () =>
      headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
      });
    const results = await Promise.all([create(), create()]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('keeps the caller session ID, commits a text turn, and refuses duplicate inference', async () => {
    const server = app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    expect(created.body.sessionId).toBe(SESSION_ID);
    expect(created.body.lastEventId).toBeGreaterThan(0);

    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const send = () =>
      headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', created.body.clientId as string)
        .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    const admitted = await send();
    expect(admitted.status).toBe(202);
    expect(admitted.body.promptId).toBe(PROMPT_ID);
    await vi.waitFor(async () => {
      const status = await headers(
        supertest(server).get(`/session/${SESSION_ID}/status`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(status.body.hasActivePrompt).toBe(false);
    });
    expect(state.model).toHaveBeenCalledTimes(1);

    const transcript = await headers(
      supertest(server).get(`/session/${SESSION_ID}/transcript`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(transcript.status).toBe(200);
    expect(transcript.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'session_update',
          promptId: PROMPT_ID,
        }),
        expect.objectContaining({ type: 'turn_complete', promptId: PROMPT_ID }),
      ]),
    );
    expect(
      (transcript.body.events as Array<{ id: number }>).map(
        (event) => event.id,
      ),
    ).toEqual(
      (transcript.body.events as Array<{ id: number }>).map(
        (_, index) => index + 1,
      ),
    );
    const listener = server.listen(0);
    const address = listener.address();
    expect(address && typeof address !== 'string').toBe(true);
    const controller = new AbortController();
    try {
      const stream = await fetch(
        `http://127.0.0.1:${(address as { port: number }).port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': created.body.clientId as string,
            'X-Qwen-Event-Epoch': admitted.body.eventEpoch as string,
            'Last-Event-ID': String(admitted.body.lastEventId),
          },
          signal: controller.signal,
        },
      );
      expect(stream.status).toBe(200);
      expect(stream.headers.get('x-qwen-event-epoch')).toBe(
        admitted.body.eventEpoch,
      );
      const reader = stream.body!.getReader();
      let frames = '';
      while (!frames.includes('event: turn_complete')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        frames += new TextDecoder().decode(chunk.value);
      }
      const ids = [...frames.matchAll(/^id: (\d+)$/gm)].map((match) =>
        Number(match[1]),
      );
      expect(ids).toEqual(
        ids.map((_, index) => Number(admitted.body.lastEventId) + index + 1),
      );
      expect(frames).toContain('event: session_update');
      expect(frames).toContain(`"promptId":"${PROMPT_ID}"`);
    } finally {
      controller.abort();
      listener.close();
    }
    const repeated = await send();
    expect(repeated.status).toBe(202);
    expect(repeated.body.lastEventId).toBe(admitted.body.lastEventId);
    expect(state.model).toHaveBeenCalledTimes(1);

    const title = await headers(
      supertest(server).post(`/session/${SESSION_ID}/title`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ title: 'Hosted test' });
    expect(title.status).toBe(200);
    expect(title.body.persisted).toBe(true);

    const closed = await headers(
      supertest(server).delete(`/session/${SESSION_ID}`),
    );
    expect(closed.status).toBe(204);
    const gone = await headers(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(gone.status).toBe(404);
  });

  it('rejects unsupported prompt content before model or tool execution', async () => {
    const server = app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'image', data: 'forbidden' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const rejected = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(rejected.status).toBe(400);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
  });

  it('rejects prompts whose durable user record would exceed the store limit', async () => {
    const server = app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const prompt = [{ type: 'text', text: 'x'.repeat(65_300) }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const rejected = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(rejected.status).toBe(413);
    expect(state.model).not.toHaveBeenCalled();
    const status = await headers(
      supertest(server).get(`/session/${SESSION_ID}/status`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(status.body.recoveryBlocked).toBe(false);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId as string,
    );
  });

  it('ends an event stream when its attachment closes', async () => {
    const server = app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const listener = server.listen(0);
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const stream = await fetch(
        `http://127.0.0.1:${address.port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': created.body.clientId as string,
          },
          signal: AbortSignal.timeout(3_000),
        },
      );
      expect(stream.status).toBe(200);
      const closed = await headers(
        supertest(server).delete(`/session/${SESSION_ID}`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(closed.status).toBe(204);
      const reader = stream.body!.getReader();
      let done = false;
      while (!done) ({ done } = await reader.read());
      expect(done).toBe(true);
    } finally {
      listener.close();
    }
  });

  it('stops writing an event stream after backpressure ends it', async () => {
    const server = app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    const clientId = created.body.clientId as string;
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    await vi.waitFor(async () => {
      const transcript = await headers(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', clientId);
      expect(transcript.body.events.length).toBeGreaterThan(2);
    });

    const originalWrite = ServerResponse.prototype.write;
    let frames = 0;
    let ends = 0;
    const write = vi
      .spyOn(ServerResponse.prototype, 'write')
      .mockImplementation(function (
        this: ServerResponse,
        ...args: Parameters<ServerResponse['write']>
      ) {
        if (typeof args[0] === 'string' && args[0].startsWith('id: ')) {
          frames++;
          originalWrite.apply(this, args);
          return false;
        }
        return originalWrite.apply(this, args);
      });
    const end = vi
      .spyOn(ServerResponse.prototype, 'end')
      .mockImplementation(function (this: ServerResponse) {
        ends++;
        return this;
      });
    const listener = server.listen(0);
    const abort = new AbortController();
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const stream = await fetch(
        `http://127.0.0.1:${address.port}/session/${SESSION_ID}/events`,
        {
          headers: {
            'X-Qwen-Harness-Protocol-Version': '1',
            'X-Qwen-Harness-Boot-Id': BOOT_ID,
            'X-Qwen-Client-Id': clientId,
          },
          signal: abort.signal,
        },
      );
      expect(stream.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(frames).toBe(1);
      expect(ends).toBe(1);
    } finally {
      write.mockRestore();
      end.mockRestore();
      abort.abort();
      listener.closeAllConnections();
      listener.close();
      await headers(supertest(server).delete(`/session/${SESSION_ID}`)).set(
        'X-Qwen-Client-Id',
        clientId,
      );
    }
  });

  it('logs the failure cause while keeping the public turn error generic', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    state.model.mockRejectedValueOnce(new Error('model initialization failed'));
    const server = app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      });
    expect(admitted.status).toBe(202);
    await vi.waitFor(async () => {
      const transcript = await headers(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_error',
            promptId: PROMPT_ID,
            data: {
              sessionId: SESSION_ID,
              promptId: PROMPT_ID,
              code: 'hosted_turn_failed',
              message: 'Hosted Harness turn failed.',
            },
          }),
        ]),
      );
    });
    expect(log).toHaveBeenCalledWith(
      `qwen serve: Hosted Harness turn ${PROMPT_ID} failed: Error: model initialization failed`,
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('reports an aborted turn as cancelled to the Java event projector', async () => {
    const log = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    state.model.mockImplementationOnce(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new Error('cancelled')),
          );
        }),
    );
    const server = app();
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
    });
    expect(created.status).toBe(200);
    const prompt = [{ type: 'text', text: 'wait' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const admitted = await headers(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    )
      .set('X-Qwen-Client-Id', created.body.clientId as string)
      .send({ prompt, promptId: PROMPT_ID, payloadDigest });
    expect(admitted.status).toBe(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(1));
    const cancelled = await headers(
      supertest(server).post(`/session/${SESSION_ID}/cancel`),
    ).set('X-Qwen-Client-Id', created.body.clientId as string);
    expect(cancelled.status).toBe(204);
    await vi.waitFor(async () => {
      const transcript = await headers(
        supertest(server).get(`/session/${SESSION_ID}/transcript`),
      ).set('X-Qwen-Client-Id', created.body.clientId as string);
      expect(transcript.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'turn_complete',
            promptId: PROMPT_ID,
            data: expect.objectContaining({ stopReason: 'cancelled' }),
          }),
        ]),
      );
    });
    expect(log).not.toHaveBeenCalled();
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });
});
