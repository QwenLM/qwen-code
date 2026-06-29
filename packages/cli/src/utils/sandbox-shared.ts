/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { exec, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { quote } from 'shell-quote';
/* eslint-disable import-x/no-internal-modules */
import { SETTINGS_DIRECTORY_NAME } from '../config/settings.js';
/* eslint-enable import-x/no-internal-modules */
import { promisify } from 'node:util';
import type { Config, SandboxConfig } from '@qwen-code/qwen-code-core';
import { writeStderrLine } from './stdioHelpers.js';
import { isContainerPathWithinWorkdir } from './sandbox-path.js';

export const execAsync = promisify(exec);

export const LOCAL_DEV_SANDBOX_IMAGE_NAME = 'qwen-code-sandbox';
export const SANDBOX_NETWORK_NAME = 'qwen-code-sandbox';
export const SANDBOX_PROXY_NAME = 'qwen-code-sandbox-proxy';
export const BUILTIN_SEATBELT_PROFILES = [
  'permissive-open',
  'permissive-closed',
  'permissive-proxied',
  'restrictive-open',
  'restrictive-closed',
  'restrictive-proxied',
];

export function getContainerPath(hostPath: string): string {
  if (os.platform() !== 'win32') {
    return hostPath;
  }

  const withForwardSlashes = hostPath.replace(/\\/g, '/');
  const match = withForwardSlashes.match(/^([A-Z]):\/(.*)/i);
  if (match) {
    return `/${match[1].toLowerCase()}/${match[2]}`;
  }
  return hostPath;
}

export function ensureDirectoryAndGetRealPath(dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return fs.realpathSync(dir);
}

export function ports(): string[] {
  return (process.env['SANDBOX_PORTS'] ?? '')
    .split(',')
    .filter((p) => p.trim())
    .map((p) => p.trim());
}

export function entrypoint(workdir: string, cliArgs: string[]): string[] {
  const isWindows = os.platform() === 'win32';
  const containerWorkdir = getContainerPath(workdir);
  const shellCmds = [];
  const pathSeparator = isWindows ? ';' : ':';

  let pathSuffix = '';
  if (process.env['PATH']) {
    const paths = process.env['PATH'].split(pathSeparator);
    for (const p of paths) {
      const containerPath = getContainerPath(p);
      if (isContainerPathWithinWorkdir(containerWorkdir, containerPath)) {
        pathSuffix += `:${containerPath}`;
      }
    }
  }
  if (pathSuffix) {
    shellCmds.push(`export PATH="$PATH${pathSuffix}";`);
  }

  let pythonPathSuffix = '';
  if (process.env['PYTHONPATH']) {
    const paths = process.env['PYTHONPATH'].split(pathSeparator);
    for (const p of paths) {
      const containerPath = getContainerPath(p);
      if (isContainerPathWithinWorkdir(containerWorkdir, containerPath)) {
        pythonPathSuffix += `:${containerPath}`;
      }
    }
  }
  if (pythonPathSuffix) {
    shellCmds.push(`export PYTHONPATH="$PYTHONPATH${pythonPathSuffix}";`);
  }

  const projectSandboxBashrc = path.join(
    SETTINGS_DIRECTORY_NAME,
    'sandbox.bashrc',
  );
  if (fs.existsSync(projectSandboxBashrc)) {
    shellCmds.push(`source ${getContainerPath(projectSandboxBashrc)};`);
  }

  ports().forEach((p) =>
    shellCmds.push(
      `socat TCP4-LISTEN:${p},bind=$(hostname -i),fork,reuseaddr TCP4:127.0.0.1:${p} 2> /dev/null &`,
    ),
  );

  const quotedCliArgs = cliArgs.slice(2).map((arg) => quote([arg]));
  const cliCmd =
    process.env['NODE_ENV'] === 'development'
      ? process.env['DEBUG']
        ? 'npm run debug --'
        : 'npm rebuild && npm run start --'
      : process.env['DEBUG']
        ? `node --inspect-brk=0.0.0.0:${process.env['DEBUG_PORT'] || '9229'} $(which qwen)`
        : 'qwen';

  const args = [...shellCmds, cliCmd, ...quotedCliArgs];
  return ['bash', '-c', args.join(' ')];
}

/**
 * Determines whether the sandbox container should be run with the current user's UID and GID.
 * This is often necessary on Linux systems when using rootful Docker without userns-remap
 * configured, to avoid permission issues with mounted volumes.
 *
 * The behavior is controlled by the `SANDBOX_SET_UID_GID` environment variable:
 * - If `SANDBOX_SET_UID_GID` is "1" or "true", this function returns `true`.
 * - If `SANDBOX_SET_UID_GID` is "0" or "false", this function returns `false`.
 * - If `SANDBOX_SET_UID_GID` is not set:
 *   - On Linux, it defaults to `true`.
 *   - On other OSes, it defaults to `false`.
 */
export async function shouldUseCurrentUserInSandbox(): Promise<boolean> {
  const envVar = process.env['SANDBOX_SET_UID_GID']?.toLowerCase().trim();

  if (envVar === '1' || envVar === 'true') {
    return true;
  }
  if (envVar === '0' || envVar === 'false') {
    return false;
  }

  if (os.platform() === 'linux') {
    const debugEnv = [process.env['DEBUG'], process.env['DEBUG_MODE']].some(
      (v) => v === 'true' || v === '1',
    );
    if (debugEnv) {
      writeStderrLine(
        'INFO: Using current user UID/GID in Linux sandbox. Set SANDBOX_SET_UID_GID=false to disable.',
      );
    }
    return true;
  }

  return false;
}

export interface SandboxBackend {
  prepare(config: SandboxConfig, cliConfig?: Config): Promise<void>;
  execute(
    config: SandboxConfig,
    nodeArgs: string[],
    cliConfig?: Config,
    cliArgs?: string[],
  ): Promise<number>;
  cleanup(): void;
}

export async function imageExists(
  sandbox: string,
  image: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['images', '-q', image];
    const checkProcess = spawn(sandbox, args);

    let stdoutData = '';
    if (checkProcess.stdout) {
      checkProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });
    }

    checkProcess.on('error', (err) => {
      writeStderrLine(
        `Failed to start '${sandbox}' command for image check: ${err.message}`,
      );
      resolve(false);
    });

    checkProcess.on('close', () => {
      resolve(stdoutData.trim() !== '');
    });
  });
}

