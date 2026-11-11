/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { checkWorkingDirectory } from './checkWorkingDirectory.js';
import { initializeSessionConfigHome } from './sessionConfigHome.js';
import { applyConfigDirFlagFromArgv } from '../config/configDirFlag.js';

import type { AppPlugin } from '../app-plugins/types.js';
import type { EntryFramework } from '../framework/entryFramework.js';
import type { CliFrameworkFactory } from './frameworkFactory.js';

/** Dependencies supplied directly by the product entry; omitted fields use public defaults. */
export interface CliOptions {
  /** CLI entry selects `qoder-oauth`; commercial entries keep the Qoder default. */
  defaultAuthType?: string;
  /** Product default themes used when ui.theme is unset or auto. */
  defaultThemePair?: { readonly dark?: string; readonly light?: string };
  prepareSettings?: () => (() => void) | Promise<() => void>;
  declarations?: (
    getFramework: () => EntryFramework,
  ) =>
    | ReadonlyArray<
        Pick<
          AppPlugin,
          'getTerminalCommands' | 'getRootOptions' | 'resolveTerminalCommands'
        >
      >
    | Promise<
        ReadonlyArray<
          Pick<
            AppPlugin,
            'getTerminalCommands' | 'getRootOptions' | 'resolveTerminalCommands'
          >
        >
      >;
  createFramework?: CliFrameworkFactory;
  /**
   * 产品把自身错误形态转译成 CLI 的致命错误。未提供时原样透传——CLI 不认识
   * 任何产品的认证或领域错误类型。异步是为了让产品按需加载自己的模块。
   */
  translateFatalError?: (error: unknown) => unknown | Promise<unknown>;
}

async function handleMainError(
  error: unknown,
  translateFatalError?: (error: unknown) => unknown | Promise<unknown>,
): Promise<never> {
  const [
    {
      FatalError,
      FatalAuthenticationError,
      FatalInputError,
      FatalConfigError,
      FatalCancellationError,
      writeToStderr,
      sessionLogger,
    },
    { gracefulExit },
  ] = await Promise.all([
    import('@qwen-code/core'),
    import('../utils/cleanup.js'),
  ]);

  const displayError = translateFatalError
    ? await translateFatalError(error)
    : error;

  if (displayError instanceof FatalError) {
    let errorMessage = displayError.message;
    if (!process.env['NO_COLOR']) {
      errorMessage = `\x1b[31m${errorMessage}\x1b[0m`;
    }
    writeToStderr(errorMessage + '\n');

    // Map FatalError subclasses to specific exit reasons
    let reason:
      | 'auth_error'
      | 'input_error'
      | 'config_error'
      | 'cancelled'
      | 'fatal_error' = 'fatal_error';
    if (displayError instanceof FatalAuthenticationError) {
      reason = 'auth_error';
    } else if (displayError instanceof FatalInputError) {
      reason = 'input_error';
    } else if (displayError instanceof FatalConfigError) {
      reason = 'config_error';
    } else if (displayError instanceof FatalCancellationError) {
      reason = 'cancelled';
    }

    sessionLogger.setExitContext({
      reason,
      exit_code: displayError.exitCode,
      message: displayError.message,
      source: 'index.main.catch',
      error_name: displayError.name,
      error_stack: displayError.stack,
    });
    return gracefulExit(displayError.exitCode, {
      exitReason:
        displayError instanceof FatalCancellationError ? 'user_quit' : 'error',
    });
  }

  writeToStderr('An unexpected critical error occurred:');
  if (error instanceof Error) {
    writeToStderr(error.stack + '\n');
  } else {
    writeToStderr(String(error) + '\n');
  }
  sessionLogger.setExitContext({
    reason: 'uncaught_exception',
    exit_code: 1,
    message: 'An unexpected critical error occurred in main()',
    source: 'index.main.catch',
    error_name: error instanceof Error ? error.name : undefined,
    error_stack: error instanceof Error ? error.stack : undefined,
  });
  return gracefulExit(1, { exitReason: 'error' });
}

/** Resolve process configuration before importing Core or product modules. */
export async function runCli(options: CliOptions = {}): Promise<void> {
  if (process.argv[2] === '--internal-process-guard') {
    const { DETACHED_PROCESS_GUARD_SOURCE } = await import(
      '../../../core/src/services/detachedProcessGuard.js'
    );
    new Function(DETACHED_PROCESS_GUARD_SOURCE)();
    return;
  }
  if (!checkWorkingDirectory()) return;
  applyConfigDirFlagFromArgv(process.argv);
  try {
    await initializeSessionConfigHome();
    const { main } = await import('../qwen.js');
    await main(options);
  } catch (error) {
    await handleMainError(error, options.translateFatalError);
  }
}
