/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { Config } from '../config/config.js';
import { buildAutoApproveAgentContext } from './agent-context-factory.js';

function makeConfig(): Config {
  return {
    getToolRegistry: () => new ToolRegistry({} as Config),
    getConversationMessages: () => [],
    stripThoughtsFromConversationHistory: vi.fn(),
    permission: {
      getRules: () => ({
        allow: { userSettings: ['Bash(git status)'] },
        deny: { userSettings: ['Bash(git *)'] },
        ask: { userSettings: ['Read(//secrets/**)'] },
      }),
    },
  } as unknown as Config;
}

describe('buildAutoApproveAgentContext', () => {
  it('uses an isolated restricted override instead of parent rules', async () => {
    const context = buildAutoApproveAgentContext(makeConfig(), 'skill-test', [
      'Read',
      'Glob',
    ]);

    const override = context.permissionContext!();
    expect(override).toMatchObject({
      mode: 'default',
      canPrompt: false,
      rules: {
        allow: { session: ['Read', 'Glob'] },
        deny: {},
        ask: {},
      },
    });
  });

  it('keeps unrestricted yolo mode when no allowed tools are provided', async () => {
    const context = buildAutoApproveAgentContext(makeConfig(), 'skill-test');

    const override = context.permissionContext!();
    expect(override).toMatchObject({ mode: 'yolo', canPrompt: false });
  });
});
