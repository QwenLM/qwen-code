/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { PowerShellTool } from './powerShell.js';

describe('PowerShell foreground sleep policy', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    { command: 'Start-Sleep 25', tools: ['Bash', 'Monitor'], blocked: true },
    {
      command: 'sleep -Seconds 30; Write-Output done',
      tools: ['Bash', 'Monitor'],
      blocked: true,
    },
    { command: 'Start-Sleep 24', tools: ['Bash', 'Monitor'], blocked: false },
    { command: 'Start-Sleep 30', tools: ['PowerShell'], blocked: false },
    { command: 'Start-Sleep 30', tools: ['Bash'], blocked: false },
    {
      command: 'Start-Sleep 30',
      tools: ['Bash', 'Monitor'],
      background: true,
      blocked: false,
    },
    {
      command: 'Start-Sleep 30',
      tools: ['Bash', 'Monitor'],
      suppressed: true,
      blocked: false,
    },
    {
      command: 'Start-Sleep 30',
      tools: ['Bash', 'Monitor'],
      user: true,
      blocked: false,
    },
  ])(
    'uses caller capabilities and execution policy: $command / $tools / $blocked',
    async (row) => {
      const { ShellExecutionService } = await import(
        '../services/shellExecutionService.js'
      );
      const execute = vi
        .spyOn(ShellExecutionService, 'execute')
        .mockRejectedValue(new Error('execution reached'));
      const root = {
        config: { getSessionId: () => 'sleep-test' },
      } as unknown as AgentLoopContext;
      const caller = {
        ...root,
        toolRegistry: {
          hasToolEnabled: (name: string) => row.tools.includes(name),
        },
      } as unknown as AgentLoopContext;
      const result = new PowerShellTool(root, 'core').build({
        command: row.command,
        run_in_background: row.background,
      }).executeWithContext!({
        signal: new AbortController().signal,
        agentLoopContext: caller,
        invocationOrigin: row.user ? 'user-shell' : 'model',
        ...(row.suppressed
          ? {
              internalExecutionOwner: {
                kind: 'workflow-agent',
                suppressMainSessionNotification: true,
                disableShellAutoBackground: true,
              },
            }
          : {}),
      });
      if (row.blocked) {
        await expect(result).resolves.toMatchObject({
          isError: true,
          error: { type: 'invalid_tool_params' },
        });
        expect(execute).not.toHaveBeenCalled();
      } else await expect(result).rejects.toThrow('execution reached');
    },
  );
});

describe('PowerShellTool contract', () => {
  it('exposes only the aligned public parameters', () => {
    const tool = new PowerShellTool({} as AgentLoopContext, 'core');
    const schema = tool.getSchema().parametersJsonSchema as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual([
      'command',
      'timeout',
      'description',
      'run_in_background',
    ]);
    expect(schema.required).toEqual(['command']);
  });

  it('rejects control characters hidden by permission dialogs', () => {
    const tool = new PowerShellTool({} as AgentLoopContext, 'desktop');
    expect(() => tool.build({ command: 'Get-Item\u0000hidden' })).toThrow(
      'U+0000',
    );
    expect(() => tool.build({ command: 'Write-Output "a\nb"' })).not.toThrow();
  });

  it('accepts CRLF commands and here-strings but rejects lone carriage returns', () => {
    const tool = new PowerShellTool({} as AgentLoopContext, 'core');
    expect(() =>
      tool.build({ command: 'Write-Output one\r\nWrite-Output two' }),
    ).not.toThrow();
    expect(() =>
      tool.build({ command: "Write-Output @'\r\n中文\r\n'@" }),
    ).not.toThrow();
    expect(() =>
      tool.build({ command: 'Write-Output hidden\roverwrite' }),
    ).toThrow('U+000D');
  });

  it.each([NaN, Infinity, -Infinity, -1])(
    'rejects invalid timeout %s before execution',
    (timeout) => {
      const tool = new PowerShellTool({} as AgentLoopContext, 'core');
      expect(() =>
        tool.build({ command: 'Write-Output hello', timeout }),
      ).toThrow();
    },
  );

  it('uses edition-specific syntax guidance', () => {
    const core = new PowerShellTool({} as AgentLoopContext, 'core');
    const desktop = new PowerShellTool({} as AgentLoopContext, 'desktop');
    expect(core.description).toContain('PowerShell 7+');
    expect(core.description).toContain('&&');
    expect(desktop.description).toContain('Windows PowerShell 5.1');
    expect(desktop.description).toContain('UTF-8 with a BOM');
  });
});

