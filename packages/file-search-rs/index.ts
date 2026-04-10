/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// TypeScript entry point that re-exports the native module
// The actual .node file is loaded dynamically

export type { SearchConfig, SearchResult } from './index.d.ts';

// Re-export types
export interface SearchConfig {
  projectRoot: string;
  useGitignore: boolean;
  useQwenignore: boolean;
  ignoreDirs: string[];
  enableFuzzySearch: boolean;
  maxDepth?: number;
}

export interface SearchResult {
  path: string;
  score?: number;
}

// Dynamic import of the native module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nativeModule: any = null;

async function loadNativeModule() {
  if (!nativeModule) {
    try {
      // Try to load the platform-specific binary
      const path = await import('node:path');
      const fs = await import('node:fs');
      const __dirname = import.meta.url
        ? path.dirname(new URL(import.meta.url).pathname)
        : '.';

      const binaryName =
        process.platform === 'win32'
          ? 'qwen-file-search.win32-x64-msvc.node'
          : process.platform === 'darwin'
            ? `qwen-file-search.darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}.node`
            : `qwen-file-search.linux-x64-gnu.node`;

      const binaryPath = path.join(__dirname, binaryName);

      if (fs.existsSync(binaryPath)) {
        nativeModule = await import(binaryPath);
      }
    } catch (err) {
      // Module not available, will fall back to JS implementation
      console.debug('Rust file search module not available:', err);
    }
  }
  return nativeModule;
}

export async function createFileSearch(config: SearchConfig) {
  const mod = await loadNativeModule();
  if (mod?.FileSearch) {
    return new mod.FileSearch(config);
  }
  throw new Error(
    'Rust file search module not available. Please build the native module first.',
  );
}
