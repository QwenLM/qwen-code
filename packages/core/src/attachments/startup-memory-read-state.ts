/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttachmentToolUseContext } from './types.js';
import type { FileState } from '../utils/fileStateCache.js';
import type { StaticMemoryFileState } from '../utils/memoryDiscovery.js';

export interface StartupStaticMemoryFileStateSource {
  getStaticMemoryFileStates?(): readonly StaticMemoryFileState[];
}

/**
 * Seed startup-loaded AGENTS-style memory files into readFileState once the
 * session attachment context is created. The rendered user context stays frozen;
 * later external edits are picked up by the normal changed_files attachment path.
 */
export function seedStartupStaticMemoryFileReadState(
  ctx: AttachmentToolUseContext,
  source: unknown,
): number {
  const states = getStaticMemoryFileStates(source);
  if (!states || states.length === 0) return 0;

  let seeded = 0;
  for (const state of states) {
    const fileState: FileState = {
      content: state.content,
      timestamp: state.timestamp,
      offset: undefined,
      limit: undefined,
      ...(state.isPartialView ? { isPartialView: true } : {}),
    };
    ctx.readFileState.set(state.filePath, fileState);
    ctx.fileReadState.set(state.filePath, fileState);
    seeded += 1;
  }

  return seeded;
}

function getStaticMemoryFileStates(
  source: unknown,
): readonly StaticMemoryFileState[] | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const getStates = (source as StartupStaticMemoryFileStateSource)
    .getStaticMemoryFileStates;
  if (typeof getStates !== 'function') return undefined;
  return getStates.call(source);
}
