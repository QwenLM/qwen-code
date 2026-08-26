/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  rereadAutoMemoryDocument,
  scanAllAutoMemoryTopicDocuments,
  scanAllUserAutoMemoryTopicDocuments,
  scanAutoMemorySnapshot,
  type MemorySourceStatus,
  type ScannedAutoMemoryDocument,
} from './scan.js';
import { selectRelevantAutoMemoryDocumentsByModel } from './relevanceSelector.js';
import { logMemoryRecall, MemoryRecallEvent } from '../telemetry/index.js';
import { memoryAge, memoryFreshnessText } from './memoryAge.js';
import {
  createAutoMemoryTreeSnapshot,
  renderAutoMemoryFocusedSubtree,
  toAutoMemoryRef,
  type AutoMemoryTreeSnapshot,
} from './tree.js';

const MAX_RELEVANT_DOCS = 5;
/**
 * Upper bound on the deterministic fast result. Deliberately far below
 * MAX_RELEVANT_DOCS: this path has no model judgement behind it, so it takes
 * only the highest-scoring documents and leaves the remaining prompt budget
 * to the model-selected result that follows.
 */
export const MAX_FAST_RECALL_DOCS = 2;
const MAX_DOC_BODY_CHARS = 1_200;
const MAX_HEURISTIC_QUERY_TOKENS = 64;
const MAX_MODEL_CANDIDATE_DOCS = 200;
const RECENT_MODEL_CANDIDATE_RESERVE = 20;
const debugLogger = createDebugLogger('AUTO_MEMORY_RECALL');

const ACTIVE_TOOL_USAGE_MEMORY_MARKERS = [
  'api docs',
  'api documentation',
  'failed call',
  'failed tool call',
  'failed tool-call',
  'field mapping',
  'field mappings',
  'guessed call',
  'guessed tool',
  'mcp tool',
  'parameter schema',
  'parameter schemas',
  'tool schema',
  'tool schemas',
  'tool usage',
  'usage reference',
];

const DURABLE_ACTIVE_TOOL_MEMORY_MARKERS = [
  'credential',
  'credentials',
  'escalation',
  'gotcha',
  'gotchas',
  'known issue',
  'known issues',
  'owner',
  'ownership',
  'warning',
  'warnings',
  'workaround',
  'workarounds',
];

const TYPE_KEYWORDS: Record<string, string[]> = {
  user: ['user', 'preference', 'preferences', 'background', 'role', 'terse'],
  feedback: ['feedback', 'rule', 'rules', 'avoid', 'style', 'summary'],
  project: ['project', 'goal', 'goals', 'incident', 'deadline', 'release'],
  reference: ['reference', 'dashboard', 'ticket', 'docs', 'doc', 'link'],
};

/**
 * Scripts tokenized as code-point bigrams because they are written without
 * word separators, so a whole run is one unsegmentable token.
 */
const CJK_CLASS =
  '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script_Extensions=Katakana}\\p{Script=Hangul}]';

/**
 * One token run: either a CJK run (bigram-tokenized below) or a run of at
 * least three non-CJK letters, marks, and digits (kept whole).
 *
 * The alphabetic alternative is `\p{L}`-based rather than `[a-z0-9]`, so
 * Cyrillic, Greek, Arabic, and accented Latin produce tokens instead of
 * silently producing none. It excludes CJK per character rather than relying
 * on alternation order: `\p{L}` also matches Han, so a plain class would let
 * a run starting in Latin swallow the CJK that follows it and turn
 * `abc漢字` into one token.
 *
 * Scripts written without spaces and outside the CJK set (Thai, Khmer, Lao)
 * still collapse into a single long token. That is no worse than the previous
 * behaviour of producing nothing, but it is not segmentation.
 */
const RECALL_TOKEN_RUN = new RegExp(
  `${CJK_CLASS}+|(?!${CJK_CLASS})[\\p{L}\\p{N}](?:(?!${CJK_CLASS})[\\p{L}\\p{M}\\p{N}]){2,}`,
  'gu',
);

/** Whether a matched run is CJK, and therefore bigram-tokenized. */
const CJK_RUN_START = new RegExp(`^${CJK_CLASS}`, 'u');

