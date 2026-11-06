/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { isatty } from 'node:tty';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { JsInterpreterCommand } from '@qwen-code/qwen-code-core/utils/runtime-info.js';
import {
  AGENT_VIEW_ROSTER_MESSAGE,
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
  interpreter?: JsInterpreterCommand;
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
let relaunchSupervised = false;

/**
 * Asks the relaunch supervisor to open the Agent View roster once this
 * process exits. The supervisor owns the terminal handoff, which a nested
 * spawnSync cannot do reliably on Windows: the blocked parent keeps reading
 * console input. Resolves false when no supervisor is listening.
 */
export function requestAgentViewRosterOnExit(
  argv: readonly string[],
): Promise<boolean> {
  if (!relaunchSupervised || !process.send || !process.connected) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      process.send!({ type: AGENT_VIEW_ROSTER_MESSAGE, argv }, (error) =>
        resolve(!error),
      );
    } catch {
      resolve(false);
    }
  });
}

export function exitWhenSupervisorExits(graceMs = ORPHAN_GRACE_MS): void {
  const supervision = process.env[RELAUNCH_SUPERVISED_ENV];
  if (supervision !== '1' && supervision !== 'terminal') {
    return;
  }
  relaunchSupervised = true;
  // Tools and subagents this process spawns are not the supervisor's children.
  delete process.env[RELAUNCH_SUPERVISED_ENV];
  // A process that never had a channel was not spawned by a supervisor, and
  // the marker it carries is not one (a disconnected channel keeps `send`).
  if (typeof process.send !== 'function') {
    return;
  }
  // The npm Bun handoff keeps a terminal child alive behind Node even when
  // only Node is killed. Other terminal relaunches keep their existing policy.
  const onTerminal = isatty(0);
  if (onTerminal && supervision !== 'terminal') {
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
    if (onTerminal) {
      debugLogger.debug('Terminal supervisor gone; exiting.');
      exit();
      return;
    }
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
  const command = options?.interpreter?.command ?? process.execPath;
  const nodeArgs = [
    ...(options?.interpreter?.runtime === 'bun'
      ? ['--expose-gc']
      : [...getRelaunchExecArgv(), ...additionalNodeArgs]),
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
    !options.interpreter &&
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
    let agentViewRosterArgv: string[] | undefined;
    const terminalHandoff =
      options?.interpreter?.runtime === 'bun' && isatty(0);
    const newEnv = {
      ...createChildEnv(),
      [RELAUNCH_SUPERVISED_ENV]: terminalHandoff ? 'terminal' : '1',
    };

    // The parent process should not be reading from stdin while the child is running.
    process.stdin.pause();

    const child = spawn(command, nodeArgs, {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: newEnv,
    });
    // The terminal sends SIGINT to both processes; the interactive child owns
    // its confirmation window. Exiting Node on the first signal would orphan it.
    const keepSupervisor = () => {};
    if (terminalHandoff) process.on('SIGINT', keepSupervisor);
    const removeSignalHandler = () => {
      if (terminalHandoff) process.removeListener('SIGINT', keepSupervisor);
    };

    child.on('message', (message) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === UPDATE_ON_EXIT_MESSAGE
      ) {
        updateOnExitRequested = true;
      }
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === AGENT_VIEW_ROSTER_MESSAGE &&
        'argv' in message &&
        Array.isArray(message.argv) &&
        message.argv.length > 0 &&
        message.argv.every((arg: unknown) => typeof arg === 'string')
      ) {
        agentViewRosterArgv = message.argv as string[];
      }
    });

    // Allow the parent to clean up process.env after spawn copies it
    // but before the next relaunch iteration.
    try {
      options?.afterSpawn?.();
    } catch (err) {
      removeSignalHandler();
      child.kill();
      throw err;
    }

    return new Promise<number>((resolve, reject) => {
      child.on('error', (error) => {
        removeSignalHandler();
        reject(error);
      });
      child.on('close', (code) => {
        removeSignalHandler();
        if (agentViewRosterArgv) {
          // The detached session asked for the roster: hand the terminal to
          // it while stdin stays paused here.
          const [rosterCommand, ...rosterArgs] = agentViewRosterArgv;
          agentViewRosterArgv = undefined;
          const roster = spawn(rosterCommand!, rosterArgs, {
            stdio: 'inherit',
            env: createChildEnv(),
          });
          roster.on('error', reject);
          roster.on('close', (rosterCode) => {
            process.stdin.resume();
            resolve(rosterCode ?? 1);
          });
          return;
        }
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
