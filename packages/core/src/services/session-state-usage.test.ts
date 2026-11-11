/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import type { SessionStateKeyProvider } from './session-state-crypto.js';
import { SessionStateStore } from './session-state-store.js';
import {
  SESSION_USAGE_SEGMENT_KEY,
  bindSessionCreditsPersistence,
  clearSessionCredits,
  flushSessionUsage,
  getSessionCreditsSnapshot,
  getRequestCredits,
  loadLatestSessionUsage,
  recordCompletedRequest,
  recordSessionUsage,
  recordSessionUsageInMemory,
} from './session-state-usage.js';

class StaticSessionStateKeyProvider implements SessionStateKeyProvider {
  async getMasterKey(): Promise<Buffer> {
    return Buffer.alloc(32, 9);
  }
}

describe('session state usage', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'test-session-state-usage-'),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createStore(): SessionStateStore {
    return new SessionStateStore({
      projectRoot: '/workspace/demo',
      sessionId: 'session-private',
      configHomeDir: tempDir,
      keyProvider: new StaticSessionStateKeyProvider(),
    });
  }

  it('stores only the latest usage anchor needed after transcript redaction', async () => {
    const firstUsage = cloneUsage();
    firstUsage.input_tokens = 100;
    firstUsage.output_tokens = 20;
    const secondUsage = cloneUsage();
    secondUsage.input_tokens = 150;
    secondUsage.output_tokens = 30;
    secondUsage.cache_read_input_tokens = 7;

    const store = createStore();
    await recordSessionUsage(
      store,
      firstUsage,
      new Date('2026-04-24T00:00:00.000Z'),
    );
    await recordSessionUsage(
      store,
      secondUsage,
      new Date('2026-04-24T00:00:01.000Z'),
    );

    const latest = await loadLatestSessionUsage(createStore());
    expect(latest?.input_tokens).toBe(150);
    expect(latest?.output_tokens).toBe(30);

    const segment = await createStore().getSegment(SESSION_USAGE_SEGMENT_KEY);
    expect(segment).toMatchObject({
      updatedAt: '2026-04-24T00:00:01.000Z',
      latest: {
        input_tokens: 150,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 7,
        output_tokens: 30,
      },
      total: {
        input_tokens: 250,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 7,
        output_tokens: 50,
      },
    });
    expect(segment).not.toHaveProperty('cumulative');
  });

  it('preserves the latest response ID through private usage persistence', async () => {
    const store = createStore();
    const usage = {
      ...cloneUsage(),
      input_tokens: 100,
      output_tokens: 20,
      request_id: 'request-before-flush',
    };
    await recordSessionUsage(store, usage);
    expect((await loadLatestSessionUsage(store))?.request_id).toBe(
      'request-before-flush',
    );
    recordSessionUsageInMemory(store, {
      ...usage,
      request_id: 'request-after-flush',
    });
    await flushSessionUsage(store);
    expect((await loadLatestSessionUsage(createStore()))?.request_id).toBe(
      'request-after-flush',
    );
  });

  it('does not expose metering field names on disk', async () => {
    const usage = cloneUsage();
    usage.input_tokens = 100;
    usage.output_tokens = 20;

    const store = createStore();
    await recordSessionUsage(store, usage);

    const raw = await fs.readFile(store.getSessionStatePath(), 'utf8');
    expect(raw).toContain(SESSION_USAGE_SEGMENT_KEY);
    expect(raw).not.toContain('usage');
    expect(raw).not.toContain('input_tokens');
    expect(raw).not.toContain('encryptedSegments');
    expect(raw).not.toContain('ciphertext');
    expect(raw).not.toContain('"alg"');
    expect(raw).not.toContain('"kid"');
    expect(raw).not.toContain('"aad"');
  });

  it('can expose metering fields on disk when private segment encryption is disabled', async () => {
    const usage = cloneUsage();
    usage.input_tokens = 100;
    usage.output_tokens = 20;

    const store = new SessionStateStore({
      projectRoot: '/workspace/demo',
      sessionId: 'session-private',
      configHomeDir: tempDir,
      keyProvider: new StaticSessionStateKeyProvider(),
      encryptPrivateSegments: false,
    });
    await recordSessionUsage(store, usage);

    const raw = await fs.readFile(store.getSessionStatePath(), 'utf8');
    expect(raw).toContain(SESSION_USAGE_SEGMENT_KEY);
    expect(raw).toContain('input_tokens');
    expect(raw).toContain('output_tokens');
    expect(raw).toContain('total');
    expect(raw).not.toContain('service_tier');
    expect(raw).not.toContain('server_tool_use');
    expect(raw).not.toContain('inference_geo');
    expect(raw).not.toContain('iterations');
    expect(raw).not.toContain('speed');
    expect(raw).not.toContain('request_id');
    expect(raw).toContain('"items": {}');
  });

  it('multi-record + flush persists latest as last event and total as sum', async () => {
    const store = createStore();

    const usage1 = cloneUsage();
    usage1.input_tokens = 100;
    usage1.output_tokens = 20;

    const usage2 = cloneUsage();
    usage2.input_tokens = 200;
    usage2.output_tokens = 40;

    const usage3 = cloneUsage();
    usage3.input_tokens = 300;
    usage3.output_tokens = 60;
    usage3.cache_read_input_tokens = 5;

    recordSessionUsageInMemory(store, usage1);
    recordSessionUsageInMemory(store, usage2);
    recordSessionUsageInMemory(store, usage3);

    await flushSessionUsage(store, new Date('2026-05-01T00:00:00.000Z'));

    const segment = await createStore().getSegment(SESSION_USAGE_SEGMENT_KEY);
    expect(segment).toMatchObject({
      updatedAt: '2026-05-01T00:00:00.000Z',
      latest: {
        input_tokens: 300,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 5,
        output_tokens: 60,
      },
      total: {
        input_tokens: 600,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 5,
        output_tokens: 120,
      },
    });
  });

  it('idempotent flush does not write when cache is clean', async () => {
    const store = createStore();

    const usage = cloneUsage();
    usage.input_tokens = 50;
    usage.output_tokens = 10;

    recordSessionUsageInMemory(store, usage);
    await flushSessionUsage(store);

    const updateSpy = vi.spyOn(store, 'update');
    await flushSessionUsage(store);
    expect(updateSpy).not.toHaveBeenCalled();
    updateSpy.mockRestore();
  });

  it('loadLatestSessionUsage returns last individual usage after flush (not cumulative delta)', async () => {
    const store = createStore();

    const usage1 = cloneUsage();
    usage1.input_tokens = 100;
    usage1.output_tokens = 20;

    const usage2 = cloneUsage();
    usage2.input_tokens = 150;
    usage2.output_tokens = 30;
    usage2.cache_read_input_tokens = 7;

    recordSessionUsageInMemory(store, usage1);
    recordSessionUsageInMemory(store, usage2);
    await flushSessionUsage(store);

    const latest = await loadLatestSessionUsage(createStore());
    expect(latest?.input_tokens).toBe(150);
    expect(latest?.output_tokens).toBe(30);
    expect(latest?.cache_read_input_tokens).toBe(7);
  });

  it('flush failure preserves totalDelta for retry on next turn', async () => {
    const store = createStore();

    const usage1 = cloneUsage();
    usage1.input_tokens = 100;
    usage1.output_tokens = 20;

    const usage2 = cloneUsage();
    usage2.input_tokens = 200;
    usage2.output_tokens = 40;

    recordSessionUsageInMemory(store, usage1);
    recordSessionUsageInMemory(store, usage2);

    const updateSpy = vi.spyOn(store, 'update');
    updateSpy.mockRejectedValueOnce(new Error('disk full'));

    await expect(flushSessionUsage(store)).rejects.toThrow('disk full');

    updateSpy.mockRestore();

    const usage3 = cloneUsage();
    usage3.input_tokens = 50;
    usage3.output_tokens = 10;

    recordSessionUsageInMemory(store, usage3);
    await flushSessionUsage(store, new Date('2026-05-01T01:00:00.000Z'));

    const segment = await createStore().getSegment(SESSION_USAGE_SEGMENT_KEY);
    expect(segment).toMatchObject({
      latest: {
        input_tokens: 50,
        output_tokens: 10,
      },
      total: {
        input_tokens: 350,
        output_tokens: 70,
      },
    });
  });

  it('flushSessionUsage accumulates onto existing persisted total', async () => {
    const store = createStore();

    const preExisting = cloneUsage();
    preExisting.input_tokens = 500;
    preExisting.output_tokens = 100;
    await recordSessionUsage(store, preExisting);

    const delta = cloneUsage();
    delta.input_tokens = 80;
    delta.output_tokens = 15;

    recordSessionUsageInMemory(store, delta);
    await flushSessionUsage(store, new Date('2026-05-02T00:00:00.000Z'));

    const segment = await createStore().getSegment(SESSION_USAGE_SEGMENT_KEY);
    expect(segment).toMatchObject({
      latest: {
        input_tokens: 80,
        output_tokens: 15,
      },
      total: {
        input_tokens: 580,
        output_tokens: 115,
      },
    });
  });

  it('empty cache fast-path does not call store.update', async () => {
    const store = createStore();
    const updateSpy = vi.spyOn(store, 'update');

    await flushSessionUsage(store);

    expect(updateSpy).not.toHaveBeenCalled();
    updateSpy.mockRestore();
  });

  it('uses billable as the authoritative credits gate and deduplicates request IDs', () => {
    const sessionId = 'credits-billable';
    clearSessionCredits(sessionId);

    expect(
      recordCompletedRequest({
        sessionId,
        requestId: 'request-1',
        model: 'qwen3-coder-plus',
        usage: {
          billable: true,
          credits: 1.25,
        },
      }),
    ).toBe(true);
    expect(
      recordCompletedRequest({
        sessionId,
        requestId: 'request-1',
        model: 'qwen3-coder-plus',
        usage: {
          billable: true,
          credits: 100,
        },
      }),
    ).toBe(false);
    expect(
      recordCompletedRequest({
        sessionId,
        requestId: 'request-2',
        model: 'qwen3-coder-plus',
        usage: {
          billable: false,
          credits: 9,
        },
      }),
    ).toBe(true);

    expect(getSessionCreditsSnapshot(sessionId)).toEqual({
      observed: true,
      totalCredits: 1.25,
      byModel: {
        'qwen3-coder-plus': { credits: 1.25 },
      },
    });
    expect(getRequestCredits(sessionId, 'request-1')).toBe(1.25);
    expect(getRequestCredits(sessionId, 'request-2')).toBe(0);
    expect(getRequestCredits(sessionId, 'unknown')).toBeUndefined();
    expect(getRequestCredits('other-session', 'request-1')).toBeUndefined();
  });

  it('does not estimate incomplete billing usage', () => {
    const sessionId = 'credits-incomplete';
    clearSessionCredits(sessionId);

    expect(
      recordCompletedRequest({
        sessionId,
        requestId: 'missing-billable',
        model: 'qwen3-coder-plus',
        usage: {
          credits: 1,
        },
      }),
    ).toBe(false);
    expect(
      recordCompletedRequest({
        sessionId,
        requestId: 'missing-credits',
        model: 'qwen3-coder-plus',
        usage: {
          billable: true,
        },
      }),
    ).toBe(false);

    expect(getSessionCreditsSnapshot(sessionId)).toEqual({
      observed: false,
      totalCredits: 0,
      byModel: {},
    });
  });

  it('counts retry attempts independently only when each has complete billing usage', () => {
    const sessionId = 'credits-retry';
    clearSessionCredits(sessionId);

    recordCompletedRequest({
      sessionId,
      requestId: 'attempt-1',
      model: 'qwen3-coder-plus',
      usage: {
        billable: true,
        credits: 0.4,
      },
    });
    recordCompletedRequest({
      sessionId,
      requestId: 'attempt-2',
      model: 'qwen3-coder-plus',
      usage: {
        billable: true,
        credits: 0.6,
      },
    });

    expect(getSessionCreditsSnapshot(sessionId).totalCredits).toBe(1);
  });

  it('persists and hydrates session credits through the encrypted s0 segment', async () => {
    const sessionId = 'session-private';
    clearSessionCredits(sessionId);
    const store = createStore();
    const dispose = await bindSessionCreditsPersistence(sessionId, store);

    recordCompletedRequest({
      sessionId,
      requestId: 'persisted-request',
      model: 'qwen3-coder-plus',
      usage: {
        billable: true,
        credits: 2.125,
      },
    });
    await flushSessionUsage(store);
    await dispose();

    clearSessionCredits(sessionId);
    const resumedStore = createStore();
    const disposeResumed = await bindSessionCreditsPersistence(
      sessionId,
      resumedStore,
    );

    expect(getSessionCreditsSnapshot(sessionId)).toEqual({
      observed: true,
      totalCredits: 2.125,
      byModel: {
        'qwen3-coder-plus': { credits: 2.125 },
      },
    });
    await disposeResumed();
  });

});
