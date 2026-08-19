/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildPermissionSuggestions } from './permission-suggestions.js';

describe('buildPermissionSuggestions', () => {
  it('prepends the hook ask reason on exec and edit suggestions', () => {
    // A PreToolUse hook escalated these calls (#9434): the stream-json
    // can_use_tool suggestions must carry the reason so a hook-forced
    // prompt is distinguishable from an ordinary one off-TUI.
    const exec = buildPermissionSuggestions({
      type: 'exec',
      title: 'Confirm shell',
      command: 'git status',
      rootCommand: 'git',
      hookAskReason: 'path requires human review',
      onConfirm: async () => undefined,
    });
    expect(exec?.[0]?.description).toBe(
      'Hook requested confirmation: path requires human review\nExecute: git status',
    );

    const edit = buildPermissionSuggestions({
      type: 'edit',
      title: 'Confirm edit',
      fileName: 'a.txt',
      filePath: '/tmp/a.txt',
      fileDiff: 'diff',
      originalContent: 'a',
      newContent: 'b',
      hookAskReason: 'path requires human review',
      onConfirm: async () => undefined,
    });
    expect(edit?.[0]?.description).toBe(
      'Hook requested confirmation: path requires human review\nEdit file: a.txt',
    );
  });

  it('keeps warnings below the hook reason and above the description', () => {
    const exec = buildPermissionSuggestions({
      type: 'exec',
      title: 'Confirm shell',
      command: 'curl $(evil)',
      rootCommand: 'curl',
      warnings: ['Contains command substitution'],
      hookAskReason: 'network egress',
      onConfirm: async () => undefined,
    });
    expect(exec?.[0]?.description).toBe(
      'Hook requested confirmation: network egress\nContains command substitution\nExecute: curl $(evil)',
    );
  });

  it('leaves ordinary suggestions unchanged without a hook reason', () => {
    const exec = buildPermissionSuggestions({
      type: 'exec',
      title: 'Confirm shell',
      command: 'git status',
      rootCommand: 'git',
      onConfirm: async () => undefined,
    });
    expect(exec?.[0]?.description).toBe('Execute: git status');
  });
});
