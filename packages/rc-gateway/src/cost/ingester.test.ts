/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractUsage,
  UsageTickCoalescer,
  UsageIngester,
  type UsageTick,
} from './ingester.js';
import { UsageStore } from './usageStore.js';
import { RateTableHolder, parseRateTable } from './rateTable.js';

const RATES = `
currencyLabel: USD
defaultModelServiceId: qwen
models:
  - modelServiceId: qwen
    modelId: qwen3-coder-plus
    inputPerMTok: 200
    outputPerMTok: 800
    cachedReadPerMTok: 20
`;

// The runtime session_update frame shape: data.update._meta.usage.
const frame = (
  usage: Record<string, unknown>,
  meta: Record<string, unknown> = {},
) => ({
  sessionId: 'sess_1',
  update: {
    sessionUpdate: 'agent_message_chunk',
    content: { text: 'hi' },
    _meta: { usage, modelId: 'qwen3-coder-plus', ...meta },
  },
});

describe('extractUsage', () => {
  it('reads camelCase token fields and the model id', () => {
    const u = extractUsage(
      frame({ inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 10 }),
    );
    expect(u).toEqual({
      modelServiceId: undefined,
      modelId: 'qwen3-coder-plus',
      tokensIn: 1000,
      tokensOut: 500,
      tokensCached: 10,
      stage: null,
    });
  });

  it('tolerates snake_case token spellings', () => {
    const u = extractUsage(
      frame({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 1 }),
    );
    expect(u).toMatchObject({ tokensIn: 7, tokensOut: 3, tokensCached: 1 });
  });

  it('returns null when there is no usage block', () => {
    expect(
      extractUsage({ sessionId: 's', update: { content: {} } }),
    ).toBeNull();
    expect(extractUsage({ update: { _meta: {} } })).toBeNull();
    expect(extractUsage(null)).toBeNull();
  });

  it('returns null when all token counts are zero', () => {
    expect(extractUsage(frame({ inputTokens: 0, outputTokens: 0 }))).toBeNull();
  });

  it('ignores a usage block on a non-agent_message_chunk frame (no double-count)', () => {
    // A `result`-style frame also carrying usage must NOT be priced — only the
    // agent_message_chunk locus is, so one turn is never counted twice.
    const resultFrame = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'result',
        _meta: { modelId: 'qwen3-coder-plus', usage: { input_tokens: 999 } },
      },
    };
    expect(extractUsage(resultFrame)).toBeNull();
  });

  it('captures modelServiceId and stage when present', () => {
    const u = extractUsage(
      frame({ inputTokens: 1 }, { modelServiceId: 'openai', stage: 'stage1' }),
    );
    expect(u).toMatchObject({ modelServiceId: 'openai', stage: 'stage1' });
  });
});

describe('UsageTickCoalescer', () => {
  function timers() {
    const armed: Array<{ fn: () => void; ms: number }> = [];
    return {
      armed,
      schedule: (fn: () => void, ms: number) => {
        armed.push({ fn, ms });
        return armed.length - 1;
      },
      cancel: () => {},
      fireAll: () => {
        const fns = armed.splice(0);
        for (const a of fns) a.fn();
      },
    };
  }

  const tick = (over: Partial<UsageTick> = {}): UsageTick => ({
    sessionId: 'sess_1',
    costMicrocentsSesTotal: 0,
    costMicrocentsPromptTotal: 0,
    tokensInTotal: 0,
    tokensOutTotal: 0,
    ...over,
  });

  it('collapses a burst into a single trailing emit with the latest totals', () => {
    const emitted: UsageTick[] = [];
    const t = timers();
    const c = new UsageTickCoalescer({
      emit: (x) => emitted.push(x),
      schedule: t.schedule,
      cancel: t.cancel,
    });
    for (let i = 1; i <= 10; i++) c.push(tick({ costMicrocentsSesTotal: i }));
    expect(t.armed).toHaveLength(1); // only one timer armed for the session
    t.fireAll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].costMicrocentsSesTotal).toBe(10); // latest wins
  });

  it('coalesces per session independently', () => {
    const emitted: UsageTick[] = [];
    const t = timers();
    const c = new UsageTickCoalescer({
      emit: (x) => emitted.push(x),
      schedule: t.schedule,
      cancel: t.cancel,
    });
    c.push(tick({ sessionId: 'a', costMicrocentsSesTotal: 1 }));
    c.push(tick({ sessionId: 'b', costMicrocentsSesTotal: 2 }));
    t.fireAll();
    expect(emitted.map((e) => e.sessionId).sort()).toEqual(['a', 'b']);
  });
});

