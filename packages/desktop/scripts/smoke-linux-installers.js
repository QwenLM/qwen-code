#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  verifyBundledNode,
  verifyBundledRipgrep,
  verifyRuntimeIntegrity,
} from './runtime-smoke-checks.js';

// AppImage's excludelist: these are supplied by the AppImage runtime or the
// host's graphics/C++ runtime. Bundling them conflicts with the host drivers
// or its glibc and C++ ABI. Keep this list in sync with the upstream file.
// https://github.com/AppImageCommunity/pkg2appimage/blob/master/excludelist
const APPIMAGE_HOST_LIBRARIES = new Set([
  'ld-linux-aarch64.so.1',
  'ld-linux-x86-64.so.2',
  'ld-linux.so.2',
  'libBrokenLocale.so.1',
  'libEGL.so.1',
  'libGL.so.1',
  'libGLdispatch.so.0',
  'libGLX.so.0',
  'libICE.so.6',
  'libOpenGL.so.0',
  'libSM.so.6',
  'libX11-xcb.so.1',
  'libX11.so.6',
  'libanl.so.1',
  'libasound.so.2',
  'libc.so.6',
  'libcidn.so.1',
  'libcom_err.so.2',
  'libdl.so.2',
  'libdrm.so.2',
  'libexpat.so.1',
  'libfontconfig.so.1',
  'libfreetype.so.6',
  'libfribidi.so.0',
  'libgbm.so.1',
  'libgcc_s.so.1',
  'libglapi.so.0',
  'libgmp.so.10',
  'libgpg-error.so.0',
  'libharfbuzz.so.0',
  'libjack.so.0',
  'libm.so.6',
  'libmvec.so.1',
  'libnss_compat.so.2',
  'libnss_dns.so.2',
  'libnss_files.so.2',
  'libnss_hesiod.so.2',
  'libnss_nis.so.2',
  'libnss_nisplus.so.2',
  'libpipewire-0.3.so.0',
  'libpthread.so.0',
  'libresolv.so.2',
  'librt.so.1',
  'libstdc++.so.6',
  'libthread_db.so.1',
  'libusb-1.0.so.0',
  'libutil.so.1',
  'libuuid.so.1',
  'libwayland-client.so.0',
  'libxcb.so.1',
  'libxcb-dri2.so.0',
  'libxcb-dri3.so.0',
  'libz.so.1',
]);

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

export function verifyExtractedRuntime(extractedRoot) {
  const runtimeRoot = findRuntimeRoot(extractedRoot);
  const manifest = verifyRuntimeIntegrity(runtimeRoot);
  verifyBundledRipgrep(runtimeRoot, manifest.target);
  verifyBundledNode(runtimeRoot);
}

export function verifyAppImageClosure(extractedRoot) {
  const files = walkFiles(extractedRoot);
  const bundled = new Set(files.map((file) => path.basename(file)));
  const elfFiles = files.filter(isElf);
  if (elfFiles.length === 0) {
    throw new Error('AppImage contains no ELF files');
  }
  const missing = new Set();
  for (const elf of elfFiles) {
    const result = spawnSync('readelf', ['-d', elf], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `Failed to read dynamic dependencies for ${path.relative(extractedRoot, elf)}: ${result.error?.message ?? result.stderr}`,
      );
    }
    for (const [, soname] of result.stdout.matchAll(
      /\(NEEDED\).*\[([^\]]+)\]/g,
    )) {
      if (!bundled.has(soname) && !APPIMAGE_HOST_LIBRARIES.has(soname)) {
        missing.add(soname);
      }
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `AppImage dependency closure is incomplete: ${[...missing].sort().join(', ')}`,
    );
  }
}

function isElf(file) {
  try {
    const buffer = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r');
    try {
      return (
        fs.readSync(fd, buffer, 0, 4, 0) === 4 &&
        buffer.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
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
    verifyExtractedRuntime(extractedRoot);
    if (type === 'appimage') verifyAppImageClosure(extractedRoot);
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
