/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import {
  RELAUNCH_EXIT_CODE,
  UPDATE_RELAUNCH_EXIT_CODE,
} from './processUtils.js';
import { writeStderrLine } from './stdioHelpers.js';

interface RelaunchOptions {
  afterSpawn?: () => void;
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
    const newEnv: NodeJS.ProcessEnv = {
      ...process.env,
      QWEN_CODE_NO_RELAUNCH: 'true',
    };
    if (newEnv['QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE'] === '1') {
      newEnv['ELECTRON_RUN_AS_NODE'] = '1';
    }

    // The parent process should not be reading from stdin while the child is running.
    process.stdin.pause();

    const child = spawn(process.execPath, nodeArgs, {
      stdio: 'inherit',
      env: newEnv,
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
        resolve(code ?? 1);
      });
    });
  };

  await relaunchOnExitCode(runner, options);
}