export async function pullImage(
  sandbox: string,
  image: string,
): Promise<boolean> {
  writeStderrLine(`Attempting to pull image ${image} using ${sandbox}...`);
  return new Promise((resolve) => {
    const args = ['pull', image];
    const pullProcess = spawn(sandbox, args, { stdio: 'pipe' });

    const onStdoutData = (data: Buffer) => {
      writeStderrLine(data.toString().trim());
    };

    const onStderrData = (data: Buffer) => {
      writeStderrLine(data.toString().trim());
    };

    const onError = (err: Error) => {
      writeStderrLine(
        `Failed to start '${sandbox} pull ${image}' command: ${err.message}`,
      );
      cleanup();
      resolve(false);
    };

    const onClose = (code: number | null) => {
      if (code === 0) {
        writeStderrLine(`Successfully pulled image ${image}.`);
        cleanup();
        resolve(true);
      } else {
        writeStderrLine(
          `Failed to pull image ${image}. '${sandbox} pull ${image}' exited with code ${code}.`,
        );
        cleanup();
        resolve(false);
      }
    };

    const cleanup = () => {
      if (pullProcess.stdout) {
        pullProcess.stdout.removeListener('data', onStdoutData);
      }
      if (pullProcess.stderr) {
        pullProcess.stderr.removeListener('data', onStderrData);
      }
      pullProcess.removeListener('error', onError);
      pullProcess.removeListener('close', onClose);
      if (pullProcess.connected) {
        pullProcess.disconnect();
      }
    };

    if (pullProcess.stdout) {
      pullProcess.stdout.on('data', onStdoutData);
    }
    if (pullProcess.stderr) {
      pullProcess.stderr.on('data', onStderrData);
    }
    pullProcess.on('error', onError);
    pullProcess.on('close', onClose);
  });
}

export async function ensureSandboxImageIsPresent(
  sandbox: string,
  image: string,
): Promise<boolean> {
  writeStderrLine(`Checking for sandbox image: ${image}`);
  if (await imageExists(sandbox, image)) {
    writeStderrLine(`Sandbox image ${image} found locally.`);
    return true;
  }

  writeStderrLine(`Sandbox image ${image} not found locally.`);
  if (image === LOCAL_DEV_SANDBOX_IMAGE_NAME) {
    return false;
  }

  if (await pullImage(sandbox, image)) {
    if (await imageExists(sandbox, image)) {
      writeStderrLine(`Sandbox image ${image} is now available after pulling.`);
      return true;
    } else {
      writeStderrLine(
        `Sandbox image ${image} still not found after a pull attempt.`,
      );
      return false;
    }
  }

  writeStderrLine(
    `Failed to obtain sandbox image ${image} after check and pull attempt.`,
  );
  return false;
}
