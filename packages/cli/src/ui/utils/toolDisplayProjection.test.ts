/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  BASH_OUTPUT_TOOL_NAME,
  buildToolStatusResult,
  CoreToolCallStatus,
  EDIT_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  IMAGE_SEARCH_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  REJECT_MESSAGE,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '@qwen-code/core';
import { projectToolCallDisplay } from './toolDisplayProjection.js';

describe('projectToolCallDisplay', () => {
  it('restores accepted legacy Bash exits as notices and preserves receipt counts and display state', () => {
    const display = projectToolCallDisplay({
      toolUse: { id: 'poll', name: 'CodeMode', input: {} },
      toolResult: {
        isError: false,
        toolUseResult: {
          type: 'code_mode',
          totalCalls: 5,
          callsMode: 'delta',
          calls: [
            {
              callId: 'bash',
              name: 'Bash',
              status: 'error',
              kind: 'business',
              error: 'Bash exited with code 1',
            },
            {
              callId: 'read',
              name: 'Read',
              status: 'pending',
              displayStatus: CoreToolCallStatus.AwaitingApproval,
            },
          ],
        },
      },
    });
    expect(display.resultDisplay).toMatchObject({
      totalCalls: 5,
      children: [
        {
          status: CoreToolCallStatus.Success,
          notice: 'Bash exited with code 1',
        },
        { status: CoreToolCallStatus.AwaitingApproval },
      ],
    });
    expect(JSON.stringify(display.resultDisplay)).not.toContain('"error":');
  });
  it.each([
    [undefined, CoreToolCallStatus.Error],
    [CoreToolCallStatus.Success, CoreToolCallStatus.Error],
    [CoreToolCallStatus.Error, CoreToolCallStatus.Error],
    [CoreToolCallStatus.Cancelled, CoreToolCallStatus.Cancelled],
    [CoreToolCallStatus.Executing, CoreToolCallStatus.Executing],
  ])(
    'projects semantic failures with runtime status %s as %s',
    (status, expected) => {
      const display = projectToolCallDisplay({
        toolUse: { id: 'failed', name: 'CodeMode', input: {} },
        toolResult: { isError: true },
        runtime: { status },
      });
      expect(display.status).toBe(expected);
    },
  );
  it('restores CodeMode output and child summaries without executing the script', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'code',
        name: 'CodeMode',
        input: { code: 'while(true) {}' },
      },
      toolResult: {
        isError: true,
        content: 'model-only text',
        toolUseResult: {
          type: 'code_mode',
          status: 'cancelled',
          output: 'partial output',
          truncated: true,
          error: 'User rejected',
          calls: [
            {
              callId: 'w',
              name: 'Write',
              status: 'cancelled',
              filePath: 'a.txt',
            },
            { callId: 'r', name: 'Read', status: 'completed' },
            { callId: 'e', name: 'Grep', status: 'error', error: 'bad regex' },
          ],
        },
      },
    });
    expect(display.resultDisplay).toEqual({
      isCodeModeDisplay: true,
      status: 'cancelled',
      children: [
        {
          callId: 'w',
          name: 'Write',
          args: { file_path: 'a.txt' },
          status: CoreToolCallStatus.Cancelled,
        },
        {
          callId: 'r',
          name: 'Read',
          args: {},
          status: CoreToolCallStatus.Success,
        },
        {
          callId: 'e',
          name: 'Grep',
          args: {},
          status: CoreToolCallStatus.Error,
          error: 'bad regex',
        },
      ],
      summary: 'User rejected\npartial output\n[Output truncated]',
    });
  });

  it('projects CodeMode parameter previews while preferring them over legacy file paths', () => {
    const display = projectToolCallDisplay({
      toolUse: { id: 'code', name: 'CodeMode', input: {} },
      toolResult: {
        isError: false,
        toolUseResult: {
          type: 'code_mode',
          status: 'completed',
          calls: [
            {
              callId: 'r',
              name: 'Read',
              status: 'completed',
              filePath: 'old.ts',
              args: { file_path: 'actual.ts', offset: 2, limit: 3 },
            },
            {
              callId: 'b',
              name: 'Bash',
              status: 'completed',
              args: { command: 'echo long…' },
              argsTruncated: true,
            },
          ],
        },
      },
    });
    expect(display.resultDisplay).toMatchObject({
      children: [
        { name: 'Read', args: { file_path: 'actual.ts', offset: 2, limit: 3 } },
        { name: 'Bash', args: { command: 'echo long…' }, argsTruncated: true },
      ],
    });
  });

  it.each([undefined, null, 'invalid', []])(
    'falls back to legacy CodeMode paths for invalid args %j',
    (args) => {
      const display = projectToolCallDisplay({
        toolUse: { id: 'code', name: 'CodeMode', input: {} },
        toolResult: {
          isError: false,
          toolUseResult: {
            type: 'code_mode',
            status: 'completed',
            calls: [
              { name: 'Read', status: 'completed', filePath: 'a.ts', args },
            ],
          },
        },
      });
      expect(display.resultDisplay).toMatchObject({
        children: [{ args: { file_path: 'a.ts' } }],
      });
    },
  );

  it('prefers the in-session CodeMode display carrying child results', () => {
    const live = {
      isCodeModeDisplay: true as const,
      children: [
        {
          callId: 'c',
          name: 'Read',
          args: { file_path: 'a.ts' },
          status: CoreToolCallStatus.Success,
          resultDisplay: 'Read 3 lines',
        },
      ],
      summary: 'completed: 1 tool calls\nok',
    };
    const display = projectToolCallDisplay({
      toolUse: { id: 'code', name: 'CodeMode', input: {} },
      toolResult: { isError: false, toolUseResult: live },
    });
    expect(display.resultDisplay).toBe(live);
  });
  it.each([undefined, 0, 100])('preserves live output with totalLines=%s', (totalLines) => {
    const display = projectToolCallDisplay({
      toolUse: { id: 'live-bash', name: SHELL_TOOL_NAME, input: {} },
      runtime: {
        status: CoreToolCallStatus.Executing,
        liveOutput: { isShellLiveOutput: true, output: 'tail', totalBytes: 1024, totalLines },
      },
    });
    expect(display.resultDisplay).toBe('tail');
    expect(display.shellProgress).toEqual({ totalBytes: 1024, totalLines });
  });

  it.each([SHELL_TOOL_NAME, 'mcp__demo__do_thing'])(
    'keeps the generic unknown-execution payload for %s',
    (toolName) => {
      const unknownResult = {
        summary: 'Tool execution status unknown',
        payload:
          'The model response ended in refusal before the tool result could be confirmed.',
      };
      const display = projectToolCallDisplay({
        toolUse: {
          id: 'tool-unknown',
          name: toolName,
          input: {},
        },
        toolResult: {
          isError: true,
          content: 'model-only recovery guidance',
          toolUseResult: unknownResult,
        },
      });

      expect(display.resultDisplay).toEqual(unknownResult);
      expect(display.resultDisplay).not.toBe('model-only recovery guidance');
    },
  );

  it('keeps the status summary for a denied MCP tool call', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-mcp-denied',
        name: 'mcp__demo__do_thing',
        input: {},
      },
      toolResult: {
        isError: true,
        content: REJECT_MESSAGE,
        toolUseResult: buildToolStatusResult('denied', 'User rejected.'),
      },
    });

    expect(display.resultDisplay).toBe('User rejected.');
  });

  it('renders a resumed MCP semantic block array without exposing base64', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-mcp',
        name: 'mcp__demo__render_app',
        input: {},
      },
      toolResult: {
        isError: false,
        toolUseResult: [
          { type: 'text', text: 'app payload' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'SECRET_BASE64',
            },
          },
        ],
      },
    });

    expect(display.resultDisplay).toBe('app payload\n[Image]');
    expect(display.resultDisplay).not.toContain('SECRET_BASE64');
  });

  it('projects TaskStop without exposing raw JSON and preserves errors', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-stop',
        name: TASK_STOP_TOOL_NAME,
        input: { task_id: 'lin' },
      },
      toolResult: {
        isError: true,
        content: 'No task found with ID: lin',
      },
    });

    expect(display.name).toBe(TASK_STOP_TOOL_NAME);
    expect(display.description).toBe('Stopping task lin');
    expect(display.description).not.toContain('{');
    expect(display.resultDisplay).toBe('No task found with ID: lin');
  });

  it('projects a concise TaskStop success summary', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-stop-success',
        name: TASK_STOP_TOOL_NAME,
        input: { task_id: 'b-123' },
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          message: 'Successfully stopped task: b-123 (node server.js)',
          task_id: 'b-123',
          task_type: 'local_bash',
          command: 'node server.js',
        },
      },
    });

    expect(display.resultDisplay).toBe('Task stopped successfully');
  });

  it.each([
    ['missing task_id', { task_type: 'local_bash' }],
    ['empty task_id', { task_id: '', task_type: 'local_bash' }],
    ['non-string task_id', { task_id: 123, task_type: 'local_bash' }],
    ['missing task_type', { task_id: 'b-123' }],
    ['empty task_type', { task_id: 'b-123', task_type: '' }],
    ['non-string task_type', { task_id: 'b-123', task_type: 123 }],
  ])('does not report TaskStop success for %s', (_label, toolUseResult) => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-stop-malformed',
        name: TASK_STOP_TOOL_NAME,
        input: { task_id: 'b-123' },
      },
      toolResult: {
        isError: false,
        toolUseResult,
      },
    });

    expect(display.resultDisplay).toBeUndefined();
  });

  it.each([
    [
      {
        stdout: '',
        stderr: '',
        exitCode: 1,
        returnCodeInterpretation: 'No matches found',
        isError: false,
      },
      'No matches found',
    ],
    [
      { stdout: '中文 output', stderr: 'diagnostic', exitCode: 1 },
      '中文 output\ndiagnostic',
    ],
    [{ stdout: '', stderr: 'spawn ENOENT', exitCode: 1 }, 'spawn ENOENT'],
    [{ stdout: '', stderr: '', exitCode: 7 }, 'Command exited with code: 7'],
    [
      { pid: 1234, backgroundTaskId: 'b-stable', stdout: '', stderr: '' },
      'Command is running in background (ID: b-stable). Use /tasks to view.',
    ],
    [
      { pid: 1234, backgroundTaskId: 'b-stable', backgroundedByUser: true },
      'Command was manually moved to background by the user (ID: b-stable). Use /tasks to view.',
    ],
    [
      { pid: 1234, backgroundTaskId: 'b-stable', timedOutAfterMs: 1000 },
      'Command exceeded its timeout and was moved to background (ID: b-stable). Use /tasks to view.',
    ],
  ])(
    'restores PowerShell output and task identity from persisted results: %j',
    (toolUseResult, expected) => {
      const display = projectToolCallDisplay({
        toolUse: {
          id: 'ps-call',
          name: POWERSHELL_TOOL_NAME,
          input: { command: 'Write-Output hello' },
        },
        toolResult: { isError: false, toolUseResult },
      });
      expect(display.resultDisplay).toBe(expected);
    },
  );

  it.each(['model', 'user', 'timeout'])(
    'retains background identity alongside PowerShell output: %s',
    (backgroundReason) => {
      const display = projectToolCallDisplay({
        toolUse: {
          id: 'ps-background',
          name: POWERSHELL_TOOL_NAME,
          input: { command: 'Write-Output hello' },
        },
        toolResult: {
          isError: false,
          toolUseResult: {
            backgroundTaskId: 'b12345678',
            backgroundReason,
            stdout: 'hello',
            stderr: 'diagnostic',
          },
        },
      });
      expect(display.resultDisplay).toContain('b12345678');
      expect(display.resultDisplay).toContain('hello');
      expect(display.resultDisplay).toContain('diagnostic');
    },
  );
  it('projects a stable execution start time without requiring live output', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-1',
        name: SHELL_TOOL_NAME,
        input: { command: 'sleep 30' },
      },
      runtime: {
        status: CoreToolCallStatus.Executing,
        startedAt: 123456,
      },
    });

    expect(display.startedAt).toBe(123456);
    expect(display.resultDisplay).toBeUndefined();
  });

  it.each([
    {
      stdout: 'partial output',
      timeoutMs: 100,
      reason: 'Command timed out after 100ms and was terminated.',
    },
    {
      stdout: '',
      timeoutMs: 1500,
      reason: 'Command timed out after 1.5s and was terminated.',
    },
    {
      stdout: 'partial output',
      timeoutMs: undefined,
      reason: 'Command timed out and was terminated.',
    },
  ])(
    'projects Bash timeout failure with its reason: $reason',
    ({ stdout, timeoutMs, reason }) => {
      const display = projectToolCallDisplay({
        toolUse: {
          id: 'timeout',
          name: SHELL_TOOL_NAME,
          input: { command: 'sleep 30' },
        },
        toolResult: {
          isError: true,
          toolUseResult: {
            kind: 'cancelled',
            stdout,
            stderr: '',
            timedOut: true,
            timeoutMs,
            isError: true,
          },
        },
        runtime: { status: CoreToolCallStatus.Success },
      });
      expect(display.status).toBe(CoreToolCallStatus.Error);
      expect(display.resultDisplay).toBe(
        stdout ? `${reason}\n${stdout}` : reason,
      );
    },
  );

  it('projects the output-cap reason before partial Bash output', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-output-cap',
        name: SHELL_TOOL_NAME,
        input: { command: 'yes' },
      },
      toolResult: {
        isError: true,
        toolUseResult: {
          kind: 'cancelled',
          stdout: 'y\ny\ny',
          stderr: '',
          timedOut: false,
          outputLimitExceeded: true,
        },
      },
    });

    expect(display.resultDisplay).toBe(
      'Command killed: output file exceeded 5GB.\ny\ny\ny',
    );
    expect(display.status).toBe(CoreToolCallStatus.Error);
  });

  it('projects the output-cap reason when Bash produced no output', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-output-cap-empty',
        name: SHELL_TOOL_NAME,
        input: { command: 'noisy-command' },
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          kind: 'cancelled',
          stdout: '',
          stderr: '',
          timedOut: false,
          outputLimitExceeded: true,
        },
      },
    });

    expect(display.resultDisplay).toBe(
      'Command killed: output file exceeded 5GB.',
    );
  });

  it('projects rejected ExitPlanMode feedback from persisted toolUseResult', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-1',
        name: EXIT_PLAN_MODE_TOOL_NAME,
        input: {},
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          plan: '# Plan',
          isAgent: false,
          status: 'rejected',
          filePath: '/tmp/plan.md',
          feedback: 'Add tests',
        },
      },
    });

    expect(display.resultDisplay).toBe('Feedback: Add tests');
  });

  it('projects rejected ExitPlanMode without feedback from persisted toolUseResult', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-1',
        name: EXIT_PLAN_MODE_TOOL_NAME,
        input: {},
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          plan: '# Plan',
          isAgent: false,
          status: 'rejected',
          filePath: '/tmp/plan.md',
        },
      },
    });

    expect(display.resultDisplay).toBe('Rejected (no feedback)');
  });

  it('projects approved ExitPlanMode from persisted toolUseResult', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-1',
        name: EXIT_PLAN_MODE_TOOL_NAME,
        input: {},
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          plan: null,
          isAgent: false,
          status: 'approved',
          filePath: '/tmp/plan.md',
        },
      },
    });

    expect(display.resultDisplay).toBe('Plan approved: /tmp/plan.md');
  });

  it('projects WriteFile file names from Windows-style persisted paths', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-1',
        name: WRITE_FILE_TOOL_NAME,
        input: {},
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          type: 'update',
          filePath: 'C:\\workspace\\src\\file.ts',
          content: 'new',
          structuredPatch: [],
          originalFile: 'old',
        },
      },
    });

    expect(display.resultDisplay).toMatchObject({
      fileName: 'file.ts',
      filePath: 'C:\\workspace\\src\\file.ts',
    });
  });

  it('projects Edit file names from Windows-style persisted paths', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-1',
        name: EDIT_TOOL_NAME,
        input: {},
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          filePath: 'C:\\workspace\\src\\file.ts',
          oldString: 'old',
          newString: 'new',
          originalFile: 'old',
          structuredPatch: [],
          userModified: false,
          replaceAll: false,
        },
      },
    });

    expect(display.resultDisplay).toMatchObject({
      fileName: 'file.ts',
      filePath: 'C:\\workspace\\src\\file.ts',
    });
  });

  it('renders compact persisted file results without full file contents', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-compact-edit',
        name: EDIT_TOOL_NAME,
        input: {},
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          success: true,
          file_path: 'C:\\workspace\\src\\file.ts',
          diff: '@@ -1,1 +1,1 @@\n-old\n+new\n',
          additions: 1,
          deletions: 1,
        },
      },
    });

    expect(display.resultDisplay).toMatchObject({
      fileName: 'file.ts',
      filePath: 'C:\\workspace\\src\\file.ts',
      fileDiff: '@@ -1,1 +1,1 @@\n-old\n+new\n',
      contentOmitted: true,
      diffStat: {
        model_added_lines: 1,
        model_removed_lines: 1,
      },
    });
  });

  it('projects ImageSearch result summaries from persisted toolUseResult', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-1',
        name: IMAGE_SEARCH_TOOL_NAME,
        input: { query: 'sunset beach' },
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          query: 'sunset beach',
          results: [{ imageUrl: 'https://example.com/image.jpg' }],
          durationSeconds: 0.1,
          requestId: 'request-123',
        },
      },
    });

    expect(display.description).toBe('Searching images for: "sunset beach"');
    expect(display.resultDisplay).toBe(
      'Image search for "sunset beach" returned (1 results).',
    );
  });

  it('projects Bash PTY screen content from persisted shell result', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-1',
        name: SHELL_TOOL_NAME,
        input: { command: 'node -i', pty: true },
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          kind: 'bash_pty',
          action: 'open',
          pty: true,
          pid: 12345,
          command: 'node -i',
          cwd: '/workspace',
          cols: 80,
          rows: 20,
          alive: true,
          screen: '> 1+1\n2\n>',
          timestamp: 1,
        },
      },
    });

    expect(display.resultDisplay).toContain(
      'Bash PTY open (pid=12345, 80x20, running)',
    );
    expect(display.resultDisplay).toContain('command: node -i');
    expect(display.resultDisplay).toContain('> 1+1\n2\n>');
    expect(display.resultDisplay).not.toContain('```');
    expect(display.renderOutputAsMarkdown).toBe(false);
  });

  it('projects full text Read results as a visible summary', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-1',
        name: READ_FILE_TOOL_NAME,
        input: { file_path: '/tmp/example.ts' },
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          type: 'text',
          file: {
            filePath: '/tmp/example.ts',
            content: 'one\ntwo\nthree',
            startLine: 1,
            numLines: 3,
            totalLines: 3,
          },
        },
      },
    });

    expect(display.resultDisplay).toBe('Read 3 lines');
  });

  it('projects partial text Read results with line range', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-1',
        name: READ_FILE_TOOL_NAME,
        input: { file_path: '/tmp/example.ts', offset: 2, limit: 2 },
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          type: 'text',
          file: {
            filePath: '/tmp/example.ts',
            content: 'two\nthree',
            startLine: 2,
            numLines: 2,
            totalLines: 5,
          },
        },
      },
    });

    expect(display.resultDisplay).toBe('Read lines 2-3 of 5');
  });

  it('projects Bash PTY input preview and screen content', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-1',
        name: BASH_OUTPUT_TOOL_NAME,
        input: { pid: 12345 },
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          kind: 'bash_pty',
          action: 'input',
          pty: true,
          pid: 12345,
          input_preview: '1+1<Enter>',
          cols: 80,
          rows: 20,
          alive: true,
          screen: '> 1+1\n2\n>',
          timestamp: 1,
        },
      },
    });

    expect(display.resultDisplay).toContain('Bash PTY input');
    expect(display.resultDisplay).toContain('input: 1+1<Enter>');
    expect(display.resultDisplay).toContain('2');
    expect(display.renderOutputAsMarkdown).toBe(false);
  });

  it('projects raw Bash output file content', () => {
    const display = projectToolCallDisplay({
      toolUse: {
        id: 'tool-1',
        name: BASH_OUTPUT_TOOL_NAME,
        input: { pid: 12345, mode: 'raw' },
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          kind: 'bash_output',
          action: 'output',
          pty: false,
          pid: 12345,
          output_path: '/tmp/12345.output',
          stdout: 'line 1\nline 2',
          timestamp: 1,
        },
      },
    });

    expect(display.resultDisplay).toContain('Bash output (pid=12345)');
    expect(display.resultDisplay).toContain('output: /tmp/12345.output');
    expect(display.resultDisplay).toContain('line 1\nline 2');
    expect(display.renderOutputAsMarkdown).toBe(false);
  });
});
