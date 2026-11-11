/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { stripUnsafePluginFields } from './pluginAgentPolicy.js';
import type { LocalAgentDefinition } from '../types.js';

function makeLocalAgent(
  overrides: Partial<LocalAgentDefinition> = {},
): LocalAgentDefinition {
  const base: LocalAgentDefinition = {
    kind: 'local',
    name: 'plugin:demo',
    description: 'demo plugin agent',
    promptConfig: { systemPrompt: 'you are a helper' },
    modelConfig: { model: 'inherit' },
  };
  return { ...base, ...overrides };
}

describe('stripUnsafePluginFields', () => {
  it('drops hooks', () => {
    const agent = makeLocalAgent({
      hooks: {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [{ type: 'command', command: 'echo PWNED' }],
          },
        ],
      },
    });

    stripUnsafePluginFields(agent);

    expect(agent.hooks).toBeUndefined();
  });

  it('drops mcpServers', () => {
    const agent = makeLocalAgent({ mcpServers: ['existing-server'] });

    stripUnsafePluginFields(agent);

    expect(agent.mcpServers).toBeUndefined();
  });

  it('drops permissionMode', () => {
    const agent = makeLocalAgent({ permissionMode: 'yolo' });

    stripUnsafePluginFields(agent);

    expect(agent.permissionMode).toBeUndefined();
  });

  it('keeps isolation when value is "worktree"', () => {
    const agent = makeLocalAgent({ isolation: 'worktree' });

    stripUnsafePluginFields(agent);

    expect(agent.isolation).toBe('worktree');
  });

  it('drops isolation for any other value', () => {
    const agent = makeLocalAgent({ isolation: 'process' });

    stripUnsafePluginFields(agent);

    expect(agent.isolation).toBeUndefined();
  });

  it('drops isolation when capitalization differs (strict equality)', () => {
    const agent = makeLocalAgent({ isolation: 'WORKTREE' });

    stripUnsafePluginFields(agent);

    expect(agent.isolation).toBeUndefined();
  });

  it('preserves memory, background, effort, skills', () => {
    const agent = makeLocalAgent({
      memory: 'project',
      background: true,
      effort: 'high',
      skills: ['skill-a'],
    });

    stripUnsafePluginFields(agent);

    expect(agent.memory).toBe('project');
    expect(agent.background).toBe(true);
    expect(agent.effort).toBe('high');
    expect(agent.skills).toEqual(['skill-a']);
  });

  it('does not touch identity, prompt, tool, or denylist fields', () => {
    const agent = makeLocalAgent({
      toolConfig: { tools: ['Read'] },
      disallowedTools: ['Bash'],
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'noop' }] }] },
    });

    stripUnsafePluginFields(agent);

    expect(agent.name).toBe('plugin:demo');
    expect(agent.description).toBe('demo plugin agent');
    expect(agent.promptConfig.systemPrompt).toBe('you are a helper');
    expect(agent.toolConfig).toEqual({ tools: ['Read'] });
    expect(agent.disallowedTools).toEqual(['Bash']);
  });

  it('is idempotent', () => {
    const agent = makeLocalAgent({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'noop' }] }] },
      mcpServers: ['srv'],
      permissionMode: 'plan',
      isolation: 'process',
    });

    stripUnsafePluginFields(agent);
    stripUnsafePluginFields(agent);

    expect(agent.hooks).toBeUndefined();
    expect(agent.mcpServers).toBeUndefined();
    expect(agent.permissionMode).toBeUndefined();
    expect(agent.isolation).toBeUndefined();
  });
});
