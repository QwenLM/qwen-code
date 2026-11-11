/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ShellExecutionService } from './shellExecutionService.js';
import {
  quotePowerShellSingleQuotedLiteral,
  _setPowerShellRuntimeForTest,
  _resetPowerShellRuntimeForTest,
} from '../utils/shell/powerShell.js';
import { getSecureSanitizationConfig } from './environmentSanitization.js';
import { createLocalBashTaskId } from '../tasks/task-id.js';
import * as windowsPaths from '../utils/windowsPaths.js';
import * as envprep from '../utils/envprep/index.js';
import { getCwd, setCwd, resetForTest } from '../utils/Shell.js';

const executable = process.env['CLI_TEST_PWSH_EXE'];
describe.skipIf(!executable)('PowerShell real shared execution', () => {
  let cwd: string;
  let originalCwd: string;
  const processes: number[] = [];
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'test-ps-exec-'));
    originalCwd = getCwd();
    resetForTest(originalCwd);
    _setPowerShellRuntimeForTest({ executable: executable!, edition: 'core' });
  });
  afterEach(async () => {
    for (const pid of processes.splice(0))
      await ShellExecutionService.kill(pid);
    setCwd(originalCwd);
    vi.restoreAllMocks();
    _resetPowerShellRuntimeForTest();
    await rm(cwd, { recursive: true, force: true });
  });
  async function start(
    command: string,
    options: Partial<Parameters<typeof ShellExecutionService.execute>[4]> = {},
    signal = new AbortController().signal,
  ) {
    const handle = await ShellExecutionService.execute(
      command,
      cwd,
      () => {},
      signal,
      {
        sanitizationConfig: getSecureSanitizationConfig(),
        shellType: 'powershell',
        taskId: createLocalBashTaskId(),
        sessionId: 'ps-integration',
        completionBehavior: 'silent',
        preserveStdoutAndStderr: true,
        preventCwdChanges: true,
        ...options,
      },
    );
    if (handle.pid === undefined)
      expect((await handle.result).error).toBeNull();
    if (handle.pid !== undefined) processes.push(handle.pid);
    return handle;
  }
  it.each(['idle', 'running', 'failed', 'succeeded'] as const)(
    'does not wait for or invoke Git Bash during PowerShell execution: %s',
    async (status) => {
      const state: envprep.GitBashPreparationState =
        status === 'running'
          ? { status, promise: new Promise(() => {}) }
          : status === 'failed'
            ? { status, lastError: 'EPERM' }
            : status === 'succeeded'
              ? { status, bashPath: 'C:/Git/bash.exe' }
              : { status };
      vi.spyOn(envprep, 'getGitBashPreparationState').mockReturnValue(state);
      const bash = vi
        .spyOn(windowsPaths, 'findGitBashPath')
        .mockRejectedValue(new Error('Git Bash unavailable'));
      const handle = await start('Write-Output independent');
      const result = await handle.result;
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('independent');
      expect(bash).not.toHaveBeenCalled();
    },
    10000,
  );
  it('preserves stdout, stderr and exit status through the shared service', async () => {
    const handle = await start(
      'Write-Output "中文😀"; [Console]::Error.WriteLine("diagnostic"); exit 7',
    );
    const result = await handle.result;
    expect(result).toMatchObject({ exitCode: 7, aborted: false });
    expect(result.stdout).toContain('中文😀');
    expect(result.stderr).toContain('diagnostic');
  }, 15000);
  it.each([
    { command: 'Write-Output "中文😀"', expected: '中文😀', failure: false },
    {
      command: 'qwen_missing_command_for_validation',
      expected: 'qwen_missing_command_for_validation',
      failure: true,
    },
    { command: 'Write-Output (', expected: 'ParserError', failure: true },
  ])(
    'preserves real tool results through JSON serialization: $command',
    async ({ command, expected, failure }) => {
      const { PowerShellTool } = await import('../tools/powerShell.js');
      const { runLogger } = await import('../utils/runLogger.js');
      const log = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
      setCwd(cwd);
      const context = {
        config: { getSessionId: () => 'ps-tool-json' },
      } as unknown as import('../config/agent-loop-context.js').AgentLoopContext;
      const result = await new PowerShellTool(context, 'core').build({
        command,
      }).executeWithContext!({
        signal: new AbortController().signal,
        callId: 'ps-tool-json-call',
        agentLoopContext: context,
        internalExecutionOwner: {
          kind: 'workflow-agent',
          suppressMainSessionNotification: true,
          disableShellAutoBackground: true,
        },
        options: {
          setExecutionIdCallback: (pid: number) => processes.push(pid),
          shellExecutionConfig: {
            preventCwdChanges: true,
            sanitizationConfig: getSecureSanitizationConfig(),
          },
        },
      } as import('../tools/tool-types.js').ToolUseContext);
      const serialized = JSON.parse(JSON.stringify(result));
      expect(serialized.isError === true).toBe(failure);
      expect(serialized.data.isError === true).toBe(failure);
      expect(serialized.toolUseResult).toEqual(serialized.data);
      expect(serialized.llmContent).toContain(expected);
      expect(serialized.returnDisplay).toContain(expected);
      if (failure) {
        expect(serialized.data.stderr).toContain(expected);
        expect(log).toHaveBeenCalledWith(
          '[PowerShellTool] Execution failed',
          expect.objectContaining({
            toolUseId: 'ps-tool-json-call',
            edition: 'core',
            phase: 'execution',
          }),
        );
      } else {
        expect(serialized.data.stdout).toContain(expected);
        expect(serialized.data.exitCode).toBe(0);
      }
    },
    15000,
  );
  it.each(['timeout', 'cancelled'] as const)(
    'preserves the real tool termination reason: %s',
    async (phase) => {
      const { PowerShellTool } = await import('../tools/powerShell.js');
      const { runLogger } = await import('../utils/runLogger.js');
      const log = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
      const controller = new AbortController();
      setCwd(cwd);
      const context = {
        config: { getSessionId: () => 'ps-termination' },
      } as unknown as import('../config/agent-loop-context.js').AgentLoopContext;
      const result = await new PowerShellTool(context, 'core').build({
        command: 'Start-Sleep -Seconds 30',
        timeout: phase === 'timeout' ? 1000 : 10000,
      }).executeWithContext!({
        signal: controller.signal,
        callId: 'ps-termination-call',
        agentLoopContext: context,
        internalExecutionOwner: {
          kind: 'workflow-agent',
          suppressMainSessionNotification: true,
          disableShellAutoBackground: true,
        },
        options: {
          setExecutionIdCallback: (pid: number) => {
            processes.push(pid);
            if (phase === 'cancelled') controller.abort('cancel');
          },
          shellExecutionConfig: {
            preventCwdChanges: true,
            sanitizationConfig: getSecureSanitizationConfig(),
          },
        },
      } as import('../tools/tool-types.js').ToolUseContext);
      expect(result.isError).toBe(true);
      expect(result.data).toMatchObject({ isError: true });
      expect(result.data).not.toHaveProperty('backgroundTaskId');
      if (phase === 'timeout')
        expect(result.data).toHaveProperty('timedOut', true);
      else expect(result.data).not.toHaveProperty('timedOut');
      expect(result.llmContent).toContain(
        phase === 'timeout' ? 'Command timed out' : '[Command was interrupted]',
      );
      expect(log).toHaveBeenCalledWith(
        '[PowerShellTool] Execution failed',
        expect.objectContaining({ phase, toolUseId: 'ps-termination-call' }),
      );
      expect(ShellExecutionService.isActive(processes.at(-1)!)).toBe(false);
    },
    15000,
  );
  it.each([false, true])(
    'applies foreground cwd isolation (prevent changes: %s)',
    async (preventCwdChanges) => {
      const initialCwd = await realpath(cwd);
      const destination = path.join(initialCwd, "中文 space's");
      await mkdir(destination);
      setCwd(initialCwd);
      const handle = await start(
        `Set-Location -LiteralPath ${quotePowerShellSingleQuotedLiteral(destination)}; Write-Output changed`,
        { preventCwdChanges },
      );
      const result = await handle.result;
      expect(result.exitCode).toBe(0);
      expect(getCwd()).toBe(preventCwdChanges ? initialCwd : destination);
    },
    10000,
  );

  it('cancels a real foreground process', async () => {
    const controller = new AbortController();
    const handle = await start(
      'Start-Sleep -Seconds 30',
      {},
      controller.signal,
    );
    expect(handle.pid).toBeDefined();
    controller.abort();
    const result = await handle.result;
    expect(result.aborted).toBe(true);
    expect(ShellExecutionService.isActive(handle.pid!)).toBe(false);
  }, 15000);
  it('moves a timed-out process to background without losing its output', async () => {
    const handle = await start('Write-Output before; Start-Sleep -Seconds 30', {
      absoluteTimeout: 1000,
      autoBackgroundOnTimeout: true,
    });
    const result = await handle.result;
    expect(result).toMatchObject({
      backgrounded: true,
      backgroundReason: 'timeout',
    });
    expect(ShellExecutionService.isActive(handle.pid!)).toBe(true);
    const output = ShellExecutionService.getOutputFilePath(handle.pid!);
    expect(output).toBeDefined();
    await vi.waitFor(
      async () => expect(await readFile(output!, 'utf8')).toContain('before'),
      { timeout: 3000, interval: 50 },
    );
    await ShellExecutionService.kill(handle.pid!);
  }, 15000);
  it('spills large pipe output to a readable file', async () => {
    const handle = await start(
      "[Console]::Write('x' * 9000000); [Console]::Write('END-MARKER')",
    );
    const result = await handle.result;
    expect(result.exitCode).toBe(0);
    expect(result.outputFilePath).toBeDefined();
    try {
      expect((await stat(result.outputFilePath!)).size).toBe(9000010);
      expect(
        (await readFile(result.outputFilePath!, 'utf8')).endsWith('END-MARKER'),
      ).toBe(true);
    } finally {
      await rm(result.outputFilePath!, { force: true });
    }
  }, 20000);
  it.each([false, true])(
    'reports a missing runtime without a ghost task (background: %s)',
    async (background) => {
      const { TaskRegistry } = await import('../tasks/task-registry.js');
      const { bridgeExecutionLifecycleToRegistry } = await import(
        '../tasks/execution-bridge.js'
      );
      const { drainSubagentSdkEvents, disposeSessionEventQueue } = await import(
        '../agents/subagent-sdk-events.js'
      );
      const registry = new TaskRegistry();
      const sessionId = 'ps-missing-runtime';
      const cleanup = bridgeExecutionLifecycleToRegistry(registry, {
        sessionId,
      });
      _setPowerShellRuntimeForTest({
        executable: path.join(cwd, 'missing-pwsh'),
        edition: 'core',
      });
      try {
        const handle = await ShellExecutionService.execute(
          'Write-Output unreachable',
          cwd,
          () => {},
          new AbortController().signal,
          {
            shellType: 'powershell',
            sanitizationConfig: getSecureSanitizationConfig(),
            taskId: createLocalBashTaskId(),
            sessionId,
            startInBackground: background ? { reason: 'model' } : undefined,
          },
        );
        const result = await handle.result;
        expect(result.error?.message).toContain('ENOENT');
        expect((result.error as NodeJS.ErrnoException)?.code).toBe('ENOENT');
        expect(result.backgrounded).not.toBe(true);
        expect(registry.all()).toEqual([]);
        expect(drainSubagentSdkEvents(sessionId, () => true)).toEqual([]);
      } finally {
        cleanup();
        disposeSessionEventQueue(sessionId);
      }
    },
    10000,
  );

  it.each(['model', 'user'] as const)(
    'uses one task identity for real background execution, registry and SDK completion: %s',
    async (reason) => {
      const { TaskRegistry } = await import('../tasks/task-registry.js');
      const { bridgeExecutionLifecycleToRegistry } = await import(
        '../tasks/execution-bridge.js'
      );
      const { drainSubagentSdkEvents, disposeSessionEventQueue } = await import(
        '../agents/subagent-sdk-events.js'
      );
      const { getCommandQueueSnapshot } = await import(
        './messageQueueManager.js'
      );
      const registry = new TaskRegistry();
      const sessionId = `ps-real-completion-${reason}`;
      const taskId = createLocalBashTaskId();
      const cleanup = bridgeExecutionLifecycleToRegistry(registry, {
        sessionId,
      });
      try {
        const handle = await start('Write-Output completed-output', {
          taskId,
          sessionId,
          taskKind: 'bash',
          ownerAgentId: 'agent-owner',
          toolUseId: 'ps-tool-call',
          completionBehavior: 'notify',
          startInBackground: reason === 'model' ? { reason } : undefined,
        });
        if (reason === 'user')
          ShellExecutionService.background(
            handle.pid!,
            sessionId,
            'Write-Output completed-output',
            'user',
            taskId,
          );
        expect(await handle.result).toMatchObject({
          backgrounded: true,
          backgroundReason: reason,
        });
        expect(registry.getByPublicId(taskId)).toMatchObject({
          publicId: taskId,
          ownerAgentId: 'agent-owner',
          toolUseId: 'ps-tool-call',
          sessionId,
          status: 'running',
        });
        expect(drainSubagentSdkEvents(sessionId, () => true)).toContainEqual(
          expect.objectContaining({
            subtype: 'task_started',
            task_id: taskId,
            tool_use_id: 'ps-tool-call',
            task_type: 'local_bash',
          }),
        );
        await vi.waitFor(
          () =>
            expect(registry.getByPublicId(taskId)).toMatchObject({
              status: 'completed',
              exitCode: 0,
              notified: true,
            }),
          { timeout: 5000 },
        );
        expect(registry.getByPublicId(taskId)).toMatchObject({
          output: expect.stringContaining('completed-output'),
        });
        expect(drainSubagentSdkEvents(sessionId, () => true)).toContainEqual(
          expect.objectContaining({
            subtype: 'task_updated',
            task_id: taskId,
            patch: expect.objectContaining({ status: 'completed' }),
          }),
        );
        expect(getCommandQueueSnapshot()).toContainEqual(
          expect.objectContaining({
            commandMode: 'task-notification',
            prompt: expect.stringContaining(taskId),
          }),
        );
        expect(ShellExecutionService.isActive(handle.pid!)).toBe(false);
        ShellExecutionService.background(
          handle.pid!,
          sessionId,
          'Write-Output completed-output',
          'user',
          taskId,
        );
        expect(registry.getByPublicId(taskId)).toMatchObject({
          status: 'completed',
          exitCode: 0,
        });
        expect(registry.all()).toHaveLength(1);
      } finally {
        cleanup();
        disposeSessionEventQueue(sessionId);
        const task = registry.getByPublicId(taskId);
        if (task?.type === 'local_bash' && task.outputPath)
          await rm(task.outputPath, { force: true });
      }
    },
    15000,
  );

  it('enforces ownership when stopping a real PowerShell background task', async () => {
    const { TaskRegistry } = await import('../tasks/task-registry.js');
    const { bridgeExecutionLifecycleToRegistry } = await import(
      '../tasks/execution-bridge.js'
    );
    const { stopTask } = await import('../tasks/task-control.js');
    const { disposeSessionEventQueue } = await import(
      '../agents/subagent-sdk-events.js'
    );
    const registry = new TaskRegistry();
    const sessionId = 'ps-real-stop';
    const taskId = createLocalBashTaskId();
    const cleanup = bridgeExecutionLifecycleToRegistry(registry, { sessionId });
    try {
      const handle = await start('Start-Sleep -Seconds 30', {
        taskId,
        sessionId,
        ownerAgentId: 'agent-owner',
        taskKind: 'bash',
        startInBackground: { reason: 'model' },
      });
      await handle.result;
      await expect(
        stopTask({ registry, sessionId, taskId, callerAgentId: 'other-agent' }),
      ).rejects.toMatchObject({ code: 'not_owner' });
      expect(ShellExecutionService.isActive(handle.pid!)).toBe(true);
      await stopTask({
        registry,
        sessionId,
        taskId,
        callerAgentId: 'agent-owner',
      });
      expect(registry.getByPublicId(taskId)).toMatchObject({
        status: 'killed',
      });
      expect(ShellExecutionService.isActive(handle.pid!)).toBe(false);
    } finally {
      cleanup();
      disposeSessionEventQueue(sessionId);
      const task = registry.getByPublicId(taskId);
      if (task?.type === 'local_bash' && task.outputPath)
        await rm(task.outputPath, { force: true });
    }
  }, 15000);

  it('starts in background and can be stopped through the same service', async () => {
    const handle = await start('Start-Sleep -Seconds 30', {
      startInBackground: { reason: 'model' },
    });
    const result = await handle.result;
    expect(result).toMatchObject({
      backgrounded: true,
      backgroundReason: 'model',
      pid: handle.pid,
    });
    expect(ShellExecutionService.isActive(handle.pid!)).toBe(true);
    await ShellExecutionService.kill(handle.pid!);
    expect(ShellExecutionService.isActive(handle.pid!)).toBe(false);
  }, 15000);
});
