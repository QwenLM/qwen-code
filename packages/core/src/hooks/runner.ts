/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'child_process';
import { createDebugLogger } from '../utils/debugLogger.js';
import type {
  HookConfig,
  HookInput,
  HookOutput,
  HookExecutionResult,
  HookEventName,
} from './types.js';
import { createHookOutput, HookType } from './types.js';

const debugLogger = createDebugLogger('HOOK_RUNNER');

/**
 * Hook runner configuration
 */
export interface HookRunnerConfig {
  /** Default timeout for hook execution (ms) */
  defaultTimeout?: number;
  /** Working directory for hook execution */
  cwd?: string;
  /** Environment variables to pass to hooks */
  env?: Record<string, string>;
}

/**
 * Command hook result
 */
export interface CommandHookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * HookRunner executes hook configurations (commands or JS plugins)
 */
export class HookRunner {
  constructor(private config: HookRunnerConfig = {}) {}

  /**
   * Execute a hook configuration
   */
  async run(
    hookConfig: HookConfig,
    input: HookInput,
    eventName: HookEventName,
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();
    const hookName =
      hookConfig.type === HookType.Command
        ? hookConfig.command
        : 'unknown-hook';

    debugLogger.debug(`Executing hook: ${hookName} for event: ${eventName}`);

    try {
      if (hookConfig.type === HookType.Command) {
        const result = await this.runCommandHook(hookConfig, input);
        const duration = Date.now() - startTime;

        // Parse stdout as JSON if possible
        const output = this.parseHookOutput(result.stdout, eventName);

        // Determine success based on exit code
        // 0 = success, 2 = handled error (graceful), other = failure
        const success = result.exitCode === 0 || result.exitCode === 2;

        if (!success) {
          debugLogger.warn(
            `Hook ${hookName} failed with exit code: ${result.exitCode}`,
          );
        } else {
          debugLogger.debug(
            `Hook ${hookName} executed successfully in ${duration}ms`,
          );
        }

        return {
          hookConfig,
          eventName,
          success,
          output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration,
        };
      }

      // Future: Support JS plugin hooks
      const errorMessage = `Unsupported hook type: ${(hookConfig as { type: string }).type}`;
      debugLogger.error(errorMessage);
      throw new Error(errorMessage);
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      debugLogger.error(`Hook ${hookName} execution error:`, error);

      return {
        hookConfig,
        eventName,
        success: false,
        output: createHookOutput(eventName, {}),
        stdout: '',
        stderr: errorMessage,
        exitCode: 1,
        duration,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Execute a command hook
   */
  private async runCommandHook(
    hookConfig: Extract<HookConfig, { type: typeof HookType.Command }>,
    input: HookInput,
  ): Promise<CommandHookResult> {
    const timeout = hookConfig.timeout ?? this.config.defaultTimeout ?? 30000;
    const cwd = this.config.cwd ?? process.cwd();

    debugLogger.debug(`Running command: ${hookConfig.command} in ${cwd}`);

    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      // Spawn the command with input as JSON in environment
      const env = {
        ...process.env,
        ...this.config.env,
        HOOK_INPUT: JSON.stringify(input),
        HOOK_EVENT_NAME: input.hook_event_name,
        HOOK_SESSION_ID: input.session_id,
        HOOK_CWD: input.cwd,
      };

      const child = spawn('sh', ['-c', hookConfig.command], {
        cwd,
        env,
        timeout,
      });

      child.stdout?.on('data', (data: Buffer) => {
        stdout.push(data);
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr.push(data);
      });

      child.on('error', (error) => {
        debugLogger.error(
          `Failed to spawn hook command: ${hookConfig.command}`,
          error,
        );
        reject(error);
      });

      child.on('close', (exitCode) => {
        const finalExitCode = exitCode ?? 0;
        debugLogger.debug(`Command exited with code: ${finalExitCode}`);
        resolve({
          stdout: Buffer.concat(stdout).toString('utf-8'),
          stderr: Buffer.concat(stderr).toString('utf-8'),
          exitCode: finalExitCode,
        });
      });

      // Write input to stdin if the command expects it
      if (child.stdin) {
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
      }
    });
  }

  /**
   * Parse hook output from stdout
   */
  private parseHookOutput(
    stdout: string,
    eventName: HookEventName,
  ): HookOutput {
    try {
      // Try to parse as JSON
      const trimmed = stdout.trim();
      if (trimmed) {
        const parsed = JSON.parse(trimmed);
        return createHookOutput(eventName, parsed);
      }
    } catch {
      // Not valid JSON, treat as plain text
    }

    // Return default output with stdout as system message if non-empty
    return createHookOutput(eventName, {
      systemMessage: stdout.trim() || undefined,
    });
  }

  /**
   * Update runner configuration
   */
  updateConfig(config: Partial<HookRunnerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): HookRunnerConfig {
    return { ...this.config };
  }
}

/**
 * Create a new hook runner
 */
export function createHookRunner(config?: HookRunnerConfig): HookRunner {
  return new HookRunner(config);
}
