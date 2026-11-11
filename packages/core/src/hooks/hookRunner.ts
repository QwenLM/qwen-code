/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getBusinessInfoFromContext,
  getCustomContextFromContext,
  getRequestSetIdFromContext,
  snapshotCustomContext,
} from '../utils/sessionIdContext.js';

import type { ModelMessage } from '../provider/event/modelCompleteEvent.js';
import { extractJsonFromText } from '../utils/extractJson.js';
import { DEFAULT_MAX_ATTEMPTS, retryWithBackoff } from '../utils/retry.js';
import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';
import {
  applyBusinessSubTask,
  resolveBusinessSubTask,
} from '../qoder/business-info.js';
import { resolveBusinessIdentity } from '../core/agent-lifecycle-state.js';
import { getVersion } from '../utils/version.js';
import { spawn } from 'node:child_process';
import {
  guardDetachedProcess,
  prepareDetachedProcessGuard,
} from '../services/detachedProcessGuard.js';
import { randomUUID } from 'node:crypto';
import { stat as fsStat } from 'node:fs/promises';
import treeKill from 'tree-kill';
import { hookEvents } from './hookEvents.js';
import {
  ENV_FILE_EVENTS,
  createEnvFile,
  invalidateSessionEnvCache,
  truncateEnvFile,
} from './sessionEnvironment.js';
import {
  ConfigSource,
  HookEventName,
  HookType,
  type HookConfig,
  type CommandHookConfig,
  type RuntimeHookConfig,
  type HttpHookConfig,
  type PromptHookConfig,
  type AgentHookConfig,
  type HookInput,
  type HookOutput,
  type HookExecutionResult,
  type PreToolUseInput,
  type UserPromptSubmitInput,
  type SchemaFailureMode,
  getHookDisplayText,
} from './types.js';
import type { Config } from '../config/config.js';
import { resolveModelSelectionOverride } from '../provider/session-model.js';
import { mergeModelConfig } from '../provider/model/modelConfig.js';
import { runLogger } from '../utils/runLogger.js';
import { getErrorMessage, isCancellationError } from '../utils/errors.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { AGENT_TOOL_NAME } from '../tools/tool-names.js';
import { toError } from '../tools/abort-utils.js';
import { sanitizeEnvironment } from '../services/environmentSanitization.js';
import type { BuiltinRuntimeExecutionContext } from '../builtin-plugins/types.js';
import {
  getShellConfiguration,
  resolveUnixCommandShell,
  type ShellConfiguration,
  type ShellType,
} from '../utils/shell-utils.js';
import { unmanagedRequest } from '../utils/fetch.js';
import {
  findGitBashPath,
  normalizeWindowsBashCommand,
  prependWindowsExecutableDirectoryToPath,
  windowsPathToPosixPath,
} from '../utils/windowsPaths.js';
import { query } from '../core/agent-loop.js';

import { createHookAgentLoopContext } from './hookAgentLoopContext.js';
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  StructuredOutputResultHolder,
  StructuredOutputDeclarativeTool,
} from './structuredOutputTool.js';
import { isKeptByAllowList } from '../tools/tool-exposure.js';
import { buildSystemPromptForTurn } from '../prompts/build-system-prompt.js';
import { validateHookOutput } from './hookOutputSchema.js';
import { isHttpHookUrlAllowed } from './httpHookPolicy.js';
import {
  ENV_PROJECT_DIR,
  ENV_PLUGIN_ROOT,
  ENV_PLUGIN_DATA,
} from '../config/brand.js';
import { getSensitiveEnvironmentVariables } from '../config/sensitiveEnvironment.js';



import { getPluginDataDir } from '../plugins/pluginDirectories.js';
import { isSDKMode } from '../utils/headless.js';

import {
  resolveShellPrefix,
  wrapPosixShellCommand,
} from '../utils/shell/shellPrefix.js';

/**
 * Default timeout for hook execution (600 seconds)
 */
const DEFAULT_HOOK_TIMEOUT = 600;

/**
 * Default timeout for HTTP hook requests (600 seconds)
 */
const DEFAULT_HTTP_HOOK_TIMEOUT = 600;

/**
 * Default timeout for prompt hook LLM calls (30 seconds)
 */
const DEFAULT_PROMPT_HOOK_TIMEOUT = 30;

const PROMPT_HOOK_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['ok'],
};

function readPromptHookDecision(
  message: ModelMessage,
): { ok: boolean; reason?: string } | undefined {
  if (!message.stopReason) {
    throw new Error('Model stream ended without a stop reason.');
  }
  const text = message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  try {
    const result = JSON.parse(extractJsonFromText(text));
    if (
      typeof result?.ok === 'boolean' &&
      (result.reason === undefined || typeof result.reason === 'string')
    ) {
      return result;
    }
  } catch {
    // Invalid JSON is retried like other responses that fail the schema.
  }
  return undefined;
}

/**
 * Default timeout for agent hook execution in seconds.
 */
const DEFAULT_AGENT_HOOK_TIMEOUT_SECONDS = 60;

/**
 * Resolve the timeout that actually governs a hook execution, in seconds.
 * Falls back to the per-type default when the hook config omits `timeout`.
 */
export function resolveHookTimeoutSeconds(config: HookConfig): number {
  return config.type === HookType.Http
    ? (config.timeout ?? DEFAULT_HTTP_HOOK_TIMEOUT)
    : config.type === HookType.Prompt
      ? (config.timeout ?? DEFAULT_PROMPT_HOOK_TIMEOUT)
      : config.type === HookType.Agent
        ? (config.timeout ?? DEFAULT_AGENT_HOOK_TIMEOUT_SECONDS)
        : (config.timeout ?? DEFAULT_HOOK_TIMEOUT); // command / runtime
}

/**
 * Default max turns for agent hooks.
 */
const DEFAULT_AGENT_HOOK_MAX_TURNS = 50;

/**
 * Slack added on top of a hook's inner timeout to compute the outer
 * defensive timeout. The inner timeout is the primary boundary; the outer
 * one only fires if the inner settle path is somehow bypassed.
 */
const OUTER_HOOK_TIMEOUT_SLACK_MS = 5_000;

/**
 * Grace period after an abort's SIGTERM before escalating to SIGKILL.
 */
const ABORT_GRACE_KILL_MS = 2_000;

/**
 * Terminate a command hook's process tree on POSIX WITHOUT forking a helper
 * process. Unlike `tree-kill` (which spawns `pgrep -P <pid>` per tree node and,
 * on a saturated process table, fails with EAGAIN exactly when cleanup is most
 * needed), this signals the hook's detached process group directly. The hook is
 * spawned with `detached: !win32`, so `child.pid` is a group leader and
 * `-child.pid` reaches every descendant (incl. reparented grandchildren).
 *
 * Safety: `process.kill(-0, …)` targets the caller's OWN process group and
 * `process.kill(-1, …)` every process the user owns, so refuse anything that is
 * not a real child pid (mirrors killProcessGroup in utils/process-utils.ts).
 * Never throws; `ESRCH` (process already gone) is silent, other errors are
 * debug-logged.
 */
function killHookProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
      runLogger.debug(`killHookProcessGroup ${signal} failed: ${err}`);
    }
  }
}

/**
 * Describe why an in-flight hook was aborted by its parent signal.
 *
 * A bare abort (no reason) or a user-cancellation reason keeps the historical
 * "cancelled by user" wording so genuine Esc/permission cancellations stay
 * silent. Any other reason is a real system abort — e.g. the headless output
 * frame guard tripping on an oversized payload — and must surface its actual
 * cause instead of being misreported as a user cancellation.
 */
function describeHookAbortReason(reason: unknown): string {
  if (reason === undefined || isCancellationError(reason)) {
    return 'Hook cancelled by user';
  }
  const detail = getErrorMessage(reason).trim();
  return detail ? `Hook aborted: ${detail}` : 'Hook cancelled by user';
}

/**
 * Wrap a hook execution with an outer defensive timeout and parent-abort
 * propagation. The inner `fn` is the primary settle path; this wrapper is a
 * second line of defense that guarantees the returned promise settles even if
 * `fn` never does.
 *
 * The fallback resolves the result BEFORE aborting the inner signal, so the
 * outcome classification (outer-timeout vs parent-cancel) is stable and cannot
 * be raced/overwritten by the inner abort handler.
 *
 * Never invokes onHookStart/onHookEnd — callers own those lifecycle events.
 */
function withOuterHookTimeout<T>(
  fn: (innerSignal: AbortSignal) => Promise<T>,
  outerSignal: AbortSignal | undefined,
  ms: number,
  onOuterTimeout: () => T,
  onParentAbort: (reason: unknown) => T,
): Promise<T> {
  if (outerSignal?.aborted) {
    return Promise.resolve(onParentAbort(outerSignal.reason));
  }

  const controller = new AbortController();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onParent: (() => void) | undefined;

  const fallbackPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onOuterTimeout()); // decide result first
      controller.abort(); // then abort inner to release its resources
    }, ms);
    timer.unref?.();

    onParent = () => {
      if (settled) return;
      settled = true;
      resolve(onParentAbort(outerSignal?.reason));
      controller.abort();
    };
    outerSignal?.addEventListener('abort', onParent, { once: true });
  });

  return Promise.race([fn(controller.signal), fallbackPromise]).finally(() => {
    settled = true;
    if (timer) clearTimeout(timer);
    if (onParent) outerSignal?.removeEventListener('abort', onParent);
  });
}

/**
 * Race a promise against an AbortSignal.
 * Ensures we bail out even if the callee ignores the signal.
 */
