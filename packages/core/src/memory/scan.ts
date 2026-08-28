/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';
import { parse as parseYaml } from '../utils/yaml-parser.js';
import {
  AUTO_MEMORY_TREE_CATEGORIES,
  AUTO_MEMORY_TYPES,
  AUTO_MEMORY_UNCATEGORIZED,
  type AutoMemoryScope,
  type AutoMemoryTreeCategory,
  type AutoMemoryTreeCategoryKey,
  type AutoMemoryType,
} from './types.js';
import {
  AUTO_MEMORY_INDEX_FILENAME,
  getAutoMemoryRoot,
  getProjectAutoMemoryRoots,
  getMemoryRootTrustedAnchor,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from './paths.js';
import { listTrustedMemoryMarkdownFiles } from './trusted-memory-filesystem.js';

const debugLogger = createDebugLogger('AUTO_MEMORY_SCAN');

const MAX_SCANNED_MEMORY_FILES = 200;
const MAX_MEMORY_KEYWORDS = 8;
const MAX_MEMORY_KEYWORD_CHARS = 64;
const MAX_MEMORY_KEYWORDS_TOTAL_CHARS = 512;
const MAX_USAGE_SCENARIOS = 3;
const MAX_USAGE_SCENARIO_CHARS = 64;
const MIN_STRUCTURED_MEMORY_KEYWORDS = 2;
const MAX_STRUCTURED_MEMORY_KEYWORDS = 6;

export type AutoMemoryScanIncompleteReason =
  | 'root_read_failed'
  | 'file_read_failed'
  | 'file_limit';

export type AutoMemoryUnavailableScopeReason =
  | 'disabled'
  | 'untrusted'
  | 'not_configured';

export interface AutoMemoryIncompleteScope {
  scope: AutoMemoryScope;
  reason: AutoMemoryScanIncompleteReason;
  discovered?: number;
  returned: number;
}

export interface AutoMemoryUnavailableScope {
  scope: AutoMemoryScope;
  reason: AutoMemoryUnavailableScopeReason;
}

export interface MemorySourceStatus {
  requestedScopes: AutoMemoryScope[];
  searchedScopes: AutoMemoryScope[];
  unavailableScopes: AutoMemoryUnavailableScope[];
  complete: boolean;
  incompleteScopes: AutoMemoryIncompleteScope[];
}

export interface AutoMemoryScanSnapshot {
  docs: ScannedAutoMemoryDocument[];
  sourceStatus: MemorySourceStatus;
}

export interface AutoMemoryDocumentCacheEntry {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
  document: ScannedAutoMemoryDocument | null;
}

export type AutoMemoryDocumentCache = Map<string, AutoMemoryDocumentCacheEntry>;

export interface ScannedAutoMemoryDocument {
  scope: AutoMemoryScope;
  type: AutoMemoryType;
  filePath: string;
  relativePath: string;
  filename: string;
  title: string;
  description: string;
  category: AutoMemoryTreeCategoryKey;
  keywords: string[];
  usageScenarios: string[];
  body: string;
  mtimeMs: number;
}

export interface StructuredAutoMemoryValidation {
  valid: boolean;
  missingOrInvalidFields: Array<
    | 'frontmatter'
    | 'name'
    | 'description'
    | 'type'
    | 'category'
    | 'keywords'
    | 'usage_scenarios'
  >;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

export function normalizeAutoMemoryKeyword(value: string): string {
  return sanitizeAutoMemoryPromptField(value, Number.MAX_SAFE_INTEGER);
}

export function sanitizeAutoMemoryPromptField(
  value: string,
  maxChars: number,
): string {
  return (
    value
      .normalize('NFKC')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxChars)
      .replace(/[\uD800-\uDBFF]$/, '')
  );
}

function parseKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const keywords: string[] = [];
  const normalizedSeen = new Set<string>();
  let totalChars = 0;

  for (const valueItem of value) {
    if (
      keywords.length >= MAX_MEMORY_KEYWORDS ||
      typeof valueItem !== 'string'
    ) {
      continue;
    }
    const keyword = normalizeAutoMemoryKeyword(valueItem);
    const normalized = keyword.toLocaleLowerCase('en-US');
    if (
      keyword.length === 0 ||
      keyword.length > MAX_MEMORY_KEYWORD_CHARS ||
      normalizedSeen.has(normalized) ||
      totalChars + keyword.length > MAX_MEMORY_KEYWORDS_TOTAL_CHARS
    ) {
      continue;
    }
    normalizedSeen.add(normalized);
    keywords.push(keyword);
    totalChars += keyword.length;
  }

  return keywords;
}