describe('PowerShell return-code classification without AST', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    ['rg absent file', 1, '', 'No matches found'],
    ['git diff', 1, '', 'Files differ'],
    ['git -C . diff --no-index --exit-code a b', 1, '', 'Files differ'],
    [
      "& 'C:\\Program Files\\Git\\git.exe' -c color.ui=false diff",
      1,
      '',
      'Files differ',
    ],
    ['where.exe missing', 1, 'missing', 'No matching files found'],
    ['fc.exe /b a b', 1, 'different', 'Files differ'],
    ['diff.exe a b', 1, 'different', 'Files differ'],
    ['where.exe missing', 1, '', undefined],
    ['fc.exe /b a missing', 2, 'missing', undefined],
    ['fc a b', 1, 'different', undefined],
    ['diff a b', 1, 'different', undefined],
    ['where x', 1, 'missing', undefined],
    ['Write-Output "x; y|z"; git diff # final comment', 1, '', 'Files differ'],
    ['unknown.exe; git diff', 1, '', 'Files differ'],
    ['rg x file; unknown.exe', 1, '', undefined],
    ['rg x file | unknown.exe', 1, '', undefined],
    ['& $program', 1, '', undefined],
    ['findstr absent file', 1, '', 'No matches found'],
    ['robocopy from to', 7, '', 'Copy completed without a copy failure.'],
    ['robocopy from to', 8, '', undefined],
    [
      'msiexec /i app.msi',
      3010,
      '',
      'The operation succeeded and a restart is required.',
    ],
    ['unknown.exe', 3010, '', undefined],
  ])(
    'interprets %s (%s) without invoking PowerShell analysis',
    async (command, code, output, interpretation) => {
      const parser = await import('./shell-permissions/powerShellParser.js');
      const parse = vi
        .spyOn(parser, 'parsePowerShellCommand')
        .mockRejectedValue(new Error('AST prohibited by host policy'));
      const { interpretPowerShellExitStatus } = await import('./powerShell.js');
      const result = await interpretPowerShellExitStatus(
        command,
        code,
        null,
        '',
        output,
      );
      expect(result).toEqual(
        interpretation
          ? { returnCodeInterpretation: interpretation }
          : { isError: true },
      );
      expect(await interpretPowerShellExitStatus(command, code, 15)).toEqual({
        isError: true,
      });
      expect(await interpretPowerShellExitStatus(command, 0, null)).toEqual({});
      expect(parse).not.toHaveBeenCalled();
    },
  );
});

describe.skipIf(!process.env['CLI_TEST_PWSH_EXE'])(
  'PowerShell approval payload',
  () => {
    it('retains the full CRLF here-string and trailing command for approval', async () => {
      const { buildConfirmationDetails } = await import(
        './confirmation-details-builder.js'
      );
      const { _setPowerShellRuntimeForTest, _resetPowerShellRuntimeForTest } =
        await import('../utils/shell/powerShell.js');
      const { _setPowerShellParserRunnerForTest } = await import(
        './shell-permissions/powerShellParser.js'
      );
      _setPowerShellRuntimeForTest({
        executable: process.env['CLI_TEST_PWSH_EXE']!,
        edition: 'core',
      });
      const command =
        "Write-Output @'\r\n中文; literal | content\r\n'@\r\nRemove-Item -LiteralPath example.txt";
      try {
        const tool = new PowerShellTool({} as AgentLoopContext, 'core');
        const details = await buildConfirmationDetails(
          tool,
          { command },
          'Review',
        );
        expect(details).toMatchObject({
          type: 'exec',
          title: command,
          command,
          commands: [command],
          isCompound: true,
        });
        if (details.type === 'exec')
          expect(
            details.rootCommands?.map((name) => name.toLowerCase()),
          ).toEqual(['write-output', 'remove-item']);
      } finally {
        _setPowerShellParserRunnerForTest();
        _resetPowerShellRuntimeForTest();
      }
    });
  },
);