function abortablePromise<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error(timeoutMessage));
  }
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new Error(timeoutMessage)),
        {
          once: true,
        },
      );
    }),
  ]);
}

/**
 * Combine an optional external abort signal with a per-hook timeout
 * into a single AbortSignal.
 */
function combineWithTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

/**
 * Exit code constants for hook execution
 */
const EXIT_CODE_SUCCESS = 0;
export const EXIT_CODE_BLOCK = 2;

function isBuiltinHook(hookConfig: CommandHookConfig): boolean {
  return (
    hookConfig.source === ConfigSource.System &&
    hookConfig.builtinPlugin === true
  );
}

function resolveBuiltinHookEnv(
  hookConfig: CommandHookConfig,
): Record<string, string | undefined> | undefined {
  if (!isBuiltinHook(hookConfig) || typeof hookConfig.env !== 'function') {
    return undefined;
  }
  try {
    return hookConfig.env();
  } catch (error) {
    runLogger.warn(
      '[hooks] env function failed; continuing without its values:',
      error,
    );
    return undefined;
  }
}

function removeSensitiveEnv(
  env: Record<string, string | undefined>,
): void {
  const names = new Set(
    getSensitiveEnvironmentVariables().map((name) => name.toUpperCase()),
  );
  for (const key of Object.keys(env)) {
    if (names.has(key.toUpperCase())) {
      delete env[key];
    }
  }
}

function applyHookEnvOverrides(
  env: Record<string, string | undefined>,
  overrides: Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(overrides)) {
    // Remove case variants as well, so inherited Windows-style names cannot
    // retain stale values when the hook replaces or unsets a variable.
    for (const existingKey of Object.keys(env)) {
      if (existingKey.toUpperCase() === key.toUpperCase()) {
        delete env[existingKey];
      }
    }
    if (value !== undefined) env[key] = value;
  }
}

/**
 * Strips CR, LF, and NUL bytes from header values to prevent CRLF injection attacks.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
}

/**
 * Returns a path converter for hook commands/env. Under bash on Windows,
 * native paths (`C:\...`) must be converted to POSIX form (`/c/...`) so bash
 * doesn't treat backslashes as escape characters. All other shells/platforms
 * use the path as-is.
 */
function getHookPathConverter(shellType: ShellType): (p: string) => string {
  return shellType === 'bash' && process.platform === 'win32'
    ? windowsPathToPosixPath
    : (p: string) => p;
}

/**
 * Hook runner that executes command hooks
 *
 * TODO: Add `outcome` field to HookExecutionResult for command, http, and prompt hooks
 *       (currently only agent hooks set outcome). Map:
 *       - success + allow/defer → 'success'
 *       - success + deny/block → 'blocking'
 *       - error → 'non_blocking_error'
 *       - timeout/cancel → 'cancelled'
 */
export class HookRunner {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  protected async prepareEnv(projectDir: string): Promise<NodeJS.ProcessEnv> {
    return {
      ...sanitizeEnvironment(process.env, this.config.sanitizationConfig),
      [ENV_PROJECT_DIR]: projectDir,
      CLAUDE_PROJECT_DIR: projectDir,
    };
  }

  /**
   * Build a ShellConfiguration for a per-hook shell override.
   * `'bash'`: on Windows uses Git Bash; on Unix prefers bash and falls back to
   * `/bin/sh` when bash is unavailable. `'powershell'` uses pwsh (Linux/Mac) or
   * powershell.exe (Windows).
   */
  private async getShellConfigForOverride(
    shell: 'bash' | 'powershell',
  ): Promise<{
    executable: string;
    argsPrefix: string[];
    shell: ShellType;
  }> {
    if (shell === 'powershell') {
      const isWin = process.platform === 'win32';
      return {
        executable: isWin ? 'powershell.exe' : 'pwsh',
        argsPrefix: ['-NoProfile', '-NonInteractive', '-Command'],
        shell: 'powershell',
      };
    }
    // shell === 'bash'
    // On Windows, findGitBashPath() is async because it may wait for a
    // background Portable Git download instead of fatally exiting the process.
    const bashExecutable =
      process.platform === 'win32'
        ? await findGitBashPath()
        : resolveUnixCommandShell();
    return {
      executable: bashExecutable,
      argsPrefix: ['-c'],
      shell: 'bash',
    };
  }

  /**
   * Execute a single hook
   */
  async executeHook(
    hookConfig: HookConfig,
    eventName: HookEventName,
    input: HookInput,
    signal?: AbortSignal,
    hookIndex?: number,
    options?: { schemaFailureMode?: SchemaFailureMode },
  ): Promise<HookExecutionResult> {
    return this.executeHookImpl(
      hookConfig,
      eventName,
      input,
      signal,
      hookIndex ?? 0,
      options,
    );
  }

  private getHookId(hookConfig: HookConfig): string {
    return getHookDisplayText(hookConfig);
  }

  private shouldRunCompletedWriteAfterCancellation(
    hookConfig: HookConfig,
    eventName: HookEventName,
    input: HookInput,
  ): boolean {
    return (
      hookConfig.type === HookType.Runtime &&
      hookConfig.runAfterCancellation === 'completed-file-write' &&
      eventName === HookEventName.PostToolUse &&
      'file_write' in input &&
      input.file_write !== undefined
    );
  }

