/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHookOutput, HookEventName, HookType } from './types.js';
import type {
  HookConfig,
  HookInput,
  HookOutput,
  HookExecutionResult,
  PreToolUseInput,
  UserPromptExpansionInput,
  UserPromptSubmitInput,
  CommandHookConfig,
  FunctionHookContext,
  PromptHookConfig,
} from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  escapeShellArg,
  getShellConfiguration,
  type ShellType,
  type ShellConfiguration,
} from '../utils/shell-utils.js';
import { HttpHookRunner } from './httpHookRunner.js';
import { FunctionHookRunner } from './functionHookRunner.js';
import { PromptHookRunner } from './promptHookRunner.js';
import { AsyncHookRegistry, generateHookId } from './asyncHookRegistry.js';
import type { Config } from '../config/config.js';
import { getShellContextEnvVars } from '../services/shellContextEnv.js';
import { sanitizeChildEnv } from '../utils/sanitize-child-env.js';

const debugLogger = createDebugLogger('TRUSTED_HOOKS');

/**
 * Default timeout for hook execution (60 seconds)
 */
const DEFAULT_HOOK_TIMEOUT = 60000;

/**
 * Maximum length for stdout/stderr output (1MB)
 * Prevents memory issues from unbounded output
 */
const MAX_OUTPUT_LENGTH = 1024 * 1024;

const HOOK_TERMINATE_GRACE_MS = 2000;
const HOOK_PROCESS_GROUP_POLL_MS = 50;
const HOOK_CHILD_CLOSE_WAIT_MS = 1000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 2000;
const WINDOWS_TASKKILL = `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\taskkill.exe`;
const SURVIVING_HOOK_TIMEOUT_EXIT_CODE = 124;
const SURVIVING_HOOK_SUPERVISOR_GRACE_MS =
  HOOK_TERMINATE_GRACE_MS + HOOK_PROCESS_GROUP_POLL_MS * 2;

// An eval source works in both TypeScript development and the single-file CLI
// bundle without shipping a second executable asset beside the entry point.
const SURVIVING_HOOK_SUPERVISOR_SOURCE = String.raw`
'use strict';

const { execFile, spawn } = require('node:child_process');
const { closeSync, openSync, rmSync, writeSync } = require('node:fs');

const [
  inputPath,
  timeoutValue,
  graceValue,
  executable,
  argsValue,
  nodeOptionsValue,
] =
  process.argv.slice(1);
const timeout = Number(timeoutValue);
const grace = Number(graceValue);
const args = JSON.parse(argsValue);
const originalNodeOptions = JSON.parse(nodeOptionsValue);
const pollInterval = ${HOOK_PROCESS_GROUP_POLL_MS};
const timeoutExitCode = ${SURVIVING_HOOK_TIMEOUT_EXIT_CODE};
const signalExitCode = 143;
const statusFd = 3;
let hook;
let rootClosed = false;
let rootExitCode = 1;
let finished = false;
let terminationPromise;
let terminationExitCode;
let timeoutHandle;
let pollHandle;

const sendStatus = (status) => {
  try {
    writeSync(statusFd, status + '\n');
  } catch {}
};

const removeInput = () => {
  try {
    rmSync(inputPath, { force: true });
  } catch {}
};

const signalGroup = (signal) => {
  if (!hook?.pid) return false;
  try {
    process.kill(-hook.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    try {
      hook.kill(signal);
    } catch {}
    return true;
  }
};

const groupAlive = () => {
  if (!hook?.pid) return false;
  if (process.platform === 'win32') return hook.exitCode === null;
  try {
    process.kill(-hook.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
};

const waitForGroupExit = async () => {
  const deadline = Date.now() + grace;
  while (groupAlive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  return !groupAlive();
};

const terminateWindowsTree = () =>
  new Promise((resolve) => {
    if (!hook?.pid) {
      resolve();
      return;
    }
    const taskkill = ${JSON.stringify(WINDOWS_TASKKILL)};
    execFile(
      taskkill,
      ['/f', '/t', '/pid', String(hook.pid)],
      { windowsHide: true, timeout: ${WINDOWS_TASKKILL_TIMEOUT_MS} },
      () => {
        try {
          hook.kill('SIGKILL');
        } catch {}
        resolve();
      },
    );
  });

const terminate = () => {
  if (terminationPromise) return terminationPromise;
  terminationPromise = (async () => {
    if (process.platform === 'win32') {
      await terminateWindowsTree();
      return;
    }
    if (!signalGroup('SIGTERM')) return;
    if (await waitForGroupExit()) return;
    signalGroup('SIGKILL');
  })();
  return terminationPromise;
};

const exit = (code, outcome) => {
  if (finished) return;
  finished = true;
  clearTimeout(timeoutHandle);
  clearInterval(pollHandle);
  removeInput();
  sendStatus('outcome:' + outcome);
  process.exit(code);
};

const handleTerminationSignal = () => {
  terminationExitCode ??= signalExitCode;
  void terminate().then(() => exit(terminationExitCode, 'terminated'));
};

for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']) {
  process.on(signal, handleTerminationSignal);
}

let inputFd;
try {
  inputFd = openSync(inputPath, 'r');
  const hookEnv = { ...process.env };
  if (originalNodeOptions === null) {
    delete hookEnv.NODE_OPTIONS;
  } else {
    hookEnv.NODE_OPTIONS = originalNodeOptions;
  }
  hook = spawn(executable, args, {
    cwd: process.cwd(),
    env: hookEnv,
    stdio: [inputFd, 'ignore', 'ignore'],
    shell: false,
    detached: process.platform !== 'win32',
  });
  sendStatus('pid:' + hook.pid);
  closeSync(inputFd);
  inputFd = undefined;
  removeInput();
} catch {
  if (inputFd !== undefined) {
    try {
      closeSync(inputFd);
    } catch {}
  }
  removeInput();
  exit(1, 'failed');
}

process.on('exit', () => {
  if (!finished && groupAlive()) signalGroup('SIGKILL');
});

hook.on('error', () => {
  void terminate().then(() => exit(1, 'failed'));
});
hook.on('close', (code) => {
  rootClosed = true;
  rootExitCode = code ?? 1;
});

pollHandle = setInterval(() => {
  if (terminationExitCode === undefined && rootClosed && !groupAlive()) {
    exit(rootExitCode, 'completed');
  }
}, pollInterval);

timeoutHandle = setTimeout(() => {
  terminationExitCode = timeoutExitCode;
  void terminate().then(() => exit(terminationExitCode, 'timed_out'));
}, timeout);
`;

