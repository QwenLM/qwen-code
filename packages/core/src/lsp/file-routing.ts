/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSubpath } from '../utils/paths.js';
import { resolveWorkspacePath } from '../utils/workspaceContext.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { LspServerConfig } from './types.js';

const debugLogger = createDebugLogger('LSP');

/** Known LSP language extensions; unknown language IDs retain legacy dispatch. */
const LANGUAGE_ID_TO_EXTENSIONS: Record<string, string[]> = {
  typescript: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
  typescriptreact: ['tsx'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  javascriptreact: ['jsx'],
  python: ['py', 'pyi', 'pyw'],
  cpp: ['cpp', 'cc', 'cxx', 'h', 'hpp', 'hh', 'hxx', 'inl', 'tpp'],
  c: ['c', 'h'],
  'objective-c': ['m'],
  'objective-cpp': ['mm'],
  csharp: ['cs'],
  fsharp: ['fs', 'fsi', 'fsx'],
  ruby: ['rb'],
  shellscript: ['sh', 'bash', 'zsh'],
  rust: ['rs'],
  yaml: ['yaml', 'yml'],
  json: ['json', 'jsonc'],
  css: ['css'],
  java: ['java'],
  go: ['go'],
};

export function getLspServerExtensions(config: LspServerConfig): string[] {
  const extensions = new Set<string>();
  for (const key of Object.keys(config.extensionToLanguage ?? {})) {
    const normalized = key.startsWith('.') ? key.slice(1) : key;
    if (normalized) extensions.add(normalized.toLowerCase());
  }
  if (Object.keys(config.extensionToLanguage ?? {}).length > 0) {
    return [...extensions];
  }

  for (const language of config.languages) {
    const id = language.toLowerCase();
    const mapped = Object.hasOwn(LANGUAGE_ID_TO_EXTENSIONS, id)
      ? LANGUAGE_ID_TO_EXTENSIONS[id]
      : undefined;
    for (const extension of mapped ?? [id]) {
      extensions.add(extension);
    }
    if (
      id === 'cpp' &&
      /^clangd(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(
        path.basename(config.command ?? ''),
      )
    ) {
      extensions.add('c');
    }
  }
  return [...extensions];
}

export function isLspDocumentApplicable(
  config: LspServerConfig,
  filePath: string,
): boolean {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (getLspServerExtensions(config).includes(extension)) return true;
  if (Object.keys(config.extensionToLanguage ?? {}).length > 0) return false;

  return (
    config.languages.some(
      (language) =>
        !Object.hasOwn(LANGUAGE_ID_TO_EXTENSIONS, language.toLowerCase()),
    ) || extension === ''
  );
}

/** primaryRoot and directories are resolved; intersect server scope with workspace scope. */
export function getLspWorkspaceRoots(
  config: LspServerConfig,
  primaryRoot: string,
  directories: readonly string[],
): readonly string[] {
  try {
    const configuredRoot =
      config.workspaceFolder ??
      (config.rootUri ? fileURLToPath(config.rootUri) : primaryRoot);
    const root =
      configuredRoot === primaryRoot
        ? primaryRoot
        : resolveWorkspacePath(configuredRoot);
    if (isSubpath(root, primaryRoot) && isSubpath(primaryRoot, root)) {
      return directories;
    }
    return directories.flatMap((directory) =>
      isSubpath(directory, root)
        ? [root]
        : isSubpath(root, directory)
          ? [directory]
          : [],
    );
  } catch (error) {
    debugLogger.warn(`LSP server ${config.name} has an unusable root:`, error);
    return [];
  }
}
