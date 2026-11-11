/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Memory attachment generators.
 *
 * Generators covering the memory system:
 *
 *   seedStaticMemoryPaths()              — seed loadedNestedMemoryPaths for JIT dedup (no attachment)
 *   getRelevantMemoriesAttachments()        — newly discovered memory files (JIT / delta by path)
 *
 * Startup memory (global/plugin/project/local tiers + the auto-memory MEMORY.md
 * baseline) is injected ephemerally via prependUserContext() in
 * buildRequestMessages() and frozen for the session (see
 * MemoryContextManager.getUserContext()). seedStaticMemoryPaths() also seeds
 * auto-memory MEMORY.md files into readFileState, so mid-session edits flow
 * through the same edited_text_file path as other tracked text files.
 */

import * as fs from 'node:fs/promises';
import { pathInAllowedWorkingPath } from '../../tools/filesystem-permissions/filesystem.js';
import { isFileReadDenied } from '../../tools/filesystem-permissions/filesystem.js';
import { pathPermissionContextOf } from '../path-permission.js';
import {
  isRuleMemoryPath,
  stripFrontmatter,
} from '../../utils/memoryDiscovery.js';
import type { FileState } from '../../utils/fileStateCache.js';
import {
  type AttachmentToolUseContext,
  type AttachmentExternalContext,
  RelevantMemoriesAttachment,
} from '../types.js';


// ── seedStaticMemoryPaths ────────────────────────────────────────────────────

/**
 * Seed ctx.loadedNestedMemoryPaths from the static memory tiers so that
 * getRelevantMemoriesAttachments() does not re-emit @import-resolved children
 * that are already inlined into the startup memory content.
 *
 * Must be called once per session (first turn) and again after compaction.
 * Controlled by ctx.isFirstTurnSeedDone.
 *
 * Does NOT emit any attachments — startup memory is injected ephemerally
 * via prependUserContext() in buildRequestMessages().
 */
export function seedStaticMemoryPaths(
  ctx: AttachmentToolUseContext,
  externalCtx: AttachmentExternalContext | undefined,
): void {
  const mgr = externalCtx?.memoryContextManager;
  const sdkMemoryFileStates = externalCtx?.sdkMemoryFileStates ?? [];
  if (!mgr && sdkMemoryFileStates.length === 0) return;

  if (!ctx.isFirstTurnSeedDone) {
    // First call: seed paths loaded at startup (tier roots + @import children)
    // into the dedup set so getRelevantMemoriesAttachments does not re-emit them.
    // Exclude JIT-discovered paths — those must remain detectable as a delta.
    const jitPaths = mgr?.getJitDiscoveredPaths?.();
    const jitSet = jitPaths
      ? new Set<string>([...jitPaths.project, ...jitPaths.local])
      : null;

    for (const p of mgr?.getLoadedPaths() ?? []) {
      if (!jitSet || !jitSet.has(p)) {
        ctx.loadedNestedMemoryPaths.add(p);
      }
    }
    seedAutoMemoryIndexReadState(ctx, externalCtx);
    seedRuleFileReadState(ctx, externalCtx);
    seedSdkMemoryFileReadState(ctx, externalCtx);
    ctx.isFirstTurnSeedDone = true;
  } else {
    // Post-compact / tier-change path: re-absorb categorized tier paths
    // so their @import children don't leak into relevant_memories. JIT
    // paths added between turns stay out of this set.
    const categorized = mgr?.getCategorizedPaths?.();
    if (categorized) {
      for (const p of categorized.global) ctx.loadedNestedMemoryPaths.add(p);
      for (const p of categorized.plugin) ctx.loadedNestedMemoryPaths.add(p);
      for (const p of categorized.project) ctx.loadedNestedMemoryPaths.add(p);
      for (const p of categorized.local) ctx.loadedNestedMemoryPaths.add(p);
    }
  }
}

function seedSdkMemoryFileReadState(
  ctx: AttachmentToolUseContext,
  externalCtx: AttachmentExternalContext | undefined,
): void {
  for (const state of externalCtx?.sdkMemoryFileStates ?? []) {
    const fileState: FileState = {
      content: state.content,
      timestamp: state.timestamp,
      offset: undefined,
      limit: undefined,
      ...(state.isPartialView ? { isPartialView: true } : {}),
      ...(state.retainIfMissing ? { retainIfMissing: true } : {}),
    };
    ctx.readFileState.set(state.filePath, fileState);
    ctx.fileReadState.set(state.filePath, fileState);
  }
}

