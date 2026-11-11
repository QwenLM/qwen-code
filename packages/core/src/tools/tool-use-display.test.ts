/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EDIT_DISPLAY_NAME,
  GLOB_DISPLAY_NAME,
  GREP_DISPLAY_NAME,
  READ_FILE_DISPLAY_NAME,
  SHELL_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  WRITE_FILE_DISPLAY_NAME,
} from './tool-names.js';
import { getToolUseDisplayMetadata } from './tool-use-display.js';

describe('getToolUseDisplayMetadata', () => {
  it.each([
    ['CodeMode', { code: 'await tools.Read({file_path:"a.ts"});' }, 'Execute script'],
    ['CodeModeWait', { cell_id: 'internal-cell-id' }, 'Wait for script'],
    ['CodeModeWait', { cell_id: 'internal-cell-id', cancel: true }, 'Cancel script'],
  ])('summarizes %s without exposing raw input', (tool, input, description) => {
    expect(getToolUseDisplayMetadata(tool, input)).toEqual({
      displayName: 'CodeMode',
      description,
    });
  });

  it('maps TaskStop to an action-oriented task identifier', () => {
    expect(
      getToolUseDisplayMetadata(TASK_STOP_TOOL_NAME, {
        task_id: 'lin',
      }),
    ).toEqual({
      displayName: TASK_STOP_TOOL_NAME,
      description: 'Stopping task lin',
    });
  });

  it.each([
    ['missing', {}],
    ['empty', { task_id: '' }],
    ['non-string', { task_id: { value: 'lin' } }],
  ])(
    'does not expose raw TaskStop input when task_id is %s',
    (_label, input) => {
      expect(getToolUseDisplayMetadata(TASK_STOP_TOOL_NAME, input)).toEqual({
        displayName: TASK_STOP_TOOL_NAME,
        description: 'Stopping task',
      });
    },
  );

  it('does not expose SendMessage payloads in tool display metadata', () => {
    expect(
      getToolUseDisplayMetadata(SEND_MESSAGE_TOOL_NAME, {
        to: 'reviewer',
        summary: 'Review complete',
        message: 'The review is complete.',
      }),
    ).toEqual({
      displayName: SEND_MESSAGE_TOOL_NAME,
      description: '',
    });
  });

  it('maps compact file and search tools to their display metadata', () => {
    expect(
      getToolUseDisplayMetadata('Write', {
        file_path: 'src/app.ts',
        content: 'export const answer = 42;\n',
      }),
    ).toEqual({
      displayName: WRITE_FILE_DISPLAY_NAME,
      description: 'src/app.ts',
    });

    expect(
      getToolUseDisplayMetadata('Glob', {
        pattern: '**/*.ts',
        path: 'src',
      }),
    ).toEqual({
      displayName: GLOB_DISPLAY_NAME,
      description: "'**/*.ts' within src",
    });

    expect(
      getToolUseDisplayMetadata('Grep', {
        pattern: 'answer',
        path: 'src',
        glob: '*.ts',
      }),
    ).toEqual({
      displayName: GREP_DISPLAY_NAME,
      description: "'answer' in *.ts within src",
    });
  });

  it('renders file paths relative to the target directory when provided', () => {
    expect(
      getToolUseDisplayMetadata(
        'Read',
        {
          file_path: '/repo/src/app.ts',
          offset: 4,
          limit: 2,
        },
        { targetDir: '/repo' },
      ),
    ).toEqual({
      displayName: READ_FILE_DISPLAY_NAME,
      description: 'src/app.ts · lines 4-5',
    });

    expect(
      getToolUseDisplayMetadata(
        'Grep',
        {
          pattern: 'answer',
          path: '/repo/src',
        },
        { targetDir: '/repo' },
      ),
    ).toEqual({
      displayName: GREP_DISPLAY_NAME,
      description: "'answer' within src",
    });
  });

  it('falls back to raw tool name and args for unknown tools', () => {
    expect(getToolUseDisplayMetadata('custom_tool', { foo: 'bar' })).toEqual({
      displayName: 'custom_tool',
      description: '{"foo":"bar"}',
    });

    expect(getToolUseDisplayMetadata('custom_tool', {})).toEqual({
      displayName: 'custom_tool',
      description: '',
    });
  });

  it('projects shell input without using invocation display fields', () => {
    expect(
      getToolUseDisplayMetadata(SHELL_TOOL_NAME, {
        command: 'npm test',
        description: 'Run tests',
      }),
    ).toEqual({
      displayName: SHELL_TOOL_NAME,
      description: 'Run tests',
      displayTitle: 'npm test',
    });
  });

  it('restores the background marker from persisted legacy shell input', () => {
    expect(
      getToolUseDisplayMetadata(SHELL_TOOL_NAME, {
        command: 'npm test',
        description: 'Run tests',
        is_background: true,
      }),
    ).toEqual({
      displayName: SHELL_TOOL_NAME,
      description: 'Run tests [background]',
      displayTitle: 'npm test',
    });
  });

  it('prefers the current shell background parameter when both names exist', () => {
    expect(
      getToolUseDisplayMetadata(SHELL_TOOL_NAME, {
        command: 'npm test',
        description: 'Run tests',
        run_in_background: false,
        is_background: true,
      }),
    ).toEqual({
      displayName: SHELL_TOOL_NAME,
      description: 'Run tests',
      displayTitle: 'npm test',
    });
  });

  it('projects workflow input as dynamic workflow metadata', () => {
    expect(
      getToolUseDisplayMetadata(WORKFLOW_TOOL_NAME, {
        name: 'audit',
      }),
    ).toEqual({
      displayName: WORKFLOW_TOOL_NAME,
      description: 'dynamic workflow: audit',
    });

    expect(
      getToolUseDisplayMetadata(
        WORKFLOW_TOOL_NAME,
        {
          scriptPath: '/repo/.qwen/workflows/audit.js',
        },
        { targetDir: '/repo' },
      ),
    ).toEqual({
      displayName: WORKFLOW_TOOL_NAME,
      description: 'dynamic workflow script: .qwen/workflows/audit.js',
    });

    expect(
      getToolUseDisplayMetadata(
        WORKFLOW_TOOL_NAME,
        {
          scriptPath: '/repo/.qwen/workflows/path-winner.js',
          script: 'return "inline loser";',
          name: 'named-loser',
        },
        { targetDir: '/repo' },
      ),
    ).toEqual({
      displayName: WORKFLOW_TOOL_NAME,
      description:
        'dynamic workflow script: .qwen/workflows/path-winner.js',
    });

    expect(
      getToolUseDisplayMetadata(WORKFLOW_TOOL_NAME, {
        script: 'return "inline winner";',
        name: 'named-loser',
      }),
    ).toEqual({
      displayName: WORKFLOW_TOOL_NAME,
      description: 'inline dynamic workflow',
    });
  });

  it('projects MCP tool names and command titles from tool input', () => {
    expect(
      getToolUseDisplayMetadata('mcp__jetbrains__execute_terminal_command', {
        command: 'pwd',
      }),
    ).toEqual({
      displayName: 'execute_terminal_command (jetbrains MCP Server)',
      description: '{"command":"pwd"}',
      displayTitle: 'pwd',
    });
  });

  it('shows file path as description for edit operations', () => {
    expect(
      getToolUseDisplayMetadata('Edit', {
        file_path: 'src/new.ts',
        old_string: '',
        new_string: 'export const created = true;\n',
      }),
    ).toEqual({
      displayName: EDIT_DISPLAY_NAME,
      description: 'src/new.ts',
    });

    expect(
      getToolUseDisplayMetadata('Edit', {
        file_path: 'src/old.ts',
        old_string: 'remove me',
        new_string: '',
      }),
    ).toEqual({
      displayName: EDIT_DISPLAY_NAME,
      description: 'src/old.ts',
    });
  });

  it('maps TodoWrite to a compact parameter summary', () => {
    expect(
      getToolUseDisplayMetadata(WRITE_TODOS_TOOL_NAME, {
        todos: [],
      }),
    ).toEqual({
      displayName: WRITE_TODOS_TOOL_NAME,
      description: 'Cleared todo list',
    });

    expect(
      getToolUseDisplayMetadata(WRITE_TODOS_TOOL_NAME, {
        todos: [
          {
            description:
              'A very long task description that should not appear in the tool header',
            status: 'pending',
          },
          { description: 'Second task', status: 'in_progress' },
        ],
      }),
    ).toEqual({
      displayName: WRITE_TODOS_TOOL_NAME,
      description: 'Set 2 todo(s)',
    });

    expect(
      getToolUseDisplayMetadata(WRITE_TODOS_TOOL_NAME, {
        todos: 'not-an-array',
      }),
    ).toEqual({
      displayName: WRITE_TODOS_TOOL_NAME,
      description: 'Update todo list',
    });
  });
});

