/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import supertest from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import type { ContentGeneratorConfig } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import type { GenerateContentParameters } from '@google/genai';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedSideQueryRoutes } from './hosted-side-query.js';

const BOOT = '11111111-1111-4111-8111-111111111111';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture(
  options: { running?: () => Promise<boolean>; deadline?: number } = {},
) {
  const app = express();
  app.use(express.json());
  const contract = createHostedHarnessContract(DIGEST, BOOT, [], 'instance');
  installHostedHarnessContractMiddleware(app, contract);
  let operations = 0;
  const calls: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const providerGates: Array<() => void> = [];
  const claim = {
    instanceId: 'instance',
    bootId: BOOT,
    generation: 1,
    token: 'private-claim-token',
  };
  const deadlineAt = options.deadline ?? Date.now() + 300_000;
  const body = (queryId = 'query') => ({
    queryId,
    sessionId: 'session',
    claim,
    modelConfigDigest: DIGEST,
    deadlineAt,
    store: {
      baseUrl: `http://127.0.0.1:8080/internal/managed-session-store/v1/sessions/session/side-queries/${queryId}`,
      token: 'harness-token',
      tenantId: 'tenant',
    },
  });
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname.split('/').at(-1)!;
    calls.push(path);
    const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(parsed['claim']).toEqual(claim);
    expect(new Headers(init?.headers).get('X-Qwen-Tenant-Id')).toBe('tenant');
    expect(
      new Headers(init?.headers).get(
        'X-Qwen-Managed-Max-Readable-Storage-Version',
      ),
    ).toBe('4');
    let result: unknown = {};
    if (path === 'input')
      result = {
        queryId: String(url).split('/').at(-2),
        tenantId: 'tenant',
        sessionId: 'session',
        workspaceId: 'workspace',
        kind: 'btw',
        question: 'side question',
        privateHistory: [],
        processingVersion: 'side-query/1',
        modelConfigDigest: DIGEST,
        deadlineAt,
        source: {
          journalRevision: 0,
          committedSequence: 0,
          lastCommitDigest: null,
          completedTurnSequence: 0,
        },
      };
    if (path === 'model-config')
      result = {
        digest: DIGEST,
        config: {
          protocol: AuthType.USE_OPENAI,
          model: 'qwen-plus',
          base_url: 'https://model.example/v1',
          api_key: 'literal-key',
          generation_config: { max_tokens: 1000 },
        },
      };
    if (path === 'running')
      result = { started: options.running ? await options.running() : true };
    if (path === 'heartbeat') result = { active: true };
    if (path === 'result')
      updates.push(parsed['update'] as Record<string, unknown>);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const generate = vi.fn(
    async (
      _model: ContentGeneratorConfig,
      _request: GenerateContentParameters,
      _signal: AbortSignal,
      onProgress?: (text: string) => void,
    ) => {
      onProgress?.('partial answer');
      await new Promise<void>((resolve) => providerGates.push(resolve));
      return { outcome: 'success', text: 'answer' };
    },
  );
  registerHostedSideQueryRoutes(
    app,
    contract,
    {
      accepting: () => true,
      beginOperation: () => {
        operations++;
        return () => {
          operations--;
        };
      },
    },
    { fetchFn, generate },
  );
  const post = (path: string, payload: Record<string, unknown>) =>
    supertest(app)
      .post(path)
      .set('X-Qwen-Harness-Protocol-Version', '1')
      .set('X-Qwen-Harness-Boot-Id', BOOT)
      .send(payload);
  const settle = async () => {
    for (const resolve of providerGates.splice(0)) resolve();
    await vi.waitFor(() => expect(operations).toBe(0));
  };
  cleanups.push(settle);
  return {
    app,
    body,
    claim,
    post,
    generate,
    calls,
    updates,
    settle,
    operations: () => operations,
  };
}

