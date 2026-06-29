/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { quote } from 'shell-quote';
/* eslint-disable import-x/no-internal-modules */
import { SETTINGS_DIRECTORY_NAME } from '../config/settings.js';
/* eslint-enable import-x/no-internal-modules */
import type { Config, SandboxConfig } from '@qwen-code/qwen-code-core';
import { FatalSandboxError, Storage } from '@qwen-code/qwen-code-core';
import { writeStderrLine } from './stdioHelpers.js';
import { execAsync, BUILTIN_SEATBELT_PROFILES } from './sandbox-shared.js';

export async function startSeatbeltSandbox(
  config: SandboxConfig,
  nodeArgs: string[] = [],
  cliConfig?: Config,
  cliArgs: string[] = [],
): Promise<number> {
  if (process.env['BUILD_SANDBOX']) {
    throw new FatalSandboxError(
      'Cannot BUILD_SANDBOX when using macOS Seatbelt',
    );
  }

  const profile = (process.env['SEATBELT_PROFILE'] ??= 'permissive-open');
  let profileFile = fileURLToPath(
    new URL(`sandbox-macos-${profile}.sb`, import.meta.url),
  );
  if (!BUILTIN_SEATBELT_PROFILES.includes(profile)) {
    profileFile = path.join(
      SETTINGS_DIRECTORY_NAME,
      `sandbox-macos-${profile}.sb`,
    );
  }
  if (!fs.existsSync(profileFile)) {
    throw new FatalSandboxError(
      `Missing macos seatbelt profile file '${profileFile}'`,
    );
  }

  writeStderrLine(`using macos seatbelt (profile: ${profile}) ...`);

  const nodeOptions = [
    ...(process.env['DEBUG'] ? ['--inspect-brk'] : []),
    ...nodeArgs,
  ].join(' ');

  const qwenDir = Storage.getGlobalQwenDir();
  const runtimeDir = Storage.getRuntimeBaseDir();
  fs.mkdirSync(qwenDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const args = [
    '-D',
    `TARGET_DIR=${fs.realpathSync(process.cwd())}`,
    '-D',
    `TMP_DIR=${fs.realpathSync(os.tmpdir())}`,
    '-D',
    `HOME_DIR=${fs.realpathSync(os.homedir())}`,
    '-D',
    `CACHE_DIR=${fs.realpathSync(execSync(`getconf DARWIN_USER_CACHE_DIR`).toString().trim())}`,
    '-D',
    `QWEN_DIR=${fs.realpathSync(qwenDir)}`,
    '-D',
    `RUNTIME_DIR=${fs.realpathSync(runtimeDir)}`,
  ];

  const MAX_INCLUDE_DIRS = 5;
  const targetDir = fs.realpathSync(cliConfig?.getTargetDir() || '');
  const includedDirs: string[] = [];

  if (cliConfig) {
    const workspaceContext = cliConfig.getWorkspaceContext();
    const directories = workspaceContext.getDirectories();
    for (const dir of directories) {
      const realDir = fs.realpathSync(dir);
      if (realDir !== targetDir) {
        includedDirs.push(realDir);
      }
    }
  }

  for (let i = 0; i < MAX_INCLUDE_DIRS; i++) {
    let dirPath = '/dev/null';
    if (i < includedDirs.length) {
      dirPath = includedDirs[i];
    }
    args.push('-D', `INCLUDE_DIR_${i}=${dirPath}`);
  }

  const finalArgv = cliArgs;
  args.push(
    '-f',
    profileFile,
    'sh',
    '-c',
    [
      `SANDBOX=sandbox-exec`,
      `NODE_OPTIONS="${nodeOptions}"`,
      ...finalArgv.map((arg) => quote([arg])),
    ].join(' '),
  );

  const proxyCommand = process.env['QWEN_SANDBOX_PROXY_COMMAND'];
  let proxyProcess: ChildProcess | undefined = undefined;
  let sandboxProcess: ChildProcess | undefined = undefined;
  const sandboxEnv = { ...process.env };

  if (proxyCommand) {
    const proxy =
      process.env['HTTPS_PROXY'] ||
      process.env['https_proxy'] ||
      process.env['HTTP_PROXY'] ||
      process.env['http_proxy'] ||
      'http://localhost:8877';
    sandboxEnv['HTTPS_PROXY'] = proxy;
    sandboxEnv['https_proxy'] = proxy;
    sandboxEnv['HTTP_PROXY'] = proxy;
    sandboxEnv['http_proxy'] = proxy;
    const noProxy = process.env['NO_PROXY'] || process.env['no_proxy'];
    if (noProxy) {
      sandboxEnv['NO_PROXY'] = noProxy;
      sandboxEnv['no_proxy'] = noProxy;
    }

    proxyProcess = spawn('bash', ['-c', proxyCommand], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const stopProxy = () => {
      writeStderrLine('stopping proxy ...');
      if (proxyProcess?.pid) {
        process.kill(-proxyProcess.pid, 'SIGTERM');
      }
    };
    process.on('exit', stopProxy);
    process.on('SIGINT', stopProxy);
    process.on('SIGTERM', stopProxy);

    proxyProcess.stderr?.on('data', (data) => {
      writeStderrLine(data.toString());
    });
    proxyProcess.on('close', (code, signal) => {
      if (sandboxProcess?.pid) {
        process.kill(-sandboxProcess.pid, 'SIGTERM');
      }
      throw new FatalSandboxError(
        `Proxy command '${proxyCommand}' exited with code ${code}, signal ${signal}`,
      );
    });
    writeStderrLine('waiting for proxy to start ...');
    await execAsync(
      `until timeout 0.25 curl -s http://localhost:8877; do sleep 0.25; done`,
    );
  }

  process.stdin.pause();
  sandboxProcess = spawn(config.command, args, {
    stdio: 'inherit',
  });

  return new Promise((resolve, reject) => {
    sandboxProcess?.on('error', reject);
    sandboxProcess?.on('close', (code) => {
      process.stdin.resume();
      resolve(code ?? 1);
    });
  });
}
