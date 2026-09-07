/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolNames } from '../../tools/tool-names.js';
import {
  buildMeshToolConfig,
  classifyMeshTool,
  createMeshToolInvocationGuard,
  MESH_THREAD_TOOL_NAMES,
  MESH_TOOL_CLASSIFICATION,
} from './capability.js';

describe('mesh capability boundary', () => {
  it('classifies every core and mesh thread tool exactly once', () => {
    expect(new Set(Object.keys(MESH_TOOL_CLASSIFICATION))).toEqual(
      new Set([...Object.values(ToolNames), ...MESH_THREAD_TOOL_NAMES]),
    );
    expect(Object.values(ToolNames).map(classifyMeshTool)).not.toContain(
      'thread',
    );
    expect(MESH_THREAD_TOOL_NAMES.map(classifyMeshTool)).toEqual(
      MESH_THREAD_TOOL_NAMES.map(() => 'thread'),
    );
  });

  it('fails closed for tools outside the classification table', () => {
    expect(classifyMeshTool('mcp__server__read')).toBe('deny');
    expect(classifyMeshTool('__proto__')).toBe('deny');
  });

  it('applies the built-in ceiling and always adds thread tools', () => {
    const full = buildMeshToolConfig();
    const wildcard = buildMeshToolConfig({ tools: ['*'] });
    const narrowed = buildMeshToolConfig({
      tools: [ToolNames.READ_FILE, ToolNames.EDIT, 'mcp__server__read'],
    });

    expect(wildcard).toEqual(full);
    expect(full.tools).not.toContain(ToolNames.SHELL);
    expect(full.tools).not.toContain(ToolNames.MEMORY);
    expect(full.disallowedTools).toEqual(
      expect.arrayContaining([
        ToolNames.EDIT,
        ToolNames.WRITE_FILE,
        ToolNames.MEMORY,
      ]),
    );
    expect(narrowed.tools).toEqual([
      ToolNames.READ_FILE,
      ...MESH_THREAD_TOOL_NAMES,
    ]);
    expect(narrowed.executionAllowedTools).toEqual(narrowed.tools);
    expect(narrowed.disallowedTools).toEqual(full.disallowedTools);
  });

  it('preserves definition execution and disallow restrictions', () => {
    const narrowed = buildMeshToolConfig({
      tools: ['*'],
      executionAllowedTools: [ToolNames.READ_FILE, ToolNames.SHELL],
      disallowedTools: [ToolNames.READ_FILE, 'thread_post'],
    });

    expect(narrowed.tools).toEqual([...MESH_THREAD_TOOL_NAMES]);
    expect(narrowed.executionAllowedTools).toEqual(narrowed.tools);
    expect(narrowed.disallowedTools).not.toContain('thread_post');
    expect(narrowed.disallowedTools).toContain(ToolNames.READ_FILE);
  });

  it('enforces the boundary at invocation time', async () => {
    const guard = createMeshToolInvocationGuard();
    const base = { callId: 'call-1', signal: new AbortController().signal };
    await expect(
      guard({
        ...base,
        toolName: ToolNames.EDIT,
        args: {},
        cwd: process.cwd(),
      }),
    ).resolves.toEqual(expect.objectContaining({ allowed: false }));
    await expect(
      guard({
        ...base,
        toolName: ToolNames.SHELL,
        args: { command: 'git push' },
        cwd: process.cwd(),
      }),
    ).resolves.toEqual(expect.objectContaining({ allowed: false }));
    await expect(
      guard({
        ...base,
        toolName: ToolNames.SHELL,
        args: { command: 'git status' },
        cwd: process.cwd(),
      }),
    ).resolves.toEqual(expect.objectContaining({ allowed: false }));
  });
});
