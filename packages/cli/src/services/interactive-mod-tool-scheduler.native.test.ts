/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { makeFakeConfig } from '@qwen-code/qwen-code-core/test-utils/config.js';
import { MockTool } from '@qwen-code/qwen-code-core/test-utils/mock-tool.js';
import { ExecTool } from '@qwen-code/qwen-code-core/tools/exec.js';
import { ToolRegistry } from '@qwen-code/qwen-code-core/tools/tool-registry.js';
import {
  Kind,
  ToolConfirmationOutcome,
} from '@qwen-code/qwen-code-core/tools/tools.js';
import type { ModToolCall } from '@qwen-code/qwen-code-core/mods/tool-events.js';
import {
  InteractiveModToolScheduler,
  type InteractiveToolCall,
  type InteractiveCompletedToolCall,
} from './interactive-mod-tool-scheduler.js';
const mocks = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('./interactive-mod-session.js', () => ({
  getInteractiveModSession: mocks.session,
}));
afterEach(() => vi.restoreAllMocks());

describe('interactive Mod adapter with the real native scheduler', () => {
  it.each([false, true])(
    'keeps nested Code Mode approval visible (Mods=%s)',
    async (mods) => {
      const config = makeFakeConfig({
        codeModeOnly: true,
        approvalMode: ApprovalMode.DEFAULT,
        interactive: true,
        chatRecording: false,
        targetDir: '/tmp',
        cwd: '/tmp',
      });
      const registry = new ToolRegistry(config);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      const execute = vi.fn(async () => ({
        llmContent: 'approved',
        returnDisplay: 'approved',
      }));
      registry.registerTool(new ExecTool(config));
      registry.registerTool(
        new MockTool({
          name: 'approval_probe',
          kind: Kind.Other,
          params: { type: 'object' },
          getDefaultPermission: async () => 'ask',
          getConfirmationDetails: async () => ({
            type: 'info',
            title: 'Approve nested tool',
            prompt: 'Continue?',
            onConfirm: async () => {},
          }),
          execute,
        }),
      );
      const middleware: ModToolCall = (input, next, signal) =>
        next(input, signal, async (_input, verdict) => verdict);
      mocks.session.mockReturnValue(
        mods
          ? {
              ready: Promise.resolve(),
              toolCall: () => middleware,
              captureToolSignal: () => new AbortController().signal,
            }
          : undefined,
      );
      const updates: InteractiveToolCall[][] = [];
      const complete = vi.fn(
        async (_calls: InteractiveCompletedToolCall[]) => {},
      );
      const scheduler = new InteractiveModToolScheduler({
        config,
        getPreferredEditor: () => undefined,
        onEditorClose: () => {},
        onToolCallsUpdate: (calls) => updates.push(calls),
        onAllToolCallsComplete: complete,
      });
      const controller = new AbortController();
      const run = scheduler.schedule(
        {
          callId: 'outer',
          prompt_id: 'turn',
          name: 'exec',
          args: { source: 'await tools.approval_probe({})' },
          isClientInitiated: false,
        },
        controller.signal,
      );
      const waiting = () =>
        updates
          .flat()
          .find(
            (call) =>
              call.request.name === 'approval_probe' &&
              call.status === 'awaiting_approval',
          );
      try {
        await vi.waitFor(() => expect(waiting()).toBeDefined(), {
          timeout: 30000,
        });
        expect(execute).not.toHaveBeenCalled();
        expect(
          updates.some(
            (calls) =>
              calls.some(
                (call) =>
                  call.request.callId === 'outer' &&
                  call.status === 'executing',
              ) &&
              calls.some(
                (call) =>
                  call.request.name === 'approval_probe' &&
                  call.status === 'awaiting_approval',
              ),
          ),
        ).toBe(true);
        const approval = waiting();
        if (approval?.status !== 'awaiting_approval')
          throw new Error('missing nested approval');
        await approval.confirmationDetails.onConfirm(
          ToolConfirmationOutcome.ProceedOnce,
        );
        await run;
        await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
        expect(execute).toHaveBeenCalledOnce();
        expect(complete.mock.calls[0][0]).toHaveLength(1);
        expect(complete.mock.calls[0][0][0].request.callId).toBe('outer');
        expect(complete.mock.calls[0][0][0].status).toBe('success');
      } finally {
        controller.abort();
        await run;
      }
    },
    40000,
  );
});