describe('instance-scoped Hosted side queries', () => {
  it('persists partial snapshots while an independent model call is still running', async () => {
    const f = fixture();
    await f.post('/side-queries', f.body());
    await vi.waitFor(
      () =>
        expect(f.updates).toContainEqual(
          expect.objectContaining({
            status: 'running',
            text: 'partial answer',
          }),
        ),
      { timeout: 2500 },
    );
    expect(f.operations()).toBe(1);
    expect(f.calls).not.toContain('transactions');
    await f.settle();
    expect(f.updates.at(-1)).toMatchObject({
      status: 'completed',
      outcome: 'success',
    });
  });
  it('deduplicates submit and holds background operation accounting beyond 202', async () => {
    const f = fixture();
    expect((await f.post('/side-queries', f.body())).status).toBe(202);
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    expect((await f.post('/side-queries', f.body())).status).toBe(202);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.operations()).toBe(1);
    expect(f.calls).toEqual([
      'input',
      'model-config',
      'stage',
      'input-ready',
      'running',
    ]);
    expect(
      (await f.post('/side-queries/query/status', { claim: f.claim })).body,
    ).toEqual({ queryId: 'query', state: 'running', active: true });
    await f.settle();
    expect(f.updates).toEqual([
      expect.objectContaining({
        status: 'completed',
        outcome: 'success',
        text: 'answer',
      }),
    ]);
  });

  it('does not call a provider when cancellation wins the running CAS', async () => {
    let release!: (value: boolean) => void;
    const f = fixture({
      running: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });
    await f.post('/side-queries', f.body());
    await vi.waitFor(() => expect(f.calls).toContain('running'));
    expect(
      (await f.post('/side-queries/query/cancel', { claim: f.claim })).status,
    ).toBe(202);
    release(false);
    await f.settle();
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('keeps cancelled abort-ignoring calls in the four-slot limit until they settle', async () => {
    const f = fixture();
    for (let i = 0; i < 4; i++)
      expect((await f.post('/side-queries', f.body(`q${i}`))).status).toBe(202);
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(4));
    const cancelled = await f.post('/side-queries/q0/cancel', {
      claim: f.claim,
    });
    expect(cancelled.body.active).toBe(true);
    expect(f.generate.mock.calls[0]?.[2].aborted).toBe(true);
    expect((await f.post('/side-queries', f.body('q4'))).status).toBe(503);
    expect(f.operations()).toBe(4);
    await f.settle();
    expect(
      f.updates.some((update) => update['outcome'] === 'interrupted'),
    ).toBe(true);
  });

  it('retains accounting and partial text when a provider ignores its deadline abort', async () => {
    const f = fixture({ deadline: Date.now() + 150 });
    await f.post('/side-queries', f.body());
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(f.updates).toContainEqual(
        expect.objectContaining({
          outcome: 'deadline_exceeded',
          text: 'partial answer',
        }),
      ),
    );
    expect(f.operations()).toBe(1);
    expect(
      (await f.post('/side-queries/query/status', { claim: f.claim })).body
        .active,
    ).toBe(true);
    await f.settle();
    expect(f.updates.some((update) => update['outcome'] === 'success')).toBe(
      false,
    );
  });

  it('fences status/cancel with the complete query claim', async () => {
    const f = fixture();
    await f.post('/side-queries', f.body());
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    expect(
      (
        await f.post('/side-queries/query/cancel', {
          claim: { ...f.claim, token: 'wrong-token' },
        })
      ).status,
    ).toBe(404);
    expect(f.generate.mock.calls[0]?.[2].aborted).toBe(false);
    expect(
      (
        await f.post('/side-queries/query/status', {
          claim: { ...f.claim, generation: 2 },
        })
      ).status,
    ).toBe(404);
  });

  it('enforces boot/protocol protection for the independent route', async () => {
    const f = fixture();
    const response = await supertest(f.app).post('/side-queries');
    expect(response.status).toBe(426);
  });
});
