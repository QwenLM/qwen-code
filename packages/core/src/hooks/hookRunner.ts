/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { HookEventName, HookType } from './types.js';
import type {
  HookConfig,
  CommandHookConfig,
  HttpHookConfig,
  PromptHookConfig,
  HookInput,
  HookOutput,
  HookExecutionResult,
  PreToolUseInput,
  UserPromptSubmitInput,
} from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  escapeShellArg,
  getShellConfiguration,
  type ShellType,
} from '../utils/shell-utils.js';

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
 * Hook runner that executes command hooks
 */
export class HookRunner {
  /**
   * Execute a single hook
   * @param hookConfig Hook configuration
   * @param eventName Event name
   * @param input Hook input
   * @param signal Optional AbortSignal to cancel hook execution
   */
  async executeHook(
    hookConfig: HookConfig,
    eventName: HookEventName,
    input: HookInput,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const hookId =
      hookConfig.name ||
      ('command' in hookConfig ? hookConfig.command : hookConfig.type) ||
      'unknown';

    // Check if already aborted before starting
    if (signal?.aborted) {
      return {
        hookConfig,
        eventName,
        success: false,
        error: new Error(`Hook execution cancelled (aborted): ${hookId}`),
        duration: 0,
      };
    }

    // Async hooks: fire and forget — spawn without awaiting, return success immediately
    if (hookConfig.async) {
      this.executeHookByType(
        hookConfig,
        eventName,
        input,
        startTime,
        signal,
      ).catch((err) => {
        debugLogger.warn(`Async hook "${hookId}" failed (non-fatal): ${err}`);
      });
      return {
        hookConfig,
        eventName,
        success: true,
        duration: 0,
      };
    }

    try {
      return await this.executeHookByType(
        hookConfig,
        eventName,
        input,
        startTime,
        signal,
      );
    } catch (error) {
      const duration = Date.now() - startTime;
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
   * Execute multiple hooks in parallel
   * @param signal Optional AbortSignal to cancel hook execution
   */
  async executeHooksParallel(
    hookConfigs: HookConfig[],
    eventName: HookEventName,
    input: HookInput,
    onHookStart?: (config: HookConfig, index: number) => void,
    onHookEnd?: (config: HookConfig, result: HookExecutionResult) => void,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult[]> {
    const promises = hookConfigs.map(async (config, index) => {
      onHookStart?.(config, index);
      const result = await this.executeHook(config, eventName, input, signal);
      onHookEnd?.(config, result);
      return result;
    });

    return Promise.all(promises);
  }

  /**
   * Execute multiple hooks sequentially
   * @param signal Optional AbortSignal to cancel hook execution
   */
  async executeHooksSequential(
    hookConfigs: HookConfig[],
    eventName: HookEventName,
    input: HookInput,
    onHookStart?: (config: HookConfig, index: number) => void,
    onHookEnd?: (config: HookConfig, result: HookExecutionResult) => void,
    signal?: AbortSignal,
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
      const result = await this.executeHook(
        config,
        eventName,
        currentInput,
        signal,
      );
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
   * Dispatch to the appropriate hook executor based on type.
   */
  private async executeHookByType(
    hookConfig: HookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    if (hookConfig.type === HookType.Http) {
      return this.executeHttpHook(
        hookConfig,
        eventName,
        input,
        startTime,
        signal,
      );
    }
    if (hookConfig.type === HookType.Prompt) {
      return this.executePromptHook(hookConfig, eventName, input, startTime);
    }
    // Default: command hooks (including unknown types as fallback)
    return this.executeCommandHook(
      hookConfig as CommandHookConfig,
      eventName,
      input,
      startTime,
      signal,
    );
  }

  /**
   * Execute an HTTP webhook hook — POST event JSON to the configured URL.
   */
  private async executeHttpHook(
    hookConfig: HttpHookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    const timeout = hookConfig.timeout ?? DEFAULT_HOOK_TIMEOUT;
    const allowedVars = new Set(hookConfig.allowedEnvVars ?? []);

    // Interpolate env vars in URL and headers
    const interpolate = (s: string): string =>
      s.replace(/\$\{?(\w+)\}?/g, (_match, varName) =>
        allowedVars.has(varName) ? (process.env[varName] ?? '') : '',
      );

    const url = interpolate(hookConfig.url);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (hookConfig.headers) {
      for (const [key, value] of Object.entries(hookConfig.headers)) {
        headers[key] = interpolate(value);
      }
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      if (signal) {
        signal.addEventListener('abort', () => controller.abort(), {
          once: true,
        });
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const duration = Date.now() - startTime;
      const body = await response.text();

      let output: HookOutput | undefined;
      try {
        output = JSON.parse(body) as HookOutput;
      } catch {
        // Non-JSON response — treat as plain text
      }

      const success = response.ok;
      return {
        hookConfig,
        eventName,
        success,
        output,
        stdout: body,
        exitCode: success ? 0 : response.status,
        duration,
      };
    } catch (error) {
      return {
        hookConfig,
        eventName,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute a prompt hook — call LLM with event JSON injected via $ARGUMENTS.
   * Returns structured JSON from the model response.
   */
  private async executePromptHook(
    hookConfig: PromptHookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
  ): Promise<HookExecutionResult> {
    const argsJson = JSON.stringify(input);
    const expandedPrompt = hookConfig.prompt.replace(/\$ARGUMENTS/g, argsJson);

    // Prompt hooks are lightweight — we log the prompt and return a placeholder.
    // Full LLM integration requires a ContentGenerator reference which is
    // wired at the HookSystem level. For now, log and return the prompt
    // as stdout so the aggregator can process any JSON in the prompt response.
    debugLogger.info(
      `Prompt hook for ${eventName} (model: ${hookConfig.model ?? 'haiku'}): ${expandedPrompt.slice(0, 200)}...`,
    );

    // TODO: Wire ContentGenerator for actual LLM calls.
    // For now, prompt hooks are a no-op that returns success.
    return {
      hookConfig,
      eventName,
      success: true,
      stdout: '',
      exitCode: 0,
      duration: Date.now() - startTime,
    };
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

      const shellConfig = getShellConfiguration();
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
