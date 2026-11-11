/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';

// Tool descriptions are constructed during import and may include the month.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
});
afterAll(() => vi.useRealTimers());

// Mock node:os BEFORE importing coreTools to ensure it uses the mock
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    platform: () => 'linux',
  };
});

import { CORE_TOOL_SET } from './model-family-sets/core-tool-set.js';
import {
  getShellDeclaration,
  getExitPlanModeDeclaration,
  getActivateSkillDeclaration,
} from './dynamic-declaration-helpers.js';
import {
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  SHELL_TOOL_NAME,
  EDIT_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  SKILL_TOOL_NAME,
} from '../tool-names.js';

describe('coreTools snapshots', () => {
  const mockPlatform = (platform: string) => {
    vi.stubGlobal(
      'process',
      Object.create(process, {
        platform: {
          get: () => platform,
        },
      }),
    );
  };

  beforeEach(() => {
    vi.resetAllMocks();
    // Stub process.platform to 'linux' by default for deterministic snapshots across OSes
    mockPlatform('linux');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const tools = [
    { name: READ_FILE_TOOL_NAME, declaration: CORE_TOOL_SET.Read },
    { name: WRITE_FILE_TOOL_NAME, declaration: CORE_TOOL_SET.Write },
    { name: GREP_TOOL_NAME, declaration: CORE_TOOL_SET.Grep },
    {
      name: 'grep_search_ripgrep',
      declaration: CORE_TOOL_SET.GrepRipgrep,
    },
    { name: GLOB_TOOL_NAME, declaration: CORE_TOOL_SET.Glob },
    {
      name: SHELL_TOOL_NAME,
      // First arg is enableBashPtyTools: snapshot the PTY-enabled variant.
      declaration: getShellDeclaration(true),
    },
    { name: EDIT_TOOL_NAME, declaration: CORE_TOOL_SET.Edit },
    { name: WEB_FETCH_TOOL_NAME, declaration: CORE_TOOL_SET.WebFetch },
    { name: WRITE_TODOS_TOOL_NAME, declaration: CORE_TOOL_SET.TodoWrite },
    { name: ASK_USER_TOOL_NAME, declaration: CORE_TOOL_SET.AskUserQuestion },
    {
      name: ENTER_PLAN_MODE_TOOL_NAME,
      declaration: CORE_TOOL_SET.EnterPlanMode,
    },
    {
      name: EXIT_PLAN_MODE_TOOL_NAME,
      declaration: getExitPlanModeDeclaration(),
    },
    {
      name: SKILL_TOOL_NAME,
      declaration: getActivateSkillDeclaration(),
    },
  ];

  for (const tool of tools) {
    it(`snapshot for tool: ${tool.name}`, () => {
      expect(tool.declaration).toMatchSnapshot();
    });
  }

  it('omits JSON Schema dialect metadata from the Skill tool schema', () => {
    expect(
      getActivateSkillDeclaration().parametersJsonSchema,
    ).not.toHaveProperty('$schema');
  });

  it('exposes only the executable Edit parameters', () => {
    const schema = CORE_TOOL_SET.Edit.parametersJsonSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toEqual([
      'file_path',
      'old_string',
      'new_string',
      'allow_multiple',
    ]);
  });

  it('keeps skill discovery and invocation rules in the Skill tool description', () => {
    const description = getActivateSkillDeclaration().description;

    expect(description).toContain(
      'Available skills appear in system-reminder messages with one-line descriptions',
    );
    expect(description).toContain('call this tool first');
    expect(description).toContain(
      'Only invoke skills from the available listing',
    );
    expect(description).not.toContain('BLOCKING REQUIREMENT');
    expect(description).not.toContain('Directory-scoped skills');
    expect(description).not.toContain('task notification');
  });
});
