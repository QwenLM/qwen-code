/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LSP Language Detector
 *
 * Detects programming languages in a workspace by analyzing file extensions
 * and root marker files (e.g., package.json, tsconfig.json).
 */

import * as fs from 'node:fs';
import * as path from 'path';
import { globSync } from 'glob';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';

/**
 * Extension to language ID mapping
 */
const DEFAULT_EXTENSION_TO_LANGUAGE: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  jsx: 'javascriptreact',
  tsx: 'typescriptreact',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  cpp: 'cpp',
  c: 'c',
  php: 'php',
  rb: 'ruby',
  cs: 'csharp',
  vue: 'vue',
  svelte: 'svelte',
  html: 'html',
  css: 'css',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
};

/**
 * Root marker file to language ID mapping
 */
const MARKER_TO_LANGUAGE: Record<string, string> = {
  'package.json': 'javascript',
  'tsconfig.json': 'typescript',
  'pyproject.toml': 'python',
  'go.mod': 'go',
  'Cargo.toml': 'rust',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'composer.json': 'php',
  Gemfile: 'ruby',
  '*.sln': 'csharp',
  'mix.exs': 'elixir',
  'deno.json': 'deno',
};

/**
 * Common root marker files to look for
 */
const COMMON_MARKERS = [
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile',
  'mix.exs',
  'deno.json',
];

/**
 * Default exclude patterns for file search
 */
const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
];

/**
 * Detects programming languages in a workspace.
 */
export class LspLanguageDetector {
  constructor(
    private readonly workspaceContext: WorkspaceContext,
    private readonly fileDiscoveryService: FileDiscoveryService,
  ) {}

  /**
   * Detect programming languages in workspace by analyzing files and markers.
   * Returns languages sorted by frequency (most common first).
   *
   * @param extensionOverrides - Custom extension to language mappings
   * @returns Array of detected language IDs
   */
  async detectLanguages(
    extensionOverrides: Record<string, string> = {},
  ): Promise<string[]> {
    const extensionMap = this.getExtensionToLanguageMap(extensionOverrides);
    const extensions = Object.keys(extensionMap);
    const patterns =
      extensions.length > 0 ? [`**/*.{${extensions.join(',')}}`] : ['**/*'];

    const files = new Set<string>();
    const searchRoots = this.workspaceContext.getDirectories();

    for (const root of searchRoots) {
      for (const pattern of patterns) {
        try {
          const matches = globSync(pattern, {
            cwd: root,
            ignore: DEFAULT_EXCLUDE_PATTERNS,
            absolute: true,
            nodir: true,
          });

          for (const match of matches) {
            if (this.fileDiscoveryService.shouldIgnoreFile(match)) {
              continue;
            }
            files.add(match);
          }
        } catch {
          // Ignore glob errors for missing/invalid directories
        }
      }
    }

    // Count files per language
    const languageCounts = new Map<string, number>();
    for (const file of Array.from(files)) {
      const ext = path.extname(file).slice(1).toLowerCase();
      if (ext) {
        const lang = this.mapExtensionToLanguage(ext, extensionMap);
        if (lang) {
          languageCounts.set(lang, (languageCounts.get(lang) || 0) + 1);
        }
      }
    }

    // Also detect languages via root marker files
    const rootMarkers = await this.detectRootMarkers();
    for (const marker of rootMarkers) {
      const lang = this.mapMarkerToLanguage(marker);
      if (lang) {
        // Give higher weight to config files
        const currentCount = languageCounts.get(lang) || 0;
        languageCounts.set(lang, currentCount + 100);
      }
    }

    // Return languages sorted by count (descending)
    return Array.from(languageCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([lang]) => lang);
  }

  /**
   * Detect root marker files in workspace directories
   */
  private async detectRootMarkers(): Promise<string[]> {
    const markers = new Set<string>();

    for (const root of this.workspaceContext.getDirectories()) {
      for (const marker of COMMON_MARKERS) {
        try {
          const fullPath = path.join(root, marker);
          if (fs.existsSync(fullPath)) {
            markers.add(marker);
          }
        } catch {
          // ignore missing files
        }
      }
    }

    return Array.from(markers);
  }

  /**
   * Map file extension to programming language ID
   */
  private mapExtensionToLanguage(
    ext: string,
    extensionMap: Record<string, string>,
  ): string | null {
    return extensionMap[ext] || null;
  }

  /**
   * Get extension to language mapping with overrides applied
   */
  private getExtensionToLanguageMap(
    extensionOverrides: Record<string, string> = {},
  ): Record<string, string> {
    const extToLang = { ...DEFAULT_EXTENSION_TO_LANGUAGE };

    for (const [key, value] of Object.entries(extensionOverrides)) {
      const normalized = key.startsWith('.') ? key.slice(1) : key;
      if (!normalized) {
        continue;
      }
      extToLang[normalized.toLowerCase()] = value;
    }

    return extToLang;
  }

  /**
   * Map root marker file to programming language ID
   */
  private mapMarkerToLanguage(marker: string): string | null {
    return MARKER_TO_LANGUAGE[marker] || null;
  }
}
