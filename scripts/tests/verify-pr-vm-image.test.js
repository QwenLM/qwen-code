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
  readdirSync,
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
          '# Expected: -R \'rdump / "<tree>"\' <image>',
          'TREE=$(printf "%s" "$2" | sed -e "s|^rdump / ||" -e \'s|^"||\' -e \'s|"$||\')',
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
    15_000,
  );

  it.skipIf(process.platform === 'win32')(
    'blocks hostile extract-tree symlink escapes (leaf, ancestor, /opt/python), detects debugfs stderr/empty-tree errors, supports spaced tempParentDir and symlinked mkfs.ext4, and adds ENOSPC hint',
    () => {
      const root = makeTempDir('vimg-sec-');
      const approved = join(root, 'approved');
      const outside = join(root, 'outside');
      mkdirSync(approved, { mode: 0o700 });
      mkdirSync(outside, { mode: 0o700 });

      const golden = join(root, 'golden-rootfs.ext4');
      writeFileSync(golden, 'readonly-golden-ext4-image-bytes', {
        mode: 0o444,
      });

      const fakeDebugfs = join(root, 'fake-debugfs');
      writeExecutable(
        fakeDebugfs,
        [
          '#!/bin/sh',
          'set -eu',
          'TREE=$(printf "%s" "$2" | sed -e "s|^rdump / ||" -e \'s|^"||\' -e \'s|"$||\')',
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
          'OUT=""',
          'while [ $# -gt 0 ]; do OUT="$1"; shift; done',
          'printf "derived-ext4-bytes\\n" > "$OUT"',
        ].join('\n') + '\n',
      );

      // 1. Hostile /opt/qwen -> outside must be blocked before writing
      const hostileDebugfs = join(root, 'hostile-debugfs');
      writeExecutable(
        hostileDebugfs,
        [
          '#!/bin/sh',
          'set -eu',
          'TREE=$(printf "%s" "$2" | sed -e "s|^rdump / ||" -e \'s|^"||\' -e \'s|"$||\')',
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

      // 2. Hostile ancestor symlink /opt -> outside must not create outside/qwen
      const hostileAncestorDebugfs = join(root, 'hostile-ancestor-debugfs');
      writeExecutable(
        hostileAncestorDebugfs,
        [
          '#!/bin/sh',
          'set -eu',
          'TREE=$(printf "%s" "$2" | sed -e "s|^rdump / ||" -e \'s|^"||\' -e \'s|"$||\')',
          `ln -s "${outside}" "$TREE/opt"`,
        ].join('\n') + '\n',
      );
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'hostile-anc-out.ext4'),
          approvedRoots: [approved],
          debugfsBin: hostileAncestorDebugfs,
          mkfsExt4Bin: fakeMkfs,
          tempParentDir: root,
        }),
      ).toThrow(/escaped extract tree via symlink/);
      expect(existsSync(join(outside, 'qwen'))).toBe(false);
      expect(existsSync(join(outside, 'poc'))).toBe(false);

      // 3. Hostile /opt/python -> outside-victim during --bundle-host-python must NOT delete victim files
      const pyVictim = join(outside, 'python-victim');
      mkdirSync(pyVictim, { mode: 0o700 });
      writeFileSync(join(pyVictim, 'precious.txt'), 'keep-me');
      const hostilePyDebugfs = join(root, 'hostile-py-debugfs');
      writeExecutable(
        hostilePyDebugfs,
        [
          '#!/bin/sh',
          'set -eu',
          'TREE=$(printf "%s" "$2" | sed -e "s|^rdump / ||" -e \'s|^"||\' -e \'s|"$||\')',
          'mkdir -p "$TREE/opt"',
          `ln -s "${pyVictim}" "$TREE/opt/python"`,
        ].join('\n') + '\n',
      );
      const fakeLdd = join(root, 'fake-ldd');
      writeExecutable(fakeLdd, '#!/bin/sh\nexit 0\n');
      const fakePyBin = join(root, 'fake-python3');
      writeExecutable(fakePyBin, '#!/bin/sh\nexit 0\n');
      const fakePyStdlib = join(root, 'fake-stdlib');
      mkdirSync(fakePyStdlib, { mode: 0o700 });
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'hostile-py-out.ext4'),
          approvedRoots: [approved],
          bundleHostPython: true,
          pythonBin: fakePyBin,
          pythonLibDir: fakePyStdlib,
          lddBin: fakeLdd,
          debugfsBin: hostilePyDebugfs,
          mkfsExt4Bin: fakeMkfs,
          tempParentDir: root,
        }),
      ).toThrow(/escaped extract tree via symlink/);
      expect(readFileSync(join(pyVictim, 'precious.txt'), 'utf8')).toBe(
        'keep-me',
      );

      // 4. debugfs stderr handling: benign non-root ownership warnings (both rdump: and dump_file:)
      // MUST succeed, while fatal lines (standalone or trailing after benign lines) and empty trees fail closed.
      const nonRootBenignDebugfs = join(root, 'nonroot-benign-debugfs');
      writeExecutable(
        nonRootBenignDebugfs,
        [
          '#!/bin/sh',
          'set -eu',
          'TREE=$(printf "%s" "$2" | sed -e "s|^rdump / ||" -e \'s|^"||\' -e \'s|"$||\')',
          'mkdir -p "$TREE/bin" "$TREE/lost+found"',
          'printf "base-marker\\n" > "$TREE/bin/base-marker"',
          'echo "debugfs 1.47.2 (1-Jan-2025)" >&2',
          'echo "rdump: Operation not permitted while changing ownership of $TREE//lost+found" >&2',
          'echo "dump_file: Operation not permitted while changing ownership of $TREE//bin/base-marker" >&2',
          'echo "rdump: Operation not permitted while changing ownership of $TREE/" >&2',
        ].join('\n') + '\n',
      );
      const markerCheckMkfs = join(root, 'marker-check-mkfs');
      writeExecutable(
        markerCheckMkfs,
        [
          '#!/bin/sh',
          'set -eu',
          'SRC=""',
          'OUT=""',
          'while [ $# -gt 0 ]; do',
          '  if [ "$1" = "-d" ]; then SRC="$2"; shift 2; continue; fi',
          '  OUT="$1"; shift',
          'done',
          'test -f "$SRC/bin/base-marker"',
          'cat "$SRC/bin/base-marker" > "$OUT"',
        ].join('\n') + '\n',
      );
      const nonRootOut = join(approved, 'nonroot-derived.ext4');
      const nonRootRes = deriveExt4GuestImage({
        baseImagePath: golden,
        outputImagePath: nonRootOut,
        approvedRoots: [approved],
        debugfsBin: nonRootBenignDebugfs,
        mkfsExt4Bin: markerCheckMkfs,
        tempParentDir: root,
      });
      expect(existsSync(nonRootRes.outputImagePath)).toBe(true);
      expect(readFileSync(nonRootOut, 'utf8').trim()).toBe('base-marker');

      const mixedFatalDebugfs = join(root, 'mixed-fatal-debugfs');
      writeExecutable(
        mixedFatalDebugfs,
        [
          '#!/bin/sh',
          'set -eu',
          'TREE=$(printf "%s" "$2" | sed -e "s|^rdump / ||" -e \'s|^"||\' -e \'s|"$||\')',
          'mkdir -p "$TREE/bin"',
          'echo "debugfs 1.47.2 (1-Jan-2025)" >&2',
          'echo "rdump: Operation not permitted while changing ownership of $TREE//bin" >&2',
          'echo "dump_file: No space left on device while writing file" >&2',
        ].join('\n') + '\n',
      );
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'mixed-fatal.ext4'),
          approvedRoots: [approved],
          debugfsBin: mixedFatalDebugfs,
          mkfsExt4Bin: fakeMkfs,
          tempParentDir: root,
        }),
      ).toThrow(/debugfs extraction failed: dump_file: No space left/);

      const silentErrDebugfs = join(root, 'silent-err-debugfs');
      writeExecutable(
        silentErrDebugfs,
        '#!/bin/sh\necho "rdump: unsupported inode type" >&2\nexit 0\n',
      );
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'silent-err.ext4'),
          approvedRoots: [approved],
          debugfsBin: silentErrDebugfs,
          mkfsExt4Bin: fakeMkfs,
          tempParentDir: root,
        }),
      ).toThrow(/debugfs extraction failed/);

      const badMagicDebugfs = join(root, 'bad-magic-debugfs');
      writeExecutable(
        badMagicDebugfs,
        '#!/bin/sh\necho "Bad magic number in super-block while trying to open image" >&2\nexit 0\n',
      );
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'bad-magic.ext4'),
          approvedRoots: [approved],
          debugfsBin: badMagicDebugfs,
          mkfsExt4Bin: fakeMkfs,
          tempParentDir: root,
        }),
      ).toThrow(/debugfs extraction failed/);

      const emptyDebugfs = join(root, 'empty-debugfs');
      writeExecutable(emptyDebugfs, '#!/bin/sh\nexit 0\n');
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'empty-tree.ext4'),
          approvedRoots: [approved],
          debugfsBin: emptyDebugfs,
          mkfsExt4Bin: fakeMkfs,
          tempParentDir: root,
        }),
      ).toThrow(/empty rootfs tree/);

      // 5. tempParentDir containing spaces requires quoted rdump arg, AND symlinked mkfs.ext4 -> mke2fs succeeds
      const strictQuotedDebugfs = join(root, 'strict-quoted-debugfs');
      writeExecutable(
        strictQuotedDebugfs,
        [
          '#!/bin/sh',
          'set -eu',
          'case "$2" in',
          "  'rdump / \"'*\\ *'\"') ;;",
          '  *) echo "rdump: unquoted path with spaces" >&2; exit 0 ;;',
          'esac',
          'TREE=$(printf "%s" "$2" | sed -e "s|^rdump / ||" -e \'s|^"||\' -e \'s|"$||\')',
          'mkdir -p "$TREE/bin"',
          'printf "base-marker\\n" > "$TREE/bin/base-marker"',
        ].join('\n') + '\n',
      );
      const spaceParent = join(root, 'temp dir with spaces');
      mkdirSync(spaceParent, { mode: 0o700 });
      const symlinkMkfs = join(root, 'mkfs.ext4-link');
      symlinkSync(fakeMkfs, symlinkMkfs);
      const spacedOut = join(approved, 'derived-spaced', 'guest.ext4');
      const spacedRes = deriveExt4GuestImage({
        baseImagePath: golden,
        outputImagePath: spacedOut,
        approvedRoots: [approved],
        debugfsBin: strictQuotedDebugfs,
        mkfsExt4Bin: symlinkMkfs,
        tempParentDir: spaceParent,
      });
      expect(existsSync(spacedRes.outputImagePath)).toBe(true);

      // 6. Failing mkfs.ext4 cleans temporary .derive.*.tmp file, leaves no partial output, and adds size hint on ENOSPC
      const failMkfs = join(root, 'fail-mkfs');
      writeExecutable(
        failMkfs,
        '#!/bin/sh\necho "Could not allocate block in ext2 filesystem" >&2\nexit 1\n',
      );
      const failDir = join(approved, 'fail-check');
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(failDir, 'fail-out.ext4'),
          approvedRoots: [approved],
          debugfsBin: fakeDebugfs,
          mkfsExt4Bin: failMkfs,
          tempParentDir: root,
        }),
      ).toThrow(/try a larger --size-mib/);
      expect(existsSync(join(failDir, 'fail-out.ext4'))).toBe(false);
      expect(readdirSync(failDir)).toEqual([]);

      // 7. Positive --bundle-host-python path packages binary, stdlib, dynload-scanned .so, and soname alias
      const pyDir = join(root, 'host-py');
      const pyStdlib = join(pyDir, 'python3.12');
      const pyDynload = join(pyStdlib, 'lib-dynload');
      const fakeLibs = join(pyDir, 'syslibs');
      mkdirSync(pyDynload, { recursive: true, mode: 0o700 });
      mkdirSync(fakeLibs, { recursive: true, mode: 0o700 });
      writeFileSync(join(pyStdlib, 'os.py'), '# stdlib\n');
      writeFileSync(join(pyDynload, '_socket.cpython-312.so'), 'elf');
      const realSo = join(fakeLibs, 'libfoo.so.1.2.3');
      const aliasSo = join(fakeLibs, 'libfoo.so.1');
      writeFileSync(realSo, 'shared-lib-bytes');
      symlinkSync('libfoo.so.1.2.3', aliasSo);
      const hostPyBin = join(pyDir, 'python3.12-bin');
      writeExecutable(hostPyBin, '#!/bin/sh\nexit 0\n');
      const goodLdd = join(pyDir, 'ldd');
      writeExecutable(
        goodLdd,
        `#!/bin/sh\necho "  libfoo.so.1 => ${aliasSo} (0x0000)"\n`,
      );
      const pyCheckMkfs = join(root, 'py-check-mkfs');
      writeExecutable(
        pyCheckMkfs,
        [
          '#!/bin/sh',
          'set -eu',
          'SRC=""',
          'OUT=""',
          'while [ $# -gt 0 ]; do',
          '  if [ "$1" = "-d" ]; then SRC="$2"; shift 2; continue; fi',
          '  OUT="$1"; shift',
          'done',
          'test -x "$SRC/opt/python/bin/python3.12-bin"',
          'test -L "$SRC/opt/python/bin/python3"',
          'test -f "$SRC/opt/python/lib/python3.12/os.py"',
          'test -f "$SRC/opt/python/lib/libfoo.so.1.2.3"',
          'test -L "$SRC/opt/python/lib/libfoo.so.1"',
          'printf "py-ok\\n" > "$OUT"',
        ].join('\n') + '\n',
      );
      const pyOut = join(approved, 'bundled-py.ext4');
      const pyRes = deriveExt4GuestImage({
        baseImagePath: golden,
        outputImagePath: pyOut,
        approvedRoots: [approved],
        bundleHostPython: true,
        pythonBin: hostPyBin,
        pythonLibDir: pyStdlib,
        lddBin: goodLdd,
        debugfsBin: fakeDebugfs,
        mkfsExt4Bin: pyCheckMkfs,
        tempParentDir: root,
      });
      expect(pyRes.bundledLibraries).toEqual(['libfoo.so.1.2.3']);
      expect(readFileSync(pyOut, 'utf8').trim()).toBe('py-ok');

      // 8. Golden mutation mid-derivation fails closed BEFORE publishing output,
      // and concurrent output creation is never clobbered (atomic linkSync EEXIST).
      const mutGolden = join(root, 'mutating-golden.ext4');
      writeFileSync(mutGolden, 'original-golden', { mode: 0o644 });
      const mutatingDebugfs = join(root, 'mutating-debugfs');
      writeExecutable(
        mutatingDebugfs,
        [
          '#!/bin/sh',
          'set -eu',
          'TREE=$(printf "%s" "$2" | sed -e "s|^rdump / ||" -e \'s|^"||\' -e \'s|"$||\')',
          'mkdir -p "$TREE/bin"',
          'printf "m\\n" > "$TREE/bin/m"',
          `printf "tampered-golden" > "${mutGolden}"`,
        ].join('\n') + '\n',
      );
      const mutOut = join(approved, 'mut-out.ext4');
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: mutGolden,
          outputImagePath: mutOut,
          approvedRoots: [approved],
          debugfsBin: mutatingDebugfs,
          mkfsExt4Bin: fakeMkfs,
          tempParentDir: root,
        }),
      ).toThrow(/golden baseImagePath changed digest/);
      expect(existsSync(mutOut)).toBe(false);

      const raceOut = join(approved, 'race-out.ext4');
      const racingMkfs = join(root, 'racing-mkfs');
      writeExecutable(
        racingMkfs,
        [
          '#!/bin/sh',
          'set -eu',
          'OUT=""',
          'while [ $# -gt 0 ]; do OUT="$1"; shift; done',
          'printf "new-image\\n" > "$OUT"',
          `printf "existing-precious" > "${raceOut}"`,
        ].join('\n') + '\n',
      );
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: raceOut,
          approvedRoots: [approved],
          debugfsBin: fakeDebugfs,
          mkfsExt4Bin: racingMkfs,
          tempParentDir: root,
        }),
      ).toThrow(/already exists/);
      expect(readFileSync(raceOut, 'utf8')).toBe('existing-precious');
    },
    20_000,
  );
});
