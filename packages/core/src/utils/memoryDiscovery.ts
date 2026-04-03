/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { getAllGeminiMdFilenames } from '../tools/memoryTool.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { processImports } from './memoryImportProcessor.js';
import { QWEN_DIR, CLAUDE_DIR } from './paths.js';
import { createDebugLogger } from './debugLogger.js';

const logger = createDebugLogger('MEMORY_DISCOVERY');

interface GeminiFileContent {
  filePath: string;
  content: string | null;
}

async function findProjectRoot(startDir: string): Promise<string | null> {
  let currentDir = path.resolve(startDir);
  while (true) {
    const gitPath = path.join(currentDir, '.git');
    try {
      const stats = await fs.lstat(gitPath);
      if (stats.isDirectory()) {
        return currentDir;
      }
    } catch (error: unknown) {
      // Don't log ENOENT errors as they're expected when .git doesn't exist
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
            `Error checking for .git directory at ${gitPath}: ${fsError.message}`,
          );
        } else {
          logger.warn(
            `Non-standard error checking for .git directory at ${gitPath}: ${String(error)}`,
          );
        }
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

async function getGeminiMdFilePathsInternal(
  currentWorkingDirectory: string,
  includeDirectoriesToReadGemini: readonly string[],
  userHomePath: string,
  fileService: FileDiscoveryService,
  extensionContextFilePaths: string[] = [],
  folderTrust: boolean,
): Promise<string[]> {
  const dirs = new Set<string>([
    ...includeDirectoriesToReadGemini,
    currentWorkingDirectory,
  ]);

  // Process directories in parallel with concurrency limit to prevent EMFILE errors
  const CONCURRENT_LIMIT = 10;
  const dirsArray = Array.from(dirs);
  const pathsArrays: string[][] = [];

  for (let i = 0; i < dirsArray.length; i += CONCURRENT_LIMIT) {
    const batch = dirsArray.slice(i, i + CONCURRENT_LIMIT);
    const batchPromises = batch.map((dir) =>
      getGeminiMdFilePathsInternalForEachDir(
        dir,
        userHomePath,
        fileService,
        extensionContextFilePaths,
        folderTrust,
      ),
    );

    const batchResults = await Promise.allSettled(batchPromises);

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        pathsArrays.push(result.value);
      } else {
        const error = result.reason;
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error discovering files in directory: ${message}`);
        // Continue processing other directories
      }
    }
  }

  const paths = pathsArrays.flat();
  return Array.from(new Set<string>(paths));
}

async function getGeminiMdFilePathsInternalForEachDir(
  dir: string,
  userHomePath: string,
  fileService: FileDiscoveryService,
  extensionContextFilePaths: string[] = [],
  folderTrust: boolean,
): Promise<string[]> {
  const allPaths = new Set<string>();
  const geminiMdFilenames = getAllGeminiMdFilenames();

  // Map each context filename to the global ~/.{dir}/ it belongs in.
  // CLAUDE.md lives in ~/.claude/; everything else defaults to ~/.proto/.
  const GLOBAL_DIR_FOR_FILENAME: Record<string, string> = {
    'CLAUDE.md': CLAUDE_DIR,
  };

  const resolvedHome = path.resolve(userHomePath);

  // --- Global file: cascade through filenames, stop at first found.
  // This means ~/.proto/PROTO.md wins over ~/.claude/CLAUDE.md — no flooding
  // the context with every compat alias that happens to exist globally.
  for (const geminiMdFilename of geminiMdFilenames) {
    const globalDir = GLOBAL_DIR_FOR_FILENAME[geminiMdFilename] ?? QWEN_DIR;
    const globalMemoryPath = path.join(
      resolvedHome,
      globalDir,
      geminiMdFilename,
    );
    try {
      await fs.access(globalMemoryPath, fsSync.constants.R_OK);
      allPaths.add(globalMemoryPath);
      logger.debug(
        `Found readable global ${geminiMdFilename}: ${globalMemoryPath}`,
      );
      break; // cascade: first found wins, skip remaining filenames
    } catch {
      // Not found, try next filename in priority order
    }
  }

  const resolvedDir = dir ? path.resolve(dir) : resolvedHome;
  const isHomeDirectory = resolvedDir === resolvedHome;

  if (isHomeDirectory) {
    // For home directory, cascade through filenames — stop at first found.
    for (const geminiMdFilename of geminiMdFilenames) {
      const homeContextPath = path.join(resolvedHome, geminiMdFilename);
      try {
        await fs.access(homeContextPath, fsSync.constants.R_OK);
        allPaths.add(homeContextPath); // Set deduplicates if same as global
        logger.debug(
          `Found readable home ${geminiMdFilename}: ${homeContextPath}`,
        );
        break; // cascade: first found wins
      } catch {
        // Not found
      }
    }
  } else if (dir && folderTrust) {
    // Walk upward from CWD to project root. For each directory, cascade through
    // filenames and stop at first found — only one context file per directory.
    const resolvedCwd = path.resolve(dir);
    logger.debug(
      `Searching for context files starting from CWD: ${resolvedCwd}`,
    );

    const projectRoot = await findProjectRoot(resolvedCwd);
    logger.debug(`Determined project root: ${projectRoot ?? 'None'}`);

    // Collect the walk directories (project root → CWD order so CWD is highest priority)
    const walkDirs: string[] = [];
    let currentDir = resolvedCwd;
    const ultimateStopDir = projectRoot
      ? path.dirname(projectRoot)
      : path.dirname(resolvedHome);

    while (currentDir && currentDir !== path.dirname(currentDir)) {
      if (currentDir === path.join(resolvedHome, QWEN_DIR)) {
        break;
      }
      walkDirs.unshift(currentDir); // prepend so outer dirs come first
      if (currentDir === ultimateStopDir) {
        break;
      }
      currentDir = path.dirname(currentDir);
    }

    // For each directory, cascade through filenames — stop at first found per dir.
    for (const walkDir of walkDirs) {
      for (const geminiMdFilename of geminiMdFilenames) {
        const potentialPath = path.join(walkDir, geminiMdFilename);
        try {
          await fs.access(potentialPath, fsSync.constants.R_OK);
          allPaths.add(potentialPath); // Set deduplicates if same as global
          logger.debug(
            `Found ${geminiMdFilename} in ${walkDir}: ${potentialPath}`,
          );
          break; // cascade: first found wins for this directory
        } catch {
          // Not found, try next filename
        }
      }
    }
  }

  // Add extension context file paths.
  for (const extensionPath of extensionContextFilePaths) {
    allPaths.add(extensionPath);
  }

  const finalPaths = Array.from(allPaths);

  logger.debug(
    `Final ordered context file paths to read: ${JSON.stringify(finalPaths)}`,
  );
  return finalPaths;
}

async function readGeminiMdFiles(
  filePaths: string[],
  importFormat: 'flat' | 'tree' = 'tree',
): Promise<GeminiFileContent[]> {
  // Process files in parallel with concurrency limit to prevent EMFILE errors
  const CONCURRENT_LIMIT = 20; // Higher limit for file reads as they're typically faster
  const results: GeminiFileContent[] = [];

  for (let i = 0; i < filePaths.length; i += CONCURRENT_LIMIT) {
    const batch = filePaths.slice(i, i + CONCURRENT_LIMIT);
    const batchPromises = batch.map(
      async (filePath): Promise<GeminiFileContent> => {
        try {
          const content = await fs.readFile(filePath, 'utf-8');

          // Process imports in the content
          const processedResult = await processImports(
            content,
            path.dirname(filePath),
            undefined,
            undefined,
            importFormat,
          );
          logger.debug(
            `Successfully read and processed imports: ${filePath} (Length: ${processedResult.content.length})`,
          );

          return { filePath, content: processedResult.content };
        } catch (error: unknown) {
          const isTestEnv =
            process.env['NODE_ENV'] === 'test' || process.env['VITEST'];
          if (!isTestEnv) {
            const message =
              error instanceof Error ? error.message : String(error);
            logger.warn(
              `Warning: Could not read ${getAllGeminiMdFilenames()} file at ${filePath}. Error: ${message}`,
            );
          }
          logger.debug(`Failed to read: ${filePath}`);
          return { filePath, content: null }; // Still include it with null content
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

function concatenateInstructions(
  instructionContents: GeminiFileContent[],
  // CWD is needed to resolve relative paths for display markers
  currentWorkingDirectoryForDisplay: string,
): string {
  return instructionContents
    .filter((item) => typeof item.content === 'string')
    .map((item) => {
      const trimmedContent = (item.content as string).trim();
      if (trimmedContent.length === 0) {
        return null;
      }
      const displayPath = path.isAbsolute(item.filePath)
        ? path.relative(currentWorkingDirectoryForDisplay, item.filePath)
        : item.filePath;
      return `--- Context from: ${displayPath} ---\n${trimmedContent}\n--- End of Context from: ${displayPath} ---`;
    })
    .filter((block): block is string => block !== null)
    .join('\n\n');
}

export interface LoadServerHierarchicalMemoryResponse {
  memoryContent: string;
  fileCount: number;
}

/**
 * Loads hierarchical QWEN.md files and concatenates their content.
 * This function is intended for use by the server.
 */
export async function loadServerHierarchicalMemory(
  currentWorkingDirectory: string,
  includeDirectoriesToReadGemini: readonly string[],
  fileService: FileDiscoveryService,
  extensionContextFilePaths: string[] = [],
  folderTrust: boolean,
  importFormat: 'flat' | 'tree' = 'tree',
): Promise<LoadServerHierarchicalMemoryResponse> {
  logger.debug(
    `Loading server hierarchical memory for CWD: ${currentWorkingDirectory} (importFormat: ${importFormat})`,
  );

  // For the server, homedir() refers to the server process's home.
  // This is consistent with how MemoryTool already finds the global path.
  const userHomePath = homedir();
  const filePaths = await getGeminiMdFilePathsInternal(
    currentWorkingDirectory,
    includeDirectoriesToReadGemini,
    userHomePath,
    fileService,
    extensionContextFilePaths,
    folderTrust,
  );
  // Also discover MEMORY.md index files from the new file-per-memory system
  const { getMemoryIndexPath } = await import('../memory/memoryStore.js');
  const { MEMORY_SYSTEM_PROMPT } = await import('../memory/memoryPrompt.js');
  for (const scope of ['global', 'project'] as const) {
    const indexPath = getMemoryIndexPath(scope, currentWorkingDirectory);
    try {
      const { readFile } = await import('node:fs/promises');
      await readFile(indexPath, 'utf-8');
      // Index exists and is readable — add it to the discovery paths
      if (!filePaths.includes(indexPath)) {
        filePaths.push(indexPath);
      }
    } catch {
      // No MEMORY.md yet — that's fine
    }
  }

  // Discover session notes (structured checkpoint for work continuity)
  const { getSessionNotesPath } = await import('../services/sessionNotes.js');
  const sessionNotesPath = getSessionNotesPath(currentWorkingDirectory);
  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(sessionNotesPath, 'utf-8');
    // Only include if it has real content (not just the template headings)
    if (content.includes('\n') && content.length > 300) {
      if (!filePaths.includes(sessionNotesPath)) {
        filePaths.push(sessionNotesPath);
      }
    }
  } catch {
    // No session notes yet — that's fine
  }

  if (filePaths.length === 0) {
    logger.debug('No context files found in hierarchy.');
    return { memoryContent: '', fileCount: 0 };
  }
  const contentsWithPaths = await readGeminiMdFiles(filePaths, importFormat);
  // Pass CWD for relative path display in concatenated content
  let combinedInstructions = concatenateInstructions(
    contentsWithPaths,
    currentWorkingDirectory,
  );

  // Prepend memory system prompt if any MEMORY.md was loaded
  const hasMemoryIndex = contentsWithPaths.some(
    (item) => path.basename(item.filePath) === 'MEMORY.md',
  );
  if (hasMemoryIndex) {
    combinedInstructions = MEMORY_SYSTEM_PROMPT + '\n\n' + combinedInstructions;
  }

  // Only count files that match configured memory filenames (e.g., QWEN.md),
  // excluding system context files like output-language.md
  const memoryFilenames = new Set(getAllGeminiMdFilenames());
  const fileCount = contentsWithPaths.filter((item) =>
    memoryFilenames.has(path.basename(item.filePath)),
  ).length;

  return {
    memoryContent: combinedInstructions,
    fileCount, // Only count the context files
  };
}
