/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildStatusLineInput } from './buildStatusLineInput.js';

const baseParams = {
  sessionId: 'sess-1',
  cwd: '/work',
  projectDir: '/work',
  modelId: 'ultimate',
  modelDisplayName: 'Ultimate',
};

describe('buildStatusLineInput', () => {
  it('emits the basic skeleton without optional fields', () => {
    const input = buildStatusLineInput(baseParams);
    expect(input).toEqual({
      session_id: 'sess-1',
      cwd: '/work',
      model: {
        id: 'ultimate',
        display_name: 'Ultimate',
      },
      workspace: {
        current_dir: '/work',
        project_dir: '/work',
      },
    });
    expect(input.cost).toBeUndefined();
    expect(
      (input as unknown as Record<string, unknown>)['rate_limits'],
    ).toBeUndefined();
  });

  it('includes diff cost stats when provided', () => {
    const input = buildStatusLineInput({
      ...baseParams,
      totalLinesAdded: 1,
      totalLinesRemoved: 2,
    });
    expect(input.cost).toEqual({
      total_lines_added: 1,
      total_lines_removed: 2,
    });
  });

  it('defaults missing diff cost stats to zero', () => {
    const input = buildStatusLineInput({
      ...baseParams,
      totalLinesAdded: 3,
    });
    expect(input.cost).toEqual({
      total_lines_added: 3,
      total_lines_removed: 0,
    });
  });

  it('includes context window stats when provided', () => {
    const input = buildStatusLineInput({
      ...baseParams,
      totalInputTokens: 100,
      totalOutputTokens: 20,
      contextWindowSize: 1000,
      usedPercentage: 10,
      remainingPercentage: 90,
    });
    expect(input.context_window).toEqual({
      total_input_tokens: 100,
      total_output_tokens: 20,
      context_window_size: 1000,
      used_percentage: 10,
      remaining_percentage: 90,
    });
  });

  it('includes the transcript path and permission mode when provided', () => {
    const input = buildStatusLineInput({
      ...baseParams,
      transcriptPath: '/tmp/sessions/sess-1.jsonl',
      permissionMode: 'acceptEdits',
    });
    expect(input.transcript_path).toBe('/tmp/sessions/sess-1.jsonl');
    expect(input.permission_mode).toBe('acceptEdits');
  });

  it('omits the session identity extras that have no value', () => {
    const input = buildStatusLineInput(baseParams);
    expect(input).not.toHaveProperty('transcript_path');
    expect(input).not.toHaveProperty('permission_mode');
    expect(input).not.toHaveProperty('session_name');
    expect(input).not.toHaveProperty('version');
    expect(input).not.toHaveProperty('agent');
    expect(input).not.toHaveProperty('worktree');
    expect(input).not.toHaveProperty('credits');
    expect(input.workspace).not.toHaveProperty('added_dirs');
  });

  it('reports a project_dir distinct from current_dir for worktree sessions', () => {
    const input = buildStatusLineInput({
      ...baseParams,
      cwd: '/work/.worktrees/feature',
      projectDir: '/work',
      worktree: {
        name: 'feature',
        path: '/work/.worktrees/feature',
        branch: 'feature',
        original_cwd: '/work',
        original_branch: 'main',
      },
    });
    expect(input.workspace.current_dir).toBe('/work/.worktrees/feature');
    expect(input.workspace.project_dir).toBe('/work');
    expect(input.worktree?.original_branch).toBe('main');
  });

  it('copies added_dirs so a readonly workspace list is not aliased', () => {
    const dirs: readonly string[] = Object.freeze(['/work', '/other']);
    const input = buildStatusLineInput({ ...baseParams, addedDirs: dirs });
    expect(input.workspace.added_dirs).toEqual(['/work', '/other']);
    expect(input.workspace.added_dirs).not.toBe(dirs);
  });

  it('includes session name, version and agent name when provided', () => {
    const input = buildStatusLineInput({
      ...baseParams,
      sessionName: 'Refactor the parser',
      version: '1.2.3',
      agentName: 'reviewer',
    });
    expect(input.session_name).toBe('Refactor the parser');
    expect(input.version).toBe('1.2.3');
    expect(input.agent).toEqual({ name: 'reviewer' });
  });

  it('ignores extension fields outside the public input contract', () => {
    const input = buildStatusLineInput({
      ...baseParams,
      productValue: { amount: 5 },
    } as Parameters<typeof buildStatusLineInput>[0]);
    expect(input).not.toHaveProperty('productValue');
    expect(input.cost).toBeUndefined();
  });
});
