/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createEmptyLoadedSettings } from '../test-utils/config.js';
import { describe, expect, it } from 'vitest';
import type { CallableTool } from '@google/genai';
import { Config } from '../config/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ToolRegistry } from './tool-registry.js';
import { DiscoveredMCPTool } from '../mcp/tools/mcp-tool.js';
import {
  applyAgentToolConstraints,
  normalizeAgentToolConstraints,
} from './agent-tool-constraints.js';

function registry() {
  const config = new Config({
    loadedSettings: createEmptyLoadedSettings(),
    sessionId: 'constraints',
    targetDir: '/tmp',
    cwd: '/tmp',
    model: 'test',
    debugMode: false,
  });
  const pool = new ToolRegistry(config, true);
  for (const name of ['Bash', 'Read', 'Write', 'Workflow'])
    pool.registerTool(new MockTool({ name }));
  pool.registerTool(
    new DiscoveredMCPTool(
      {} as CallableTool,
      'repo_server',
      'search',
      'Search',
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { exposedName: 'RepoSearch' },
    ),
  );
  return pool;
}
describe('execution-local tool constraints', () => {
  it.each([null, 'Bash', [''], [' Bash'], [1]])(
    'rejects malformed arrays: %j',
    (disallowedTools) => {
      expect(() => normalizeAgentToolConstraints({ disallowedTools })).toThrow(
        'opts.disallowedTools',
      );
    },
  );
  it('deduplicates, sorts and drops empty option arrays', () => {
    expect(
      normalizeAgentToolConstraints({
        disallowedTools: ['Write', 'Bash', 'Write'],
        bashCommandClamp: [],
      }),
    ).toEqual({
      disallowedTools: ['Bash', 'Write'],
      bashCommandClamp: undefined,
    });
  });
  it.each([
    'mcp__*',
    'mcp__*__*',
    'mcp__repo_server',
    'mcp__repo_server__*',
    'mcp__repo_server__search',
    'RepoSearch',
  ])('removes MCP tools by canonical/server/alias name: %s', (deny) => {
    const tools = registry();
    const denies = applyAgentToolConstraints(tools, {
      disallowedTools: [deny],
    });
    expect(tools.getAllKnownToolNames()).not.toContain('RepoSearch');
    expect(tools.getTool('mcp__repo_server__search')).toBeUndefined();
    expect(denies).toContain('RepoSearch');
    expect(denies).toContain('mcp__repo_server__search');
    expect(tools.getTool('Bash')).toBeDefined();
  });
  it.each([
    'bash',
    'MCP__repo_server',
    'mcp__Repo_server',
    'mcp__repo.server',
    'mcp__repo*',
    'mcp__repo_server__sea*',
    'mcp____search',
  ])('refuses case/spelling and malformed wildcard slips: %s', (deny) => {
    expect(() =>
      applyAgentToolConstraints(registry(), { disallowedTools: [deny] }),
    ).toThrow(/Spawn refused/);
  });
  it('keeps syntactically valid unknown denies as no-ops, as on the native path', () => {
    const tools = registry();
    const before = tools.getAllKnownToolNames();
    applyAgentToolConstraints(tools, {
      disallowedTools: ['NoSuchTool', 'mcp__not_connected', 'mcp__*__search'],
    });
    expect(tools.getAllKnownToolNames()).toEqual(before);
  });

  it('disables lazy dispatch when all MCP tools are denied and validates lazy names', () => {
    const tools = registry();
    tools.registerTool(new MockTool({ name: 'mcp_call' }));
    applyAgentToolConstraints(tools, { bashCommandClamp: ['Bash(git:*)'] });
    expect(tools.getTool('mcp_call')).toBeUndefined();
    expect(() =>
      applyAgentToolConstraints(
        registry(),
        { disallowedTools: ['mcp__Lazy_server'] },
        [],
        ['mcp__lazy_server__read'],
      ),
    ).toThrow('check case');
  });
  it('resolves host legacy aliases and tool-content entries before whole-tool removal', () => {
    const tools = registry();
    applyAgentToolConstraints(tools, {
      disallowedTools: ['RunWorkflow', 'Bash(git:*)'],
    });
    expect(tools.getTool('Workflow')).toBeUndefined();
    expect(tools.getTool('Bash')).toBeUndefined();
    expect(tools.getTool('Read')).toBeDefined();
  });
});
