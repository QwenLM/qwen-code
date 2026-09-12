/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { selectRelevantAutoMemoryDocuments } from './recall.js';
import type { ScannedAutoMemoryDocument } from './scan.js';
import type { AutoMemoryType } from './types.js';

/**
 * Measurement harness for the deterministic recall path.
 *
 * RFC #7040 gates the multilingual precision change on evidence that English
 * Recall@5 and no-result precision do not regress. Behavioural assertions in
 * `recall.test.ts` pin individual contracts but cannot answer that question,
 * because "no regression" is a statement about the *previous* scorer. This
 * file therefore keeps a frozen copy of the pre-change scorer as a reference
 * implementation and scores both over one labeled corpus.
 *
 * Only the deterministic selector is measured. The model selector is the
 * normal precision gate and is exercised by the mocked cases in
 * `recall.test.ts`; active-tool noise filtering and model-candidate bounding
 * likewise stay in that file, since neither is reachable from the pure
 * scoring function evaluated here.
 */

const fixtureUrl = new URL(
  './__fixtures__/auto-memory-recall-eval.json',
  import.meta.url,
);

const RECALL_AT = 5;

const categories = new Set([
  'english',
  'chinese',
  'japanese',
  'korean',
  'mixed',
  'nfkc',
  'body-only',
  'semantic-no-lexical',
  'other-script',
  'no-result',
] as const);

type EvalCategory = typeof categories extends Set<infer T> ? T : never;

interface EvalDoc {
  id: string;
  type: AutoMemoryType;
  title: string;
  description: string;
  body: string;
}

interface EvalCase {
  id: string;
  category: EvalCategory;
  query: string;
  relevantIds: string[];
  expectedTopId?: string;
}

interface EvalFixture {
  docs: EvalDoc[];
  cases: EvalCase[];
}

interface EvalSummary {
  cases: number;
  recallCases: number;
  recallAt5: number | null;
  top1Cases: number;
  top1Accuracy: number | null;
  labeledNoResultCases: number;
  /**
   * Of the cases where the scorer stayed silent, how many were genuinely
   * unanswerable. Only meaningful over a slice that mixes answerable and
   * unanswerable cases — over a no-result-only slice it is 100% by
   * construction, which is why the gate below uses `noResultRecall`.
   */
  noResultPrecision: number | null;
  /**
   * Of the labeled no-result cases, how many the scorer correctly answered
   * with nothing. This is the false-positive metric: a scorer that returns
   * filler documents for an unmatched query scores 0 here.
   */
  noResultRecall: number | null;
  maxSelectedDocs: number;
}

type Selector = (
  query: string,
  docs: ScannedAutoMemoryDocument[],
  limit?: number,
) => ScannedAutoMemoryDocument[];

/* -------------------------------------------------------------------------
 * Frozen pre-#8716 reference scorer.
 *
 * Copied verbatim from `recall.ts` at the merge-base of this branch. It is
 * intentionally duplicated rather than imported: it must keep describing the
 * old behaviour even after `recall.ts` changes, otherwise the "before" column
 * silently tracks the "after" one and the gate stops meaning anything.
 * ---------------------------------------------------------------------- */

const BASELINE_TYPE_KEYWORDS: Record<string, string[]> = {
  user: ['user', 'preference', 'preferences', 'background', 'role', 'terse'],
  feedback: ['feedback', 'rule', 'rules', 'avoid', 'style', 'summary'],
  project: ['project', 'goal', 'goals', 'incident', 'deadline', 'release'],
  reference: ['reference', 'dashboard', 'ticket', 'docs', 'doc', 'link'],
};

function baselineNormalizeBody(body: string): string {
  const trimmed = body.trim();
  return trimmed === '_No entries yet._' ? '' : trimmed;
}

function baselineTokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3),
    ),
  );
}

function baselineScoreDocument(
  queryTokens: string[],
  doc: ScannedAutoMemoryDocument,
): number {
  const normalizedBody = baselineNormalizeBody(doc.body);
  const haystack = [doc.type, doc.title, doc.description, normalizedBody]
    .join(' ')
    .toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 2;
    }
    if (BASELINE_TYPE_KEYWORDS[doc.type]?.includes(token)) {
      score += 1;
    }
  }

  if (normalizedBody.length > 0) {
    score += 1;
  }

  return score;
}

