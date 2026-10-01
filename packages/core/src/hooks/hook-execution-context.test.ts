/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  MessageBusType,
  type HookProgress,
} from '../confirmation-bus/types.js';
import {
  runOutsideAgentContext,
  runWithAgentContext,
} from '../agents/runtime/agent-context.js';
import { HookSystem } from './hookSystem.js';
import {
  HookEventName,
  HookType,
  PermissionMode,
  type HookInput,
  type HookDefinition,
} from './types.js';
import {
  assertHookExecutionOwner,
  captureHookExecutionOwner,
  getHookExecutionOwner,
  runWithHookExecutionOwner,
} from './hook-execution-context.js';

vi.mock('../telemetry/loggers.js', () => ({ logHookCall: vi.fn() }));

async function runtime() {
  let sessionId = 'session';
  const events: Array<{ label: string; input: HookInput }> = [];
  const progress: HookProgress[] = [];
  const bus = new MessageBus();
  bus.subscribe<HookProgress>(MessageBusType.HOOK_PROGRESS, (event) =>
    progress.push(event),
  );
  const hook = (label: string): HookDefinition[] => [
    {
      hooks: [
        {
          type: HookType.Function,
          id: label,
          errorMessage: 'fixture hook failed',
          callback: async (input) => {
            events.push({ label, input });
            return undefined;
          },
        },
      ],
    },
  ];
  const config = {
    getSessionId: () => sessionId,
    getAllowedHttpHookUrls: () => [],
    getAllowPrivateNetworkHooks: () => false,
    getSystemHooks: () => undefined,
    getUserHooks: () => ({ [HookEventName.PreToolUse]: hook('global') }),
    getProjectHooks: () => undefined,
    getExtensions: () => [],
    getSessionSourceType: () => undefined,
    getSessionSourceId: () => undefined,
    getTranscriptPath: () => '/tmp/transcript',
    getWorkingDir: () => '/tmp',
    getProjectRoot: () => '/tmp',
    getApprovalMode: () => 'default',
    getMessageBus: () => bus,
    getHookSystem: (): HookSystem => system,
    isTrustedFolder: () => true,
  } as unknown as Config;
  const system = new HookSystem(config);
  await system.initialize();
  const register = (agentId: string, isSourceTrusted?: () => boolean) =>
    system.getRegistry().addAgentHooks(
      {
        [HookEventName.PreToolUse]: hook(agentId),
        [HookEventName.SubagentStart]: hook(agentId),
        [HookEventName.SubagentStop]: hook(agentId),
      },
      `registration:${agentId}`,
      { owner: { sessionId, agentId }, isSourceTrusted },
    );
  const fire = () =>
    system.firePreToolUseEvent(
      'read_file',
      {},
      'tool-id',
      PermissionMode.Default,
    );
  return {
    config,
    system,
    register,
    events,
    progress,
    fire,
    setSession: (value: string) => {
      sessionId = value;
    },
  };
}

