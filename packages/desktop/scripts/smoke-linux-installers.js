#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  verifyBundledNode,
  verifyBundledRipgrep,
  verifyRuntimeIntegrity,
} from './runtime-smoke-checks.js';

export function findLinuxInstallers(
  bundleRoot,
  required = ['appImage', 'deb'],
) {
  const files = walkFiles(bundleRoot);
  const matchers = {
    appImage: ['AppImage', (file) => file.endsWith('.AppImage')],
    deb: ['deb', (file) => file.endsWith('.deb')],
    rpm: ['rpm', (file) => file.endsWith('.rpm')],
  };
  return Object.fromEntries(
    required.map((kind) => {
      const [label, matches] = matchers[kind];
      return [kind, only(files.filter(matches), label)];
    }),
  );
}

export function parseInstallerArgs(argv) {
  // The default keeps the existing guarantee: an AppImage/deb leg must ship
  // both. An rpm leg ships one artifact, so it asks for exactly that.
  const required = [];
  let expectGlibc = '';
  let bundleRoot;
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--require') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--require needs a comma-separated installer list');
      }
      const names = value.split(',').map((name) => name.trim());
      if (names.some((name) => !['appImage', 'deb', 'rpm'].includes(name))) {
        throw new Error(
          `--require accepts appImage, deb, and rpm; got '${value}'`,
        );
      }
      required.push(...names);
    } else if (argument === '--expect-glibc') {
      const value = argv[++i];
      if (!value || value.startsWith('--') || !/^\d+\.\d+$/.test(value)) {
        throw new Error('--expect-glibc needs a version such as 2.43');
      }
      expectGlibc = value;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown installer smoke option: ${argument}`);
    } else if (bundleRoot) {
      throw new Error(
        `Expected one bundle root, got '${bundleRoot}' and '${argument}'`,
      );
    } else {
      bundleRoot = argument;
    }
  }
  const selected = required.length ? required : ['appImage', 'deb'];
  if (selected.includes('rpm') && !expectGlibc) {
    throw new Error('RPM smoke checks require --expect-glibc');
  }
  if (!selected.includes('rpm') && expectGlibc) {
    throw new Error('--expect-glibc is only valid with --require rpm');
  }
  return {
    bundleRoot,
    required: selected,
    expectGlibc,
  };
}

export function findRuntimeRoot(extractedRoot) {
  const manifests = walkFiles(extractedRoot).filter((file) =>
    file.endsWith(path.join('runtime', 'qwen-code', 'manifest.json')),
  );
  const manifest = only(manifests, 'bundled runtime manifest');
  return path.dirname(manifest);
}

function only(matches, description) {
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${description}, found ${matches.length}: ${matches.join(', ')}`,
    );
  }
  return matches[0];
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(absolute) : [absolute];
  });
}

export function verifyExtractedRuntime(extractedRoot) {
  const runtimeRoot = findRuntimeRoot(extractedRoot);
  const manifest = verifyRuntimeIntegrity(runtimeRoot);
  verifyBundledRipgrep(runtimeRoot, manifest.target);
  verifyBundledNode(runtimeRoot);
}

function smokeInstaller(installer, type, expectGlibc = '') {
  const extractedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `qwen-desktop-${type}-smoke-`),
  );
  try {
    if (type === 'appimage') {
      execFileSync(installer, ['--appimage-extract'], {
        cwd: extractedRoot,
        env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
        stdio: 'inherit',
      });
    } else if (type === 'rpm') {
      execFileSync(
        'sh',
        [
          '-c',
          'rpm2cpio "$1" | cpio -idm --quiet',
          'smoke',
          path.resolve(installer),
        ],
        { cwd: extractedRoot, stdio: 'inherit' },
      );
    } else {
      execFileSync('dpkg-deb', ['--extract', installer, extractedRoot], {
        stdio: 'inherit',
      });
    }
    verifyExtractedRuntime(extractedRoot);
    if (type === 'rpm') verifyRpmDependencies(installer, expectGlibc);
  } finally {
    fs.rmSync(extractedRoot, { recursive: true, force: true });
  }
}

export function verifyRpmDependencies(
  installer,
  expectGlibc,
  run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }),
) {
  const architecturals = run('rpm', ['-qp', '--qf', '%{ARCH}\n', installer])
    .trim()
    .split('\n')
    .filter(Boolean);
  if (architecturals.length === 0 || architecturals.includes('noarch')) {
    throw new Error('The Desktop rpm must declare a native architecture');
  }
  const requires = run('rpm', ['-qp', '--requires', installer])
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    !requires.some((entry) =>
      /^libwebkit2gtk-4\.1\.so\.0(?:\([^)]*\))*$/.test(entry),
    )
  ) {
    throw new Error(
      'The Desktop rpm must require libwebkit2gtk-4.1.so.0 from the distribution',
    );
  }
  const files = run('rpm', ['-qpl', installer])
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (files.some((file) => /(^|\/)libwebkit2gtk-4\.1\.so(?:\.|$)/.test(file))) {
    throw new Error('The Desktop rpm must not carry its own WebKitGTK library');
  }
  const glibcVersions = requires.flatMap((entry) => {
    const direct = entry.match(/^glibc\s*>=\s*(\d+\.\d+(?:\.\d+)?)/)?.[1];
    const symbol = entry.match(
      /^GLIBC_(\d+\.\d+(?:\.\d+)?)(?:\([^)]*\))*$/,
    )?.[1];
    return [direct, symbol].filter(Boolean);
  });
  const requiredFloor = glibcVersions.sort(compareVersions).at(-1);
  if (!requiredFloor) {
    throw new Error('The Desktop rpm must declare a glibc requirement');
  }
  if (compareVersions(requiredFloor, expectGlibc) > 0) {
    throw new Error(
      `Expected the Desktop rpm to require glibc no newer than ${expectGlibc}, found ${requiredFloor}`,
    );
  }
}

function compareVersions(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}

function main() {
  const { bundleRoot, required, expectGlibc } = parseInstallerArgs(
    process.argv.slice(2),
  );
  if (!bundleRoot) {
    throw new Error(
      'Usage: node scripts/smoke-linux-installers.js <bundle-root> [--require appImage,deb|rpm] [--expect-glibc VERSION]',
    );
  }
  const installers = findLinuxInstallers(path.resolve(bundleRoot), required);
  const kinds = {
    appimage: installers.appImage,
    deb: installers.deb,
    rpm: installers.rpm,
  };
  for (const [type, installer] of Object.entries(kinds)) {
    if (installer) smokeInstaller(installer, type, expectGlibc);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
