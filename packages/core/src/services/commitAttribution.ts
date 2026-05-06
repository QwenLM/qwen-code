/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Commit Attribution Service
 *
 * Tracks character-level contribution ratios between AI and humans per file.
 * When a git commit is made, this data is combined with git diff analysis to
 * calculate real AI vs human contribution percentages, stored as git notes.
 *
 * Features:
 * - Character-level prefix/suffix diff algorithm
 * - Real AI/human contribution ratio via git diff
 * - Surface tracking (cli/ide/api/sdk)
 * - Prompt counting (since-last-commit window)
 * - Snapshot/restore for session persistence
 * - Generated file exclusion
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isGeneratedFile } from './generatedFiles.js';

/**
 * Resolve symlinks on a path. On macOS in particular, `/var` is a
 * symlink to `/private/var`, so an absolute path captured via
 * `fs.realpathSync` (what edit.ts/write-file.ts records) and
 * `path.relative` against `git rev-parse --show-toplevel` (which may
 * report either form) won't line up unless we normalise both sides.
 * Falls back to the input on any fs error so a missing path can't
 * make the lookup fail outright.
 */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileAttribution {
  /** Total characters contributed by AI (accumulated across edits) */
  aiContribution: number;
  /** Whether the file was created by AI */
  aiCreated: boolean;
}

/** Per-file attribution detail in the git notes payload. */
export interface FileAttributionDetail {
  aiChars: number;
  humanChars: number;
  percent: number;
  surface?: string;
}

/** Full attribution payload stored as git notes JSON. */
export interface CommitAttributionNote {
  version: 1;
  generator: string;
  files: Record<string, FileAttributionDetail>;
  summary: {
    aiPercent: number;
    aiChars: number;
    humanChars: number;
    totalFilesTouched: number;
    surfaces: string[];
  };
  surfaceBreakdown: Record<string, { aiChars: number; percent: number }>;
  /**
   * Sample of generated/vendored files that were excluded from
   * attribution. Capped at `MAX_EXCLUDED_GENERATED_SAMPLE` paths so a
   * commit churning thousands of `dist/` artifacts can't blow past the
   * 30 KB note budget and silently drop attribution for the real
   * source files in the same commit. Use `excludedGeneratedCount` for
   * the true total.
   */
  excludedGenerated: string[];
  /** Total count of excluded files (≥ excludedGenerated.length). */
  excludedGeneratedCount: number;
  promptCount: number;
}

/**
 * Upper bound on the number of excluded-generated paths we serialize
 * into the git note. Keeps the JSON payload bounded for commits with
 * lots of generated artifacts.
 */
export const MAX_EXCLUDED_GENERATED_SAMPLE = 50;

/** Result of running git commands to get staged file info. */
export interface StagedFileInfo {
  files: string[];
  diffSizes: Map<string, number>;
  deletedFiles: Set<string>;
  /**
   * Absolute path of the repository root (`git rev-parse --show-toplevel`).
   * Optional for backward compatibility with synthetic test inputs;
   * production callers should set it so file paths in `files` (which are
   * relative to the repo root) align with absolute paths tracked by the
   * attribution service. When absent, callers may fall back to the
   * configured target directory at the cost of zeroed-out attribution
   * for files outside that directory.
   */
  repoRoot?: string;
}

/**
 * On-disk schema version for AttributionSnapshot. Bump when the shape
 * changes incompatibly so restoreFromSnapshot can refuse / migrate
 * stale payloads instead of silently producing NaN counters or
 * mismatched key shapes.
 */
export const ATTRIBUTION_SNAPSHOT_VERSION = 1;

/** Serializable snapshot for session persistence. */
export interface AttributionSnapshot {
  type: 'attribution-snapshot';
  /** Schema version; absent on pre-versioning snapshots, treated as 1. */
  version?: number;
  surface: string;
  fileStates: Record<string, FileAttribution>;
  promptCount: number;
  promptCountAtLastCommit: number;
}

// ---------------------------------------------------------------------------
// Model name sanitization
// ---------------------------------------------------------------------------

const INTERNAL_MODEL_PATTERNS = [
  /qwen[-_]?\d+(\.\d+)?[-_]?b?/i,
  /qwen[-_]?coder[-_]?\d*/i,
  /qwen[-_]?max/i,
  /qwen[-_]?plus/i,
  /qwen[-_]?turbo/i,
];

const SANITIZED_GENERATOR_NAME = 'Qwen-Coder';