function normalizeRecallText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

function tokenize(text: string): string[] {
  const normalized = normalizeRecallText(text);
  const edgeSize = MAX_HEURISTIC_QUERY_TOKENS / 2;
  const headTokens = new Set<string>();
  const tailTokens = new Set<string>();
  const addToken = (token: string) => {
    if (headTokens.has(token)) return;
    if (tailTokens.delete(token)) {
      tailTokens.add(token);
      return;
    }
    if (headTokens.size < edgeSize) {
      headTokens.add(token);
      return;
    }
    tailTokens.add(token);
    if (tailTokens.size > edgeSize) {
      const oldest = tailTokens.values().next();
      if (!oldest.done) tailTokens.delete(oldest.value);
    }
  };

  for (const match of normalized.matchAll(RECALL_TOKEN_RUN)) {
    const run = match[0];
    if (CJK_RUN_START.test(run)) {
      let previous = '';
      for (const codePoint of run) {
        if (previous) addToken(previous + codePoint);
        previous = codePoint;
      }
    } else {
      addToken(run);
    }
  }

  return [...headTokens, ...tailTokens];
}

function normalizeBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '_No entries yet._') {
    return '';
  }
  return trimmed;
}

function toolAliases(toolName: string): string[] {
  const normalized = toolName.trim().toLowerCase();
  const aliases = [normalized];

  if (normalized.includes('::')) {
    aliases.push(normalized.split('::').at(-1) ?? '');
  }

  if (normalized.startsWith('mcp__')) {
    const parts = normalized.split('__');
    if (parts.length >= 3) {
      aliases.push(parts.slice(2).join('__'));
      aliases.push(parts.at(-1) ?? '');
    }
  }

  return Array.from(
    new Set(aliases.map((alias) => alias.trim()).filter(Boolean)),
  );
}

/**
 * Build the active-tool noise predicate once per recall rather than deriving
 * it per document. The alias set depends only on `recentTools`, so computing
 * it inside the per-document filter re-derived up to
 * `MAX_RECENT_TOOL_NAMES_FOR_MEMORY` alias lists for every scanned document —
 * which recall now does over an uncapped pool.
 *
 * Returns a predicate rather than a boolean so both filter sites share the
 * hoisting; a `recentTools`-free recall short-circuits to a constant `false`.
 */
function createActiveToolUsageFilter(
  recentTools: readonly string[],
  useStructuredMetadata = true,
): (doc: ScannedAutoMemoryDocument) => boolean {
  if (recentTools.length === 0) {
    return () => false;
  }

  const aliases = Array.from(new Set(recentTools.flatMap(toolAliases)));
  if (aliases.length === 0) {
    return () => false;
  }

  return (doc) => {
    const rawHaystack = [
      doc.title,
      doc.description,
      ...(useStructuredMetadata ? doc.keywords : []),
      ...(useStructuredMetadata ? doc.usageScenarios : []),
      normalizeBody(doc.body),
    ].join(' ');
    const haystack = (
      useStructuredMetadata ? rawHaystack.normalize('NFKC') : rawHaystack
    ).toLowerCase();
    if (!aliases.some((alias) => haystack.includes(alias))) {
      return false;
    }

    if (
      DURABLE_ACTIVE_TOOL_MEMORY_MARKERS.some((marker) =>
        haystack.includes(marker),
      )
    ) {
      return false;
    }

    return ACTIVE_TOOL_USAGE_MEMORY_MARKERS.some((marker) =>
      haystack.includes(marker),
    );
  };
}

