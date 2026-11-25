/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  ActiveLeafEntry,
  Entry,
} from '../../protocol/transcript/entry.js';
import { decodeTranscriptLine, encodeTranscriptEntry } from './entry-codec.js';

describe('transcript entry codec', () => {
  it('encodes one entry as one UTF-8 JSONL record', () => {
    const entry: Entry = {
      type: 'custom-title',
      sessionId: 'session-1',
      customTitle: '中文标题',
    };

    const encoded = encodeTranscriptEntry(entry);

    expect(encoded.bytes.at(-1)).toBe(0x0a);
    expect(encoded.bytes.toString('utf8')).toBe(`${JSON.stringify(entry)}\n`);
    expect(decodeTranscriptLine(encoded.bytes.subarray(0, -1))).toEqual({
      kind: 'entry',
      entry,
    });
  });

  it('does not impose a single-entry size limit', () => {
    const entry: Entry = {
      type: 'summary',
      leafUuid: 'leaf-1',
      summary: 'x'.repeat(3 * 1024 * 1024),
    };

    const encoded = encodeTranscriptEntry(entry);
    const decoded = decodeTranscriptLine(encoded.bytes.subarray(0, -1));

    expect(encoded.bytes.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(decoded).toMatchObject({ kind: 'entry', entry });
  });

  it('round-trips MCP semantic result metadata without projecting it into content', () => {
    const entry: Entry = {
      type: 'user',
      uuid: 'user-mcp-result',
      timestamp: '2026-08-19T12:00:00.000Z',
      parentUuid: null,
      isSidechain: false,
      cwd: '/workspace',
      sessionId: 'session-mcp',
      userType: 'external',
      version: 'test',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-mcp',
            content: 'model-visible content',
          },
        ],
      },
      toolUseResult: [{ type: 'text', text: 'semantic content' }],
      mcpMeta: {
        _meta: { ui: { resourceUri: 'ui://example/app' } },
        structuredContent: { value: 1 },
      },
    };

    const encoded = encodeTranscriptEntry(entry);

    expect(decodeTranscriptLine(encoded.bytes.subarray(0, -1))).toEqual({
      kind: 'entry',
      entry,
    });
  });

  it('distinguishes malformed, unknown and invalid-shape records', () => {
    expect(decodeTranscriptLine('{')).toMatchObject({ kind: 'malformed' });
    expect(decodeTranscriptLine('{"type":"future-entry","value":1}')).toEqual({
      kind: 'unknown',
      type: 'future-entry',
      value: { type: 'future-entry', value: 1 },
    });
    expect(decodeTranscriptLine('{"type":"custom-title"}')).toEqual({
      kind: 'invalid-shape',
      type: 'custom-title',
      value: { type: 'custom-title' },
    });
  });

  it('round-trips a valid active leaf marker', () => {
    const activeLeaf: ActiveLeafEntry = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: 'user-2',
      explicit: false,
      compactBoundaryUuid: 'compact-boundary-1',
      timestamp: 1_754_300_000_000,
    };

    expect(decodeTranscriptLine(JSON.stringify(activeLeaf))).toEqual({
      kind: 'entry',
      entry: activeLeaf,
    });
  });

  it.each([
    {
      name: 'numeric leaf UUID',
      value: {
        type: 'active-leaf',
        sessionId: 'session-1',
        leafUuid: 2,
        explicit: true,
        timestamp: 1,
      },
    },
    {
      name: 'missing explicit flag',
      value: {
        type: 'active-leaf',
        sessionId: 'session-1',
        leafUuid: null,
        timestamp: 1,
      },
    },
    {
      name: 'non-boolean rewound flag',
      value: {
        type: 'active-leaf',
        sessionId: 'session-1',
        leafUuid: null,
        explicit: true,
        rewound: 'yes',
        timestamp: 1,
      },
    },
    {
      name: 'non-numeric timestamp',
      value: {
        type: 'active-leaf',
        sessionId: 'session-1',
        leafUuid: null,
        explicit: true,
        timestamp: 'now',
      },
    },
    {
      name: 'non-string compact boundary UUID',
      value: {
        type: 'active-leaf',
        sessionId: 'session-1',
        leafUuid: 'user-2',
        explicit: false,
        compactBoundaryUuid: 2,
        timestamp: 1,
      },
    },
    {
      name: 'explicit compaction commit',
      value: {
        type: 'active-leaf',
        sessionId: 'session-1',
        leafUuid: 'user-2',
        explicit: true,
        compactBoundaryUuid: 'compact-boundary-1',
        timestamp: 1,
      },
    },
  ])('rejects an active leaf marker with $name', ({ value }) => {
    expect(decodeTranscriptLine(JSON.stringify(value))).toEqual({
      kind: 'invalid-shape',
      type: 'active-leaf',
      value,
    });
  });

  it('rejects a compact boundary with a non-boolean commit requirement', () => {
    const value = {
      type: 'system',
      uuid: 'compact-boundary-1',
      timestamp: '2026-08-04T00:00:00.000Z',
      subtype: 'compact_boundary',
      requiresActiveLeafCommit: 'yes',
    };

    expect(decodeTranscriptLine(JSON.stringify(value))).toEqual({
      kind: 'invalid-shape',
      type: 'system',
      value,
    });
  });

  it('decodes relocation and worktree lifecycle entries', () => {
    const relocated = {
      type: 'relocated',
      sessionId: 'session-1',
      relocatedCwd: '/workspace/worktree',
    };
    const worktreeState = {
      type: 'worktree-state',
      sessionId: 'session-1',
      worktreeSession: {
        originalCwd: '/workspace/project',
        preEnterOriginalCwd: '/workspace/project',
        worktreePath: '/workspace/worktree',
        worktreeCwd: '/workspace/worktree/apps/desktop',
        worktreeName: 'feature',
        worktreeBranch: 'worktree-feature',
        sessionId: 'session-1',
        lifecycle: 'owner',
        enteredExisting: true,
      },
    };

    expect(decodeTranscriptLine(JSON.stringify(relocated))).toEqual({
      kind: 'entry',
      entry: relocated,
    });
    expect(decodeTranscriptLine(JSON.stringify(worktreeState))).toEqual({
      kind: 'entry',
      entry: worktreeState,
    });

    const historicalWorktreeState = {
      ...worktreeState,
      worktreeSession: {
        ...worktreeState.worktreeSession,
        worktreeCwd: undefined,
      },
    };
    delete historicalWorktreeState.worktreeSession.worktreeCwd;

    expect(decodeTranscriptLine(JSON.stringify(historicalWorktreeState))).toEqual(
      {
        kind: 'entry',
        entry: historicalWorktreeState,
      },
    );
  });

  it.each([
    { worktreeCwd: 42 },
    { pendingExit: false },
    { pendingExit: 'true' },
  ])('rejects invalid optional worktree state fields: %j', (invalidFields) => {
    const entry = {
      type: 'worktree-state',
      sessionId: 'session-1',
      worktreeSession: {
        originalCwd: '/workspace/project',
        worktreePath: '/workspace/worktree',
        ...invalidFields,
        worktreeName: 'feature',
        sessionId: 'session-1',
      },
    };

    expect(decodeTranscriptLine(JSON.stringify(entry))).toEqual({
      kind: 'invalid-shape',
      type: 'worktree-state',
      value: entry,
    });
  });

  it.each([
    { originalCwd: 'relative/project' },
    { worktreePath: 'relative/worktree' },
    { worktreeCwd: 'relative/worktree/app' },
    { pendingOwnerReleasePath: 'relative/previous-worktree' },
  ])('rejects unsafe persisted worktree paths: %j', (invalidFields) => {
    const entry = {
      type: 'worktree-state',
      sessionId: 'session-1',
      worktreeSession: {
        originalCwd: '/workspace/project',
        worktreePath: '/workspace/worktree',
        worktreeCwd: '/workspace/worktree/app',
        worktreeName: 'feature',
        sessionId: 'session-1',
        ...invalidFields,
      },
    };

    expect(decodeTranscriptLine(JSON.stringify(entry))).toEqual({
      kind: 'invalid-shape',
      type: 'worktree-state',
      value: entry,
    });
  });

  it('decodes a transient previous-owner release marker for a worktree handoff', () => {
    const entry = {
      type: 'worktree-state',
      sessionId: 'session-1',
      worktreeSession: {
        originalCwd: '/workspace/project',
        worktreePath: '/workspace/worktree-b',
        worktreeCwd: '/workspace/worktree-b/apps/desktop',
        worktreeName: 'feature-b',
        sessionId: 'session-1',
        lifecycle: 'owner',
        pendingOwnerReleasePath: '/workspace/worktree-a',
      },
    };

    expect(decodeTranscriptLine(JSON.stringify(entry))).toEqual({
      kind: 'entry',
      entry,
    });
  });

  it.each([
    { name: 'empty', pendingOwnerReleasePath: '' },
    { name: 'non-string', pendingOwnerReleasePath: 42 },
  ])(
    'rejects a worktree handoff marker with a $name previous-owner path',
    ({ pendingOwnerReleasePath }) => {
      const entry = {
        type: 'worktree-state',
        sessionId: 'session-1',
        worktreeSession: {
          originalCwd: '/workspace/project',
          worktreePath: '/workspace/worktree-b',
          worktreeName: 'feature-b',
          sessionId: 'session-1',
          pendingOwnerReleasePath,
        },
      };

      expect(decodeTranscriptLine(JSON.stringify(entry))).toEqual({
        kind: 'invalid-shape',
        type: 'worktree-state',
        value: entry,
      });
    },
  );
});
