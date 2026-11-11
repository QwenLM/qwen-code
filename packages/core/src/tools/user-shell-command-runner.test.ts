/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockBackground = vi.hoisted(() => vi.fn());
vi.mock('../services/shellExecutionService.js', () => ({
  ShellExecutionService: {
    background: mockBackground,
    execute: vi.fn(),
    getOutputFilePath: vi.fn(),
  },
}));

import type { Config } from '../config/config.js';
import type { ToolUseContext } from './tool-types.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { ShellTool, type ShellToolParams } from './shell.js';
import { PowerShellTool, type PowerShellToolParams } from './powerShell.js';
import { POWERSHELL_TOOL_NAME, SHELL_TOOL_NAME } from './tool-names.js';
import {
  backgroundUserShellCommand,
  runUserShellCommand,
} from './user-shell-command-runner.js';

function createConfig(tool: unknown): Config {
  return {
    getToolRegistry: () => ({
      getKnownTool: (name: string) =>
        (name === 'PowerShell' && tool instanceof PowerShellTool) ||
        (name === 'Bash' && tool instanceof ShellTool)
          ? tool
          : undefined,
    }),
    getSessionId: () => 'session-123',
    getShellExecutionConfig: () => ({ shellType: 'bash' }),
  } as unknown as Config;
}

