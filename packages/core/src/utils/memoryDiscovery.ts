/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';
import { load as loadYaml } from 'js-yaml';
import picomatch from 'picomatch';
import {
  DEFAULT_CONTEXT_FILENAME,
  deriveLocalContextFilenames,
} from '../tools/memoryTool.js';
import {
  processImports,
  collectImportParentMap,
  type BlockedExternalImport,
  type FailedImport,
} from './memoryImportProcessor.js';
import {
  getConfigHomeDir,
  normalizePath,
  isSubpath,
  CONFIG_DIR,
} from './paths.js';
import { runLogger } from './runLogger.js';
import type { HierarchicalMemory } from '../config/memory.js';
import { getErrorMessage } from './errors.js';
import { stripHtmlComments } from './stripHtmlComments.js';

/**
 * Fallback context filenames for callers with no session to ask.
 *
 * Every in-repo caller passes the owning Config's names, so this only keeps the
 * exported signatures non-breaking for external callers. It matches what a
 * Config lands on when its settings say nothing about `context.fileName`.
 */
const DEFAULT_CONTEXT_FILENAMES: readonly string[] = [DEFAULT_CONTEXT_FILENAME];

// ── AGENTS.md exclusion ──────────────────────────────────────────────────────

export interface TypedMemoryPaths {
  global: string[];
  plugin: string[];
  project: string[];
  local: string[];
}

/**
 * Expands exclude patterns by resolving symlinks in absolute path prefixes.
 * For each absolute pattern (starting with /), tries to resolve the longest
 * existing directory prefix via realpathSync and adds the resolved version.
 * Glob patterns (containing *) have their static prefix resolved.
 */
export function resolveExcludePatterns(patterns: string[]): string[] {
  const expanded: string[] = patterns.map((p) => p.replaceAll('\\', '/'));

  for (const normalized of [...expanded]) {
    if (!normalized.startsWith('/')) {
      continue;
    }

    const globStart = normalized.search(/[*?{[]/);
    const staticPrefix =
      globStart === -1 ? normalized : normalized.slice(0, globStart);
    const dirToResolve = path.dirname(staticPrefix);

    try {
      const resolvedDir = fsSync
        .realpathSync(dirToResolve)
        .replaceAll('\\', '/');
      if (resolvedDir !== dirToResolve) {
        const resolvedPattern =
          resolvedDir + normalized.slice(dirToResolve.length);
        expanded.push(resolvedPattern);
      }
    } catch {
      // Directory doesn't exist; skip resolution for this pattern
    }
  }

  return expanded.filter((p) => p.length > 0);
}

/**
 * Checks whether a memory file path matches any of the expanded exclude patterns.
 */
export function isAgentsMdExcluded(
  filePath: string,
  expandedPatterns: string[],
): boolean {
  if (expandedPatterns.length === 0) return false;
  const normalizedPath = filePath.replaceAll('\\', '/');
  const nocase = process.platform === 'darwin' || process.platform === 'win32';
  return picomatch.isMatch(normalizedPath, expandedPatterns, {
    dot: true,
    nocase,
  });
}

/**
 * Filters out excluded memory paths. Only project and local paths
 * are subject to exclusion — global and extension are never excluded.
 * Extra properties on `paths` are preserved as-is.
 */
export function filterExcludedMemoryPaths<T extends TypedMemoryPaths>(
  paths: T,
  excludePatterns: string[],
): T {
  if (!excludePatterns || excludePatterns.length === 0) return paths;
  const expanded = resolveExcludePatterns(excludePatterns);
  if (expanded.length === 0) return paths;

  const excluded: string[] = [];
  const filterPaths = (pathList: string[]) =>
    pathList.filter((p) => {
      if (isAgentsMdExcluded(p, expanded)) {
        excluded.push(p);
        return false;
      }
      return true;
    });

  const result: T = {
    ...paths,
    project: filterPaths(paths.project),
    local: filterPaths(paths.local),
  };

  if (excluded.length > 0) {
    runLogger.debug(
      '[DEBUG] [MemoryDiscovery] Excluded memory files by agentsMdExcludes:',
      excluded.join(', '),
    );
  }

  return result;
}

// Simple console logger, similar to the one previously in CLI's config.ts
// TODO: Integrate with a more robust server-side logger if available/appropriate.
const logger = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (...args: any[]) =>
    runLogger.debug('[DEBUG] [MemoryDiscovery]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (...args: any[]) => runLogger.warn('[WARN] [MemoryDiscovery]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...args: any[]) =>
    runLogger.error('[ERROR] [MemoryDiscovery]', ...args),
};

export interface MemoryFileContent {
  filePath: string;
  content: string | null;
  error?: string;
  blockedExternalImports?: BlockedExternalImport[];
  /** Imports that failed (e.g. file not found, read error). */
  failedImports?: FailedImport[];
  /** File paths that were resolved and inlined via @import directives within this file. */
  resolvedImportPaths?: string[];
  /** Map from imported child path → immediate parent path. For hook parent_file_path field. */
  importParentMap?: Map<string, string>;
}

export const MAX_MEMORY_CHARACTER_COUNT = 40000;
const RULES_DIR_NAME = 'rules';
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type RuleTrigger = 'always_on' | 'manual' | 'glob' | 'model_decision';

export interface RuleFrontmatterMetadata {
  trigger: RuleTrigger;
  globs?: string[];
  description?: string;
}

export interface ModelDecisionRuleEntry {
  filePath: string;
  description: string;
}

export interface LargeMemoryFileInfo {
  path: string;
  characterCount: number;
}

export interface FailedMemoryFileInfo {
  path: string;
  error: string;
}

export function getLargeMemoryFiles(
  files: MemoryFileContent[],
): LargeMemoryFileInfo[] {
  return files
    .filter(
      (f): f is MemoryFileContent & { content: string } =>
        typeof f.content === 'string' &&
        f.content.length > MAX_MEMORY_CHARACTER_COUNT,
    )
    .map((f) => ({ path: f.filePath, characterCount: f.content.length }))
    .sort((a, b) => b.characterCount - a.characterCount);
}

export function getFailedMemoryFiles(
  files: MemoryFileContent[],
): FailedMemoryFileInfo[] {
  return files
    .filter(
      (f): f is MemoryFileContent & { error: string } =>
        f.content === null && typeof f.error === 'string',
    )
    .map((f) => ({ path: f.filePath, error: f.error }));
}

function expandBraces(pattern: string): string[] {
  const braceMatch = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/);
  if (!braceMatch) {
    return [pattern];
  }

  const prefix = braceMatch[1] || '';
  const alternatives = braceMatch[2] || '';
  const suffix = braceMatch[3] || '';
  return alternatives
    .split(',')
    .map((alt) => alt.trim())
    .filter(Boolean)
    .flatMap((alt) => expandBraces(prefix + alt + suffix));
}

