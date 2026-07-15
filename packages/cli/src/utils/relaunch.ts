/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import {
  RELAUNCH_EXIT_CODE,
  UPDATE_ON_EXIT_MESSAGE,
  UPDATE_RELAUNCH_EXIT_CODE,
} from './processUtils.js';
import { writeStderrLine } from './stdioHelpers.js';

interface RelaunchOptions {
  afterSpawn?: () => void;
  childEnv?: Readonly<Record<string, string>>;
  onUpdateRelaunch?: () => Promise<number> | number;
}

export async function relaunchOnExitCode(
  runner: () => Promise<number>,
  options?: Pick<RelaunchOptions, 'onUpdateRelaunch'>,
) {
  while (true) {
    try {
      const exitCode = await runner();

      if (exitCode === UPDATE_RELAUNCH_EXIT_CODE && options?.onUpdateRelaunch) {
        const updatedExitCode = await options.onUpdateRelaunch();
        process.exit(updatedExitCode);
      }

      if (exitCode !== RELAUNCH_EXIT_CODE) {
        process.exit(exitCode);
      }
    } catch (error) {
      process.stdin.resume();
      writeStderrLine('Fatal error: Failed to relaunch the CLI process.');
      writeStderrLine(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
}

export async function relaunchAppInChildProcess(
  additionalNodeArgs: string[],
  additionalScriptArgs: string[],
  options?: RelaunchOptions,
) {
  if (process.env['QWEN_CODE_NO_RELAUNCH']) {
    return;
  }

  const runner = () => {
    let updateOnExitRequested = false;

    // process.argv is [node, script, ...args]
    // We want to construct [ ...nodeArgs, script, ...scriptArgs]
    const script = process.argv[1];
    const scriptArgs = process.argv.slice(2);

    const nodeArgs = [
      ...process.execArgv,
      ...additionalNodeArgs,
      script,
      ...additionalScriptArgs,
      ...scriptArgs,
    ];
    const newEnv = {
      ...process.env,
      ...options?.childEnv,
      QWEN_CODE_NO_RELAUNCH: 'true',
    };

    // The parent process should not be reading from stdin while the child is running.
    process.stdin.pause();

    const child = spawn(process.execPath, nodeArgs, {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: newEnv,
    });

    child.on('message', (message) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === UPDATE_ON_EXIT_MESSAGE
      ) {
        updateOnExitRequested = true;
      }
    });

    // Allow the parent to clean up process.env after spawn copies it
    // but before the next relaunch iteration.
    try {
      options?.afterSpawn?.();
    } catch (err) {
      child.kill();
      throw err;
    }

    return new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        // Resume stdin before the parent process exits.
        process.stdin.resume();
        const exitCode = code ?? 1;
        if (
          exitCode === 0 &&
          updateOnExitRequested &&
          options?.onUpdateRelaunch
        ) {
          updateOnExitRequested = false;
          void Promise.resolve(options.onUpdateRelaunch()).then(
            (updatedExitCode) => resolve(updatedExitCode),
            reject,
          );
          return;
        }
        resolve(exitCode);
      });
    });
  };

  await relaunchOnExitCode(runner, options);
}