function scoreDocument(
  queryTokens: string[],
  doc: ScannedAutoMemoryDocument,
  useStructuredMetadata = true,
): number {
  const title = normalizeRecallText(doc.title);
  const description = normalizeRecallText(doc.description);
  const keywords = normalizeRecallText(doc.keywords.join(' '));
  const usageScenarios = normalizeRecallText(doc.usageScenarios.join(' '));
  const body = normalizeRecallText(
    normalizeBody(doc.body).slice(0, MAX_DOC_BODY_CHARS),
  );

  let lexicalScore = 0;
  for (const token of queryTokens) {
    if (title.includes(token)) {
      lexicalScore += 4;
    }
    if (description.includes(token)) {
      lexicalScore += 3;
    }
    if (useStructuredMetadata && keywords.includes(token)) {
      lexicalScore += 4;
    }
    if (useStructuredMetadata && usageScenarios.includes(token)) {
      lexicalScore += 3;
    }
    const cjkBigram = /^\p{Script=Han}{2}$/u.test(token);
    if ((!useStructuredMetadata || !cjkBigram) && body.includes(token)) {
      lexicalScore += 1;
    }
  }

  if (lexicalScore === 0) {
    return 0;
  }

  const typeBoost = Math.min(
    queryTokens.filter((token) => TYPE_KEYWORDS[doc.type]?.includes(token))
      .length,
    2,
  );
  return lexicalScore + typeBoost;
}

function isStrongFastMatch(
  query: string,
  doc: ScannedAutoMemoryDocument,
): boolean {
  const normalizedQuery = normalizeRecallText(query);
  const title = normalizeRecallText(doc.title).trim();
  const keywords = doc.keywords
    .map((keyword) => normalizeRecallText(keyword).trim())
    .filter(Boolean);
  if (
    (title.length > 0 && normalizedQuery.includes(title)) ||
    keywords.some((keyword) => normalizedQuery.includes(keyword))
  ) {
    return true;
  }

  const queryTokens = tokenize(query);
  const metadata = normalizeRecallText(
    [doc.title, doc.description, ...doc.keywords, ...doc.usageScenarios].join(
      ' ',
    ),
  );
  return queryTokens.filter((token) => metadata.includes(token)).length >= 2;
}

function hasStaleBodyInHistory(
  doc: ScannedAutoMemoryDocument,
  bodyPresentVersions?: ReadonlyMap<string, number>,
): boolean {
  const presentVersion = bodyPresentVersions?.get(toAutoMemoryRef(doc));
  return presentVersion !== undefined && presentVersion !== doc.mtimeMs;
}

export function selectRelevantAutoMemoryDocuments(
  query: string,
  docs: ScannedAutoMemoryDocument[],
  limit = MAX_RELEVANT_DOCS,
  useStructuredMetadata = true,
): ScannedAutoMemoryDocument[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  return (
    docs
      .map((doc) => ({
        doc,
        score: scoreDocument(queryTokens, doc, useStructuredMetadata),
      }))
      .filter(({ score }) => score > 0)
      // Recency, then input order (stable sort), as the tie-breaks. NOT the
      // document type: an alphabetical type comparison ranks `user` behind
      // every other type, and MAX_FAST_RECALL_DOCS takes only the top two, so
      // a type tie-break would systematically drop user-level memory from the
      // fast result — the exact case the fast path exists to serve.
      .sort((a, b) => b.score - a.score || b.doc.mtimeMs - a.doc.mtimeMs)
      .slice(0, limit)
      .map(({ doc }) => doc)
  );
}

function selectModelCandidateDocuments(
  query: string,
  docs: ScannedAutoMemoryDocument[],
  recentTools: readonly string[],
  fallbackLimit: number,
  useStructuredMetadata = true,
): {
  modelCandidates: ScannedAutoMemoryDocument[];
  fallbackDocs: ScannedAutoMemoryDocument[];
} {
  const isActiveToolNoise = createActiveToolUsageFilter(
    recentTools,
    useStructuredMetadata,
  );
  const eligible = docs.filter((doc) => !isActiveToolNoise(doc));
  const lexical = selectRelevantAutoMemoryDocuments(
    query,
    eligible,
    Math.max(
      MAX_MODEL_CANDIDATE_DOCS - RECENT_MODEL_CANDIDATE_RESERVE,
      fallbackLimit,
    ),
    useStructuredMetadata,
  );
  const modelLexical = lexical.slice(
    0,
    MAX_MODEL_CANDIDATE_DOCS - RECENT_MODEL_CANDIDATE_RESERVE,
  );
  const selected = new Set(modelLexical.map((doc) => doc.filePath));
  const recent = eligible
    .filter((doc) => !selected.has(doc.filePath))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MODEL_CANDIDATE_DOCS - modelLexical.length);
  const modelCandidates = modelLexical.flatMap((doc, index) => {
    const recentDoc = recent[index];
    return recentDoc ? [doc, recentDoc] : [doc];
  });
  modelCandidates.push(...recent.slice(modelLexical.length));
  return {
    modelCandidates,
    fallbackDocs: lexical.slice(0, fallbackLimit),
  };
}

