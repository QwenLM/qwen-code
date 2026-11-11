/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolRegistry,
  type Config,
  type ToolInvocation,
  type ToolResult,
} from '@qwen-code/core';
import { RootToolRegistry } from './rootToolRegistry.js';

class TestInvocation extends BaseToolInvocation<
  Record<string, never>,
  ToolResult
> {
  getDescription(): string {
    return 'test';
  }

  async execute(): Promise<ToolResult> {
    return { llmContent: 'ok', returnDisplay: 'ok' };
  }
}

class TestTool extends BaseDeclarativeTool<
  Record<string, never>,
  ToolResult
> {
  constructor(name: string) {
    super(
      name,
      name,
      `${name} description`,
      Kind.Communicate,
      { type: 'object', additionalProperties: false },
    );
  }

  protected createInvocation(
    params: Record<string, never>,
  ): ToolInvocation<Record<string, never>, ToolResult> {
    return new TestInvocation(params);
  }
}

function createConfig(): Config {
  const config = {
    getExcludeTools: vi.fn(() => undefined),
    getMainAgentTools: vi.fn(() => undefined),
    isTopicUpdateNarrationEnabled: vi.fn(() => true),
    shouldHideInteractiveTools: vi.fn(() => false),
    getPromptRegistry: vi.fn(() => ({})),
    getResourceRegistry: vi.fn(() => ({})),
    toolCallSnapshots: {},
    promptId: 'remote-session',
    getConversationMessages: vi.fn(() => []),
    stripThoughtsFromConversationHistory: vi.fn(),
    isWorkflowsEnabled: vi.fn(() => true),
    getSkillManager: vi.fn(() => ({
      isAdminEnabled: () => true,
      getSkill: (name: string) => name === 'workflow-authoring'
        ? { name, description: 'Workflow guide' }
        : null,
      getSkillVisibilityOverride: () => undefined,
      isSkillAllowedForMainSession: () => true,
    })),
  };
  return config as unknown as Config;
}

describe('RootToolRegistry', () => {
  it('adds host tools without mutating the main registry', () => {
    const config = createConfig();
    const main = new ToolRegistry(config, true);
    main.registerTool(new TestTool('MainTool'));

    const overlay = new RootToolRegistry(config, main, [
      new TestTool('HostTool'),
    ]);

    expect(overlay.getAllToolNames()).toEqual(['MainTool', 'HostTool']);
    expect(overlay.getFunctionDeclarations().map(({ name }) => name)).toEqual([
      'MainTool',
      'HostTool',
    ]);
    expect(main.getTool('HostTool')).toBeUndefined();
  });

  it('delegates late main-registry additions without copying them', () => {
    const config = createConfig();
    const main = new ToolRegistry(config, true);
    const overlay = new RootToolRegistry(config, main, [
      new TestTool('HostTool'),
    ]);

    main.registerTool(new TestTool('LateMcpTool'));

    expect(overlay.getTool('LateMcpTool')).toBeDefined();
    expect(overlay.getFunctionDeclarations().map(({ name }) => name)).toEqual([
      'LateMcpTool',
      'HostTool',
    ]);
  });

  it('preserves the shared Workflow Skill-aware description in the remote overlay', () => {
    const config = createConfig();
    const main = new ToolRegistry(config, true);
    main.registerTool(new TestTool('Workflow'));
    main.registerTool(new TestTool('Skill'));
    const overlay = new RootToolRegistry(config, main, []);

    const description = overlay.getFunctionDeclarations()
      .find(({ name }) => name === 'Workflow')?.description;
    expect(description).toContain(
      'Before writing a script, load the `workflow-authoring` skill',
    );
    expect(description).not.toContain('# Workflow authoring reference');
  });

  it('keeps host tools visible when the SDK narrows the main-agent tool list', () => {
    const config = createConfig();
    vi.mocked(config.getMainAgentTools).mockReturnValue(['MainTool']);
    const main = new ToolRegistry(config, true);
    main.registerTool(new TestTool('MainTool'));
    main.registerTool(new TestTool('OtherMainTool'));

    const overlay = new RootToolRegistry(config, main, [
      new TestTool('HostTool'),
    ]);

    expect(overlay.getFunctionDeclarations().map(({ name }) => name)).toEqual([
      'MainTool',
      'HostTool',
    ]);
  });

  it('still applies the configured deny list to host tools', () => {
    const config = createConfig();
    vi.mocked(config.getExcludeTools).mockReturnValue(new Set(['HostTool']));
    const main = new ToolRegistry(config, true);
    main.registerTool(new TestTool('MainTool'));

    const overlay = new RootToolRegistry(config, main, [
      new TestTool('HostTool'),
    ]);

    expect(overlay.getFunctionDeclarations().map(({ name }) => name)).toEqual([
      'MainTool',
    ]);
    expect(overlay.getTool('HostTool')).toBeUndefined();
  });

  it('resolves a main registry that becomes available after construction', () => {
    const config = createConfig();
    const mainRef: { current?: ToolRegistry } = {};
    const overlay = new RootToolRegistry(config, () => mainRef.current!, [
      new TestTool('HostTool'),
    ]);

    expect(() => overlay.getFunctionDeclarations()).toThrow(
      'Main tool registry is not initialized',
    );

    mainRef.current = new ToolRegistry(config, true);
    mainRef.current.registerTool(new TestTool('MainTool'));

    expect(overlay.getFunctionDeclarations().map(({ name }) => name)).toEqual([
      'MainTool',
      'HostTool',
    ]);
    expect(overlay.getTool('MainTool')).toBeDefined();
  });
});
