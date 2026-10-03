/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { HookSystem } from './hookSystem.js';
import { HookRegistry } from './hookRegistry.js';
import { HookRunner } from './hookRunner.js';
import type {
  HookEventHandler,
  ManagedHookDispatcher,
} from './hookEventHandler.js';
import {
  HookEventName,
  HookPhase,
  NotificationType,
  PermissionMode,
  PostCompactTrigger,
  PreCompactTrigger,
  SessionEndReason,
  SessionStartSource,
} from './types.js';

afterEach(() => vi.restoreAllMocks());

const calls: Record<
  HookEventName,
  (handler: HookEventHandler) => Promise<unknown>
> = {
  PreToolUse: (h) =>
    h.firePreToolUseEvent('shell', {}, 'call-1', PermissionMode.Default),
  PostToolUse: (h) =>
    h.firePostToolUseEvent('shell', {}, {}, 'call-1', PermissionMode.Default),
  PostToolUseFailure: (h) =>
    h.firePostToolUseFailureEvent('call-1', 'shell', {}, 'failed'),
  PostToolBatch: (h) => h.firePostToolBatchEvent([]),
  Notification: (h) =>
    h.fireNotificationEvent('idle', NotificationType.IdlePrompt),
  UserPromptSubmit: (h) => h.fireUserPromptSubmitEvent('hello'),
  UserPromptExpansion: (h) =>
    h.fireUserPromptExpansionEvent('test', '', 'expanded'),
  SessionStart: (h) =>
    h.fireSessionStartEvent(
      SessionStartSource.Startup,
      'model-1',
      PermissionMode.Default,
    ),
  Stop: (h) => h.fireStopEvent(false, 'answer'),
  MessageDisplay: (h) => h.fireMessageDisplayEvent('message-1', 'answer', true),
  SubagentStart: (h) =>
    h.fireSubagentStartEvent('child-1', 'worker', PermissionMode.Default),
  SubagentStop: (h) =>
    h.fireSubagentStopEvent(
      'child-1',
      'worker',
      '',
      'answer',
      false,
      PermissionMode.Default,
    ),
  PreCompact: (h) => h.firePreCompactEvent(PreCompactTrigger.Auto, ''),
  PostCompact: (h) =>
    h.firePostCompactEvent(PostCompactTrigger.Auto, 'summary'),
  SessionEnd: (h) => h.fireSessionEndEvent(SessionEndReason.Other),
  SessionDelete: (h) => h.fireSessionDeleteEvent('session-1'),
  PermissionRequest: (h) =>
    h.firePermissionRequestEvent('shell', {}, PermissionMode.Default),
  PermissionDenied: (h) =>
    h.firePermissionDeniedEvent('shell', {}, 'call-1', 'classifier_blocked'),
  StopFailure: (h) => h.fireStopFailureEvent('server_error'),
  TodoCreated: (h) =>
    h.fireTodoCreatedEvent(
      'todo-1',
      'work',
      'pending',
      [],
      HookPhase.Validation,
    ),
  TodoCompleted: (h) =>
    h.fireTodoCompletedEvent(
      'todo-1',
      'work',
      'in_progress',
      [],
      HookPhase.PostWrite,
    ),
  InstructionsLoaded: (h) =>
    h.fireInstructionsLoadedEvent(
      '/workspace/AGENTS.md',
      'project',
      'session_start',
    ),
};

function fixture() {
  const config = {
    getSessionId: () => 'session-1',
    getSessionSourceType: () => undefined,
    getSessionSourceId: () => undefined,
    getTranscriptPath: () => '/workspace/session.jsonl',
    getWorkingDir: () => '/workspace',
    getApprovalMode: () => 'default',
    getAllowedHttpHookUrls: () => [],
    getAllowPrivateNetworkHooks: () => false,
  } as unknown as Config;
  const output = {
    success: true,
    allOutputs: [],
    errors: [],
    totalDuration: 1,
    finalOutput: { continue: false, stopReason: 'managed decision' },
  };
  const execute = vi
    .fn<ManagedHookDispatcher['execute']>()
    .mockResolvedValue(output);
  const hasHooksForEvent = vi.fn(() => true);
  const system = new HookSystem(config, { hasHooksForEvent, execute });
  return { system, execute, hasHooksForEvent, output };
}

describe('Managed native Hook dispatch', () => {
  it('preserves the native function messages provider as an immutable dispatch snapshot', async () => {
    const { system, execute } = fixture();
    const messages = [{ role: 'user', parts: [{ text: 'this Session only' }] }];
    system.setMessagesProvider(() => messages);
    await system.fireNotificationEvent('idle', NotificationType.IdlePrompt);
    expect(execute.mock.calls[0][1]).toMatchObject({ messages });
    messages[0].parts[0].text = 'later';
    expect(execute.mock.calls[0][1]).toMatchObject({
      messages: [{ role: 'user', parts: [{ text: 'this Session only' }] }],
    });
  });

  it.each(Object.values(HookEventName))(
    'forwards %s with native inputs and never invokes local runners',
    async (event) => {
      const { system, execute, output } = fixture();
      const parallel = vi.spyOn(HookRunner.prototype, 'executeHooksParallel');
      const sequential = vi.spyOn(
        HookRunner.prototype,
        'executeHooksSequential',
      );
      await expect(calls[event](system.getEventHandler())).resolves.toBe(
        output,
      );
      expect(execute).toHaveBeenCalledWith(
        event,
        expect.objectContaining({
          session_id: 'session-1',
          cwd: '/workspace',
          hook_event_name: event,
        }),
        undefined,
      );
      expect(parallel).not.toHaveBeenCalled();
      expect(sequential).not.toHaveBeenCalled();
    },
  );

  it('never loads ambient catalogs and suppresses unmanaged event producers', async () => {
    const initialize = vi.spyOn(HookRegistry.prototype, 'initialize');
    const reload = vi.spyOn(HookRegistry.prototype, 'reloadConfiguredHooks');
    const { system, execute, hasHooksForEvent } = fixture();
    await system.initialize();
    await system.reload();
    expect(initialize).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    hasHooksForEvent.mockReturnValue(false);
    expect(system.hasHooksForEvent(HookEventName.Stop)).toBe(false);
    await system.fireStopEvent();
    expect(execute).not.toHaveBeenCalled();
  });

  it('propagates authoritative recovery failures instead of converting them into success', async () => {
    const { system, execute } = fixture();
    execute.mockRejectedValue(new Error('Hook recovery required'));
    await expect(system.fireStopEvent()).rejects.toThrow(
      'Hook recovery required',
    );
  });
});