export function buildLegacyRelevantAutoMemoryPrompt(
  docs: readonly ScannedAutoMemoryDocument[],
): string {
  if (docs.length === 0) return '';
  return [
    '## Relevant memory',
    '',
    'Use the following memories only when they are directly relevant to the current request. Verify file/function claims before relying on them.',
    '',
    ...docs.flatMap((doc) => {
      const normalized = normalizeBody(doc.body);
      const body =
        normalized.length <= MAX_DOC_BODY_CHARS
          ? normalized
          : `${normalized.slice(0, MAX_DOC_BODY_CHARS).trimEnd()}\n\n> NOTE: Relevant memory truncated for prompt budget.`;
      const staleness = memoryFreshnessText(doc.mtimeMs);
      return [
        `### ${doc.title} (${doc.relativePath || path.basename(doc.filePath)})`,
        `Saved ${memoryAge(doc.mtimeMs)}.`,
        doc.description,
        '',
        body || '_No detailed entries yet._',
        ...(staleness ? ['', `> NOTE: ${staleness}`] : []),
        '',
      ];
    }),
  ].join('\n');
}

export interface ResolveRelevantAutoMemoryPromptOptions {
  config?: Config;
  excludedFilePaths?: Iterable<string>;
  limit?: number;
  recentTools?: readonly string[];
  /** When provided and aborted, suppresses logMemoryRecall telemetry for discarded results. */
  abortSignal?: AbortSignal;
  /**
   * Invoked with a deterministic, model-free result as soon as the shared
   * scan has produced candidates — before the model selector is called.
   *
   * The model selector is a network side query, so the full result settles in
   * round-trip time. A caller with a short initial-turn budget (see
   * `INITIAL_MEMORY_RECALL_WAIT_MS`) would otherwise have nothing to inject
   * on a turn that makes no tool call, because there is no later safe
   * delivery point on such a turn. This callback reuses the candidates the
   * selector was going to score anyway, so it costs no extra scan or I/O.
   *
   * Fires at most once and never after `abortSignal` aborts. When the
   * deterministic pass finds nothing, it publishes the compact router.
   */
  onFastResult?: (result: RelevantAutoMemoryPromptResult) => void;
}

export interface RelevantAutoMemoryPromptResult {
  treeSnapshot?: AutoMemoryTreeSnapshot;
  focusedPrompt: string;
  prompt: string;
  selectedDocs: ScannedAutoMemoryDocument[];
  strategy: 'none' | 'heuristic' | 'model';
}

function createRecallResult(
  treeSnapshot: AutoMemoryTreeSnapshot | undefined,
  selectedDocs: ScannedAutoMemoryDocument[],
  strategy: RelevantAutoMemoryPromptResult['strategy'],
  bodyPresentVersions?: ReadonlyMap<string, number>,
  legacy = false,
): RelevantAutoMemoryPromptResult {
  const focusedPrompt = legacy
    ? buildLegacyRelevantAutoMemoryPrompt(selectedDocs)
    : renderAutoMemoryFocusedSubtree(selectedDocs, {
        bodyPresentVersions,
      }).prompt;
  return {
    ...(legacy ? {} : { treeSnapshot }),
    focusedPrompt,
    prompt: focusedPrompt,
    selectedDocs,
    strategy,
  };
}

function filterExcludedAutoMemoryDocuments(
  docs: ScannedAutoMemoryDocument[],
  excludedFilePaths?: Iterable<string>,
): ScannedAutoMemoryDocument[] {
  if (!excludedFilePaths) return docs;
  const excluded = new Set(excludedFilePaths);
  return excluded.size === 0
    ? docs
    : docs.filter((doc) => !excluded.has(doc.filePath));
}

