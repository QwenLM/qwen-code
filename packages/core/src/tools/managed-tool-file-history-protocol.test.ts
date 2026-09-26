/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureManagedToolExecutionContext,
  parseManagedToolFileHistoryBinding,
  type ManagedToolExecutionContext,
  parseManagedToolFileHistoryPromptId,
  parseManagedToolFileHistoryState,
} from './managed-tool-file-history-protocol.js';
import { managedToolDigest } from './managed-tool-protocol.js';
import type { Config } from '../config/config.js';

const ownerSessionId = '550e8400-e29b-41d4-a716-446655440108';
const ownerRuntimeSessionId = '550e8400-e29b-41d4-a716-446655440109';
const timestamp = '2026-09-09T00:00:00.000Z';
const backup = {
  backupFileName: '0123456789abcdef@v1',
  version: 1,
  backupTime: timestamp,
};
const snapshot = {
  promptId: 'parent-turn',
  timestamp,
  trackedFileBackups: { 'proof.txt': backup },
};
const binding = {
  ownerSessionId,
  ownerRuntimeSessionId,
  executionCwd: path.resolve('managed-child'),
  snapshots: [snapshot],
};

describe('managed file history protocol', () => {
  const context: ManagedToolExecutionContext = {
    workspaceDirectories: [
      binding.executionCwd,
      path.resolve('additional-workspace'),
    ],
    memoryBaseDir: path.resolve('gateway-memory'),
    lsToolEnabled: true,
    fileFilteringOptions: {
      respectGitIgnore: false,
      respectQwenIgnore: true,
      customIgnoreFiles: [],
    },
  };

  it('copies the exact execution scope without adding directories or default ignore files', () => {
    const input = { ...binding, executionContext: structuredClone(context) };
    const parsed = parseManagedToolFileHistoryBinding(input);
    expect(parsed).toEqual(input);
    input.executionContext.workspaceDirectories.reverse();
    input.executionContext.fileFilteringOptions.customIgnoreFiles.push(
      '.laterignore',
    );
    expect(parsed.executionContext).toEqual(context);
    expect(
      parseManagedToolFileHistoryBinding({
        ...binding,
        executionContext: { ...context, workspaceDirectories: [] },
      }).executionContext?.workspaceDirectories,
    ).toEqual([]);
  });

  it.each([null, 17.5])(
    'round trips explicit output limits (%s) and backend preferences',
    (chars) => {
      const config = {
        getWorkspaceContext: () => ({
          getDirectories: () => context.workspaceDirectories,
        }),
        getMemoryBaseDir: () => context.memoryBaseDir,
        isLsToolEnabled: () => context.lsToolEnabled,
        getFileFilteringOptions: () => context.fileFilteringOptions,
        getUseRipgrep: () => false,
        getUseBuiltinRipgrep: () => true,
        getTruncateToolOutputThreshold: () => chars ?? Infinity,
        getTruncateToolOutputLines: () => Infinity,
        isTruncateToolOutputThresholdExplicit: () => true,
      } as unknown as Config;
      const captured = captureManagedToolExecutionContext(config);
      expect(captured.grepOptions).toEqual({
        useRipgrep: false,
        useBuiltinRipgrep: true,
      });
      expect(captured.outputLimits).toEqual({
        chars,
        lines: null,
        charsExplicit: true,
      });
      const parsed = parseManagedToolFileHistoryBinding(
        JSON.parse(JSON.stringify({ ...binding, executionContext: captured })),
      );
      expect(parsed.executionContext).toEqual(captured);
      captured.grepOptions!.useRipgrep = true;
      captured.outputLimits!.lines = 3;
      expect(parsed.executionContext?.grepOptions?.useRipgrep).toBe(false);
      expect(parsed.executionContext?.outputLimits?.lines).toBeNull();
    },
  );

  it.each([
    { grepOptions: {} },
    { grepOptions: { useRipgrep: 'true', useBuiltinRipgrep: true } },
    { grepOptions: { useRipgrep: true, useBuiltinRipgrep: true, extra: true } },
    { outputLimits: { chars: 0, lines: 1, charsExplicit: false } },
    { outputLimits: { chars: 1, lines: -1, charsExplicit: false } },
    { outputLimits: { chars: Infinity, lines: 1, charsExplicit: false } },
    { outputLimits: { chars: NaN, lines: 1, charsExplicit: false } },
    { outputLimits: { chars: null, lines: null } },
    { outputLimits: { chars: null, lines: null, charsExplicit: 'false' } },
  ])('rejects invalid search preferences and limits', (extra) => {
    expect(() =>
      parseManagedToolFileHistoryBinding({
        ...binding,
        executionContext: { ...context, ...extra },
      }),
    ).toThrow();
  });

  it.each([
    { ...context, extra: true },
    { ...context, workspaceDirectories: ['relative'] },
    {
      ...context,
      workspaceDirectories: [binding.executionCwd, binding.executionCwd],
    },
    { ...context, memoryBaseDir: 'relative' },
    { ...context, lsToolEnabled: 'true' },
    {
      ...context,
      fileFilteringOptions: { ...context.fileFilteringOptions, extra: true },
    },
    {
      ...context,
      fileFilteringOptions: {
        ...context.fileFilteringOptions,
        respectGitIgnore: 'true',
      },
    },
    {
      ...context,
      fileFilteringOptions: {
        ...context.fileFilteringOptions,
        customIgnoreFiles: ['../parent'],
      },
    },
    {
      ...context,
      fileFilteringOptions: {
        ...context.fileFilteringOptions,
        customIgnoreFiles: ['.qwenignore'],
      },
    },
    {
      ...context,
      fileFilteringOptions: {
        ...context.fileFilteringOptions,
        customIgnoreFiles: ['.custom', '.custom'],
      },
    },
  ])('rejects malformed execution context', (executionContext) => {
    expect(() =>
      parseManagedToolFileHistoryBinding({ ...binding, executionContext }),
    ).toThrow();
  });

  it('accepts accumulated history above 1 MiB without widening tool input limits', () => {
    const trackedFileBackups = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `${'directory/'.repeat(5)}file-${i}.txt`,
        backup,
      ]),
    );
    const snapshots = Array.from({ length: 100 }, (_, i) => ({
      promptId: `turn-${i}`,
      timestamp,
      trackedFileBackups,
    }));
    const state = { ownerSessionId, revision: 100, snapshots };
    expect(Buffer.byteLength(JSON.stringify(state))).toBeGreaterThan(
      1024 * 1024,
    );
    expect(
      parseManagedToolFileHistoryBinding({ ...binding, snapshots }).snapshots,
    ).toEqual(snapshots);
    expect(parseManagedToolFileHistoryState(state)).toEqual(state);
    expect(() => managedToolDigest(state, 1024 * 1024)).toThrow('size limit');
  });

  it('copies valid bindings and preserves empty snapshots and explicit failed backups', () => {
    const input = {
      ...binding,
      snapshots: [
        snapshot,
        { promptId: 'next', timestamp, trackedFileBackups: {} },
        {
          promptId: 'failed',
          timestamp,
          trackedFileBackups: {
            [path.resolve('outside.txt')]: {
              ...backup,
              backupFileName: null,
              failed: true,
            },
          },
        },
      ],
    };
    const parsed = parseManagedToolFileHistoryBinding(input);
    expect(parsed).toEqual(input);
    expect(parsed.snapshots).not.toBe(input.snapshots);
    expect(parsed.snapshots[0].trackedFileBackups['proof.txt']).not.toBe(
      backup,
    );
    expect(() => managedToolDigest(parsed)).not.toThrow();
    expect(
      parseManagedToolFileHistoryState({
        ownerSessionId,
        revision: 0,
        snapshots: [],
      }),
    ).toEqual({ ownerSessionId, revision: 0, snapshots: [] });
  });

  it.each([
    { ...binding, extra: true },
    { ...binding, ownerSessionId: ownerSessionId.toUpperCase() },
    { ...binding, ownerRuntimeSessionId: '../another-owner' },
    { ...binding, executionCwd: 'relative' },
    { ...binding, executionCwd: `${binding.executionCwd}${path.sep}..` },
    { ...binding, snapshots: undefined },
    { ...binding, snapshots: [snapshot, snapshot] },
    { ...binding, snapshots: [{ ...snapshot, extra: true }] },
    { ...binding, snapshots: [{ ...snapshot, timestamp: 'invalid' }] },
    { ...binding, snapshots: [{ ...snapshot, trackedFileBackups: [] }] },
    {
      ...binding,
      snapshots: [
        { ...snapshot, trackedFileBackups: { '../outside': backup } },
      ],
    },
  ])('rejects malformed bindings before filesystem use', (input) => {
    expect(() => parseManagedToolFileHistoryBinding(input)).toThrow();
  });

  it.each([
    { ...backup, extra: true },
    { ...backup, backupFileName: '../other-session/backup' },
    { ...backup, backupFileName: '..\\other-session\\backup' },
    { ...backup, backupFileName: '.' },
    { ...backup, version: -1 },
    { ...backup, version: Infinity },
    { ...backup, version: Number.MAX_SAFE_INTEGER + 1 },
    { ...backup, backupTime: '2026-09-09' },
    { ...backup, failed: undefined },
    { ...backup, failed: 1 },
  ])('rejects malformed backup records', (invalidBackup) => {
    expect(() =>
      parseManagedToolFileHistoryBinding({
        ...binding,
        snapshots: [
          { ...snapshot, trackedFileBackups: { 'proof.txt': invalidBackup } },
        ],
      }),
    ).toThrow();
  });

  it.each([-1, 0.1, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects revision %s',
    (revision) => {
      expect(() =>
        parseManagedToolFileHistoryState({
          ownerSessionId,
          revision,
          snapshots: [],
        }),
      ).toThrow();
    },
  );

  it('rejects non-JSON values, excessive snapshots and oversized state', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    for (const input of [
      cycle,
      {
        ...binding,
        snapshots: Array.from({ length: 101 }, (_, i) => ({
          ...snapshot,
          promptId: String(i),
        })),
      },
      { ...binding, executionCwd: 'x'.repeat(1024 * 1024) },
    ])
      expect(() => parseManagedToolFileHistoryBinding(input)).toThrow();
  });

  it.each(['', 'x'.repeat(129), 'nul\0prompt', undefined])(
    'rejects invalid prompt ID',
    (promptId) => {
      expect(() => parseManagedToolFileHistoryPromptId(promptId)).toThrow();
    },
  );
});
