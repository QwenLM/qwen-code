/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Publish CLI bundle and channel-base to anpm registry.
 *
 * Mirrors upstream's release.yml approach: publish the esbuild CLI bundle
 * from dist/ (after prepare:package) and @qwen-code/channel-base from its
 * workspace directory. All other workspace packages (core, webui, sdk, etc.)
 * are either bundled into the CLI or published via separate pipelines upstream,
 * so they are NOT published here.
 *
 * Usage:
 *   node scripts/publish-packages.js --token <anpm_token> [--tag latest] [--pre-id dataworks] [--dry-run] [--auto-version]
 *
 * Options:
 *   --token <token>     anpm auth token (required unless --dry-run)
 *   --tag <tag>         npm dist-tag (default: "latest")
 *   --pre-id <id>       prerelease identifier for version suffix (default: "dataworks")
 *                       e.g. --pre-id dataworks → 0.14.7-dataworks.3
 *   --dry-run           simulate publish without actually publishing
 *   --auto-version      auto-increment prerelease version based on registry
 *                       e.g. 0.14.7 → 0.14.7-dataworks.3 (if dataworks.2 exists)
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const REGISTRY = 'https://registry.anpm.alibaba-inc.com/';

/**
 * Packages to publish, mirroring upstream release.yml.
 * Each entry: { dir, label }.
 *   - dir:   working directory for `npm publish` (relative to rootDir)
 *   - label: human-readable name for logs
 */
const PUBLISH_TARGETS = [
  { dir: 'dist', label: 'CLI bundle' },
  { dir: 'packages/channels/base', label: 'channel-base' },
];

/**
 * Expand workspace entries (which may contain glob patterns like "packages/*")
 * into concrete package.json paths.
 */
function expandWorkspacePaths(workspaces, root) {
  const seen = new Set();
  for (const ws of workspaces || []) {
    if (ws.includes('*')) {
      const [base] = ws.split('*');
      const dir = path.join(root, base);
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgPath = path.join(dir, entry.name, 'package.json');
        if (fs.existsSync(pkgPath)) seen.add(pkgPath);
      }
    } else {
      const pkgPath = path.join(root, ws, 'package.json');
      if (fs.existsSync(pkgPath)) seen.add(pkgPath);
    }
  }
  return [...seen];
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const autoVersion = args.includes('--auto-version');
const tagIdx = args.indexOf('--tag');
const tag = tagIdx !== -1 && args[tagIdx + 1] ? args[tagIdx + 1] : 'latest';
const preIdIdx = args.indexOf('--pre-id');
const preId =
  preIdIdx !== -1 && args[preIdIdx + 1] ? args[preIdIdx + 1] : 'dataworks';
const tokenIdx = args.indexOf('--token');
const token = tokenIdx !== -1 ? args[tokenIdx + 1] : '';

// -------------------------------------------------------------------------
// Configure .npmrc (project + home, same as npm-publisher)
// -------------------------------------------------------------------------

if (!dryRun && !token) {
  console.error('Error: --token <anpm_token> is required for publishing.');
  console.error('Use --dry-run to skip authentication.');
  process.exit(1);
}

if (token) {
  const npmrcContent = [
    `registry=${REGISTRY}`,
    `//registry.anpm.alibaba-inc.com/:_authToken=${token}`,
    'always-auth=true',
    '',
  ].join('\n');

  const projectNpmrc = path.join(rootDir, '.npmrc');
  fs.writeFileSync(projectNpmrc, npmrcContent);
  console.log(`Wrote ${projectNpmrc}`);

  const homeNpmrc = path.join(os.homedir(), '.npmrc');
  if (homeNpmrc !== projectNpmrc) {
    fs.writeFileSync(homeNpmrc, npmrcContent);
    console.log(`Wrote ${homeNpmrc}`);
  }

  console.log('npm registry auth configured\n');
}

// -------------------------------------------------------------------------
// Auto-version: resolve next prerelease
// -------------------------------------------------------------------------

