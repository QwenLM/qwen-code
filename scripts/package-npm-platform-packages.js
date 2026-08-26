#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Repackages the standalone archives built by package:standalone:release into
 * npm platform packages (@qwen-code/qwen-code-<os>-<arch>).
 *
 * Each platform package carries the full standalone runtime — the pinned Bun
 * build, the native renderer libraries, and the bundled CLI — so that
 * `npm install @qwen-code/qwen-code` gets a working OpenTUI CLI via the
 * optionalDependencies mechanism (os/cpu fields make npm pick exactly one
 * platform package per install). The JS-only main package resolves the
 * matching platform package at runtime through scripts/npm-bin.js.
 *
 * Run after package:standalone:release, with the same --version, so the
 * platform package versions line up with the main package version that
 * prepare:package stamps into dist/package.json.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { RELEASE_TARGETS } from './build-standalone-release.js';
import { fail, parseArgs } from './release-script-utils.js';

// RELEASE_TARGETS (build-standalone-release.js) is the authority on which
// platforms ship; derive the npm platform packages from it so a target
// rename/add cannot drift between the archive builder and this repackager.
const OS_NAMES = { darwin: 'darwin', linux: 'linux', win: 'win32' };
const PLATFORMS = RELEASE_TARGETS.map((target) => {
  const [osPart, cpu] = target.qwenTarget.split('-');
  return {
    archive:
      `qwen-code-${target.qwenTarget}.` +
      (target.qwenTarget === 'win-x64' ? 'zip' : 'tar.gz'),
    name: `@qwen-code/qwen-code-${target.qwenTarget}`,
    os: [OS_NAMES[osPart]],
    cpu: [cpu],
  };
});

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

function parseOptions(argv) {
  const args = parseArgs(argv, {
    '--version': { key: 'version' },
    '--standalone-dir': { key: 'standaloneDir' },
    '--out-dir': { key: 'outDir' },
  });
  if (!args.version) {
    fail('--version is required (must match the release version)');
  }
  return {
    version: args.version,
    standaloneDir: path.resolve(
      args.standaloneDir ?? path.join(ROOT_DIR, 'dist', 'standalone'),
    ),
    outDir: path.resolve(
      args.outDir ?? path.join(ROOT_DIR, 'dist', 'npm-platform'),
    ),
  };
}

function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (archivePath.endsWith('.zip')) {
    execFileSync('unzip', ['-qo', archivePath, '-d', destDir], {
      stdio: 'inherit',
    });
  } else {
    execFileSync('tar', ['-xzf', archivePath, '-C', destDir], {
      stdio: 'inherit',
    });
  }
}

function assertFile(...segments) {
  const filePath = path.join(...segments);
  if (!fs.existsSync(filePath)) {
    throw new Error(`platform package is incomplete: missing ${filePath}`);
  }
  return filePath;
}

function packagePlatform(platform, options) {
  const archivePath = path.join(options.standaloneDir, platform.archive);
  if (!fs.existsSync(archivePath)) {
    throw new Error(
      `standalone archive not found: ${archivePath}. ` +
        'Run package:standalone:release first.',
    );
  }

  const shortName = platform.name.replace('@qwen-code/', '');
  const packageDir = path.join(options.outDir, shortName);
  fs.rmSync(packageDir, { recursive: true, force: true });

  const stagingDir = fs.mkdtempSync(path.join(options.outDir, '.staging-'));
  try {
    extractArchive(archivePath, stagingDir);

    // The archives carry a top-level qwen-code/ directory; lift its contents
    // to the package root.
    const archiveRoot = path.join(stagingDir, 'qwen-code');
    if (!fs.existsSync(archiveRoot)) {
      throw new Error(`archive ${platform.archive} has no qwen-code/ root`);
    }
    fs.mkdirSync(options.outDir, { recursive: true });
    fs.renameSync(archiveRoot, packageDir);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  // The standalone metadata package.json describes the archive layout and is
  // not a valid npm manifest for this package; replace it with the platform
  // package manifest.
  fs.rmSync(path.join(packageDir, 'package.json'));
  // The archive doubles as a standalone-installer payload. Strip everything
  // isStandaloneInstallDir() probes (manifest.json, the bin/qwen shim, the
  // node/ compat mirror) so the CLI never mistakes an npm platform package
  // for a standalone install; node/ and bin/ are also dead weight on the npm
  // channel — the launcher runs lib/cli-entry.js under the bundled Bun.
  fs.rmSync(path.join(packageDir, 'manifest.json'), { force: true });
  fs.rmSync(path.join(packageDir, 'bin'), { recursive: true, force: true });
  fs.rmSync(path.join(packageDir, 'node'), { recursive: true, force: true });
  const manifest = {
    name: platform.name,
    version: options.version,
    description:
      'Qwen Code prebuilt runtime (Bun + OpenTUI native renderer) for ' +
      `${platform.os.join('/')} ${platform.cpu.join('/')}`,
    license: 'Apache-2.0',
    repository: {
      type: 'git',
      url: 'git+https://github.com/QwenLM/qwen-code.git',
    },
    // No exports/scripts on purpose: the package is pure payload, resolved
    // by the main package's npm-bin.js launcher at runtime. os/cpu make npm
    // skip the package on non-matching platforms without failing installs.
    os: platform.os,
    cpu: platform.cpu,
  };
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  // Sanity-check the layout the npm-bin.js launcher depends on.
  const isWindows = platform.os.includes('win32');
  assertFile(packageDir, 'lib', 'cli-entry.js');
  assertFile(packageDir, 'bun', ...(isWindows ? ['bun.exe'] : ['bin', 'bun']));
  for (const stripped of [
    path.join(packageDir, 'manifest.json'),
    path.join(packageDir, 'bin'),
    path.join(packageDir, 'node'),
  ]) {
    if (fs.existsSync(stripped)) {
      throw new Error(
        `platform package still carries a standalone fingerprint: ${stripped}`,
      );
    }
  }

  console.log(`packaged ${platform.name}@${options.version} -> ${packageDir}`);
  return manifest;
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  fs.mkdirSync(options.outDir, { recursive: true });

  const manifests = PLATFORMS.map((platform) =>
    packagePlatform(platform, options),
  );

  const optionalDependencies = Object.fromEntries(
    manifests.map((manifest) => [manifest.name, manifest.version]),
  );
  fs.writeFileSync(
    path.join(options.outDir, 'optional-dependencies.json'),
    `${JSON.stringify(optionalDependencies, null, 2)}\n`,
  );
  console.log(
    `optionalDependencies for the main package: ${JSON.stringify(optionalDependencies)}`,
  );
}

main();
