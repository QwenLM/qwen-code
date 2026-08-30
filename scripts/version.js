/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

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

// 2. Bump the version in the root and all workspace package.json files.
run(`npm version ${versionType} --no-git-tag-version --allow-same-version`);

// 3. Get all workspaces and filter out the one we don't want to version.
// We intend to maintain sdk, mobile-mcp, and node-repl versions independently.
const workspacesToExclude = [
  '@qwen-code/sdk',
  '@qwen-code/mobile-mcp',
  '@qwen-code/node-repl-mcp',
];
const workspaceNames = JSON.parse(
  execSync('npm pkg get name --workspaces --json').toString(),
);
const allWorkspaces = Object.keys(workspaceNames);
const workspacesToVersion = allWorkspaces.filter(
  (wsName) => !workspacesToExclude.includes(wsName),
);

for (const workspaceName of workspacesToVersion) {
  run(
    `npm version ${versionType} --workspace ${workspaceName} --no-git-tag-version --allow-same-version`,
  );
}

// 4. Get the new version number from the root package.json
const rootPackageJsonPath = resolve(process.cwd(), 'package.json');
const newVersion = readJson(rootPackageJsonPath).version;

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

// 7. Pin channel adapters' semver dependency on @qwen-code/channel-base to
// the exact new version. A caret range like ^0.21.0 does not match a
// prerelease bump (e.g. 0.21.1-preview.0), so npm would replace the workspace
// link with the stale registry package and the release build would compile
// against outdated types.
const channelsDir = resolve(process.cwd(), 'packages/channels');
for (const entry of readdirSync(channelsDir)) {
  const pkgPath = join(channelsDir, entry, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = readJson(pkgPath);
  const dep = pkg.dependencies?.['@qwen-code/channel-base'];
  if (dep && !dep.startsWith('file:')) {
    pkg.dependencies['@qwen-code/channel-base'] = newVersion;
    writeJson(pkgPath, pkg);
    console.log(
      `Pinned @qwen-code/channel-base to ${newVersion} in ${pkg.name}`,
    );
  }
}

// 8. Refresh node_modules and package-lock.json against the pinned exact
// versions so the adapters resolve channel-base to the workspace link again.
// --ignore-scripts prevents the root `prepare` lifecycle from triggering a
// redundant full build that fails with TS5055 when dist/ already exists from
// the initial `npm ci` install.
run('npm install --ignore-scripts');

// 9. The per-workspace `npm version` reifies above nested a stale registry
// copy of channel-base under each adapter while ranges briefly mismatched.
// The install above cleans both lockfiles but can leave that directory on
// disk, where it shadows the workspace link during tsc. Remove it.
for (const entry of readdirSync(channelsDir)) {
  rmSync(join(channelsDir, entry, 'node_modules', '@qwen-code'), {
    recursive: true,
    force: true,
  });
}

console.log(`Successfully bumped versions to v${newVersion}.`);