describe('PowerShell shared task lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());
  it('handles a failed interrupt kill without an unhandled rejection', async () => {
    const { ShellExecutionService } = await import(
      '../services/shellExecutionService.js'
    );
    const { runLogger } = await import('../utils/runLogger.js');
    const log = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    const kill = vi
      .spyOn(ShellExecutionService, 'kill')
      .mockRejectedValue(new Error('taskkill access denied'));
    vi.spyOn(ShellExecutionService, 'isActive').mockReturnValue(true);
    vi.spyOn(ShellExecutionService, 'execute').mockResolvedValue({
      pid: 12345,
      result: Promise.resolve({
        output: '',
        exitCode: null,
        signal: null,
        error: null,
        aborted: true,
        pid: 12345,
        executionMethod: 'child_process',
      }),
    });
    const controller = new AbortController();
    const context = {
      config: { getSessionId: () => 'session' },
    } as unknown as AgentLoopContext;
    await new PowerShellTool(context, 'core').build({
      command: 'Write-Output hello',
    }).executeWithContext!({
      signal: controller.signal,
      agentLoopContext: context,
      internalExecutionOwner: {
        kind: 'workflow-agent',
        suppressMainSessionNotification: true,
        disableShellAutoBackground: true,
      },
      options: {
        shellExecutionConfig: {
          preventCwdChanges: true,
          sanitizationConfig: {
            allowedEnvironmentVariables: [],
            blockedEnvironmentVariables: [],
            enableEnvironmentVariableRedaction: false,
          },
        },
        setExecutionIdCallback: () =>
          queueMicrotask(() => controller.abort('interrupt')),
      },
    });
    expect(kill).toHaveBeenCalledExactlyOnceWith(12345);
    expect(log).toHaveBeenCalledWith(
      '[PowerShellTool] Interrupt kill failed',
      { executionId: 12345, error: 'Error: taskkill access denied' },
    );
  });

  it.each(['ENOENT', 'EACCES'])(
    'shows startup failure %s even when stderr is empty',
    async (code) => {
      const { ShellExecutionService } = await import(
        '../services/shellExecutionService.js'
      );
      const { runLogger } = await import('../utils/runLogger.js');
      const log = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
      vi.spyOn(ShellExecutionService, 'execute').mockResolvedValue({
        pid: undefined,
        result: Promise.resolve({
          output: '',
          stdout: '',
          stderr: '',
          exitCode: null,
          signal: null,
          error: Object.assign(new Error(`spawn pwsh ${code}`), { code }),
          aborted: false,
          pid: undefined,
          executionMethod: 'child_process',
        }),
      });
      const context = {
        config: { getSessionId: () => 'session' },
      } as unknown as AgentLoopContext;
      const result = await new PowerShellTool(context, 'core').build({
        command: 'Write-Output secret-argument',
      }).executeWithContext!({
        signal: new AbortController().signal,
        callId: 'call-startup',
        agentLoopContext: context,
        options: { shellExecutionConfig: { preventCwdChanges: true } },
      } as import('./tool-types.js').ToolUseContext);
      expect(result.isError).toBe(true);
      expect(result.llmContent).toContain(
        `PowerShell could not start: spawn pwsh ${code}`,
      );
      expect(result.returnDisplay).toContain(code);
      expect(result.data).toMatchObject({
        isError: true,
        stderr: expect.stringContaining(code),
      });
      expect(log).toHaveBeenCalledWith(
        '[PowerShellTool] Execution failed',
        expect.objectContaining({
          taskId: expect.stringMatching(/^b[a-z0-9]{8}$/),
          toolUseId: 'call-startup',
          edition: 'core',
          phase: 'startup',
          errorCode: code,
        }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-argument');
    },
  );
  it.each([false, true])(
    'passes ownership and stable task identity before spawning (background suppressed: %s)',
    async (suppress) => {
      const { ShellExecutionService } = await import(
        '../services/shellExecutionService.js'
      );
      const execute = vi
        .spyOn(ShellExecutionService, 'execute')
        .mockResolvedValue({
          pid: 12345,
          result: Promise.resolve({
            output: '',
            stdout: '',
            stderr: '',
            exitCode: 0,
            signal: null,
            error: null,
            aborted: false,
            pid: 12345,
            executionMethod: 'child_process',
            backgrounded: !suppress,
            backgroundReason: 'model',
          }),
        });
      vi.spyOn(ShellExecutionService, 'getOutputFilePath').mockReturnValue(
        '/tmp/task.output',
      );
      const background = vi.spyOn(ShellExecutionService, 'background');
      const context = {
        config: { getSessionId: () => 'session' },
      } as unknown as AgentLoopContext;
      const invocation = new PowerShellTool(context, 'core').build({
        command: 'Write-Output hello',
        description: 'Print hello',
        run_in_background: true,
      });
      const result = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        agentId: 'worker',
        callId: 'call-1',
        sessionId: 'session',
        agentLoopContext: context,
        options: { shellExecutionConfig: { preventCwdChanges: true } },
        ...(suppress
          ? { internalExecutionOwner: { disableShellAutoBackground: true } }
          : {}),
      } as import('./tool-types.js').ToolUseContext);
      const options = execute.mock.calls[0][4]!;
      expect(options).toMatchObject({
        shellType: 'powershell',
        taskKind: 'bash',
        taskId: expect.stringMatching(/^b[a-z0-9]{8}$/),
        taskDescription: 'Print hello',
        ownerAgentId: 'worker',
        toolUseId: 'call-1',
        sessionId: 'session',
        preventCwdChanges: true,
      });
      expect(options.startInBackground).toEqual(
        suppress ? undefined : { reason: 'model' },
      );
      expect(options.autoBackgroundOnTimeout).toBe(false);
      expect(background).not.toHaveBeenCalled();
      if (!suppress) {
        expect(result.data).toMatchObject({
          backgroundTaskId: options.taskId,
          pid: 12345,
        });
        expect(result.llmContent).toContain(options.taskId!);
      }
    },
  );
});
