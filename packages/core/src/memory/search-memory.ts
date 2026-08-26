/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AUTO_MEMORY_TREE_CATEGORIES,
  AUTO_MEMORY_UNCATEGORIZED,
  type AutoMemoryScope,
  type AutoMemoryTreeCategoryKey,
} from './types.js';
import {
  normalizeAutoMemoryKeyword,
  rereadAutoMemoryDocument,
  sanitizeAutoMemoryPromptField,
  scanAutoMemorySnapshot,
  type AutoMemoryScanSnapshot,
  type MemorySourceStatus,
  type ScannedAutoMemoryDocument,
} from './scan.js';
import { buildAutoMemoryTree, type AutoMemoryTreeLeaf } from './tree.js';

const SEARCH_BODY_WINDOW_CHARS = 1_200;
const SEARCH_BODY_CONTEXT_BEFORE_CHARS = 300;
const SEARCH_DIVERSITY_BONUS_PER_KEYWORD = 2;
const SEARCH_DIVERSITY_BONUS_CAP = 4;
const FETCH_BODY_WINDOW_CHARS = 8_000;
const FETCH_TOTAL_BODY_CHARS = 20_000;
const SEARCH_TOTAL_BODY_CHARS = 6_000;
const MAX_FETCH_REFS = 5;
const MAX_SEARCH_RESULTS = 5;
const MAX_EXPLORE_BRANCHES = 3;
const MAX_EXPLORE_LEAVES = 20;
const CURSOR_HMAC_KEY = randomBytes(32);
const SEARCH_MATCH_WEIGHT = {
  titleExact: 12,
  keywordExact: 10,
  titleContains: 8,
  keywordContains: 6,
  metadata: 4,
  body: 1,
} as const;

const SCOPE_ORDER: readonly AutoMemoryScope[] = ['project', 'user', 'team'];
const CATEGORY_KEYS = new Set<string>([
  ...AUTO_MEMORY_TREE_CATEGORIES,
  AUTO_MEMORY_UNCATEGORIZED,
]);
const SCOPE_KEYS = new Set<string>(['project', 'user', 'team']);

type MemoryCursor = {
  kind: 'memory';
  ref: string;
  mtimeMs: number;
  offset: number;
  depth?: number;
};

type BranchCursor = {
  kind: 'branch';
  category: AutoMemoryTreeCategoryKey;
  scopes: AutoMemoryScope[];
  offset: number;
};

type SearchMemoryCursor = MemoryCursor | BranchCursor;

type SignedSearchMemoryCursor = SearchMemoryCursor & {
  mac: string;
};

export type SearchMemoryToolParams =
  | { mode: 'fetch'; refs: string[]; cursor?: string }
  | {
      mode: 'search';
      keywords: string[];
      scopes?: AutoMemoryScope[];
      categories?: AutoMemoryTreeCategoryKey[];
      limit?: number;
    }
  | {
      mode: 'explore';
      scopes?: AutoMemoryScope[];
      branches?: Array<{
        category: AutoMemoryTreeCategoryKey;
        cursor?: string;
      }>;
      limitPerBranch?: number;
    };

interface MemoryBodyResult {
  ref: string;
  version: number;
  content?: string;
  alreadyAvailable?: true;
  truncated?: boolean;
  range?: {
    start: number;
    end: number;
    total: number;
  };
  previousCursor?: string;
  nextCursor?: string;
  continuation?: {
    mode: 'fetch';
    refs: [string];
    cursor: string;
  };
  readLimitExhausted?: boolean;
  readLimitMessage?: string;
}

interface MemorySearchResult extends MemoryBodyResult {
  title: string;
  matches: MemorySearchMatch[];
}

interface MemorySearchMatch {
  keyword: string;
  source: 'title' | 'keyword' | 'description' | 'usage_scenario' | 'body';
  kind: 'exact' | 'contains';
}

export type SearchMemoryToolResult =
  | {
      mode: 'fetch';
      sourceStatus: MemorySourceStatus;
      results: MemoryBodyResult[];
      warnings?: string[];
      missingRefs?: string[];
    }
  | {
      mode: 'search';
      sourceStatus: MemorySourceStatus;
      results: MemorySearchResult[];
      warnings?: string[];
    }
  | {
      mode: 'explore';
      sourceStatus: MemorySourceStatus;
      router?: Array<{
        category: AutoMemoryTreeCategoryKey;
        total: number;
        keywords: string[];
        hiddenKeywordCount: number;
      }>;
      branches: Array<{
        category: AutoMemoryTreeCategoryKey;
        total: number;
        leaves: AutoMemoryTreeLeaf[];
        nextCursor?: string;
      }>;
    };

