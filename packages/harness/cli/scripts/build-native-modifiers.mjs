#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(scriptDir, '..');
const source = path.join(cliRoot, 'src/native-modifiers/modifiers.c');

if (process.platform !== 'darwin') {
  process.stdout.write('Native modifier prebuilds are only built on macOS.\n');
  process.exit(0);
}

function findNodeHeaders() {
  const configured = process.env['NODE_HEADERS_DIR'];
  const candidates = [
    configured,
    path.resolve(path.dirname(process.execPath), '../include/node'),
    '/opt/homebrew/include/node',
    '/usr/local/include/node',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'node_api.h'))) return candidate;
  }
  throw new Error(
    'Could not find node_api.h. Set NODE_HEADERS_DIR to the Node.js include directory.',
  );
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with status ${result.status ?? 'unknown'}`,
    );
  }
}

const headers = findNodeHeaders();
const sdkResult = spawnSync('xcrun', ['--show-sdk-path'], {
  encoding: 'utf8',
});
if (sdkResult.status !== 0) {
  throw new Error('Could not locate the macOS SDK with xcrun.');
}
const sdk = sdkResult.stdout.trim();

for (const arch of ['arm64', 'x86_64']) {
  const platformArch = arch === 'x86_64' ? 'x64' : arch;
  const outputDir = path.join(
    cliRoot,
    'src/native-modifiers/prebuilds',
    `darwin-${platformArch}`,
  );
  const output = path.join(outputDir, 'modifiers.node');
  mkdirSync(outputDir, { recursive: true });

  run('xcrun', [
    'clang',
    '-arch',
    arch,
    '-isysroot',
    sdk,
    '-mmacosx-version-min=11.0',
    '-DNAPI_VERSION=8',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fvisibility=hidden',
    '-bundle',
    '-undefined',
    'dynamic_lookup',
    '-I',
    headers,
    source,
    '-framework',
    'CoreGraphics',
    '-o',
    output,
  ]);
  run('codesign', ['--force', '--sign', '-', output]);
  process.stdout.write(`Built ${path.relative(cliRoot, output)}\n`);
}
