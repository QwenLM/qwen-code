/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolNames } from '../../tools/tool-names.js';
import { _resetParser, initParser } from '../../utils/shellAstParser.js';
import {
  buildMeshToolConfig,
  checkMeshShellCommand,
  classifyMeshTool,
  MESH_THREAD_TOOL_NAMES,
  MESH_TOOL_CLASSIFICATION,
} from './capability.js';

beforeAll(async () => {
  await initParser();
});

afterAll(() => {
  _resetParser();
});

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
    const wildcard = buildMeshToolConfig(['*']);
    const narrowed = buildMeshToolConfig([
      ToolNames.READ_FILE,
      ToolNames.EDIT,
      'mcp__server__read',
    ]);

    expect(wildcard).toEqual(full);
    expect(full.tools).toContain(ToolNames.SHELL);
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

  it.each(['cat package.json', 'git status', 'grep -r TODO packages/core'])(
    'allows read-only shell command %s',
    async (command) => {
      await expect(
        checkMeshShellCommand(command, process.cwd()),
      ).resolves.toEqual({ allowed: true });
    },
  );

  it.each([
    ['rm -rf temp', 'write'],
    ['echo text > file', 'write'],
    ['git push', 'write'],
    ['unknownbin --x', 'unknown'],
  ])('refuses shell command %s classified as %s', async (command, safety) => {
    const decision = await checkMeshShellCommand(command, process.cwd());
    expect(decision).toEqual({
      allowed: false,
      reason: expect.stringContaining(safety),
    });
  });
});
