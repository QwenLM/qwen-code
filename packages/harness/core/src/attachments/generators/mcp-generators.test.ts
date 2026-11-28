/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createToolFileStateCache } from '../../utils/fileStateCache.js';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getMcpInstructionsDeltaAttachments,
  resetMcpInstructionsDeltaState,
} from './mcp-generators.js';
import type {
  AttachmentToolUseContext,
  AttachmentExternalContext,
} from '../types.js';
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js';

function createCtx(): AttachmentToolUseContext {
  return {
    fileReadState: createToolFileStateCache(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    cwd: '/project',
    loadedNestedMemoryPaths: new Set(),
    sentSkillNames: new Map(),
    pendingHookOutputs: [],
    pendingHookAttachments: [],
    postCompactCandidates: null,
    announcedMcpInstructionServers: new Set(),
    announcedLazyMcpTools: new Set(),
    announcedAgentTypes: new Set(),
    seenSessionStartHookOutputs: new Set(),
  };
}

function createExternalContext(
  servers: Array<{ serverName: string; instructions: string | undefined }>,
): AttachmentExternalContext {
  return {
    mcpClientManager: {
      getConnectedServerInstructions: () => servers,
    },
  };
}

describe('getMcpInstructionsDeltaAttachments', () => {
  let ctx: AttachmentToolUseContext;

  beforeEach(() => {
    ctx = createCtx();
  });

  it('returns [] when no externalContext is provided', () => {
    const result = getMcpInstructionsDeltaAttachments(ctx);
    expect(result).toEqual([]);
  });

  it('returns [] when mcpClientManager is not in externalContext', () => {
    const result = getMcpInstructionsDeltaAttachments(ctx, {});
    expect(result).toEqual([]);
  });

  it('returns [] when no servers have instructions', () => {
    const ext = createExternalContext([
      { serverName: 'server-a', instructions: undefined },
    ]);
    const result = getMcpInstructionsDeltaAttachments(ctx, ext);
    expect(result).toEqual([]);
  });

  it('emits added servers with instructions on first call', () => {
    const ext = createExternalContext([
      { serverName: 'server-a', instructions: 'Use tools X and Y' },
      { serverName: 'server-b', instructions: 'Always call Z first' },
    ]);

    const result = getMcpInstructionsDeltaAttachments(ctx, ext);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('mcp_instructions_delta');
    expect(result[0].addedNames).toEqual(['server-a', 'server-b']);
    expect(result[0].addedBlocks).toEqual([
      '## server-a\nUse tools X and Y',
      '## server-b\nAlways call Z first',
    ]);
    expect(result[0].removedNames).toEqual([]);
  });

  it('updates announced set after emitting delta', () => {
    const ext = createExternalContext([
      { serverName: 'server-a', instructions: 'Use tools X and Y' },
    ]);

    getMcpInstructionsDeltaAttachments(ctx, ext);

    expect(ctx.announcedMcpInstructionServers.has('server-a')).toBe(true);
  });

  it('returns [] on second call with same servers', () => {
    const ext = createExternalContext([
      { serverName: 'server-a', instructions: 'Use tools X and Y' },
    ]);

    getMcpInstructionsDeltaAttachments(ctx, ext);
    const result = getMcpInstructionsDeltaAttachments(ctx, ext);

    expect(result).toEqual([]);
  });

  it('emits only newly connected servers on subsequent calls', () => {
    const ext1 = createExternalContext([
      { serverName: 'server-a', instructions: 'Instruction A' },
    ]);
    getMcpInstructionsDeltaAttachments(ctx, ext1);

    const ext2 = createExternalContext([
      { serverName: 'server-a', instructions: 'Instruction A' },
      { serverName: 'server-b', instructions: 'Instruction B' },
    ]);
    const result = getMcpInstructionsDeltaAttachments(ctx, ext2);

    expect(result).toHaveLength(1);
    expect(result[0].addedNames).toEqual(['server-b']);
    expect(result[0].addedBlocks).toEqual(['## server-b\nInstruction B']);
    expect(result[0].removedNames).toEqual([]);
  });

  it('emits removed servers when previously announced servers disconnect', () => {
    const ext1 = createExternalContext([
      { serverName: 'server-a', instructions: 'Instruction A' },
      { serverName: 'server-b', instructions: 'Instruction B' },
    ]);
    getMcpInstructionsDeltaAttachments(ctx, ext1);

    // server-b disconnected
    const ext2 = createExternalContext([
      { serverName: 'server-a', instructions: 'Instruction A' },
    ]);
    const result = getMcpInstructionsDeltaAttachments(ctx, ext2);

    expect(result).toHaveLength(1);
    expect(result[0].addedNames).toEqual([]);
    expect(result[0].addedBlocks).toEqual([]);
    expect(result[0].removedNames).toEqual(['server-b']);
  });

  it('emits both added and removed in the same delta', () => {
    const ext1 = createExternalContext([
      { serverName: 'server-a', instructions: 'Instruction A' },
    ]);
    getMcpInstructionsDeltaAttachments(ctx, ext1);

    // server-a disconnected, server-b connected
    const ext2 = createExternalContext([
      { serverName: 'server-b', instructions: 'Instruction B' },
    ]);
    const result = getMcpInstructionsDeltaAttachments(ctx, ext2);

    expect(result).toHaveLength(1);
    expect(result[0].addedNames).toEqual(['server-b']);
    expect(result[0].removedNames).toEqual(['server-a']);
  });

  it('removes disconnected server from announced set', () => {
    const ext1 = createExternalContext([
      { serverName: 'server-a', instructions: 'Instruction A' },
    ]);
    getMcpInstructionsDeltaAttachments(ctx, ext1);

    // server-a disconnects
    const ext2 = createExternalContext([]);
    getMcpInstructionsDeltaAttachments(ctx, ext2);

    expect(ctx.announcedMcpInstructionServers.has('server-a')).toBe(false);
  });

  it('does not announce servers without instructions', () => {
    const ext = createExternalContext([
      { serverName: 'server-a', instructions: 'Has instructions' },
      { serverName: 'server-b', instructions: undefined },
    ]);

    const result = getMcpInstructionsDeltaAttachments(ctx, ext);

    expect(result).toHaveLength(1);
    expect(result[0].addedNames).toEqual(['server-a']);
    expect(ctx.announcedMcpInstructionServers.has('server-b')).toBe(false);
  });

  it('does not mark removal for servers that had no instructions', () => {
    // server-a without instructions connects then disconnects
    const ext1 = createExternalContext([
      { serverName: 'server-a', instructions: undefined },
    ]);
    getMcpInstructionsDeltaAttachments(ctx, ext1);

    const ext2 = createExternalContext([]);
    const result = getMcpInstructionsDeltaAttachments(ctx, ext2);

    // No delta because server-a was never announced
    expect(result).toEqual([]);
  });

  it('sorts added names deterministically', () => {
    const ext = createExternalContext([
      { serverName: 'charlie', instructions: 'C' },
      { serverName: 'alpha', instructions: 'A' },
      { serverName: 'bravo', instructions: 'B' },
    ]);

    const result = getMcpInstructionsDeltaAttachments(ctx, ext);

    expect(result[0].addedNames).toEqual(['alpha', 'bravo', 'charlie']);
    // blocks should be sorted consistently with names
    expect(result[0].addedBlocks).toEqual([
      '## alpha\nA',
      '## bravo\nB',
      '## charlie\nC',
    ]);
  });

  it('sorts removed names deterministically', () => {
    const ext1 = createExternalContext([
      { serverName: 'charlie', instructions: 'C' },
      { serverName: 'alpha', instructions: 'A' },
    ]);
    getMcpInstructionsDeltaAttachments(ctx, ext1);

    const ext2 = createExternalContext([]);
    const result = getMcpInstructionsDeltaAttachments(ctx, ext2);

    expect(result[0].removedNames).toEqual(['alpha', 'charlie']);
  });
});

describe('resetMcpInstructionsDeltaState', () => {
  it('clears the announced set', () => {
    const ctx = createCtx();
    ctx.announcedMcpInstructionServers.add('server-a');
    ctx.announcedMcpInstructionServers.add('server-b');

    resetMcpInstructionsDeltaState(ctx);

    expect(ctx.announcedMcpInstructionServers.size).toBe(0);
  });

  it('causes full re-announcement on next delta call', () => {
    const ctx = createCtx();
    const ext = createExternalContext([
      { serverName: 'server-a', instructions: 'Instruction A' },
    ]);

    // First announcement
    getMcpInstructionsDeltaAttachments(ctx, ext);
    expect(getMcpInstructionsDeltaAttachments(ctx, ext)).toEqual([]);

    // Reset (simulating compaction)
    resetMcpInstructionsDeltaState(ctx);

    // Should re-announce
    const result = getMcpInstructionsDeltaAttachments(ctx, ext);
    expect(result).toHaveLength(1);
    expect(result[0].addedNames).toEqual(['server-a']);
  });
});
