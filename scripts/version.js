/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bumpWorkspaceVersions } from './bump-workspace-versions.js';

// A script to handle versioning and ensure all related changes are in a single, atomic commit.

function run(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: 'inherit' });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

// 1. Get the version from the command line arguments.
const versionType = process.argv[2];
if (!versionType) {
  console.error('Error: No version specified.');
  console.error(
    'Usage: npm run version <version> (e.g., 1.2.3 or patch|minor|major|prerelease)',
  );
  process.exit(1);
}

// 2. Bump the version in the root package.json file.
run(`npm version ${versionType} --no-git-tag-version --allow-same-version`);

// 3. Get the new version number from the root package.json
const rootPackageJsonPath = resolve(process.cwd(), 'package.json');
const newVersion = readJson(rootPackageJsonPath).version;

// 4. Bump every workspace (except sdk and mobile-mcp, which are versioned
// independently) and rewrite inter-workspace ^/~ dependency ranges to the new
// version, so the bumped workspaces keep satisfying their dependents and npm
// never backfills stale registry copies into packages/*/node_modules.
const workspacesToExclude = ['@qwen-code/sdk', '@qwen-code/mobile-mcp'];
for (const name of bumpWorkspaceVersions(process.cwd(), newVersion, {
  exclude: workspacesToExclude,
})) {
  console.log(`Updated ${name}`);
}

// 5. Update the sandboxImageUri in the root package.json
const rootPackageJson = readJson(rootPackageJsonPath);
if (rootPackageJson.config?.sandboxImageUri) {
  rootPackageJson.config.sandboxImageUri =
    rootPackageJson.config.sandboxImageUri.replace(/:.*$/, `:${newVersion}`);
  console.log(`Updated sandboxImageUri in root to use version ${newVersion}`);
  writeJson(rootPackageJsonPath, rootPackageJson);
}

// 6. Update the sandboxImageUri in the cli package.json
const cliPackageJsonPath = resolve(process.cwd(), 'packages/cli/package.json');
const cliPackageJson = readJson(cliPackageJsonPath);
if (cliPackageJson.config?.sandboxImageUri) {
  cliPackageJson.config.sandboxImageUri =
    cliPackageJson.config.sandboxImageUri.replace(/:.*$/, `:${newVersion}`);
  console.log(
    `Updated sandboxImageUri in cli package to use version ${newVersion}`,
  );
  writeJson(cliPackageJsonPath, cliPackageJson);
}

// 7. Run `npm install` to update package-lock.json with the new versions and
// inter-workspace ranges in one pass, so npm never sees an inconsistent
// tree that it would "fix" with stale registry copies.
// --ignore-scripts prevents the root `prepare` lifecycle from triggering a
// redundant full build that fails with TS5055 when dist/ already exists from
// the initial `npm ci` install.
run('npm install --package-lock-only --ignore-scripts');

console.log(`Successfully bumped versions to v${newVersion}.`);