const activePosixHookProcesses = new Set<ChildProcess>();
let parentExitCleanupRegistered = false;

/**
 * Exit code constants for hook execution
 */
const EXIT_CODE_SUCCESS = 0;
const EXIT_CODE_NON_BLOCKING_ERROR = 1;

function isNoSuchProcessError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ESRCH';
}

function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
): 'sent' | 'gone' | 'failed' {
  try {
    process.kill(-pid, signal);
    return 'sent';
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return 'gone';
    }
    debugLogger.warn(
      `Failed to send ${signal} to hook process group ${pid}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'failed';
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(HOOK_PROCESS_GROUP_POLL_MS, remaining)),
    );
  }
  return true;
}

function killDirectChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The process already exited.
  }
}

function forceKillActivePosixHookProcesses(): void {
  for (const child of activePosixHookProcesses) {
    const pid = child.pid;
    if (!pid) {
      killDirectChild(child, 'SIGKILL');
      continue;
    }
    if (signalProcessGroup(pid, 'SIGKILL') === 'failed') {
      killDirectChild(child, 'SIGKILL');
    }
  }
}

function handleParentSignal(signal: NodeJS.Signals): void {
  forceKillActivePosixHookProcesses();
  if (
    process
      .listeners(signal)
      .some((listener) => listener !== handleParentSignal)
  ) {
    return;
  }

  process.removeListener(signal, handleParentSignal);
  process.kill(process.pid, signal);
}

function registerActivePosixHookProcess(child: ChildProcess): void {
  if (process.platform === 'win32' || !child.pid) {
    return;
  }
  activePosixHookProcesses.add(child);
  if (!parentExitCleanupRegistered) {
    process.on('exit', forceKillActivePosixHookProcesses);
    process.prependListener('SIGHUP', handleParentSignal);
    process.prependListener('SIGINT', handleParentSignal);
    process.prependListener('SIGQUIT', handleParentSignal);
    process.prependListener('SIGTERM', handleParentSignal);
    parentExitCleanupRegistered = true;
  }
}

function unregisterActivePosixHookProcess(child: ChildProcess): void {
  activePosixHookProcesses.delete(child);
  if (activePosixHookProcesses.size === 0 && parentExitCleanupRegistered) {
    process.removeListener('exit', forceKillActivePosixHookProcesses);
    process.removeListener('SIGHUP', handleParentSignal);
    process.removeListener('SIGINT', handleParentSignal);
    process.removeListener('SIGQUIT', handleParentSignal);
    process.removeListener('SIGTERM', handleParentSignal);
    parentExitCleanupRegistered = false;
  }
}

async function terminatePosixProcessGroup(
  pid: number,
  graceMs = HOOK_TERMINATE_GRACE_MS,
  signalFallback?: (signal: NodeJS.Signals) => void,
): Promise<void> {
  const termResult = signalProcessGroup(pid, 'SIGTERM');
  if (termResult === 'gone') {
    return;
  }
  if (termResult === 'failed') {
    signalFallback?.('SIGTERM');
  }

  if (await waitForProcessGroupExit(pid, graceMs)) {
    return;
  }

  debugLogger.debug(
    `Hook process group ${pid} did not exit within ${graceMs}ms after SIGTERM; escalating to SIGKILL`,
  );
  const killResult = signalProcessGroup(pid, 'SIGKILL');
  if (killResult === 'failed') {
    signalFallback?.('SIGKILL');
  }
}

async function terminatePosixHookProcessTree(
  child: ChildProcess,
  graceMs = HOOK_TERMINATE_GRACE_MS,
): Promise<void> {
  // executeCommandHook makes child.pid the process-group leader on POSIX.
  const pid = child.pid;
  if (!pid) {
    killDirectChild(child, 'SIGKILL');
    return;
  }

  await terminatePosixProcessGroup(pid, graceMs, (signal) =>
    killDirectChild(child, signal),
  );
}

async function terminateWindowsHookProcessTree(
  child: ChildProcess,
): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    killDirectChild(child, 'SIGKILL');
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      execFile(
        WINDOWS_TASKKILL,
        ['/f', '/t', '/pid', pid.toString()],
        {
          windowsHide: true,
          timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
        },
        (error) => {
          if (error) {
            debugLogger.warn(
              `taskkill failed for hook process tree ${pid}: ${error.message}`,
            );
            killDirectChild(child, 'SIGKILL');
          }
          resolve();
        },
      );
    } catch (error) {
      debugLogger.warn(
        `taskkill threw for hook process tree ${pid}: ${error instanceof Error ? error.message : String(error)}`,
      );
      killDirectChild(child, 'SIGKILL');
      resolve();
    }
  });
}

async function terminateHookProcessTree(
  child: ChildProcess,
  graceMs = HOOK_TERMINATE_GRACE_MS,
): Promise<void> {
  if (process.platform === 'win32') {
    await terminateWindowsHookProcessTree(child);
    return;
  }
  await terminatePosixHookProcessTree(child, graceMs);
}

async function terminateSurvivingHookProcessGroup(
  pid: number,
  graceMs = HOOK_TERMINATE_GRACE_MS,
): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }

  await terminatePosixProcessGroup(pid, graceMs, (signal) => {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  });
}

function createSurvivingHookInputFile(input: HookInput): string {
  const path = join(
    tmpdir(),
    `qwen-hook-input-${process.pid}-${randomUUID()}.json`,
  );
  writeFileSync(path, JSON.stringify(input), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return path;
}

/**
 * Hook runner that executes command, HTTP, function, and prompt hooks
 */
export class HookRunner {
  private readonly httpRunner: HttpHookRunner;
  private readonly functionRunner: FunctionHookRunner;
  private readonly promptRunner: PromptHookRunner | null;
  private readonly asyncRegistry: AsyncHookRegistry;

  constructor(allowedHttpUrls?: string[], config?: Config) {
    this.httpRunner = new HttpHookRunner(
      allowedHttpUrls,
      config?.getAllowPrivateNetworkHooks(),
    );
    this.functionRunner = new FunctionHookRunner();
    this.promptRunner = config ? new PromptHookRunner(config) : null;
    this.asyncRegistry = new AsyncHookRegistry();
  }

  /**
   * Get the async hook registry
   */
  getAsyncRegistry(): AsyncHookRegistry {
    return this.asyncRegistry;
  }

  /**
   * Update allowed HTTP URLs
   */
  updateAllowedHttpUrls(allowedUrls: string[]): void {
    this.httpRunner.updateAllowedUrls(allowedUrls);
  }

  /**
   * Execute a single hook
   * @param hookConfig Hook configuration
   * @param eventName Event name
   * @param input Hook input
   * @param contextOrSignal Optional context (for function hooks) or AbortSignal
   */
  async executeHook(
    hookConfig: HookConfig,
    eventName: HookEventName,
    input: HookInput,
    contextOrSignal?: FunctionHookContext | AbortSignal,
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();

    // Extract signal from context or use directly
    const signal =
      contextOrSignal && 'aborted' in contextOrSignal
        ? contextOrSignal
        : contextOrSignal?.signal;

    // Check if already aborted before starting
    if (signal?.aborted) {
      const hookId = this.getHookId(hookConfig);
      return {
        hookConfig,
        eventName,
        success: false,
        outcome: 'cancelled',
        error: new Error(`Hook execution cancelled (aborted): ${hookId}`),
        duration: 0,
      };
    }

    try {
      // Check if this is an async command hook
      if (this.isAsyncHook(hookConfig)) {
        return this.executeAsyncHook(
          hookConfig as CommandHookConfig,
          eventName,
          input,
          signal,
        );
      }

      // Route to appropriate runner based on hook type
      switch (hookConfig.type) {
        case HookType.Command:
          return await this.executeCommandHook(
            hookConfig,
            eventName,
            input,
            startTime,
            signal,
          );
        case HookType.Http:
          return await this.httpRunner.execute(
            hookConfig,
            eventName,
            input,
            signal,
          );
        case HookType.Function: {
          // Function hooks accept context, not just signal
          const functionContext =
            contextOrSignal && !('aborted' in contextOrSignal)
              ? contextOrSignal
              : { signal };
          return await this.functionRunner.execute(
            hookConfig,
            eventName,
            input,
            functionContext,
          );
        }
        case HookType.Prompt: {
          // Prompt hooks require Config for LLM access
          if (!this.promptRunner) {
            throw new Error(
              'Prompt hook requires Config to be provided to HookRunner',
            );
          }
          return await this.promptRunner.execute(
            hookConfig as PromptHookConfig,
            eventName,
            input,
            signal,
          );
        }
        default:
          throw new Error(
            `Unknown hook type: ${(hookConfig as HookConfig).type}`,
          );
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const hookId = this.getHookId(hookConfig);
      const errorMessage = `Hook execution failed for event '${eventName}' (hook: ${hookId}): ${error}`;
      debugLogger.warn(`Hook execution error (non-fatal): ${errorMessage}`);

      return {
        hookConfig,
        eventName,
        success: false,
        error: error instanceof Error ? error : new Error(errorMessage),
        duration,
      };
    }
  }

  /**
   * Check if a hook should be executed asynchronously
   */
  private isAsyncHook(hookConfig: HookConfig): boolean {
    return hookConfig.type === HookType.Command && hookConfig.async === true;
  }

  /**
   * Get a unique identifier for a hook
   */
  private getHookId(hookConfig: HookConfig): string {
    if (hookConfig.name) {
      return hookConfig.name;
    }
    switch (hookConfig.type) {
      case HookType.Command:
        return hookConfig.command || 'unknown-command';
      case HookType.Http:
        return hookConfig.url || 'unknown-url';
      case HookType.Function:
        return hookConfig.id || 'unknown-function';
      case HookType.Prompt:
        return 'prompt-hook';
      default:
        return 'unknown';
    }
  }

  /**
   * Get shell configuration for a hook, respecting hookConfig.shell override
   */
  private getShellConfigForHook(
    hookConfig: CommandHookConfig,
  ): ShellConfiguration {
    const globalConfig = getShellConfiguration();

    // If hook specifies a shell, use it
    if (hookConfig.shell) {
      const shellType: ShellType =
        hookConfig.shell === 'powershell' ? 'powershell' : 'bash';

      // Return configuration for the specified shell type
      if (shellType === 'powershell') {
        return {
          shell: 'powershell',
          executable: 'powershell',
          argsPrefix: ['-Command'],
        };
      }

      // For bash, use global config's executable path or fallback
      return {
        shell: 'bash',
        executable:
          globalConfig.shell === 'bash' ? globalConfig.executable : 'bash',
        argsPrefix: ['-c'],
      };
    }

    // Use global configuration
    return globalConfig;
  }

  /**
   * Execute a command hook asynchronously (non-blocking)
   */
  private async executeAsyncHook(
    hookConfig: CommandHookConfig,
    eventName: HookEventName,
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    const hookId = generateHookId();
    const hookName = hookConfig.name || hookConfig.command || 'async-hook';

    // Check concurrency limit before registering
    if (!this.asyncRegistry.canAcceptMore()) {
      debugLogger.warn(
        `Async hook rejected due to concurrency limit: ${hookName}`,
      );
      return {
        hookConfig,
        eventName,
        success: false,
        duration: 0,
        isAsync: true,
        error: new Error(
          'Async hook rejected: too many concurrent async hooks running',
        ),
        output: { continue: true }, // Non-blocking, continue execution
      };
    }

    // Register in async registry
    const registeredId = this.asyncRegistry.register({
      hookId,
      hookName,
      hookEvent: eventName,
      sessionId: input.session_id,
      startTime: Date.now(),
      timeout: hookConfig.timeout || DEFAULT_HOOK_TIMEOUT,
      stdout: '',
      stderr: '',
    });

    // Double-check registration succeeded (race condition protection)
    if (!registeredId) {
      debugLogger.warn(
        `Async hook registration failed due to concurrency limit: ${hookName}`,
      );
      return {
        hookConfig,
        eventName,
        success: false,
        duration: 0,
        isAsync: true,
        error: new Error(
          'Async hook rejected: too many concurrent async hooks running',
        ),
        output: { continue: true },
      };
    }

    // Execute in background with proper error handling
    this.executeCommandHookInBackground(
      hookConfig,
      eventName,
      input,
      hookId,
      signal,
    ).catch((error) => {
      // This catch handles any unexpected errors that escape the try-catch in executeCommandHookInBackground
      debugLogger.error(
        `Unexpected error in async hook background execution: ${hookId} (${hookName}): ${error instanceof Error ? error.message : String(error)}`,
      );
      // Ensure the hook is marked as failed in the registry
      try {
        this.asyncRegistry.fail(
          hookId,
          error instanceof Error
            ? error
            : new Error(`Unexpected error: ${String(error)}`),
        );
      } catch (registryError) {
        // Registry operation failed, log but don't throw
        debugLogger.error(
          `Failed to update async registry for hook ${hookId}: ${registryError}`,
        );
      }
    });

    // Return immediately with success
    debugLogger.debug(`Started async hook: ${hookId} (${hookName})`);
    return {
      hookConfig,
      eventName,
      success: true,
      duration: 0,
      isAsync: true,
      output: { continue: true },
    };
  }

  /**
   * Execute a command hook in the background
   */
  private async executeCommandHookInBackground(
    hookConfig: CommandHookConfig,
    eventName: HookEventName,
    input: HookInput,
    hookId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const hookName = hookConfig.name || hookConfig.command || 'async-hook';

    try {
      debugLogger.debug(`Executing async hook in background: ${hookId}`);

      const result = await this.executeCommandHook(
        hookConfig,
        eventName,
        input,
        Date.now(),
        signal,
      );

      // Update registry with result
      if (result.success) {
        this.asyncRegistry.updateOutput(hookId, result.stdout, result.stderr);
        this.asyncRegistry.complete(hookId, result.output);
        debugLogger.debug(
          `Async hook completed successfully: ${hookId} (${hookName})`,
        );
      } else {
        const error = result.error || new Error('Unknown error');
        this.asyncRegistry.fail(hookId, error);
        debugLogger.warn(
          `Async hook failed: ${hookId} (${hookName}): ${error.message}`,
        );
      }
    } catch (error) {
      const errorObj =
        error instanceof Error ? error : new Error(String(error));
      this.asyncRegistry.fail(hookId, errorObj);
      debugLogger.error(
        `Async hook threw exception: ${hookId} (${hookName}): ${errorObj.message}`,
      );
      // Re-throw to be caught by the .catch() in executeAsyncHook
      throw error;
    }
  }

  /**
   * Execute multiple hooks in parallel
   * @param context Optional function hook context (messages, toolUseID)
   */
  async executeHooksParallel(
    hookConfigs: HookConfig[],
    eventName: HookEventName,
    input: HookInput,
    onHookStart?: (config: HookConfig, index: number) => void,
    onHookEnd?: (config: HookConfig, result: HookExecutionResult) => void,
    signal?: AbortSignal,
    context?: FunctionHookContext,
  ): Promise<HookExecutionResult[]> {
    const promises = hookConfigs.map(async (config, index) => {
      onHookStart?.(config, index);
      const result = await this.executeHook(config, eventName, input, {
        ...context,
        signal,
      });
      onHookEnd?.(config, result);
      return result;
    });

    return Promise.all(promises);
  }

  /**
   * Execute multiple hooks sequentially
   * @param context Optional function hook context (messages, toolUseID)
   */
  async executeHooksSequential(
    hookConfigs: HookConfig[],
    eventName: HookEventName,
    input: HookInput,
    onHookStart?: (config: HookConfig, index: number) => void,
    onHookEnd?: (config: HookConfig, result: HookExecutionResult) => void,
    signal?: AbortSignal,
    context?: FunctionHookContext,
  ): Promise<HookExecutionResult[]> {
    const results: HookExecutionResult[] = [];
    let currentInput = input;

    for (let i = 0; i < hookConfigs.length; i++) {
      // Check if aborted before each hook
      if (signal?.aborted) {
        break;
      }
      const config = hookConfigs[i];
      onHookStart?.(config, i);
      const result = await this.executeHook(config, eventName, currentInput, {
        ...context,
        signal,
      });
      onHookEnd?.(config, result);
      results.push(result);

      // If the hook succeeded and has output, use it to modify the input for the next hook
      if (result.success && result.output) {
        currentInput = this.applyHookOutputToInput(
          currentInput,
          result.output,
          eventName,
        );
      }
    }

    return results;
  }

  /**
   * Apply hook output to modify input for the next hook in sequential execution
   */
  private applyHookOutputToInput(
    originalInput: HookInput,
    hookOutput: HookOutput,
    eventName: HookEventName,
  ): HookInput {
    // Create a copy of the original input
    const modifiedInput = { ...originalInput };

    // Apply modifications based on hook output and event type
    if (hookOutput.hookSpecificOutput) {
      switch (eventName) {
        case HookEventName.UserPromptSubmit:
          {
            const additionalContext =
              hookOutput.hookSpecificOutput['additionalContext'];
            if (
              typeof additionalContext === 'string' &&
              additionalContext &&
              'prompt' in modifiedInput
            ) {
              (modifiedInput as UserPromptSubmitInput).prompt +=
                '\n\n' + additionalContext;
            }
          }
          break;

        case HookEventName.UserPromptExpansion:
          {
            const additionalContext = createHookOutput(
              eventName,
              hookOutput,
            ).getAdditionalContext();
            if (additionalContext && 'prompt' in modifiedInput) {
              (modifiedInput as UserPromptExpansionInput).prompt +=
                '\n\n' + additionalContext;
            }
          }
          break;

        case HookEventName.PreToolUse:
          if ('tool_input' in hookOutput.hookSpecificOutput) {
            const newToolInput = hookOutput.hookSpecificOutput[
              'tool_input'
            ] as Record<string, unknown>;
            if (newToolInput && 'tool_input' in modifiedInput) {
              (modifiedInput as PreToolUseInput).tool_input = {
                ...(modifiedInput as PreToolUseInput).tool_input,
                ...newToolInput,
              };
            }
          }
          break;

        default:
          // For other events, no special input modification is needed
          break;
      }
    }

    return modifiedInput;
  }

  /**
   * Execute a command hook
   * @param hookConfig Hook configuration
   * @param eventName Event name
   * @param input Hook input
   * @param startTime Start time for duration calculation
   * @param signal Optional AbortSignal to cancel hook execution
   */
  private async executeCommandHook(
    hookConfig: CommandHookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    const timeout = hookConfig.timeout ?? DEFAULT_HOOK_TIMEOUT;

    return new Promise((resolve) => {
      if (!hookConfig.command) {
        const errorMessage = 'Command hook missing command';
        debugLogger.warn(
          `Hook configuration error (non-fatal): ${errorMessage}`,
        );
        resolve({
          hookConfig,
          eventName,
          success: false,
          error: new Error(errorMessage),
          duration: Date.now() - startTime,
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let terminationPromise: Promise<void> | undefined;
      let childClosed = false;
      let survivingHookPid: number | undefined;
      let survivingHookOutcome:
        | 'completed'
        | 'timed_out'
        | 'terminated'
        | 'failed'
        | undefined;
      let supervisorStatusBuffer = '';
      let resolveChildClosed: () => void;
      const childClosedPromise = new Promise<void>((resolve) => {
        resolveChildClosed = resolve;
      });
      let resolveSupervisorStarted = () => {};
      const supervisorStartedPromise = new Promise<void>((resolve) => {
        resolveSupervisorStarted = resolve;
      });

      const consumeSupervisorStatusLine = (line: string) => {
        if (line.startsWith('pid:')) {
          const pid = Number(line.slice('pid:'.length));
          if (Number.isSafeInteger(pid) && pid > 0) {
            survivingHookPid = pid;
            resolveSupervisorStarted();
          }
          return;
        }
        if (!line.startsWith('outcome:')) {
          return;
        }
        const outcome = line.slice('outcome:'.length);
        switch (outcome) {
          case 'completed':
          case 'timed_out':
          case 'terminated':
          case 'failed':
            survivingHookOutcome = outcome;
            break;
          default:
            break;
        }
      };

      const consumeSupervisorStatus = (data: Buffer) => {
        supervisorStatusBuffer += data.toString();
        let newlineIndex = supervisorStatusBuffer.indexOf('\n');
        while (newlineIndex !== -1) {
          consumeSupervisorStatusLine(
            supervisorStatusBuffer.slice(0, newlineIndex),
          );
          supervisorStatusBuffer = supervisorStatusBuffer.slice(
            newlineIndex + 1,
          );
          newlineIndex = supervisorStatusBuffer.indexOf('\n');
        }
      };

      // Use hook-specific shell configuration if specified
      const shellConfig = this.getShellConfigForHook(hookConfig);
      const command = this.expandCommand(
        hookConfig.command,
        input,
        shellConfig.shell,
      );

      const env: NodeJS.ProcessEnv = {
        // Hook commands are child processes launched on the agent's behalf,
        // so they must not inherit Qwen-internal daemon secrets.
        ...sanitizeChildEnv(process.env),
        GEMINI_PROJECT_DIR: input.cwd,
        CLAUDE_PROJECT_DIR: input.cwd, // For compatibility
        QWEN_PROJECT_DIR: input.cwd, // For Qwen Code compatibility
        ...getShellContextEnvVars(),
        ...hookConfig.env,
      };

      const survivesParentExit =
        eventName === HookEventName.MessageDisplay ||
        eventName === HookEventName.StopFailure ||
        eventName === HookEventName.SessionDelete;
      let parentIndependentInputPath: string | undefined;
      let child: ChildProcess;
      if (survivesParentExit) {
        parentIndependentInputPath = createSurvivingHookInputFile(input);
        const supervisorEnv = { ...env };
        delete supervisorEnv['NODE_OPTIONS'];
        try {
          child = spawn(
            process.execPath,
            [
              '--input-type=commonjs',
              '--eval',
              SURVIVING_HOOK_SUPERVISOR_SOURCE,
              parentIndependentInputPath,
              String(timeout),
              String(HOOK_TERMINATE_GRACE_MS),
              shellConfig.executable,
              JSON.stringify([...shellConfig.argsPrefix, command]),
              JSON.stringify(env['NODE_OPTIONS'] ?? null),
            ],
            {
              env: supervisorEnv,
              cwd: input.cwd,
              stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
              shell: false,
              detached: true,
            },
          );
          const statusStream = child.stdio?.[3] as
            | (NodeJS.ReadableStream & { unref?: () => void })
            | null
            | undefined;
          if (statusStream) {
            statusStream.on('data', consumeSupervisorStatus);
            statusStream.on('error', resolveSupervisorStarted);
            statusStream.unref?.();
          } else {
            resolveSupervisorStarted();
          }
          child.unref();
        } catch (error) {
          rmSync(parentIndependentInputPath, { force: true });
          throw error;
        }
      } else {
        resolveSupervisorStarted();
        child = spawn(
          shellConfig.executable,
          [...shellConfig.argsPrefix, command],
          {
            env,
            cwd: input.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            // Own a process group so cancellation can signal the entire tree.
            detached: process.platform !== 'win32',
          },
        );
      }
      if (!survivesParentExit) {
        registerActivePosixHookProcess(child);
      }

      let abortListenerAttached = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (parentIndependentInputPath) {
          rmSync(parentIndependentInputPath, { force: true });
          parentIndependentInputPath = undefined;
        }
        if (!survivesParentExit) {
          unregisterActivePosixHookProcess(child);
        }
        if (signal && abortListenerAttached) {
          signal.removeEventListener('abort', abortHandler);
          abortListenerAttached = false;
        }
      };

      const finish = (result: HookExecutionResult) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };

      const finishCancellation = async () => {
        try {
          await terminationPromise;
        } catch (error) {
          debugLogger.warn(
            `Unexpected hook process tree cleanup failure: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (!childClosed) {
          await new Promise<void>((resolve) => {
            const closeWaitHandle = setTimeout(
              resolve,
              HOOK_CHILD_CLOSE_WAIT_MS,
            );
            void childClosedPromise.then(() => {
              clearTimeout(closeWaitHandle);
              resolve();
            });
          });
        }

        if (!childClosed) {
          debugLogger.debug(
            `Hook process ${child.pid ?? 'unknown'} did not close within ${HOOK_CHILD_CLOSE_WAIT_MS}ms after cancellation; destroying streams`,
          );
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
        }

        const duration = Date.now() - startTime;
        finish({
          hookConfig,
          eventName,
          success: false,
          error: new Error(
            aborted
              ? 'Hook execution cancelled (aborted)'
              : `Hook timed out after ${timeout}ms`,
          ),
          stdout,
          stderr,
          duration,
        });
      };

      const startTermination = () => {
        if (!terminationPromise) {
          const childTermination = terminateHookProcessTree(
            child,
            survivesParentExit
              ? SURVIVING_HOOK_SUPERVISOR_GRACE_MS
              : HOOK_TERMINATE_GRACE_MS,
          );
          terminationPromise = survivesParentExit
            ? Promise.all([
                childTermination,
                (async () => {
                  await supervisorStartedPromise;
                  if (survivingHookPid) {
                    await terminateSurvivingHookProcessGroup(survivingHookPid);
                  }
                })(),
              ]).then(() => undefined)
            : childTermination;
          void finishCancellation();
        }
      };

      if (!survivesParentExit) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          startTermination();
        }, timeout);
      }

      // Set up abort handler
      const abortHandler = () => {
        aborted = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        startTermination();
      };

      if (signal) {
        if (signal.aborted) {
          abortHandler();
        } else {
          signal.addEventListener('abort', abortHandler, { once: true });
          abortListenerAttached = true;
        }
      }

      // Send input to stdin
      if (child.stdin) {
        child.stdin.on('error', (err: NodeJS.ErrnoException) => {
          // Ignore EPIPE errors which happen when the child process closes stdin early
          if (err.code !== 'EPIPE') {
            debugLogger.debug(`Hook stdin error: ${err}`);
          }
        });

        // Wrap write operations in try-catch to handle synchronous EPIPE errors
        // that occur when the child process exits before we finish writing
        try {
          child.stdin.write(JSON.stringify(input));
          child.stdin.end();
        } catch (err) {
          // Ignore EPIPE errors which happen when the child process closes stdin early
          if (err instanceof Error && 'code' in err && err.code !== 'EPIPE') {
            debugLogger.debug(`Hook stdin write error: ${err}`);
          }
        }
      }

      // Collect stdout
      child.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT_LENGTH) {
          const remaining = MAX_OUTPUT_LENGTH - stdout.length;
          stdout += data.slice(0, remaining).toString();
          if (data.length > remaining) {
            debugLogger.warn(
              `Hook stdout exceeded max length (${MAX_OUTPUT_LENGTH} bytes), truncating`,
            );
          }
        }
      });

      // Collect stderr
      child.stderr?.on('data', (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT_LENGTH) {
          const remaining = MAX_OUTPUT_LENGTH - stderr.length;
          stderr += data.slice(0, remaining).toString();
          if (data.length > remaining) {
            debugLogger.warn(
              `Hook stderr exceeded max length (${MAX_OUTPUT_LENGTH} bytes), truncating`,
            );
          }
        }
      });

      // Handle process exit
      child.on('close', (exitCode) => {
        childClosed = true;
        resolveChildClosed();
        resolveSupervisorStarted();
        if (aborted || timedOut) {
          return;
        }
        const duration = Date.now() - startTime;

        if (survivesParentExit && survivingHookOutcome === 'timed_out') {
          timedOut = true;
          finish({
            hookConfig,
            eventName,
            success: false,
            error: new Error(`Hook timed out after ${timeout}ms`),
            stdout,
            stderr,
            duration,
          });
          return;
        }

        // Parse output
        // Exit code 2 is a blocking error - ignore stdout, use stderr only
        let output: HookOutput | undefined;
        const isBlockingError = exitCode === 2;

        // For exit code 2, only use stderr (ignore stdout)
        const textToParse = isBlockingError
          ? stderr.trim()
          : stdout.trim() || stderr.trim();

        if (textToParse) {
          // Try parsing as JSON to preserve structured output like
          // hookSpecificOutput.additionalContext (applies to both exit 0 and exit 2)
          try {
            let parsed = JSON.parse(textToParse);
            if (typeof parsed === 'string') {
              parsed = JSON.parse(parsed);
            }
            if (parsed && typeof parsed === 'object') {
              output = parsed as HookOutput;
            }
          } catch {
            // Not JSON, convert plain text to structured output
            output = this.convertPlainTextToHookOutput(
              textToParse,
              isBlockingError
                ? exitCode
                : exitCode === EXIT_CODE_SUCCESS
                  ? EXIT_CODE_SUCCESS
                  : EXIT_CODE_NON_BLOCKING_ERROR,
            );
          }
        }

        const killedBySignal = exitCode === null;
        finish({
          hookConfig,
          eventName,
          success: exitCode === EXIT_CODE_SUCCESS,
          output,
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
          duration,
          ...(killedBySignal && {
            error: new Error('Hook killed by signal'),
          }),
        });
      });

      // Handle process errors
      child.on('error', (error) => {
        if (aborted || timedOut) {
          return;
        }
        const duration = Date.now() - startTime;

        finish({
          hookConfig,
          eventName,
          success: false,
          error,
          stdout,
          stderr,
          duration,
        });
      });
    });
  }

  /**
   * Expand command with environment variables and input context
   */
  private expandCommand(
    command: string,
    input: HookInput,
    shellType: ShellType,
  ): string {
    debugLogger.debug(`Expanding hook command: ${command} (cwd: ${input.cwd})`);
    const escapedCwd = escapeShellArg(input.cwd, shellType);
    return command
      .replace(/\$GEMINI_PROJECT_DIR/g, () => escapedCwd)
      .replace(/\$CLAUDE_PROJECT_DIR/g, () => escapedCwd); // For compatibility
  }

  /**
   * Convert plain text output to structured HookOutput
   */
  private convertPlainTextToHookOutput(
    text: string,
    exitCode: number,
  ): HookOutput {
    if (exitCode === EXIT_CODE_SUCCESS) {
      // Success - treat as system message or additional context
      return {
        decision: 'allow',
        reason: 'Hook executed successfully',
        systemMessage: text,
      };
    } else if (exitCode === EXIT_CODE_NON_BLOCKING_ERROR) {
      // Non-blocking error (EXIT_CODE_NON_BLOCKING_ERROR = 1)
      return {
        decision: 'allow',
        reason: `Non-blocking error: ${text}`,
        systemMessage: `Warning: ${text}`,
      };
    } else {
      // All other non-zero exit codes (including 2) are blocking
      return {
        decision: 'deny',
        reason: text,
      };
    }
  }
}
