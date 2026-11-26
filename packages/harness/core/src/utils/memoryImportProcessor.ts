/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isSubpath } from './paths.js';
import { runLogger } from './runLogger.js';

// Simple console logger for import processing
const logger = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (...args: any[]) =>
    runLogger.debug('[DEBUG] [ImportProcessor]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (...args: any[]) => runLogger.warn('[WARN] [ImportProcessor]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...args: any[]) =>
    runLogger.error('[ERROR] [ImportProcessor]', ...args),
};

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
 * Information about an external import that was blocked by path validation.
 */
export interface BlockedExternalImport {
  /** The raw @path from the AGENTS.md file */
  importPath: string;
  /** The absolute resolved path */
  resolvedPath: string;
  /** The AGENTS.md file that contains the import */
  sourceFile: string;
}

/**
 * Information about an import that failed (e.g. file not found).
 */
export interface FailedImport {
  /** The raw @path from the AGENTS.md file */
  importPath: string;
  /** The absolute resolved path */
  resolvedPath: string;
  /** The AGENTS.md file that contains the import */
  sourceFile: string;
  /** The error message */
  error: string;
}

/**
 * Result of processing imports
 */
export interface ProcessImportsResult {
  content: string;
  importTree: MemoryFile;
  /** External imports that were blocked because they reference paths outside the project root. */
  blockedExternalImports: BlockedExternalImport[];
  /** All file paths that were resolved and inlined via @import directives. */
  resolvedImportPaths: string[];
  /** Imports that failed (e.g. file not found, read error). */
  failedImports: FailedImport[];
}

// Helper to find the project root (looks for boundary marker directories/files)
async function findProjectRoot(
  startDir: string,
  boundaryMarkers: readonly string[] = ['.git'],
): Promise<string> {
  if (boundaryMarkers.length === 0) {
    return path.resolve(startDir);
  }

  let currentDir = path.resolve(startDir);
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
      } catch {
        // marker not found, continue
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached filesystem root
      break;
    }
    currentDir = parentDir;
  }
  // Fallback to startDir if no marker found
  return path.resolve(startDir);
}

// Add a type guard for error objects
function hasMessage(err: unknown): err is { message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  );
}

