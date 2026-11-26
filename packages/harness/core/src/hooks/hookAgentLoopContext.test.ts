/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { TestPermissionManager } from '../test-utils/config.js';
import { createHookAgentLoopContext } from './hookAgentLoopContext.js';

function makePermission(): TestPermissionManager {
  return {
    getPermissionMode: () => 'default',
    getRules: () => ({ allow: { session: ['Bash'] }, deny: {}, ask: {} }),
  } as unknown as TestPermissionManager;
}

function makeConfig(permission?: TestPermissionManager): Config {
  return {
    getToolRegistry: vi.fn().mockReturnValue({}),
    getPromptRegistry: vi.fn().mockReturnValue({}),
    getResourceRegistry: vi.fn().mockReturnValue({}),
    getConversationMessages: vi.fn().mockReturnValue([]),
    stripThoughtsFromConversationHistory: vi.fn(),
    toolCallSnapshots: {},
    permission,
  } as unknown as Config;
}

describe('createHookAgentLoopContext', () => {
  it('shares the session permission object rather than copying its rules', () => {
    // Inheritance is by identity now: the hook agent sees a rule written
    // mid-session because it is looking at the same object, not a snapshot.
    const permission = makePermission();

    const context = createHookAgentLoopContext(
      makeConfig(permission),
      'hook-prompt-1',
    );

    expect(context.permission).toBe(permission);
  });

  it('pins the hook agent to DontAsk', () => {
    const context = createHookAgentLoopContext(
      makeConfig(makePermission()),
      'hook-prompt-1',
    );

    expect(context.permissionContext!()).toMatchObject({
      mode: 'dontAsk',
      canPrompt: false,
    });
  });

  it('refuses any ask, since a hook agent has nobody to ask', async () => {
    const context = createHookAgentLoopContext(
      makeConfig(makePermission()),
      'hook-prompt-1',
    );

    const override = context.permissionContext!();
    // DontAsk already denies anything that would have asked; nobody can be
    // prompted for the rest.
    expect(override?.canPrompt).toBe(false);
  });

  it('carries no permission object when the session has none', () => {
    const context = createHookAgentLoopContext(makeConfig(), 'hook-prompt-1');

    expect(context.permission).toBeUndefined();
  });
});