async function rereadSelectedDocuments(
  docs: readonly ScannedAutoMemoryDocument[],
): Promise<ScannedAutoMemoryDocument[]> {
  const reread = await Promise.all(docs.map(rereadAutoMemoryDocument));
  return reread.filter((doc): doc is ScannedAutoMemoryDocument => doc !== null);
}

function logRecallResult(
  config: Config | undefined,
  abortSignal: AbortSignal | undefined,
  queryLength: number,
  docsScanned: number,
  result: RelevantAutoMemoryPromptResult,
  startedAt: number,
  timings: {
    scanDurationMs: number;
    fastDurationMs: number;
    selectorDurationMs: number;
  },
): void {
  if (!config || abortSignal?.aborted) return;
  logMemoryRecall(
    config,
    new MemoryRecallEvent({
      query_length: queryLength,
      docs_scanned: docsScanned,
      docs_selected: result.selectedDocs.length,
      strategy: result.strategy,
      duration_ms: Date.now() - startedAt,
      scan_duration_ms: timings.scanDurationMs,
      fast_duration_ms: timings.fastDurationMs,
      selector_duration_ms: timings.selectorDurationMs,
    }),
  );
}

export async function resolveRelevantAutoMemoryPromptForQuery(
  projectRoot: string,
  query: string,
  options: ResolveRelevantAutoMemoryPromptOptions = {},
): Promise<RelevantAutoMemoryPromptResult> {
  const t0 = Date.now();
  const legacy =
    (options.config?.getMemoryRecallMode?.() ?? 'legacy') === 'legacy';
  const teamMemoryEnabled = options.config?.getTeamMemoryEnabled?.() ?? false;
  const snapshot = legacy
    ? await Promise.all([
        scanAllAutoMemoryTopicDocuments(projectRoot),
        scanAllUserAutoMemoryTopicDocuments().catch((error: unknown) => {
          debugLogger.warn(
            `User-level auto-memory scan failed; project-level recall continues: ${error instanceof Error ? error.message : String(error)}`,
          );
          return [];
        }),
      ]).then(([projectDocs, userDocs]) => {
        const sourceStatus: MemorySourceStatus = {
          requestedScopes: ['project', 'user'],
          searchedScopes: ['project', 'user'],
          unavailableScopes: [],
          complete: true,
          incompleteScopes: [],
        };
        return {
          docs: [...projectDocs, ...userDocs],
          sourceStatus,
        };
      })
    : await scanAutoMemorySnapshot(projectRoot, {
        scopes: teamMemoryEnabled ? ['project', 'user', 'team'] : undefined,
        teamMemoryEnabled,
        trustedProject: options.config?.isTrustedFolder?.() ?? false,
        uncapped: true,
      });
  const scanDurationMs = Date.now() - t0;
  let fastDurationMs = 0;
  let selectorDurationMs = 0;
  let selectorStartedAt: number | undefined;
  const timings = () => ({
    scanDurationMs,
    fastDurationMs,
    selectorDurationMs,
  });
  const bodyPresentVersions = options.config
    ?.getMemoryManager?.()
    .getBodyPresentVersionsInHistory();
  const docs = legacy
    ? filterExcludedAutoMemoryDocuments(
        snapshot.docs,
        options.excludedFilePaths,
      )
    : snapshot.docs;
  const treeSnapshot = legacy
    ? undefined
    : createAutoMemoryTreeSnapshot(docs, snapshot.sourceStatus);
  const limit = legacy
    ? (options.limit ?? MAX_RELEVANT_DOCS)
    : Math.min(options.limit ?? MAX_RELEVANT_DOCS, MAX_RELEVANT_DOCS);

  if (query.trim().length === 0 || docs.length === 0 || limit <= 0) {
    const result = createRecallResult(
      treeSnapshot,
      [],
      'none',
      bodyPresentVersions,
      legacy,
    );
    if (!legacy && options.onFastResult && !options.abortSignal?.aborted) {
      options.onFastResult(result);
    }
    logRecallResult(
      options.config,
      options.abortSignal,
      query.length,
      docs.length,
      result,
      t0,
      timings(),
    );
    return result;
  }

  let fallbackDocs: ScannedAutoMemoryDocument[] | undefined;
  if (options.config) {
    try {
      const fastStartedAt = Date.now();
      const candidates = selectModelCandidateDocuments(
        query,
        docs,
        options.recentTools ?? [],
        limit,
        !legacy,
      );
      fallbackDocs = candidates.fallbackDocs;
      // Publish the deterministic candidates before blocking on the selector
      // round trip. `fallbackDocs` is already lexically ranked and already has
      // active-tool noise filtered out by selectModelCandidateDocuments.
      if (options.onFastResult && !options.abortSignal?.aborted) {
        const fastDocs = legacy
          ? fallbackDocs.slice(0, MAX_FAST_RECALL_DOCS)
          : [
              ...fallbackDocs.filter((doc) =>
                hasStaleBodyInHistory(doc, bodyPresentVersions),
              ),
              ...fallbackDocs.filter(
                (doc) =>
                  !hasStaleBodyInHistory(doc, bodyPresentVersions) &&
                  isStrongFastMatch(query, doc),
              ),
            ].slice(0, MAX_FAST_RECALL_DOCS);
        if (!legacy || fastDocs.length > 0)
          options.onFastResult(
            createRecallResult(
              treeSnapshot,
              fastDocs,
              fastDocs.length > 0 ? 'heuristic' : 'none',
              bodyPresentVersions,
              legacy,
            ),
          );
      }
      fastDurationMs = Date.now() - fastStartedAt;
      selectorStartedAt = Date.now();
      const modelSelectedDocs = await selectRelevantAutoMemoryDocumentsByModel(
        options.config,
        query,
        candidates.modelCandidates,
        limit,
        options.recentTools ?? [],
        options.abortSignal,
      );
      selectorDurationMs = Date.now() - selectorStartedAt;
      const selectedDocs = legacy
        ? modelSelectedDocs
        : await rereadSelectedDocuments(modelSelectedDocs);
      const strategy: RelevantAutoMemoryPromptResult['strategy'] =
        selectedDocs.length > 0 ? 'model' : 'none';
      const result = createRecallResult(
        treeSnapshot,
        selectedDocs,
        strategy,
        bodyPresentVersions,
        legacy,
      );
      logRecallResult(
        options.config,
        options.abortSignal,
        query.length,
        docs.length,
        result,
        t0,
        timings(),
      );
      return result;
    } catch (error) {
      if (selectorStartedAt !== undefined && selectorDurationMs === 0) {
        selectorDurationMs = Date.now() - selectorStartedAt;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (options.abortSignal?.aborted) {
          debugLogger.debug('Model-driven auto-memory recall aborted.');
        } else {
          debugLogger.debug(
            'Model-driven auto-memory recall timed out; using heuristic fallback.',
          );
        }
      } else {
        debugLogger.warn(
          'Model-driven auto-memory recall failed; using heuristic fallback.',
          error,
        );
      }
    }
  }

  if (options.abortSignal?.aborted) {
    return {
      ...(treeSnapshot ? { treeSnapshot } : {}),
      focusedPrompt: '',
      prompt: '',
      selectedDocs: [],
      strategy: 'none',
    };
  }

  const isActiveToolNoise = createActiveToolUsageFilter(
    options.recentTools ?? [],
    !legacy,
  );
  const selectedDocs =
    fallbackDocs ??
    selectRelevantAutoMemoryDocuments(
      query,
      docs.filter((doc) => !isActiveToolNoise(doc)),
      limit,
      !legacy,
    );
  const freshSelectedDocs = legacy
    ? selectedDocs
    : await rereadSelectedDocuments(selectedDocs);
  const strategy: RelevantAutoMemoryPromptResult['strategy'] =
    freshSelectedDocs.length > 0 ? 'heuristic' : 'none';
  const result = createRecallResult(
    treeSnapshot,
    freshSelectedDocs,
    strategy,
    bodyPresentVersions,
    legacy,
  );
  logRecallResult(
    options.config,
    options.abortSignal,
    query.length,
    docs.length,
    result,
    t0,
    timings(),
  );
  return result;
}