function splitPathPatternString(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let braceDepth = 0;

  for (const char of input) {
    if (char === '{') {
      braceDepth++;
      current += char;
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      current += char;
    } else if ((char === ',' || char === '\n') && braceDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
      current = '';
    } else {
      current += char;
    }
  }

  const trimmed = current.trim();
  if (trimmed) {
    parts.push(trimmed);
  }

  return parts;
}

function normalizeFrontmatterPathPatterns(raw: unknown): string[] | undefined {
  let rawPatterns: string[];
  if (typeof raw === 'string') {
    rawPatterns = splitPathPatternString(raw);
  } else if (Array.isArray(raw)) {
    rawPatterns = raw
      .filter((item): item is string => typeof item === 'string')
      .flatMap(splitPathPatternString);
  } else {
    return undefined;
  }

  const patterns = rawPatterns
    .flatMap(expandBraces)
    .map((pattern) => pattern.trim())
    .map((pattern) =>
      pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern,
    )
    .filter((pattern) => pattern.length > 0 && pattern !== '**');

  return patterns.length > 0 ? patterns : undefined;
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeRuleTrigger(raw: unknown): RuleTrigger | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }

  const trigger = raw.trim();
  if (
    trigger === 'always_on' ||
    trigger === 'manual' ||
    trigger === 'glob' ||
    trigger === 'model_decision'
  ) {
    return trigger;
  }
  return undefined;
}

function normalizeFrontmatterBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw !== 'string') {
    return undefined;
  }

  const value = raw.trim().toLowerCase();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

function normalizeFrontmatterDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const description = raw.trim();
  return description.length > 0 ? description : undefined;
}

function extractFallbackPathPatternsFromFrontmatter(
  frontmatter: string,
  fieldName: 'paths' | 'glob',
): string[] | undefined {
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(new RegExp(`^${fieldName}:\\s*(.*)$`));
    if (!match) {
      continue;
    }

    const inlineValue = stripWrappingQuotes(match[1].trim());
    if (inlineValue) {
      return normalizeFrontmatterPathPatterns(inlineValue);
    }

    const listValues: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) {
        continue;
      }
      if (!/^\s+/.test(line)) {
        break;
      }
      const item = stripWrappingQuotes(line.replace(/^\s*-\s*/, '').trim());
      if (item) {
        listValues.push(item);
      }
    }
    return normalizeFrontmatterPathPatterns(listValues);
  }
  return undefined;
}

function extractFallbackPathsFromFrontmatter(
  frontmatter: string,
): string[] | undefined {
  return extractFallbackPathPatternsFromFrontmatter(frontmatter, 'paths');
}

function extractFallbackScalarFromFrontmatter(
  frontmatter: string,
  fieldName: 'trigger' | 'alwaysApply' | 'description',
): string | undefined {
  const lines = frontmatter.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(new RegExp(`^${fieldName}:\\s*(.*)$`));
    if (!match) {
      continue;
    }
    const value = stripWrappingQuotes(match[1].trim());
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

function parseRuleFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return null;
  }

  const frontmatter = match[1] ?? '';
  try {
    const parsed = loadYaml(frontmatter);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall back to a small parser below. Invalid frontmatter should not block
    // loading the instruction file itself.
  }

  return {
    trigger: extractFallbackScalarFromFrontmatter(frontmatter, 'trigger'),
    alwaysApply: extractFallbackScalarFromFrontmatter(
      frontmatter,
      'alwaysApply',
    ),
    description: extractFallbackScalarFromFrontmatter(
      frontmatter,
      'description',
    ),
    paths: extractFallbackPathsFromFrontmatter(frontmatter),
    glob: extractFallbackPathPatternsFromFrontmatter(frontmatter, 'glob'),
  };
}

export function extractRuleFrontmatterMetadata(
  content: string,
): RuleFrontmatterMetadata {
  const frontmatter = parseRuleFrontmatter(content);
  if (!frontmatter) {
    return { trigger: 'always_on' };
  }

  const explicitTrigger = normalizeRuleTrigger(frontmatter['trigger']);
  if (explicitTrigger === 'always_on') {
    return { trigger: 'always_on' };
  }
  if (explicitTrigger === 'manual') {
    return { trigger: 'manual' };
  }
  if (explicitTrigger === 'model_decision') {
    const description = normalizeFrontmatterDescription(
      frontmatter['description'],
    );
    return description
      ? { trigger: 'model_decision', description }
      : { trigger: 'manual' };
  }
  if (explicitTrigger === 'glob') {
    const globs = normalizeFrontmatterPathPatterns(frontmatter['glob']);
    return globs ? { trigger: 'glob', globs } : { trigger: 'manual' };
  }

  const alwaysApply = normalizeFrontmatterBoolean(frontmatter['alwaysApply']);
  if (alwaysApply === true) {
    return { trigger: 'always_on' };
  }
  if (alwaysApply === false) {
    return { trigger: 'manual' };
  }

  const legacyPathGlobs = normalizeFrontmatterPathPatterns(
    frontmatter['paths'],
  );
  return legacyPathGlobs
    ? { trigger: 'glob', globs: legacyPathGlobs }
    : { trigger: 'always_on' };
}