describe('hook execution ownership through real registry and runners', () => {
  it('keeps concurrent and nested owners separate and restores the parent', async () => {
    const r = await runtime();
    for (const id of ['A', 'B', 'C']) r.register(id);
    const a = captureHookExecutionOwner(r.config, 'A');
    const b = captureHookExecutionOwner(r.config, 'B');
    await Promise.all([
      runWithHookExecutionOwner(a, async () => {
        await Promise.resolve();
        await r.fire();
      }),
      runWithHookExecutionOwner(b, r.fire),
      r.fire(),
    ]);
    expect(
      r.events
        .map(({ label, input }) => `${label}:${input.agent_id ?? 'parent'}`)
        .sort(),
    ).toEqual(['A:A', 'B:B', 'global:A', 'global:B', 'global:parent']);
    r.events.length = 0;
    await runWithHookExecutionOwner(a, async () => {
      await runWithHookExecutionOwner(
        captureHookExecutionOwner(r.config, 'C'),
        r.fire,
      );
      expect(getHookExecutionOwner()).toBe(a);
      await r.fire();
    });
    expect(
      r.events.map(({ label, input }) => `${label}:${input.agent_id}`).sort(),
    ).toEqual(['A:A', 'C:C', 'global:A', 'global:C']);
    expect(getHookExecutionOwner()).toBeUndefined();
    for (const event of r.events) {
      expect(event.input.session_id).toBe('session');
      expect(event.input).not.toHaveProperty('runtimeId');
      expect(event.input).not.toHaveProperty('owner');
    }
  });

  it('uses the lifecycle target even when the parent or another agent emits it', async () => {
    const r = await runtime();
    r.register('A');
    r.register('B');
    await runWithHookExecutionOwner(
      captureHookExecutionOwner(r.config, 'A'),
      async () => {
        await r.system.fireSubagentStartEvent(
          'B',
          'same-type',
          PermissionMode.Default,
        );
        await r.system.fireSubagentStopEvent(
          'B',
          'same-type',
          '/tmp/b',
          'done',
          false,
          PermissionMode.Default,
        );
      },
    );
    expect(r.events.map(({ label, input }) => [label, input.agent_id])).toEqual(
      [
        ['B', 'B'],
        ['B', 'B'],
      ],
    );
    expect(r.progress).toHaveLength(4);
    expect(r.progress.every((event) => event.agentId === 'B')).toBe(true);
  });

  it('rejects foreign runtimes and old sessions without running global or local hooks', async () => {
    const a = await runtime();
    const b = await runtime();
    a.register('A');
    b.register('A');
    const owner = captureHookExecutionOwner(a.config, 'A');
    expect(() =>
      assertHookExecutionOwner(owner, b.system.runtimeId, 'session'),
    ).toThrow(/owner/);
    await expect(runWithHookExecutionOwner(owner, b.fire)).rejects.toThrow(
      /owner/,
    );
    expect(b.events).toEqual([]);
    a.setSession('new-session');
    await expect(runWithHookExecutionOwner(owner, a.fire)).rejects.toThrow(
      /owner/,
    );
    expect(a.events).toEqual([]);
    await a.fire();
    expect(a.events.map(({ label }) => label)).toEqual(['global']);
  });

  it('rechecks source trust and preserves session-only inheritance', async () => {
    const r = await runtime();
    let trusted = true;
    r.register('A', () => trusted);
    const callback = vi.fn(async () => undefined);
    r.system
      .getSessionHooksManager()
      .addFunctionHook(
        'session',
        HookEventName.PreToolUse,
        '*',
        callback,
        'failed',
      );
    r.system.getSessionHooksManager().addFunctionHook(
      'other-session',
      HookEventName.PreToolUse,
      '*',
      async () => {
        throw new Error('wrong session');
      },
      'failed',
    );
    await runWithHookExecutionOwner(
      captureHookExecutionOwner(r.config, 'A'),
      async () => {
        await r.fire();
        trusted = false;
        await r.fire();
        trusted = true;
        await r.fire();
      },
    );
    expect(r.events.filter(({ label }) => label === 'A')).toHaveLength(2);
    expect(r.events.filter(({ label }) => label === 'global')).toHaveLength(3);
    expect(callback).toHaveBeenCalledTimes(3);
    r.system
      .getSessionHooksManager()
      .addFunctionHook(
        'session',
        HookEventName.MessageDisplay,
        '*',
        callback,
        'failed',
      );
    expect(
      r.system.hasHooksForEvent(HookEventName.MessageDisplay, 'session'),
    ).toBe(true);
    await r.system.fireMessageDisplayEvent('message', 'text', true);
    expect(callback).toHaveBeenCalledTimes(4);
  });

  it('clears both hook and agent context for main-session-owned notifications', async () => {
    const r = await runtime();
    r.register('A');
    await runWithAgentContext('A', () =>
      runWithHookExecutionOwner(captureHookExecutionOwner(r.config, 'A'), () =>
        runOutsideAgentContext(r.fire),
      ),
    );
    expect(r.events.map(({ label, input }) => [label, input.agent_id])).toEqual(
      [['global', undefined]],
    );
  });

  it.each([
    undefined,
    { runtimeId: '', sessionId: 'session', agentId: null },
    { runtimeId: 'runtime', sessionId: 'session', agentId: '' },
  ])('rejects invalid ownership %j', (owner) => {
    expect(() => assertHookExecutionOwner(owner, 'runtime', 'session')).toThrow(
      /owner/,
    );
  });
});
