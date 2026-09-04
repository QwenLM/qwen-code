/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {
  codePointBigrams,
  normalizeRecallText,
} from '@qwen-code/channel-base/recallTokenizer';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  scanAllAutoMemoryTopicDocuments,
  scanAllUserAutoMemoryTopicDocuments,
  type ScannedAutoMemoryDocument,
} from './scan.js';
import { memoryAge, memoryFreshnessText } from './memoryAge.js';
import { selectRelevantAutoMemoryDocumentsByModel } from './relevanceSelector.js';
import { logMemoryRecall, MemoryRecallEvent } from '../telemetry/index.js';

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
      for (const bigram of codePointBigrams(run)) {
        addToken(bigram);
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
): (doc: ScannedAutoMemoryDocument) => boolean {
  if (recentTools.length === 0) {
    return () => false;
  }

  const aliases = Array.from(new Set(recentTools.flatMap(toolAliases)));
  if (aliases.length === 0) {
    return () => false;
  }

  return (doc) => {
    const haystack = [doc.title, doc.description, normalizeBody(doc.body)]
      .join(' ')
      .toLowerCase();
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
): number {
  const title = normalizeRecallText(doc.title);
  const description = normalizeRecallText(doc.description);
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
    if (body.includes(token)) {
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

export function selectRelevantAutoMemoryDocuments(
  query: string,
  docs: ScannedAutoMemoryDocument[],
  limit = MAX_RELEVANT_DOCS,
): ScannedAutoMemoryDocument[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  return (
    docs
      .map((doc) => ({ doc, score: scoreDocument(queryTokens, doc) }))
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
): {
  modelCandidates: ScannedAutoMemoryDocument[];
  fallbackDocs: ScannedAutoMemoryDocument[];
} {
  const isActiveToolNoise = createActiveToolUsageFilter(recentTools);
  const eligible = docs.filter((doc) => !isActiveToolNoise(doc));
  const lexical = selectRelevantAutoMemoryDocuments(
    query,
    eligible,
    Math.max(
      MAX_MODEL_CANDIDATE_DOCS - RECENT_MODEL_CANDIDATE_RESERVE,
      fallbackLimit,
    ),
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

function truncateBody(body: string): string {
  const normalized = normalizeBody(body);
  if (normalized.length <= MAX_DOC_BODY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_DOC_BODY_CHARS).trimEnd()}\n\n> NOTE: Relevant memory truncated for prompt budget.`;
}

export function buildRelevantAutoMemoryPrompt(
  docs: ScannedAutoMemoryDocument[],
): string {
  if (docs.length === 0) {
    return '';
  }

  return [
    '## Relevant memory',
    '',
    'Use the following memories only when they are directly relevant to the current request. Verify file/function claims before relying on them.',
    '',
    ...docs.flatMap((doc) => {
      const body = truncateBody(doc.body);
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
   * Fires at most once, never after `abortSignal` aborts, and never when the
   * deterministic pass found nothing.
   */
  onFastResult?: (result: RelevantAutoMemoryPromptResult) => void;
}

export interface RelevantAutoMemoryPromptResult {
  prompt: string;
  selectedDocs: ScannedAutoMemoryDocument[];
  strategy: 'none' | 'heuristic' | 'model';
}

function filterExcludedAutoMemoryDocuments(
  docs: ScannedAutoMemoryDocument[],
  excludedFilePaths?: Iterable<string>,
): ScannedAutoMemoryDocument[] {
  if (!excludedFilePaths) {
    return docs;
  }

  const excluded = new Set(excludedFilePaths);
  if (excluded.size === 0) {
    return docs;
  }

  return docs.filter((doc) => !excluded.has(doc.filePath));
}

export async function resolveRelevantAutoMemoryPromptForQuery(
  projectRoot: string,
  query: string,
  options: ResolveRelevantAutoMemoryPromptOptions = {},
): Promise<RelevantAutoMemoryPromptResult> {
  const t0 = Date.now();
  // User-level scan is best-effort: a read failure (EACCES, ELOOP) on
  // `~/.qwen/memories/` must not cancel the project-level scan, otherwise
  // recall returns nothing at all for the rest of the session. Project-
  // level scan failures still bubble — they're the only mandatory side.
  const [projectDocs, userDocs] = await Promise.all([
    scanAllAutoMemoryTopicDocuments(projectRoot),
    scanAllUserAutoMemoryTopicDocuments().catch((error: unknown) => {
      debugLogger.warn(
        `User-level auto-memory scan failed; project-level recall continues: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }),
  ]);
  // Project-level docs come first so that, once score and mtime have tied in
  // `selectRelevantAutoMemoryDocuments`, the stable sort leaves project
  // memory ahead of user memory — the "project shadows user" precedence. The
  // model selector ranks by its own judgement, so this ordering is advisory
  // there, not enforced.
  const docs = filterExcludedAutoMemoryDocuments(
    [...projectDocs, ...userDocs],
    options.excludedFilePaths,
  );
  const limit = options.limit ?? MAX_RELEVANT_DOCS;

  if (query.trim().length === 0 || docs.length === 0 || limit <= 0) {
    if (options.config && !options.abortSignal?.aborted) {
      logMemoryRecall(
        options.config,
        new MemoryRecallEvent({
          query_length: query.length,
          docs_scanned: docs.length,
          docs_selected: 0,
          strategy: 'none',
          duration_ms: Date.now() - t0,
        }),
      );
    }
    return {
      prompt: '',
      selectedDocs: [],
      strategy: 'none',
    };
  }

  let fallbackDocs: ScannedAutoMemoryDocument[] | undefined;
  if (options.config) {
    try {
      const candidates = selectModelCandidateDocuments(
        query,
        docs,
        options.recentTools ?? [],
        limit,
      );
      fallbackDocs = candidates.fallbackDocs;
      // Publish the deterministic candidates before blocking on the selector
      // round trip. `fallbackDocs` is already lexically ranked and already has
      // active-tool noise filtered out by selectModelCandidateDocuments.
      if (options.onFastResult && !options.abortSignal?.aborted) {
        const fastDocs = fallbackDocs.slice(0, MAX_FAST_RECALL_DOCS);
        if (fastDocs.length > 0) {
          options.onFastResult({
            prompt: buildRelevantAutoMemoryPrompt(fastDocs),
            selectedDocs: fastDocs,
            strategy: 'heuristic',
          });
        }
      }
      const selectedDocs = await selectRelevantAutoMemoryDocumentsByModel(
        options.config,
        query,
        candidates.modelCandidates,
        limit,
        options.recentTools ?? [],
        options.abortSignal,
      );
      const strategy: RelevantAutoMemoryPromptResult['strategy'] =
        selectedDocs.length > 0 ? 'model' : 'none';
      if (!options.abortSignal?.aborted) {
        logMemoryRecall(
          options.config,
          new MemoryRecallEvent({
            query_length: query.length,
            docs_scanned: docs.length,
            docs_selected: selectedDocs.length,
            strategy,
            duration_ms: Date.now() - t0,
          }),
        );
      }
      return {
        prompt: buildRelevantAutoMemoryPrompt(selectedDocs),
        selectedDocs,
        strategy,
      };
    } catch (error) {
      // Distinguish three cases so oncall debugging isn't misled:
      //   - caller-driven abort (user signal / new UserQuery / session
      //     cleanup): caller signal is aborted → heuristic fallback is
      //     skipped below at `options.abortSignal?.aborted`, so the
      //     result really is discarded.
      //   - 30 s safety-net timeout in relevanceSelector: only the inner
      //     combined signal aborts; the caller's signal is NOT aborted,
      //     so the heuristic fallback below DOES run.
      //   - real model error: warn at the higher level.
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (options.abortSignal?.aborted) {
          debugLogger.debug(
            'Model-driven auto-memory recall aborted by caller; heuristic result discarded.',
          );
        } else {
          debugLogger.debug(
            'Model-driven auto-memory recall timed out (30 s safety net); heuristic fallback will run.',
          );
        }
      } else {
        debugLogger.warn(
          'Model-driven auto-memory recall failed; falling back to heuristic selection.',
          error,
        );
      }
    }
  }

  // If the caller's abort signal is already set, skip the heuristic
  // fallback — the result would be discarded anyway.
  if (options.abortSignal?.aborted) {
    return {
      prompt: '',
      selectedDocs: [],
      strategy: 'none',
    };
  }

  const isActiveToolNoise = createActiveToolUsageFilter(
    options.recentTools ?? [],
  );
  const selectedDocs =
    fallbackDocs ??
    selectRelevantAutoMemoryDocuments(
      query,
      docs.filter((doc) => !isActiveToolNoise(doc)),
      limit,
    );
  const strategy: RelevantAutoMemoryPromptResult['strategy'] =
    selectedDocs.length > 0 ? 'heuristic' : 'none';
  if (options.config && !options.abortSignal?.aborted) {
    logMemoryRecall(
      options.config,
      new MemoryRecallEvent({
        query_length: query.length,
        docs_scanned: docs.length,
        docs_selected: selectedDocs.length,
        strategy,
        duration_ms: Date.now() - t0,
      }),
    );
  }
  return {
    prompt: buildRelevantAutoMemoryPrompt(selectedDocs),
    selectedDocs,
    strategy,
  };
}

export async function buildRelevantAutoMemoryPromptForQuery(
  projectRoot: string,
  query: string,
  options: ResolveRelevantAutoMemoryPromptOptions = {},
): Promise<string> {
  const result = await resolveRelevantAutoMemoryPromptForQuery(
    projectRoot,
    query,
    options,
  );
  return result.prompt;
}
