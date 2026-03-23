/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getToolDisplayLabel } from './labelUtils.js';

describe('getToolDisplayLabel', () => {
  it('unifies shell tool variants to Shell', () => {
    expect(getToolDisplayLabel({ kind: 'execute' })).toBe('Shell');
    expect(getToolDisplayLabel({ kind: 'bash' })).toBe('Shell');
    expect(getToolDisplayLabel({ kind: 'command' })).toBe('Shell');
  });

  it('uses core names for web fetch and web search', () => {
    expect(getToolDisplayLabel({ kind: 'web_fetch' })).toBe('WebFetch');
    expect(getToolDisplayLabel({ kind: 'web_search' })).toBe('WebSearch');
  });

  it('normalizes todo write labels even when older titles are still present', () => {
    expect(
      getToolDisplayLabel({ kind: 'todo_write', title: 'Updated Plan' }),
    ).toBe('TodoWrite');
    expect(
      getToolDisplayLabel({ kind: 'update_todos', title: 'Update Todos' }),
    ).toBe('TodoWrite');
    expect(
      getToolDisplayLabel({ kind: 'updated_plan', title: 'Updated Plan' }),
    ).toBe('TodoWrite');
  });

  it('uses core names for read-family tools by kind', () => {
    expect(getToolDisplayLabel({ kind: 'read_many_files' })).toBe(
      'ReadManyFiles',
    );
    expect(getToolDisplayLabel({ kind: 'list_directory' })).toBe('ListFiles');
  });

  it('derives read-family tool names from the title when kind is normalized', () => {
    expect(
      getToolDisplayLabel({
        kind: 'read',
        title: 'ReadFile packages/webui/src/index.ts',
      }),
    ).toBe('ReadFile');
    expect(
      getToolDisplayLabel({
        kind: 'read',
        title: 'ReadManyFiles packages/webui/src packages/core/src',
      }),
    ).toBe('ReadManyFiles');
    expect(
      getToolDisplayLabel({
        kind: 'read',
        title: 'ListFiles packages/webui/src/components',
      }),
    ).toBe('ListFiles');
    expect(
      getToolDisplayLabel({
        kind: 'read',
        title: 'Skill open-source-flow',
      }),
    ).toBe('Skill');
  });

  it('capitalizes generic label mappings that still fall through generic rendering', () => {
    expect(getToolDisplayLabel({ kind: 'task' })).toBe('Task');
    expect(getToolDisplayLabel({ kind: 'skill' })).toBe('Skill');
    expect(getToolDisplayLabel({ kind: 'exit_plan_mode' })).toBe(
      'ExitPlanMode',
    );
  });
});
