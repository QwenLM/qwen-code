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

const RECALL_AT = 3;
const MAX_SELECTED_CODE_POINTS = 1_200;

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
  recallCases: number;
  recallAt3: number;
  top1Cases: number;
  top1Accuracy: number;
  labeledNoResultCases: number;
  noResultPrecision: number;
  maxSelectedEntries: number;
  maxSelectedCodePoints: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowedFields: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedFields.includes(key)) {
      throw new Error(`${field} contains an unknown field: ${key}`);
    }
  }
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be a string array`);
  }
  const ids = value.map((item, index) =>
    parseNonEmptyString(item, `${field}[${index}]`),
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${field} must contain unique IDs`);
  }
  return ids;
}

function assertReferencesBelongToEntries(
  references: readonly string[],
  entryIds: ReadonlySet<string>,
  field: string,
): void {
  for (const id of references) {
    if (!entryIds.has(id)) {
      throw new Error(`${field} references an unknown entry ID: ${id}`);
    }
  }
}

function parseEntry(value: unknown, caseId: string): EvalEntry {
  if (!isRecord(value)) {
    throw new Error(`${caseId}.entries contains an invalid entry`);
  }
  assertKnownFields(value, ['id', 'text'], `${caseId}.entries`);
  return {
    id: parseNonEmptyString(value['id'], `${caseId}.entries.id`),
    text: parseNonEmptyString(value['text'], `${caseId}.entries.text`),
  };
}

function parseCase(value: unknown): EvalCase {
  if (!isRecord(value)) {
    throw new Error('invalid channel-memory recall evaluation case');
  }
  assertKnownFields(
    value,
    [
      'id',
      'category',
      'message',
      'entries',
      'relevantIds',
      'expectedTopId',
      'expectedSelectedIds',
    ],
    'evaluation case',
  );
  const id = parseNonEmptyString(value['id'], 'case.id');
  if (
    typeof value['category'] !== 'string' ||
    !categories.has(value['category'] as EvalCategory)
  ) {
    throw new Error(`${id}.category must be a known category`);
  }
  if (!Array.isArray(value['entries'])) {
    throw new Error(`${id}.entries must be an array`);
  }
  const entries = value['entries'].map((entry) => parseEntry(entry, id));
  const entryIds = new Set(entries.map((entry) => entry.id));
  if (entryIds.size !== entries.length) {
    throw new Error(`${id}.entries must contain unique IDs`);
  }
  const relevantIds = parseStringArray(
    value['relevantIds'],
    `${id}.relevantIds`,
  );
  assertReferencesBelongToEntries(relevantIds, entryIds, `${id}.relevantIds`);
  const expectedSelectedIds =
    value['expectedSelectedIds'] === undefined
      ? undefined
      : parseStringArray(
          value['expectedSelectedIds'],
          `${id}.expectedSelectedIds`,
        );
  if (expectedSelectedIds) {
    assertReferencesBelongToEntries(
      expectedSelectedIds,
      entryIds,
      `${id}.expectedSelectedIds`,
    );
  }
  const expectedTopId =
    value['expectedTopId'] === undefined
      ? undefined
      : parseNonEmptyString(value['expectedTopId'], `${id}.expectedTopId`);
  if (relevantIds.length === 0) {
    if (expectedTopId !== undefined) {
      throw new Error(`${id}.expectedTopId is not allowed for no-result cases`);
    }
  } else {
    if (expectedTopId === undefined) {
      throw new Error(`${id}.expectedTopId is required for positive cases`);
    }
    if (!relevantIds.includes(expectedTopId)) {
      throw new Error(`${id}.expectedTopId must be a relevant ID`);
    }
  }
  return {
    id,
    category: value['category'] as EvalCategory,
    message: parseNonEmptyString(value['message'], `${id}.message`),
    entries,
    relevantIds,
    expectedTopId,
    expectedSelectedIds,
  };
}

function loadCases(): EvalCase[] {
  const parsed: unknown = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
  if (!Array.isArray(parsed))
    throw new Error('evaluation fixture must be an array');
  const cases = parsed.map(parseCase);
  if (new Set(cases.map((testCase) => testCase.id)).size !== cases.length) {
    throw new Error('evaluation fixture must contain unique case IDs');
  }
  return cases;
}