/**
 * Strips a leading YAML frontmatter block (`--- ... ---`) from rule content
 * before it is injected to the model: only the recognized leading block is
 * removed; the body (including any `---` inside code blocks) is preserved.
 * Returns the content unchanged when there is no frontmatter.
 *
 * Uses the same FRONTMATTER_REGEX as extractFrontmatterGlobs() so stripping and
 * glob extraction always agree on what counts as frontmatter.
 */
export function stripFrontmatter(content: string): string {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return content;
  }
  return content.slice(match[0].length);
}

/**
 * Extracts active file-matching rule globs from Markdown frontmatter.
 * Supports legacy `paths:` and desktop-compatible `trigger: glob` + `glob:`.
 */
export function extractFrontmatterGlobs(content: string): string[] | undefined {
  const metadata = extractRuleFrontmatterMetadata(content);
  return metadata.trigger === 'glob' ? metadata.globs : undefined;
}

/**
 * Deduplicates file paths by file identity (device + inode) rather than string path.
 * This is necessary on case-insensitive filesystems where different case variants
 * of the same filename resolve to the same physical file but have different path strings.
 *
 * @param filePaths Array of file paths to deduplicate
 * @returns Object containing deduplicated file paths and a map of path to identity key
 */
export async function deduplicatePathsByFileIdentity(
  filePaths: string[],
): Promise<{
  paths: string[];
  identityMap: Map<string, string>;
}> {
  if (filePaths.length === 0) {
    return {
      paths: [],
      identityMap: new Map<string, string>(),
    };
  }

  // first deduplicate by string path to avoid redundant stat calls
  const uniqueFilePaths = Array.from(new Set(filePaths));

  const fileIdentityMap = new Map<string, string>();
  const deduplicatedPaths: string[] = [];

  const CONCURRENT_LIMIT = 20;
  const results: Array<{
    path: string;
    dev: bigint | number | null;
    ino: bigint | number | null;
  }> = [];

  for (let i = 0; i < uniqueFilePaths.length; i += CONCURRENT_LIMIT) {
    const batch = uniqueFilePaths.slice(i, i + CONCURRENT_LIMIT);
    const batchPromises = batch.map(async (filePath) => {
      try {
        // use stat() instead of lstat() to follow symlinks and get target file identity
        const stats = await fs.stat(filePath);
        return {
          path: filePath,
          dev: stats.dev,
          ino: stats.ino,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(
          `could not stat file for deduplication: ${filePath}. error: ${message}`,
        );
        return {
          path: filePath,
          dev: null,
          ino: null,
        };
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);
    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        const message = getErrorMessage(result.reason);
        runLogger.debug(
          '[DEBUG] [MemoryDiscovery] unexpected error during deduplication stat:',
          message,
        );
      }
    }
  }

  const pathToIdentityMap = new Map<string, string>();
  for (const { path, dev, ino } of results) {
    if (dev !== null && ino !== null) {
      const identityKey = `${dev.toString()}:${ino.toString()}`;
      pathToIdentityMap.set(path, identityKey);
      if (!fileIdentityMap.has(identityKey)) {
        fileIdentityMap.set(identityKey, path);
        deduplicatedPaths.push(path);
        runLogger.debug(
          '[DEBUG] [MemoryDiscovery] deduplication: keeping',
          path,
          `(dev: ${dev}, ino: ${ino})`,
        );
      } else {
        const existingPath = fileIdentityMap.get(identityKey);
        runLogger.debug(
          '[DEBUG] [MemoryDiscovery] deduplication: skipping',
          path,
          `(same file as ${existingPath})`,
        );
      }
    } else {
      deduplicatedPaths.push(path);
    }
  }

  return {
    paths: deduplicatedPaths,
    identityMap: pathToIdentityMap,
  };
}

export async function findProjectRoot(
  startDir: string,
  boundaryMarkers: readonly string[] = ['.git'],
): Promise<string | null> {
  if (boundaryMarkers.length === 0) {
    return null;
  }

  let currentDir = normalizePath(startDir);
  while (true) {
    for (const marker of boundaryMarkers) {
      // Sanitize: skip markers with path traversal or absolute paths
      if (path.isAbsolute(marker) || marker.includes('..')) {
        continue;
      }
      const markerPath = path.join(currentDir, marker);
      try {
        // Check for existence only — marker can be a directory (normal repos)
        // or a file (submodules / worktrees).
        await fs.access(markerPath);
        return currentDir;
      } catch (error: unknown) {
        // Don't log ENOENT errors as they're expected when marker doesn't exist
        // Also don't log errors in test environments, which often have mocked fs
        const isENOENT =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code: string }).code === 'ENOENT';

        // Only log unexpected errors in non-test environments
        // process.env['NODE_ENV'] === 'test' or VITEST are common test indicators
        const isTestEnv =
          process.env['NODE_ENV'] === 'test' || process.env['VITEST'];

        if (!isENOENT && !isTestEnv) {
          if (typeof error === 'object' && error !== null && 'code' in error) {
            const fsError = error as { code: string; message: string };
            logger.warn(
              `Error checking for ${marker} at ${markerPath}: ${fsError.message}`,
            );
          } else {
            logger.warn(
              `Non-standard error checking for ${marker} at ${markerPath}: ${String(error)}`,
            );
          }
        }
      }
    }
    const parentDir = normalizePath(path.dirname(currentDir));
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export async function readMemoryMdFiles(
  filePaths: string[],
  importFormat: 'flat' | 'tree' = 'tree',
  boundaryMarkers: readonly string[] = ['.git'],
  includeExternal: boolean = false,
  contextFileNames: readonly string[] = DEFAULT_CONTEXT_FILENAMES,
): Promise<MemoryFileContent[]> {
  // Process files in parallel with concurrency limit to prevent EMFILE errors
  const CONCURRENT_LIMIT = 20; // Higher limit for file reads as they're typically faster
  const results: MemoryFileContent[] = [];

  for (let i = 0; i < filePaths.length; i += CONCURRENT_LIMIT) {
    const batch = filePaths.slice(i, i + CONCURRENT_LIMIT);
    const batchPromises = batch.map(
      async (filePath): Promise<MemoryFileContent> => {
        try {
          const rawContent = await fs.readFile(filePath, 'utf-8');
          // Strip the leading frontmatter block from rule files so the model
          // never sees internal routing metadata (matches cc's
          // parseFrontmatter). Glob matching reads the file separately, so this
          // does not affect rule selection.
          const content = isRuleMemoryPath(filePath)
            ? stripFrontmatter(rawContent)
            : rawContent;

          // Process imports in the content.
          // Seed processedFiles with the root file path so that circular
          // imports (e.g. A→B→A) are detected in tree mode without relying
          // solely on maxDepth.
          const processedResult = await processImports(
            content,
            path.dirname(filePath),
            false,
            {
              processedFiles: new Set([filePath]),
              maxDepth: 5,
              currentDepth: 0,
              currentFile: filePath,
            },
            undefined,
            importFormat,
            boundaryMarkers,
            includeExternal,
          );
          // Strip block-level HTML comments (preserves comments inside code blocks)
          const { content: strippedContent, stripped } = stripHtmlComments(
            processedResult.content,
          );
          if (stripped) {
            runLogger.debug(
              '[DEBUG] [MemoryDiscovery] Stripped HTML comments from:',
              filePath,
            );
          }

          runLogger.debug(
            '[DEBUG] [MemoryDiscovery] Successfully read and processed imports:',
            filePath,
            `(Length: ${strippedContent.length})`,
          );

          const importParentMap = collectImportParentMap(
            processedResult.importTree.imports ?? [],
            filePath,
          );

          return {
            filePath,
            content: strippedContent,
            blockedExternalImports:
              processedResult.blockedExternalImports.length > 0
                ? processedResult.blockedExternalImports
                : undefined,
            failedImports:
              processedResult.failedImports.length > 0
                ? processedResult.failedImports
                : undefined,
            resolvedImportPaths:
              processedResult.resolvedImportPaths.length > 0
                ? processedResult.resolvedImportPaths
                : undefined,
            importParentMap:
              importParentMap.size > 0 ? importParentMap : undefined,
          };
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          const isTestEnv =
            process.env['NODE_ENV'] === 'test' || process.env['VITEST'];
          if (!isTestEnv) {
            logger.warn(
              `Warning: Could not read ${contextFileNames.join(', ')} file at ${filePath}. Error: ${message}`,
            );
          }
          runLogger.debug(
            '[DEBUG] [MemoryDiscovery] Failed to read:',
            filePath,
          );
          return { filePath, content: null, error: message };
        }
      },
    );

    const batchResults = await Promise.allSettled(batchPromises);

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        // This case shouldn't happen since we catch all errors above,
        // but handle it for completeness
        const error = result.reason;
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Unexpected error processing file: ${message}`);
      }
    }
  }

  return results;
}

export function concatenateInstructions(
  instructionContents: MemoryFileContent[],
): string {
  return instructionContents
    .filter((item) => typeof item.content === 'string')
    .map((item) => {
      const trimmedContent = (item.content as string).trim();
      if (trimmedContent.length === 0) {
        return null;
      }
      return `--- Context from: ${item.filePath} ---\n${trimmedContent}\n--- End of Context from: ${item.filePath} ---`;
    })
    .filter((block): block is string => block !== null)
    .join('\n\n');
}

export interface MemoryLoadResult {
  files: Array<{ path: string; content: string }>;
  fileIdentities?: string[];
  blockedExternalImports?: BlockedExternalImport[];
  /** Imports that failed (e.g. file not found). */
  failedImports?: FailedImport[];
  /** File paths resolved via @import within the loaded files. */
  resolvedImportPaths?: string[];
  /** Map from imported child path → immediate parent path. */
  importParentMap?: Map<string, string>;
}

/** User-scope context-file candidates, independent of any session. */
export function getGlobalContextFilePaths(
  contextFileNames: readonly string[] = DEFAULT_CONTEXT_FILENAMES,
): string[] {
  const userConfigRoot = getConfigHomeDir();
  return contextFileNames.map((filename) =>
    normalizePath(path.join(userConfigRoot, filename)),
  );
}

export async function getGlobalMemoryPaths(
  contextFileNames: readonly string[] = DEFAULT_CONTEXT_FILENAMES,
): Promise<string[]> {
  const userConfigRoot = getConfigHomeDir();

  const accessChecks = contextFileNames.map(async (filename) => {
    const globalPath = normalizePath(path.join(userConfigRoot, filename));
    try {
      await fs.access(globalPath, fsSync.constants.F_OK);
      runLogger.debug(
        '[DEBUG] [MemoryDiscovery] Found global memory file:',
        globalPath,
      );
      return globalPath;
    } catch {
      return null;
    }
  });

  // Always-on user-scope rules load eagerly across every project. Glob-triggered
  // user rules load on demand via loadJitSubdirectoryMemory instead.
  const [agentsMdPaths, userRulePaths] = await Promise.all([
    Promise.all(accessChecks),
    selectRuleFiles(getUserRulesDir(), userConfigRoot, { conditional: false }),
  ]);

  return [
    ...agentsMdPaths.filter((p): p is string => p !== null),
    ...userRulePaths,
  ];
}

export async function getEnvironmentMemoryPaths(
  trustedRoots: string[],
  contextFileNames: readonly string[] = DEFAULT_CONTEXT_FILENAMES,
  boundaryMarkers: readonly string[] = ['.git'],
  rulesRoot?: string,
): Promise<{ project: string[]; local: string[] }> {
  const projectPaths = new Set<string>();
  const localPaths = new Set<string>();

  // Trusted Roots Upward Traversal (Parallelized)
  const traversalPromises = trustedRoots.map(async (root) => {
    const resolvedRoot = normalizePath(root);
    const gitRoot = await findProjectRoot(resolvedRoot, boundaryMarkers);
    const ceiling = gitRoot ? normalizePath(gitRoot) : resolvedRoot;
    runLogger.debug(
      '[DEBUG] [MemoryDiscovery] Loading environment memory for trusted root:',
      resolvedRoot,
      '(Stopping at',
      gitRoot
        ? `git root: ${ceiling})`
        : `trusted root: ${ceiling} — no git root found)`,
    );
    // Additional roots load instruction files without eagerly loading rules.
    return findUpwardMemoryFiles(
      resolvedRoot,
      ceiling,
      contextFileNames,
      undefined,
      rulesRoot === undefined || resolvedRoot === normalizePath(rulesRoot),
    );
  });

  const resultArrays = await Promise.all(traversalPromises);
  for (const result of resultArrays) {
    result.project.forEach((p) => projectPaths.add(p));
    result.local.forEach((p) => localPaths.add(p));
  }

  return {
    project: Array.from(projectPaths).sort(),
    local: Array.from(localPaths).sort(),
  };
}

export function categorizeAndConcatenate(
  paths: {
    global: string[];
    plugin: string[];
    project: string[];
    local?: string[];
  },
  contentsMap: Map<string, MemoryFileContent>,
): HierarchicalMemory {
  const getConcatenated = (pList: string[]) =>
    concatenateInstructions(
      pList
        .map((p) => contentsMap.get(p))
        .filter((c): c is MemoryFileContent => !!c),
    );

  return {
    global: getConcatenated(paths.global),
    plugin: getConcatenated(paths.plugin),
    project: getConcatenated(paths.project),
    local: getConcatenated(paths.local ?? []),
  };
}

/**
 * Checks if a file exists, returning its normalized path or null.
 * Returns the path even if the file is not readable, so that downstream
 * consumers (readMemoryMdFiles) can report a proper load-failure diagnostic
 * instead of silently skipping the file.
 */
async function checkReadableFile(
  dir: string,
  filename: string,
): Promise<string | null> {
  const potentialPath = normalizePath(path.join(dir, filename));
  try {
    await fs.access(potentialPath, fsSync.constants.F_OK);
    return potentialPath;
  } catch {
    return null;
  }
}

function shouldSkipRuleAccessError(
  error: unknown,
  operation: 'realpath' | 'readdir' | 'readFile',
  targetPath: string,
): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === 'EACCES' || code === 'EPERM') {
    // 可选规则的访问限制不应阻断会话初始化，但必须保留可定位的诊断信息。
    runLogger.warn('[MemoryDiscovery] 跳过不可访问的规则路径', {
      operation,
      code,
      path: targetPath,
    });
    return true;
  }
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function collectMarkdownRuleFiles(
  rulesDir: string,
  visitedDirs: Set<string> = new Set(),
): Promise<string[]> {
  let realRulesDir: string;
  try {
    realRulesDir = normalizePath(await fs.realpath(rulesDir));
  } catch (error: unknown) {
    if (shouldSkipRuleAccessError(error, 'realpath', rulesDir)) {
      return [];
    }
    throw error;
  }

  if (visitedDirs.has(realRulesDir)) {
    return [];
  }
  visitedDirs.add(realRulesDir);

  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(rulesDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (shouldSkipRuleAccessError(error, 'readdir', rulesDir)) {
      return [];
    }
    throw error;
  }

  const result: string[] = [];
  for (const entry of entries) {
    const entryPath = normalizePath(path.join(rulesDir, entry.name));
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      try {
        const stats = await fs.stat(entryPath);
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
      } catch {
        continue;
      }
    }

    if (isDirectory) {
      result.push(...(await collectMarkdownRuleFiles(entryPath, visitedDirs)));
    } else if (
      isFile &&
      (entry.name.endsWith('.md') || entry.name.endsWith('.mdc'))
    ) {
      result.push(entryPath);
    }
  }

  return result.sort();
}

async function readRuleFrontmatterMetadata(
  rulePath: string,
): Promise<RuleFrontmatterMetadata> {
  try {
    const content = await fs.readFile(rulePath, 'utf-8');
    return extractRuleFrontmatterMetadata(content);
  } catch (error: unknown) {
    if (shouldSkipRuleAccessError(error, 'readFile', rulePath)) {
      return { trigger: 'manual' };
    }
    throw error;
  }
}

function ruleGlobsMatchTarget(
  globs: string[],
  baseDir: string,
  targetPath: string,
): boolean {
  const relativePath = path.isAbsolute(targetPath)
    ? path.relative(baseDir, targetPath).replaceAll('\\', '/')
    : targetPath.replaceAll('\\', '/');

  if (
    !relativePath ||
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
    return false;
  }

  try {
    return ignore().add(globs).ignores(relativePath);
  } catch {
    return picomatch.isMatch(relativePath, globs, {
      dot: true,
      nocase: process.platform === 'darwin' || process.platform === 'win32',
    });
  }
}

/** Absolute path to the user-scope rules directory (`~/.qwen/rules`). */
export function getUserRulesDir(): string {
  return path.join(getConfigHomeDir(), RULES_DIR_NAME);
}

/**
 * Selects rule files from `rulesDir`.
 *  - unconditional (`conditional: false`): always-on rules.
 *  - conditional (`conditional: true`): rules whose frontmatter globs match
 *    `targetPath`, evaluated relative to `globBaseDir`.
 *
 * `globBaseDir` is the directory that rule globs are resolved against — the
 * directory containing `.qwen/` for project rules, or the current project root
 * for user-scope rules.
 */
async function selectRuleFiles(
  rulesDir: string,
  globBaseDir: string,
  options:
    | { conditional: false }
    | { conditional: true; targetPath: string },
): Promise<string[]> {
  const ruleFiles = await collectMarkdownRuleFiles(rulesDir);
  if (ruleFiles.length === 0) {
    return [];
  }

  const selected: string[] = [];
  for (const ruleFile of ruleFiles) {
    const metadata = await readRuleFrontmatterMetadata(ruleFile);
    if (!options.conditional) {
      if (metadata.trigger === 'always_on') {
        selected.push(ruleFile);
      }
      continue;
    }

    if (
      metadata.trigger === 'glob' &&
      metadata.globs &&
      ruleGlobsMatchTarget(
        metadata.globs,
        normalizePath(globBaseDir),
        options.targetPath,
      )
    ) {
      selected.push(ruleFile);
    }
  }

  return selected.sort();
}

async function getRuleMemoryFilePathsForDirectory(
  baseDir: string,
  options:
    | { conditional: false }
    | { conditional: true; targetPath: string },
): Promise<string[]> {
  return selectRuleFiles(
    path.join(baseDir, CONFIG_DIR, RULES_DIR_NAME),
    baseDir,
    options,
  );
}

async function selectModelDecisionRuleEntries(
  rulesDir: string,
): Promise<ModelDecisionRuleEntry[]> {
  const ruleFiles = await collectMarkdownRuleFiles(rulesDir);
  if (ruleFiles.length === 0) {
    return [];
  }

  const entries: ModelDecisionRuleEntry[] = [];
  for (const ruleFile of ruleFiles) {
    const metadata = await readRuleFrontmatterMetadata(ruleFile);
    if (metadata.trigger === 'model_decision' && metadata.description) {
      entries.push({
        filePath: ruleFile,
        description: metadata.description,
      });
    }
  }
  return entries.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/** Model-decision user rules (`~/.qwen/rules`) are described to the model,
 * but their bodies are not automatically injected. */
export async function getUserModelDecisionRuleEntries(): Promise<
  ModelDecisionRuleEntry[]
> {
  return selectModelDecisionRuleEntries(getUserRulesDir());
}

async function getModelDecisionRuleEntriesForDirectory(
  baseDir: string,
): Promise<ModelDecisionRuleEntry[]> {
  return selectModelDecisionRuleEntries(
    path.join(baseDir, CONFIG_DIR, RULES_DIR_NAME),
  );
}

/**
 * Traverses upward from startDir to stopDir, finding all GEMINI.md variants
 * and their .local.md counterparts.
 *
 * Files are ordered by directory level (root to leaf), with all filename
 * variants grouped together per directory.
 */
async function findUpwardMemoryFiles(
  startDir: string,
  stopDir: string,
  contextFileNames: readonly string[],
  conditionalRuleTargetPath?: string,
  includeRules = true,
): Promise<{ project: string[]; local: string[] }> {
  const upwardProjectPaths: string[] = [];
  const upwardLocalPaths: string[] = [];
  let currentDir = normalizePath(startDir);
  const resolvedStopDir = normalizePath(stopDir);
  const localMdFilenames = deriveLocalContextFilenames(contextFileNames);
  const globalConfigDir = normalizePath(getConfigHomeDir());

  runLogger.debug(
    '[DEBUG] [MemoryDiscovery] Starting upward search from',
    currentDir,
    'stopping at',
    resolvedStopDir,
  );

  while (true) {
    if (currentDir === globalConfigDir) {
      break;
    }

    // Parallelize checks for all filename variants in the current directory
    const allChecks = [
      ...contextFileNames.map((f) => checkReadableFile(currentDir, f)),
      ...localMdFilenames.map((f) => checkReadableFile(currentDir, f)),
    ];
    const results = await Promise.all(allChecks);

    const projectCount = contextFileNames.length;
    const foundProject = results
      .slice(0, projectCount)
      .filter((p): p is string => p !== null);
    const foundLocal = results
      .slice(projectCount)
      .filter((p): p is string => p !== null);
    const foundUnconditionalRules = includeRules
      ? await getRuleMemoryFilePathsForDirectory(currentDir, { conditional: false })
      : [];
    const foundConditionalRules =
      includeRules && conditionalRuleTargetPath
        ? await getRuleMemoryFilePathsForDirectory(currentDir, {
            conditional: true,
            targetPath: conditionalRuleTargetPath,
          })
        : [];

    if (foundLocal.length > 0) {
      runLogger.debug(
        '[DEBUG] [MemoryDiscovery] Found local memory file(s):',
        foundLocal.join(', '),
      );
    }

    upwardProjectPaths.unshift(
      ...foundProject,
      ...foundUnconditionalRules,
      ...foundConditionalRules,
    );
    upwardLocalPaths.unshift(...foundLocal);

    const parentDir = normalizePath(path.dirname(currentDir));
    if (currentDir === resolvedStopDir || currentDir === parentDir) {
      break;
    }
    currentDir = parentDir;
  }
  return { project: upwardProjectPaths, local: upwardLocalPaths };
}

async function findUpwardModelDecisionRuleEntries(
  startDir: string,
  stopDir: string,
): Promise<ModelDecisionRuleEntry[]> {
  const entries: ModelDecisionRuleEntry[] = [];
  let currentDir = normalizePath(startDir);
  const resolvedStopDir = normalizePath(stopDir);
  const globalConfigDir = normalizePath(getConfigHomeDir());

  while (true) {
    if (currentDir === globalConfigDir) {
      break;
    }

    entries.unshift(
      ...(await getModelDecisionRuleEntriesForDirectory(currentDir)),
    );

    const parentDir = normalizePath(path.dirname(currentDir));
    if (currentDir === resolvedStopDir || currentDir === parentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return entries;
}

export async function getEnvironmentModelDecisionRuleEntries(
  trustedRoots: string[],
  boundaryMarkers: readonly string[] = ['.git'],
): Promise<ModelDecisionRuleEntry[]> {
  const entriesByPath = new Map<string, ModelDecisionRuleEntry>();

  await Promise.all(
    trustedRoots.map(async (root) => {
      const resolvedRoot = normalizePath(root);
      const gitRoot = await findProjectRoot(resolvedRoot, boundaryMarkers);
      const ceiling = gitRoot ? normalizePath(gitRoot) : resolvedRoot;
      const entries = await findUpwardModelDecisionRuleEntries(
        resolvedRoot,
        ceiling,
      );
      for (const entry of entries) {
        entriesByPath.set(entry.filePath, entry);
      }
    }),
  );

  return Array.from(entriesByPath.values()).sort((a, b) =>
    a.filePath.localeCompare(b.filePath),
  );
}

export function renderModelDecisionRuleEntries(
  entries: readonly ModelDecisionRuleEntry[],
): string {
  const uniqueEntries = Array.from(
    new Map(entries.map((entry) => [entry.filePath, entry])).values(),
  ).sort((a, b) => a.filePath.localeCompare(b.filePath));

  if (uniqueEntries.length === 0) {
    return '';
  }

  const lines = uniqueEntries.map(
    (entry) => `- ${entry.filePath}: ${entry.description}`,
  );
  return [
    'The following rule files are available but not loaded automatically.',
    'When a description matches the task, read the listed file before following its instructions.',
    ...lines,
  ].join('\n');
}

/** 项目规则文件（`.qwen/rules/` 下的 `.md` 或 `.mdc`）的磁盘原始状态。
 *  Used to seed readFileState so mid-session rule edits surface as
 *  edited_text_file, mirroring the auto-memory MEMORY.md change-detection path
 *  (see ScopedMemoryIndexFileState). */
export interface RuleFileState {
  /** Absolute path to the rule file. */
  rulePath: string;
  /** Raw on-disk bytes captured at load time. */
  content: string;
  /** Floor of the file's mtimeMs. */
  timestamp: number;
  /** True when the injected memory view (imports inlined, HTML comments
   *  stripped) differs from raw disk bytes, so Edit/Write still require a
   *  real Read first. */
  isPartialView?: boolean;
}

/** Raw on-disk file state for a startup-loaded static memory file.
 *  Used to seed readFileState so mid-session AGENTS.md edits surface as
 *  edited_text_file. */
export interface StaticMemoryFileState {
  /** Absolute path to the memory file. */
  filePath: string;
  /** Raw on-disk bytes captured at load time. */
  content: string;
  /** Floor of the file's mtimeMs. */
  timestamp: number;
  /** True when the injected memory view differs from raw disk bytes. */
  isPartialView?: boolean;
}

// Config-directory validation forbids path separators, so the final two
// normalized segments are always exactly <CONFIG_DIR>/<RULES_DIR_NAME>.
const RULES_PATH_MARKER = `/${normalizePath(
  path.join(CONFIG_DIR, RULES_DIR_NAME),
)
  .split('/')
  .slice(-2)
  .join('/')}/`;

/** True when `filePath` is a rule file under either the configured project
 *  directory or the resolved user config root. */
export function isRuleMemoryPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  if (normalized.includes(RULES_PATH_MARKER)) {
    return true;
  }
  // User-scope rules live under the global config dir, whose basename may
  // differ from the project CONFIG_DIR (e.g. site-specific builds).
  return normalized.startsWith(`${normalizePath(getUserRulesDir())}/`);
}

/**
 * Reads raw on-disk file state for every loaded project rule file so callers
 * can seed readFileState for mid-session change detection. The injected memory
 * view may differ from disk (imports inlined, HTML comments stripped);
 * `isPartialView` is set in that case so Edit/Write require an explicit Read.
 *
 * `contentsMap` is the processed-content map from the current refresh, keyed by
 * the same paths as `projectPaths`; a missing entry just means we fall back to
 * treating the raw bytes as the injected view (isPartialView=false).
 */
export async function loadRuleFileStates(
  projectPaths: readonly string[],
  contentsMap: Map<string, MemoryFileContent>,
): Promise<RuleFileState[]> {
  const out: RuleFileState[] = [];
  await Promise.all(
    projectPaths
      .filter((p) => isRuleMemoryPath(p))
      .map(async (rulePath) => {
        try {
          const [stats, raw] = await Promise.all([
            fs.stat(rulePath),
            fs.readFile(rulePath, 'utf-8'),
          ]);
          const injected = contentsMap.get(rulePath)?.content ?? null;
          out.push({
            rulePath,
            content: raw,
            timestamp: Math.floor(stats.mtimeMs),
            isPartialView: injected !== null && injected !== raw,
          });
        } catch {
          // File vanished between discovery and read — nothing to watch.
        }
      }),
  );
  return out;
}

/**
 * Reads raw on-disk file state for startup-loaded non-rule static memory files,
 * including AGENTS.md roots and @import-resolved children. The injected memory
 * view can differ from disk when imports or HTML-comment stripping were applied;
 * `isPartialView` preserves the existing Read-before-Edit/Write guard in that
 * case while still allowing edited_text_file change detection.
 */
export async function loadStaticMemoryFileStates(
  loadedPaths: readonly string[],
  contentsMap: Map<string, MemoryFileContent>,
): Promise<StaticMemoryFileState[]> {
  const out: StaticMemoryFileState[] = [];
  const uniquePaths = Array.from(new Set(loadedPaths)).filter(
    (filePath) => !isRuleMemoryPath(filePath),
  );

  await Promise.all(
    uniquePaths.map(async (filePath) => {
      try {
        const [stats, raw] = await Promise.all([
          fs.stat(filePath),
          fs.readFile(filePath, 'utf-8'),
        ]);
        const injected = contentsMap.get(filePath)?.content ?? null;
        out.push({
          filePath,
          content: raw,
          timestamp: Math.floor(stats.mtimeMs),
          isPartialView: injected === null || injected !== raw,
        });
      } catch {
        // File vanished between discovery and read — nothing to watch.
      }
    }),
  );

  return out;
}

export async function loadJitSubdirectoryMemory(
  targetPath: string,
  trustedRoots: string[],
  alreadyLoadedPaths: Set<string>,
  contextFileNames: readonly string[] = DEFAULT_CONTEXT_FILENAMES,
  alreadyLoadedIdentities?: Set<string>,
  boundaryMarkers: readonly string[] = ['.git'],
  includeExternal: boolean = false,
): Promise<MemoryLoadResult> {
  const resolvedTarget = normalizePath(targetPath);
  let bestRoot: string | null = null;

  // Find the deepest trusted root that contains the target path
  for (const root of trustedRoots) {
    if (isSubpath(root, targetPath)) {
      const resolvedRoot = normalizePath(root);
      if (!bestRoot || resolvedRoot.length > bestRoot.length) {
        bestRoot = resolvedRoot;
      }
    }
  }

  if (!bestRoot) {
    runLogger.debug(
      '[DEBUG] [MemoryDiscovery] JIT memory skipped:',
      resolvedTarget,
      'is not in any trusted root.',
    );
    return { files: [], fileIdentities: [] };
  }

  // Find the git root to use as the traversal ceiling.
  // If no git root exists, fall back to the trusted root as the ceiling.
  const gitRoot = await findProjectRoot(bestRoot, boundaryMarkers);
  const resolvedCeiling = gitRoot ? normalizePath(gitRoot) : bestRoot;

  runLogger.debug(
    '[DEBUG] [MemoryDiscovery] Loading JIT memory for',
    resolvedTarget,
    `(Trusted root: ${bestRoot}, Ceiling: ${resolvedCeiling}${gitRoot ? ' [git root]' : ' [trusted root, no git]'})`,
  );

  // Resolve the target to a directory before traversing upward.
  // When the target is a file (e.g. /app/src/file.ts), start from its
  // parent directory to avoid a wasted fs.access check on a nonsensical
  // path like /app/src/file.ts/GEMINI.md.
  let startDir = resolvedTarget;
  try {
    const stat = await fs.stat(resolvedTarget);
    if (stat.isFile()) {
      startDir = normalizePath(path.dirname(resolvedTarget));
    }
  } catch {
    // If stat fails (e.g. file doesn't exist yet for write_file),
    // assume it's a file path and use its parent directory.
    startDir = normalizePath(path.dirname(resolvedTarget));
  }

  // Traverse from the resolved directory up to the ceiling
  const traversalResult = await findUpwardMemoryFiles(
    startDir,
    resolvedCeiling,
    contextFileNames,
    resolvedTarget,
  );

  // Glob-triggered user-scope rules load on demand when the accessed file
  // matches their globs. Globs are resolved relative to the trusted root
  // containing the target, matching cc's CWD-relative base for User rules.
  const userConditionalRules = await selectRuleFiles(getUserRulesDir(), bestRoot, {
    conditional: true,
    targetPath: resolvedTarget,
  });

  const potentialPaths = [
    ...traversalResult.project,
    ...traversalResult.local,
    ...userConditionalRules,
  ];

  if (potentialPaths.length === 0) {
    return { files: [], fileIdentities: [] };
  }

  // deduplicate by file identity to handle case-insensitive filesystems
  // this deduplicates within the current batch
  const { paths: deduplicatedNewPaths, identityMap: newPathsIdentityMap } =
    await deduplicatePathsByFileIdentity(potentialPaths);

  // Use cached file identities if provided, otherwise build from paths
  // This avoids redundant fs.stat() calls on already loaded files
  const cachedIdentities = alreadyLoadedIdentities ?? new Set<string>();
  if (!alreadyLoadedIdentities && alreadyLoadedPaths.size > 0) {
    const CONCURRENT_LIMIT = 20;
    const alreadyLoadedArray = Array.from(alreadyLoadedPaths);

    for (let i = 0; i < alreadyLoadedArray.length; i += CONCURRENT_LIMIT) {
      const batch = alreadyLoadedArray.slice(i, i + CONCURRENT_LIMIT);
      const batchPromises = batch.map(async (filePath) => {
        try {
          const stats = await fs.stat(filePath);
          const identityKey = `${stats.dev.toString()}:${stats.ino.toString()}`;
          cachedIdentities.add(identityKey);
        } catch {
          // ignore errors - if we can't stat it, we can't deduplicate by identity
        }
      });
      // Await each batch to properly limit concurrency and prevent EMFILE errors
      await Promise.allSettled(batchPromises);
    }
  }

  // filter out paths that match already loaded files by identity
  // reuse the identities from deduplicatePathsByFileIdentity to avoid redundant stat calls
  const newPaths: string[] = [];
  const newFileIdentities: string[] = [];
  for (const filePath of deduplicatedNewPaths) {
    const identityKey = newPathsIdentityMap.get(filePath);
    if (identityKey && cachedIdentities.has(identityKey)) {
      runLogger.debug(
        '[DEBUG] [MemoryDiscovery] jit memory: skipping',
        filePath,
        '(already loaded with different case)',
      );
      continue;
    }
    // if we don't have an identity (stat failed), include it to be safe
    newPaths.push(filePath);
    if (identityKey) {
      newFileIdentities.push(identityKey);
    }
  }

  if (newPaths.length === 0) {
    return { files: [], fileIdentities: [] };
  }

  runLogger.debug(
    '[DEBUG] [MemoryDiscovery] Found new JIT memory files:',
    JSON.stringify(newPaths),
  );

  const contents = await readMemoryMdFiles(
    newPaths,
    'tree',
    boundaryMarkers,
    includeExternal,
    contextFileNames,
  );

  // Collect blocked external imports, failed imports, and import parent maps from JIT-loaded files
  const blockedExternalImports: BlockedExternalImport[] = [];
  const failedImports: FailedImport[] = [];
  const resolvedImportPaths: string[] = [];
  const importParentMap = new Map<string, string>();
  for (const item of contents) {
    if (item.blockedExternalImports && item.blockedExternalImports.length > 0) {
      blockedExternalImports.push(...item.blockedExternalImports);
    }
    if (item.failedImports && item.failedImports.length > 0) {
      failedImports.push(...item.failedImports);
    }
    if (item.resolvedImportPaths && item.resolvedImportPaths.length > 0) {
      resolvedImportPaths.push(...item.resolvedImportPaths);
    }
    if (item.importParentMap) {
      for (const [child, parent] of item.importParentMap) {
        importParentMap.set(child, parent);
      }
    }
  }

  return {
    files: contents
      .filter((item) => item.content !== null)
      .map((item) => ({
        path: item.filePath,

        content: item.content as string,
      })),
    fileIdentities: newFileIdentities,
    blockedExternalImports,
    failedImports: failedImports.length > 0 ? failedImports : undefined,
    resolvedImportPaths:
      resolvedImportPaths.length > 0 ? resolvedImportPaths : undefined,
    importParentMap: importParentMap.size > 0 ? importParentMap : undefined,
  };
}
