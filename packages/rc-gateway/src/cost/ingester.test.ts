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
    costCentsSessionTotal: 0,
    costCentsPromptTotal: 0,
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
    for (let i = 1; i <= 10; i++) c.push(tick({ costCentsSessionTotal: i }));
    expect(t.armed).toHaveLength(1); // only one timer armed for the session
    t.fireAll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].costCentsSessionTotal).toBe(10); // latest wins
  });

  it('coalesces per session independently', () => {
    const emitted: UsageTick[] = [];
    const t = timers();
    const c = new UsageTickCoalescer({
      emit: (x) => emitted.push(x),
      schedule: t.schedule,
      cancel: t.cancel,
    });
    c.push(tick({ sessionId: 'a', costCentsSessionTotal: 1 }));
    c.push(tick({ sessionId: 'b', costCentsSessionTotal: 2 }));
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

  it('prices a usage frame, writes a row, and emits a usage_tick', () => {
    const { ingester, ticks } = makeIngester();
    const cost = ingester.ingest(
      'sess_1',
      frame({ inputTokens: 1000, outputTokens: 500 }),
      { attributionTokenId: 'tkn_abc', subActor: null },
    );
    expect(cost).toBeCloseTo(0.6, 10);
    expect(store.sessionTotals('sess_1').costCentsSessionTotal).toBeCloseTo(
      0.6,
    );
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({
      sessionId: 'sess_1',
      costCentsPromptTotal: expect.closeTo(0.6, 5),
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
    expect(last.costCentsPromptTotal).toBeCloseTo(0.6, 5); // reset, just this prompt
    expect(last.costCentsSessionTotal).toBeCloseTo(1.2, 5); // both prompts
  });
});
