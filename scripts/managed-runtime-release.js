/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { valid } from 'semver';
import { isMainModule, parseArgs, sha256File } from './release-script-utils.js';

export async function stageManagedRuntimeRelease({ jar, version, outDir }) {
  if (valid(version) !== version)
    throw new Error('An exact CLI release version is required.');
  const input = fs.openSync(jar, 'r');
  try {
    const header = Buffer.alloc(4);
    fs.readSync(input, header, 0, header.length, 0);
    if (header.toString('hex') !== '504b0304')
      throw new Error('Expected a packaged server JAR.');
  } finally {
    fs.closeSync(input);
  }
  const name = `qwen-managed-agent-server-${version}.jar`;
  fs.mkdirSync(outDir, { recursive: true });
  const destination = path.join(outDir, name);
  fs.copyFileSync(jar, destination);
  const sha256 = await sha256File(destination);
  fs.writeFileSync(`${destination}.sha256`, `${sha256}  ${name}\n`);
  return { name, sha256 };
}

export async function checkManagedRuntimeAsset(url, file, fetchImpl = fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(
      'Release artifact verification requires a public HTTPS URL.',
    );
  }
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(300_000),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return 'missing';
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(
      `Cannot verify existing release artifact: HTTP ${response.status}.`,
    );
  }
  const size = fs.statSync(file).size;
  const digest = createHash('sha256');
  let received = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > size) {
          callback(
            new Error(
              'Existing release artifact has different bytes; refusing overwrite.',
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    }),
    digest,
  );
  if (received !== size || digest.digest('hex') !== (await sha256File(file))) {
    throw new Error(
      'Existing release artifact has different bytes; refusing overwrite.',
    );
  }
  return 'present';
}

if (isMainModule(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2), {
      '--jar': { key: 'jar', type: 'value' },
      '--version': { key: 'version', type: 'value' },
      '--out-dir': { key: 'outDir', type: 'value' },
      '--check-url': { key: 'url', type: 'value' },
      '--file': { key: 'file', type: 'value' },
    });
    if (args.help) {
      console.log(
        'Stage: --jar PATH --version VERSION --out-dir DIR\nVerify without replacing: --check-url HTTPS_URL --file PATH (prints present or missing).',
      );
    } else if (
      args.url &&
      args.file &&
      !args.jar &&
      !args.version &&
      !args.outDir
    ) {
      console.log(await checkManagedRuntimeAsset(args.url, args.file));
    } else if (
      args.jar &&
      args.version &&
      args.outDir &&
      !args.url &&
      !args.file
    ) {
      console.log(JSON.stringify(await stageManagedRuntimeRelease(args)));
    } else {
      throw new Error(
        'Provide one complete stage or verification argument set; see --help.',
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
