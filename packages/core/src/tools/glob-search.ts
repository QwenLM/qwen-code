/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { globStream, escape } from 'glob';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { FileFilteringOptions } from '../utils/file-filtering-options.js';
import { getErrorMessage } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isPathWithinRoot } from '../utils/workspaceContext.js';

const debugLogger = createDebugLogger('GLOB');

// Subset of 'Path' interface provided by 'glob' that we can implement for testing
export interface GlobPath {
  fullpath(): string;
  mtimeMs?: number;
}

export interface GlobDirectorySearch {
  searchDir: string;
  pattern: string;
  entryLimit: number;
  projectRoot: string;
  fileFilteringOptions: FileFilteringOptions;
  containmentRoot?: string;
}

export interface GlobDirectoryReply {
  entries: Array<{ path: string; mtimeMs?: number }>;
  hitLimit: boolean;
}

export async function searchGlobDirectory(
  options: GlobDirectorySearch,
  fileService: FileDiscoveryService,
  signal: AbortSignal,
): Promise<{ entries: GlobPath[]; hitLimit: boolean }> {
  const {
    searchDir: requestedSearchDir,
    pattern,
    entryLimit,
    projectRoot: requestedProjectRoot,
    fileFilteringOptions,
    containmentRoot,
  } = options;
  const realpaths = new Map<string, string | null>();
  const realpathOf = (target: string): string | null => {
    let real = realpaths.get(target);
    if (real === undefined) {
      try {
        real = fs.realpathSync(target);
      } catch {
        real = null;
      }
      realpaths.set(target, real);
    }
    return real;
  };
  const root =
    containmentRoot === undefined
      ? undefined
      : (realpathOf(containmentRoot) ?? containmentRoot);
  // Start below the real directory: `follow: false` cannot recursively walk
  // a search root that is itself a symlink. Keep the caller's output spelling.
  const searchDir =
    root === undefined
      ? requestedSearchDir
      : (realpathOf(requestedSearchDir) ?? requestedSearchDir);
  const projectRoot =
    root === undefined
      ? requestedProjectRoot
      : (realpathOf(requestedProjectRoot) ?? requestedProjectRoot);
  let effectivePattern = pattern;
  const fullPath = path.join(searchDir, effectivePattern);
  if (fs.existsSync(fullPath)) {
    effectivePattern = escape(effectivePattern);
  }

  // Prune ignored directories DURING traversal (glob's `childrenIgnored`)
  // rather than only post-filtering the results. Delegating to
  // FileDiscoveryService reuses the real .gitignore/.qwenignore semantics
  // (anchoring, negation/re-inclusion, nested ignore files) — a hand-rolled
  // gitignore→glob pattern conversion cannot reproduce these correctly.
  const isTraversalIgnored = (entry: {
    fullpath(): string;
    isDirectory(): boolean;
  }): boolean => {
    try {
      const relativePath = path.relative(projectRoot, entry.fullpath());
      // Never prune paths outside the project root (e.g. an external search
      // dir); ignore rules are only defined relative to the root.
      if (!relativePath || !isPathWithinRoot(entry.fullpath(), projectRoot)) {
        return false;
      }
      // Append trailing '/' for directories so the ignore library matches
      // directory-only patterns like `node_modules/`.
      const ignorePath = entry.isDirectory()
        ? relativePath + '/'
        : relativePath;
      return fileService.shouldIgnoreFile(ignorePath, fileFilteringOptions);
    } catch (error) {
      // Fail open: if an ignore check throws, don't prune. The post-filter
      // below is the source of truth, so a missed prune only costs a little
      // extra traversal, whereas a false prune would hide real matches and
      // be indistinguishable from a legitimately empty result.
      debugLogger.debug(
        `traversal ignore check failed for ${entry.fullpath()}: ${getErrorMessage(error)}`,
      );
      return false;
    }
  };

  // Containment is judged per walked entry, not on the pattern: `..`,
  // `[.][.]`, `\.\.` and brace alternatives all resolve to an entry whose
  // lexical path leaves the root, and a file reached through a symlinked
  // directory has a parent whose realpath does. Pruning both keeps an
  // outside entry from being walked, reported or counted.
  const escapesRoot = (full: string, self: boolean): boolean => {
    if (root === undefined) return false;
    if (!isPathWithinRoot(full, root)) return true;
    // Judge a listed entry by its parent's realpath, so a merely listed
    // outward symlink (a venv's `bin/python`) stays visible; judge a
    // directory about to be entered by its own.
    const real = self
      ? realpathOf(full)
      : (() => {
          const parent = realpathOf(path.dirname(full));
          return parent === null
            ? null
            : path.join(parent, path.basename(full));
        })();
    return real === null || !isPathWithinRoot(real, root);
  };

  const isAllowedByFileFilters = (entry: GlobPath): boolean => {
    const relativePath = path.relative(projectRoot, entry.fullpath());
    return (
      fileService.filterFiles([relativePath], fileFilteringOptions).length > 0
    );
  };

  const stream = globStream(effectivePattern, {
    cwd: searchDir,
    withFileTypes: true,
    nodir: true,
    stat: true,
    nocase: true,
    dot: true,
    follow: false,
    signal,
    ignore: {
      ignored: (entry) =>
        escapesRoot(entry.fullpath(), false) || isTraversalIgnored(entry),
      childrenIgnored: (entry) =>
        escapesRoot(entry.fullpath(), true) || isTraversalIgnored(entry),
    },
  }) as AsyncIterable<GlobPath> & { destroy?: () => void };

  const entries: GlobPath[] = [];
  let hitLimit = false;
  for await (const entry of stream) {
    if (!isAllowedByFileFilters(entry)) {
      continue;
    }
    if (entries.length >= entryLimit) {
      hitLimit = true;
      break;
    }
    let outputBase = requestedSearchDir;
    let canonicalBase = searchDir;
    // A climbing hit must be anchored at the Session root: a link's lexical
    // depth need not match the depth of the directory it points to.
    if (
      root !== undefined &&
      containmentRoot !== undefined &&
      !isPathWithinRoot(entry.fullpath(), searchDir)
    ) {
      outputBase = containmentRoot;
      canonicalBase = root;
    }
    entries.push(
      searchDir === requestedSearchDir
        ? entry
        : {
            fullpath: () =>
              path.join(
                outputBase,
                path.relative(canonicalBase, entry.fullpath()),
              ),
            mtimeMs: entry.mtimeMs,
          },
    );
  }
  if (hitLimit) {
    stream.destroy?.();
  }

  return { entries, hitLimit };
}