describe('UsageIngester', () => {
  let dir: string;
  let store: UsageStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-ingest-'));
    store = UsageStore.open(join(dir, 'usage.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeIngester(over: { onRateMiss?: () => void } = {}) {
    const ticks: UsageTick[] = [];
    const coalescer = new UsageTickCoalescer({
      emit: (x) => ticks.push(x),
      schedule: (fn) => {
        fn(); // fire synchronously for assertions
        return 0;
      },
      cancel: () => {},
    });
    const ingester = new UsageIngester({
      rates: new RateTableHolder(parseRateTable(RATES)),
      store,
      coalescer,
      now: () => 1234,
      onRateMiss: over.onRateMiss,
    });
    return { ingester, ticks };
  }

  it('prices a usage frame, writes a row, and emits a usage_tick (microcents)', () => {
    const { ingester, ticks } = makeIngester();
    // 1000 in * 200/MTok + 500 out * 800/MTok = 200000 + 400000 = 600000 microcents = 0.6 cents
    const MICRO = 1_000_000;
    const cost = ingester.ingest(
      'sess_1',
      frame({ inputTokens: 1000, outputTokens: 500 }),
      { attributionTokenId: 'tkn_abc', subActor: null },
    );
    expect(cost).toBe(Math.round(0.6 * MICRO));
    expect(store.sessionTotals('sess_1').costMicrocentsSesTotal).toBe(
      Math.round(0.6 * MICRO),
    );
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({
      sessionId: 'sess_1',
      costMicrocentsPromptTotal: Math.round(0.6 * MICRO),
    });
  });

  it('records the bridge sub-actor on the row', () => {
    const { ingester } = makeIngester();
    ingester.ingest('sess_1', frame({ inputTokens: 100 }), {
      attributionTokenId: 'tkn_brg',
      subActor: 'telegram:42',
    });
    const rows = store.aggregate({
      sinceMs: 0,
      untilMs: 9999,
      groupBy: 'sub_actor',
    });
    expect(rows.map((r) => r.key)).toContain('telegram:42');
  });

  it('writes a NULL cost and audits on a rate-table miss', () => {
    let missed = false;
    const { ingester } = makeIngester({ onRateMiss: () => (missed = true) });
    const cost = ingester.ingest(
      'sess_1',
      frame({ inputTokens: 1 }, { modelId: 'unknown-model' }),
      { attributionTokenId: 't', subActor: null },
    );
    expect(cost).toBeNull();
    expect(missed).toBe(true);
    expect(store.sessionTotals('sess_1').tokensInTotal).toBe(1); // row still written
  });

  it('is a no-op for a frame with no usage', () => {
    const { ingester, ticks } = makeIngester();
    const r = ingester.ingest(
      'sess_1',
      { update: { content: {} } },
      {
        attributionTokenId: 't',
        subActor: null,
      },
    );
    expect(r).toBeUndefined();
    expect(ticks).toHaveLength(0);
  });

  it('resets the prompt total on a prompt boundary but keeps the session total', () => {
    const { ingester, ticks } = makeIngester();
    const MICRO = 1_000_000;
    ingester.ingest('sess_1', frame({ inputTokens: 1000, outputTokens: 500 }), {
      attributionTokenId: 't',
      subActor: null,
    });
    ingester.notePromptBoundary('sess_1');
    ingester.ingest('sess_1', frame({ inputTokens: 1000, outputTokens: 500 }), {
      attributionTokenId: 't',
      subActor: null,
    });
    const last = ticks[ticks.length - 1];
    expect(last.costMicrocentsPromptTotal).toBe(Math.round(0.6 * MICRO)); // reset, just this prompt
    expect(last.costMicrocentsSesTotal).toBe(Math.round(1.2 * MICRO)); // both prompts
  });
});
