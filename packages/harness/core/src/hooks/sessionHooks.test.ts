/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerFrontmatterHooks,
  clearFrontmatterHooks,
} from './sessionHooks.js';
import { HookEventName, type HookConfig } from './types.js';
import type { HookSystem } from './hookSystem.js';

vi.mock('../utils/runLogger.js', () => ({
  runLogger: {
    warn: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
  },
}));

import { runLogger } from '../utils/runLogger.js';

interface RegisteredCall {
  agentId: string;
  config: HookConfig;
  eventName: HookEventName;
  options?: { matcher?: string };
}

function createMockHookSystem(): {
  hookSystem: HookSystem;
  calls: RegisteredCall[];
  clearSessionHooks: ReturnType<typeof vi.fn>;
} {
  const calls: RegisteredCall[] = [];
  const clearSessionHooks = vi.fn();
  const hookSystem = {
    registerSessionHook: (
      agentId: string,
      config: HookConfig,
      eventName: HookEventName,
      options?: { matcher?: string },
    ) => {
      calls.push({ agentId, config, eventName, options });
    },
    clearSessionHooks,
  } as unknown as HookSystem;
  return { hookSystem, calls, clearSessionHooks };
}

const commandHook = (extra?: Record<string, unknown>): HookConfig =>
  ({ type: 'command', command: 'echo hi', ...extra }) as HookConfig;

const hooksRecord = (
  eventName: string,
  hook: HookConfig,
  matcher?: string,
): Record<string, unknown> => ({
  [eventName]: [{ ...(matcher !== undefined ? { matcher } : {}), hooks: [hook] }],
});

describe('registerFrontmatterHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts every event in the global HookEventName enum', () => {
    const { hookSystem, calls } = createMockHookSystem();
    const allEvents = Object.values(HookEventName);
    const hooks: Record<string, unknown> = {};
    for (const event of allEvents) {
      Object.assign(hooks, hooksRecord(event, commandHook()));
    }

    registerFrontmatterHooks(hookSystem, 'skill:test', hooks, false, true);

    expect(calls).toHaveLength(allEvents.length);
    expect(runLogger.warn).not.toHaveBeenCalled();
  });

  it('registers skill hooks for events outside the old agent subset (e.g. UserPromptSubmit)', () => {
    const { hookSystem, calls } = createMockHookSystem();

    registerFrontmatterHooks(
      hookSystem,
      'skill:test',
      hooksRecord('UserPromptSubmit', commandHook(), 'foo'),
      false,
      true,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].eventName).toBe(HookEventName.UserPromptSubmit);
    expect(calls[0].options?.matcher).toBe('foo');
  });

  it('warns and skips unknown event names', () => {
    const { hookSystem, calls } = createMockHookSystem();

    registerFrontmatterHooks(
      hookSystem,
      'skill:test',
      hooksRecord('NotARealEvent', commandHook()),
      false,
      true,
    );

    expect(calls).toHaveLength(0);
    expect(runLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring unknown frontmatter hook event'),
    );
  });

  it('remaps Stop to SubagentStop for agents but not for main-session skills', () => {
    const { hookSystem: agentSystem, calls: agentCalls } =
      createMockHookSystem();
    registerFrontmatterHooks(
      agentSystem,
      'agent-1',
      hooksRecord('Stop', commandHook()),
      true,
    );
    expect(agentCalls[0].eventName).toBe(HookEventName.SubagentStop);

    const { hookSystem: skillSystem, calls: skillCalls } =
      createMockHookSystem();
    registerFrontmatterHooks(
      skillSystem,
      'skill:test',
      hooksRecord('Stop', commandHook()),
      false,
      true,
    );
    expect(skillCalls[0].eventName).toBe(HookEventName.Stop);
  });

  it('strips once for agent frontmatter but keeps it for skill frontmatter', () => {
    const { hookSystem: agentSystem, calls: agentCalls } =
      createMockHookSystem();
    registerFrontmatterHooks(
      agentSystem,
      'agent-1',
      hooksRecord('PreToolUse', commandHook({ once: true })),
      true,
      false,
    );
    expect('once' in agentCalls[0].config).toBe(false);

    const { hookSystem: skillSystem, calls: skillCalls } =
      createMockHookSystem();
    registerFrontmatterHooks(
      skillSystem,
      'skill:test',
      hooksRecord('PreToolUse', commandHook({ once: true })),
      false,
      true,
    );
    expect(
      (skillCalls[0].config as unknown as Record<string, unknown>)['once'],
    ).toBe(true);
  });

  it('skips invalid matcher entries with a warning', () => {
    const { hookSystem, calls } = createMockHookSystem();

    registerFrontmatterHooks(
      hookSystem,
      'skill:test',
      { PreToolUse: ['not-an-object'] },
      false,
      true,
    );

    expect(calls).toHaveLength(0);
    expect(runLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid matcher'),
    );
  });
});

describe('clearFrontmatterHooks', () => {
  it('delegates to hookSystem.clearSessionHooks with the agentId', () => {
    const { hookSystem, clearSessionHooks } = createMockHookSystem();

    clearFrontmatterHooks(hookSystem, 'skill:test');

    expect(clearSessionHooks).toHaveBeenCalledWith('skill:test');
  });
});