export interface ExecuteSearchMemoryOptions {
  projectRoot: string;
  teamMemoryEnabled?: boolean;
  trustedProject?: boolean;
  bodyPresentVersions?: Map<string, number>;
  bodyCoverage?: Map<string, MemoryBodyCoverage>;
  exhaustedBodyRefs?: Set<string>;
  snapshot?: AutoMemoryScanSnapshot;
  onComplete?: (observation: {
    mode: SearchMemoryToolParams['mode'];
    docsScanned: number;
    resultsReturned: number;
    durationMs: number;
  }) => void;
}

export interface MemoryBodyCoverage {
  version: number;
  total: number;
  ranges: Array<{ start: number; end: number }>;
}

function normalizeSearchText(value: string): string {
  return normalizeAutoMemoryKeyword(value).toLocaleLowerCase('en-US');
}

function normalizedOffsetToSourceOffset(
  source: string,
  normalizedOffset: number,
): number {
  if (normalizedOffset <= 0) return 0;

  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (
      normalizeSearchText(source.slice(0, middle)).length < normalizedOffset
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function memoryRef(doc: ScannedAutoMemoryDocument): string {
  return `${doc.scope}:${sanitizeAutoMemoryPromptField(doc.relativePath, 512)}`;
}

function encodeCursor(cursor: SearchMemoryCursor): string {
  return Buffer.from(
    JSON.stringify({
      ...cursor,
      mac: signCursor(cursor),
    }),
    'utf-8',
  ).toString('base64url');
}

function decodeCursor(cursor: string): SearchMemoryCursor {
  try {
    const signed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf-8'),
    ) as SignedSearchMemoryCursor;
    const { mac: _mac, ...parsed } = signed;
    if (
      typeof signed.mac !== 'string' ||
      !hasValidCursorMac(parsed as SearchMemoryCursor, signed.mac)
    ) {
      throw new Error('Invalid cursor.');
    }
    if (
      (parsed.kind === 'memory' &&
        typeof parsed.ref === 'string' &&
        typeof parsed.mtimeMs === 'number' &&
        Number.isInteger(parsed.offset) &&
        parsed.offset >= 0) ||
      (parsed.kind === 'branch' &&
        typeof parsed.category === 'string' &&
        CATEGORY_KEYS.has(parsed.category) &&
        Array.isArray(parsed.scopes) &&
        parsed.scopes.every((scope) => SCOPE_KEYS.has(scope)) &&
        Number.isInteger(parsed.offset) &&
        parsed.offset >= 0)
    ) {
      return parsed;
    }
  } catch {
    // Fall through to the shared validation error below.
  }
  throw new Error('Invalid cursor.');
}

function signCursor(cursor: SearchMemoryCursor): string {
  return createHmac('sha256', CURSOR_HMAC_KEY)
    .update(JSON.stringify(cursor))
    .digest('base64url');
}

function hasValidCursorMac(cursor: SearchMemoryCursor, mac: string): boolean {
  const expected = Buffer.from(signCursor(cursor), 'utf8');
  const actual = Buffer.from(mac, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseMemoryCursor(
  cursor: string | undefined,
  ref: string,
  mtimeMs: number,
): { offset: number; depth: number } {
  if (!cursor) return { offset: 0, depth: 0 };
  const parsed = decodeCursor(cursor);
  if (parsed.kind !== 'memory' || parsed.ref !== ref) {
    throw new Error('Invalid cursor.');
  }
  if (parsed.mtimeMs !== mtimeMs) {
    throw new Error('Memory changed since cursor was issued.');
  }
  return { offset: parsed.offset, depth: parsed.depth ?? 0 };
}

function parseBranchCursor(
  cursor: string | undefined,
  category: AutoMemoryTreeCategoryKey,
  scopes: readonly AutoMemoryScope[],
): number {
  if (!cursor) return 0;
  const parsed = decodeCursor(cursor);
  if (
    parsed.kind !== 'branch' ||
    parsed.category !== category ||
    parsed.scopes.join('\0') !== scopes.join('\0')
  ) {
    throw new Error('Invalid cursor.');
  }
  return parsed.offset;
}

function makeMemoryCursor(
  ref: string,
  mtimeMs: number,
  offset: number | undefined,
  depth: number,
): string | undefined {
  return offset === undefined
    ? undefined
    : encodeCursor({ kind: 'memory', ref, mtimeMs, offset, depth });
}

function makeBranchCursor(
  category: AutoMemoryTreeCategoryKey,
  scopes: readonly AutoMemoryScope[],
  offset: number | undefined,
): string | undefined {
  return offset === undefined
    ? undefined
    : encodeCursor({ kind: 'branch', category, scopes: [...scopes], offset });
}

function bodyWindow(
  body: string,
  ref: string,
  mtimeMs: number,
  cursor: string | undefined,
  preferredOffset = 0,
  maxChars = FETCH_BODY_WINDOW_CHARS,
  maxTotalChars = FETCH_TOTAL_BODY_CHARS,
): Omit<MemoryBodyResult, 'ref' | 'version' | 'alreadyAvailable'> {
  const total = body.length;
  const readableTotal = Math.min(total, maxTotalChars);
  const parsedCursor = cursor
    ? parseMemoryCursor(cursor, ref, mtimeMs)
    : { offset: preferredOffset, depth: 0 };
  const requestedOffset = parsedCursor.offset;
  const start = Math.max(0, Math.min(requestedOffset, readableTotal));
  const end = Math.min(readableTotal, start + maxChars);
  const nextDepth = parsedCursor.depth + 1;
  const readLimitExhausted =
    maxChars > 0 && end >= readableTotal && readableTotal < total;
  const nextCursor =
    end < readableTotal
      ? makeMemoryCursor(ref, mtimeMs, end, nextDepth)
      : undefined;
  return {
    content: body.slice(start, end),
    truncated: end < total,
    range: { start, end, total },
    previousCursor:
      start > 0
        ? makeMemoryCursor(ref, mtimeMs, Math.max(0, start - maxChars), 1)
        : undefined,
    nextCursor,
    ...(nextCursor
      ? {
          continuation: {
            mode: 'fetch' as const,
            refs: [ref] as [string],
            cursor: nextCursor,
          },
        }
      : {}),
    ...(readLimitExhausted
      ? {
          readLimitExhausted: true,
          readLimitMessage:
            'The per-ref fetch budget is exhausted before the end of this memory. Use the returned content or report the bounded-read limit; do not fetch or search this same ref again to continue reading.',
        }
      : {}),
  };
}

function validateScope(scope: string): asserts scope is AutoMemoryScope {
  if (!SCOPE_KEYS.has(scope)) {
    throw new Error(`Invalid memory scope: ${scope}`);
  }
}

function validateCategory(
  category: string,
): asserts category is AutoMemoryTreeCategoryKey {
  if (!CATEGORY_KEYS.has(category)) {
    throw new Error(`Invalid memory category: ${category}`);
  }
}

function normalizeValidSearchKeyword(keyword: string): string | null {
  const normalized = normalizeSearchText(keyword);
  const cjkCount = [...normalized].filter((char) =>
    /\p{Script=Han}/u.test(char),
  ).length;
  const asciiCount = (normalized.match(/[a-z0-9]/g) ?? []).length;
  if (cjkCount < 2 && asciiCount < 3) {
    return null;
  }
  return normalized;
}

function normalizeSearchKeywords(keywords: readonly string[]): {
  keywords: string[];
  warnings: string[];
} {
  const normalized: string[] = [];
  const seen = new Set<string>();
  const ignored: string[] = [];
  for (const keyword of keywords) {
    if (normalized.length >= 5) {
      ignored.push(keyword);
      continue;
    }
    const valid = normalizeValidSearchKeyword(keyword);
    if (!valid) {
      ignored.push(keyword);
      continue;
    }
    if (!seen.has(valid)) {
      seen.add(valid);
      normalized.push(valid);
    }
  }
  if (normalized.length === 0) {
    throw new Error('search requires at least one valid keyword.');
  }
  return {
    keywords: normalized,
    warnings:
      ignored.length > 0
        ? [`Ignored invalid or excess search keywords: ${ignored.join(', ')}`]
        : [],
  };
}

async function getSnapshot(
  options: ExecuteSearchMemoryOptions,
  scopes?: readonly AutoMemoryScope[],
): Promise<AutoMemoryScanSnapshot> {
  if (options.snapshot) {
    if (scopes === undefined) return options.snapshot;
    const requested = [...new Set(scopes)];
    const requestedSet = new Set(requested);
    const sourceStatus = options.snapshot.sourceStatus;
    return {
      docs: options.snapshot.docs.filter((doc) => requestedSet.has(doc.scope)),
      sourceStatus: {
        requestedScopes: requested,
        searchedScopes: sourceStatus.searchedScopes.filter((scope) =>
          requestedSet.has(scope),
        ),
        unavailableScopes: sourceStatus.unavailableScopes.filter((item) =>
          requestedSet.has(item.scope),
        ),
        complete: sourceStatus.incompleteScopes.every(
          (item) => !requestedSet.has(item.scope),
        ),
        incompleteScopes: sourceStatus.incompleteScopes.filter((item) =>
          requestedSet.has(item.scope),
        ),
      },
    };
  }
  return scanAutoMemorySnapshot(options.projectRoot, {
    scopes,
    teamMemoryEnabled: options.teamMemoryEnabled,
    trustedProject: options.trustedProject,
  });
}

function scopeIndex(scope: AutoMemoryScope): number {
  const index = SCOPE_ORDER.indexOf(scope);
  return index === -1 ? SCOPE_ORDER.length : index;
}

function exactOrContains(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a);
}

interface SearchScore {
  total: number;
  coverageCount: number;
  coverageRatio: number;
  rarityBonus: number;
  matchedKeywords: string[];
  matches: MemorySearchMatch[];
  titleExact: number;
  keywordExact: number;
  titleContains: number;
  keywordContains: number;
  metadata: number;
  body: number;
}

function metadataMatchCount(score: SearchScore): number {
  return score.matches.filter((match) => match.source !== 'body').length;
}

function isQualifiedMetadataMatch(
  score: SearchScore,
  keywordCount: number,
): boolean {
  if (score.titleExact > 0 || score.keywordExact > 0) return true;
  return metadataMatchCount(score) >= Math.min(2, keywordCount);
}

function scoreSearchDoc(
  doc: ScannedAutoMemoryDocument,
  keywords: readonly string[],
): SearchScore | null {
  const title = normalizeSearchText(doc.title);
  const storedKeywords = doc.keywords.map(normalizeSearchText);
  const description = normalizeSearchText(doc.description);
  const usageScenarios = doc.usageScenarios.map(normalizeSearchText);
  const body = normalizeSearchText(doc.body.slice(0, FETCH_TOTAL_BODY_CHARS));
  const score: SearchScore = {
    total: 0,
    coverageCount: 0,
    coverageRatio: 0,
    rarityBonus: 0,
    matchedKeywords: [],
    matches: [],
    titleExact: 0,
    keywordExact: 0,
    titleContains: 0,
    keywordContains: 0,
    metadata: 0,
    body: 0,
  };
  const bodyHits = new Set<string>();

  for (const keyword of keywords) {
    let bestMatch: { weight: number; match: MemorySearchMatch } | undefined;
    const consider = (
      weight: number,
      source: MemorySearchMatch['source'],
      kind: MemorySearchMatch['kind'],
    ) => {
      if (!bestMatch || weight > bestMatch.weight) {
        bestMatch = { weight, match: { keyword, source, kind } };
      }
    };
    if (title === keyword) {
      score.titleExact += 1;
      consider(SEARCH_MATCH_WEIGHT.titleExact, 'title', 'exact');
    }
    if (storedKeywords.some((stored) => stored === keyword)) {
      score.keywordExact += 1;
      consider(SEARCH_MATCH_WEIGHT.keywordExact, 'keyword', 'exact');
    }
    if (title.includes(keyword)) {
      score.titleContains += 1;
      consider(SEARCH_MATCH_WEIGHT.titleContains, 'title', 'contains');
    }
    if (storedKeywords.some((stored) => exactOrContains(stored, keyword))) {
      score.keywordContains += 1;
      consider(SEARCH_MATCH_WEIGHT.keywordContains, 'keyword', 'contains');
    }
    if (description.includes(keyword)) {
      score.metadata += 1;
      consider(SEARCH_MATCH_WEIGHT.metadata, 'description', 'contains');
    } else if (usageScenarios.some((item) => item.includes(keyword))) {
      score.metadata += 1;
      consider(SEARCH_MATCH_WEIGHT.metadata, 'usage_scenario', 'contains');
    }
    if (body.includes(keyword)) {
      bodyHits.add(keyword);
      consider(SEARCH_MATCH_WEIGHT.body, 'body', 'contains');
    }
    if (bestMatch) {
      score.total += bestMatch.weight;
      if (keyword.includes(' ')) score.total += 2;
      if (isExactIdentifier(keyword)) score.total += 2;
      score.matchedKeywords.push(keyword);
      score.matches.push(bestMatch.match);
    }
  }

  score.body = bodyHits.size;
  score.coverageCount = score.matchedKeywords.length;
  score.coverageRatio = score.coverageCount / keywords.length;
  if (score.total === 0) return null;
  return score;
}

function isExactIdentifier(keyword: string): boolean {
  return /[._:/#()[\]{}-]|\d/.test(keyword) && !keyword.includes(' ');
}

function applyRarityBonus(
  candidates: Array<{ doc: ScannedAutoMemoryDocument; score: SearchScore }>,
): void {
  const documentFrequency = new Map<string, number>();
  for (const { score } of candidates) {
    for (const keyword of score.matchedKeywords) {
      documentFrequency.set(keyword, (documentFrequency.get(keyword) ?? 0) + 1);
    }
  }
  for (const { score } of candidates) {
    score.rarityBonus = score.matchedKeywords.filter(
      (keyword) => (documentFrequency.get(keyword) ?? 0) <= 2,
    ).length;
    score.total += Math.min(2, score.rarityBonus);
  }
}

function compareSearchResult(
  a: { doc: ScannedAutoMemoryDocument; score: SearchScore },
  b: { doc: ScannedAutoMemoryDocument; score: SearchScore },
): number {
  return (
    b.score.total - a.score.total ||
    b.score.coverageRatio - a.score.coverageRatio ||
    b.score.coverageCount - a.score.coverageCount ||
    b.score.titleExact - a.score.titleExact ||
    b.score.keywordExact - a.score.keywordExact ||
    b.score.titleContains - a.score.titleContains ||
    b.score.keywordContains - a.score.keywordContains ||
    b.score.metadata - a.score.metadata ||
    b.score.body - a.score.body ||
    scopeIndex(a.doc.scope) - scopeIndex(b.doc.scope) ||
    a.doc.relativePath.localeCompare(b.doc.relativePath)
  );
}

function selectSearchResults(
  candidates: Array<{ doc: ScannedAutoMemoryDocument; score: SearchScore }>,
  limit: number,
): Array<{ doc: ScannedAutoMemoryDocument; score: SearchScore }> {
  const remaining = [...candidates].sort(compareSearchResult);
  const selected: Array<{
    doc: ScannedAutoMemoryDocument;
    score: SearchScore;
  }> = [];
  const coveredKeywords = new Set<string>();

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestUtility = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const uncovered = candidate.score.matchedKeywords.filter(
        (keyword) => !coveredKeywords.has(keyword),
      ).length;
      const diversityBonus = Math.min(
        SEARCH_DIVERSITY_BONUS_CAP,
        uncovered * SEARCH_DIVERSITY_BONUS_PER_KEYWORD,
      );
      const utility = candidate.score.total + diversityBonus;
      if (utility > bestUtility) {
        bestIndex = index;
        bestUtility = utility;
      }
    }

    const [best] = remaining.splice(bestIndex, 1);
    if (!best) break;
    selected.push(best);
    for (const keyword of best.score.matchedKeywords) {
      coveredKeywords.add(keyword);
    }
  }

  return selected;
}

function selectBodyWindowOffset(
  body: string,
  keywords: readonly string[],
): number {
  const searchableBody = body.slice(0, FETCH_TOTAL_BODY_CHARS);
  const normalizedBody = normalizeSearchText(searchableBody);
  const hits: Array<{ keyword: string; index: number }> = [];
  for (const keyword of keywords) {
    let from = 0;
    while (from < normalizedBody.length) {
      const index = normalizedBody.indexOf(keyword, from);
      if (index < 0) break;
      hits.push({ keyword, index });
      from = index + Math.max(1, keyword.length);
    }
  }
  if (hits.length === 0) return 0;

  const starts = new Set(
    hits.map(({ index }) =>
      Math.max(0, index - SEARCH_BODY_CONTEXT_BEFORE_CHARS),
    ),
  );
  let bestStart = 0;
  let best:
    | {
        identifiers: number;
        coverage: number;
        longestPhrase: number;
        matchedChars: number;
      }
    | undefined;
  for (const start of starts) {
    const end = start + SEARCH_BODY_WINDOW_CHARS;
    const visible = hits.filter(
      ({ keyword, index }) => index < end && index + keyword.length > start,
    );
    const visibleKeywords = new Set(visible.map(({ keyword }) => keyword));
    const score = {
      identifiers: [...visibleKeywords].filter(isExactIdentifier).length,
      coverage: visibleKeywords.size,
      longestPhrase: Math.max(
        0,
        ...[...visibleKeywords].map((item) => item.length),
      ),
      matchedChars: [...visibleKeywords].reduce(
        (total, item) => total + item.length,
        0,
      ),
    };
    if (
      !best ||
      score.identifiers > best.identifiers ||
      (score.identifiers === best.identifiers &&
        (score.coverage > best.coverage ||
          (score.coverage === best.coverage &&
            (score.longestPhrase > best.longestPhrase ||
              (score.longestPhrase === best.longestPhrase &&
                score.matchedChars > best.matchedChars)))))
    ) {
      best = score;
      bestStart = start;
    }
  }
  return normalizedOffsetToSourceOffset(searchableBody, bestStart);
}

async function readContentResult(
  doc: ScannedAutoMemoryDocument,
  bodyPresentVersions: Map<string, number>,
  bodyCoverage: Map<string, MemoryBodyCoverage>,
  exhaustedBodyRefs: Set<string>,
  cursor?: string,
  preferredOffset = 0,
  maxChars = FETCH_BODY_WINDOW_CHARS,
  maxTotalChars = FETCH_TOTAL_BODY_CHARS,
): Promise<(MemoryBodyResult & { title: string }) | null> {
  const freshDoc = await rereadAutoMemoryDocument(doc);
  if (!freshDoc) return null;
  const ref = memoryRef(freshDoc);
  if (bodyPresentVersions.get(ref) === freshDoc.mtimeMs) {
    return {
      ref,
      version: freshDoc.mtimeMs,
      title: sanitizeAutoMemoryPromptField(freshDoc.title, 256),
      alreadyAvailable: true,
    };
  }
  const window = bodyWindow(
    freshDoc.body,
    ref,
    freshDoc.mtimeMs,
    cursor,
    preferredOffset,
    maxChars,
    maxTotalChars,
  );
  const previousCoverage = bodyCoverage.get(ref);
  if (
    window.range &&
    previousCoverage?.version === freshDoc.mtimeMs &&
    previousCoverage.total === window.range.total &&
    isRangeCovered(previousCoverage.ranges, window.range)
  ) {
    return {
      ref,
      version: freshDoc.mtimeMs,
      title: sanitizeAutoMemoryPromptField(freshDoc.title, 256),
      alreadyAvailable: true,
      truncated: window.truncated,
      range: window.range,
      previousCursor: window.previousCursor,
      nextCursor: window.nextCursor,
      continuation: window.continuation,
    };
  }
  if (window.truncated && !window.nextCursor) {
    exhaustedBodyRefs.add(ref);
  }
  if (window.content && window.range) {
    const previous = bodyCoverage.get(ref);
    const coverage =
      previous?.version === freshDoc.mtimeMs &&
      previous.total === window.range.total
        ? previous
        : {
            version: freshDoc.mtimeMs,
            total: window.range.total,
            ranges: [],
          };
    coverage.ranges.push({
      start: window.range.start,
      end: window.range.end,
    });
    coverage.ranges.sort((a, b) => a.start - b.start);
    bodyCoverage.set(ref, coverage);
    let coveredUntil = 0;
    for (const range of coverage.ranges) {
      if (range.start > coveredUntil) break;
      coveredUntil = Math.max(coveredUntil, range.end);
    }
    if (coveredUntil >= coverage.total) {
      bodyPresentVersions.set(ref, freshDoc.mtimeMs);
    }
  }
  return {
    ref,
    version: freshDoc.mtimeMs,
    title: sanitizeAutoMemoryPromptField(freshDoc.title, 256),
    ...window,
  };
}

function isRangeCovered(
  ranges: ReadonlyArray<{ start: number; end: number }>,
  target: { start: number; end: number },
): boolean {
  let coveredUntil = target.start;
  for (const range of ranges) {
    if (range.end <= coveredUntil) continue;
    if (range.start > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, range.end);
    if (coveredUntil >= target.end) return true;
  }
  return false;
}

function suggestMemoryRef(
  missingRef: string,
  availableRefs: readonly string[],
): string | undefined {
  const matches = availableRefs.filter(
    (candidate) =>
      candidate.endsWith(`:${missingRef}`) ||
      candidate.endsWith(`/${missingRef}`),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function scopesFromRefs(refs: readonly string[]): AutoMemoryScope[] {
  const scopes: AutoMemoryScope[] = [];
  const seen = new Set<AutoMemoryScope>();
  for (const ref of refs) {
    const [scope] = ref.split(':', 1);
    if (!scope || !SCOPE_KEYS.has(scope)) continue;
    if (!seen.has(scope as AutoMemoryScope)) {
      seen.add(scope as AutoMemoryScope);
      scopes.push(scope as AutoMemoryScope);
    }
  }
  return scopes;
}

export async function executeSearchMemory(
  params: SearchMemoryToolParams,
  options: ExecuteSearchMemoryOptions,
): Promise<SearchMemoryToolResult> {
  const startedAt = Date.now();
  const bodyPresentVersions = options.bodyPresentVersions ?? new Map();
  const bodyCoverage = options.bodyCoverage ?? new Map();
  const exhaustedBodyRefs = options.exhaustedBodyRefs ?? new Set<string>();
  const complete = <T extends SearchMemoryToolResult>(
    result: T,
    docsScanned: number,
    resultsReturned: number,
  ): T => {
    options.onComplete?.({
      mode: params.mode,
      docsScanned,
      resultsReturned,
      durationMs: Date.now() - startedAt,
    });
    return result;
  };

  if (params.mode === 'fetch') {
    if (params.refs.length === 0 || params.refs.length > MAX_FETCH_REFS) {
      throw new Error('fetch requires 1-5 refs.');
    }
    if (params.cursor && params.refs.length !== 1) {
      throw new Error('fetch cursor requires exactly one ref.');
    }
    const refScopes = scopesFromRefs(params.refs);
    const hasUnscopedRef = params.refs.some((ref) => {
      const [scope] = ref.split(':', 1);
      return !scope || !SCOPE_KEYS.has(scope);
    });
    const snapshot = await getSnapshot(
      options,
      hasUnscopedRef ? undefined : refScopes,
    );
    const docsByRef = new Map(
      snapshot.docs.map((doc) => [memoryRef(doc), doc]),
    );
    const availableRefs = [...docsByRef.keys()];
    const seen = new Set<string>();
    const results: MemoryBodyResult[] = [];
    const missingRefs: string[] = [];
    const warnings: string[] = [];
    let remaining = FETCH_TOTAL_BODY_CHARS;
    for (const ref of params.refs) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      const doc = docsByRef.get(ref);
      if (!doc) {
        missingRefs.push(ref);
        const suggestion = suggestMemoryRef(ref, availableRefs);
        warnings.push(
          suggestion
            ? `Unknown ref ${JSON.stringify(ref)}. Did you mean ${JSON.stringify(suggestion)}? Copy refs exactly from the memory tree or a search result.`
            : `Unknown ref ${JSON.stringify(ref)}. Copy the complete ref exactly from the memory tree or a search result.`,
        );
        continue;
      }
      if (remaining <= 0) {
        warnings.push(
          `Skipped ${ref}: the aggregate fetch body budget is exhausted.`,
        );
        continue;
      }
      if (
        !params.cursor &&
        exhaustedBodyRefs.has(ref) &&
        !bodyPresentVersions.has(ref)
      ) {
        warnings.push(
          `Skipped ${ref}: the per-ref fetch budget is already exhausted for this turn.`,
        );
        continue;
      }
      const result = await readContentResult(
        doc,
        bodyPresentVersions,
        bodyCoverage,
        exhaustedBodyRefs,
        params.cursor,
        0,
        Math.min(FETCH_BODY_WINDOW_CHARS, remaining),
      );
      if (result) {
        const { title: _title, ...fetchResult } = result;
        remaining -= fetchResult.content?.length ?? 0;
        results.push(fetchResult);
      }
    }
    return complete(
      {
        mode: 'fetch',
        sourceStatus: snapshot.sourceStatus,
        results,
        ...(missingRefs.length > 0 ? { missingRefs } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      snapshot.docs.length,
      results.length,
    );
  }

  if (params.mode === 'search') {
    if (params.limit !== undefined && (params.limit < 1 || params.limit > 5)) {
      throw new Error('search limit must be between 1 and 5.');
    }
    if (params.keywords.length < 1) {
      throw new Error('search requires keywords.');
    }
    for (const scope of params.scopes ?? []) validateScope(scope);
    for (const category of params.categories ?? []) validateCategory(category);
    const { keywords, warnings } = normalizeSearchKeywords(params.keywords);
    const snapshot = await getSnapshot(options, params.scopes);
    const categories = params.categories
      ? new Set<AutoMemoryTreeCategoryKey>(params.categories)
      : undefined;
    const scored = snapshot.docs
      .filter((doc) => !categories || categories.has(doc.category))
      .filter((doc) => !exhaustedBodyRefs.has(memoryRef(doc)))
      .map((doc) => {
        const score = scoreSearchDoc(doc, keywords);
        return score ? { doc, score } : null;
      })
      .filter(
        (
          item,
        ): item is { doc: ScannedAutoMemoryDocument; score: SearchScore } =>
          item !== null,
      );
    applyRarityBonus(scored);
    const qualifiedMetadataCandidates = scored.filter(({ score }) =>
      isQualifiedMetadataMatch(score, keywords.length),
    );
    const candidates =
      qualifiedMetadataCandidates.length > 0
        ? qualifiedMetadataCandidates
        : scored.filter(
            ({ score }) => score.body >= Math.min(2, keywords.length),
          );
    const ranked = selectSearchResults(
      candidates,
      params.limit ?? MAX_SEARCH_RESULTS,
    );
    let remaining = SEARCH_TOTAL_BODY_CHARS;
    const results: MemorySearchResult[] = [];
    for (const item of ranked) {
      if (remaining <= 0) break;
      const preferredOffset = selectBodyWindowOffset(item.doc.body, keywords);
      const result = await readContentResult(
        item.doc,
        bodyPresentVersions,
        bodyCoverage,
        exhaustedBodyRefs,
        undefined,
        preferredOffset,
        Math.min(SEARCH_BODY_WINDOW_CHARS, remaining),
        FETCH_TOTAL_BODY_CHARS,
      );
      if (result) {
        remaining -= result.content?.length ?? 0;
        results.push({ ...result, matches: item.score.matches });
      }
    }
    return complete(
      {
        mode: 'search',
        sourceStatus: snapshot.sourceStatus,
        results,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      snapshot.docs.length,
      results.length,
    );
  }

  for (const scope of params.scopes ?? []) validateScope(scope);
  const limitPerBranch = params.limitPerBranch ?? MAX_EXPLORE_LEAVES;
  if (limitPerBranch < 1 || limitPerBranch > MAX_EXPLORE_LEAVES) {
    throw new Error('explore limitPerBranch must be between 1 and 20.');
  }
  if ((params.branches?.length ?? 0) > MAX_EXPLORE_BRANCHES) {
    throw new Error('explore accepts at most 3 branches.');
  }
  for (const branch of params.branches ?? []) validateCategory(branch.category);
  const snapshot = await getSnapshot(options, params.scopes);
  const cursorScopes = snapshot.sourceStatus.searchedScopes;
  if (!params.branches || params.branches.length === 0) {
    const tree = buildAutoMemoryTree(snapshot.docs);
    return complete(
      {
        mode: 'explore',
        sourceStatus: snapshot.sourceStatus,
        router: tree.categories.map((category) => ({
          category: category.category,
          total: category.total,
          keywords: category.keywords,
          hiddenKeywordCount: category.hiddenKeywordCount,
        })),
        branches: [],
      },
      snapshot.docs.length,
      tree.categories.length,
    );
  }

  const tree = buildAutoMemoryTree(snapshot.docs);
  const byCategory = new Map(
    tree.categories.map((category) => [category.category, category]),
  );
  const branches = params.branches.map((branch) => {
    const category = byCategory.get(branch.category);
    const start = parseBranchCursor(
      branch.cursor,
      branch.category,
      cursorScopes,
    );
    const leaves = category?.leaves.slice(start, start + limitPerBranch) ?? [];
    const next =
      category && start + limitPerBranch < category.leaves.length
        ? makeBranchCursor(
            branch.category,
            cursorScopes,
            start + limitPerBranch,
          )
        : undefined;
    return {
      category: branch.category,
      total: category?.total ?? 0,
      leaves,
      ...(next ? { nextCursor: next } : {}),
    };
  });
  return complete(
    {
      mode: 'explore',
      sourceStatus: snapshot.sourceStatus,
      branches,
    },
    snapshot.docs.length,
    branches.reduce((total, branch) => total + branch.leaves.length, 0),
  );
}
