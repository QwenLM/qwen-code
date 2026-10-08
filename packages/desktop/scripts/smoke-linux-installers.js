#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  verifyBundledRipgrep,
  verifyRuntimeIntegrity,
} from './runtime-smoke-checks.js';

export function findLinuxInstallers(bundleRoot) {
  const files = walkFiles(bundleRoot);
  return {
    appImage: only(
      files.filter((file) => file.endsWith('.AppImage')),
      'AppImage',
    ),
    deb: only(
      files.filter((file) => file.endsWith('.deb')),
      'deb',
    ),
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

function smokeInstaller(installer, type) {
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
    } else {
      execFileSync('dpkg-deb', ['--extract', installer, extractedRoot], {
        stdio: 'inherit',
      });
    }
    const runtimeRoot = findRuntimeRoot(extractedRoot);
    const manifest = verifyRuntimeIntegrity(runtimeRoot);
    verifyBundledRipgrep(runtimeRoot, manifest.target);
  } finally {
    fs.rmSync(extractedRoot, { recursive: true, force: true });
  }
}

function main() {
  const bundleRoot = process.argv[2];
  if (!bundleRoot) {
    throw new Error(
      'Usage: node scripts/smoke-linux-installers.js <bundle-root>',
    );
  }
  const { appImage, deb } = findLinuxInstallers(path.resolve(bundleRoot));
  smokeInstaller(appImage, 'appimage');
  smokeInstaller(deb, 'deb');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