function sanitizeModelName(name: string): string {
  for (const pattern of INTERNAL_MODEL_PATTERNS) {
    if (pattern.test(name)) {
      return SANITIZED_GENERATOR_NAME;
    }
  }
  return name;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Defensive coercions for restoring snapshot fields. A snapshot can
 * arrive with `undefined` / wrong-type fields if the on-disk JSON was
 * partially written or pre-dates the current schema; without coercion
 * they would flow through `Math.min(undefined, n) === NaN` into the
 * git-notes payload.
 */
function sanitiseCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function sanitiseAttribution(v: unknown): FileAttribution {
  const obj = (v ?? {}) as Partial<FileAttribution>;
  return {
    aiContribution: sanitiseCount(obj.aiContribution),
    aiCreated: typeof obj.aiCreated === 'boolean' ? obj.aiCreated : false,
  };
}

/**
 * Surface label embedded in the git-notes payload. Defaults to `'cli'`
 * for the qwen-code CLI; embedders (IDE extensions, SDK consumers) can
 * override by setting `QWEN_CODE_ENTRYPOINT` before construction so the
 * note records where the contribution was authored.
 */
export function getClientSurface(): string {
  return process.env['QWEN_CODE_ENTRYPOINT'] ?? 'cli';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CommitAttributionService {
  private static instance: CommitAttributionService | null = null;

  /** Per-file AI contribution tracking (keyed by absolute path) */
  private fileAttributions: Map<string, FileAttribution> = new Map();
  /** Client surface (cli, ide, api, sdk, etc.) */
  private surface: string = getClientSurface();

  // -- Prompt counting --
  private promptCount: number = 0;
  private promptCountAtLastCommit: number = 0;

  private constructor() {}

  static getInstance(): CommitAttributionService {
    if (!CommitAttributionService.instance) {
      CommitAttributionService.instance = new CommitAttributionService();
    }
    return CommitAttributionService.instance;
  }

  /** Reset singleton for testing. */
  static resetInstance(): void {
    CommitAttributionService.instance = null;
  }

  // -----------------------------------------------------------------------
  // Recording
  // -----------------------------------------------------------------------

  /**
   * Record an AI edit to a file.
   * Uses prefix/suffix matching for precise character-level contribution.
   *
   * `filePath` is canonicalised via `fs.realpathSync` before being used
   * as a key, so symlinked paths (e.g. `/var/...` ↔ `/private/var/...`
   * on macOS) collapse to the same entry instead of silently producing
   * two parallel records.
   */
  recordEdit(
    filePath: string,
    oldContent: string | null,
    newContent: string,
  ): void {
    const key = realpathOrSelf(filePath);

    const existing = this.fileAttributions.get(key) || {
      aiContribution: 0,
      aiCreated: false,
    };

    const isNewFile = oldContent === null;
    const contribution = computeCharContribution(oldContent ?? '', newContent);

    existing.aiContribution += contribution;
    if (isNewFile && !existing.aiCreated) {
      existing.aiCreated = true;
    }

    this.fileAttributions.set(key, existing);
  }

  // -----------------------------------------------------------------------
  // Prompt counting
  // -----------------------------------------------------------------------

  incrementPromptCount(): void {
    this.promptCount++;
  }

  getPromptCount(): number {
    return this.promptCount;
  }

  /** Prompts since last commit (for "N-shotted" display). */
  getPromptsSinceLastCommit(): number {
    return this.promptCount - this.promptCountAtLastCommit;
  }

  // -----------------------------------------------------------------------
  // Querying
  // -----------------------------------------------------------------------

  getAttributions(): Map<string, FileAttribution> {
    const copy = new Map<string, FileAttribution>();
    for (const [k, v] of this.fileAttributions) {
      copy.set(k, { ...v });
    }
    return copy;
  }

  getFileAttribution(filePath: string): FileAttribution | undefined {
    // Canonicalise so callers don't have to know about the realpath
    // normalization happening inside `recordEdit`.
    const attr = this.fileAttributions.get(realpathOrSelf(filePath));
    return attr ? { ...attr } : undefined;
  }

  hasAttributions(): boolean {
    return this.fileAttributions.size > 0;
  }

  getSurface(): string {
    return this.surface;
  }

  /**
   * Clear file attribution data. Called after commit (success or failure).
   * @param commitSucceeded If true, also updates the "at last commit"
   *   counters so getPromptsSinceLastCommit() resets to 0.
   */
  clearAttributions(commitSucceeded: boolean = true): void {
    if (commitSucceeded) {
      this.promptCountAtLastCommit = this.promptCount;
    }
    this.fileAttributions.clear();
  }

  /**
   * Clear attribution data for the specific files that just landed in
   * a commit, leaving entries for files the user *didn't* include
   * (partial commits, `git add A && git commit -m "..."`) intact so
   * they're still credited on a later commit. Snapshots prompt
   * counters since a commit did succeed.
   *
   * Inputs must already be canonical absolute paths. The caller
   * should resolve repo-relative diff entries against a canonical
   * (realpath'd) repo root rather than realpathing each leaf — at
   * cleanup time the leaf for a just-deleted file no longer exists,
   * so per-leaf `fs.realpathSync` would fail and fall back to a
   * non-canonical path that misses the stored canonical key.
   */
  clearAttributedFiles(committedAbsolutePaths: Set<string>): void {
    this.promptCountAtLastCommit = this.promptCount;
    for (const p of committedAbsolutePaths) {
      this.fileAttributions.delete(p);
    }
  }

  /**
   * Snapshot the prompt counter as the new "last commit" without
   * clearing per-file attribution. Used when a commit landed but we
   * can't reliably determine which files were in it (multi-commit
   * chain we won't write a note for, attribution toggle off, diff
   * analysis failed). Wholesale-clearing in those branches would
   * silently wipe pending AI edits for *unrelated* files the user
   * didn't stage — a worse failure mode than the small risk of
   * stale per-file state for files that did just land.
   */
  noteCommitWithoutClearing(): void {
    this.promptCountAtLastCommit = this.promptCount;
  }

  /**
   * Resolve a set of repo-relative file paths to the canonical absolute
   * keys actually stored in the attribution map. Used by cleanup to
   * partial-clear only the files that just landed in a commit.
   *
   * Matching by walking `fileAttributions` (instead of resolving each
   * relative path with `path.resolve` + `fs.realpathSync`) is the only
   * approach that handles all of: deleted files (where realpathSync
   * throws), intermediate-symlink directories (where path.resolve only
   * canonicalises the base), and renamed files (where the diff-time
   * relative path differs from the recordEdit-time absolute path —
   * still no match here, that's a rename-tracking concern handled
   * separately). Each tracked key is canonical (recordEdit ran it
   * through `realpathOrSelf`), so its computed relative form against
   * the canonical repo root is what generateNotePayload uses too.
   */
  matchCommittedFiles(
    relativeFiles: Iterable<string>,
    canonicalRepoRoot: string,
  ): Set<string> {
    const wanted = new Set(relativeFiles);
    const matched = new Set<string>();
    for (const key of this.fileAttributions.keys()) {
      const rel = path
        .relative(canonicalRepoRoot, key)
        .split(path.sep)
        .join('/');
      if (wanted.has(rel)) {
        matched.add(key);
      }
    }
    return matched;
  }

  // -----------------------------------------------------------------------
  // Snapshot / restore (session persistence)
  // -----------------------------------------------------------------------

  /** Serialize current state for session persistence. */
  toSnapshot(): AttributionSnapshot {
    const fileStates: Record<string, FileAttribution> = {};
    for (const [k, v] of this.fileAttributions) {
      fileStates[k] = { ...v };
    }
    return {
      type: 'attribution-snapshot',
      version: ATTRIBUTION_SNAPSHOT_VERSION,
      surface: this.surface,
      fileStates,
      promptCount: this.promptCount,
      promptCountAtLastCommit: this.promptCountAtLastCommit,
    };
  }

  /** Restore state from a persisted snapshot. */
  restoreFromSnapshot(snapshot: AttributionSnapshot): void {
    // The resume-time caller (client.ts) passes `snapshot` as a
    // structural cast from `unknown`, so its TS-typed shape is only
    // a hint — the actual runtime value can be anything (corrupted
    // JSONL line, hand-edited session file, schema drift). Bail to
    // a clean reset on any envelope-level shape mismatch:
    //   - non-object / null / array
    //   - wrong `type` discriminator
    //   - non-numeric `version` (after the `version ?? 1` default)
    //   - non-object `fileStates`
    // Per-field coercion (sanitiseAttribution etc.) handles damage
    // INSIDE a structurally valid snapshot; this gate stops a
    // wholesale-wrong payload from polluting fileAttributions with
    // garbage keys before per-field validation can run.
    const isPlainObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v);
    const looksLikeSnapshot =
      isPlainObject(snapshot) &&
      (snapshot as Record<string, unknown>)['type'] === 'attribution-snapshot';
    if (!looksLikeSnapshot) {
      this.fileAttributions.clear();
      this.surface = getClientSurface();
      this.promptCount = 0;
      this.promptCountAtLastCommit = 0;
      return;
    }
    // Future schema bumps land here. Treat absent `version` as 1
    // (the schema in production at the time this field was added) so
    // existing on-disk snapshots restore cleanly.
    const snapshotVersion = snapshot.version ?? 1;
    if (snapshotVersion !== ATTRIBUTION_SNAPSHOT_VERSION) {
      // Don't trust a stale shape — its fields may have moved or
      // changed semantics. Reset to a fresh state rather than
      // splice incompatible data.
      this.fileAttributions.clear();
      this.surface = getClientSurface();
      this.promptCount = 0;
      this.promptCountAtLastCommit = 0;
      return;
    }

    // `surface` is embedded verbatim in the git-notes payload and used
    // as a Map/Record key downstream. A corrupted snapshot with a
    // non-string value (e.g. `{}`, `42`, `null`) would coerce into
    // strings like `[object Object]` and break the payload shape.
    // Fall back to the current client surface when the stored value
    // isn't a string.
    this.surface =
      typeof snapshot.surface === 'string' && snapshot.surface.length > 0
        ? snapshot.surface
        : getClientSurface();
    // A corrupted or partially-written snapshot can leave numeric
    // counters as `undefined`; without coercion, downstream
    // `Math.min(undefined, n)` produces NaN that flows into the
    // git-notes payload. Coerce per-field with a typed default.
    this.promptCount = sanitiseCount(snapshot.promptCount);
    this.promptCountAtLastCommit = sanitiseCount(
      snapshot.promptCountAtLastCommit,
    );
    // Enforce the invariant `atLastCommit <= total`: a corrupted /
    // partially-written snapshot with the inverse would surface a
    // negative `getPromptsSinceLastCommit()` and propagate as a
    // "(-3)-shotted" trailer into PR descriptions.
    if (this.promptCountAtLastCommit > this.promptCount) {
      this.promptCountAtLastCommit = this.promptCount;
    }

    this.fileAttributions.clear();
    // Reject a corrupted `fileStates` (e.g. an array, a string, or
    // null) before iterating: `Object.entries(<array>)` would happily
    // produce `[index, value]` pairs and seed fileAttributions with
    // numeric-string keys.
    const fileStates = isPlainObject(snapshot.fileStates)
      ? snapshot.fileStates
      : {};
    for (const [k, v] of Object.entries(fileStates)) {
      // Re-canonicalise on restore so old snapshots (written before
      // recordEdit started running keys through realpath) end up
      // with the same shape as newly-recorded entries. If both the
      // symlinked and canonical forms were stored under separate
      // keys (e.g. a session straddling the canonicalisation fix),
      // collapsing them onto the same canonical key MUST merge their
      // attribution rather than overwrite — otherwise the second
      // entry to land wins and the AI's accumulated contribution from
      // the first form is silently dropped.
      const canonicalKey = realpathOrSelf(k);
      const incoming = sanitiseAttribution(v);
      const existing = this.fileAttributions.get(canonicalKey);
      if (existing) {
        this.fileAttributions.set(canonicalKey, {
          aiContribution: existing.aiContribution + incoming.aiContribution,
          aiCreated: existing.aiCreated || incoming.aiCreated,
        });
      } else {
        this.fileAttributions.set(canonicalKey, incoming);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Payload generation
  // -----------------------------------------------------------------------

  /**
   * Generate the git notes JSON payload by combining tracked AI contributions
   * with staged file information from git.
   */
  generateNotePayload(
    stagedInfo: StagedFileInfo,
    baseDir: string,
    generatorName?: string,
  ): CommitAttributionNote {
    const generator = sanitizeModelName(
      generatorName ?? SANITIZED_GENERATOR_NAME,
    );

    const files: Record<string, FileAttributionDetail> = {};
    const excludedGenerated: string[] = [];
    let excludedGeneratedCount = 0;
    const surfaceCounts: Record<string, number> = {};
    let totalAiChars = 0;
    let totalHumanChars = 0;

    // Build lookup: relative path → tracked AI contribution. Keys in
    // `fileAttributions` are already canonical (recordEdit runs them
    // through realpath); we only need to canonicalise `baseDir`,
    // which comes from `git rev-parse --show-toplevel` and may be a
    // symlink (e.g. macOS `/var` → `/private/var`). Without that
    // canonicalisation `path.relative` would produce a `../...` key
    // that never matches the diff output. Normalize separators to
    // forward slashes so git paths line up on Windows.
    const canonicalBase = realpathOrSelf(baseDir);
    const aiLookup = new Map<string, FileAttribution>();
    for (const [absPath, attr] of this.fileAttributions) {
      const rel = path
        .relative(canonicalBase, absPath)
        .split(path.sep)
        .join('/');
      aiLookup.set(rel, attr);
    }

    for (const relFile of stagedInfo.files) {
      if (isGeneratedFile(relFile)) {
        excludedGeneratedCount++;
        // Cap the sample so a commit churning thousands of `dist/`
        // artifacts can't blow past the 30 KB note budget.
        if (excludedGenerated.length < MAX_EXCLUDED_GENERATED_SAMPLE) {
          excludedGenerated.push(relFile);
        }
        continue;
      }

      const tracked = aiLookup.get(relFile);
      const diffSize = stagedInfo.diffSizes.get(relFile) ?? 0;
      const isDeleted = stagedInfo.deletedFiles.has(relFile);

      let aiChars: number;
      let humanChars: number;

      if (tracked) {
        // Clamp aiChars to diffSize so aiChars+humanChars stays
        // consistent with the committed change magnitude derived from
        // `git diff --numstat`. Without this, cases where
        // tracked.aiContribution exceeds the committed change size
        // can leave aiChars > diffSize: humanChars then snaps to 0
        // but aiChars stays large, inflating the per-file total
        // beyond what was committed.
        aiChars = Math.min(tracked.aiContribution, diffSize);
        humanChars = Math.max(0, diffSize - aiChars);
      } else if (isDeleted) {
        // Deleted files with no AI tracking are attributed entirely to
        // the human. diffSize comes from `git diff --numstat` so empty
        // deletions legitimately have diffSize=0 — a magic fallback
        // would only inflate totals.
        aiChars = 0;
        humanChars = diffSize;
      } else {
        aiChars = 0;
        humanChars = diffSize;
      }

      const total = aiChars + humanChars;
      const percent = total > 0 ? Math.round((aiChars / total) * 100) : 0;

      files[relFile] = { aiChars, humanChars, percent, surface: this.surface };
      totalAiChars += aiChars;
      totalHumanChars += humanChars;
      surfaceCounts[this.surface] =
        (surfaceCounts[this.surface] ?? 0) + aiChars;
    }

    const totalChars = totalAiChars + totalHumanChars;
    const aiPercent =
      totalChars > 0 ? Math.round((totalAiChars / totalChars) * 100) : 0;

    // Surface breakdown
    const surfaceBreakdown: Record<
      string,
      { aiChars: number; percent: number }
    > = {};
    for (const [surf, chars] of Object.entries(surfaceCounts)) {
      surfaceBreakdown[surf] = {
        aiChars: chars,
        percent: totalChars > 0 ? Math.round((chars / totalChars) * 100) : 0,
      };
    }

    return {
      version: 1,
      generator,
      files,
      summary: {
        aiPercent,
        aiChars: totalAiChars,
        humanChars: totalHumanChars,
        totalFilesTouched: Object.keys(files).length,
        surfaces: [this.surface],
      },
      surfaceBreakdown,
      excludedGenerated,
      excludedGeneratedCount,
      promptCount: this.getPromptsSinceLastCommit(),
    };
  }
}

// ---------------------------------------------------------------------------
// Character contribution calculation (Claude's prefix/suffix algorithm)
// ---------------------------------------------------------------------------

/**
 * Compute the character contribution for a file modification.
 * Uses common prefix/suffix matching to find the actual changed region,
 * then returns the larger of the old/new changed lengths.
 */
export function computeCharContribution(
  oldContent: string,
  newContent: string,
): number {
  if (oldContent === '' || newContent === '') {
    return oldContent === '' ? newContent.length : oldContent.length;
  }

  const minLen = Math.min(oldContent.length, newContent.length);
  let prefixEnd = 0;
  while (
    prefixEnd < minLen &&
    oldContent[prefixEnd] === newContent[prefixEnd]
  ) {
    prefixEnd++;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixEnd &&
    oldContent[oldContent.length - 1 - suffixLen] ===
      newContent[newContent.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldChangedLen = oldContent.length - prefixEnd - suffixLen;
  const newChangedLen = newContent.length - prefixEnd - suffixLen;
  return Math.max(oldChangedLen, newChangedLen);
}
