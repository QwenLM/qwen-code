/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_CONTEXT_FILENAME = 'QWEN.md';
export const AGENT_CONTEXT_FILENAME = 'AGENTS.md';
/**
 * Per-developer, project-scoped context file. Anchored at
 * `<projectRoot>/.qwen/QWEN.local.md`. Intended to be gitignored so each
 * developer can keep personal instructions (local cluster IDs, account
 * names, paths) without polluting the shared project `QWEN.md` or the
 * global `~/.qwen/QWEN.md`.
 *
 * Unlike `DEFAULT_CONTEXT_FILENAME` / `AGENT_CONTEXT_FILENAME`, this name is
 * NOT part of the hierarchical upward-search list — it is loaded from a
 * single fixed slot, after all other project-level context files, so it can
 * supplement or override shared instructions.
 *
 * Project root is the nearest ancestor containing a `.git` directory OR a
 * `.git` file (the latter marks git worktrees and submodules). If no
 * project root can be found, the slot is skipped — the loader does NOT
 * fall back to cwd, because that would turn a "single fixed slot" into a
 * per-cwd file and (when cwd is the home directory) would collide with
 * the global Qwen dir at `~/.qwen/`.
 */
export const LOCAL_CONTEXT_FILENAME = 'QWEN.local.md';
export const MEMORY_SECTION_HEADER = '## Qwen Added Memories';

// This variable will hold the currently configured filename for context files.
// It defaults to include both QWEN.md and AGENTS.md but can be overridden by setGeminiMdFilename.
// QWEN.md is first to maintain backward compatibility (used by /init command tool).
let currentGeminiMdFilename: string | string[] = [
  DEFAULT_CONTEXT_FILENAME,
  AGENT_CONTEXT_FILENAME,
];

export function setGeminiMdFilename(newFilename: string | string[]): void {
  if (Array.isArray(newFilename)) {
    if (newFilename.length > 0) {
      currentGeminiMdFilename = newFilename.map((name) => name.trim());
    }
  } else if (newFilename && newFilename.trim() !== '') {
    currentGeminiMdFilename = newFilename.trim();
  }
}

export function getCurrentGeminiMdFilename(): string {
  if (Array.isArray(currentGeminiMdFilename)) {
    // #4297 fold-in 10 (qwen-latest critical, addresses divergence
    // with daemon's `extractContextFilename`): skip empty / whitespace
    // entries so callers that pass `['  ', 'AGENTS.md']` get
    // `'AGENTS.md'` instead of `''`. Without this filter the daemon's
    // `extractContextFilename` (which DOES skip empty) and this
    // process-global picker disagreed on the same input — daemon
    // parent would write `AGENTS.md` while the ACP child would read
    // `''`, leaving the init'd file orphaned.
    for (const entry of currentGeminiMdFilename) {
      if (typeof entry === 'string' && entry.trim() !== '') {
        return entry.trim();
      }
    }
    // All entries empty/whitespace — fall back to the default rather
    // than return `undefined` (callers expect a non-empty string).
    return DEFAULT_CONTEXT_FILENAME;
  }
  return currentGeminiMdFilename;
}

export function getAllGeminiMdFilenames(): string[] {
  if (Array.isArray(currentGeminiMdFilename)) {
    return currentGeminiMdFilename;
  }
  return [currentGeminiMdFilename];
}