function evaluate(cases: readonly EvalCase[]): {
  summary: EvalSummary;
  selectedIdsByCase: Record<string, string[]>;
} {
  let recallTotal = 0;
  let recallCases = 0;
  let top1Hits = 0;
  let top1Cases = 0;
  let correctNoResultPredictions = 0;
  let noResultPredictions = 0;
  let labeledNoResultCases = 0;
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
        selectedIds.slice(0, RECALL_AT).includes(id),
      ).length;
      recallTotal += hits / testCase.relevantIds.length;
      recallCases += 1;
    }
    if (testCase.expectedTopId) {
      top1Hits += selectedIds[0] === testCase.expectedTopId ? 1 : 0;
      top1Cases += 1;
    }
    if (testCase.relevantIds.length === 0) {
      labeledNoResultCases += 1;
    }
    if (selected.length === 0) {
      noResultPredictions += 1;
      correctNoResultPredictions += testCase.relevantIds.length === 0 ? 1 : 0;
    }
  }

  return {
    summary: {
      cases: cases.length,
      recallCases,
      recallAt3: recallCases === 0 ? 0 : recallTotal / recallCases,
      top1Cases,
      top1Accuracy: top1Cases === 0 ? 0 : top1Hits / top1Cases,
      labeledNoResultCases,
      noResultPrecision:
        noResultPredictions === 0
          ? 0
          : correctNoResultPredictions / noResultPredictions,
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
  'fallback-single': ['short-fact'],
  'fallback-order': ['first', 'second', 'third'],
  'fallback-after-positive': ['positive', 'first-fallback', 'second-fallback'],
  'en-stable-tie': ['first-tie', 'second-tie'],
  'budget-skip-middle': ['first', 'later-fit'],
  'none-long-unrelated': [],
  'none-single-cjk': [],
  'none-short-latin': [],
  'none-unsafe-separators': [],
  'zh-single-character-no-result': [],
  'ranking-overlap-count': ['two-terms-first', 'two-terms-second', 'one-term'],
  'ranking-document-order': ['first', 'second'],
} as const;

describe('channel memory recall evaluation', () => {
  it('counts empty selections on positive cases against no-result precision', () => {
    const cases: EvalCase[] = [
      {
        id: 'correct-no-result',
        category: 'no-result',
        message: 'probetoken',
        entries: [
          {
            id: 'unrelated',
            text: 'This entry contains deliberately distinct vocabulary and enough content to avoid fallback selection. zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
          },
        ],
        relevantIds: [],
      },
      {
        id: 'false-no-result',
        category: 'english',
        message: 'probetoken',
        entries: [
          {
            id: 'relevant',
            text: 'This relevant entry contains deliberately distinct vocabulary and enough content to avoid fallback selection. zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
          },
        ],
        relevantIds: ['relevant'],
        expectedTopId: 'relevant',
      },
    ];

    expect(evaluate(cases).summary.noResultPrecision).toBe(0.5);
  });

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
    expect(summary.recallCases).toBe(31);
    expect(summary.top1Cases).toBe(31);
    expect(summary.labeledNoResultCases).toBe(5);
    expect(summary.recallAt3).toBeGreaterThanOrEqual(0.9);
    expect(summary.top1Accuracy).toBeGreaterThanOrEqual(0.85);
    expect(summary.noResultPrecision).toBe(1);
  });

  it('keeps every evaluation result within the existing prompt budgets', () => {
    const { summary } = evaluate(loadCases());
    expect(CHANNEL_MEMORY_RECALL_MAX_ENTRIES).toBe(RECALL_AT);
    expect(CHANNEL_MEMORY_RECALL_MAX_CODE_POINTS).toBe(
      MAX_SELECTED_CODE_POINTS,
    );
    expect(summary.maxSelectedEntries).toBeLessThanOrEqual(RECALL_AT);
    expect(summary.maxSelectedCodePoints).toBeLessThanOrEqual(
      MAX_SELECTED_CODE_POINTS,
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