// Helper to find all code block and inline code regions using regex
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

    // Validate as a file path reference.
    // Accept: @./relative, @~/home, @/absolute, @filename.ext, @dir/file
    // Reject: npm-style scoped packages (e.g. @testing-library/react),
    //         special characters (e.g. @#channel, @**bold**),
    //         bare words without path-like structure that lack a file extension
    //         or path separator starting with ./ or ~/
    if (importPath.length > 0 && isValidImportPath(importPath)) {
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

/**
 * Validates whether a string looks like a file path (as opposed to an npm package
 * name, a mention, or other non-path @-reference).
 *
 * Heuristics:
 * - Explicit relative paths: ./path, ~/path
 * - Absolute paths: /path (but not bare "/")
 * - Bare names that look like files: must start with [a-zA-Z0-9._-] AND must
 *   contain a file extension (dot followed by letters) or start with a path
 *   indicator. This filters out npm scoped packages like "testing-library/react"
 *   which have no extension and no ./ prefix.
 *
 * Rejects:
 * - Paths starting with @ (double-@, e.g. @@something)
 * - Paths starting with special chars: #, %, ^, &, *, (, )
 * - npm-style package paths: bare word + "/" without a file extension
 *   (e.g. "testing-library/react", "babel/preset-env")
 */
export function isValidImportPath(importPath: string): boolean {
  // Explicit relative or home-relative paths are always valid
  if (importPath.startsWith('./') 
    || importPath.startsWith('../')
    ||importPath.startsWith('~/')) {
    return true;
  }
  // Absolute paths (but not bare "/")
  if (importPath.startsWith('/') && importPath.length > 1) {
    return true;
  }

  // Reject if starts with @ or special characters
  if (importPath.startsWith('@')
    || /^[#%^&*()]+/.test(importPath)
    || !/^[a-zA-Z0-9._-]/.test(importPath)
  ) {
    return false;
  }

  // For bare names (no ./ or ~/ prefix), distinguish file paths from package names
  // and mentions (e.g. "@admin"). A valid file path must contain a file extension
  // (dot followed by alphanumeric characters). This filters out:
  // - npm package names like "testing-library/react" (slash but no extension)
  // - Mentions like "admin" (no slash, no extension)
  // - Simple words like "help", "someone" (no extension)
  //
  // Bare names WITHOUT extension are only valid if they start with a dot
  // (hidden files/dirs like ".config/rules").
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(importPath) || // extension at end
                       /\.[a-zA-Z0-9]+\//.test(importPath);   // extension in middle segment
  const startsWithDot = importPath.startsWith('.');

  if (!hasExtension && !startsWithDot) {
    // No extension and doesn't start with dot — likely a mention or package name
    return false;
  }

  if (importPath.includes('/')) {
    // Has a slash — check if it looks like a file path vs a package name.
    // File paths typically have an extension somewhere, or the first segment
    // contains a dot (e.g. "src/file.ts", ".config/rules.md", "dir/sub/file.txt")
    // Package names: "testing-library/react", "babel/core", "types/node"
    const firstSegment = importPath.split('/')[0];
    const firstSegmentHasDot = firstSegment.includes('.');

    if (!hasExtension && !firstSegmentHasDot) {
      // Looks like a package name (e.g. "testing-library/react")
      return false;
    }
  }

  return true;
}

function findCodeRegions(content: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  // Regex to match code blocks (inline and multiline)
  // Matches one or more backticks, content (lazy), and same number of backticks
  const regex = /(`+)([\s\S]*?)\1/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    regions.push([match.index, match.index + match[0].length]);
  }
  return regions;
}

/**
 * Walk the import tree and build a child→parent path mapping.
 * Each child maps to its immediate parent (the file that @imported it).
 */
export function collectImportParentMap(
  imports: MemoryFile[],
  parentPath: string,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const imp of imports) {
    if (imp.path && imp.path !== 'unknown') {
      map.set(imp.path, parentPath);
    }
    if (imp.imports) {
      for (const [child, parent] of collectImportParentMap(
        imp.imports,
        imp.path,
      )) {
        map.set(child, parent);
      }
    }
  }
  return map;
}

/**
 * Recursively collects all file paths from an array of MemoryFile import trees.
 */
function collectAllImportPaths(imports: MemoryFile[]): string[] {
  const paths: string[] = [];
  for (const imp of imports) {
    if (imp.path && imp.path !== 'unknown') {
      paths.push(imp.path);
    }
    if (imp.imports) {
      paths.push(...collectAllImportPaths(imp.imports));
    }
  }
  return paths;
}

/**
 * Processes import statements in GEMINI.md content
 * Supports @path/to/file syntax for importing content from other files
 * @param content - The content to process for imports
 * @param basePath - The directory path where the current file is located
 * @param debugMode - Whether to enable debug logging
 * @param importState - State tracking for circular import prevention
 * @param projectRoot - The project root directory for allowed directories
 * @param importFormat - The format of the import tree
 * @param includeExternal - When true, imports outside the project root are allowed
 * @returns Processed content with imports resolved and import tree
 */
export async function processImports(
  content: string,
  basePath: string,
  debugMode: boolean = false,
  importState: ImportState = {
    processedFiles: new Set(),
    maxDepth: 5,
    currentDepth: 0,
  },
  projectRoot?: string,
  importFormat: 'flat' | 'tree' = 'tree',
  boundaryMarkers: readonly string[] = ['.git'],
  includeExternal: boolean = false,
): Promise<ProcessImportsResult> {
  if (!projectRoot) {
    projectRoot = await findProjectRoot(basePath, boundaryMarkers);
  }

  if (importState.currentDepth >= importState.maxDepth) {
    if (debugMode) {
      logger.warn(
        `Maximum import depth (${importState.maxDepth}) reached. Stopping import processing.`,
      );
    }
    return {
      content,
      importTree: { path: importState.currentFile || 'unknown' },
      blockedExternalImports: [],
      resolvedImportPaths: [],
      failedImports: [],
    };
  }

  // --- FLAT FORMAT LOGIC ---
  if (importFormat === 'flat') {
    // Use a queue to process files in order of first encounter, and a set to avoid duplicates
    const flatFiles: Array<{ path: string; content: string }> = [];
    // Track processed files across the entire operation
    const processedFiles = new Set<string>();
    const blockedExternalImports: BlockedExternalImport[] = [];
    const failedImports: FailedImport[] = [];

    // Helper to recursively process imports
    async function processFlat(
      fileContent: string,
      fileBasePath: string,
      filePath: string,
      depth: number,
    ) {
      // Normalize the file path to ensure consistent comparison
      const normalizedPath = path.normalize(filePath);

      // Skip if already processed
      if (processedFiles.has(normalizedPath)) return;

      // Mark as processed before processing to prevent infinite recursion
      processedFiles.add(normalizedPath);

      // Add this file to the flat list
      flatFiles.push({ path: normalizedPath, content: fileContent });

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
          if (includeExternal) {
            // When includeExternal is true, allow the import to proceed
          } else {
            // Collect blocked external import info
            const resolvedPath = path.resolve(fileBasePath, importPath);
            // Only collect if it's a real path (not a URL which validateImportPath also rejects)
            if (!/^(file|https?):\/\//.test(importPath)) {
              blockedExternalImports.push({
                importPath,
                resolvedPath,
                sourceFile: filePath,
              });
            }
            continue;
          }
        }

        const fullPath = path.resolve(fileBasePath, importPath);
        const normalizedFullPath = path.normalize(fullPath);

        // Skip if already processed
        if (processedFiles.has(normalizedFullPath)) continue;

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
        } catch (error) {
          const message = hasMessage(error) ? error.message : 'Unknown error';
          logger.error(`Failed to import ${importPath}: ${message}`);
          failedImports.push({
            importPath,
            resolvedPath: fullPath,
            sourceFile: filePath,
            error: message,
          });
          // Continue with other imports even if one fails
        }
      }
    }

    // Start with the root file (current file)
    const rootPath = path.normalize(
      importState.currentFile || path.resolve(basePath),
    );
    await processFlat(content, basePath, rootPath, 0);

    // Concatenate all unique files in order.
    const flatContent = flatFiles
      .map(
        (f) =>
          `--- File: ${f.path} ---\n${f.content.trim()}\n--- End of File: ${f.path} ---`,
      )
      .join('\n\n');

    return {
      content: flatContent,
      importTree: { path: rootPath }, // Tree not meaningful in flat mode
      blockedExternalImports,
      resolvedImportPaths: flatFiles.slice(1).map((f) => f.path),
      failedImports,
    };
  }

  // --- TREE FORMAT LOGIC (existing) ---
  const codeRegions = findCodeRegions(content);
  let result = '';
  let lastIndex = 0;
  const imports: MemoryFile[] = [];
  const importsList = findImports(content);
  const blockedExternalImports: BlockedExternalImport[] = [];
  const failedImports: FailedImport[] = [];

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
      if (includeExternal && !/^(file|https?):\/\//.test(importPath)) {
        // When includeExternal is true, allow the import to proceed
        // (fall through to the file loading below)
      } else {
        // Collect blocked external import info (only for path-based imports, not URLs)
        if (!/^(file|https?):\/\//.test(importPath)) {
          blockedExternalImports.push({
            importPath,
            resolvedPath: path.resolve(basePath, importPath),
            sourceFile: importState.currentFile || 'unknown',
          });
        }
        result += `<!-- Import blocked: ${importPath} - outside project root -->`;
        continue;
      }
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
        debugMode,
        newImportState,
        projectRoot,
        importFormat,
        boundaryMarkers,
        includeExternal,
      );
      result += `<!-- Imported from: ${importPath} -->\n${imported.content}\n<!-- End of import from: ${importPath} -->`;
      imports.push(imported.importTree);
      // Merge blocked imports from nested processing
      blockedExternalImports.push(...imported.blockedExternalImports);
      // Merge failed imports from nested processing
      failedImports.push(...imported.failedImports);
    } catch (err: unknown) {
      let message = 'Unknown error';
      if (hasMessage(err)) {
        message = err.message;
      } else if (typeof err === 'string') {
        message = err;
      }
      logger.error(`Failed to import ${importPath}: ${message}`);
      result += `<!-- Import failed: ${importPath} - ${message} -->`;
      failedImports.push({
        importPath,
        resolvedPath: fullPath,
        sourceFile: importState.currentFile || 'unknown',
        error: message,
      });
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
    blockedExternalImports,
    resolvedImportPaths: collectAllImportPaths(imports),
    failedImports,
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