describe('getToolUseDisplayMetadata - workspace path display', () => {
  const mockHomeDir =
    process.platform === 'win32' ? 'C:\\Users\\testuser' : '/Users/testuser';

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, eslint-js/no-restricted-syntax
    vi.spyOn(require('node:os'), 'homedir').mockReturnValue(mockHomeDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('displays external home path with tilde for Write tool', () => {
    const targetDir = `${mockHomeDir}/project`;
    const result = getToolUseDisplayMetadata(
      'Write',
      { file_path: `${mockHomeDir}/Desktop/notes.md`, content: 'hello' },
      { targetDir },
    );
    expect(result.description).toBe('~/Desktop/notes.md');
  });

  it('displays external non-home path as absolute for Write tool', () => {
    const targetDir = `${mockHomeDir}/project`;
    const result = getToolUseDisplayMetadata(
      'Write',
      { file_path: '/tmp/output.txt', content: 'data' },
      { targetDir },
    );
    expect(result.description).toBe('/tmp/output.txt');
  });

  it('still displays internal path as relative for Write tool', () => {
    const targetDir = `${mockHomeDir}/project`;
    const result = getToolUseDisplayMetadata(
      'Write',
      { file_path: `${mockHomeDir}/project/src/app.ts`, content: 'code' },
      { targetDir },
    );
    expect(result.description).toBe('src/app.ts');
  });

  it('displays external home path with tilde for Edit tool', () => {
    const targetDir = `${mockHomeDir}/project`;
    const result = getToolUseDisplayMetadata(
      'Edit',
      {
        file_path: `${mockHomeDir}/other-project/config.json`,
        old_string: 'a',
        new_string: 'b',
      },
      { targetDir },
    );
    expect(result.description).toContain('~/other-project/config.json');
  });
});
