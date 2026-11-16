/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateSdkTarball(tarball, version, cliVersion) {
  const read = (file) =>
    execFileSync('tar', ['-xOf', tarball, `package/${file}`], {
      encoding: 'utf8',
    });
  const manifest = JSON.parse(read('package.json'));
  if (manifest.name !== '@qwen-code/sdk' || manifest.version !== version) {
    throw new Error('SDK tarball name/version does not match the release');
  }
  const files = new Set(
    execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
      .trim()
      .split('\n'),
  );
  const targets = (value) =>
    typeof value === 'string'
      ? [value]
      : Object.values(value ?? {}).flatMap(targets);
  for (const file of [
    'dist/cli/cli.js',
    'dist/BUNDLED_CLI_VERSION',
    ...targets(manifest.exports),
    ...targets(manifest.bin),
  ]) {
    if (!files.has(`package/${file.replace(/^\.\//, '')}`))
      throw new Error(`SDK tarball is missing ${file}`);
  }
  if (read('dist/BUNDLED_CLI_VERSION').trim() !== cliVersion)
    throw new Error('Bundled CLI version does not match');
  return manifest;
}

export function packSdk(sdkDirectory, destination, version, cliVersion) {
  mkdirSync(destination, { recursive: true });
  const output = execFileSync(
    'npm',
    [
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      resolve(destination),
    ],
    { cwd: sdkDirectory, encoding: 'utf8' },
  );
  const [{ filename }] = JSON.parse(output);
  const tarball = join(destination, filename);
  validateSdkTarball(tarball, version, cliVersion);
  renameSync(tarball, join(destination, 'sdk.tgz'));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [command, directory, version, cliVersion] = process.argv.slice(2);
  if (command === 'pack')
    packSdk('packages/sdk-typescript', directory, version, cliVersion);
  else if (command === 'validate')
    validateSdkTarball(join(directory, 'sdk.tgz'), version, cliVersion);
  else throw new Error('Expected pack or validate');
}
