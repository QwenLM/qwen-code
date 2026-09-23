/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const nativePrefixes = [
  'packages/desktop-shell',
  'packages/live-host',
  'packages/mobile-shell',
];
const forbiddenRootPackages = [
  'electron',
  'electron-builder',
  '@sentry/cli',
  '@sentry/electron',
  '@sentry/vite-plugin',
];

let hasError = false;

console.log('Checking native workspace isolation...');

function isNativeLocation(location) {
  return nativePrefixes.some(
    (prefix) => location === prefix || location.startsWith(`${prefix}/`),
  );
}

function reportError(message, values = []) {
  hasError = true;
  console.error(`\nError: ${message}`);
  for (const value of values) {
    console.error(`- ${value}`);
  }
}

function rootPackageJsonPath(packageName) {
  return join(root, 'node_modules', ...packageName.split('/'), 'package.json');
}

let workspaces;
try {
  workspaces = JSON.parse(
    execSync('npm query .workspace --json', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
} catch (error) {
  console.error('Failed to query npm workspaces:', error.message);
  process.exit(1);
}

const nativeWorkspaces = workspaces
  .map((workspace) => workspace.location)
  .filter(isNativeLocation);

if (nativeWorkspaces.length > 0) {
  reportError(
    'Native packages should not be part of the root npm workspace set.',
    nativeWorkspaces,
  );
}

const lockfile = parseYaml(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
const nativeLockfileEntries = Object.keys(lockfile.importers ?? {}).filter(
  isNativeLocation,
);

if (nativeLockfileEntries.length > 0) {
  reportError(
    'Root pnpm-lock.yaml should not contain native package importers.',
    nativeLockfileEntries,
  );
}

const installedForbiddenPackages = forbiddenRootPackages.filter((packageName) =>
  existsSync(rootPackageJsonPath(packageName)),
);

if (installedForbiddenPackages.length > 0) {
  reportError(
    'Desktop-only dependencies should not be installed in root node_modules.',
    installedForbiddenPackages,
  );
}

const wrapperJar = join(
  root,
  'packages',
  'mobile-shell',
  'gradle',
  'wrapper',
  'gradle-wrapper.jar',
);
const wrapperChecksum = `${wrapperJar}.sha256`;
if (!existsSync(wrapperJar) || !existsSync(wrapperChecksum)) {
  reportError('Android Gradle wrapper integrity files are missing.');
} else {
  const expected = readFileSync(wrapperChecksum, 'utf8').trim().toLowerCase();
  const actual = createHash('sha256')
    .update(readFileSync(wrapperJar))
    .digest('hex');
  if (!/^[a-f0-9]{64}$/u.test(expected) || actual !== expected) {
    reportError('Android Gradle wrapper checksum does not match.', [
      `expected ${expected}`,
      `actual ${actual}`,
    ]);
  }
}

if (hasError) {
  process.exit(1);
}

console.log('Native workspace isolation check passed.');
