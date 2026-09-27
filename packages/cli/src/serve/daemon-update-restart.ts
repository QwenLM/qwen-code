/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import semver from 'semver';
import { EXTERNAL_TOOL_GUARD_TOKEN_ENV } from '@qwen-code/acp-bridge/externalToolGuard';
import { normalizeServeFastPathArgv } from '../utils/serve-fast-path-argv.js';

export function createDaemonUpdateRestarter(options: {
  argv: readonly string[];
  env: Readonly<NodeJS.ProcessEnv>;
  token?: string;
  externalToolGuardToken?: string;
  getPort: () => number;
  close: () => Promise<void>;
}): ((launcher: string) => Promise<void>) | undefined {
  const execve = (
    process as typeof process & {
      execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never;
    }
  ).execve?.bind(process);
  const argv = normalizeServeFastPathArgv(options.argv);
  if (
    !execve ||
    ['win32', 'os400'].includes(os.platform()) ||
    process.versions['bun'] ||
    argv[0] !== 'serve' ||
    argv.includes('--')
  ) {
    return undefined;
  }
  const env = { ...options.env };
  for (const key of [
    'QWEN_CODE_MANAGED_NPM_PIN',
    'QWEN_CODE_STARTUP_VERSION',
    'QWEN_CODE_RELAUNCH_ARGS',
    'QWEN_CODE_MANAGED_NPM_UPDATE_VERSION',
    'QWEN_CODE_LAUNCHER_PATH',
    'CLI_VERSION',
  ]) {
    delete env[key];
  }
  if (options.token) env['QWEN_SERVER_TOKEN'] = options.token;
  else delete env['QWEN_SERVER_TOKEN'];
  if (options.externalToolGuardToken) {
    env[EXTERNAL_TOOL_GUARD_TOKEN_ENV] = options.externalToolGuardToken;
  }
  const args: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const name = arg.split('=', 1)[0];
    if (name === '--port' || name === '--token') {
      if (!arg.includes('=')) index++;
      continue;
    }
    if (/^--(?:no-)?open(?:-with-auth)?(?:=|$)/.test(arg)) {
      if (
        !arg.includes('=') &&
        /^(?:true|false)$/.test(argv[index + 1] ?? '')
      ) {
        index++;
      }
      continue;
    }
    args.push(arg);
  }
  const execArgv = [...process.execArgv];
  return async (launcher) => {
    if (!isAbsolute(launcher))
      throw new Error('Update launcher must be absolute');
    const npmLauncher = launcher.endsWith('.js');
    await access(launcher, npmLauncher ? constants.R_OK : constants.X_OK);
    if (!npmLauncher) {
      // execFile may fall back to a shell for scripts execve would reject.
      const [header] = (await readFile(launcher, 'utf8')).split('\n', 1);
      if (header !== '#!/usr/bin/env sh') {
        throw new Error('Unsupported standalone update launcher');
      }
      const { stdout } = await promisify(execFile)(launcher, ['--version'], {
        env,
        timeout: 10_000,
      });
      if (!semver.valid(stdout.trim())) {
        throw new Error('Updated launcher did not report a valid version');
      }
    }
    const cliArgs = [...args, '--port', String(options.getPort())];
    await options.close();
    if (npmLauncher) {
      execve(
        process.execPath,
        [process.execPath, ...execArgv, launcher, ...cliArgs],
        env,
      );
    } else {
      execve(launcher, [launcher, ...cliArgs], env);
    }
  };
}
