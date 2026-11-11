/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  traceStartupStep,
  traceStartupStepAsync,
  configureDefaultCertificateStore,
  ensureLocalFilesGitignored,
  ExitCodes,
  type ExitContext,
  getConfigHomeDir,
  isAbortError,
  isAbortErrorDeep,
  isNodeError,
  isRetryableNetworkError,
  patchStdio,
  runLogger,
  sessionLogger,
  setCwd,
  setOriginalCwd,
  setShellCwd,
  setDefaultAuthType,
  type AuthType,
  startOomDiagnostics,
  writeToStderr,
} from '@qwen-code/core';

import { CommanderError } from '@commander-js/extra-typings';

import * as cliConfig from './config/config.js';
import { setDefaultThemeNames } from './ui/themes/theme-manager.js';
import { createCommand } from './commands/index.js';
import {
  createFramework,
  type StartFramework,
} from './startup/frameworkFactory.js';
import type { EntryFramework } from './framework/entryFramework.js';
import type { FrameworkMode } from './framework/appFramework.js';
import { createCliSettingsService } from './config/createCliSettingsService.js';
import type { CliOptions } from './startup/runCli.js';
import { registerApplicationLifecycle } from './utils/cleanup.js';
import {
  RootCommandExecutionError,
  StartupInputError,
  emitStartupError,
} from './config/startupInputError.js';
import {
  markProcessStart,
  startParseArgsTimer,
  stopParseArgsTimer,
} from './utils/processStartClock.js';
import * as fs from 'node:fs';
import { setDefaultSettingSourcesForProcess } from './config/settings.js';
import {
  eagerParseSettingsFlag,
  eagerParseSettingSourcesFlag,
  loadSettingsFromFlag,
} from './config/flagSettings.js';
import { prefetchStartupWarnings } from './utils/startupWarnings.js';
import { initializeOutputListenersAndFlush } from './utils/outputListeners.js';
import {
  registerCleanup,
  registerSyncCleanup,
  runExitCleanupWithTimeout,
  setupSignalHandlers,
} from './utils/cleanup.js';
import { SlashCommandConflictHandler } from './services/SlashCommandConflictHandler.js';

const EARLY_CWD_FLAGS = new Set(['-w', '--cwd', '--workspace']);
function eagerParseCwdFlag(rawArgs: string[] = process.argv.slice(2)) {
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--') break;

    const eqIndex = arg.indexOf('=');
    const flagName = eqIndex >= 0 ? arg.slice(0, eqIndex) : arg;
    if (!EARLY_CWD_FLAGS.has(flagName)) {
      continue;
    }

    if (eqIndex >= 0) {
      const value = arg.slice(eqIndex + 1);
      return value || undefined;
    }

    const next = rawArgs[i + 1];
    if (!next || next.startsWith('-')) {
      return undefined;
    }
    return next;
  }

  return cliConfig.getWorkingDirFromEnv();
}

// Startup flags that should be matched case-insensitively. Commander.js treats
// long options as case-sensitive by default, so we normalize the raw argv
// before parsing to honor variants like --YOLO, --Yolo, --YoLo → --yolo.
//
// Keep this list small and explicit — only add flags where case-insensitivity
// is an actual user-facing convenience.
const CASE_INSENSITIVE_STARTUP_FLAGS = new Set<string>(['--yolo']);

// Replaces any case-variant of a registered case-insensitive flag with its
// canonical lowercase form. Leaves all other args untouched.
function normalizeStartupFlagCase(argv: readonly string[]): string[] {
  return argv.map((arg) => {
    if (!arg.startsWith('--')) return arg;
    const lower = arg.toLowerCase();
    return CASE_INSENSITIVE_STARTUP_FLAGS.has(lower) ? lower : arg;
  });
}

/**
 * Ends the process the way a startup failure must: flush cleanup, record why
 * the process is exiting so diagnostic logs keep the cause, then exit. Returns
 * `never`, so a caller can use it as the tail of a branch.
 */
async function exitAfterCleanup(
  context: ExitContext & { exit_code: number },
): Promise<never> {
  await runExitCleanupWithTimeout();
  sessionLogger.setExitContext(context);
  process.exit(context.exit_code);
}

