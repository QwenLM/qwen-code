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
  it('requires a fresh approval for every next and rejects an earlier attempt callback', async () => {
    const config = makeFakeConfig({
      approvalMode: ApprovalMode.DEFAULT,
      interactive: true,
      chatRecording: false,
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    const execute = vi.fn(async () => ({
      llmContent: 'approved',
      returnDisplay: 'approved',
    }));
    registry.registerTool(
      new MockTool({
        name: 'repeat_approval',
        kind: Kind.Other,
        params: { type: 'object' },
        getDefaultPermission: async () => 'ask',
        getConfirmationDetails: async () => ({
          type: 'info',
          title: 'Approve current attempt',
          prompt: 'Continue?',
          onConfirm: async () => {},
        }),
        execute,
      }),
    );
    const middleware: ModToolCall = async (input, next, signal) => {
      const first = await next(
        input,
        signal,
        async (_input, verdict) => verdict,
      );
      await next(input, signal, async (_input, verdict) => verdict);
      return first;
    };
    const controller = new AbortController();
    mocks.session.mockReturnValue({
      ready: Promise.resolve(),
      toolCall: () => middleware,
      captureToolSignal: () => controller.signal,
    });
    let current: InteractiveToolCall[] = [];
    const complete = vi.fn(
      async (_calls: InteractiveCompletedToolCall[]) => {},
    );
    const scheduler = new InteractiveModToolScheduler({
      config,
      getPreferredEditor: () => undefined,
      onEditorClose: () => {},
      onToolCallsUpdate: (calls) => {
        current = calls;
      },
      onAllToolCallsComplete: complete,
    });
    const run = scheduler.schedule(
      {
        callId: 'same-model-id',
        prompt_id: 'turn',
        name: 'repeat_approval',
        args: {},
        isClientInitiated: false,
      },
      controller.signal,
    );
    const waiting = () =>
      current.find((call) => call.status === 'awaiting_approval');
    try {
      await vi.waitFor(() => expect(waiting()).toBeDefined());
      const first = waiting();
      if (first?.status !== 'awaiting_approval')
        throw new Error('missing first approval');
      expect(execute).not.toHaveBeenCalled();
      await first.confirmationDetails.onConfirm(
        ToolConfirmationOutcome.ProceedOnce,
      );
      await vi.waitFor(() => expect(waiting()).toBeDefined());
      const second = waiting();
      if (second?.status !== 'awaiting_approval')
        throw new Error('missing second approval');
      expect(second.confirmationDetails).not.toBe(first.confirmationDetails);
      expect(execute).toHaveBeenCalledOnce();
      await first.confirmationDetails.onConfirm(
        ToolConfirmationOutcome.ProceedAlwaysProject,
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(waiting()).toBe(second);
      await second.confirmationDetails.onConfirm(
        ToolConfirmationOutcome.ProceedOnce,
      );
      await run;
      expect(execute).toHaveBeenCalledTimes(2);
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      await run;
    }
  });

  it.each([false, true])(
    'rejects each invalid attempt with the documented validation diagnostic scope (Mods=%s)',
    async (mods) => {
      const config = makeFakeConfig({
        approvalMode: ApprovalMode.DEFAULT,
        interactive: true,
        chatRecording: false,
      });
      const registry = new ToolRegistry(config);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      const execute = vi.fn(async () => ({
        llmContent: 'unexpected',
        returnDisplay: 'unexpected',
      }));
      registry.registerTool(
        new MockTool({
          name: 'validation_probe',
          params: {
            type: 'object',
            properties: { required: { type: 'string' } },
            required: ['required'],
          },
          execute,
        }),
      );
      const middleware: ModToolCall = async (input, next, signal) => {
        let result = await next(
          input,
          signal,
          async (_input, verdict) => verdict,
        );
        for (let attempt = 1; attempt < 3; attempt++)
          result = await next(
            input,
            signal,
            async (_input, verdict) => verdict,
          );
        return result;
      };
      const generation = new AbortController();
      mocks.session.mockReturnValue(
        mods
          ? {
              ready: Promise.resolve(),
              toolCall: () => middleware,
              captureToolSignal: () => generation.signal,
            }
          : undefined,
      );
      const native: InteractiveCompletedToolCall[] = [];
      const complete = vi.fn(
        async (_calls: InteractiveCompletedToolCall[]) => {},
      );
      const scheduler = new InteractiveModToolScheduler({
        config,
        getPreferredEditor: () => undefined,
        onEditorClose: () => {},
        onAllToolCallsComplete: complete,
        onNativeAttempt: async (call) => {
          native.push(call);
        },
      });
      const request = {
        callId: 'invalid',
        name: 'validation_probe',
        args: {},
        isClientInitiated: false,
        prompt_id: 'validation-turn',
      };
      if (mods) await scheduler.schedule(request, generation.signal);
      else
        for (let attempt = 0; attempt < 3; attempt++) {
          await scheduler.schedule(
            { ...request, callId: `invalid-${attempt}` },
            generation.signal,
          );
          await vi.waitFor(() =>
            expect(complete).toHaveBeenCalledTimes(attempt + 1),
          );
        }
      expect(execute).not.toHaveBeenCalled();
      const observed = mods
        ? native
        : complete.mock.calls.map(([calls]) => calls[0]);
      expect(observed).toHaveLength(3);
      expect(
        observed.every(
          (call) =>
            call.status === 'error' &&
            call.response.executionStatus === 'not_started',
        ),
      ).toBe(true);
      expect(
        observed[2].response.error?.message.includes('RETRY LOOP DETECTED'),
      ).toBe(!mods);
    },
  );

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