if (autoVersion) {
  console.log(
    `Auto-versioning enabled (prerelease identifier: ${preId}, dist-tag: ${tag})\n`,
  );

  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'),
  );
  const baseVersion = rootPkg.version.replace(/-.*$/, '');

  const nextVersion = resolveNextVersion(rootPkg.name, baseVersion, preId);
  console.log(`\nResolved next version: ${nextVersion}`);
  console.log('Applying to all workspace packages...\n');

  updatePackageVersion(path.join(rootDir, 'package.json'), nextVersion);
  console.log(`  (root) → ${nextVersion}`);

  const pkgPaths = expandWorkspacePaths(rootPkg.workspaces, rootDir);
  for (const pkgPath of pkgPaths) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg.private) continue;
    updatePackageVersion(pkgPath, nextVersion);
    console.log(`  ${pkg.name} → ${nextVersion}`);
  }
  console.log();

  // Re-bundle CLI so esbuild picks up the new version in process.env.CLI_VERSION
  console.log('Re-bundling CLI with updated version...\n');
  execSync('npm run bundle', { cwd: rootDir, stdio: 'inherit' });
  console.log();
}

// -------------------------------------------------------------------------
// Prepare dist/ for publishing (synthetic package.json, README, LICENSE)
// -------------------------------------------------------------------------

console.log('Preparing dist/ package for publishing...\n');
execSync('npm run prepare:package', { cwd: rootDir, stdio: 'inherit' });
console.log();

// -------------------------------------------------------------------------
// Publish packages explicitly (matching upstream release.yml)
// -------------------------------------------------------------------------

let failed = false;

for (const { dir, label } of PUBLISH_TARGETS) {
  const absDir = path.join(rootDir, dir);
  const pkgPath = path.join(absDir, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    console.error(`⚠️  Skipping ${label}: ${pkgPath} not found`);
    continue;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const publishCmd = [
    'npm publish',
    `--tag ${tag}`,
    `--registry ${REGISTRY}`,
    dryRun ? '--dry-run' : '',
  ]
    .filter(Boolean)
    .join(' ');

  console.log(`Publishing ${label} (${pkg.name}@${pkg.version})...`);
  console.log(`  cwd: ${absDir}`);
  console.log(`  cmd: ${publishCmd}\n`);

  try {
    execSync(publishCmd, {
      cwd: absDir,
      stdio: 'inherit',
      env: { ...process.env },
    });
    console.log(`\n✅ ${label} published successfully\n`);
  } catch (_err) {
    console.error(`\n❌ ${label} publish failed\n`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log('✅ All packages published successfully\n');

// -------------------------------------------------------------------------
// Print summary
// -------------------------------------------------------------------------

console.log('📦 Published packages:');
for (const { dir, label } of PUBLISH_TARGETS) {
  const pkgPath = path.join(rootDir, dir, 'package.json');
  if (!fs.existsSync(pkgPath)) continue;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  console.log(`  ├─ ${dir} (${pkg.name}@${pkg.version}) [${label}]`);
}
console.log();

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Query the registry for existing versions and compute the next prerelease.
 *
 * Given base version "0.14.7" and preId "dataworks":
 *   - If no 0.14.7-dataworks.* exists → 0.14.7-dataworks.0
 *   - If 0.14.7-dataworks.2 is the highest → 0.14.7-dataworks.3
 */
function resolveNextVersion(pkgName, baseVersion, preId) {
  console.log(
    `Querying registry for ${pkgName} versions matching ${baseVersion}-${preId}.*`,
  );

  let versions = [];
  try {
    const output = execSync(
      `npm view ${pkgName} versions --json --registry ${REGISTRY}`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(output);
    versions = Array.isArray(parsed) ? parsed : [parsed];
  } catch (_err) {
    console.log('  No existing versions found on registry (new package?)');
  }

  const prefix = `${baseVersion}-${preId}.`;
  const existing = versions
    .filter((v) => v.startsWith(prefix))
    .map((v) => {
      const num = parseInt(v.slice(prefix.length), 10);
      return isNaN(num) ? -1 : num;
    })
    .filter((n) => n >= 0);

  if (existing.length === 0) {
    console.log(`  No existing ${preId} versions for ${baseVersion}`);
    return `${baseVersion}-${preId}.0`;
  }

  const maxNum = Math.max(...existing);
  console.log(
    `  Found ${existing.length} existing ${preId} versions, highest: ${prefix}${maxNum}`,
  );
  return `${baseVersion}-${preId}.${maxNum + 1}`;
}

function updatePackageVersion(pkgPath, newVersion) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}
