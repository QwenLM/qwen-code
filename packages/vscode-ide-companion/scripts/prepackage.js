/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * VS Code extension packaging orchestration.
 *
 * We bundle the CLI into the extension so users don't need a global install.
 * To match the published CLI layout, we need to:
 * - build root bundle (dist/cli.js + vendor/ + sandbox profiles)
 * - run root prepare:package (dist/package.json + locales + README/LICENSE)
 * - install production deps into root dist/ (dist/node_modules) so runtime deps
 *   like optional node-pty are present inside the VSIX payload.
 *
 * Then we generate notices and build the extension.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..', '..');
const bundledCliDir = path.join(extensionRoot, 'dist', 'qwen-cli');

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (res.error) {
    throw res.error;
  }
  if (typeof res.status === 'number' && res.status !== 0) {
    throw new Error(
      `Command failed (${res.status}): ${cmd} ${args.map((a) => JSON.stringify(a)).join(' ')}`,
    );
  }
}

function parseVsceTarget(target) {
  if (!target) return null;
  const parts = target.split('-');
  if (parts.length !== 2) return null;
  const [platform, arch] = parts;
  return { platform, arch };
}

function getExpectedRipgrepDirName() {
  const target = parseVsceTarget(process.env.VSCODE_TARGET);
  const platform = target?.platform ?? process.platform;
  const arch = target?.arch ?? process.arch;

  const normalizedPlatform =
    platform === 'darwin' || platform === 'linux' || platform === 'win32'
      ? platform
      : null;
  const normalizedArch = arch === 'x64' || arch === 'arm64' ? arch : null;

  if (!normalizedPlatform || !normalizedArch) return null;
  return `${normalizedArch}-${normalizedPlatform}`;
}

function pruneBundledRipgrep() {
  const isUniversalBuild = process.env.UNIVERSAL_BUILD === 'true';
  if (isUniversalBuild) {
    console.log('[prepackage] Universal build: keeping all ripgrep binaries');
    return;
  }

  if (!process.env.VSCODE_TARGET) {
    console.log(
      '[prepackage] VSCODE_TARGET not set: keeping all ripgrep binaries',
    );
    return;
  }

  const expectedDirName = getExpectedRipgrepDirName();
  if (!expectedDirName) {
    console.warn(
      '[prepackage] Could not resolve expected ripgrep target; keeping all binaries',
    );
    return;
  }

  const ripgrepDir = path.join(bundledCliDir, 'vendor', 'ripgrep');
  if (!fs.existsSync(ripgrepDir)) {
    console.log('[prepackage] No bundled ripgrep directory found; skipping');
    return;
  }

  const entries = fs.readdirSync(ripgrepDir, { withFileTypes: true });
  const removed = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!/^(x64|arm64)-(darwin|linux|win32)$/.test(name)) continue;
    if (name === expectedDirName) continue;

    const fullPath = path.join(ripgrepDir, name);
    fs.rmSync(fullPath, { recursive: true, force: true });
    removed.push(name);
  }

  if (removed.length === 0) {
    console.log(
      `[prepackage] Ripgrep already pruned for ${expectedDirName} (no changes)`,
    );
    return;
  }

  console.log(
    `[prepackage] Pruned ripgrep binaries; kept ${expectedDirName}, removed: ${removed.join(', ')}`,
  );
}

function removeSelfReferenceFromNodeModules() {
  if (process.platform !== 'win32') return;

  const packageJsonPath = path.join(bundledCliDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return;

  let packageName;
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    packageName = parsed?.name;
  } catch {
    return;
  }

  if (typeof packageName !== 'string' || packageName.length === 0) return;

  // Some npm installations on Windows can create a junction in node_modules
  // pointing back to the package itself. vsce/yazl can't zip that reliably.
  let selfPath;
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/');
    if (!scope || !name) return;
    selfPath = path.join(bundledCliDir, 'node_modules', scope, name);
  } else {
    selfPath = path.join(bundledCliDir, 'node_modules', packageName);
  }

  if (!fs.existsSync(selfPath)) return;

  fs.rmSync(selfPath, { recursive: true, force: true });
  console.log(
    `[prepackage] Windows: removed self-reference from node_modules: ${packageName}`,
  );

  // Cleanup empty scope directory (cosmetic).
  try {
    const parentDir = path.dirname(selfPath);
    if (
      fs.existsSync(parentDir) &&
      fs.statSync(parentDir).isDirectory() &&
      fs.readdirSync(parentDir).length === 0
    ) {
      fs.rmdirSync(parentDir);
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function main() {
  const npm = npmBin();

  // Root bundling depends on built workspace outputs. Use the root build to
  // ensure all required workspace dist/ artifacts exist.
  console.log('[prepackage] Building repo...');
  run(npm, ['--prefix', repoRoot, 'run', 'build'], { cwd: repoRoot });

  console.log('[prepackage] Bundling root CLI...');
  run(npm, ['--prefix', repoRoot, 'run', 'bundle'], { cwd: repoRoot });

  console.log('[prepackage] Preparing root dist/ package metadata...');
  run(npm, ['--prefix', repoRoot, 'run', 'prepare:package'], { cwd: repoRoot });

  console.log('[prepackage] Preparing webui dist/ package metadata...');
  run(
    npm,
    ['--prefix', path.join(repoRoot, 'packages', 'webui'), 'run', 'build'],
    { cwd: repoRoot },
  );

  console.log('[prepackage] Generating notices...');
  run(npm, ['run', 'generate:notices'], { cwd: extensionRoot });

  console.log('[prepackage] Building extension (production)...');
  run(npm, ['run', 'build:prod'], { cwd: extensionRoot });

  console.log('[prepackage] Copying bundled CLI dist/ into extension...');
  run(
    'node',
    [`${path.join(extensionRoot, 'scripts', 'copy-bundled-cli.js')}`],
    {
      cwd: extensionRoot,
    },
  );

  const isUniversalBuild = process.env.UNIVERSAL_BUILD === 'true';

  console.log(
    '[prepackage] Installing production deps into extension dist/qwen-cli...',
  );

  const installArgs = [
    '--prefix',
    bundledCliDir,
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
  ];

  // For universal build, exclude optional dependencies (node-pty native binaries)
  // This ensures the universal VSIX works on all platforms using child_process fallback
  if (isUniversalBuild) {
    installArgs.push('--omit=optional');
    console.log(
      '[prepackage] Universal build: excluding optional dependencies (node-pty)',
    );
  }

  run(npm, installArgs, {
    cwd: bundledCliDir,
    env: {
      ...process.env,
      npm_config_workspaces: 'false',
      npm_config_include_workspace_root: 'false',
      npm_config_link_workspace_packages: 'false',
    },
  });

  removeSelfReferenceFromNodeModules();
  pruneBundledRipgrep();
}

main();
