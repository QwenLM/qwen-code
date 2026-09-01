/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_FAST_RECALL_DOCS,
  selectRelevantAutoMemoryDocuments,
} from './recall.js';
import type { ScannedAutoMemoryDocument } from './scan.js';
import type { AutoMemoryType } from './types.js';

/**
 * Delivery-stage measurement for the deterministic fast path.
 *
 * `recall-eval.test.ts` answers "did recall pick the right documents". This
 * file answers the separate question the fast path exists for: "did the
 * picked documents actually reach the model at a safe delivery point". A
 * perfect selector that never gets delivered is worth nothing.
 *
 * ## What is measured and what is modelled
 *
 * Measured for real: the deterministic scorer's own latency, which documents
 * each design delivers, and the overlap between the fast and refined sets
 * under the shipped dedupe rule.
 *
 * Modelled, not measured: the model selector's latency. It is a network side
 * query and cannot be timed in a unit test, so it is a parameter here. The
 * conclusions are reported per latency scenario rather than as a single
 * number, and the only structural claim — that a selector slower than the
 * initial budget leaves a tool-free turn with no delivery point at all under
 * the single-path design — holds for every scenario above the budget.
 */

const fixtureUrl = new URL(
  './__fixtures__/auto-memory-recall-eval.json',
  import.meta.url,
);

/** Mirrors INITIAL_MEMORY_RECALL_WAIT_MS in client.ts. */
const INITIAL_BUDGET_MS = 100;
const RECALL_AT = 5;

interface EvalDoc {
  id: string;
  type: AutoMemoryType;
  title: string;
  description: string;
  body: string;
}

interface EvalCase {
  id: string;
  category: string;
  query: string;
  relevantIds: string[];
  expectedTopId?: string;
}

interface EvalFixture {
  docs: EvalDoc[];
  cases: EvalCase[];
}

/**
 * Selector latency scenarios in milliseconds. 40 ms stands for a warm,
 * unusually fast round trip that lands inside the budget; the rest span an
 * ordinary to slow model call. Only the first is inside INITIAL_BUDGET_MS.
 */
const SELECTOR_LATENCY_SCENARIOS_MS = [40, 250, 600, 1500, 3000] as const;

/** Whether the first turn issues a tool call, which is the only later delivery point. */
type TurnShape = 'tool-free' | 'tool-using';

interface DeliveryOutcome {
  /** Documents in front of the model in the very first request. */
  initialDocIds: string[];
  /** Documents added at the first ToolResult, if any. */
  toolResultDocIds: string[];
  /** Documents selected but never delivered anywhere. */
  discardedDocIds: string[];
  /** Documents delivered more than once across both points. */
  duplicateDocIds: string[];
}

function loadFixture(): EvalFixture {
  return JSON.parse(readFileSync(fixtureUrl, 'utf8')) as EvalFixture;
}

function toScannedDocs(docs: EvalDoc[]): ScannedAutoMemoryDocument[] {
  return docs.map((doc) => ({
    type: doc.type,
    filePath: `/memory/${doc.id}.md`,
    relativePath: `${doc.id}.md`,
    filename: `${doc.id}.md`,
    title: doc.title,
    description: doc.description,
    body: doc.body,
    mtimeMs: 1,
  }));
}

const docIdOf = (doc: ScannedAutoMemoryDocument) =>
  doc.filename.replace(/\.md$/, '');

/**
 * Stand-in for the model selector's choice. The model is unavailable here, so
 * the deterministic top-5 is used. For the duplicate-rate question this is the
 * worst case on purpose: the fast set is drawn from the same ranking, so
 * overlap is maximal and the dedupe rule gets the hardest input it can get.
 */
function refinedSelection(
  query: string,
  docs: ScannedAutoMemoryDocument[],
): ScannedAutoMemoryDocument[] {
  return selectRelevantAutoMemoryDocuments(query, docs, RECALL_AT);
}

function fastSelection(
  query: string,
  docs: ScannedAutoMemoryDocument[],
): ScannedAutoMemoryDocument[] {
  return selectRelevantAutoMemoryDocuments(query, docs, RECALL_AT).slice(
    0,
    MAX_FAST_RECALL_DOCS,
  );
}

