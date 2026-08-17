/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isSubpath } from './paths.js';
import { marked, type Token } from 'marked';
import { createDebugLogger } from './debugLogger.js';
import { findProjectRoot } from './projectRoot.js';

const logger = createDebugLogger('IMPORT_PROCESSOR');

/**
 * Interface for tracking import processing state to prevent circular imports
 */
interface ImportState {
  processedFiles: Set<string>;
  maxDepth: number;
  currentDepth: number;
  currentFile?: string; // Track the current file being processed
}

/**
 * Interface representing a file in the import tree
 */
export interface MemoryFile {
  path: string;
  imports?: MemoryFile[]; // Direct imports, in the order they were imported
}

/**
 * Result of processing imports
 */
export interface ProcessImportsResult {
  content: string;
  importTree: MemoryFile;
}

export interface ImportedFileNotification {
  filePath: string;
  parentFilePath: string;
}

export interface ProcessImportsOptions {
  onFileImported?: (
    notification: ImportedFileNotification,
  ) => void | Promise<void>;
}

async function notifyFileImported(
  options: ProcessImportsOptions | undefined,
  notification: ImportedFileNotification,
): Promise<void> {
  try {
    await options?.onFileImported?.(notification);
  } catch (error) {
    logger.warn(
      `onFileImported callback failed for ${notification.filePath}: ${
        hasMessage(error) ? error.message : 'Unknown error'
      }`,
    );
  }
}

// `findProjectRoot` now lives in `./projectRoot.ts` and is shared with
// memoryDiscovery. It returns `string | null`; `processImports` below
// preserves the previous "fall back to startDir" contract at the call
// site, so behavior for code paths that don't care about the difference
// (a non-git scratch dir for example) is unchanged.

// Add a type guard for error objects
function hasMessage(err: unknown): err is { message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  );
}

// Helper to find all code block and inline code regions using marked
/**
 * Finds all import statements in content without using regex
 * @returns Array of {start, _end, path} objects for each import found
 */
function findImports(
  content: string,
): Array<{ start: number; _end: number; path: string }> {
  const imports: Array<{ start: number; _end: number; path: string }> = [];
  let i = 0;
  const len = content.length;

  while (i < len) {
    // Find next @ symbol
    i = content.indexOf('@', i);
    if (i === -1) break;

    // Check if it's a word boundary (not part of another word)
    if (i > 0 && !isWhitespace(content[i - 1])) {
      i++;
      continue;
    }

    // Find the end of the import path (whitespace or newline)
    let j = i + 1;
    while (
      j < len &&
      !isWhitespace(content[j]) &&
      content[j] !== '\n' &&
      content[j] !== '\r'
    ) {
      j++;
    }

    // Extract the path (everything after @)
    const importPath = content.slice(i + 1, j);

    // Basic validation (starts with ./ or / or letter)
    if (
      importPath.length > 0 &&
      (importPath[0] === '.' ||
        importPath[0] === '/' ||
        isLetter(importPath[0]))
    ) {
      imports.push({
        start: i,
        _end: j,
        path: importPath,
      });
    }

    i = j + 1;
  }

  return imports;
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function isLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122)
  ); // a-z
}

/**
 * Checks if an error is a "file not found" error (ENOENT)
 */
function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

function findCodeRegions(content: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  const tokens = marked.lexer(content);
  let offset = 0;

  function walk(token: Token, baseOffset: number) {
    if (token.type === 'code' || token.type === 'codespan') {
      regions.push([baseOffset, baseOffset + token.raw.length]);
    }

    if ('tokens' in token && token.tokens) {
      let childOffset = 0;
      for (const child of token.tokens) {
        const childIndexInParent = token.raw.indexOf(child.raw, childOffset);
        if (childIndexInParent === -1) {
          logger.error(
            `Could not find child token in parent raw content. Aborting parsing for this branch. Child raw: "${child.raw}"`,
          );
          break;
        }
        walk(child, baseOffset + childIndexInParent);
        childOffset = childIndexInParent + child.raw.length;
      }
    }
  }

  for (const token of tokens) {
    walk(token, offset);
    offset += token.raw.length;
  }

  return regions;
}

/**
 * Processes import statements in QWEN.md content
 * Supports @path/to/file syntax for importing content from other files
 * @param content - The content to process for imports
 * @param basePath - The directory path where the current file is located
 * @param importState - State tracking for circular import prevention
 * @param projectRoot - The project root directory for allowed directories
 * @param importFormat - The format of the import tree
 * @returns Processed content with imports resolved and import tree
 */