async function chdirOrExit(cwd: string): Promise<void> {
  try {
    process.chdir(cwd);
    const resolved = process.cwd();
    setCwd(resolved);
    setOriginalCwd(resolved);
    syncShellCwdToProcess();
  } catch (error) {
    writeToStderr(
      `Error: Cannot change directory to ${cwd}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    await exitAfterCleanup({
      reason: 'input_error',
      exit_code: ExitCodes.FATAL_INPUT_ERROR,
      message: `Cannot change directory to ${cwd}`,
      source: 'gemini.chdirOrExit',
    });
  }
}

function syncShellCwdToProcess(): void {
  setShellCwd(process.cwd());
}
// Background cancellations and network faults are expected rejections.
function isBenignBackgroundRejection(reason: unknown): boolean {
  // isRetryableNetworkError covers error codes (ECONNRESET, EPIPE, etc.),
  // cause-chain traversal, and message patterns (fetch failed, socket closed).
  // It is checked first: it walks a bounded cause chain, while isAbortErrorDeep
  // recurses over the whole error graph, and network faults dominate here.
  return isRetryableNetworkError(reason) || isAbortErrorDeep(reason);
}

// Match only undici's response-body cancellation error at the process boundary.
function isUndiciResponseBodyAbort(error: unknown): boolean {
  return (
    isAbortError(error) &&
    isNodeError(error) &&
    error.code === 'UND_ERR_ABORTED'
  );
}

// Preserve the documented node-pty resize race on Windows as non-fatal.
function isKnownWindowsPtyResizeRace(error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    error instanceof Error &&
    error.message === 'Cannot resize a pty that has already exited'
  );
}

export function setupUnhandledRejectionHandler() {
  process.on('uncaughtException', (error) => {
    // A response-body cancellation can surface as an AbortError if a transport
    // loses its error listener while being destroyed. Keep that cancellation
    // non-fatal, but do not infer that other uncaught network errors are safe:
    // their error code alone does not prove they came from a background task.
    if (
      isUndiciResponseBodyAbort(error) ||
      isKnownWindowsPtyResizeRace(error)
    ) {
      runLogger.warn(
        `[uncaughtException] Cancelled error (non-fatal): ${error.message}`,
      );
      return;
    }

    const errorMessage = `[uncaughtException] ${error instanceof Error ? error.message : String(error)}`;
    runLogger.error(errorMessage);
    if (error instanceof Error && error.stack) {
      runLogger.error(error.stack);
    }

    sessionLogger.setExitContext({
      reason: 'uncaught_exception',
      exit_code: 1,
      message: errorMessage,
      error_name: error instanceof Error ? error.name : 'UnknownError',
      error_stack: error instanceof Error ? error.stack : undefined,
      source: 'gemini.uncaughtException',
    });
  });
  process.on('unhandledRejection', (reason, _promise) => {
    // Network errors and cancellations from background fetches are non-fatal —
    // log as warning without scaring the user or opening debug console.
    if (isBenignBackgroundRejection(reason)) {
      runLogger.warn(
        `[unhandledRejection] Cancelled or network error (non-fatal): ${reason instanceof Error ? reason.message : String(reason)}`,
      );
      return;
    }

    const errorMessage = `[unhandledRejection] ${reason instanceof Error ? reason.message : String(reason)}`;
    runLogger.error(errorMessage);
    if (reason instanceof Error && reason.stack) {
      runLogger.error(reason.stack);
    }

    sessionLogger.setExitContext({
      reason: 'unhandled_rejection',
      exit_code: 1,
      message: errorMessage,
      error_name: reason instanceof Error ? reason.name : 'UnknownError',
      error_stack: reason instanceof Error ? reason.stack : undefined,
      source: 'gemini.unhandledRejection',
    });
  });
}

export async function main(options: CliOptions = {}): Promise<void> {
  // The CLI entry defaults to Qoder OAuth; commercial entries keep the
  // built-in Qoder browser/PAT fallback.
  if (options.defaultAuthType) {
    setDefaultAuthType(options.defaultAuthType as AuthType);
  }
  if (options.defaultThemePair) {
    setDefaultThemeNames(options.defaultThemePair);
  }
  // Framework 管应用资源；退出先取消未完成的准备，等会话收尾结束后再释放共享组件。
  const controller = new AbortController();
  let framework: EntryFramework | undefined;
  let starting: Promise<EntryFramework> | undefined;
  // Cleanup is registered before settings exist, including failures during early startup.
  // eslint-disable-next-line prefer-const
  let settingsService: ReturnType<typeof createCliSettingsService> | undefined;
  // Assigned after cwd/flag setup; cleanup must also cover earlier failures.
  // eslint-disable-next-line prefer-const
  let preparingSettings: Promise<void> | undefined;
  let restoreSettingsPolicy: (() => void) | undefined;
  registerApplicationLifecycle({
    cancelInitialization: () => controller.abort(),
    dispose: async () => {
      const failures: unknown[] = [];
      for (const dispose of [
        async () => {
          await starting?.catch(() => {});
          await framework?.dispose();
        },
        () => settingsService?.dispose(),
        async () => {
          await preparingSettings?.catch(() => {});
          restoreSettingsPolicy?.();
        },
      ]) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Application cleanup failed');
    },
  });
  configureDefaultCertificateStore();

  // Eagerly ensure the user-level config directory exists (e.g. ~/.qwen)
  // so that downstream lazy-creation paths don't silently fail.
  const configDir = getConfigHomeDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  startOomDiagnostics();

  markProcessStart();
  sessionLogger.event({
    level: 'info',
    kind: 'cli',
    type: 'cli.main.started',
  });

  // Without an error listener, a detached/revoked terminal emits EIO and Node
  // throws it as an unhandled 'error' event, crashing the process.
  const stdinErrorHandler = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EIO' || err.code === 'EBADF') return;
    runLogger.warn(`Unexpected stdin error: ${err.message}`);
  };
  process.stdin.on('error', stdinErrorHandler);
  registerSyncCleanup(() =>
    process.stdin.removeListener('error', stdinErrorHandler),
  );

  const cleanupStdio = patchStdio();
  registerSyncCleanup(() => {
    // ACP writes through its protocol connection. Replaying buffered terminal
    // output here would append non-JSON text after the last JSON-RPC response.
    if (framework?.mode !== 'acp') {
      initializeOutputListenersAndFlush();
    }
    cleanupStdio();
  });

  setupUnhandledRejectionHandler();

  setupSignalHandlers();

  const slashCommandConflictHandler = new SlashCommandConflictHandler();
  slashCommandConflictHandler.start();
  registerCleanup(() => slashCommandConflictHandler.stop());

  // Parse --settings flag before loadSettings() so the flag-provided file is
  // merged into the load chain.
  const flagSettingsValue = eagerParseSettingsFlag();
  if (flagSettingsValue !== undefined) {
    traceStartupStep('main.flag_settings', () =>
      loadSettingsFromFlag(flagSettingsValue),
    );
  }

  // --cwd / --workspace influences project settings, local settings, and env
  // loading, so apply it before loadSettings() reads anything from disk.
  const earlyCwd = eagerParseCwdFlag();
  if (earlyCwd) {
    await traceStartupStepAsync('main.resolve_cwd', () =>
      chdirOrExit(earlyCwd),
    );
  }
  const earlySettingSources = eagerParseSettingSourcesFlag();
  setDefaultSettingSourcesForProcess(earlySettingSources);

  // Building the command tree and running the matched command are one step:
  // subcommands do their work in their own action, and the root command's
  // action owns the startup tail (handleRootCommand), so parseAsync resolves
  // only once the matched command has finished. The parse timer is therefore
  // stopped by whichever action runs; stopping it below is the safety net for
  // argv that never reaches an action (--help, --version, bad flags).
  startParseArgsTimer();
  preparingSettings = Promise.resolve().then(async () => {
    restoreSettingsPolicy = await options.prepareSettings?.();
  });
  await preparingSettings;
  controller.signal.throwIfAborted();
  settingsService = createCliSettingsService({ environmentPolicy: 'session' });
  const declarations =
    (await options.declarations?.(() => {
      if (!framework) throw new Error('Command runtime has not started');
      return framework;
    })) ?? [];
  let selectedMode: FrameworkMode | undefined;
  const startFramework: StartFramework = (mode, input) => {
    if (selectedMode && selectedMode !== mode)
      throw new Error('Cannot switch entry framework');
    controller.signal.throwIfAborted();
    selectedMode = mode;
    starting ??= (async () => {
      framework = await traceStartupStepAsync(
        'main.create_framework',
        async () =>
          (options.createFramework ?? createFramework)(
            controller.signal,
            settingsService!,
            mode,
            input,
          ),
      );
      controller.signal.throwIfAborted();
      await framework.init();
      return framework;
    })();
    return starting;
  };
  const program = await traceStartupStepAsync('main.command_tree', () =>
    createCommand(settingsService!, declarations, startFramework),
  );
  // 命令树负责加载 Settings/.env 以发现外部命令；若位置参数最终是根命令
  // prompt，则在其 action 中确认 Resume 资源根，再合并环境参数默认值。
  void ensureLocalFilesGitignored();
  prefetchStartupWarnings();
  try {
    await program.parseAsync(normalizeStartupFlagCase(process.argv));
  } catch (e) {
    // The root command's own failure is not an argv problem: rethrow it so the
    // entry point's handler maps FatalError subclasses to their exit codes
    // instead of the generic parse-error epilogue below.
    if (e instanceof RootCommandExecutionError) {
      throw e.reason;
    }
    // commander throws these only after it has already printed what was asked
    // for, so they are successful exits.
    if (
      e instanceof CommanderError &&
      (e.code === 'commander.helpDisplayed' || e.code === 'commander.version')
    ) {
      await exitAfterCleanup({
        reason: 'success',
        exit_code: 0,
        message:
          e.code === 'commander.version'
            ? 'Displayed version'
            : 'Displayed help',
        source: 'gemini.main',
      });
    }
    // A StartupInputError was already reported to the user by whoever rejected
    // the argv; every other error arrives here unannounced and needs printing.
    const msg = e instanceof Error ? e.message : String(e);
    const alreadyReported = e instanceof StartupInputError;
    if (!alreadyReported) {
      emitStartupError(msg);
    }
    await exitAfterCleanup({
      reason: 'input_error',
      exit_code: 1,
      message: alreadyReported ? msg : `Argument parsing failed: ${msg}`,
      source: 'gemini.main',
      error_name: e instanceof Error ? e.name : undefined,
      error_stack: e instanceof Error ? e.stack : undefined,
    });
  } finally {
    stopParseArgsTimer();
  }
}