/**
 * Single-path design as shipped in #8716 before the fast path: one result,
 * delivered initially only if the selector settles inside the budget,
 * otherwise held for a ToolResult that a tool-free turn never produces.
 */
function simulateSinglePath(
  query: string,
  docs: ScannedAutoMemoryDocument[],
  selectorLatencyMs: number,
  turnShape: TurnShape,
): DeliveryOutcome {
  const refined = refinedSelection(query, docs).map(docIdOf);
  if (refined.length === 0) {
    return {
      initialDocIds: [],
      toolResultDocIds: [],
      discardedDocIds: [],
      duplicateDocIds: [],
    };
  }
  if (selectorLatencyMs <= INITIAL_BUDGET_MS) {
    return {
      initialDocIds: refined,
      toolResultDocIds: [],
      discardedDocIds: [],
      duplicateDocIds: [],
    };
  }
  if (turnShape === 'tool-using') {
    // The simulation models the safe ToolResult point after selector completion.
    // Selector latency is varied by scenario; ToolResult timing is not.
    return {
      initialDocIds: [],
      toolResultDocIds: refined,
      discardedDocIds: [],
      duplicateDocIds: [],
    };
  }
  return {
    initialDocIds: [],
    toolResultDocIds: [],
    discardedDocIds: refined,
    duplicateDocIds: [],
  };
}

/**
 * Fast-path design: same refined result, plus a deterministic result injected
 * at budget expiry and excluded from the later refined delivery.
 */
function simulateFastPath(
  query: string,
  docs: ScannedAutoMemoryDocument[],
  selectorLatencyMs: number,
  turnShape: TurnShape,
): DeliveryOutcome {
  const refined = refinedSelection(query, docs).map(docIdOf);
  if (selectorLatencyMs <= INITIAL_BUDGET_MS) {
    // Selector won the race; the fast result is never consumed.
    return {
      initialDocIds: refined,
      toolResultDocIds: [],
      discardedDocIds: [],
      duplicateDocIds: [],
    };
  }

  const fast = fastSelection(query, docs).map(docIdOf);
  const delivered = new Set(fast);
  const remaining = refined.filter((id) => !delivered.has(id));

  if (turnShape === 'tool-using') {
    // The simulation models the safe ToolResult point after selector completion.
    // Selector latency is varied by scenario; ToolResult timing is not.
    return {
      initialDocIds: fast,
      toolResultDocIds: remaining,
      discardedDocIds: [],
      duplicateDocIds: fast.filter((id) => remaining.includes(id)),
    };
  }
  return {
    initialDocIds: fast,
    toolResultDocIds: [],
    discardedDocIds: remaining,
    duplicateDocIds: [],
  };
}

interface DeliverySummary {
  answerableCases: number;
  /** Share of answerable cases with at least one document in the first request. */
  firstTurnDeliveryRate: number;
  /** Same, restricted to turns that make no tool call. */
  toolFreeFirstTurnDeliveryRate: number;
  /** Share of answerable cases where the relevant document reached the model at all. */
  anyDeliveryRate: number;
  /**
   * Same, on a turn that does make a tool call. The single-path design is not
   * broken here — it delivers one request later — so reporting this keeps the
   * comparison honest about where the actual gap is.
   */
  anyDeliveryRateToolUsing: number;
  /** Share of answerable cases delivering the same document twice. */
  duplicateDeliveryRate: number;
  /**
   * Share of answerable cases where the fast and refined sets overlap at all.
   * This is what the dedupe rule has to suppress; without it these cases would
   * become duplicate deliveries.
   */
  overlapBeforeDedupeRate: number;
}

