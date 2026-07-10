/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end wiring proof for cost ingestion (`add-cost-tracking`): a real
 * {@link SessionEventPump} subscribed to a stub daemon, with the real
 * {@link UsageIngester} on its `onEvent` hook, writes a priced row to the real
 * {@link UsageStore} when a `session_update` carrying a usage block arrives.
 *
 * This exercises the actual pump→onEvent→ingester→store path (not fakes). The one
 * link it CANNOT verify in this environment is whether a live `qwen serve`
 * actually emits usage at `data.update._meta.usage` — there is no model-credentialed
 * daemon in CI (the rc-gateway e2e only routes prompts, never runs a model turn).
 * So the frame here is hand-built in the shape `extractUsage` reads; the real
 * daemon's exact shape remains a documented verification ceiling.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { SessionEventPump } from '../webpush/pump.js';
import { UsageStore } from './usageStore.js';
import { RateTableHolder, DEFAULT_RATE_TABLE } from './rateTable.js';
import {
  UsageIngester,
  UsageTickCoalescer,
  type UsageTick,
} from './ingester.js';
import { SessionAttributionMap } from './sessionAttribution.js';

let stub: StubDaemon | undefined;
let pump: SessionEventPump | undefined;
let store: UsageStore;
let dir: string;

afterEach(async () => {
  if (pump) await pump.stop();
  if (stub) await stub.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
  pump = undefined;
  stub = undefined;
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-cost-int-'));
  store = UsageStore.open(join(dir, 'usage.db'));
});

async function waitFor(p: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!p()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// A session_update in the runtime shape extractUsage reads.
const usageFrame = (id: number) => ({
  id,
  type: 'session_update',
  data: {
    sessionId: 's1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'hello' },
      _meta: {
        modelId: 'qwen3-coder-plus',
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 0,
        },
      },
    },
  },
});

describe('cost ingestion through the real pump', () => {
  it('prices a usage session_update into a usage_events row attributed to the prompter', async () => {
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      holdOpenMs: 2000,
      frames: [usageFrame(7)],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });

    const attribution = new SessionAttributionMap();
    attribution.set('s1', {
      attributionTokenId: 'tkn_abc',
      subActor: 'telegram:42',
    });
    const ticks: UsageTick[] = [];
    const ingester = new UsageIngester({
      rates: new RateTableHolder(DEFAULT_RATE_TABLE),
      store,
      coalescer: new UsageTickCoalescer({ emit: (t) => ticks.push(t) }),
      now: () => 1_000,
    });

    pump = new SessionEventPump(daemon, undefined, {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
      onEvent: (sid, ev) => ingester.ingest(sid, ev.data, attribution.get(sid)),
    });
    await pump.start();

    await waitFor(() => store.sessionTotals('s1').costMicrocentsSesTotal > 0);

    // qwen3-coder-plus @ (200,800,20)/Mtok: 1000*200/1e6 + 500*800/1e6 = 600000 microcents
    expect(store.sessionTotals('s1').costMicrocentsSesTotal).toBe(600000);
    const rows = store.aggregate({
      sinceMs: 0,
      untilMs: 2000,
      groupBy: 'sub_actor',
    });
    expect(rows.find((r) => r.key === 'telegram:42')).toBeDefined();
    await waitFor(() => ticks.length > 0);
    expect(ticks[0].sessionId).toBe('s1');
  });

  it('runs the pump for cost tracking with NO push notifier', async () => {
    // The discriminator: cost ingestion must work when push is unconfigured.
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      holdOpenMs: 2000,
      frames: [usageFrame(1)],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const ingester = new UsageIngester({
      rates: new RateTableHolder(DEFAULT_RATE_TABLE),
      store,
      coalescer: new UsageTickCoalescer({ emit: () => {} }),
      now: () => 1_000,
    });
    pump = new SessionEventPump(daemon, undefined, {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
      onEvent: (sid, ev) =>
        ingester.ingest(sid, ev.data, {
          attributionTokenId: 'unknown',
          subActor: null,
        }),
    });
    await pump.start(); // must not throw with notifier=undefined
    await waitFor(() => store.sessionTotals('s1').tokensInTotal > 0);
    expect(store.sessionTotals('s1').tokensInTotal).toBe(1000);
  });
});
