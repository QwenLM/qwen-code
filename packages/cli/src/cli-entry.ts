/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  statSync,
} from 'node:fs';
import { clearInheritedPeerMessagingEnv } from './peerMessaging/env.js';
import { installBundledChunkResolver } from './utils/bundled-chunk-resolver.js';
import { initCpuProfiler } from './utils/cpuProfiler.js';
import { CHECKED_NODE_VERSION_ENV } from './utils/env-provenance.js';
import { normalizeServeFastPathArgv } from './utils/serve-fast-path-argv.js';
import { initStartupProfiler } from './utils/startupProfiler.js';
import { writeStderrLine } from './utils/stdioHelpers.js';
import { handleUncaughtException } from './utils/uncaught-exception-handler.js';

// Capture the profiling baseline before route-specific imports.
initStartupProfiler();
initCpuProfiler();

export async function tryRunServeEntry(
  argv: readonly string[],
  entryUrl: string,
): Promise<boolean> {
  installBundledChunkResolver(entryUrl);
  const { tryRunServeFastPath } = await import('./serve/fast-path.js');
  return tryRunServeFastPath(argv);
}

export async function dispatchCliStartup(
  rawArgv: readonly string[],
  entryUrl: string,
): Promise<void> {
  const argv = normalizeServeFastPathArgv(rawArgv);
  // The general dispatcher owns exact version-token precedence and managed
  // updates. The serve parser also delegates help and unrecognized flags.
  if (
    argv[0] === 'serve' &&
    !process.env['QWEN_CODE_MANAGED_NPM_UPDATE_VERSION'] &&
    !argv.some((arg) => arg === '--version' || arg === '-v')
  ) {
    clearInheritedPeerMessagingEnv();
    if (await tryRunServeEntry(argv, entryUrl)) return;

    const { runFullCliStartup } = await import('./cli.js');
    return runFullCliStartup(rawArgv, entryUrl, true);
  }

  const { runCliEntry } = await import('./cli.js');
  return runCliEntry(rawArgv, entryUrl);
}

/**
 * Tool shells should run this build. For workspace builds the shebang is in
 * dist/index.js, which tsc emits without execute bits. Outer launchers can
 * supply their own entry, e.g. a standalone shim that selects bundled Node.
 */
export function stampCliEntryEnv(entryPath?: string): void {
  if (process.env['QWEN_CODE_CLI'] || !entryPath || !existsSync(entryPath)) {
    return;
  }
  try {
    accessSync(entryPath, constants.X_OK);
  } catch {
    try {
      chmodSync(entryPath, statSync(entryPath).mode | 0o111);
    } catch {
      // The spawn filter falls back to qwen on PATH for a read-only checkout.
    }
  }
  process.env['QWEN_CODE_CLI'] = entryPath;
}

async function handleStartupError(error: unknown): Promise<void> {
  const { handleCriticalError } = await import('./cli.js');
  await handleCriticalError(error);
}

export async function runCliEntryPoint(
  run: () => Promise<void>,
  handleError: (error: unknown) => Promise<void> = handleStartupError,
  entryPath?: string,
): Promise<void> {
  stampCliEntryEnv(entryPath);

  // Consume the relaunch marker so later tool subprocesses get their own check.
  const checkedNodeVersion = process.env[CHECKED_NODE_VERSION_ENV];
  delete process.env[CHECKED_NODE_VERSION_ENV];
  const nodeVersion = process.versions.node;
  // Bounded risk ranges based on #15165 reproductions, not every patch tested.
  if (
    !process.versions['bun'] &&
    checkedNodeVersion !== nodeVersion &&
    /^(24|25)\./.test(nodeVersion)
  ) {
    const { default: semver } = await import('semver');
    if (
      semver.satisfies(nodeVersion, '>=24.0.0 <=24.22.1 || >=25.0.0 <=25.9.0')
    ) {
      writeStderrLine(
        `Warning: Node.js ${nodeVersion} can cause high temporary memory usage during shell safety checks. ` +
          'Upgrade to Node.js 26.12.1. Qwen Code will continue normally. ' +
          'See https://github.com/QwenLM/qwen-code/issues/15165',
      );
    }
  }

  process.on('uncaughtException', handleUncaughtException);

  try {
    await run();
  } catch (error) {
    try {
      await handleError(error);
    } catch (handlerError) {
      writeStderrLine('An unexpected critical error occurred:');
      writeStderrLine('Original error:');
      if (error instanceof Error) {
        writeStderrLine(error.stack ?? error.message);
      } else {
        writeStderrLine(String(error));
      }
      writeStderrLine('Error handler failed:');
      if (handlerError instanceof Error) {
        writeStderrLine(handlerError.stack ?? handlerError.message);
      } else {
        writeStderrLine(String(handlerError));
      }
      process.exit(1);
    }
  }
}
