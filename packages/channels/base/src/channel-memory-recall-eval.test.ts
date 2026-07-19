import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_MEMORY_RECALL_MAX_CODE_POINTS,
  CHANNEL_MEMORY_RECALL_MAX_ENTRIES,
  selectRelevantChannelMemory,
} from './channel-memory-recall.js';

const fixtureUrl = new URL(
  './__fixtures__/channel-memory-recall-eval.json',
  import.meta.url,
);

const categories = new Set([
  'english',
  'chinese',
  'japanese',
  'korean',
  'mixed',
  'fallback',
  'no-result',
  'ranking',
  'budget',
] as const);

type EvalCategory =
  | 'english'
  | 'chinese'
  | 'japanese'
  | 'korean'
  | 'mixed'
  | 'fallback'
  | 'no-result'
  | 'ranking'
  | 'budget';

interface EvalEntry {
  id: string;
  text: string;
}

interface EvalCase {
  id: string;
  category: EvalCategory;
  message: string;
  entries: EvalEntry[];
  relevantIds: string[];
  expectedTopId?: string;
  expectedSelectedIds?: string[];
}

interface EvalSummary {
  cases: number;
  recallAt3: number;
  top1Accuracy: number;
  noResultPrecision: number;
  maxSelectedEntries: number;
  maxSelectedCodePoints: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new Error(`${field} must be a string array`);
  }
  return value;
}

function parseEntry(value: unknown, caseId: string): EvalEntry {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['text'] !== 'string'
  ) {
    throw new Error(`${caseId}.entries contains an invalid entry`);
  }
  return { id: value['id'], text: value['text'] };
}

function parseCase(value: unknown): EvalCase {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['category'] !== 'string' ||
    !categories.has(value['category'] as EvalCategory) ||
    typeof value['message'] !== 'string' ||
    !Array.isArray(value['entries'])
  ) {
    throw new Error('invalid channel-memory recall evaluation case');
  }
  const result: EvalCase = {
    id: value['id'],
    category: value['category'] as EvalCategory,
    message: value['message'],
    entries: value['entries'].map((entry) =>
      parseEntry(entry, value['id'] as string),
    ),
    relevantIds: parseStringArray(
      value['relevantIds'],
      `${value['id']}.relevantIds`,
    ),
  };
  if (typeof value['expectedTopId'] === 'string') {
    result.expectedTopId = value['expectedTopId'];
  } else if (value['expectedTopId'] !== undefined) {
    throw new Error(`${value['id']}.expectedTopId must be a string`);
  }
  if (value['expectedSelectedIds'] !== undefined) {
    result.expectedSelectedIds = parseStringArray(
      value['expectedSelectedIds'],
      `${value['id']}.expectedSelectedIds`,
    );
  }
  return result;
}

function loadCases(): EvalCase[] {
  const parsed: unknown = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
  if (!Array.isArray(parsed))
    throw new Error('evaluation fixture must be an array');
  return parsed.map(parseCase);
}

function evaluate(cases: readonly EvalCase[]): {
  summary: EvalSummary;
  selectedIdsByCase: Record<string, string[]>;
} {
  let recallTotal = 0;
  let recallCases = 0;
  let top1Hits = 0;
  let top1Cases = 0;
  let noResultHits = 0;
  let noResultCases = 0;
  let maxSelectedEntries = 0;
  let maxSelectedCodePoints = 0;
  const selectedIdsByCase: Record<string, string[]> = {};

  for (const testCase of cases) {
    const selected = selectRelevantChannelMemory(
      testCase.message,
      testCase.entries,
    );
    const selectedIds = selected.map((entry) => entry.id);
    selectedIdsByCase[testCase.id] = selectedIds;
    maxSelectedEntries = Math.max(maxSelectedEntries, selected.length);
    maxSelectedCodePoints = Math.max(
      maxSelectedCodePoints,
      selected.reduce((sum, entry) => sum + Array.from(entry.text).length, 0),
    );

    if (testCase.relevantIds.length > 0) {
      const hits = testCase.relevantIds.filter((id) =>
        selectedIds.includes(id),
      ).length;
      recallTotal += hits / testCase.relevantIds.length;
      recallCases += 1;
    }
    if (testCase.expectedTopId) {
      top1Hits += selectedIds[0] === testCase.expectedTopId ? 1 : 0;
      top1Cases += 1;
    }
    if (
      testCase.category === 'no-result' ||
      testCase.expectedSelectedIds?.length === 0
    ) {
      noResultHits += selected.length === 0 ? 1 : 0;
      noResultCases += 1;
    }
  }

  return {
    summary: {
      cases: cases.length,
      recallAt3: recallCases === 0 ? 0 : recallTotal / recallCases,
      top1Accuracy: top1Cases === 0 ? 0 : top1Hits / top1Cases,
      noResultPrecision: noResultCases === 0 ? 0 : noResultHits / noResultCases,
      maxSelectedEntries,
      maxSelectedCodePoints,
    },
    selectedIdsByCase,
  };
}

