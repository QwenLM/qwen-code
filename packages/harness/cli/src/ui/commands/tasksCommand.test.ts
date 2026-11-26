/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { tasksCommand, workflowsCommand } from './tasksCommand.js';
import type { CommandContext } from './types.js';

describe('tasksCommand', () => {
  it('should return a custom_dialog action', async () => {
    const removeComponent = () => {};
    const context = {
      ui: {
        removeComponent,
      },
    } as unknown as CommandContext;

    if (tasksCommand.action) {
      const result = await tasksCommand.action(context, '');
      expect(result).toMatchObject({ type: 'custom_dialog' });
    }
  });

  it('should have correct name and altNames', () => {
    expect(tasksCommand.name).toBe('tasks');
    expect(tasksCommand.altNames).toContain('bg');
    expect(tasksCommand.altNames).toContain('background');
  });

  it('should auto-execute', () => {
    expect(tasksCommand.autoExecute).toBe(true);
  });

  it('should be safe concurrent', () => {
    expect(tasksCommand.isSafeConcurrent).toBe(true);
  });
});

describe('workflowsCommand', () => {
  it('should open the shared workflow task panel', async () => {
    const viewWorkflowSessions = vi.fn();
    const context = {
      ui: {
        viewWorkflowSessions,
      },
    } as unknown as CommandContext;

    if (workflowsCommand.action) {
      const result = await workflowsCommand.action(context, '');
      expect(result).toBeUndefined();
      expect(viewWorkflowSessions).toHaveBeenCalledTimes(1);
    }
  });

  it('should have workflow aliases', () => {
    expect(workflowsCommand.name).toBe('workflows');
    expect(workflowsCommand.altNames).toContain('workflow-tasks');
  });
});