function parseCategory(value: unknown): AutoMemoryTreeCategoryKey {
  const category = stringValue(value);
  if (
    category &&
    AUTO_MEMORY_TREE_CATEGORIES.includes(category as AutoMemoryTreeCategory)
  ) {
    return category as AutoMemoryTreeCategoryKey;
  }
  return AUTO_MEMORY_UNCATEGORIZED;
}

function parseUsageScenarios(value: unknown, description: string): string[] {
  const raw = Array.isArray(value) ? value : description ? [description] : [];
  const scenarios: string[] = [];
  const normalizedSeen = new Set<string>();

  for (const item of raw) {
    if (scenarios.length >= MAX_USAGE_SCENARIOS || typeof item !== 'string') {
      continue;
    }
    const scenario = sanitizeAutoMemoryPromptField(
      item,
      MAX_USAGE_SCENARIO_CHARS,
    );
    const normalized = scenario.toLocaleLowerCase('en-US');
    if (scenario.length === 0 || normalizedSeen.has(normalized)) {
      continue;
    }
    normalizedSeen.add(normalized);
    scenarios.push(scenario);
  }

  return scenarios;
}

export function validateStructuredAutoMemoryDocument(
  content: string,
): StructuredAutoMemoryValidation {
  const frontmatterMatch = content
    .replace(/\r\n/g, '\n')
    .match(/^---\n([\s\S]*?)\n---\n?[\s\S]*$/);
  if (!frontmatterMatch) {
    return { valid: false, missingOrInvalidFields: ['frontmatter'] };
  }
  const parsed = parseYaml(frontmatterMatch[1]);
  const invalid: StructuredAutoMemoryValidation['missingOrInvalidFields'] = [];
  const name = stringValue(parsed['name']);
  const description = stringValue(parsed['description']);
  const type = stringValue(parsed['type']);
  const category = stringValue(parsed['category']);
  const rawKeywords = parsed['keywords'];
  const rawScenarios = parsed['usage_scenarios'];

  if (!name) invalid.push('name');
  if (!description) invalid.push('description');
  if (!type || !AUTO_MEMORY_TYPES.includes(type as AutoMemoryType)) {
    invalid.push('type');
  }
  if (
    !category ||
    !AUTO_MEMORY_TREE_CATEGORIES.includes(category as AutoMemoryTreeCategory)
  ) {
    invalid.push('category');
  }
  if (
    !Array.isArray(rawKeywords) ||
    rawKeywords.length < MIN_STRUCTURED_MEMORY_KEYWORDS ||
    rawKeywords.length > MAX_STRUCTURED_MEMORY_KEYWORDS ||
    parseKeywords(rawKeywords).length !== rawKeywords.length
  ) {
    invalid.push('keywords');
  }
  if (
    !Array.isArray(rawScenarios) ||
    rawScenarios.length < 1 ||
    rawScenarios.length > MAX_USAGE_SCENARIOS ||
    parseUsageScenarios(rawScenarios, '').length !== rawScenarios.length
  ) {
    invalid.push('usage_scenarios');
  }
  return { valid: invalid.length === 0, missingOrInvalidFields: invalid };
}

