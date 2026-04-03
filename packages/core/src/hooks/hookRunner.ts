/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { HookEventName, HookType } from './types.js';
import type {
  HookConfig,
  HookInput,
  HookOutput,
  HookExecutionResult,
  PreToolUseInput,
  UserPromptSubmitInput,
  CommandHookConfig,
  FunctionHookContext,
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
import { AsyncHookRegistry, generateHookId } from './asyncHookRegistry.js';

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

/**
 * Exit code constants for hook execution
 */
const EXIT_CODE_SUCCESS = 0;
const EXIT_CODE_NON_BLOCKING_ERROR = 1;

/**
 * Hook runner that executes command, HTTP, and function hooks
 */
export class HookRunner {
  private readonly httpRunner: HttpHookRunner;
  private readonly functionRunner: FunctionHookRunner;
  private readonly asyncRegistry: AsyncHookRegistry;

  constructor(allowedHttpUrls?: string[]) {
    this.httpRunner = new HttpHookRunner(allowedHttpUrls);
    this.functionRunner = new FunctionHookRunner();
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
          if ('additionalContext' in hookOutput.hookSpecificOutput) {
            // For UserPromptSubmit, we could modify the prompt with additional context
            const additionalContext =
              hookOutput.hookSpecificOutput['additionalContext'];
            if (
              typeof additionalContext === 'string' &&
              'prompt' in modifiedInput
            ) {
              (modifiedInput as UserPromptSubmitInput).prompt +=
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

      // Use hook-specific shell configuration if specified
      const shellConfig = this.getShellConfigForHook(hookConfig);
      const command = this.expandCommand(
        hookConfig.command,
        input,
        shellConfig.shell,
      );

      const env = {
        ...process.env,
        GEMINI_PROJECT_DIR: input.cwd,
        CLAUDE_PROJECT_DIR: input.cwd, // For compatibility
        QWEN_PROJECT_DIR: input.cwd, // For Qwen Code compatibility
        ...hookConfig.env,
      };

      const child = spawn(
        shellConfig.executable,
        [...shellConfig.argsPrefix, command],
        {
          env,
          cwd: input.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        },
      );

      // Helper to kill child process
      const killChild = () => {
        if (!child.killed) {
          child.kill('SIGTERM');
          // Force kill after 2 seconds
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 2000);
        }
      };

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeout);

      // Set up abort handler
      const abortHandler = () => {
        aborted = true;
        clearTimeout(timeoutHandle);
        killChild();
      };

      if (signal) {
        signal.addEventListener('abort', abortHandler);
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
        clearTimeout(timeoutHandle);
        // Clean up abort listener
        if (signal) {
          signal.removeEventListener('abort', abortHandler);
        }
        const duration = Date.now() - startTime;

        if (aborted) {
          resolve({
            hookConfig,
            eventName,
            success: false,
            error: new Error('Hook execution cancelled (aborted)'),
            stdout,
            stderr,
            duration,
          });
          return;
        }

        if (timedOut) {
          resolve({
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
          // Only parse JSON on exit 0
          if (!isBlockingError) {
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
                exitCode || EXIT_CODE_SUCCESS,
              );
            }
          } else {
            // Exit code 2: blocking error, use stderr as reason
            output = this.convertPlainTextToHookOutput(textToParse, exitCode);
          }
        }

        resolve({
          hookConfig,
          eventName,
          success: exitCode === EXIT_CODE_SUCCESS,
          output,
          stdout,
          stderr,
          exitCode: exitCode || EXIT_CODE_SUCCESS,
          duration,
        });
      });

      // Handle process errors
      child.on('error', (error) => {
        clearTimeout(timeoutHandle);
        const duration = Date.now() - startTime;

        resolve({
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
