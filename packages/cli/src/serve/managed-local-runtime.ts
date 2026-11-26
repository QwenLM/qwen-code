/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { getCliVersion } from '../utils/version.js';
import { installManagedLocalRuntime } from './managed-local-download.js';

export interface ManagedLocalRuntime {
  java: string;
  serverJar: string;
  cliEntry: string;
}

const execFileAsync = promisify(execFile);

async function resolveSystemJava(): Promise<string> {
  const javaHome = process.env['JAVA_HOME'];
  const candidates = javaHome
    ? [path.resolve(javaHome, 'bin', 'java')]
    : (process.env['PATH'] ?? '')
        .split(path.delimiter)
        .map((directory) => path.resolve(directory, 'java'));
  let java: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      java = await realpath(candidate);
      break;
    } catch {
      continue;
    }
  }
  const requirement =
    'Managed local serve requires local Java 21. Set JAVA_HOME to a Java 21 home or put Java 21 on PATH.';
  if (!java) {
    throw new Error(
      `${requirement} No executable java found ${javaHome ? 'in JAVA_HOME/bin' : 'on PATH'}.`,
    );
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      java,
      ['-XshowSettings:properties', '-version'],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
    );
    if (
      !/^\s*java\.specification\.version\s*=\s*21\s*$/mu.test(
        `${stdout}\n${stderr}`,
      )
    ) {
      throw new Error('Wrong Java version');
    }
  } catch {
    throw new Error(`${requirement} Could not verify Java 21 at ${java}.`);
  }
  return java;
}

export async function resolveManagedLocalRuntime(
  cliEntry = process.argv[1],
  runtimeDirectory = process.env['QWEN_MANAGED_LOCAL_RUNTIME_DIR'],
): Promise<ManagedLocalRuntime> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Managed local serve supports native macOS and Linux.');
  }
  if (
    'bun' in process.versions ||
    Number(process.versions.node.split('.')[0]) < 22
  ) {
    throw new Error(
      'Managed local serve requires Node.js 22 or newer; Bun is unsupported.',
    );
  }
  if (!cliEntry) throw new Error('Cannot determine the installed CLI entry.');
  const entry = await realpath(cliEntry);
  const version = await getCliVersion();
  const target = `${process.platform}-${process.arch}`;
  const installed = path.join(
    Storage.getGlobalQwenDir(),
    'managed-runtime',
    version,
    target,
  );
  let directory = runtimeDirectory;
  let systemJava: string | undefined;
  if (directory === undefined) {
    const colocated = path.join(path.dirname(entry), 'managed-runtime');
    try {
      await lstat(colocated);
      directory = colocated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      directory = installed;
      try {
        await lstat(installed);
      } catch (installedError) {
        if ((installedError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw installedError;
        }
        systemJava = await resolveSystemJava();
        await installManagedLocalRuntime(version, target, installed);
      }
    }
  }
  directory = path.resolve(directory);
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(path.join(directory, 'manifest.json'), 'utf8'),
    );
  } catch {
    throw new Error(
      `Managed runtime is missing or invalid at ${directory}. Install the managed-runtime archive for CLI ${version}, ${target} into ${Storage.getGlobalQwenDir()}, ` +
        'use the complete Managed local distribution, or set QWEN_MANAGED_LOCAL_RUNTIME_DIR to its payload directory.',
    );
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('schemaVersion' in manifest) ||
    manifest.schemaVersion !== 1 ||
    !('cliVersion' in manifest) ||
    manifest.cliVersion !== version ||
    !('target' in manifest) ||
    manifest.target !== target ||
    !('javaMajor' in manifest) ||
    manifest.javaMajor !== 21 ||
    ('javaSource' in manifest &&
      manifest.javaSource !== 'bundled' &&
      manifest.javaSource !== 'system') ||
    !('serverSha256' in manifest) ||
    typeof manifest.serverSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(manifest.serverSha256)
  ) {
    throw new Error(
      `Managed runtime must match CLI ${version}, ${target}, and Java 21.`,
    );
  }
  const serverJar = path.join(directory, 'server.jar');
  let java = path.join(directory, 'jre', 'bin', 'java');
  const digest = createHash('sha256');
  try {
    for await (const chunk of createReadStream(serverJar)) digest.update(chunk);
    if (digest.digest('hex') !== manifest.serverSha256) {
      throw new Error('Server checksum mismatch');
    }
    if (!(await stat(serverJar)).isFile()) throw new Error('Not a server JAR');
    if ('javaSource' in manifest && manifest.javaSource === 'system') {
      java = systemJava ?? (await resolveSystemJava());
    } else {
      await access(java, constants.X_OK);
      const release = await readFile(
        path.join(directory, 'jre', 'release'),
        'utf8',
      );
      if (!/^JAVA_VERSION="21(?:[.\-+"])/mu.test(release)) {
        throw new Error('Java runtime is not Java 21');
      }
    }
  } catch (error) {
    throw new Error(
      `Managed runtime verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { java, serverJar, cliEntry: entry };
}