const requiredCaseIds = [
  'en-deploy-staging',
  'en-incident-runbook',
  'en-nfkc-case',
  'en-repeated-token',
  'en-number-42',
  'en-stable-tie',
  'zh-data-governance',
  'zh-release-window',
  'zh-role-preference',
  'zh-project-alias',
  'zh-incident-owner',
  'zh-longer-run',
  'zh-nfkc',
  'zh-single-character-no-result',
  'ja-hiragana',
  'ja-katakana',
  'ja-prolonged-mark',
  'ja-mixed-script',
  'ko-data-quality',
  'ko-release-owner',
  'ko-incident-runbook',
  'ko-mixed-number',
  'mixed-zh-en',
  'mixed-ja-en',
  'mixed-ko-en',
  'mixed-nfkc-number',
  'fallback-single',
  'fallback-order',
  'fallback-after-positive',
  'none-long-unrelated',
  'none-single-cjk',
  'none-short-latin',
  'none-unsafe-separators',
  'ranking-overlap-count',
  'ranking-document-order',
  'budget-skip-middle',
] as const;

const expectedCategoryCounts: Record<EvalCategory, number> = {
  english: 6,
  chinese: 8,
  japanese: 4,
  korean: 4,
  mixed: 4,
  fallback: 3,
  'no-result': 4,
  ranking: 2,
  budget: 1,
};

const requiredSelectedIds = {
  'fallback-order': ['first', 'second', 'third'],
  'fallback-after-positive': ['positive', 'first-fallback', 'second-fallback'],
  'budget-skip-middle': ['first', 'later-fit'],
  'none-long-unrelated': [],
  'none-single-cjk': [],
  'none-short-latin': [],
  'none-unsafe-separators': [],
  'zh-single-character-no-result': [],
} as const;

describe('channel memory recall evaluation', () => {
  it('loads the complete synthetic multilingual fixture', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(36);
    expect(new Set(cases.map((testCase) => testCase.id)).size).toBe(
      cases.length,
    );
    expect(cases.map((testCase) => testCase.id).sort()).toEqual(
      [...requiredCaseIds].sort(),
    );
    const categoryCounts = cases.reduce<Record<EvalCategory, number>>(
      (counts, testCase) => {
        counts[testCase.category] += 1;
        return counts;
      },
      {
        english: 0,
        chinese: 0,
        japanese: 0,
        korean: 0,
        mixed: 0,
        fallback: 0,
        'no-result': 0,
        ranking: 0,
        budget: 0,
      },
    );
    expect(categoryCounts).toEqual(expectedCategoryCounts);
    expect(new Set(cases.map((testCase) => testCase.category))).toEqual(
      categories,
    );
  });

  it('holds the multilingual quality floor', () => {
    const { summary } = evaluate(loadCases());
    expect(summary.cases).toBe(36);
    expect(summary.recallAt3).toBeGreaterThanOrEqual(0.9);
    expect(summary.top1Accuracy).toBeGreaterThanOrEqual(0.85);
    expect(summary.noResultPrecision).toBe(1);
  });

  it('keeps every evaluation result within the existing prompt budgets', () => {
    const { summary } = evaluate(loadCases());
    expect(summary.maxSelectedEntries).toBeLessThanOrEqual(
      CHANNEL_MEMORY_RECALL_MAX_ENTRIES,
    );
    expect(summary.maxSelectedCodePoints).toBeLessThanOrEqual(
      CHANNEL_MEMORY_RECALL_MAX_CODE_POINTS,
    );
  });

  it('asserts the required ordered selected IDs', () => {
    const cases = loadCases();
    const { selectedIdsByCase } = evaluate(cases);

    for (const [caseId, expectedSelectedIds] of Object.entries(
      requiredSelectedIds,
    )) {
      const testCase = cases.find((candidate) => candidate.id === caseId);
      expect(testCase?.expectedSelectedIds).toEqual(expectedSelectedIds);
      expect(selectedIdsByCase[caseId]).toEqual(expectedSelectedIds);
    }
  });

  it('produces deterministic selected IDs and summary values', () => {
    const cases = loadCases();
    expect(evaluate(cases)).toEqual(evaluate(cases));
  });
});