describe('runUserShellCommand', () => {
  it.each([
    {
      data: {
        stdout: '',
        stderr: '',
        interrupted: false,
        exitCode: 1,
        returnCodeInterpretation: 'No matches found',
      },
      kind: 'completed',
      display: 'No matches found',
    },
    {
      data: {
        stdout: '',
        stderr: 'Command timed out',
        interrupted: false,
        timedOut: true,
        isError: true,
      },
      kind: 'cancelled',
      display: 'Command timed out',
    },
  ])(
    'preserves PowerShell outcome semantics: $display',
    async ({ data, kind, display }) => {
      const tool = Object.create(PowerShellTool.prototype) as PowerShellTool;
      Object.assign(tool, {
        build: () => ({ executeWithContext: async () => ({ data }) }),
      });
      const result = await runUserShellCommand({
        config: createConfig(tool),
        command: 'command',
        callId: 'review',
        signal: new AbortController().signal,
      });
      expect(result.kind).toBe(kind);
      expect(result.displayOutput).toContain(display);
      expect(result.modelOutput.stderr).toBe(data.stderr);
      if (result.kind === 'cancelled') expect(result.timedOut).toBe(true);
    },
  );
  it('preserves cancellation before PowerShell starts', async () => {
    const tool = new PowerShellTool({} as never, 'core');
    const controller = new AbortController();
    controller.abort();
    const result = await runUserShellCommand({
      config: createConfig(tool),
      command: 'Write-Output hello',
      callId: 'review',
      signal: controller.signal,
    });
    expect(result).toMatchObject({ kind: 'cancelled', timedOut: false });
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('directly invokes the registered Bash Tool with user-shell context', async () => {
    let receivedContext: ToolUseContext | undefined;
    const executeWithContext = vi.fn(async (ctx: ToolUseContext) => {
      receivedContext = ctx;
      ctx.options?.setExecutionIdCallback?.(4242);
      ctx.updateOutput?.({
        isShellLiveOutput: true,
        output: 'running',
        totalLines: 12,
        totalBytes: 345,
      });
      return {
        llmContent: 'ignored by shell mode',
        returnDisplay: 'ignored by shell mode',
        data: {
          kind: 'completed',
          stdout: 'done',
          stderr: '',
          exitCode: 0,
          signal: null,
          totalLines: 12,
          totalBytes: 345,
        },
      } satisfies ToolResult;
    });
    const invocation = {
      executeWithContext,
    } as unknown as ToolInvocation<ShellToolParams, ToolResult>;
    const tool = Object.create(ShellTool.prototype) as ShellTool;
    const checkPermissions = vi.fn();
    Object.assign(tool, {
      build: vi.fn(() => invocation),
      checkPermissions,
    });
    const onExecutionId = vi.fn();
    const onProgress = vi.fn();
    const controller = new AbortController();

    const outcome = await runUserShellCommand({
      config: createConfig(tool),
      command: 'echo done',
      signal: controller.signal,
      callId: 'shell-call',
      onExecutionId,
      onProgress,
    });

    expect(tool.build).toHaveBeenCalledWith({ command: 'echo done' });
    expect(executeWithContext).toHaveBeenCalledOnce();
    expect(checkPermissions).not.toHaveBeenCalled();
    expect(receivedContext).toMatchObject({
      signal: controller.signal,
      callId: 'shell-call',
      sessionId: 'session-123',
      invocationOrigin: 'user-shell',
    });
    expect(receivedContext?.options?.shellExecutionConfig).toMatchObject({
      shellType: 'bash',
      sessionId: 'session-123',
      pager: 'cat',
      originalCommand: 'echo done',
    });
    expect(onExecutionId).toHaveBeenCalledWith(4242);
    expect(onProgress).toHaveBeenCalledWith({
      output: 'running',
      totalLines: 12,
      totalBytes: 345,
    });
    expect(outcome).toMatchObject({
      kind: 'completed',
      displayOutput: 'done',
      modelOutput: { stdout: 'done', stderr: '' },
      exitCode: 0,
      signal: null,
      progress: { totalLines: 12, totalBytes: 345 },
    });
  });

  it('uses the registered PowerShell Tool when Bash is unavailable in this registry', async () => {
    let requestedToolName: string | undefined;
    let receivedContext: ToolUseContext | undefined;
    const executeWithContext = vi.fn(async (ctx: ToolUseContext) => {
      receivedContext = ctx;
      ctx.options?.setExecutionIdCallback?.(5150);
      return {
        llmContent: 'stdout:\ndone\nstderr:\n(empty)\nExit code: 0',
        returnDisplay: 'done',
        data: {
          stdout: 'done',
          stderr: '',
          interrupted: false,
          exitCode: 0,
          isImage: false,
          totalLines: 1,
          totalBytes: 4,
        },
      } satisfies ToolResult;
    });
    const invocation = {
      executeWithContext,
    } as unknown as ToolInvocation<PowerShellToolParams, ToolResult>;
    const tool = Object.create(PowerShellTool.prototype) as PowerShellTool;
    const checkPermissions = vi.fn();
    Object.assign(tool, {
      build: vi.fn(() => invocation),
      checkPermissions,
    });
    const config = {
      getToolRegistry: () => ({
        getKnownTool: (name: string) => {
          requestedToolName = name;
          return name === POWERSHELL_TOOL_NAME ? tool : undefined;
        },
      }),
      getSessionId: () => 'session-123',
      getShellExecutionConfig: () => ({}),
    } as unknown as Config;
    const onExecutionId = vi.fn();

    const outcome = await runUserShellCommand({
      config,
      command: 'Write-Output done',
      signal: new AbortController().signal,
      callId: 'powershell-call',
      onExecutionId,
    });

    expect(requestedToolName).toBe(POWERSHELL_TOOL_NAME);
    expect(tool.build).toHaveBeenCalledWith({
      command: 'Write-Output done',
    });
    expect(checkPermissions).not.toHaveBeenCalled();
    expect(receivedContext).toMatchObject({
      callId: 'powershell-call',
      invocationOrigin: 'user-shell',
      options: {
        shellExecutionConfig: { shellType: 'powershell' },
      },
    });
    expect(onExecutionId).toHaveBeenCalledWith(5150);
    expect(outcome).toMatchObject({
      kind: 'completed',
      displayOutput: 'done',
      modelOutput: { stdout: 'done', stderr: '' },
      exitCode: 0,
      signal: null,
      progress: { totalLines: 1, totalBytes: 4 },
    });
  });

  it('requests the Bash Tool when Bash is available in this registry', async () => {
    let requestedToolName: string | undefined;
    const tool = Object.create(ShellTool.prototype) as ShellTool;
    Object.assign(tool, {
      build: vi.fn(() => ({
        executeWithContext: vi.fn(async () => ({
          llmContent: 'done',
          returnDisplay: 'done',
          data: {
            kind: 'completed',
            stdout: 'done',
            stderr: '',
            exitCode: 0,
            signal: null,
          },
        })),
      })),
    });
    const config = {
      getToolRegistry: () => ({
        getKnownTool: (name: string) => {
          requestedToolName = name;
          return name === SHELL_TOOL_NAME ? tool : undefined;
        },
      }),
      getSessionId: () => 'session-123',
      getShellExecutionConfig: () => ({}),
    } as unknown as Config;

    await runUserShellCommand({
      config,
      command: 'echo done',
      signal: new AbortController().signal,
      callId: 'bash-call',
    });

    expect(requestedToolName).toBe(SHELL_TOOL_NAME);
  });

  it('reports the execution id before the command promise completes', async () => {
    let resolveResult!: (result: ToolResult) => void;
    const completion = new Promise<ToolResult>((resolve) => {
      resolveResult = resolve;
    });
    const executeWithContext = vi.fn(async (ctx: ToolUseContext) => {
      ctx.options?.setExecutionIdCallback?.(9876);
      return completion;
    });
    const tool = Object.create(ShellTool.prototype) as ShellTool;
    Object.assign(tool, {
      build: vi.fn(() => ({ executeWithContext })),
    });
    const onExecutionId = vi.fn();

    const runPromise = runUserShellCommand({
      config: createConfig(tool),
      command: 'sleep 30',
      signal: new AbortController().signal,
      callId: 'shell-call',
      onExecutionId,
    });

    await vi.waitFor(() => expect(onExecutionId).toHaveBeenCalledWith(9876));
    resolveResult({
      llmContent: 'done',
      returnDisplay: 'done',
      data: {
        kind: 'completed',
        stdout: 'done',
        stderr: '',
        exitCode: 0,
        signal: null,
      },
    });
    await expect(runPromise).resolves.toMatchObject({ kind: 'completed' });
  });

  it('uses the shared persisted-output formatter for display and model context', async () => {
    const rawInlineOutput = 'x'.repeat(30_000);
    const executeWithContext = vi.fn(async () => ({
      llmContent: 'ignored',
      returnDisplay: 'ignored',
      data: {
        kind: 'completed',
        stdout: rawInlineOutput,
        stderr: '',
        exitCode: 0,
        signal: null,
        persistedOutput: {
          path: '/tmp/tool-outputs/session/output.txt',
          originalSizeBytes: 40_000,
          savedSizeBytes: 40_000,
          truncated: false,
          preview: 'preview line',
        },
      },
    }));
    const tool = Object.create(ShellTool.prototype) as ShellTool;
    Object.assign(tool, {
      build: vi.fn(() => ({ executeWithContext })),
    });

    const outcome = await runUserShellCommand({
      config: createConfig(tool),
      command: 'large-output',
      signal: new AbortController().signal,
      callId: 'shell-call',
    });

    expect(outcome.displayOutput).toContain('Full output saved to:');
    expect(outcome.displayOutput).toContain(
      '/tmp/tool-outputs/session/output.txt',
    );
    expect(outcome.displayOutput).toContain('preview line');
    expect(outcome.displayOutput).not.toContain(rawInlineOutput);
    expect(outcome.modelOutput.stdout).toBe(outcome.displayOutput);
  });

  it('reports output-cap termination instead of a generic cancellation', async () => {
    const executeWithContext = vi.fn(async () => ({
      llmContent: 'ignored',
      returnDisplay: 'ignored',
      data: {
        kind: 'cancelled',
        stdout: 'partial output',
        stderr: '',
        timedOut: false,
        outputLimitExceeded: true,
      },
    }));
    const tool = Object.create(ShellTool.prototype) as ShellTool;
    Object.assign(tool, {
      build: vi.fn(() => ({ executeWithContext })),
    });

    const outcome = await runUserShellCommand({
      config: createConfig(tool),
      command: 'noisy-command',
      signal: new AbortController().signal,
      callId: 'shell-call',
    });

    expect(outcome).toMatchObject({
      kind: 'cancelled',
      displayOutput: expect.stringContaining('output file exceeded 5GB'),
      modelOutput: {
        stderr: expect.stringContaining('output file exceeded 5GB'),
      },
    });
  });

  it('fails closed when the registered tool is unavailable', async () => {
    await expect(
      runUserShellCommand({
        config: createConfig(undefined),
        command: 'echo nope',
        signal: new AbortController().signal,
        callId: 'shell-call',
      }),
    ).rejects.toThrow('Registered Bash tool is unavailable.');
  });

  it('backgrounds through the shared shell execution service', () => {
    backgroundUserShellCommand(42, 'session-id', 'sleep 30');
    expect(mockBackground).toHaveBeenCalledWith(
      42,
      'session-id',
      'sleep 30',
      'user',
    );
  });
});