function seedAutoMemoryIndexReadState(
  ctx: AttachmentToolUseContext,
  externalCtx: AttachmentExternalContext | undefined,
): void {
  // Auto-memory MEMORY.md reaches the model via prependUserContext, not a Read
  // tool result. Seed the same raw file bytes here so later writes surface as
  // ordinary edited_text_file attachments.
  const states =
    externalCtx?.memoryContextManager?.getAutoMemoryIndexFileStates?.();
  if (!states || states.length === 0) return;

  for (const state of states) {
    const fileState: FileState = {
      content: state.content,
      timestamp: state.timestamp,
      offset: undefined,
      limit: undefined,
      ...(state.isPartialView ? { isPartialView: true } : {}),
      ...(state.retainIfMissing ? { retainIfMissing: true } : {}),
    };
    ctx.readFileState.set(state.indexPath, fileState);
    ctx.fileReadState.set(state.indexPath, fileState);
  }
}

function seedRuleFileReadState(
  ctx: AttachmentToolUseContext,
  externalCtx: AttachmentExternalContext | undefined,
): void {
  // Project rule files (.qwen/rules/*.md) reach the model via
  // prependUserContext, not a Read tool result, so their content is frozen for
  // the session. Seed the raw disk bytes here so later edits surface as
  // ordinary edited_text_file attachments — the same change-detection path used
  // for auto-memory MEMORY.md.
  const states = externalCtx?.memoryContextManager?.getRuleFileStates?.();
  if (!states || states.length === 0) return;

  for (const state of states) {
    const fileState: FileState = {
      content: state.content,
      timestamp: state.timestamp,
      offset: undefined,
      limit: undefined,
      ...(state.isPartialView ? { isPartialView: true } : {}),
    };
    ctx.readFileState.set(state.rulePath, fileState);
    ctx.fileReadState.set(state.rulePath, fileState);
  }
}

// ── getRelevantMemoriesAttachments ──────────────────────────────────────────────

/**
 * Emit a RelevantMemoriesAttachment for newly discovered memory files.
 *
 * Uses ctx.loadedNestedMemoryPaths as the "already seen" set and compares
 * against mgr.getLoadedPaths() to find new files. Reads each new file's
 * content from disk (fallback to '' on error).
 *
 * This covers JIT / subdirectory memory discovery triggered by file access.
 */
export async function getRelevantMemoriesAttachments(
  ctx: AttachmentToolUseContext,
  externalCtx: AttachmentExternalContext | undefined,
): Promise<RelevantMemoriesAttachment[]> {
  const mgr = externalCtx?.memoryContextManager;
  if (!mgr) return [];

  const currentPaths = mgr.getLoadedPaths();
  const pathCtx = pathPermissionContextOf(ctx);
  const newPaths: string[] = [];
  for (const p of currentPaths) {
    if (!ctx.loadedNestedMemoryPaths.has(p)) {
      // Guard: only inject memory files that reside within the working
      // directory. Prevents a rogue AGENTS.md outside the workspace from
      // being auto-injected into context without user consent.
      if (
        pathCtx &&
        (!pathInAllowedWorkingPath(p, pathCtx, ctx.cwd) ||
          isFileReadDenied(p, pathCtx, ctx.cwd))
      ) {
        continue;
      }
      newPaths.push(p);
    }
  }

  if (newPaths.length === 0) return [];

  const files = await Promise.all(
    newPaths.map(async (filePath) => {
      // JIT-discovered files are always the 'jit' tier
      const memoryType = 'jit';
      let raw = '';
      let mtimeMs = 0;
      try {
        const [stats, fileContent] = await Promise.all([
          fs.stat(filePath),
          fs.readFile(filePath, 'utf8'),
        ]);
        raw = fileContent;
        mtimeMs = stats.mtimeMs;
      } catch {
        // File may have been deleted or access denied — skip silently
        return { filePath, content: '', memoryType };
      }

      // Strip the leading frontmatter block from rule files so internal
      // `paths:`/glob routing metadata is not injected (matches the startup
      // path and cc's parseFrontmatter). Non-rule nested memory is injected
      // verbatim.
      const injected = isRuleMemoryPath(filePath) ? stripFrontmatter(raw) : raw;

      // Seed readFileState with the RAW disk bytes so mid-session edits to this
      // JIT-loaded file surface as edited_text_file via getChangedFiles —
      // mirroring cc's memoryFilesToAttachments seeding. isPartialView is set
      // when the injected view differs from disk so Edit/Write still require a
      // real Read first.
      if (!ctx.readFileState.has(filePath)) {
        const fileState: FileState = {
          content: raw,
          timestamp: Math.floor(mtimeMs),
          offset: undefined,
          limit: undefined,
          ...(injected !== raw ? { isPartialView: true } : {}),
        };
        ctx.readFileState.set(filePath, fileState);
        ctx.fileReadState.set(filePath, fileState);
      }

      return { filePath, content: injected, memoryType };
    }),
  );

  // Update tracking set AFTER reading so that failures don't block re-discovery
  for (const p of newPaths) {
    ctx.loadedNestedMemoryPaths.add(p);
  }

  const nonEmpty = files.filter((f) => f.content.trim().length > 0);
  if (nonEmpty.length === 0) return [];

  return [
    new RelevantMemoriesAttachment({
      type: 'relevant_memories' as const,
      files: nonEmpty,
    }),
  ];
}