  private async executeHookImpl(
    hookConfig: HookConfig,
    eventName: HookEventName,
    input: HookInput,
    signal?: AbortSignal,
    hookIndex: number = 0,
    options?: { schemaFailureMode?: SchemaFailureMode },
  ): Promise<HookExecutionResult> {
    const startTime = Date.now();

    // Workspace-trust gate: in interactive mode, ALL hook sources (project /
    // user / plugin / managed) require workspace trust. Non-interactive sessions
    // (headless, --print, SDK) have implicit trust via trustedFolders auto-trust.
    if (this.config.isInteractive() && !this.config.isTrustedFolder()) {
      const errorMessage = `Security: Blocked execution of hook (${hookConfig.source}) in untrusted folder`;
      runLogger.warn(errorMessage);
      return {
        hookConfig,
        eventName,
        success: false,
        error: new Error(errorMessage),
        duration: 0,
      };
    }

    try {
      const runCompletedWrite = this.shouldRunCompletedWriteAfterCancellation(
        hookConfig,
        eventName,
        input,
      );
      // A successful file write is already externally visible. An explicitly
      // opted-in PostToolUse recorder must start even if cancellation arrived
      // between the write and hook dispatch; every other hook keeps the early bail.
      if (signal?.aborted && !runCompletedWrite) {
        return {
          hookConfig,
          eventName,
          success: false,
          error: new Error('Hook execution skipped: request already cancelled'),
          duration: Date.now() - startTime,
        };
      }
      if (signal?.aborted && runCompletedWrite) {
        runLogger.debug(
          `[Hooks] Running completed file-write hook after cancellation hook=${this.getHookId(hookConfig)}`,
        );
      }

      if (hookConfig.type === HookType.Runtime) {
        return await this.executeRuntimeHook(
          hookConfig,
          eventName,
          input,
          startTime,
          runCompletedWrite ? undefined : signal,
        );
      }

      if (hookConfig.type === HookType.Http) {
        return await this.executeHttpHook(
          hookConfig,
          eventName,
          input,
          startTime,
          signal,
        );
      }

      if (hookConfig.type === HookType.Prompt) {
        return await this.executePromptHook(
          hookConfig,
          eventName,
          input,
          startTime,
          signal,
        );
      }

      if (hookConfig.type === HookType.Agent) {
        return await this.executeAgentHook(
          hookConfig,
          eventName,
          input,
          startTime,
          signal,
        );
      }

      return await this.executeCommandHook(
        hookConfig,
        eventName,
        input,
        startTime,
        signal,
        hookIndex,
        options,
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      const hookId = this.getHookId(hookConfig);
      const errorMessage = `Hook execution failed for event '${eventName}' (hook: ${hookId}): ${error}`;
      runLogger.warn(`Hook execution error (non-fatal): ${errorMessage}`);

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
   */
  async executeHooksParallel(
    hookConfigs: HookConfig[],
    eventName: HookEventName,
    input: HookInput,
    onHookStart?: (config: HookConfig, index: number) => void,
    onHookEnd?: (
      config: HookConfig,
      result: HookExecutionResult,
      index: number,
    ) => void,
    signal?: AbortSignal,
    options?: { schemaFailureMode?: SchemaFailureMode },
  ): Promise<HookExecutionResult[]> {
    const promises = hookConfigs.map(async (config, index) => {
      onHookStart?.(config, index);
      try {
        const runCompletedWrite = this.shouldRunCompletedWriteAfterCancellation(
          config,
          eventName,
          input,
        );
        if (runCompletedWrite && signal?.aborted) {
          runLogger.debug(
            `[Hooks] Preserving completed file-write attribution after cancellation hook=${this.getHookId(config)}`,
          );
        }
        const parentSignal = runCompletedWrite ? undefined : signal;
        const result = await withOuterHookTimeout(
          (innerSignal) =>
            this.executeHook(
              config,
              eventName,
              input,
              innerSignal,
              index,
              options,
            ),
          parentSignal,
          this.getOuterTimeoutForHook(config),
          () =>
            this.outerFailResult(
              config,
              eventName,
              `Hook outer timeout (defensive) for event ${eventName}`,
            ),
          (reason) =>
            this.outerFailResult(
              config,
              eventName,
              describeHookAbortReason(reason),
            ),
        );
        onHookEnd?.(config, result, index);
        return result;
      } catch (error) {
        const failResult: HookExecutionResult = {
          hookConfig: config,
          eventName,
          success: false,
          duration: 0,
          error: toError(error),
        };
        onHookEnd?.(config, failResult, index);
        return failResult;
      }
    });

    return Promise.all(promises);
  }

  /**
   * Execute multiple hooks sequentially
   */
  async executeHooksSequential(
    hookConfigs: HookConfig[],
    eventName: HookEventName,
    input: HookInput,
    onHookStart?: (config: HookConfig, index: number) => void,
    onHookEnd?: (
      config: HookConfig,
      result: HookExecutionResult,
      index: number,
    ) => void,
    signal?: AbortSignal,
    options?: { schemaFailureMode?: SchemaFailureMode },
  ): Promise<HookExecutionResult[]> {
    const results: HookExecutionResult[] = [];
    let currentInput = input;

    for (let i = 0; i < hookConfigs.length; i++) {
      const config = hookConfigs[i];
      onHookStart?.(config, i);
      let result: HookExecutionResult;
      try {
        const runCompletedWrite = this.shouldRunCompletedWriteAfterCancellation(
          config,
          eventName,
          currentInput,
        );
        if (runCompletedWrite && signal?.aborted) {
          runLogger.debug(
            `[Hooks] Preserving completed file-write attribution after cancellation hook=${this.getHookId(config)}`,
          );
        }
        const parentSignal = runCompletedWrite ? undefined : signal;
        result = await withOuterHookTimeout(
          (innerSignal) =>
            this.executeHook(
              config,
              eventName,
              currentInput,
              innerSignal,
              i,
              options,
            ),
          parentSignal,
          this.getOuterTimeoutForHook(config),
          () =>
            this.outerFailResult(
              config,
              eventName,
              `Hook outer timeout (defensive) for event ${eventName}`,
            ),
          (reason) =>
            this.outerFailResult(
              config,
              eventName,
              describeHookAbortReason(reason),
            ),
        );
      } catch (error) {
        result = {
          hookConfig: config,
          eventName,
          success: false,
          duration: 0,
          error: toError(error),
        };
      }
      onHookEnd?.(config, result, i);
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
   * Compute the outer defensive timeout for a hook (inner timeout + slack).
   * Uses per-type defaults so a short inner timeout (e.g. prompt's 30s) is not
   * masked by the command hook's 600s default.
   */
  private getOuterTimeoutForHook(config: HookConfig): number {
    return (
      resolveHookTimeoutSeconds(config) * 1000 + OUTER_HOOK_TIMEOUT_SLACK_MS
    );
  }

  /**
   * Build a uniform failure result for the outer defensive timeout wrapper.
   */
  private outerFailResult(
    config: HookConfig,
    eventName: HookEventName,
    message: string,
  ): HookExecutionResult {
    return {
      hookConfig: config,
      eventName,
      success: false,
      duration: 0,
      error: new Error(message),
    };
  }

  /**
   * Apply hook output to modify input for the next hook in sequential execution
   */
  private applyHookOutputToInput(
    originalInput: HookInput,
    hookOutput: HookOutput,
    eventName: HookEventName,
  ): HookInput {
    const modifiedInput = { ...originalInput };
    // Object spread omits the Runtime-only PostToolUse file facts.
    const fileWriteDescriptor = Object.getOwnPropertyDescriptor(
      originalInput,
      'file_write',
    );
    if (fileWriteDescriptor) {
      Object.defineProperty(modifiedInput, 'file_write', fileWriteDescriptor);
    }

    // Apply modifications based on hook output and event type
    if (hookOutput.hookSpecificOutput) {
      switch (eventName) {
        case HookEventName.PreToolUse:
          if ('updatedInput' in hookOutput.hookSpecificOutput) {
            const newToolInput = hookOutput.hookSpecificOutput[
              'updatedInput'
            ] as Record<string, unknown>;
            if (newToolInput && 'tool_input' in modifiedInput) {
              (modifiedInput as PreToolUseInput).tool_input = {
                ...(modifiedInput as PreToolUseInput).tool_input,
                ...newToolInput,
              };
            }
          }
          break;

        case HookEventName.UserPromptSubmit:
          if (
            'prompt' in hookOutput.hookSpecificOutput &&
            // eslint-disable-next-line eslint-js/no-restricted-syntax
            typeof hookOutput.hookSpecificOutput['prompt'] === 'string' &&
            'prompt' in modifiedInput
          ) {
            (modifiedInput as UserPromptSubmitInput).prompt =
              hookOutput.hookSpecificOutput['prompt'];
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
   * Execute a runtime hook
   */
  private async executeRuntimeHook(
    hookConfig: RuntimeHookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    const timeoutMs = (hookConfig.timeout ?? DEFAULT_HOOK_TIMEOUT) * 1000;

    const combinedSignal = combineWithTimeout(signal, timeoutMs);

    const execution: BuiltinRuntimeExecutionContext = {
      getSessionContext: () => this.config.getBuiltinSessionContext(),
      isSdkMode: isSDKMode(),
      getSetting: (section) => this.config.getSetting(section),
    };

    try {
      const result = await abortablePromise(
        hookConfig.action(input, { signal: combinedSignal, execution }),
        combinedSignal,
        `Runtime hook timed out after ${timeoutMs}ms`,
      );

      const output =
        result === null || result === undefined ? undefined : result;

      return {
        hookConfig,
        eventName,
        success: true,
        output,
        outputFormat: output ? 'json' : undefined,
        duration: Date.now() - startTime,
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
   * Execute an HTTP hook by POSTing the input as JSON to the configured URL.
   *
   * The response is expected to be a JSON HookOutput. Non-2xx responses are
   * treated as failures. Headers support `${ENV_VAR}` interpolation.
   */
  private async executeHttpHook(
    hookConfig: HttpHookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    const timeoutMs = (hookConfig.timeout ?? DEFAULT_HTTP_HOOK_TIMEOUT) * 1000;
    const hookName = getHookDisplayText(hookConfig);
    const hookId = randomUUID();
    let startedEmitted = false;

    try {
      // Security: Validate URL protocol (only http/https allowed)
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(hookConfig.url);
      } catch {
        return {
          hookConfig,
          eventName,
          success: false,
          error: new Error(`Invalid HTTP hook URL: ${hookConfig.url}`),
          duration: Date.now() - startTime,
        };
      }

      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return {
          hookConfig,
          eventName,
          success: false,
          error: new Error(
            `HTTP hook URL must use http or https protocol, got: ${parsedUrl.protocol}`,
          ),
          duration: Date.now() - startTime,
        };
      }

      const allowedHttpHookUrls = this.config.getAllowedHttpHookUrls();
      if (!isHttpHookUrlAllowed(hookConfig.url, allowedHttpHookUrls)) {
        return {
          hookConfig,
          eventName,
          success: false,
          error: new Error(
            `HTTP hook blocked: ${hookConfig.url} does not match any pattern in allowedHttpHookUrls`,
          ),
          duration: Date.now() - startTime,
        };
      }

      // Emit started event (after validation, before the actual request)
      hookEvents.emitStarted({
        sessionId: this.config.getSessionId(),
        hook_id: hookId,
        hook_name: hookName,
        hook_event: eventName,
      });
      startedEmitted = true;

      // Build headers with environment variable interpolation + CRLF sanitization
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (hookConfig.headers) {
        for (const [key, value] of Object.entries(hookConfig.headers)) {
          headers[sanitizeHeaderValue(key)] = sanitizeHeaderValue(
            this.interpolateEnvVars(value, hookConfig.allowedEnvVars),
          );
        }
      }

      const response = await unmanagedRequest(
        hookConfig.url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            event: eventName,
            ...input,
          }),
          signal,
        },
        { timeoutMs },
      );

      const duration = Date.now() - startTime;
      const responseText = await response.text();

      // Helper: emit error event and return a non-blocking error result
      const emitNonBlockingError = (
        errorMessage: string,
        output = responseText || errorMessage,
        stdout = responseText,
      ) => {
        hookEvents.emitResponse({
          sessionId: this.config.getSessionId(),
          hook_id: hookId,
          hook_name: hookName,
          hook_event: eventName,
          exit_code: response.status,
          duration_ms: duration,
          outcome: 'error',
          stdout,
          stderr: errorMessage,
          output,
        });
        return {
          hookConfig,
          eventName,
          success: false as const,
          outcome: 'non_blocking_error' as const,
          error: new Error(errorMessage),
          stdout,
          stderr: errorMessage,
          exitCode: response.status,
          duration,
        };
      };

      const emitPreToolUseDenyResult = (reason: string) => {
        runLogger.warn(reason);
        hookEvents.emitResponse({
          sessionId: this.config.getSessionId(),
          hook_id: hookId,
          hook_name: hookName,
          hook_event: eventName,
          exit_code: response.status,
          duration_ms: duration,
          outcome: 'error',
          stdout: responseText,
          stderr: reason,
          output: responseText,
        });
        return {
          hookConfig,
          eventName,
          success: true as const,
          output: {
            decision: 'deny' as const,
            reason,
            stdoutContent: responseText,
            hookName,
            hookCommand: hookConfig.url,
          },
          outputFormat: 'json' as const,
          stdout: responseText,
          duration,
        };
      };

      if (!response.ok) {
        const msg = `HTTP hook returned ${response.status}: ${responseText.slice(0, 5000)}`;
        return emitNonBlockingError(msg, msg, '');
      }

      // Parse HTTP hook output according to the hook contract:
      // 2xx empty body succeeds with no output; 2xx plain text becomes
      // context; 2xx JSON is schema-validated hook output.
      let output: HookOutput | undefined;
      let outputFormat: 'json' | 'text' | undefined;
      if (responseText.trim()) {
        const text = responseText.trim();
        if (!text.startsWith('{')) {
          output = {
            decision: 'allow',
            stdoutContent: text,
            hookName,
            hookCommand: hookConfig.url,
          };
          outputFormat = 'text';
        } else {
          try {
            const parsed = JSON.parse(text);
            const validation = validateHookOutput(parsed);
            if (validation.success) {
              output = {
                ...validation.output,
                hookName,
                hookCommand: hookConfig.url,
              };
              outputFormat = 'json';
            } else if (eventName === HookEventName.PreToolUse) {
              return emitPreToolUseDenyResult(
                `PreToolUse HTTP hook output failed schema validation, denying tool: ${validation.error}`,
              );
            } else {
              const msg = `HTTP hook output for ${eventName} failed schema validation: ${validation.error}`;
              runLogger.warn(msg);
              return emitNonBlockingError(msg);
            }
          } catch (parseError) {
            if (eventName === HookEventName.PreToolUse) {
              return emitPreToolUseDenyResult(
                `PreToolUse HTTP hook returned malformed JSON output: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
              );
            }
            // Starts with '{' but is not valid JSON
            const msg = `HTTP hook output for ${eventName} looks like JSON but failed to parse: ${parseError instanceof Error ? parseError.message : String(parseError)}`;
            runLogger.warn(msg);
            return emitNonBlockingError(msg);
          }
        }
      }

      hookEvents.emitResponse({
        sessionId: this.config.getSessionId(),
        hook_id: hookId,
        hook_name: hookName,
        hook_event: eventName,
        exit_code: undefined,
        duration_ms: duration,
        outcome: 'success',
        stdout: responseText,
        stderr: '',
        output: responseText,
      });

      return {
        hookConfig,
        eventName,
        success: true,
        output,
        outputFormat,
        stdout: responseText,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const isAbort = error instanceof Error && error.name === 'AbortError';
      const message = isAbort
        ? `HTTP hook timed out after ${timeoutMs / 1000}s`
        : `HTTP hook request failed: ${error instanceof Error ? error.message : String(error)}`;
      if (startedEmitted) {
        const eventOutput = isAbort ? 'Hook cancelled' : message;
        hookEvents.emitResponse({
          sessionId: this.config.getSessionId(),
          hook_id: hookId,
          hook_name: hookName,
          hook_event: eventName,
          exit_code: undefined,
          duration_ms: duration,
          outcome: isAbort ? 'cancelled' : 'error',
          stdout: '',
          stderr: isAbort ? '' : message,
          output: eventOutput,
        });
      }

      return {
        hookConfig,
        eventName,
        success: false,
        error: new Error(message),
        duration,
      };
    }
  }

  /**
   * Interpolate `${ENV_VAR}` and `$ENV_VAR` references in a string with process.env values.
   * Supports both `${VAR_NAME}` (braced) and `$VAR_NAME` (bare) syntax.
   */
  private interpolateEnvVars(value: string, allowedEnvVars?: string[]): string {
    return value.replace(
      /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g,
      (match, braced: string | undefined, bare: string | undefined) => {
        const envVar = braced ?? bare!;
        if (allowedEnvVars && !allowedEnvVars.includes(envVar)) {
          runLogger.warn(
            `Environment variable "${envVar}" is not in the allowedEnvVars list and will not be interpolated`,
          );
          return ''; // Replace with empty string to avoid leaking placeholder syntax
        }
        return process.env[envVar] ?? '';
      },
    );
  }

  /**
   * Execute a prompt hook by calling the LLM with a single-turn JSON request.
   *
   * The LLM receives:
   * 1. A system instruction defining the evaluator role and expected JSON output
   * 2. The user-defined prompt combined with the serialized hook input
   *
   * Returns a structured HookOutput based on the LLM's JSON decision.
   */
  private async executePromptHook(
    hookConfig: PromptHookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    const timeoutMs =
      (hookConfig.timeout ?? DEFAULT_PROMPT_HOOK_TIMEOUT) * 1000;

    const combinedSignal = combineWithTimeout(signal, timeoutMs);

    try {
      const modelProvider = this.config.getModelProviderManager();
      const sessionId = this.config.getSessionId();
      const policy = await this.config.getModelPolicy?.(
        'hook_prompt',
        sessionId,
        0,
        undefined,
        combinedSignal,
        { resolvedModel: hookConfig.model ?? this.config.getModel() },
      );
      combinedSignal.throwIfAborted();
      const overrideKey = policy?.model ?? hookConfig.model;
      const baseSelection =
        overrideKey !== undefined
          ? await abortablePromise(
              resolveModelSelectionOverride(modelProvider, overrideKey),
              combinedSignal,
              'Prompt hook model selection was cancelled or timed out',
            )
          : await modelProvider.select({ purpose: 'hook_prompt' });
      const resolution = await modelProvider.select({
        purpose: 'hook_prompt',
        overrideSelection: {
          model: baseSelection.model,
          config: mergeModelConfig(baseSelection.config, {
            reasoning: { effort: policy?.parameters?.reasoningEffort },
            context: { contextWindow: policy?.parameters?.contextWindow },
          }),
        },
      });
      combinedSignal.throwIfAborted();

      const systemInstruction = `You are a hook evaluator. Analyze the following hook event and respond with a JSON object.
The JSON must have an "ok" field (boolean). Set "ok" to true if the event should proceed, false if it should be blocked.
Optionally include a "reason" field explaining your decision when ok is false.`;

      const userContent = `User-defined instruction:
${hookConfig.prompt}

Hook event: ${eventName}
Hook event data:
${JSON.stringify(input, null, 2)}`;

      const parentBusiness = getBusinessInfoFromContext();
      const subTask = resolveBusinessSubTask(
        'hook_prompt',
        policy?.labels?.subTask,
      );
      const business = parentBusiness
        ? applyBusinessSubTask({ ...parentBusiness }, 'hook_prompt', subTask)
        : subTask
          ? {
              ...resolveBusinessIdentity(),
              version: await getVersion(),
              id: randomUUID(),
              model_key: this.config.getModel(),
              name: subTask,
              sub_task: subTask,
              begin_at: Date.now(),
              stage: 'init',
            }
          : undefined;
      const request = {
        resolution,
        prompt: {
          messages: [
            {
              role: 'system' as const,
              content: `${systemInstruction}\n\n${[
                'Return only a JSON object that conforms to this JSON Schema.',
                'Do not wrap the JSON in Markdown.',
                JSON.stringify(PROMPT_HOOK_RESPONSE_SCHEMA, null, 2),
              ].join('\n')}`,
            },
            { role: 'user' as const, content: userContent },
          ],
        },
        control: { signal: combinedSignal },
        qoder: {
          identity: { sessionId, requestSetId: getRequestSetIdFromContext() },
          taskRouting: {
            taskId: business?.type === 'sec_scan' ? 'sec_scan' : undefined,
            policyTaskId: policy?.labels?.taskId,
          },
          business,
        },
      };

      const jsonResult = await abortablePromise(
        retryWithBackoff(
          async () => {
            const response = await modelProvider.inference(request);
            return readPromptHookDecision(await response.completed);
          },
          {
            maxAttempts: DEFAULT_MAX_ATTEMPTS,
            signal: combinedSignal,
            shouldRetryOnError: () => false,
            shouldRetryOnContent: (decision) => decision === undefined,
          },
        ),
        combinedSignal,
        `Prompt hook timed out after ${timeoutMs}ms`,
      );
      if (!jsonResult) {
        throw new Error('Prompt hook returned an invalid decision.');
      }

      const duration = Date.now() - startTime;

      // Map LLM JSON {ok, reason} to internal HookOutput {decision, reason}
      const { ok, reason } = jsonResult;

      const output: HookOutput = ok
        ? { decision: 'allow' }
        : { decision: 'deny', reason: reason || 'Prompt hook rejected' };

      runLogger.debug(
        `Prompt hook for ${eventName} returned ok: ${ok}${reason ? `, reason: ${reason}` : ''}`,
      );

      return {
        hookConfig,
        eventName,
        success: true,
        output,
        outputFormat: 'json',
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const hookId = getHookDisplayText(hookConfig);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      runLogger.warn(
        `Prompt hook "${hookId}" for ${eventName} failed: ${errorMessage}`,
      );

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
   * Execute an agent hook by running a sub-agent loop with tool access.
   *
   * Uses the standard Scheduler pipeline with a non-interactive hook-agent
   * permission context, a scoped ToolRegistry for tool filtering, and
   * AbortSignal.timeout() for cascading timeout protection.
   */
  private async executeAgentHook(
    hookConfig: AgentHookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
    signal?: AbortSignal,
  ): Promise<HookExecutionResult> {
    // Timeout in seconds, convert to ms
    const timeoutMs =
      (hookConfig.timeout ?? DEFAULT_AGENT_HOOK_TIMEOUT_SECONDS) * 1000;
    const maxTurns = hookConfig.maxTurns ?? DEFAULT_AGENT_HOOK_MAX_TURNS;

    // Cascading timeout: self-cleaning (no clearTimeout needed).
    const hookSignal = combineWithTimeout(signal, timeoutMs);

    let toolRegistry: ToolRegistry | undefined;
    try {
      hookSignal.throwIfAborted();
      const mainRegistry = this.config.getToolRegistry();
      if (!mainRegistry) {
        throw new Error('ToolRegistry not available for agent hook execution');
      }

      const promptId = `hook-agent-${eventName}-${Date.now()}`;

      // Shared result holder — DeclarativeTool writes, we read
      const resultHolder = new StructuredOutputResultHolder();

      // Scoped ToolRegistry: filtered tools + injected StructuredOutput
      const hookToolRegistry = this.createScopedToolRegistry(
        mainRegistry,
        hookConfig.tools ?? null,
        resultHolder,
      );

      // AgentLoopContext assembled from Config, with scoped registry
      const loopContext = createHookAgentLoopContext(
        this.config,
        promptId,
        hookToolRegistry,
      );

      // Hook-agent permission behavior is owned by
      // createHookAgentLoopContext/createHookAgentCanUseTool, not by a
      // request-level auto-approve flag.
      toolRegistry = hookToolRegistry;

      const jsonInput = JSON.stringify(input, null, 2);
      const processedPrompt = hookConfig.prompt.includes('$ARGUMENTS')
        ? hookConfig.prompt.replace(/\$ARGUMENTS/g, jsonInput)
        : `${hookConfig.prompt}\n\nHook event: ${eventName}\nHook event data:\n${jsonInput}`;

      // TODO: system prompt references the conversation transcript file path
      //       for the agent to read. Add transcript_path injection when our
      //       transcript mechanism supports it.
      const systemPromptText = `You are verifying a condition for a hook event. Your task is to evaluate whether the condition is met.

Use the available tools to inspect the codebase and verify the condition.
Use as few steps as possible - be efficient and direct.

When done, return your result using the ${STRUCTURED_OUTPUT_TOOL_NAME} tool with:
- ok: true if the condition is met
- ok: false with reason if the condition is not met`;

      const systemPrompt = await buildSystemPromptForTurn(undefined, {
        resolvedSource: { source: 'custom', fixedBody: systemPromptText },
      });

      let turnCount = 0;

      const parentBusinessInfo = getBusinessInfoFromContext();
      for await (const event of query({
        querySelection:
          hookConfig.model !== undefined
            ? { key: hookConfig.model }
            : undefined,
        turnHookFactories: this.config.turnHookFactories,
        isSubagent: true,
        agentType: 'hook-agent',
        agentId: promptId,
        sessionId: input.session_id,
        parentBusinessInfo,
        parentRequestSetId: getRequestSetIdFromContext(),
        customContext: snapshotCustomContext(getCustomContextFromContext()),
        prompt: processedPrompt,
        signal: hookSignal,
        systemPrompt,
        toolRegistry,
        toolExecutor: this.config.getToolExecutor(),
        agentContext: loopContext,
        maxTurns,
        promptId,
        modelPurpose: 'hook_prompt',
        config: this.config,
      })) {
        // Count assistant turns
        if (event.type === 'assistant') {
          turnCount++;
        }

        // Check if StructuredOutput tool was called
        if (resultHolder.result) {
          break;
        }
      }

      const duration = Date.now() - startTime;

      const result = resultHolder.result;

      if (!result) {
        // No structured output → treat as cancelled
        runLogger.debug(
          `Agent hook for ${eventName} did not return structured output ` +
            `(turns: ${turnCount}, aborted: ${hookSignal.aborted})`,
        );
        return {
          hookConfig,
          eventName,
          success: true,
          outcome: 'cancelled',
          output: { decision: 'defer' },
          duration,
        };
      }

      if (!result.ok) {
        // ok=false → blocking with reason
        return {
          hookConfig,
          eventName,
          success: true,
          outcome: 'blocking',
          output: {
            decision: 'deny',
            reason: result.reason || 'Agent hook condition was not met',
          },
          outputFormat: 'json',
          duration,
        };
      }

      // ok=true → success
      return {
        hookConfig,
        eventName,
        success: true,
        outcome: 'success',
        output: { decision: 'allow' },
        outputFormat: 'json',
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      // query 的选模取消抛出 signal.reason；不能把同时发生的普通执行错误吞成取消。
      if (hookSignal.aborted && error === hookSignal.reason) {
        return {
          hookConfig,
          eventName,
          success: true,
          outcome: 'cancelled',
          output: { decision: 'defer' },
          duration,
        };
      }
      const hookId = getHookDisplayText(hookConfig);
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Error → non-blocking
      runLogger.warn(
        `Agent hook "${hookId}" for ${eventName} failed: ${errorMsg}`,
      );
      return {
        hookConfig,
        eventName,
        success: false,
        outcome: 'non_blocking_error',
        error: error instanceof Error ? error : new Error(errorMsg),
        duration,
      };
    } finally {
      toolRegistry?.dispose();
    }
  }

  /**
   * Tools that agent hooks must NOT have access to.
   */
  private static readonly AGENT_HOOK_DISALLOWED_TOOLS = new Set([
    AGENT_TOOL_NAME, // Prevent recursive agent spawning
    'EnterPlanMode', // No plan mode in hook agents
    'ExitPlanMode',
    'AskUserQuestion', // No interactive prompts
    'TaskCreate',
    'TaskStop',
    'TaskOutput',
  ]);

  /**
   * Create a scoped ToolRegistry for hook agent execution.
   *
   * Filters the main registry's tools (by allowlist or denylist),
   * then injects StructuredOutput as a real DeclarativeTool.
   */
  private createScopedToolRegistry(
    mainRegistry: ToolRegistry,
    allowedTools: string[] | null,
    resultHolder: StructuredOutputResultHolder,
  ): ToolRegistry {
    const hookRegistry = new ToolRegistry(this.config);
    const allowSet = allowedTools ? new Set(allowedTools) : null;

    for (const tool of mainRegistry.getAllTools()) {
      const name = tool.name;
      if (name === STRUCTURED_OUTPUT_TOOL_NAME) continue;
      if (allowSet) {
        if (isKeptByAllowList(tool, allowSet)) hookRegistry.registerTool(tool);
      } else {
        if (!HookRunner.AGENT_HOOK_DISALLOWED_TOOLS.has(name)) {
          hookRegistry.registerTool(tool);
        }
      }
    }

    // Inject StructuredOutput as a real DeclarativeTool
    hookRegistry.registerTool(
      new StructuredOutputDeclarativeTool(resultHolder),
    );
    return hookRegistry;
  }

  /**
   * Execute a command hook.
   *
   * Settle-boundary contract (do not break when editing):
   * - Every settle path (exit / error / timeout / abort) MUST go through the
   *   single `finalize()` guard — it is the only place that resolves.
   * - timeout/abort are completion boundaries: they resolve immediately and do
   *   NOT wait for the child's exit event (a wedged child that ignores signals
   *   would otherwise hang the promise forever).
   * - exit/error are no-ops once `finalized` is set (late events after a
   *   timeout/abort must not re-emit, re-parse, or read the env file).
   *
   * Stage-2 note: if this is ever refactored into a CommandHookProcess wrapper,
   * the caller MUST consume only `proc.result` and must NOT attach its own
   * child.on('exit'|'close'|'error') race. That is exactly how the CLI
   * regressed — the wrapper settled correctly but a caller-built race bypassed
   * it and still hung.
   */
  private async executeCommandHook(
    hookConfig: CommandHookConfig,
    eventName: HookEventName,
    input: HookInput,
    startTime: number,
    signal?: AbortSignal,
    hookIndex: number = 0,
    options?: { schemaFailureMode?: SchemaFailureMode },
  ): Promise<HookExecutionResult> {
    const timeoutMs = (hookConfig.timeout ?? DEFAULT_HOOK_TIMEOUT) * 1000;

    if (!hookConfig.command) {
      const errorMessage = 'Command hook missing command';
      runLogger.warn(`Hook configuration error (non-fatal): ${errorMessage}`);
      return {
        hookConfig,
        eventName,
        success: false,
        error: new Error(errorMessage),
        duration: Date.now() - startTime,
      };
    }

    const preflightFailure = await this.runPluginPreflight(
      hookConfig,
      eventName,
      startTime,
    );
    if (preflightFailure) {
      return preflightFailure;
    }

    return (async () => {
        const useExecForm = hookConfig.args !== undefined;

        if (useExecForm) {
          // Misuse hint: in exec form `command` is a single executable. Whitespace
          // without a path separator suggests the author meant shell form.
          if (
            /\s/.test(hookConfig.command) &&
            !/[\\/]/.test(hookConfig.command)
          ) {
            runLogger.warn(
              `Hook command "${hookConfig.command}" has both "args" and ` +
                `whitespace in "command". Exec form treats "command" as a ` +
                `single executable name; move the rest into "args".`,
            );
          }
        }

        // Resolve shell config before entering the Promise constructor
        // (which is a non-async callback where await is not allowed).
        // On Windows, default to bash (Git Bash) instead of PowerShell to avoid
        // shell syntax conflicts (e.g., cmd.exe-style bracket/variable expansion
        // being misinterpreted by PowerShell).
        // Exec form ignores `shell` and bypasses the shell entirely. We use a
        // synthetic config so we never call findGitBashPath() (which can fail
        // on Windows when Git Bash isn't installed). Downstream code branches
        // on useExecForm, so the synthetic executable/argsPrefix are inert.
        const shellConfig: ShellConfiguration = useExecForm
          ? { shell: 'bash', executable: '', argsPrefix: [] }
          : hookConfig.shell
            ? await this.getShellConfigForOverride(hookConfig.shell)
            : process.platform === 'win32'
              ? await this.getShellConfigForOverride('bash')
              : getShellConfiguration();

        // Exec form uses native paths. Shell form uses the target shell's
        // format (POSIX under Bash on Windows).
        const toHookPath = useExecForm
          ? (p: string) => p
          : getHookPathConverter(shellConfig.shell);
        const projectDir = toHookPath(
          this.config.getSessionArtifactProjectRoot(),
        );
        const preparedEnv = await this.prepareEnv(projectDir);

        return new Promise<HookExecutionResult>((resolve, reject) => {


          let stdout = '';
          let stderr = '';
          let processExited = false; // set only by real exit/error events
          let finalized = false; // set only by finalize(); guards double-settle
          // Declared early so finalize() (defined below) can clear it; assigned
          // once when the timeout is armed further down.
          // eslint-disable-next-line prefer-const
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

          // -------------------------------------------------------------------
          // Structured hook event emission.
          // Uses a 1000 ms polling interval that emits cumulative stdout/stderr
          // when output has changed since last emission. Lazy-armed on first
          // byte of output so silent hooks pay no timer cost.
          // -------------------------------------------------------------------
          const hookId = randomUUID();
          const hookName = getHookDisplayText(hookConfig);
          let output = ''; // interleaved cumulative (stdout + stderr in arrival order)
          let lastEmittedOutput = '';
          let progressInterval: ReturnType<typeof setInterval> | null = null;

          const flushProgress = (): void => {
            if (output === lastEmittedOutput) return;
            lastEmittedOutput = output;
            try {
              hookEvents.emitProgress({
                sessionId: this.config.getSessionId(),
                hook_id: hookId,
                hook_name: hookName,
                hook_event: eventName,
                stdout,
                stderr,
                output,
              });
            } catch (err) {
              runLogger.debug(`Hook progress emit failed: ${err}`);
            }
          };
          const stopProgressInterval = (): void => {
            if (progressInterval) {
              clearInterval(progressInterval);
              progressInterval = null;
            }
          };
          // Lazy: arm the polling interval only after the first byte of
          // stdout/stderr arrives. Silent hooks (the common case) pay no timer
          // cost.
          const armProgressIntervalIfNeeded = (): void => {
            if (progressInterval === null) {
              progressInterval = setInterval(flushProgress, 1000);
              progressInterval.unref();
            }
          };

          // Pre-compute plugin data dir once to avoid redundant mkdirSync calls
          const pluginDataDir = hookConfig.pluginId
            ? getPluginDataDir(hookConfig.pluginId)
            : undefined;

          // Exec-form expansion: substitute placeholders directly into the
          // command path and each arg. Shell-form leaves bash placeholders as
          // literals (env passthrough) and substitutes only for pwsh.
          const execExecutable = useExecForm
            ? this.expandTokenForExec(
                hookConfig.command,
                hookConfig,
                pluginDataDir,
              )
            : hookConfig.command;
          const execArgs: string[] = useExecForm
            ? (hookConfig.args ?? []).map((a) =>
                this.expandTokenForExec(a, hookConfig, pluginDataDir),
              )
            : [];

          let command = '';
          if (!useExecForm) {
            command = this.expandCommand(
              hookConfig.command,
              input,
              shellConfig.shell,
              hookConfig,
              pluginDataDir,
            );
            if (process.platform === 'win32' && shellConfig.shell === 'bash') {
              command = normalizeWindowsBashCommand(command);
            }
            if (shellConfig.shell === 'powershell') {
              // Append exit code check to ensure the exit code of the command is propagated
              command = `${command}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
            } else {
              const shellPrefix = resolveShellPrefix();
              if (shellPrefix) {
                command = wrapPosixShellCommand(command, shellPrefix);
              }
            }
          }

          const env: Record<string, string | undefined> = {
            ...preparedEnv,
            ...(typeof hookConfig.env === 'function' ? {} : hookConfig.env),
          };
          removeSensitiveEnv(env);
          const resolvedEnv = resolveBuiltinHookEnv(hookConfig);
          if (resolvedEnv) {
            applyHookEnvOverrides(env, resolvedEnv);
          }
          if (process.platform === 'win32' && shellConfig.shell === 'bash') {
            prependWindowsExecutableDirectoryToPath(
              env,
              shellConfig.executable,
            );
          }

          // Inject plugin context as environment variables for the subprocess
          if (hookConfig.pluginRoot) {
            const root = toHookPath(hookConfig.pluginRoot);
            env[ENV_PLUGIN_ROOT] = root;
            env['CLAUDE_PLUGIN_ROOT'] = root;
          }
          if (pluginDataDir) {
            const data = toHookPath(pluginDataDir);
            env[ENV_PLUGIN_DATA] = data;
            env['CLAUDE_PLUGIN_DATA'] = data;
          }

          // Hook env file: For Setup, SessionStart, CwdChanged, FileChanged
          // events (non-powershell, non-exec-form), create a persistent env
          // file in the session env directory. Hooks write `export KEY=VALUE`
          // lines to it; bashProvider sources all session env files into
          // every bash command. Exec-form bypasses shell so there's no source
          // mechanism to honor an env file.
          let envFilePath: string | undefined;
          // 缓存按 sessionId 键控，失效时必须指名道姓：不传就会把同进程其他
          // 会话的缓存一起清掉。
          const envFileSessionId = this.config.getSessionId();
          if (
            !useExecForm &&
            ENV_FILE_EVENTS.has(eventName) &&
            shellConfig.shell !== 'powershell'
          ) {
            try {
              envFilePath = createEnvFile(
                envFileSessionId,
                eventName,
                hookIndex ?? 0,
              );
              env[`${BRAND_FIXED_ENV_PREFIX}ENV_FILE`] = envFilePath;
            } catch (err) {
              runLogger.debug(`Failed to create hook env file: ${err}`);
              envFilePath = undefined;
            }
          }

          hookEvents.emitStarted({
            sessionId: this.config.getSessionId(),
            hook_id: hookId,
            hook_name: hookName,
            hook_event: eventName,
          });

          const child = (() => {
            try {
              if (process.platform !== 'win32') prepareDetachedProcessGuard();
              if (useExecForm) {
                return spawn(execExecutable, execArgs, {
                  env,
                  cwd: input.cwd,
                  stdio: ['pipe', 'pipe', 'pipe'],
                  shell: false,
                  // Detached ⇒ the child is a process-group leader on POSIX, so
                  // abort/timeout teardown can signal the whole group via
                  // process.kill(-pid) without forking (see killHookProcessGroup).
                  detached: process.platform !== 'win32',
                  windowsHide: true,
                });
              }
              return spawn(
                shellConfig.executable,
                [...shellConfig.argsPrefix, command],
                {
                  env,
                  cwd: input.cwd,
                  stdio: ['pipe', 'pipe', 'pipe'],
                  shell: false,
                  // Detached ⇒ the child is a process-group leader on POSIX, so
                  // abort/timeout teardown can signal the whole group via
                  // process.kill(-pid) without forking (see killHookProcessGroup).
                  detached: process.platform !== 'win32',
                  // Prevent MSYS2/Cygwin fork-failure messages from being
                  // written directly to the inherited console handle (which
                  // would corrupt the Ink alt-screen and bypass patchStderr).
                  // CREATE_NO_WINDOW is a no-op on non-Windows platforms.
                  windowsHide: true,
                },
              );
            } catch (error) {
              const duration = Date.now() - startTime;
              const message =
                error instanceof Error ? error.message : String(error);
              try {
                stopProgressInterval();
                flushProgress();
                hookEvents.emitResponse({
                  sessionId: this.config.getSessionId(),
                  hook_id: hookId,
                  hook_name: hookName,
                  hook_event: eventName,
                  exit_code: undefined,
                  duration_ms: duration,
                  outcome: 'error',
                  stdout,
                  stderr: message,
                  output: output || message,
                });
              } catch (err) {
                runLogger.debug(`Hook response emit failed: ${err}`);
              }
              if (envFilePath) {
                truncateEnvFile(envFilePath);
                invalidateSessionEnvCache(envFileSessionId);
              }
              reject(error);
              return null;
            }
          })();
          if (!child) {
            return;
          }
          guardDetachedProcess(child);



          // One-shot settle guard. All settle paths (exit / error / timeout /
          // abort) funnel through here. Mechanical only — emitResponse,
          // env-cache invalidation, output parsing and metadata are
          // handled by each caller BEFORE invoking finalize.
          //
          // `forced: true` (timeout / abort) additionally destroys stdio so a
          // grandchild that inherited the fds and ignored the kill cannot keep
          // appending into our buffers after we've settled. Normal exit/error
          // must NOT destroy — it would drop tail chunks still in the event loop.
          const finalize = (
            result: HookExecutionResult,
            opts: { forced?: boolean } = {},
          ): void => {
            if (finalized) return;
            finalized = true;

            if (timeoutHandle) clearTimeout(timeoutHandle);
            signal?.removeEventListener('abort', onAbort);

            // Order: stop interval → flush current buffer → (forced) destroy
            stopProgressInterval();
            flushProgress();
            if (opts.forced) {
              try {
                child.stdin?.destroy();
              } catch {
                // ignore — stream may already be destroyed
              }
              try {
                child.stdout?.destroy();
              } catch {
                // ignore
              }
              try {
                child.stderr?.destroy();
              } catch {
                // ignore
              }
            }

            resolve(result);
          };

          // Shared forced-settle logic for timeout and abort paths. Both fill
          // metadata, emit response, clean env file, and finalize — they differ
          // only in `timedOut` flag and the error message.
          const settleForced = (opts: {
            timedOut: boolean;
            errorMessage: string;
            kind: 'timeout' | 'cancelled';
          }): void => {
            const duration = Date.now() - startTime;








            try {
              stopProgressInterval();
              flushProgress();
              hookEvents.emitResponse({
                sessionId: this.config.getSessionId(),
                hook_id: hookId,
                hook_name: hookName,
                hook_event: eventName,
                exit_code: undefined,
                duration_ms: duration,
                outcome: 'cancelled',
                stdout,
                stderr,
                output,
              });
            } catch (err) {
              runLogger.debug(`Hook response emit failed: ${err}`);
            }
            if (envFilePath) {
              truncateEnvFile(envFilePath);
              invalidateSessionEnvCache(envFileSessionId);
            }

            finalize(
              {
                hookConfig,
                eventName,
                success: false,
                error: new Error(opts.errorMessage),
                stdout,
                stderr,
                duration,
                failureKind: opts.kind,
              },
              { forced: true },
            );
          };

          // Abort signal: settle immediately as cancelled, then signal the
          // child. We do NOT wait for the child's exit event — a wedged child
          // (ignores signals, or treeKill's underlying kill never reaps it)
          // would otherwise hang this promise forever.
          const onAbort = () => {
            if (finalized || processExited) return;

            // SIGTERM first (gives the child a chance to clean up), then
            // escalate to SIGKILL after a short grace — but only if the child
            // has not exited in the meantime (avoid killing a reused pid).
            if (child.pid) {
              if (process.platform === 'win32') {
                treeKill(child.pid, 'SIGTERM', (err) => {
                  if (err) {
                    runLogger.debug(`treeKill SIGTERM on abort failed: ${err}`);
                  }
                });
              } else {
                killHookProcessGroup(child.pid, 'SIGTERM');
              }
            }
            setTimeout(() => {
              if (processExited) return;
              if (child.pid) {
                if (process.platform === 'win32') {
                  treeKill(child.pid, 'SIGKILL', (err) => {
                    if (err) {
                      runLogger.debug(`treeKill SIGKILL grace failed: ${err}`);
                    }
                  });
                } else {
                  killHookProcessGroup(child.pid, 'SIGKILL');
                }
              }
            }, ABORT_GRACE_KILL_MS).unref();

            settleForced({
              timedOut: false,
              errorMessage: 'Hook cancelled',
              kind: 'cancelled',
            });
          };

          // Timeout: settle immediately as a timeout failure on expiry, then
          // SIGKILL the process tree. Does NOT depend on the child's exit event.
          timeoutHandle = setTimeout(() => {
            if (finalized || processExited) return;

            if (child.pid) {
              if (process.platform === 'win32') {
                treeKill(child.pid, 'SIGKILL', (err) => {
                  if (err) {
                    runLogger.debug(`treeKill failed: ${err}`);
                  }
                });
              } else {
                killHookProcessGroup(child.pid, 'SIGKILL');
              }
            }

            settleForced({
              timedOut: true,
              errorMessage: `Hook timed out after ${timeoutMs / 1000}s`,
              kind: 'timeout',
            });
          }, timeoutMs);

          // Immediate-abort check. The timeout above already assigned
          // timeoutHandle, so any later exit/error → finalize will clearTimeout
          // (no orphan timer), even if a mock fires exit synchronously on
          // registration below. The `finalized` guard is defensive. If already
          // aborted, run onAbort and bail before writing stdin / attaching data
          // listeners so we don't pump input into a doomed child.
          if (finalized) {
            return;
          }
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });

          // Send input to stdin
          if (child.stdin) {
            child.stdin.on('error', (err: NodeJS.ErrnoException) => {
              // Ignore EPIPE errors which happen when the child process closes stdin early
              if (err.code !== 'EPIPE') {
                runLogger.debug(`Hook stdin error: ${err}`);
              }
            });

            // Wrap write operations in try-catch to handle synchronous EPIPE errors
            // that occur when the child process exits before we finish writing
            try {
              child.stdin.write(JSON.stringify(input));
              child.stdin.end();
            } catch (err) {
              // Ignore EPIPE errors which happen when the child process closes stdin early
              if (
                err instanceof Error &&
                'code' in err &&
                err.code !== 'EPIPE'
              ) {
                runLogger.debug(`Hook stdin write error: ${err}`);
              }
            }
          }

          child.stdout?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            stdout += chunk;
            output += chunk;
            armProgressIntervalIfNeeded();
          });

          child.stderr?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            stderr += chunk;
            output += chunk;
            armProgressIntervalIfNeeded();
          });

          // Use 'exit' not 'close': 'close' waits for stdio to close, which
          // includes grandchild processes that inherit file descriptors (e.g.
          // `sleep 30 &`). 'exit' fires when the shell itself exits.
          child.on('exit', (exitCode) => {
            processExited = true;
            // Late event: timeout/abort already settled this hook. Do nothing
            // (no re-parse, no env-file read, no second emitResponse).
            if (finalized) return;

            const duration = Date.now() - startTime;
            // Flush any pending output BEFORE emitting the response
            // so consumers always see the tail chunks via `progress` first.
            stopProgressInterval();
            flushProgress();

            // Parse output based on exit code
            let parsedOutput: HookOutput | undefined;
            let outputFormat: 'json' | 'text' | undefined;
            const effectiveExitCode = exitCode ?? EXIT_CODE_SUCCESS;






            let schemaError: string | undefined;

            if (effectiveExitCode === EXIT_CODE_SUCCESS) {
              // Exit 0: success — three-stage parse of stdout
              const textToParse = stdout.trim();
              if (textToParse) {
                const usePlainTextOutput = () => {
                  parsedOutput = {
                    decision: 'allow',
                    stdoutContent: textToParse,
                  };
                  outputFormat = 'text';
                };

                if (
                  textToParse.startsWith('{') ||
                  textToParse.startsWith('"')
                ) {
                  try {
                    let parsed: unknown = JSON.parse(textToParse);
                    if (typeof parsed === 'string') {
                      const inner = parsed.trim();
                      parsed = inner.startsWith('{')
                        ? JSON.parse(inner)
                        : parsed;
                    }
                    if (parsed && typeof parsed === 'object') {
                      const validation = validateHookOutput(parsed);
                      if (validation.success) {
                        parsedOutput = validation.output;
                        outputFormat = 'json';
                      } else if (eventName === HookEventName.PreToolUse) {
                        runLogger.warn(
                          `PreToolUse hook output failed schema validation, denying tool: ${validation.error}`,
                        );
                        parsedOutput = {
                          decision: 'deny',
                          reason: `PreToolUse hook returned invalid JSON output: ${validation.error}`,
                          stdoutContent: textToParse,
                        };
                        outputFormat = 'json';
                      } else {
                        // Stage 3: Valid JSON but fails schema validation
                        runLogger.warn(
                          `Hook output for ${eventName} failed schema validation: ${validation.error}`,
                        );
                        const mode = options?.schemaFailureMode ?? 'strict';
                        if (mode === 'strict') {
                          // Sync command hook: surface error to user via
                          // attachment + wire `outcome: 'error'`. Stdout is
                          // NOT injected as plain text context.
                          schemaError = validation.error;
                          parsedOutput = undefined;
                          outputFormat = undefined;
                        } else {
                          // Async / asyncRewake: keep existing behaviour so
                          // pendingAsyncContexts injection in
                          // hookEventHandler keeps working unchanged.
                          usePlainTextOutput();
                        }
                      }
                    } else {
                      usePlainTextOutput();
                    }
                  } catch (parseError) {
                    if (eventName === HookEventName.PreToolUse) {
                      runLogger.warn(
                        `PreToolUse hook output is malformed JSON, denying tool: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
                      );
                      parsedOutput = {
                        decision: 'deny',
                        reason: `PreToolUse hook returned malformed JSON output: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
                        stdoutContent: textToParse,
                      };
                      outputFormat = 'json';
                    } else {
                      // Stage 3: Starts with '{' but is not valid JSON — bad JSON
                      runLogger.warn(
                        `Hook output for ${eventName} looks like JSON but failed to parse: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
                      );
                      usePlainTextOutput();
                    }
                  }
                } else {
                  // Stage 1: Plain text — convert to model-visible context.
                  runLogger.debug(
                    `[HookRunner] Hook output for ${eventName} does not start with JSON, treating as plain text. ` +
                      `First 100 chars: "${textToParse.slice(0, 100)}". ` +
                      `This may indicate shell profile pollution (.bashrc/.zshrc unconditional echo).`,
                  );
                  usePlainTextOutput();
                }
              }
            } else if (effectiveExitCode === EXIT_CODE_BLOCK) {
              // Exit 2: blocking error — stderr is feedback to model, stdout JSON ignored
              parsedOutput = {
                decision: 'deny',
                reason: stderr.trim() || 'Hook blocked with exit code 2',
              };
              outputFormat = 'text';
            } else {
              // Other exit codes (1, >2): non-blocking error — don't parse
              // stderr shown in verbose/debug, continue execution
              parsedOutput = undefined;
              outputFormat = undefined;
              // Log stderr so that hook failures are diagnosable from qwen.log
              if (stderr.trim()) {
                runLogger.warn(
                  `[HookRunner] Hook "${hookName}" (event: ${eventName}) exited with code ${effectiveExitCode}. stderr: ${stderr.trim().slice(0, 2000)}`,
                );
              } else {
                runLogger.warn(
                  `[HookRunner] Hook "${hookName}" (event: ${eventName}) exited with code ${effectiveExitCode} (no stderr output).` +
                    (stdout.trim()
                      ? ` stdout: ${stdout.trim().slice(0, 500)}`
                      : ''),
                );
              }
            }

            const reportedExitCode = schemaError ? 1 : effectiveExitCode;
            const reportedStderr = schemaError ?? stderr;
            const reportedOutcome: 'success' | 'error' = schemaError
              ? 'error'
              : effectiveExitCode === EXIT_CODE_SUCCESS
                ? 'success'
                : 'error';

            try {
              hookEvents.emitResponse({
                sessionId: this.config.getSessionId(),
                hook_id: hookId,
                hook_name: hookName,
                hook_event: eventName,
                exit_code: reportedExitCode,
                duration_ms: duration,
                outcome: reportedOutcome,
                stdout,
                stderr: reportedStderr,
                output,
              });
            } catch (err) {
              runLogger.debug(`Hook response emit failed: ${err}`);
            }

            // Invalidate session env cache so bashProvider re-reads the
            // updated env files on the next bash command.
            if (envFilePath) {
              if (effectiveExitCode !== EXIT_CODE_SUCCESS) {
                truncateEnvFile(envFilePath);
              }
              invalidateSessionEnvCache(envFileSessionId);
            }

            finalize({
              hookConfig,
              eventName,
              success: schemaError
                ? false
                : effectiveExitCode === EXIT_CODE_SUCCESS,
              outcome: schemaError ? 'non_blocking_error' : undefined,
              output: parsedOutput
                ? {
                    ...parsedOutput,
                    hookName,
                    hookCommand: hookConfig.command,
                  }
                : undefined,
              outputFormat,
              stdout,
              stderr: reportedStderr,
              exitCode: reportedExitCode,
              duration,
              failureKind: schemaError ? 'schema' : undefined,
              error: schemaError ? new Error(schemaError) : undefined,
            });
          });

          // Handle process errors
          child.on('error', (error) => {
            processExited = true;
            // Late event: timeout/abort already settled this hook.
            if (finalized) return;

            const duration = Date.now() - startTime;






            // Flush pending deltas BEFORE the error response.
            stopProgressInterval();
            flushProgress();
            try {
              hookEvents.emitResponse({
                sessionId: this.config.getSessionId(),
                hook_id: hookId,
                hook_name: hookName,
                hook_event: eventName,
                exit_code: undefined,
                duration_ms: duration,
                outcome: 'error',
                stdout,
                stderr,
                output,
              });
            } catch (err) {
              runLogger.debug(`Hook response emit failed: ${err}`);
            }
            if (envFilePath) {
              truncateEnvFile(envFilePath);
              invalidateSessionEnvCache(envFileSessionId);
            }

            finalize({
              hookConfig,
              eventName,
              success: false,
              exitCode: 1,
              error,
              stdout,
              stderr,
              duration,
              failureKind: 'spawn',
            });
          });
        });
    })();
  }

  /**
   * Two-step plugin preflight (run before spawn):
   *
   * 1. Placeholder in non-plugin hook:
   *    Plugin path placeholders referenced from a hook that has
   *    no `pluginRoot` cannot be satisfied. If we let it through, the value
   *    expands to empty and the spawned process is likely to fail with exit
   *    code 2 (a common signal for "missing script"), indistinguishable from
   *    a deliberate hook deny.
   *
   * 2. Plugin directory removed:
   *    `pluginRoot` is configured but the directory no longer exists (orphan
   *    GC race, concurrent uninstall). Same exit-2 indistinguishability rule
   *    applies — pre-check defensively.
   *
   * Both failures return a non-blocking error result (exitCode=1, error +
   * stderr set) and emit a hookEvents response so SDK consumers see the
   * failure. The exit code is intentionally NOT EXIT_CODE_BLOCK so that
   * asyncRewake and attachment-skipping downstream consumers don't mistake
   * the failure for a deny.
   *
   * Returns undefined when the hook passes preflight.
   */
  private async runPluginPreflight(
    hookConfig: CommandHookConfig,
    eventName: HookEventName,
    startTime: number,
  ): Promise<HookExecutionResult | undefined> {
    const pluginVariables = [
      ENV_PLUGIN_ROOT,
      ENV_PLUGIN_DATA,
      'CLAUDE_PLUGIN_ROOT',
      'CLAUDE_PLUGIN_DATA',
    ];

    const placeholderHit = [
      hookConfig.command,
      ...(hookConfig.args ?? []),
    ].some((s) =>
      pluginVariables.some((name) => s.includes('${' + name + '}')),
    );

    const emitFailure = (message: string): HookExecutionResult => {
      const duration = Date.now() - startTime;
      try {
        hookEvents.emitResponse({
          sessionId: this.config.getSessionId(),
          hook_id: randomUUID(),
          hook_name: getHookDisplayText(hookConfig),
          hook_event: eventName,
          exit_code: 1,
          duration_ms: duration,
          outcome: 'error',
          stdout: '',
          stderr: message,
          output: message,
        });
      } catch (err) {
        runLogger.debug(`Hook preflight response emit failed: ${err}`);
      }
      return {
        hookConfig,
        eventName,
        success: false,
        error: new Error(message),
        stdout: '',
        stderr: message,
        exitCode: 1,
        duration,
      };
    };

    // Check 1: placeholder used outside a plugin context.
    if (placeholderHit && !hookConfig.pluginRoot) {
      return emitFailure(
        `Hook references \${${ENV_PLUGIN_ROOT}}/\${${ENV_PLUGIN_DATA}} but is ` +
          `not associated with a plugin. This variable is only available in ` +
          `hooks defined in a plugin's hooks/hooks.json file, not in ` +
          `settings.json. Command: ${hookConfig.command}`,
      );
    }

    // Check 2: plugin root directory missing.
    // Run before getPluginDataDir() (which mkdirSyncs) and before expandCommand,
    // so a stale pluginRoot can't silently produce empty paths.
    if (hookConfig.pluginRoot) {
      let isDir = false;
      try {
        isDir = (await fsStat(hookConfig.pluginRoot)).isDirectory();
      } catch {
        // ENOENT or permission denied → treat as missing
      }
      if (!isDir) {
        const idHint = hookConfig.pluginId
          ? ` (${hookConfig.pluginId} — run /plugin to reinstall)`
          : '';
        const message = `Plugin directory does not exist: ${hookConfig.pluginRoot}${idHint}`;
        return emitFailure(message);
      }
    }

    return undefined;
  }

  /**
   * Expand command with placeholder substitutions (pwsh shell-form only).
   *
   * Bash shell-form does NOT inline-substitute placeholders: the values are
   * exported as env vars (see env setup above) and bash expands them itself.
   * This follows POSIX: unquoted parameter expansion is not re-lexed, so a
   * plugin root path containing shell metacharacters (single quotes, `$`,
   * backticks, etc.) is treated as a literal value rather than re-parsed as
   * code.
   *
   * PowerShell shell-form inlines `${...}` placeholders because pwsh env-var
   * expansion uses `$env:NAME` syntax — leaving a plugin-root variable literal
   * would not expand under pwsh. Plugin paths are trusted (controlled by the
   * plugin install machinery) so direct substitution is safe.
   *
   * The branded project-dir variable and its upstream alias are NOT substituted in
   * bash shell-form (env var passthrough) for the same data/code-separation
   * reason. Under pwsh, project-dir inlining is gated on Commit C.
   *
   * On Windows under bash, env-var values are converted to POSIX form so bash
   * doesn't interpret backslashes as escape characters.
   */
  private expandCommand(
    command: string,
    input: HookInput,
    shellType: ShellType,
    hookConfig: CommandHookConfig,
    pluginDataDir?: string,
  ): string {
    runLogger.debug(`Expanding hook command: ${command} (cwd: ${input.cwd})`);

    // Bash shell-form: env var passthrough. Bash will expand ${...} itself
    // from the env vars injected in executeHookImpl. JS-layer substitution
    // would feed the expansion result back into bash's lexer, mishandling
    // values that contain shell metacharacters (`'`, `"`, `` ` ``, `$(...)`).
    if (shellType !== 'powershell') {
      return command;
    }
    return this.replacePlaceholders(
      command,
      hookConfig,
      pluginDataDir,
      getHookPathConverter(shellType),
    );
  }

  /**
   * Exec-form token expansion: substitute placeholders directly into a single
   * argv token without shell involvement. Native paths are used (no POSIX
   * conversion) because the value goes straight to `spawn(... { shell: false })`.
   * cwd injection vectors don't apply — no shell, no parsing.
   */
  private expandTokenForExec(
    token: string,
    hookConfig: CommandHookConfig,
    pluginDataDir?: string,
  ): string {
    return this.replacePlaceholders(token, hookConfig, pluginDataDir, (p) => p);
  }

  /** Shared substitution body used by expandCommand (pwsh) and expandTokenForExec. */
  private replacePlaceholders(
    s: string,
    hookConfig: CommandHookConfig,
    pluginDataDir: string | undefined,
    toPath: (p: string) => string,
  ): string {
    const replacements = new Map<string, string>();
    const projectDir = toPath(this.config.getSessionArtifactProjectRoot());
    replacements.set('${' + ENV_PROJECT_DIR + '}', projectDir);
    replacements.set('${CLAUDE_PROJECT_DIR}', projectDir);
    if (hookConfig.pluginRoot) {
      const root = toPath(hookConfig.pluginRoot);
      replacements.set('${' + ENV_PLUGIN_ROOT + '}', root);
      replacements.set('${CLAUDE_PLUGIN_ROOT}', root);
    }
    if (pluginDataDir) {
      const data = toPath(pluginDataDir);
      replacements.set('${' + ENV_PLUGIN_DATA + '}', data);
      replacements.set('${CLAUDE_PLUGIN_DATA}', data);
    }
    return s.replace(
      /\$\{[^{}]+\}/g,
      (match) => replacements.get(match) ?? match,
    );
  }
}