function summarize(
  fixture: EvalFixture,
  simulate: typeof simulateSinglePath,
  selectorLatencyMs: number,
  filter: (testCase: EvalCase) => boolean = () => true,
): DeliverySummary {
  const docs = toScannedDocs(fixture.docs);
  const answerable = fixture.cases.filter(
    (testCase) => testCase.relevantIds.length > 0 && filter(testCase),
  );

  let firstTurnHits = 0;
  let toolFreeHits = 0;
  let anyDeliveryHits = 0;
  let anyDeliveryToolUsingHits = 0;
  let duplicateCases = 0;
  let overlapCases = 0;

  for (const testCase of answerable) {
    const toolFree = simulate(
      testCase.query,
      docs,
      selectorLatencyMs,
      'tool-free',
    );
    const toolUsing = simulate(
      testCase.query,
      docs,
      selectorLatencyMs,
      'tool-using',
    );

    if (toolUsing.initialDocIds.length > 0) firstTurnHits += 1;
    if (toolFree.initialDocIds.length > 0) toolFreeHits += 1;
    if (toolFree.initialDocIds.length + toolFree.toolResultDocIds.length > 0) {
      anyDeliveryHits += 1;
    }
    if (
      toolUsing.initialDocIds.length + toolUsing.toolResultDocIds.length >
      0
    ) {
      anyDeliveryToolUsingHits += 1;
    }
    if (toolUsing.duplicateDocIds.length > 0) duplicateCases += 1;

    // What dedupe had to suppress, independent of which design ran.
    const fast = new Set(fastSelection(testCase.query, docs).map(docIdOf));
    if (
      selectorLatencyMs > INITIAL_BUDGET_MS &&
      refinedSelection(testCase.query, docs).some((doc) =>
        fast.has(docIdOf(doc)),
      )
    ) {
      overlapCases += 1;
    }
  }

  const n = answerable.length;
  return {
    answerableCases: n,
    firstTurnDeliveryRate: firstTurnHits / n,
    toolFreeFirstTurnDeliveryRate: toolFreeHits / n,
    anyDeliveryRate: anyDeliveryHits / n,
    anyDeliveryRateToolUsing: anyDeliveryToolUsingHits / n,
    duplicateDeliveryRate: duplicateCases / n,
    overlapBeforeDedupeRate: overlapCases / n,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function measureDeterministicLatencyMs(fixture: EvalFixture): {
  p50: number;
  p95: number;
} {
  const docs = toScannedDocs(fixture.docs);
  const samples: number[] = [];
  // Warm up so the first-call compile cost doesn't land in the samples.
  for (let i = 0; i < 50; i += 1) {
    for (const testCase of fixture.cases) {
      selectRelevantAutoMemoryDocuments(testCase.query, docs, RECALL_AT);
    }
  }
  for (let i = 0; i < 200; i += 1) {
    for (const testCase of fixture.cases) {
      const started = performance.now();
      selectRelevantAutoMemoryDocuments(testCase.query, docs, RECALL_AT);
      samples.push(performance.now() - started);
    }
  }
  samples.sort((a, b) => a - b);
  return { p50: percentile(samples, 50), p95: percentile(samples, 95) };
}

/**
 * Answerable cases the deterministic scorer can actually reach. The
 * `semantic-no-lexical` slice is labeled answerable but shares no token with
 * its document, so no fast result exists for it; it is measured on its own
 * rather than folded into the delivery guarantee.
 */
const isLexicallyAnswerable = (testCase: EvalCase) =>
  testCase.category !== 'semantic-no-lexical';

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

describe('auto-memory recall delivery evaluation', () => {
  it('keeps deterministic candidate selection far inside the initial budget', () => {
    const { p50, p95 } = measureDeterministicLatencyMs(loadFixture());
    // The fast delivery path reuses this candidate selection, so the measured
    // work must stay negligible next to the budget. Generous bound: shared CI.
    expect(p95).toBeLessThan(INITIAL_BUDGET_MS / 10);
    expect(p50).toBeLessThanOrEqual(p95);
  });

  it('delivers nothing on a tool-free turn under the single-path design when the selector misses the budget', () => {
    const fixture = loadFixture();
    for (const latency of SELECTOR_LATENCY_SCENARIOS_MS) {
      if (latency <= INITIAL_BUDGET_MS) continue;
      const summary = summarize(fixture, simulateSinglePath, latency);
      expect(summary.toolFreeFirstTurnDeliveryRate).toBe(0);
      expect(summary.anyDeliveryRate).toBe(0);
    }
  });

  it('delivers on every tool-free turn whose query the deterministic path can match', () => {
    const fixture = loadFixture();
    for (const latency of SELECTOR_LATENCY_SCENARIOS_MS) {
      const summary = summarize(
        fixture,
        simulateFastPath,
        latency,
        isLexicallyAnswerable,
      );
      expect(summary.answerableCases).toBeGreaterThan(0);
      expect(summary.toolFreeFirstTurnDeliveryRate).toBe(1);
      expect(summary.anyDeliveryRate).toBe(1);
    }
  });

  /**
   * The bound on the claim above. The fast result is the deterministic
   * result, so a query with no lexical match produces no fast result, and a
   * tool-free turn asking it still ends with nothing delivered. The fast path
   * closes the *timing* gap, not the *matching* gap — only the model selector
   * closes the latter, and on a tool-free turn it never lands.
   *
   * The table below reports the honest overall rate, which is this slice's
   * share below 100%, rather than the lexically-answerable rate alone.
   */
  it('delivers nothing on a tool-free turn for semantic-only queries', () => {
    const fixture = loadFixture();
    for (const latency of SELECTOR_LATENCY_SCENARIOS_MS) {
      if (latency <= INITIAL_BUDGET_MS) continue;
      const summary = summarize(
        fixture,
        simulateFastPath,
        latency,
        (testCase) => !isLexicallyAnswerable(testCase),
      );
      expect(summary.answerableCases).toBeGreaterThan(0);
      expect(summary.toolFreeFirstTurnDeliveryRate).toBe(0);
      expect(summary.anyDeliveryRate).toBe(0);
    }
  });

  it('never delivers the same document twice', () => {
    const fixture = loadFixture();
    for (const latency of SELECTOR_LATENCY_SCENARIOS_MS) {
      expect(
        summarize(fixture, simulateFastPath, latency).duplicateDeliveryRate,
      ).toBe(0);
    }
  });

  it('leaves no-result queries silent under both designs', () => {
    const fixture = loadFixture();
    const docs = toScannedDocs(fixture.docs);
    for (const testCase of fixture.cases) {
      if (testCase.relevantIds.length > 0) continue;
      for (const simulate of [simulateSinglePath, simulateFastPath]) {
        const outcome = simulate(testCase.query, docs, 600, 'tool-free');
        expect(outcome.initialDocIds).toEqual([]);
        expect(outcome.toolResultDocIds).toEqual([]);
      }
    }
  });

  it('reports the before/after delivery table', () => {
    const fixture = loadFixture();
    const { p50, p95 } = measureDeterministicLatencyMs(fixture);
    const lines = [
      '',
      'Delivery gate — single path (before) vs deterministic fast path (after)',
      `deterministic scoring latency: p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms (budget ${INITIAL_BUDGET_MS} ms)`,
      '',
      '| selector latency | metric | before | after |',
      '| --- | --- | --- | --- |',
    ];

    for (const latency of SELECTOR_LATENCY_SCENARIOS_MS) {
      const before = summarize(fixture, simulateSinglePath, latency);
      const after = summarize(fixture, simulateFastPath, latency);
      const rows: Array<[string, number, number]> = [
        [
          'first-turn delivery (tool-using)',
          before.firstTurnDeliveryRate,
          after.firstTurnDeliveryRate,
        ],
        [
          'first-turn delivery (tool-free)',
          before.toolFreeFirstTurnDeliveryRate,
          after.toolFreeFirstTurnDeliveryRate,
        ],
        [
          'delivered at all (tool-free)',
          before.anyDeliveryRate,
          after.anyDeliveryRate,
        ],
        [
          'delivered at all (tool-using)',
          before.anyDeliveryRateToolUsing,
          after.anyDeliveryRateToolUsing,
        ],
        [
          'fast/refined overlap needing dedupe',
          before.overlapBeforeDedupeRate,
          after.overlapBeforeDedupeRate,
        ],
        [
          'duplicate delivery',
          before.duplicateDeliveryRate,
          after.duplicateDeliveryRate,
        ],
      ];
      for (const [metric, beforeValue, afterValue] of rows) {
        lines.push(
          `| ${latency} ms | ${metric} | ${formatPercent(beforeValue)} | ${formatPercent(afterValue)} |`,
        );
      }
    }

    console.log(lines.join('\n'));
    expect(lines.length).toBeGreaterThan(6);
  });
});
