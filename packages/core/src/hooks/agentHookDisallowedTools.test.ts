/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { AGENT_HOOK_DISALLOWED_TOOLS } from './agentHookDisallowedTools.js';
import { ToolNames } from '../tools/tool-names.js';

describe('agentHookDisallowedTools', () => {
  it('should be a non-empty readonly array', () => {
    expect(Array.isArray(AGENT_HOOK_DISALLOWED_TOOLS)).toBe(true);
    expect(AGENT_HOOK_DISALLOWED_TOOLS.length).toBeGreaterThan(0);
  });

  it('should disallow the AGENT tool to prevent recursion', () => {
    expect(AGENT_HOOK_DISALLOWED_TOOLS).toContain(ToolNames.AGENT);
  });

  it('should disallow interactive user prompts', () => {
    expect(AGENT_HOOK_DISALLOWED_TOOLS).toContain(ToolNames.ASK_USER_QUESTION);
  });

  it('should disallow plan mode toggling', () => {
    expect(AGENT_HOOK_DISALLOWED_TOOLS).toContain(ToolNames.EXIT_PLAN_MODE);
  });

  it('should disallow task stop', () => {
    expect(AGENT_HOOK_DISALLOWED_TOOLS).toContain(ToolNames.TASK_STOP);
  });

  it('should disallow send message', () => {
    expect(AGENT_HOOK_DISALLOWED_TOOLS).toContain(ToolNames.SEND_MESSAGE);
  });

  it('should disallow cron operations', () => {
    expect(AGENT_HOOK_DISALLOWED_TOOLS).toContain(ToolNames.CRON_CREATE);
    expect(AGENT_HOOK_DISALLOWED_TOOLS).toContain(ToolNames.CRON_LIST);
    expect(AGENT_HOOK_DISALLOWED_TOOLS).toContain(ToolNames.CRON_DELETE);
  });

  it('should disallow todo writes', () => {
    expect(AGENT_HOOK_DISALLOWED_TOOLS).toContain(ToolNames.TODO_WRITE);
  });

  it('should contain only string entries', () => {
    for (const tool of AGENT_HOOK_DISALLOWED_TOOLS) {
      expect(typeof tool).toBe('string');
    }
  });
});
