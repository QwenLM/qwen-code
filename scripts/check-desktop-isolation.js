/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const desktopPrefix = 'packages/desktop';
const forbiddenRootPackages = [
  'electron',
  'electron-builder',
  '@sentry/cli',
  '@sentry/electron',
  '@sentry/vite-plugin',
];

let hasError = false;

console.log('Checking desktop workspace isolation...');

function isDesktopLocation(location) {
  return location === desktopPrefix || location.startsWith(`${desktopPrefix}/`);
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

const desktopWorkspaces = workspaces
  .map((workspace) => workspace.location)
  .filter(isDesktopLocation);

if (desktopWorkspaces.length > 0) {
  reportError(
    'Desktop packages should not be part of the root npm workspace set.',
    desktopWorkspaces,
  );
}

const lockfile = JSON.parse(
  readFileSync(join(root, 'package-lock.json'), 'utf8'),
);
const desktopLockfileEntries = Object.keys(lockfile.packages ?? {}).filter(
  isDesktopLocation,
);

if (desktopLockfileEntries.length > 0) {
  reportError(
    'Root package-lock.json should not contain desktop package entries.',
    desktopLockfileEntries,
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

if (hasError) {
  process.exit(1);
}

console.log('Desktop workspace isolation check passed.');