export function parseAutoMemoryTopicDocument(
  filePath: string,
  content: string,
  mtimeMs = 0,
  relativePath = path.basename(filePath),
  scope: AutoMemoryScope = 'project',
): ScannedAutoMemoryDocument | null {
  // Normalize CRLF → LF before matching: the delimiter regex anchors on
  // `^---\n`, so a Windows checkout (`---\r\n`) would fail to parse and the file
  // would silently vanish from the shared team index. Team files are read raw
  // (utf-8) and git may hand them back with CRLF on Windows.
  const normalized = content.replace(/\r\n/g, '\n');
  const frontmatterMatch = normalized.match(
    /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/,
  );
  if (!frontmatterMatch) {
    return null;
  }

  const [, frontmatter, bodyContent] = frontmatterMatch;
  const parsedFrontmatter = parseYaml(frontmatter);
  const rawType = stringValue(parsedFrontmatter['type']);
  if (!rawType || !AUTO_MEMORY_TYPES.includes(rawType as AutoMemoryType)) {
    return null;
  }
  const description = stringValue(parsedFrontmatter['description']) ?? '';

  return {
    scope,
    type: rawType as AutoMemoryType,
    filePath,
    relativePath,
    filename: path.basename(filePath),
    title:
      stringValue(parsedFrontmatter['name']) ??
      stringValue(parsedFrontmatter['title']) ??
      rawType,
    description,
    category: parseCategory(parsedFrontmatter['category']),
    keywords: parseKeywords(parsedFrontmatter['keywords']),
    usageScenarios: parseUsageScenarios(
      parsedFrontmatter['usage_scenarios'],
      description,
    ),
    body: bodyContent.trim(),
    mtimeMs,
  };
}

async function listMarkdownFiles(root: string) {
  return listTrustedMemoryMarkdownFiles(
    root,
    getMemoryRootTrustedAnchor(root),
    AUTO_MEMORY_INDEX_FILENAME,
  );
}

function sortScannedDocuments(
  docs: ScannedAutoMemoryDocument[],
  deterministic?: boolean,
): ScannedAutoMemoryDocument[] {
  return deterministic
    ? docs.sort((a, b) =>
        a.relativePath < b.relativePath
          ? -1
          : a.relativePath > b.relativePath
            ? 1
            : 0,
      )
    : docs.sort(
        (a, b) =>
          b.mtimeMs - a.mtimeMs ||
          a.filename.localeCompare(b.filename) ||
          a.relativePath.localeCompare(b.relativePath),
      );
}

async function scanAutoMemoryDocumentsFromRootWithStatus(
  root: string,
  opts: {
    scope: AutoMemoryScope;
    deterministic?: boolean;
    uncapped?: boolean;
    documentCache?: AutoMemoryDocumentCache;
  },
): Promise<{
  docs: ScannedAutoMemoryDocument[];
  incompleteScopes: AutoMemoryIncompleteScope[];
  rootError?: unknown;
}> {
  let files: Awaited<ReturnType<typeof listMarkdownFiles>>;
  try {
    files = await listMarkdownFiles(root);
  } catch (error) {
    debugLogger.debug(`failed to list memory root ${root}`, error);
    return {
      docs: [],
      rootError: error,
      incompleteScopes: [
        {
          scope: opts.scope,
          reason: 'root_read_failed',
          returned: 0,
        },
      ],
    };
  }

  const docs: ScannedAutoMemoryDocument[] = [];
  let fileReadFailures = 0;
  await Promise.all(
    files.map(async ({ relativePath, resolvedPath: trustedFile }) => {
      const filePath = path.join(root, relativePath);
      try {
        const stats = await fs.stat(trustedFile);
        const cacheKey = `${opts.scope}\0${trustedFile}`;
        const cached = opts.documentCache?.get(cacheKey);
        if (
          cached?.mtimeMs === stats.mtimeMs &&
          cached.ctimeMs === stats.ctimeMs &&
          cached.size === stats.size &&
          cached.ino === stats.ino
        ) {
          if (cached.document) docs.push(cached.document);
          return;
        }
        const content = await fs.readFile(trustedFile, 'utf-8');
        const parsed = parseAutoMemoryTopicDocument(
          filePath,
          content,
          stats.mtimeMs,
          relativePath,
          opts.scope,
        );
        opts.documentCache?.set(cacheKey, {
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
          size: stats.size,
          ino: stats.ino,
          document: parsed,
        });
        if (parsed) {
          docs.push(parsed);
        }
      } catch (error) {
        fileReadFailures += 1;
        debugLogger.debug(
          `skipping unreadable memory file ${relativePath}`,
          error,
        );
      }
    }),
  );

  const ordered = sortScannedDocuments(docs, opts.deterministic);
  const returnedDocs = opts.uncapped
    ? ordered
    : ordered.slice(0, MAX_SCANNED_MEMORY_FILES);
  const incompleteScopes: AutoMemoryIncompleteScope[] = [];
  if (fileReadFailures > 0) {
    incompleteScopes.push({
      scope: opts.scope,
      reason: 'file_read_failed',
      discovered: files.length,
      returned: returnedDocs.length,
    });
  }
  if (!opts.uncapped && ordered.length > MAX_SCANNED_MEMORY_FILES) {
    incompleteScopes.push({
      scope: opts.scope,
      reason: 'file_limit',
      discovered: ordered.length,
      returned: returnedDocs.length,
    });
  }

  return { docs: returnedDocs, incompleteScopes };
}

