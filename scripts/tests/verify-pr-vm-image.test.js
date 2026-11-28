/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveExt4GuestImage,
  normalizeImageTargetPath,
} from '../verify-pr-vm-image.mjs';

const IMAGE_CLI = fileURLToPath(
  new URL('../verify-pr-vm-image.mjs', import.meta.url),
);

const cleanups = [];

function makeTempDir(prefix = 'vimg-') {
  const base = existsSync('/tmp') ? '/tmp' : tmpdir();
  const dir = realpathSync(mkdtempSync(join(base, prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()();
  }
});

describe('verify-pr-vm-image offline golden ext4 derivation', () => {
  it('validates and normalizes in-image target paths', () => {
    expect(normalizeImageTargetPath('/opt/qwen/guest-runner.py')).toBe(
      '/opt/qwen/guest-runner.py',
    );
    expect(() => normalizeImageTargetPath('opt/qwen/file')).toThrow(
      /invalid guest image target path/,
    );
    expect(() => normalizeImageTargetPath('/init')).toThrow(
      /nested below a top-level directory/,
    );
    expect(() => normalizeImageTargetPath('/opt/../etc/passwd')).toThrow(
      /must not traverse/,
    );
    expect(() => normalizeImageTargetPath('/opt/qwen/\0bad')).toThrow(
      /invalid guest image target path/,
    );
    expect(() => normalizeImageTargetPath('/opt/qwen/a\\b')).toThrow(
      /invalid guest image target path/,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'derives an ext4 image via debugfs/mkfs.ext4 without mutating golden source, enforces safety guards, and blocks image-tree symlink escapes',
    () => {
      const root = makeTempDir('vimg-drv-');
      const approved = join(root, 'approved');
      const outside = join(root, 'outside');
      const vault = join(approved, 'vault');
      mkdirSync(approved, { mode: 0o700 });
      mkdirSync(outside, { mode: 0o700 });
      mkdirSync(vault, { mode: 0o700 });

      const golden = join(root, 'golden-rootfs.ext4');
      writeFileSync(golden, 'readonly-golden-ext4-image-bytes', {
        mode: 0o444,
      });
      const goldenSha = sha256File(golden);

      const inspectedManifest = join(root, 'mkfs-seen.txt');
      const fakeDebugfs = join(root, 'fake-debugfs');
      writeExecutable(
        fakeDebugfs,
        [
          '#!/bin/sh',
          'set -eu',
          '# Expected: -R "rdump / <tree>" <image>',
          'TREE=$(printf "%s" "$2" | sed "s|^rdump / ||")',
          'mkdir -p "$TREE/bin" "$TREE/opt/poc"',
          'printf "base-marker\\n" > "$TREE/bin/base-marker"',
        ].join('\n') + '\n',
      );

      const fakeMkfs = join(root, 'fake-mkfs.ext4');
      writeExecutable(
        fakeMkfs,
        [
          '#!/bin/sh',
          'set -eu',
          'TREE=""',
          'OUT=""',
          'while [ $# -gt 0 ]; do',
          '  if [ "$1" = "-d" ]; then shift; TREE="$1"; else OUT="$1"; fi',
          '  shift',
          'done',
          `find "$TREE" -type f | sort | sed "s|^$TREE||" > "${inspectedManifest}"`,
          'printf "derived-ext4-bytes\\n" > "$OUT"',
        ].join('\n') + '\n',
      );

      const workloadSrc = join(root, 'my-workload.sh');
      writeFileSync(workloadSrc, '#!/bin/sh\necho hi\n', { mode: 0o755 });

      // 1. Happy path derivation
      const outImg = join(approved, 'derived', 'guest.ext4');
      const result = deriveExt4GuestImage({
        baseImagePath: golden,
        expectedBaseSha256: goldenSha,
        outputImagePath: outImg,
        approvedRoots: [approved],
        vaultDir: vault,
        extraFiles: [
          {
            srcPath: workloadSrc,
            target: '/opt/qwen/workload.sh',
            mode: 0o755,
          },
        ],
        imageSizeMib: 64,
        debugfsBin: fakeDebugfs,
        mkfsExt4Bin: fakeMkfs,
        tempParentDir: root,
      });

      expect(result.outputImagePath).toBe(outImg);
      expect(result.baseImageSha256).toBe(goldenSha);
      expect(result.baseImageUnchanged).toBe(true);
      expect(sha256File(golden)).toBe(goldenSha);
      expect(existsSync(outImg)).toBe(true);
      expect(result.injectedFiles.map((f) => f.target)).toEqual([
        '/opt/qwen/guest-vsock.py',
        '/opt/qwen/guest-runner.py',
        '/opt/poc/init',
        '/opt/qwen/workload.sh',
      ]);
      const seenPaths = readFileSync(inspectedManifest, 'utf8')
        .trim()
        .split('\n');
      expect(seenPaths).toContain('/opt/qwen/guest-vsock.py');
      expect(seenPaths).toContain('/opt/qwen/guest-runner.py');
      expect(seenPaths).toContain('/opt/poc/init');
      expect(seenPaths).toContain('/opt/qwen/workload.sh');

      // 2. Refuses overwrite, wrong expectedBaseSha256, outside approvedRoots, vaultDir, symlink & hardlink sources
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: outImg,
          approvedRoots: [approved],
          debugfsBin: fakeDebugfs,
          mkfsExt4Bin: fakeMkfs,
        }),
      ).toThrow(/refusing to overwrite/);

      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          expectedBaseSha256: '0'.repeat(64),
          outputImagePath: join(approved, 'bad-sha.ext4'),
          approvedRoots: [approved],
          debugfsBin: fakeDebugfs,
          mkfsExt4Bin: fakeMkfs,
        }),
      ).toThrow(/SHA-256 mismatch/);

      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(outside, 'esc.ext4'),
          approvedRoots: [approved],
          debugfsBin: fakeDebugfs,
          mkfsExt4Bin: fakeMkfs,
        }),
      ).toThrow(/outside approvedRoots/);

      const vaultLink = join(approved, 'vault-link');
      symlinkSync(vault, vaultLink);
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(vault, 'in-vault.ext4'),
          approvedRoots: [approved],
          vaultDir: vaultLink,
          debugfsBin: fakeDebugfs,
          mkfsExt4Bin: fakeMkfs,
        }),
      ).toThrow(/must not reside inside vaultDir/);

      const symBase = join(root, 'sym-golden.ext4');
      symlinkSync(golden, symBase);
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: symBase,
          outputImagePath: join(approved, 'from-sym.ext4'),
          approvedRoots: [approved],
          debugfsBin: fakeDebugfs,
          mkfsExt4Bin: fakeMkfs,
        }),
      ).toThrow(/must not be a symlink/);

      const hardBase = join(root, 'hard-golden.ext4');
      linkSync(golden, hardBase);
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: hardBase,
          outputImagePath: join(approved, 'from-hard.ext4'),
          approvedRoots: [approved],
          debugfsBin: fakeDebugfs,
          mkfsExt4Bin: fakeMkfs,
        }),
      ).toThrow(/single-link regular file/);
      rmSync(hardBase);

      // 3. Hostile base image unpacking a symlink at /opt/qwen -> outside must be blocked before writing
      const hostileDebugfs = join(root, 'hostile-debugfs');
      writeExecutable(
        hostileDebugfs,
        [
          '#!/bin/sh',
          'set -eu',
          'TREE=$(printf "%s" "$2" | sed "s|^rdump / ||")',
          'mkdir -p "$TREE/opt"',
          `ln -s "${outside}" "$TREE/opt/qwen"`,
        ].join('\n') + '\n',
      );
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'hostile-out.ext4'),
          approvedRoots: [approved],
          debugfsBin: hostileDebugfs,
          mkfsExt4Bin: fakeMkfs,
          tempParentDir: root,
        }),
      ).toThrow(/escaped extract tree via symlink/);
      expect(existsSync(join(outside, 'guest-vsock.py'))).toBe(false);
      expect(existsSync(join(approved, 'hostile-out.ext4'))).toBe(false);

      // 4. Failing mkfs.ext4 cleans temporary file and leaves no partial output
      const failMkfs = join(root, 'fail-mkfs');
      writeExecutable(failMkfs, '#!/bin/sh\necho "disk full" >&2\nexit 1\n');
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'fail-out.ext4'),
          approvedRoots: [approved],
          debugfsBin: fakeDebugfs,
          mkfsExt4Bin: failMkfs,
          tempParentDir: root,
        }),
      ).toThrow(/exited 1: disk full/);
      expect(existsSync(join(approved, 'fail-out.ext4'))).toBe(false);

      // 5. CLI derive works end to end and rejects bad arguments with exit 2
      const cliOut = join(approved, 'cli-derived.ext4');
      const cliOk = spawnSync(
        process.execPath,
        [
          IMAGE_CLI,
          'derive',
          '--base',
          golden,
          '--expected-base-sha256',
          goldenSha,
          '--out',
          cliOut,
          '--approved-root',
          approved,
          '--size-mib',
          '64',
          '--workload',
          workloadSrc,
          '--debugfs-bin',
          fakeDebugfs,
          '--mkfs-ext4-bin',
          fakeMkfs,
        ],
        { encoding: 'utf8' },
      );
      expect(cliOk.status, cliOk.stderr).toBe(0);
      expect(JSON.parse(cliOk.stdout).outputImagePath).toBe(cliOut);
      expect(lstatSync(cliOut).isFile()).toBe(true);

      const cliMissing = spawnSync(
        process.execPath,
        [IMAGE_CLI, 'derive', '--base', '--out'],
        { encoding: 'utf8' },
      );
      expect(cliMissing.status).toBe(2);
      expect(cliMissing.stderr).toMatch(/missing value for --base/);

      const cliBadSize = spawnSync(
        process.execPath,
        [
          IMAGE_CLI,
          'derive',
          '--base',
          golden,
          '--out',
          join(approved, 'z.ext4'),
          '--approved-root',
          approved,
          '--size-mib',
          '0',
        ],
        { encoding: 'utf8' },
      );
      expect(cliBadSize.status).toBe(2);
      expect(cliBadSize.stderr).toMatch(/positive integer/);
    },
  );
});
