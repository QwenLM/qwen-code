/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const distRoot = path.join(rootDir, 'dist', 'native');
const entryPoint = path.join(rootDir, 'packages', 'cli', 'index.ts');
const localesDir = path.join(
  rootDir,
  'packages',
  'cli',
  'src',
  'i18n',
  'locales',
);
const vendorDir = path.join(rootDir, 'packages', 'core', 'vendor');

const rootPackageJson = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'),
);
const cliName = Object.keys(rootPackageJson.bin || {})[0] || 'qwen';
const version = rootPackageJson.version;

const TARGETS = [
  {
    id: 'darwin-arm64',
    os: 'darwin',
    arch: 'arm64',
    bunTarget: 'bun-darwin-arm64',
  },
  {
    id: 'darwin-x64',
    os: 'darwin',
    arch: 'x64',
    bunTarget: 'bun-darwin-x64',
  },
  {
    id: 'linux-arm64',
    os: 'linux',
    arch: 'arm64',
    bunTarget: 'bun-linux-arm64',
  },
  {
    id: 'linux-x64',
    os: 'linux',
    arch: 'x64',
    bunTarget: 'bun-linux-x64',
  },
  {
    id: 'linux-arm64-musl',
    os: 'linux',
    arch: 'arm64',
    libc: 'musl',
    bunTarget: 'bun-linux-arm64-musl',
  },
  {
    id: 'linux-x64-musl',
    os: 'linux',
    arch: 'x64',
    libc: 'musl',
    bunTarget: 'bun-linux-x64-musl',
  },
  {
    id: 'windows-x64',
    os: 'windows',
    arch: 'x64',
    bunTarget: 'bun-windows-x64',
  },
];

function getHostTargetId() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'win32' && arch === 'x64') return 'windows-x64';
  if (platform === 'linux' && arch === 'x64') {
    return isMusl() ? 'linux-x64-musl' : 'linux-x64';
  }
  if (platform === 'linux' && arch === 'arm64') {
    return isMusl() ? 'linux-arm64-musl' : 'linux-arm64';
  }
  return null;
}

function isMusl() {
  if (process.platform !== 'linux') return false;
  const report = process.report?.getReport?.();
  return !report?.header?.glibcVersionRuntime;
}

function parseArgs(argv) {
  const args = {
    all: false,
    list: false,
    targets: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      args.all = true;
    } else if (arg === '--list-targets') {
      args.list = true;
    } else if (arg === '--target' && argv[i + 1]) {
      args.targets.push(argv[i + 1]);
      i += 1;
    } else if (arg?.startsWith('--targets=')) {
      const raw = arg.split('=')[1] || '';
      args.targets.push(
        ...raw
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      );
    }
  }

  return args;
}

function ensureBunAvailable() {
  const result = spawnSync('bun', ['--version'], { stdio: 'pipe' });
  if (result.error) {
    console.error('Error: Bun is required to build native binaries.');
    console.error('Install Bun from https://bun.sh and retry.');
    process.exit(1);
  }
}

function cleanNativeDist() {
  fs.rmSync(distRoot, { recursive: true, force: true });
  fs.mkdirSync(distRoot, { recursive: true });
}

function copyRecursiveSync(src, dest) {
  if (!fs.existsSync(src)) {
    return;
  }

  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    for (const entry of fs.readdirSync(src)) {
      if (entry === '.DS_Store') continue;
      copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
    if (stats.mode & 0o111) {
      fs.chmodSync(dest, stats.mode);
    }
  }
}

function copyNativeAssets(targetDir, target) {
  if (target.os === 'darwin') {
    const sbFiles = findSandboxProfiles();
    for (const file of sbFiles) {
      fs.copyFileSync(file, path.join(targetDir, path.basename(file)));
    }
  }

  copyVendorRipgrep(targetDir, target);
  copyRecursiveSync(localesDir, path.join(targetDir, 'locales'));
}

function findSandboxProfiles() {
  const matches = [];
  const packagesDir = path.join(rootDir, 'packages');
  const stack = [packagesDir];

  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.sb')) {
        matches.push(entryPath);
      }
    }
  }

  return matches;
}

function copyVendorRipgrep(targetDir, target) {
  if (!fs.existsSync(vendorDir)) {
    console.warn(`Warning: Vendor directory not found at ${vendorDir}`);
    return;
  }

  const vendorRipgrepDir = path.join(vendorDir, 'ripgrep');
  if (!fs.existsSync(vendorRipgrepDir)) {
    console.warn(`Warning: ripgrep directory not found at ${vendorRipgrepDir}`);
    return;
  }

  const platform = target.os === 'windows' ? 'win32' : target.os;
  const ripgrepTargetDir = path.join(
    vendorRipgrepDir,
    `${target.arch}-${platform}`,
  );
  if (!fs.existsSync(ripgrepTargetDir)) {
    console.warn(`Warning: ripgrep binaries not found at ${ripgrepTargetDir}`);
    return;
  }

  const destVendorRoot = path.join(targetDir, 'vendor');
  const destRipgrepDir = path.join(destVendorRoot, 'ripgrep');
  fs.mkdirSync(destRipgrepDir, { recursive: true });

  const copyingFile = path.join(vendorRipgrepDir, 'COPYING');
  if (fs.existsSync(copyingFile)) {
    fs.copyFileSync(copyingFile, path.join(destRipgrepDir, 'COPYING'));
  }

  copyRecursiveSync(
    ripgrepTargetDir,
    path.join(destRipgrepDir, path.basename(ripgrepTargetDir)),
  );
}

function buildTarget(target) {
  const outputName = `${cliName}-${target.id}`;
  const targetDir = path.join(distRoot, outputName);
  const binDir = path.join(targetDir, 'bin');
  const binaryName = target.os === 'windows' ? `${cliName}.exe` : cliName;

  fs.mkdirSync(binDir, { recursive: true });

  const buildArgs = [
    'build',
    '--compile',
    '--target',
    target.bunTarget,
    entryPoint,
    '--outfile',
    path.join(binDir, binaryName),
  ];

  const result = spawnSync('bun', buildArgs, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Bun build failed for ${target.id}`);
  }

  const packageJson = {
    name: outputName,
    version,
    os: [target.os === 'windows' ? 'win32' : target.os],
    cpu: [target.arch],
  };

  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    JSON.stringify(packageJson, null, 2) + '\n',
  );

  copyNativeAssets(targetDir, target);
}

function main() {
  if (!fs.existsSync(entryPoint)) {
    console.error(`Entry point not found at ${entryPoint}`);
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    console.log(TARGETS.map((target) => target.id).join('\n'));
    return;
  }

  ensureBunAvailable();
  cleanNativeDist();

  let selectedTargets = [];
  if (args.all) {
    selectedTargets = TARGETS;
  } else if (args.targets.length > 0) {
    selectedTargets = TARGETS.filter((target) =>
      args.targets.includes(target.id),
    );
  } else {
    const hostTargetId = getHostTargetId();
    if (!hostTargetId) {
      console.error(
        `Unsupported host platform/arch: ${process.platform}/${process.arch}`,
      );
      process.exit(1);
    }
    selectedTargets = TARGETS.filter((target) => target.id === hostTargetId);
  }

  if (selectedTargets.length === 0) {
    console.error('No matching targets selected.');
    process.exit(1);
  }

  for (const target of selectedTargets) {
    console.log(`\nBuilding native binary for ${target.id}...`);
    buildTarget(target);
  }

  console.log('\n✅ Native build complete.');
}

main();