async function scanAutoMemoryDocumentsFromRoot(
  root: string,
  opts: {
    scope: AutoMemoryScope;
    deterministic?: boolean;
    uncapped?: boolean;
    documentCache?: AutoMemoryDocumentCache;
  },
): Promise<ScannedAutoMemoryDocument[]> {
  const result = await scanAutoMemoryDocumentsFromRootWithStatus(root, opts);
  if (
    result.incompleteScopes.some(
      (incomplete) => incomplete.reason === 'root_read_failed',
    )
  ) {
    throw result.rootError;
  }
  return result.docs;
}

export async function scanAllAutoMemoryTopicDocumentsFromRoot(
  root: string,
  scope: AutoMemoryScope,
): Promise<ScannedAutoMemoryDocument[]> {
  return scanAutoMemoryDocumentsFromRoot(root, { scope, uncapped: true });
}

function dedupeScannedDocuments(
  docs: ScannedAutoMemoryDocument[],
): ScannedAutoMemoryDocument[] {
  const seen = new Set<string>();
  const deduped: ScannedAutoMemoryDocument[] = [];
  for (const doc of docs) {
    const key = `${doc.scope}:${doc.relativePath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(doc);
  }
  return deduped;
}

async function scanProjectAutoMemoryWithStatus(
  projectRoot: string,
  trustedProject: boolean,
  uncapped = false,
  documentCache?: AutoMemoryDocumentCache,
): Promise<{
  docs: ScannedAutoMemoryDocument[];
  incompleteScopes: AutoMemoryIncompleteScope[];
}> {
  const roots = getProjectAutoMemoryRoots(projectRoot, trustedProject);
  const results = await Promise.all(
    roots.map((root) =>
      scanAutoMemoryDocumentsFromRootWithStatus(root, {
        scope: 'project',
        uncapped: true,
        documentCache,
      }),
    ),
  );
  const allDocs = sortScannedDocuments(
    dedupeScannedDocuments(results.flatMap((result) => result.docs)),
  );
  const docs = uncapped ? allDocs : allDocs.slice(0, MAX_SCANNED_MEMORY_FILES);
  const incompleteScopes = results.flatMap((result) => result.incompleteScopes);
  if (!uncapped && allDocs.length > MAX_SCANNED_MEMORY_FILES) {
    incompleteScopes.push({
      scope: 'project',
      reason: 'file_limit',
      discovered: allDocs.length,
      returned: docs.length,
    });
  }
  return {
    docs,
    incompleteScopes,
  };
}

export async function scanAutoMemorySnapshot(
  projectRoot: string,
  options: {
    scopes?: readonly AutoMemoryScope[];
    teamMemoryEnabled?: boolean;
    trustedProject?: boolean;
    uncapped?: boolean;
    documentCache?: AutoMemoryDocumentCache;
  } = {},
): Promise<AutoMemoryScanSnapshot> {
  const requestedScopes = [...(options.scopes ?? ['project', 'user'])];
  const searchedScopes: AutoMemoryScope[] = [];
  const unavailableScopes: AutoMemoryUnavailableScope[] = [];
  const scanTasks: Array<
    Promise<{
      docs: ScannedAutoMemoryDocument[];
      incompleteScopes: AutoMemoryIncompleteScope[];
    }>
  > = [];

  for (const scope of requestedScopes) {
    if (scope === 'project') {
      const projectRoots = getProjectAutoMemoryRoots(
        projectRoot,
        options.trustedProject !== false,
      );
      if (projectRoots.length === 0) {
        unavailableScopes.push({ scope, reason: 'untrusted' });
        continue;
      }
      searchedScopes.push(scope);
      scanTasks.push(
        scanProjectAutoMemoryWithStatus(
          projectRoot,
          options.trustedProject !== false,
          options.uncapped,
          options.documentCache,
        ),
      );
    } else if (scope === 'user') {
      searchedScopes.push(scope);
      scanTasks.push(
        scanAutoMemoryDocumentsFromRootWithStatus(getUserAutoMemoryRoot(), {
          scope,
          uncapped: options.uncapped,
          documentCache: options.documentCache,
        }),
      );
    } else if (options.teamMemoryEnabled !== true) {
      unavailableScopes.push({ scope, reason: 'disabled' });
    } else if (options.trustedProject === false) {
      unavailableScopes.push({ scope, reason: 'untrusted' });
    } else {
      searchedScopes.push(scope);
      scanTasks.push(
        scanAutoMemoryDocumentsFromRootWithStatus(
          getTeamAutoMemoryRoot(projectRoot),
          {
            scope,
            deterministic: true,
            uncapped: options.uncapped,
            documentCache: options.documentCache,
          },
        ),
      );
    }
  }

  const results = await Promise.all(scanTasks);
  const docs = results.flatMap((result) => result.docs);
  const incompleteScopes = results.flatMap((result) => result.incompleteScopes);

  return {
    docs,
    sourceStatus: {
      requestedScopes,
      searchedScopes,
      unavailableScopes,
      complete: incompleteScopes.length === 0,
      incompleteScopes,
    },
  };
}

export async function scanAutoMemoryTopicDocuments(
  projectRoot: string,
): Promise<ScannedAutoMemoryDocument[]> {
  return scanAutoMemoryDocumentsFromRoot(getAutoMemoryRoot(projectRoot), {
    scope: 'project',
  });
}

export async function scanAllAutoMemoryTopicDocuments(
  projectRoot: string,
  documentCache?: AutoMemoryDocumentCache,
): Promise<ScannedAutoMemoryDocument[]> {
  // ponytail: reuse the existing O(n) parsed scan; add a catalog only if
  // measured topic counts make recall scanning too slow.
  return scanAutoMemoryDocumentsFromRoot(getAutoMemoryRoot(projectRoot), {
    scope: 'project',
    uncapped: true,
    documentCache,
  });
}

/**
 * Scan the user-level (cross-project) auto-memory dir. Returns an empty
 * array when the dir does not exist yet, so callers can union with
 * project-level docs unconditionally.
 */
export async function scanUserAutoMemoryTopicDocuments(): Promise<
  ScannedAutoMemoryDocument[]
> {
  return scanAutoMemoryDocumentsFromRoot(getUserAutoMemoryRoot(), {
    scope: 'user',
  });
}

export async function scanAllUserAutoMemoryTopicDocuments(
  documentCache?: AutoMemoryDocumentCache,
): Promise<ScannedAutoMemoryDocument[]> {
  return scanAutoMemoryDocumentsFromRoot(getUserAutoMemoryRoot(), {
    scope: 'user',
    uncapped: true,
    documentCache,
  });
}

/**
 * Scan the team (in-repo, git-tracked) auto-memory dir. Returns an empty
 * array when the dir does not exist yet.
 */
export async function scanTeamAutoMemoryTopicDocuments(
  projectRoot: string,
): Promise<ScannedAutoMemoryDocument[]> {
  // Deterministic cap: the team index is committed and shared, so the subset
  // that survives MAX_SCANNED_MEMORY_FILES must be machine-independent.
  return scanAutoMemoryDocumentsFromRoot(getTeamAutoMemoryRoot(projectRoot), {
    scope: 'team',
    deterministic: true,
  });
}

export async function rereadAutoMemoryDocument(
  doc: ScannedAutoMemoryDocument,
): Promise<ScannedAutoMemoryDocument | null> {
  try {
    const [content, stats] = await Promise.all([
      fs.readFile(doc.filePath, 'utf-8'),
      fs.stat(doc.filePath),
    ]);
    return parseAutoMemoryTopicDocument(
      doc.filePath,
      content,
      stats.mtimeMs,
      doc.relativePath,
      doc.scope,
    );
  } catch (error) {
    debugLogger.debug(
      `selected memory disappeared before prompt injection: ${doc.relativePath}`,
      error,
    );
    return null;
  }
}