const baselineSelectRelevantAutoMemoryDocuments: Selector = (
  query,
  docs,
  limit = RECALL_AT,
) => {
  const queryTokens = baselineTokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  return docs
    .map((doc) => ({ doc, score: baselineScoreDocument(queryTokens, doc) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.doc.type.localeCompare(b.doc.type))
    .slice(0, limit)
    .map(({ doc }) => doc);
};

/* ---------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadFixture(): EvalFixture {
  const parsed: unknown = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error('recall evaluation fixture must be an object');
  }
  const { docs, cases } = parsed as unknown as EvalFixture;
  if (!Array.isArray(docs) || !Array.isArray(cases)) {
    throw new Error('recall evaluation fixture must define docs and cases');
  }

  const docIds = new Set(docs.map((doc) => doc.id));
  if (docIds.size !== docs.length) {
    throw new Error('recall evaluation fixture must use unique doc IDs');
  }

  const caseIds = new Set(cases.map((testCase) => testCase.id));
  if (caseIds.size !== cases.length) {
    throw new Error('recall evaluation fixture must use unique case IDs');
  }

  for (const testCase of cases) {
    if (!categories.has(testCase.category)) {
      throw new Error(`unknown category on case ${testCase.id}`);
    }
    for (const id of [
      ...testCase.relevantIds,
      ...(testCase.expectedTopId ? [testCase.expectedTopId] : []),
    ]) {
      if (!docIds.has(id)) {
        throw new Error(`case ${testCase.id} references unknown doc ${id}`);
      }
    }
    if (testCase.expectedTopId && testCase.relevantIds.length === 0) {
      throw new Error(`case ${testCase.id} expects a top doc but is no-result`);
    }
  }

  return { docs, cases };
}

/**
 * Fixed mtime for every document: recency must not influence the
 * deterministic scorer, so a shared value keeps the corpus order-stable.
 */
function toScannedDocs(docs: EvalDoc[]): ScannedAutoMemoryDocument[] {
  return docs.map((doc) => ({
    scope: 'project',
    type: doc.type,
    filePath: `/memory/${doc.id}.md`,
    relativePath: `${doc.id}.md`,
    filename: `${doc.id}.md`,
    title: doc.title,
    description: doc.description,
    category: 'uncategorized',
    keywords: [],
    usageScenarios: [],
    body: doc.body,
    mtimeMs: 1,
  }));
}

function docIdOf(doc: ScannedAutoMemoryDocument): string {
  return doc.filename.replace(/\.md$/, '');
}

function evaluate(
  fixture: EvalFixture,
  selector: Selector,
  filter: (testCase: EvalCase) => boolean = () => true,
): EvalSummary {
  const scannedDocs = toScannedDocs(fixture.docs);
  const cases = fixture.cases.filter(filter);

  let recallTotal = 0;
  let recallCases = 0;
  let top1Hits = 0;
  let top1Cases = 0;
  let correctNoResultPredictions = 0;
  let noResultPredictions = 0;
  let labeledNoResultCases = 0;
  let correctlySilentNoResultCases = 0;
  let maxSelectedDocs = 0;

  for (const testCase of cases) {
    const selected = selector(testCase.query, scannedDocs, RECALL_AT);
    const selectedIds = selected.map(docIdOf);
    maxSelectedDocs = Math.max(maxSelectedDocs, selected.length);

    if (testCase.relevantIds.length > 0) {
      const hits = testCase.relevantIds.filter((id) =>
        selectedIds.slice(0, RECALL_AT).includes(id),
      ).length;
      recallTotal += hits / testCase.relevantIds.length;
      recallCases += 1;
    } else {
      labeledNoResultCases += 1;
      if (selected.length === 0) {
        correctlySilentNoResultCases += 1;
      }
    }

    if (testCase.expectedTopId) {
      top1Hits += selectedIds[0] === testCase.expectedTopId ? 1 : 0;
      top1Cases += 1;
    }

    if (selected.length === 0) {
      noResultPredictions += 1;
      correctNoResultPredictions += testCase.relevantIds.length === 0 ? 1 : 0;
    }
  }

  // `null` means "not applicable to this slice" so an inapplicable metric
  // reads as n/a rather than as a 0% failure.
  return {
    cases: cases.length,
    recallCases,
    recallAt5: recallCases === 0 ? null : recallTotal / recallCases,
    top1Cases,
    top1Accuracy: top1Cases === 0 ? null : top1Hits / top1Cases,
    labeledNoResultCases,
    noResultPrecision:
      noResultPredictions === 0
        ? null
        : correctNoResultPredictions / noResultPredictions,
    noResultRecall:
      labeledNoResultCases === 0
        ? null
        : correctlySilentNoResultCases / labeledNoResultCases,
    maxSelectedDocs,
  };
}

const isEnglish = (testCase: EvalCase) => testCase.category === 'english';
/**
 * Answerable queries that share no token with their labeled document. The
 * scorer requires a lexical match before it returns anything, so it cannot
 * serve this slice by design — the model selector is the path that covers it.
 * The slice exists to keep that cost measured and visible rather than absent
 * from the corpus, and it is excluded from the quality floor below because a
 * floor over cases the deterministic path is not meant to answer would only
 * measure how many of them the corpus happens to contain.
 */
const isSemanticNoLexical = (testCase: EvalCase) =>
  testCase.category === 'semantic-no-lexical';
/**
 * Alphabetic scripts outside ASCII and CJK — Cyrillic, Greek, and accented
 * Latin here. The pre-change tokenizer kept only `[a-z0-9]{3,}` runs, so
 * these queries produced no tokens at all and the deterministic path was
 * unconditionally silent; the shipped tokenizer keeps whole non-CJK letter
 * runs instead.
 */
const isOtherScript = (testCase: EvalCase) =>
  testCase.category === 'other-script';
const isCjk = (testCase: EvalCase) =>
  testCase.category === 'chinese' ||
  testCase.category === 'japanese' ||
  testCase.category === 'korean';
/** Queries that mix scripts, including the full-width NFKC cases. */
const isMixed = (testCase: EvalCase) =>
  testCase.category === 'mixed' || testCase.category === 'nfkc';

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/**
 * Expected Recall@5 of a scorer that ignores the query and returns five
 * documents drawn uniformly at random from the corpus. Each labeled document
 * has a `RECALL_AT / corpusSize` chance of being among them, so the expected
 * per-case recall — and therefore the mean over any slice — is that ratio.
 *
 * Printed beside the measured columns because a small corpus flatters the
 * headline: on a pool this size "100% Recall@5" is a much weaker statement
 * than it reads, and a reader comparing designs needs the floor to calibrate
 * against. It is exact rather than sampled, so the table stays deterministic.
 */
function randomBaselineRecallAt5(corpusSize: number): number {
  return corpusSize === 0 ? 0 : Math.min(1, RECALL_AT / corpusSize);
}

describe('auto-memory recall evaluation', () => {
  it('loads a labeled corpus covering every required category', () => {
    const fixture = loadFixture();
    expect(fixture.cases.length).toBeGreaterThanOrEqual(30);
    expect(fixture.cases.length).toBeLessThanOrEqual(60);
    expect(new Set(fixture.cases.map((testCase) => testCase.category))).toEqual(
      categories,
    );
  });

  /**
   * The floors carry deliberate headroom: this is an evaluation, not a
   * behavioural contract. One known top-1 miss is expected and correct —
   * `body-only-owner-approval` ("owner approval") ranks `en-owner` first
   * because "owner" is a substring of "ownership" in that document's title,
   * and a title match outranks the body match in `en-rollback`. Tighten the
   * scorer if that ordering is ever judged wrong; do not relabel the case.
   */
  it('holds the multilingual quality floor', () => {
    // Excludes the semantic-no-lexical slice: those cases are labeled
    // answerable but are unreachable without a lexical match, so counting
    // them here would turn a deliberate design boundary into a moving floor.
    // Their cost is measured by the test below instead.
    const summary = evaluate(
      loadFixture(),
      selectRelevantAutoMemoryDocuments,
      (testCase) => !isSemanticNoLexical(testCase),
    );
    expect(summary.recallAt5).toBeGreaterThanOrEqual(0.9);
    expect(summary.top1Accuracy).toBeGreaterThanOrEqual(0.85);
    expect(summary.noResultPrecision).toBe(1);
    expect(summary.noResultRecall).toBe(1);
    expect(summary.maxSelectedDocs).toBeLessThanOrEqual(RECALL_AT);
  });

  /**
   * Records the price of "no lexical match, no score". These queries are
   * genuinely answerable — a human, and the model selector, would pick the
   * labeled document — and the deterministic scorer returns nothing for all
   * of them. Two consequences follow that the headline numbers do not show:
   * on a tool-free turn the fast path delivers nothing here, and the
   * selector-failure fallback is silent here too.
   *
   * If a future scorer change starts answering part of this slice, this test
   * fails. That is the intended signal: raise the number, do not delete the
   * cases or move them to `no-result`.
   */
  it('records the deterministic path as silent on semantic-only queries', () => {
    const summary = evaluate(
      loadFixture(),
      selectRelevantAutoMemoryDocuments,
      isSemanticNoLexical,
    );

    expect(summary.recallCases).toBeGreaterThanOrEqual(3);
    expect(summary.recallAt5).toBe(0);
    expect(summary.maxSelectedDocs).toBe(0);
  });

  it('does not regress English Recall@5 against the pre-change scorer', () => {
    const fixture = loadFixture();
    const before = evaluate(
      fixture,
      baselineSelectRelevantAutoMemoryDocuments,
      isEnglish,
    );
    const after = evaluate(
      fixture,
      selectRelevantAutoMemoryDocuments,
      isEnglish,
    );

    expect(before.recallCases).toBeGreaterThan(0);
    expect(after.recallAt5!).toBeGreaterThanOrEqual(before.recallAt5!);
    expect(after.top1Accuracy!).toBeGreaterThanOrEqual(before.top1Accuracy!);
  });

  it('does not regress no-result handling against the pre-change scorer', () => {
    const fixture = loadFixture();
    const before = evaluate(fixture, baselineSelectRelevantAutoMemoryDocuments);
    const after = evaluate(fixture, selectRelevantAutoMemoryDocuments);

    // Measured over the whole corpus. Restricting to the no-result cases
    // would make precision 100% for any scorer that ever stays silent.
    expect(before.labeledNoResultCases).toBeGreaterThan(0);
    expect(after.noResultRecall!).toBeGreaterThanOrEqual(
      before.noResultRecall!,
    );
    expect(after.noResultPrecision!).toBeGreaterThanOrEqual(
      before.noResultPrecision!,
    );
  });

  it('reports the before/after rollout-gate table', () => {
    const fixture = loadFixture();
    const rows = [
      ['overall', () => true],
      ['english', isEnglish],
      ['cjk', isCjk],
      ['mixed', isMixed],
      ['other-script', isOtherScript],
      ['semantic-no-lexical', isSemanticNoLexical],
    ] as const;

    const lines = [
      '',
      'RFC #7040 rollout gate — deterministic recall path',
      '',
      '| slice | metric | before | after |',
      '| --- | --- | --- | --- |',
    ];

    const randomFloor = randomBaselineRecallAt5(fixture.docs.length);
    lines.splice(
      2,
      0,
      `corpus: ${fixture.docs.length} documents, ${fixture.cases.length} cases — a query-blind random scorer returning ${RECALL_AT} documents scores ${formatPercent(randomFloor)} Recall@5 on this pool`,
      '',
    );

    for (const [label, filter] of rows) {
      const before = evaluate(
        fixture,
        baselineSelectRelevantAutoMemoryDocuments,
        filter,
      );
      const after = evaluate(
        fixture,
        selectRelevantAutoMemoryDocuments,
        filter,
      );
      const metrics: Array<[string, number | null, number | null]> = [
        ['Recall@5', before.recallAt5, after.recallAt5],
        ['top-1 accuracy', before.top1Accuracy, after.top1Accuracy],
        [
          'no-result precision',
          before.noResultPrecision,
          after.noResultPrecision,
        ],
        ['no-result recall', before.noResultRecall, after.noResultRecall],
      ];
      for (const [metric, beforeValue, afterValue] of metrics) {
        lines.push(
          `| ${label} (n=${before.cases}) | ${metric} | ${formatPercent(beforeValue)} | ${formatPercent(afterValue)} |`,
        );
      }
    }

    console.log(lines.join('\n'));
    expect(lines.length).toBeGreaterThan(5);
  });

  /**
   * Guards the headline against a corpus so small that Recall@5 is nearly
   * free. This is a property of the fixture, not of the scorer: shrink the
   * corpus far enough and every metric approaches 100% for any design.
   */
  it('keeps the corpus large enough for Recall@5 to discriminate', () => {
    const fixture = loadFixture();
    const randomFloor = randomBaselineRecallAt5(fixture.docs.length);

    expect(randomFloor).toBeLessThanOrEqual(0.25);
    const after = evaluate(
      fixture,
      selectRelevantAutoMemoryDocuments,
      (testCase) => !isSemanticNoLexical(testCase),
    );
    expect(after.recallAt5!).toBeGreaterThan(randomFloor * 3);
  });

  it('produces deterministic summaries', () => {
    const fixture = loadFixture();
    expect(evaluate(fixture, selectRelevantAutoMemoryDocuments)).toEqual(
      evaluate(fixture, selectRelevantAutoMemoryDocuments),
    );
  });
});
