/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, useState, useCallback } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import { ToolActionsProvider, useToolActions } from './ToolActionsContext.js';
import {
  ToolConfirmationOutcome,
  CoreToolCallStatus,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';
import type { QueuedPermissionPrompt } from '../permissions/permissionQueueStore.js';
import { type IndividualToolCallDisplay } from '../types.js';

describe('ToolActionsContext', () => {
  // Prompts keyed by correlationId, recording how each one was settled.
  type RecordingPrompt = QueuedPermissionPrompt & {
    _approvals: Array<{ remember?: unknown; input?: unknown } | undefined>;
    _rejections: number;
    _aborts: number;
  };
  const mockItems = new Map<string, RecordingPrompt>();

  function createMockItem(
    correlationId: string,
    toolName: string,
    _details?: SerializableConfirmationDetails,
  ): RecordingPrompt {
    const prompt: RecordingPrompt = {
      toolUseId: correlationId,
      toolName,
      input: {},
      reason: {
        message: '',
        attribution: { type: 'other', reason: 'no rule' },
      },
      skippable: true,
      _approvals: [],
      _rejections: 0,
      _aborts: 0,
      approve(options) {
        prompt._approvals.push(options);
      },
      reject() {
        prompt._rejections += 1;
      },
      abort() {
        prompt._aborts += 1;
      },
    };
    mockItems.set(correlationId, prompt);
    return prompt;
  }

  const mockToolCalls: IndividualToolCallDisplay[] = [
    {
      callId: 'modern-call',
      correlationId: 'corr-123',
      name: 'test-tool',
      description: 'desc',
      status: CoreToolCallStatus.AwaitingApproval,
      resultDisplay: undefined,
      confirmationDetails: { type: 'info', title: 'title', prompt: 'prompt' },
    },
    {
      callId: 'edit-call',
      correlationId: 'corr-edit',
      name: 'edit-tool',
      description: 'desc',
      status: CoreToolCallStatus.AwaitingApproval,
      resultDisplay: undefined,
      confirmationDetails: {
        type: 'edit',
        title: 'edit',
        fileName: 'f.txt',
        filePath: '/f.txt',
        fileDiff: 'diff',
        originalContent: 'old',
        newContent: 'new',
      },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockItems.clear();
    // Create default mock items for the default tool calls
    createMockItem('corr-123', 'test-tool', {
      type: 'info',
      title: 'title',
      prompt: 'prompt',
    });
    createMockItem('corr-edit', 'edit-tool', {
      type: 'edit',
      title: 'edit',
      fileName: 'f.txt',
      filePath: '/f.txt',
      fileDiff: 'diff',
      originalContent: 'old',
      newContent: 'new',
    });
  });

  const WrapperReactComp = ({ children }: { children: React.ReactNode }) => {
    const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

    const isExpanded = useCallback(
      (callId: string) => expandedTools.has(callId),
      [expandedTools],
    );

    const toggleExpansion = useCallback((callId: string) => {
      setExpandedTools((prev) => {
        const next = new Set(prev);
        if (next.has(callId)) {
          next.delete(callId);
        } else {
          next.add(callId);
        }
        return next;
      });
    }, []);

    const toggleAllExpansion = useCallback((callIds: string[]) => {
      setExpandedTools((prev) => {
        const next = new Set(prev);
        const anyCollapsed = callIds.some((id) => !next.has(id));

        if (anyCollapsed) {
          callIds.forEach((id) => next.add(id));
        } else {
          callIds.forEach((id) => next.delete(id));
        }
        return next;
      });
    }, []);
    return (
      <ToolActionsProvider
        toolCalls={mockToolCalls}
        isExpanded={isExpanded}
        toggleExpansion={toggleExpansion}
        toggleAllExpansion={toggleAllExpansion}
        permissionQueueLookup={(id) => mockItems.get(id)}
      >
        {children}
      </ToolActionsProvider>
    );
  };

  it('resolves QueuedPermissionPrompt for tools with correlationId', async () => {
    const { result } = await renderHook(() => useToolActions(), {
      wrapper: WrapperReactComp,
    });

    await result.current.confirm(
      'modern-call',
      ToolConfirmationOutcome.ProceedOnce,
    );

    const item = mockItems.get('corr-123')!;
    expect(item._approvals).toHaveLength(1);
  });

  it('handles cancel by calling confirm with Cancel outcome', async () => {
    const { result } = await renderHook(() => useToolActions(), {
      wrapper: WrapperReactComp,
    });

    await result.current.cancel('modern-call');

    const item = mockItems.get('corr-123')!;
    expect(item._rejections).toBe(1);
  });

  it('warns when no permissionQueueLookup match and no correlationId', async () => {
    const orphanTool: IndividualToolCallDisplay = {
      callId: 'orphan-call',
      name: 'orphan-tool',
      description: 'desc',
      status: CoreToolCallStatus.AwaitingApproval,
      resultDisplay: undefined,
      confirmationDetails: {
        type: 'exec',
        title: 'exec',
        command: 'ls',
        rootCommand: 'ls',
        rootCommands: ['ls'],
      } as SerializableConfirmationDetails,
    };

    const { result } = await renderHook(() => useToolActions(), {
      wrapper: ({ children }) => (
        <ToolActionsProvider
          toolCalls={[orphanTool]}
          isExpanded={vi.fn().mockReturnValue(false)}
          toggleExpansion={vi.fn()}
          toggleAllExpansion={vi.fn()}
        >
          {children}
        </ToolActionsProvider>
      ),
    });

    // Should not throw — just warn
    await act(async () => {
      await result.current.confirm(
        'orphan-call',
        ToolConfirmationOutcome.ProceedOnce,
      );
    });
  });

  describe('toggleAllExpansion', () => {
    it('expands all when none are expanded', async () => {
      const { result } = await renderHook(() => useToolActions(), {
        wrapper: WrapperReactComp,
      });

      act(() => {
        result.current.toggleAllExpansion(['modern-call', 'edit-call']);
      });

      expect(result.current.isExpanded('modern-call')).toBe(true);
      expect(result.current.isExpanded('edit-call')).toBe(true);
    });

    it('expands all when some are expanded', async () => {
      const { result } = await renderHook(() => useToolActions(), {
        wrapper: WrapperReactComp,
      });

      act(() => {
        result.current.toggleExpansion('modern-call');
      });
      expect(result.current.isExpanded('modern-call')).toBe(true);
      expect(result.current.isExpanded('edit-call')).toBe(false);

      act(() => {
        result.current.toggleAllExpansion(['modern-call', 'edit-call']);
      });

      expect(result.current.isExpanded('modern-call')).toBe(true);
      expect(result.current.isExpanded('edit-call')).toBe(true);
    });

    it('collapses all when all are expanded', async () => {
      const { result } = await renderHook(() => useToolActions(), {
        wrapper: WrapperReactComp,
      });

      act(() => {
        result.current.toggleExpansion('modern-call');
        result.current.toggleExpansion('edit-call');
      });
      expect(result.current.isExpanded('modern-call')).toBe(true);
      expect(result.current.isExpanded('edit-call')).toBe(true);

      act(() => {
        result.current.toggleAllExpansion(['modern-call', 'edit-call']);
      });

      expect(result.current.isExpanded('modern-call')).toBe(false);
      expect(result.current.isExpanded('edit-call')).toBe(false);
    });
  });
});
