/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { isatty } from 'node:tty';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import {
  RELAUNCH_EXIT_CODE,
  UPDATE_ON_EXIT_MESSAGE,
  UPDATE_RELAUNCH_EXIT_CODE,
  getRelaunchExecArgv,
} from './processUtils.js';
import { runExitCleanup } from './cleanup.js';
import { RELAUNCH_SUPERVISED_ENV } from './env-provenance.js';
import { writeStderrLine } from './stdioHelpers.js';

const debugLogger = createDebugLogger('RELAUNCH');

// How long a supervised child may run on once its supervisor is gone: longer
// than ACP's own shutdown (SessionEnd hooks, MCP pool and session drains, exit
// cleanup), which the host starts by signalling the process group or closing
// the child's input.
const ORPHAN_GRACE_MS = 120_000;

interface RelaunchOptions {
  afterSpawn?: () => void;
  childEnv?: Readonly<Record<string, string>>;
  onUpdateRelaunch?: (relaunchOnFailure: boolean) => Promise<number> | number;
  replaceProcess?: boolean;
  /**
   * `.env` files or `settings.env` injected values after this process's
   * modules (and Node itself, e.g. NODE_EXTRA_CA_CERTS) read the environment,
   * so only a fresh image sees them.
   */
  environmentChangedSinceBoot?: boolean;
}

export async function relaunchOnExitCode(
  runner: () => Promise<number>,
  options?: Pick<RelaunchOptions, 'onUpdateRelaunch'>,
) {
  while (true) {
    try {
      const exitCode = await runner();

      if (exitCode === UPDATE_RELAUNCH_EXIT_CODE && options?.onUpdateRelaunch) {
        const updatedExitCode = await options.onUpdateRelaunch(true);
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

/**
 * Makes a supervised child exit once its supervisor is gone. A host stops the
 * CLI by signalling the process it started, which is the supervisor, so the
 * child watches the IPC channel it was spawned with and, when that closes,
 * exits after a grace period instead of running on indefinitely. `graceMs` is
 * for tests.
 */
export function exitWhenSupervisorExits(graceMs = ORPHAN_GRACE_MS): void {
  if (process.env[RELAUNCH_SUPERVISED_ENV] !== '1') {
    return;
  }
  // Tools and subagents this process spawns are not the supervisor's children.
  delete process.env[RELAUNCH_SUPERVISED_ENV];
  // A process that never had a channel was not spawned by a supervisor, and
  // the marker it carries is not one (a disconnected channel keeps `send`).
  if (typeof process.send !== 'function') {
    return;
  }
  // On a terminal the process group gets the terminal's signals, and a shell
  // that has taken the terminal back would make restoring it fail, so only a
  // child on pipes (an SDK host, an editor, a daemon) watches.
  if (isatty(0)) {
    return;
  }
  // 129, as for SIGHUP: the side that started this process hung up.
  const exit = () => void runExitCleanup().finally(() => process.exit(129));
  if (!process.connected || !process.channel) {
    debugLogger.debug('Supervisor gone before startup; exiting.');
    exit();
    return;
  }
  process.once('disconnect', () => {
    debugLogger.debug('Supervisor gone; exiting after the grace period.');
    // Nothing is signalled here: a host that signals the process group, or
    // closes this process's input, starts the mode's own shutdown, and a
    // second signal would kill the SessionEnd hooks it runs. This only bounds
    // how long the process may run on.
    setTimeout(exit, graceMs).unref();
  });
  // The listener would otherwise hold the channel, and so this process, open.
  process.channel.unref();
}

export async function relaunchAppInChildProcess(
  additionalNodeArgs: string[],
  additionalScriptArgs: string[],
  options?: RelaunchOptions,
) {
  if (process.env['QWEN_CODE_NO_RELAUNCH']) {
    return;
  }

  const script = process.argv[1];
  const scriptArgs = process.argv.slice(2);
  const nodeArgs = [
    ...getRelaunchExecArgv(),
    ...additionalNodeArgs,
    script,
    ...additionalScriptArgs,
    ...scriptArgs,
  ];
  const createChildEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...options?.childEnv,
      QWEN_CODE_NO_RELAUNCH: 'true',
    };
    // Only the supervised spawn below marks its child.
    delete env[RELAUNCH_SUPERVISED_ENV];
    if (env['QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE'] === '1') {
      env['ELECTRON_RUN_AS_NODE'] = '1';
    }
    return env;
  };

  // `afterSpawn` runs once `createChildEnv()` has already snapshotted the
  // environment, so it only ever scrubbed the *parent's* copy for the next
  // relaunch iteration or subprocess — never the child's. Process replacement
  // inherits that same snapshot and leaves no parent behind, so there is
  // nothing for the hook to protect on this path.
  if (
    options?.replaceProcess &&
    typeof process.execve === 'function' &&
    !['win32', 'os400'].includes(process.platform)
  ) {
    // With no new Node or script arguments and no environment change since
    // boot, the replacement image would be this process booted a second
    // time: continue in place instead.
    // `childEnv` only carries state (env provenance) that a fresh image must
    // re-read and this process already holds, so only the no-relaunch guard
    // is published.
    if (
      additionalNodeArgs.length === 0 &&
      additionalScriptArgs.length === 0 &&
      !options?.environmentChangedSinceBoot
    ) {
      process.env['QWEN_CODE_NO_RELAUNCH'] = 'true';
      return;
    }
    try {
      return process.execve(
        process.execPath,
        [process.execPath, ...nodeArgs],
        createChildEnv(),
      );
    } catch (error) {
      // Fall back when the runtime supports execve but the replacement
      // fails; surface the reason so a persistent failure (e.g. E2BIG) is
      // visible instead of silently voiding the optimization.
      writeStderrLine(
        `Process replacement failed, using a supervised relaunch instead: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const runner = () => {
    let updateOnExitRequested = false;
    const newEnv = { ...createChildEnv(), [RELAUNCH_SUPERVISED_ENV]: '1' };

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
          void Promise.resolve(options.onUpdateRelaunch(false)).then(
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
