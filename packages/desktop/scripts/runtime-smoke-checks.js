import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ripgrepByTarget = new Map([
  ['darwin-arm64', ['arm64-darwin', 'rg']],
  ['darwin-x64', ['x64-darwin', 'rg']],
  ['linux-arm64', ['arm64-linux', 'rg']],
  ['linux-x64', ['x64-linux', 'rg']],
  ['win32-x64', ['x64-win32', 'rg.exe']],
]);

export function verifyRuntimeIntegrity(runtimeRoot) {
  const required = [
    'manifest.json',
    'checksums.json',
    'LICENSE',
    'NOTICE',
    'node/LICENSE',
    'lib/cli-entry.js',
    'lib/web-shell/index.html',
  ];
  for (const relative of required) {
    const file = path.join(runtimeRoot, relative);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Bundled runtime file is missing: ${relative}`);
    }
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(runtimeRoot, 'manifest.json'), 'utf8'),
  );
  for (const field of [
    'desktopVersion',
    'qwenCodeVersion',
    'qwenCodeCommit',
    'target',
    'node',
    'builtAt',
  ]) {
    if (!manifest[field])
      throw new Error(`Runtime manifest is missing ${field}`);
  }
  const checksums = JSON.parse(
    fs.readFileSync(path.join(runtimeRoot, 'checksums.json'), 'utf8'),
  );
  for (const [relative, expected] of Object.entries(checksums)) {
    const file = path.join(runtimeRoot, relative);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Checksummed runtime file is missing: ${relative}`);
    }
    const actual = crypto
      .createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex');
    if (actual !== expected) {
      throw new Error(`Bundled runtime checksum mismatch: ${relative}`);
    }
  }
  return manifest;
}

export function verifyBundledRipgrep(runtimeRoot, target) {
  const targetPath = ripgrepByTarget.get(target);
  if (!targetPath) throw new Error(`Unsupported desktop target: ${target}`);
  const ripgrepPath = path.join(
    runtimeRoot,
    'lib',
    'vendor',
    'ripgrep',
    ...targetPath,
  );
  if (!fs.statSync(ripgrepPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Bundled ripgrep is missing for ${target}`);
  }
  const result = spawnSync(ripgrepPath, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (
    result.error ||
    result.status !== 0 ||
    !result.stdout.startsWith('ripgrep')
  ) {
    throw new Error(
      `Bundled ripgrep failed its version probe for ${target}:\n${result.error?.message ?? ''}${result.stdout}${result.stderr}`,
    );
  }
  console.log(`Bundled ripgrep ready (${result.stdout.split('\n', 1)[0]})`);
}