export async function processImports(
  content: string,
  basePath: string,
  importState: ImportState = {
    processedFiles: new Set(),
    maxDepth: 5,
    currentDepth: 0,
  },
  projectRoot?: string,
  importFormat: 'flat' | 'tree' = 'tree',
  options: ProcessImportsOptions = {},
): Promise<ProcessImportsResult> {
  if (!projectRoot) {
    // Preserve the previous local helper's contract: if no `.git`
    // ancestor exists, fall back to the absolute basePath so
    // `@`-imports can still resolve relatively.
    projectRoot = (await findProjectRoot(basePath)) ?? path.resolve(basePath);
  }

  if (importState.currentDepth >= importState.maxDepth) {
    logger.warn(
      `Maximum import depth (${importState.maxDepth}) reached. Stopping import processing.`,
    );
    return {
      content,
      importTree: { path: importState.currentFile || 'unknown' },
    };
  }

  // --- FLAT FORMAT LOGIC ---
  if (importFormat === 'flat') {
    // Collect files in order of first encounter, deduplicated by the depth map
    // below rather than by a plain set.
    const flatFiles: Array<{ path: string; content: string }> = [];
    // Track the shallowest depth each file has been expanded at, rather than a
    // plain "seen" set. Once a depth limit exists the two differ: a file first
    // reached down a long chain is truncated there, and a later, shallower route
    // to that same file -- comfortably inside the limit -- would be dismissed as
    // already seen, so its own imports would never be expanded. Recording the
    // depth lets the shallower route re-expand it while the file itself is still
    // emitted only once.
    const expandedAt = new Map<string, number>();

    // Helper to recursively process imports
    async function processFlat(
      fileContent: string,
      fileBasePath: string,
      filePath: string,
      depth: number,
    ) {
      // Normalize the file path to ensure consistent comparison
      const normalizedPath = path.normalize(filePath);

      // Already expanded by an equally shallow or shallower route, so this one
      // cannot reach anything new. This is also what stops cycles: a repeat
      // visit always arrives at a greater depth.
      const seenAt = expandedAt.get(normalizedPath);
      if (seenAt !== undefined && seenAt <= depth) return;

      // Add this file to the flat list, once, however many routes reach it.
      if (seenAt === undefined) {
        flatFiles.push({ path: normalizedPath, content: fileContent });
      }

      // Record before recursing to prevent infinite recursion.
      expandedAt.set(normalizedPath, depth);

      // Stop descending once the depth limit is reached, matching what the tree
      // path does at the top of processImports: the file sitting at the limit is
      // still included, its own imports are simply not expanded.
      if (depth >= importState.maxDepth) {
        logger.warn(
          `Maximum import depth (${importState.maxDepth}) reached at ${normalizedPath}. Stopping import processing.`,
        );
        return;
      }

      // Find imports in this file
      const codeRegions = findCodeRegions(fileContent);
      const imports = findImports(fileContent);

      // Process imports in reverse order to handle indices correctly
      for (let i = imports.length - 1; i >= 0; i--) {
        const { start, path: importPath } = imports[i];

        // Skip if inside a code region
        if (
          codeRegions.some(
            ([regionStart, regionEnd]) =>
              start >= regionStart && start < regionEnd,
          )
        ) {
          continue;
        }

        // Validate import path
        if (
          !validateImportPath(importPath, fileBasePath, [projectRoot || ''])
        ) {
          continue;
        }

        const fullPath = path.resolve(fileBasePath, importPath);
        const normalizedFullPath = path.normalize(fullPath);

        // Skip if already expanded from here or shallower, so the file is not
        // re-read when the recursion would immediately return anyway.
        const childSeenAt = expandedAt.get(normalizedFullPath);
        if (childSeenAt !== undefined && childSeenAt <= depth + 1) continue;

        try {
          await fs.access(fullPath);
          const importedContent = await fs.readFile(fullPath, 'utf-8');

          // Process the imported file
          await processFlat(
            importedContent,
            path.dirname(fullPath),
            normalizedFullPath,
            depth + 1,
          );
          // Announce a file the first time it is reached, matching the single
          // copy of it in the flat output. A file first met down a truncated
          // route is re-expanded when a shallower route reaches it, and that
          // second pass must not announce it again: nothing downstream
          // de-duplicates, so the consumer would see one loaded file reported
          // twice under two different parents. `childSeenAt` is read before
          // the recursion above, which is what makes it a first-visit test --
          // afterwards the entry always reads `depth + 1`.
          if (childSeenAt === undefined) {
            await notifyFileImported(options, {
              filePath: normalizedFullPath,
              parentFilePath: normalizedPath,
            });
          }
        } catch (error) {
          // If file doesn't exist, silently skip this import (it's not a real import)
          // Only log warnings for other types of errors
          if (!isFileNotFoundError(error)) {
            logger.warn(
              `Failed to import ${fullPath}: ${hasMessage(error) ? error.message : 'Unknown error'}`,
            );
          }
          // Continue with other imports even if one fails
        }
      }
    }

    // Start with the root file (current file)
    const rootPath = path.normalize(
      importState.currentFile || path.resolve(basePath),
    );
    // Start from the depth already spent rather than 0, so the two formats
    // budget from the same origin. Every caller today enters flat mode at
    // depth 0, which makes this a no-op for them, but a caller arriving with
    // budget already spent would otherwise get the full limit over again in
    // flat mode while tree mode gave it only what was left.
    await processFlat(content, basePath, rootPath, importState.currentDepth);

    // Concatenate all unique files in order, Claude-style
    const flatContent = flatFiles
      .map(
        (f) =>
          `--- File: ${f.path} ---\n${f.content.trim()}\n--- End of File: ${f.path} ---`,
      )
      .join('\n\n');

    return {
      content: flatContent,
      importTree: { path: rootPath }, // Tree not meaningful in flat mode
    };
  }

  // --- TREE FORMAT LOGIC (existing) ---
  const codeRegions = findCodeRegions(content);
  let result = '';
  let lastIndex = 0;
  const imports: MemoryFile[] = [];
  const importsList = findImports(content);

  for (const { start, _end, path: importPath } of importsList) {
    // Add content before this import
    result += content.substring(lastIndex, start);
    lastIndex = _end;

    // Skip if inside a code region
    if (codeRegions.some(([s, e]) => start >= s && start < e)) {
      result += `@${importPath}`;
      continue;
    }
    // Validate import path to prevent path traversal attacks
    if (!validateImportPath(importPath, basePath, [projectRoot || ''])) {
      result += `<!-- Import failed: ${importPath} - Path traversal attempt -->`;
      continue;
    }
    const fullPath = path.resolve(basePath, importPath);
    if (importState.processedFiles.has(fullPath)) {
      result += `<!-- File already processed: ${importPath} -->`;
      continue;
    }
    try {
      await fs.access(fullPath);
      const fileContent = await fs.readFile(fullPath, 'utf-8');
      // Mark this file as processed for this import chain
      const newImportState: ImportState = {
        ...importState,
        processedFiles: new Set(importState.processedFiles),
        currentDepth: importState.currentDepth + 1,
        currentFile: fullPath,
      };
      newImportState.processedFiles.add(fullPath);
      const imported = await processImports(
        fileContent,
        path.dirname(fullPath),
        newImportState,
        projectRoot,
        importFormat,
        options,
      );
      result += `<!-- Imported from: ${importPath} -->\n${imported.content}\n<!-- End of import from: ${importPath} -->`;
      imports.push(imported.importTree);
      await notifyFileImported(options, {
        filePath: fullPath,
        parentFilePath: importState.currentFile ?? path.resolve(basePath),
      });
    } catch (err: unknown) {
      // If file doesn't exist, preserve the original @path text (it's not a real import)
      if (isFileNotFoundError(err)) {
        result += `@${importPath}`;
        continue;
      }
      // For other errors, log and add error comment
      let message = 'Unknown error';
      if (hasMessage(err)) {
        message = err.message;
      } else if (typeof err === 'string') {
        message = err;
      }
      logger.error(`Failed to import ${importPath}: ${message}`);
      result += `<!-- Import failed: ${importPath} - ${message} -->`;
    }
  }
  // Add any remaining content after the last match
  result += content.substring(lastIndex);

  return {
    content: result,
    importTree: {
      path: importState.currentFile || 'unknown',
      imports: imports.length > 0 ? imports : undefined,
    },
  };
}

export function validateImportPath(
  importPath: string,
  basePath: string,
  allowedDirectories: string[],
): boolean {
  // Reject URLs
  if (/^(file|https?):\/\//.test(importPath)) {
    return false;
  }

  const resolvedPath = path.resolve(basePath, importPath);

  return allowedDirectories.some((allowedDir) =>
    isSubpath(allowedDir, resolvedPath),
  );
}
