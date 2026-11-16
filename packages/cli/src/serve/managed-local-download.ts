/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import lockfile from 'proper-lockfile';
import { valid } from 'semver';
import { writeStderrLine } from '../utils/stdioHelpers.js';

async function download(
  url: string,
  destination: string,
  limit: number,
  signal: AbortSignal,
  version: string,
): Promise<string> {
  const response = await fetch(url, {
    signal,
    headers: { 'User-Agent': `qwen-code/${version}` },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Download returned HTTP ${response.status}.`);
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel();
    throw new Error('Download exceeds the size limit.');
  }
  const digest = createHash('sha256');
  let received = 0;
  await pipeline(
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > limit) {
          callback(new Error('Download exceeds the size limit.'));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
  );
  return digest.digest('hex');
}

export async function installManagedLocalRuntime(
  version: string,
  target: string,
  directory: string,
): Promise<void> {
  if (
    version.length > 128 ||
    valid(version) !== version ||
    !/^(?:darwin|linux)-(?:arm64|x64)$/u.test(target)
  ) {
    throw new Error(
      'Managed runtime download requires a release version and supported target.',
    );
  }
  const parent = path.dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, {
    realpath: false,
    stale: 120_000,
    retries: { retries: 600, minTimeout: 1000, maxTimeout: 1000 },
  });
  try {
    try {
      await lstat(directory);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporaryPrefix = `.${target}-download-`;
    for (const entry of await readdir(parent)) {
      if (entry.startsWith(temporaryPrefix)) {
        await rm(path.join(parent, entry), { recursive: true, force: true });
      }
    }
    const tag = encodeURIComponent(`v${version}`);
    const name = `qwen-managed-agent-server-${version}.jar`;
    const sources = [
      `https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/${tag}`,
      `https://github.com/QwenLM/qwen-code/releases/download/${tag}`,
    ];
    const errors: string[] = [];
    for (const source of sources) {
      const temporary = await mkdtemp(path.join(parent, temporaryPrefix));
      try {
        writeStderrLine(
          `Downloading Managed server ${version} from ${new URL(source).hostname}...`,
        );
        const signal = AbortSignal.timeout(300_000);
        const checksumFile = path.join(temporary, 'checksum');
        await download(
          `${source}/${name}.sha256`,
          checksumFile,
          1024,
          signal,
          version,
        );
        const checksum = (await readFile(checksumFile, 'utf8')).trim();
        const expected = /^([a-f0-9]{64}) {2}(\S+)$/u.exec(checksum);
        if (!expected || expected[2] !== name) {
          throw new Error('Invalid Managed server checksum file.');
        }
        const serverJar = path.join(temporary, 'server.jar');
        const actual = await download(
          `${source}/${name}`,
          serverJar,
          256 * 1024 * 1024,
          signal,
          version,
        );
        if (actual !== expected[1])
          throw new Error('Server checksum mismatch.');
        const jar = await open(serverJar, 'r');
        try {
          const header = Buffer.alloc(4);
          await jar.read(header, 0, header.length, 0);
          if (header.toString('hex') !== '504b0304') {
            throw new Error('Managed server is not a JAR.');
          }
        } finally {
          await jar.close();
        }
        await rm(checksumFile);
        await writeFile(
          path.join(temporary, 'manifest.json'),
          `${JSON.stringify(
            {
              schemaVersion: 1,
              cliVersion: version,
              target,
              javaMajor: 21,
              javaSource: 'system',
              serverSha256: actual,
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
        await rename(temporary, directory);
        writeStderrLine(
          `Managed server ${version} installed. Subsequent starts use the local cache.`,
        );
        return;
      } catch (error) {
        errors.push(
          `${new URL(source).hostname}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    throw new Error(
      `Could not install Managed runtime for CLI ${version}, ${target} at ${directory}. ${errors.join(' ')} Retry when the release is available, or preinstall a matching managed-runtime archive for offline use.`,
    );
  } finally {
    await release();
  }
}
