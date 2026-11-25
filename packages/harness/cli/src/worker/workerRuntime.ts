/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort, workerData } from 'node:worker_threads';
import { applyConfigDirFlagFromArgv } from '../config/configDirFlag.js';
import { initializeSessionConfigHome } from '../startup/sessionConfigHome.js';
import type { CliOptions } from '../startup/runCli.js';

/** worker 宿主握手：请求关闭与回执的消息类型（中立契约）。 */
export const WORKER_CLOSE_REQUEST = 'runtime.close';
export const WORKER_CLOSING_RESPONSE = 'runtime.closing';

/** 产品把自身错误形态转译成 CLI 的致命错误；缺省原样透传。 */
type TranslateFatalError = NonNullable<CliOptions['translateFatalError']>;

/**
 * 宿主对 worker 启动契约的适配。缺省即中立契约，产品宿主可翻译成自己的 wire 形状。
 */
export interface WorkerLaunchOverrides {
  /** 覆盖 worker_threads 的 workerData（例如翻译成 { workerRuntime: { cwd } }）。 */
  readonly workerData?: unknown;
  /** 宿主请求关闭的消息类型。 */
  readonly closeRequestType?: string;
  /** worker 回执关闭的消息类型。 */
  readonly closingResponseType?: string;
}

async function handleFatalStartupError(
  error: unknown,
  translateFatalError?: TranslateFatalError,
): Promise<never> {
  const [
    {
      FatalAuthenticationError,
      FatalCancellationError,
      FatalConfigError,
      FatalError,
      FatalInputError,
      sessionLogger,
      writeToStderr,
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
    writeToStderr(`${errorMessage}\n`);

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
      source: 'workerRuntime.main.catch',
      error_name: displayError.name,
      error_stack: displayError.stack,
    });
    return gracefulExit(displayError.exitCode, {
      exitReason: 'error',
    });
  }

  writeToStderr('An unexpected critical error occurred:');
  if (error instanceof Error) {
    writeToStderr(`${error.stack}\n`);
  } else {
    writeToStderr(`${String(error)}\n`);
  }
  sessionLogger.setExitContext({
    reason: 'uncaught_exception',
    exit_code: 1,
    message: 'An unexpected critical error occurred in worker runtime main()',
    source: 'workerRuntime.main.catch',
    error_name: error instanceof Error ? error.name : undefined,
    error_stack: error instanceof Error ? error.stack : undefined,
  });
  return gracefulExit(1, { exitReason: 'error' });
}

async function run(
  options: CliOptions,
  launch: WorkerLaunchOverrides | undefined,
): Promise<void> {
  const { installWorkerCwdShim } = await import('./workerCwdShim.js');
  try {
    installWorkerCwdShim({ workerData: launch?.workerData ?? workerData });
  } catch (error) {
    process.stderr.write(
      `[worker-runtime] Failed to initialize worker cwd: ${
        error instanceof Error ? error.message : String(error)
      }
`,
    );
    process.exit(1);
  }

  // Worker cwd must be installed before Core consumers capture process paths.
  await initializeSessionConfigHome();
  const { traceStartupStepAsync, enableDetachedProcessGuard } = await import(
    '@qwen-code/core'
  );
  enableDetachedProcessGuard();
  const { main } = await traceStartupStepAsync(
    'worker.import_main',
    () => import('../qwen.js'),
  );
  await main(options);
}

/** Supports both Node Worker threads and SDK daemon child processes. */
export async function runWorkerCli(
  options: CliOptions = {},
  launch?: WorkerLaunchOverrides,
): Promise<void> {
  applyConfigDirFlagFromArgv(process.argv);
  let closing = false;
  const closeFromHost = (message: unknown): void => {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      message.type !== (launch?.closeRequestType ?? WORKER_CLOSE_REQUEST)
    )
      return;
    if (closing) return;
    closing = true;
    void import('../utils/cleanup.js')
      .then(({ gracefulExit, getExitCleanupTimeoutMs }) => {
        parentPort?.postMessage({
          type: launch?.closingResponseType ?? WORKER_CLOSING_RESPONSE,
          timeoutMs: getExitCleanupTimeoutMs(),
        });
        return gracefulExit(
          typeof process.exitCode === 'number' ? process.exitCode : 0,
          { exitReason: 'natural_end' },
        );
      })
      .catch(async (error: unknown) => {
        // The cleanup module itself may have failed to load. Do not create an
        // unobserved rejection or report successful shutdown to the host.
        try {
          const { runLogger } = await import('@qwen-code/core');
          runLogger.error('[worker-runtime] host shutdown failed', {
            error,
          });
        } finally {
          process.exit(1);
        }
      });
  };
  parentPort?.on('message', closeFromHost);
  parentPort?.unref();
  try {
    await run(options, launch);
  } catch (error) {
    await handleFatalStartupError(error, options.translateFatalError);
  }
}
