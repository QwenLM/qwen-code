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
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/**
 * Creates a fake `debugfs` executable that speaks the batched `-f` (`stat`)
 * and `-w -f` (inject) protocol, recording every executed write command so
 * tests can verify exact `mkdir`, `rm`, `write`, `symlink`, `mode`, `uid`, and
 * `gid` commands.
 */
function makeFakeDebugfs(
  binPath,
  {
    existingTypes = { '/': 'directory', '/opt': 'directory' },
    recordCommandsTo = null,
    injectStderr = '',
    statStderr = '',
    injectExitCode = 0,
    onWriteHook = '',
  } = {},
) {
  const typeCases = Object.entries(existingTypes)
    .map(
      ([p, t]) =>
        `        "${p}") printf "Inode: 12   Type: ${t}    Mode:  0755\\n" ;;`,
    )
    .join('\n');
  writeExecutable(
    binPath,
    [
      '#!/bin/sh',
      'set -eu',
      'echo "debugfs 1.47.2 (1-Jan-2025)" >&2',
      'if [ "$1" = "-f" ]; then',
      statStderr ? `  printf '%s\\n' ${JSON.stringify(statStderr)} >&2` : '',
      '  CMD_FILE="$2"',
      '  while IFS= read -r line; do',
      '    printf "debugfs: %s\\n" "$line"',
      '    case "$line" in',
      '      stat\\ *)',
      '        P=$(printf "%s" "$line" | sed -e \'s|^stat "||\' -e \'s|"$||\')',
      '        case "$P" in',
      typeCases,
      '          *) printf "%s: File not found by ext2_lookup\\n" "$P" >&2 ;;',
      '        esac',
      '        ;;',
      '    esac',
      '  done < "$CMD_FILE"',
      '  exit 0',
      'fi',
      'if [ "$1" = "-w" ] && [ "$2" = "-f" ]; then',
      recordCommandsTo ? `  cp "$3" "${recordCommandsTo}"` : '',
      onWriteHook,
      injectStderr
        ? `  printf '%s\\n' ${JSON.stringify(injectStderr)} >&2`
        : '',
      `  exit ${injectExitCode}`,
      'fi',
      'exit 2',
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );
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
    expect(() => normalizeImageTargetPath('/opt/qwen/a"b"c')).toThrow(
      /invalid guest image target path/,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'derives an independent ext4 copy via debugfs -w with explicit 0:0 ownership and modes without mutating golden source, and enforces safety guards',
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

      const cmdLog = join(root, 'inject-cmds.txt');
      const fakeDebugfs = join(root, 'fake-debugfs');
      makeFakeDebugfs(fakeDebugfs, {
        existingTypes: { '/': 'directory', '/opt': 'directory' },
        recordCommandsTo: cmdLog,
      });
      const fakeResize2fs = join(root, 'fake-resize2fs');
      writeExecutable(
        fakeResize2fs,
        [
          '#!/bin/sh',
          'set -eu',
          'SZ=$(wc -c < "$2" | tr -d " ")',
          'if [ "$SZ" != "67108864" ]; then echo "unexpected size=$SZ" >&2; exit 1; fi',
        ].join('\n') + '\n',
      );
      const fakeTune2fs = join(root, 'fake-tune2fs');
      writeExecutable(fakeTune2fs, '#!/bin/sh\nexit 0\n');

      const workloadSrc = join(root, 'my-workload.sh');
      writeFileSync(workloadSrc, '#!/bin/sh\necho hi\n', { mode: 0o644 });
      chmodSync(workloadSrc, 0o644);

      // 1. Happy path derivation with image growth (64 MiB) + 0644 workload -> 0755 + uid/gid 0
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
        resize2fsBin: fakeResize2fs,
        tune2fsBin: fakeTune2fs,
        tempParentDir: root,
      });

      expect(result.outputImagePath).toBe(outImg);
      expect(result.imageBytes).toBe(64 * 1024 * 1024);
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
      expect(
        result.injectedFiles.find((f) => f.target === '/opt/qwen/workload.sh')
          ?.mode,
      ).toBe('755');
      const cmds = readFileSync(cmdLog, 'utf8');
      expect(cmds).toContain('mkdir "/opt/poc"');
      expect(cmds).toContain('set_inode_field "/opt/poc" uid 0');
      expect(cmds).toContain('set_inode_field "/opt/poc" gid 0');
      expect(cmds).toContain('set_inode_field "/opt/poc/init" mode 0100755');
      expect(cmds).toContain('set_inode_field "/opt/poc/init" uid 0');
      expect(cmds).toContain('set_inode_field "/opt/poc/init" gid 0');
      expect(cmds).toContain(
        'set_inode_field "/opt/qwen/workload.sh" mode 0100755',
      );
      expect(cmds).toContain('set_inode_field "/opt/qwen/workload.sh" uid 0');

      // 2. Refuses overwrite, wrong expectedBaseSha256, outside approvedRoots, vaultDir, symlink & hardlink sources
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: outImg,
          approvedRoots: [approved],
          debugfsBin: fakeDebugfs,
          tune2fsBin: fakeTune2fs,
        }),
      ).toThrow(/refusing to overwrite/);

      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          expectedBaseSha256: '0'.repeat(64),
          outputImagePath: join(approved, 'bad-sha.ext4'),
          approvedRoots: [approved],
          debugfsBin: fakeDebugfs,
          tune2fsBin: fakeTune2fs,
        }),
      ).toThrow(/SHA-256 mismatch/);

      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(outside, 'esc.ext4'),
          approvedRoots: [approved],
          debugfsBin: fakeDebugfs,
          tune2fsBin: fakeTune2fs,
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
          tune2fsBin: fakeTune2fs,
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
          tune2fsBin: fakeTune2fs,
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
          tune2fsBin: fakeTune2fs,
        }),
      ).toThrow(/single-link regular file/);
      rmSync(hardBase);

      // 3. CLI derive works end to end (with and without --size-mib) and rejects bad arguments with exit 2
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
          '--workload',
          workloadSrc,
          '--debugfs-bin',
          fakeDebugfs,
          '--tune2fs-bin',
          fakeTune2fs,
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
    'blocks in-image ancestor symlinks (/opt, /opt/qwen, /opt/python), unlinks leaf file symlinks, rejects corrupt images, supports spaced tempParentDir and symlinked tools, and adds ENOSPC hint',
    () => {
      const root = makeTempDir('vimg-sec-');
      const approved = join(root, 'approved');
      mkdirSync(approved, { mode: 0o700 });

      const golden = join(root, 'golden-rootfs.ext4');
      writeFileSync(golden, 'readonly-golden-ext4-image-bytes', {
        mode: 0o444,
      });
      const fakeTune2fs = join(root, 'fake-tune2fs');
      writeExecutable(fakeTune2fs, '#!/bin/sh\nexit 0\n');

      // 1. In-image symlink at /opt/qwen must be refused before any write
      const symQwenDebugfs = join(root, 'sym-qwen-debugfs');
      makeFakeDebugfs(symQwenDebugfs, {
        existingTypes: {
          '/': 'directory',
          '/opt': 'directory',
          '/opt/qwen': 'symlink',
        },
      });
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'sym-qwen.ext4'),
          approvedRoots: [approved],
          debugfsBin: symQwenDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/traverses symlink inside image: \/opt\/qwen/);
      expect(existsSync(join(approved, 'sym-qwen.ext4'))).toBe(false);

      // 2. In-image ancestor symlink at /opt must be refused
      const symOptDebugfs = join(root, 'sym-opt-debugfs');
      makeFakeDebugfs(symOptDebugfs, {
        existingTypes: { '/': 'directory', '/opt': 'symlink' },
      });
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'sym-opt.ext4'),
          approvedRoots: [approved],
          debugfsBin: symOptDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/traverses symlink inside image: \/opt/);

      // 3. In-image symlink at /opt/python during --bundle-host-python must be refused
      const symPyDebugfs = join(root, 'sym-py-debugfs');
      makeFakeDebugfs(symPyDebugfs, {
        existingTypes: {
          '/': 'directory',
          '/opt': 'directory',
          '/opt/python': 'symlink',
        },
      });
      const fakeLdd = join(root, 'fake-ldd');
      const fakePyBin = join(root, 'fake-python3');
      const fakePyStdlib = join(root, 'fake-stdlib');
      writeExecutable(fakeLdd, '#!/bin/sh\nexit 0\n');
      writeExecutable(fakePyBin, '#!/bin/sh\nexit 0\n');
      mkdirSync(fakePyStdlib, { mode: 0o700 });
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'sym-py.ext4'),
          approvedRoots: [approved],
          bundleHostPython: true,
          pythonBin: fakePyBin,
          pythonLibDir: fakePyStdlib,
          lddBin: fakeLdd,
          debugfsBin: symPyDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/traverses symlink inside image: \/opt\/python/);

      // 4. Leaf file symlink at /opt/qwen/guest-vsock.py is unlinked via `rm` before `write`
      const leafCmdLog = join(root, 'leaf-cmds.txt');
      const leafSymDebugfs = join(root, 'leaf-sym-debugfs');
      makeFakeDebugfs(leafSymDebugfs, {
        existingTypes: {
          '/': 'directory',
          '/opt': 'directory',
          '/opt/qwen': 'directory',
          '/opt/qwen/guest-vsock.py': 'symlink',
        },
        recordCommandsTo: leafCmdLog,
      });
      const leafOut = join(approved, 'leaf-safe.ext4');
      deriveExt4GuestImage({
        baseImagePath: golden,
        outputImagePath: leafOut,
        approvedRoots: [approved],
        debugfsBin: leafSymDebugfs,
        tune2fsBin: fakeTune2fs,
        tempParentDir: root,
      });
      expect(existsSync(leafOut)).toBe(true);
      const leafCmds = readFileSync(leafCmdLog, 'utf8');
      expect(leafCmds).toContain('rm "/opt/qwen/guest-vsock.py"');

      // 5. Corrupt/non-ext4 image (bad magic stderr or missing root /) fails closed
      const badMagicDebugfs = join(root, 'bad-magic-debugfs');
      makeFakeDebugfs(badMagicDebugfs, {
        existingTypes: {},
        statStderr:
          'Bad magic number in super-block while trying to open image',
      });
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'bad-magic.ext4'),
          approvedRoots: [approved],
          debugfsBin: badMagicDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/debugfs image inspection failed/);

      const emptyRootDebugfs = join(root, 'empty-root-debugfs');
      makeFakeDebugfs(emptyRootDebugfs, { existingTypes: {} });
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'empty-root.ext4'),
          approvedRoots: [approved],
          debugfsBin: emptyRootDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/root \/ is not a valid ext4 directory/);

      // 6. debugfs -w ENOSPC stderr error cleans temp files and adds --size-mib hint
      const enospcDebugfs = join(root, 'enospc-debugfs');
      makeFakeDebugfs(enospcDebugfs, {
        existingTypes: { '/': 'directory', '/opt': 'directory' },
        injectStderr: 'write: EXT2_ET_BLOCK_ALLOC_FAIL while writing file',
      });
      const failDir = join(approved, 'fail-check');
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(failDir, 'enospc.ext4'),
          approvedRoots: [approved],
          debugfsBin: enospcDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/try a larger --size-mib/);
      expect(existsSync(join(failDir, 'enospc.ext4'))).toBe(false);
      expect(readdirSync(failDir)).toEqual([]);

      // 7. Spaced tempParentDir + symlinked debugfs binary both work cleanly
      const spaceParent = join(root, 'temp dir with spaces');
      mkdirSync(spaceParent, { mode: 0o700 });
      const okDebugfs = join(root, 'ok-debugfs');
      const okCmdLog = join(root, 'spaced-cmds.txt');
      makeFakeDebugfs(okDebugfs, {
        existingTypes: { '/': 'directory', '/opt': 'directory' },
        recordCommandsTo: okCmdLog,
      });
      const symlinkDebugfs = join(root, 'debugfs-link');
      symlinkSync(okDebugfs, symlinkDebugfs);
      const spacedOut = join(approved, 'derived-spaced', 'guest.ext4');
      const spacedRes = deriveExt4GuestImage({
        baseImagePath: golden,
        outputImagePath: spacedOut,
        approvedRoots: [approved],
        debugfsBin: symlinkDebugfs,
        tune2fsBin: fakeTune2fs,
        tempParentDir: spaceParent,
      });
      expect(existsSync(spacedRes.outputImagePath)).toBe(true);
      expect(readFileSync(okCmdLog, 'utf8')).toMatch(
        /write ".*temp dir with spaces.*staged\/inject-0"/,
      );

      // 8. Quote-bearing tempParentDir fails closed in escapeDebugfsArg (R4-3)
      const quoteParent = join(root, 'bad"quote');
      mkdirSync(quoteParent, { mode: 0o700 });
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'quote-tmp.ext4'),
          approvedRoots: [approved],
          debugfsBin: okDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: quoteParent,
        }),
      ).toThrow(/must not contain quotes/);
      expect(existsSync(join(approved, 'quote-tmp.ext4'))).toBe(false);

      // 9. Truncated ext4 source image + --size-mib 48 MUST fail closed BEFORE truncateSync/resize2fs
      const resizeMarker = join(root, 'resize-should-not-run');
      const guardResize2fs = join(root, 'guard-resize2fs');
      writeExecutable(
        guardResize2fs,
        `#!/bin/sh\nprintf "ran" > "${resizeMarker}"\nexit 0\n`,
      );
      const makeTruncatedExt4 = (filePath, { blocksLo, blocksHi = 0 }) => {
        const buf = Buffer.alloc(4096, 0);
        // ext4 superblock at offset 1024: magic 0xef53, 4 KiB blocks (s_log_block_size = 2)
        buf.writeUInt32LE(blocksLo, 1024 + 0x04);
        buf.writeUInt32LE(2, 1024 + 0x18);
        buf.writeUInt16LE(0xef53, 1024 + 0x38);
        if (blocksHi > 0) {
          buf.writeUInt32LE(0x80, 1024 + 0x60);
          buf.writeUInt32LE(blocksHi, 1024 + 0x150);
        }
        writeFileSync(filePath, buf, { mode: 0o444 });
      };
      const trunc32 = join(root, 'truncated-32m.ext4');
      makeTruncatedExt4(trunc32, { blocksLo: 8192 }); // declares 32 MiB in 4 KiB file
      const truncOut32 = join(approved, 'trunc-32-out.ext4');
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: trunc32,
          outputImagePath: truncOut32,
          approvedRoots: [approved],
          imageSizeMib: 48,
          debugfsBin: okDebugfs,
          resize2fsBin: guardResize2fs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/baseImagePath is truncated/);
      expect(existsSync(truncOut32)).toBe(false);
      expect(existsSync(resizeMarker)).toBe(false);

      const trunc64 = join(root, 'truncated-64bit.ext4');
      makeTruncatedExt4(trunc64, { blocksLo: 0, blocksHi: 1 }); // 64-bit ext4 declaring 16 TiB
      const truncOut64 = join(approved, 'trunc-64-out.ext4');
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: trunc64,
          outputImagePath: truncOut64,
          approvedRoots: [approved],
          imageSizeMib: 48,
          debugfsBin: okDebugfs,
          resize2fsBin: guardResize2fs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/baseImagePath is truncated/);
      expect(existsSync(truncOut64)).toBe(false);

      // 10. R5-1: Padded container file (64 MiB container whose ext4 superblock declares 32 MiB):
      // --size-mib 48 must grow (NOT refuse as shrinking) and --size-mib 64 MUST invoke resize2fs.
      const paddedBase = join(root, 'padded-64m-declares-32m.ext4');
      const padBuf = Buffer.alloc(64 * 1024 * 1024, 0);
      padBuf.writeUInt32LE(8192, 1024 + 0x04); // 32 MiB declared
      padBuf.writeUInt32LE(2, 1024 + 0x18); // 4096-byte blocks
      padBuf.writeUInt16LE(0xef53, 1024 + 0x38);
      writeFileSync(paddedBase, padBuf, { mode: 0o444 });
      const resizeCallsLog = join(root, 'padded-resize.log');
      const trackingResize = join(root, 'tracking-resize2fs');
      writeExecutable(
        trackingResize,
        `#!/bin/sh\nwc -c < "$2" | tr -d " " >> "${resizeCallsLog}"\n`,
      );
      const pad48Out = join(approved, 'pad-48m.ext4');
      const pad48Res = deriveExt4GuestImage({
        baseImagePath: paddedBase,
        outputImagePath: pad48Out,
        approvedRoots: [approved],
        imageSizeMib: 48,
        debugfsBin: okDebugfs,
        resize2fsBin: trackingResize,
        tune2fsBin: fakeTune2fs,
        tempParentDir: root,
      });
      expect(pad48Res.imageBytes).toBe(48 * 1024 * 1024);
      const pad64Out = join(approved, 'pad-64m.ext4');
      const pad64Res = deriveExt4GuestImage({
        baseImagePath: paddedBase,
        outputImagePath: pad64Out,
        approvedRoots: [approved],
        imageSizeMib: 64,
        debugfsBin: okDebugfs,
        resize2fsBin: trackingResize,
        tune2fsBin: fakeTune2fs,
        tempParentDir: root,
      });
      expect(pad64Res.imageBytes).toBe(64 * 1024 * 1024);
      // Omitting imageSizeMib on a padded container preserves the container without invoking resize2fs
      const padKeepOut = join(approved, 'pad-keep.ext4');
      const padKeepRes = deriveExt4GuestImage({
        baseImagePath: paddedBase,
        outputImagePath: padKeepOut,
        approvedRoots: [approved],
        debugfsBin: okDebugfs,
        resize2fsBin: trackingResize,
        tune2fsBin: fakeTune2fs,
        tempParentDir: root,
      });
      expect(padKeepRes.imageBytes).toBe(64 * 1024 * 1024);
      expect(readFileSync(resizeCallsLog, 'utf8').trim().split('\n')).toEqual([
        String(48 * 1024 * 1024),
        String(64 * 1024 * 1024),
      ]);

      // 11. R5-8: debugfs 1.47.2 non-directory stderr (`Ext2 inode is not a directory`) must
      // fall through to the purpose-built ancestor error `cannot traverse non-directory inside image`.
      const nonDirDebugfs = join(root, 'nondir-opt-debugfs');
      makeFakeDebugfs(nonDirDebugfs, {
        existingTypes: { '/': 'directory', '/opt': 'regular' },
        statStderr: '/opt/qwen/guest-runner.py: Ext2 inode is not a directory',
      });
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'nondir-opt.ext4'),
          approvedRoots: [approved],
          debugfsBin: nonDirDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/cannot traverse non-directory inside image: \/opt/);
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'pins vault input exclusions, --bundle-host-python dynload regular+symlink scan, golden mutation guard, concurrent output EEXIST, and mid-copy injected mutation',
    () => {
      const root = makeTempDir('vimg-r3-');
      const approved = join(root, 'approved');
      const vault = join(root, 'vault');
      mkdirSync(approved, { mode: 0o700 });
      mkdirSync(vault, { mode: 0o700 });

      const golden = join(root, 'golden.ext4');
      writeFileSync(golden, 'golden-bytes', { mode: 0o444 });
      const fakeTune2fs = join(root, 'fake-tune2fs');
      writeExecutable(fakeTune2fs, '#!/bin/sh\nexit 0\n');
      const fakeDebugfs = join(root, 'fake-debugfs');
      const pyCmdLog = join(root, 'py-cmds.txt');
      makeFakeDebugfs(fakeDebugfs, {
        existingTypes: { '/': 'directory', '/opt': 'directory' },
        recordCommandsTo: pyCmdLog,
      });

      // 1. Vault exclusion on baseImagePath, extraFiles[].srcPath, and pythonLibDir
      const vaultBase = join(vault, 'base.ext4');
      writeFileSync(vaultBase, 'vault-base', { mode: 0o444 });
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: vaultBase,
          outputImagePath: join(approved, 'from-vault-base.ext4'),
          approvedRoots: [approved],
          vaultDir: vault,
          debugfsBin: fakeDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/must not reside inside vaultDir/);

      const vaultExtra = join(vault, 'extra.sh');
      writeFileSync(vaultExtra, '#!/bin/sh\necho hi\n', { mode: 0o644 });
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'from-vault-extra.ext4'),
          approvedRoots: [approved],
          vaultDir: vault,
          extraFiles: [
            {
              srcPath: vaultExtra,
              target: '/opt/qwen/workload.sh',
              mode: 0o755,
            },
          ],
          debugfsBin: fakeDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/must not reside inside vaultDir/);

      const vaultPyLib = join(vault, 'pylib');
      mkdirSync(vaultPyLib, { mode: 0o700 });
      const dummyPy = join(root, 'dummy-py');
      const dummyLdd = join(root, 'dummy-ldd');
      writeExecutable(dummyPy, '#!/bin/sh\nexit 0\n');
      writeExecutable(dummyLdd, '#!/bin/sh\nexit 0\n');
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'from-vault-pylib.ext4'),
          approvedRoots: [approved],
          vaultDir: vault,
          bundleHostPython: true,
          pythonBin: dummyPy,
          pythonLibDir: vaultPyLib,
          lddBin: dummyLdd,
          debugfsBin: fakeDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/must not reside inside vaultDir/);

      // 2. Argument-sensitive fake ldd + regular AND symlinked lib-dynload/*.so entries
      const pyDir = join(root, 'dyn-py');
      const pyStdlib = join(pyDir, 'python3.12');
      const pyDynload = join(pyStdlib, 'lib-dynload');
      const fakeLibs = join(pyDir, 'syslibs');
      mkdirSync(pyDynload, { recursive: true, mode: 0o700 });
      mkdirSync(fakeLibs, { recursive: true, mode: 0o700 });
      writeFileSync(join(pyStdlib, 'os.py'), '# stdlib\n');
      const regMod = join(pyDynload, '_socket.so');
      const realSslTarget = join(pyDir, 'real-ssl.so');
      const symMod = join(pyDynload, '_ssl.so');
      writeFileSync(regMod, 'elf-socket');
      writeFileSync(realSslTarget, 'elf-ssl');
      symlinkSync(realSslTarget, symMod);

      const libPy = join(fakeLibs, 'libpy.so.1.0');
      const libSock = join(fakeLibs, 'libsock.so.2.0');
      const libSsl = join(fakeLibs, 'libssl.so.3.0');
      writeFileSync(libPy, 'py');
      writeFileSync(libSock, 'sock');
      writeFileSync(libSsl, 'ssl');
      const hostPyBin = join(pyDir, 'python3.12-bin');
      writeExecutable(hostPyBin, '#!/bin/sh\nexit 0\n');
      const argLdd = join(pyDir, 'arg-ldd');
      writeExecutable(
        argLdd,
        [
          '#!/bin/sh',
          'case "$1" in',
          `  *python3.12-bin) echo "  libpy.so.1 => ${libPy} (0x0)" ;;`,
          `  *_socket.so) echo "  libsock.so.2 => ${libSock} (0x0)" ;;`,
          `  *_ssl.so) echo "  libssl.so.3 => ${libSsl} (0x0)" ;;`,
          'esac',
        ].join('\n') + '\n',
      );
      const dynOut = join(approved, 'dyn-bundled.ext4');
      const dynRes = deriveExt4GuestImage({
        baseImagePath: golden,
        outputImagePath: dynOut,
        approvedRoots: [approved],
        bundleHostPython: true,
        pythonBin: hostPyBin,
        pythonLibDir: pyStdlib,
        lddBin: argLdd,
        debugfsBin: fakeDebugfs,
        tune2fsBin: fakeTune2fs,
        tempParentDir: root,
      });
      expect(dynRes.bundledLibraries).toEqual([
        'libpy.so.1.0',
        'libsock.so.2.0',
        'libssl.so.3.0',
      ]);
      const pyCmds = readFileSync(pyCmdLog, 'utf8');
      expect(pyCmds).toContain(
        'symlink "/opt/python/bin/python3" "python3.12-bin"',
      );
      expect(pyCmds).toContain(
        'set_inode_field "/opt/python/bin/python3" uid 0',
      );
      expect(pyCmds).toContain('"/opt/python/lib/libpy.so.1.0"');
      expect(pyCmds).toContain('"/opt/python/lib/libsock.so.2.0"');
      expect(pyCmds).toContain('"/opt/python/lib/libssl.so.3.0"');

      // 3. Golden mutation mid-derivation fails closed BEFORE publishing output
      const mutGolden = join(root, 'mutating-golden.ext4');
      writeFileSync(mutGolden, 'original-golden', { mode: 0o644 });
      const mutDebugfs = join(root, 'mutating-debugfs');
      makeFakeDebugfs(mutDebugfs, {
        existingTypes: { '/': 'directory', '/opt': 'directory' },
        onWriteHook: `printf "tampered-golden" > "${mutGolden}"`,
      });
      const mutOut = join(approved, 'mut-out.ext4');
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: mutGolden,
          outputImagePath: mutOut,
          approvedRoots: [approved],
          debugfsBin: mutDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/golden baseImagePath changed digest/);
      expect(existsSync(mutOut)).toBe(false);

      // 4. Concurrent output creation is never clobbered (atomic linkSync EEXIST)
      const raceOut = join(approved, 'race-out.ext4');
      const raceDebugfs = join(root, 'racing-debugfs');
      makeFakeDebugfs(raceDebugfs, {
        existingTypes: { '/': 'directory', '/opt': 'directory' },
        onWriteHook: `printf "existing-precious" > "${raceOut}"`,
      });
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: raceOut,
          approvedRoots: [approved],
          debugfsBin: raceDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/already exists/);
      expect(readFileSync(raceOut, 'utf8')).toBe('existing-precious');

      // 5. R5-3: Re-deriving a base that already has /opt/python + extraFiles under /opt/python
      // MUST emit `mkdir "/opt/python"` after `rmdir "/opt/python"`.
      const rederiveCmdLog = join(root, 'rederive-py.log');
      const rederiveDebugfs = join(root, 'rederive-debugfs');
      writeExecutable(
        rederiveDebugfs,
        [
          '#!/bin/sh',
          'set -eu',
          'echo "debugfs 1.47.2 (1-Jan-2025)" >&2',
          'if [ "$1" = "-f" ]; then',
          '  if grep -q "^ls -p" "$2"; then',
          '    printf "[pwd]   INODE: 20  PATH: /opt/python\\n"',
          '    printf "/20/040755/0/0/.//\\n"',
          '    printf "/21/100644/0/0/old.txt/4/\\n"',
          '    exit 0',
          '  fi',
          '  while IFS= read -r line; do',
          '    printf "debugfs: %s\\n" "$line"',
          '    case "$line" in',
          '      stat\\ *)',
          '        P=$(printf "%s" "$line" | sed -e \'s|^stat "||\' -e \'s|"$||\')',
          '        case "$P" in',
          '          "/"|"/opt"|"/opt/python") printf "Inode: 12   Type: directory    Mode:  0755\\n" ;;',
          '          *) printf "%s: File not found by ext2_lookup\\n" "$P" >&2 ;;',
          '        esac ;;',
          '    esac',
          '  done < "$2"',
          '  exit 0',
          'fi',
          'if [ "$1" = "-w" ] && [ "$2" = "-f" ]; then',
          `  cp "$3" "${rederiveCmdLog}"`,
          '  exit 0',
          'fi',
          'exit 2',
        ].join('\n') + '\n',
      );
      const pyExtraCfg = join(root, 'py-custom.cfg');
      writeFileSync(pyExtraCfg, 'ok=1\n', { mode: 0o644 });
      deriveExt4GuestImage({
        baseImagePath: golden,
        outputImagePath: join(approved, 'rederive-py.ext4'),
        approvedRoots: [approved],
        bundleHostPython: true,
        pythonBin: hostPyBin,
        pythonLibDir: pyStdlib,
        lddBin: argLdd,
        extraFiles: [
          {
            srcPath: pyExtraCfg,
            target: '/opt/python/custom.cfg',
            mode: 0o644,
          },
        ],
        debugfsBin: rederiveDebugfs,
        tune2fsBin: fakeTune2fs,
        tempParentDir: root,
      });
      const rederiveCmds = readFileSync(rederiveCmdLog, 'utf8');
      const rmdirIdx = rederiveCmds.indexOf('rmdir "/opt/python"');
      const mkdirIdx = rederiveCmds.indexOf('mkdir "/opt/python"', rmdirIdx);
      expect(rmdirIdx).toBeGreaterThan(-1);
      expect(mkdirIdx).toBeGreaterThan(rmdirIdx);

      // 6. R5-6: listImageSubtree fails closed on unparseable/newline-split ls -p output
      const badLsDebugfs = join(root, 'bad-ls-debugfs');
      writeExecutable(
        badLsDebugfs,
        [
          '#!/bin/sh',
          'set -eu',
          'echo "debugfs 1.47.2 (1-Jan-2025)" >&2',
          'if [ "$1" = "-f" ]; then',
          '  if grep -q "^ls -p" "$2"; then',
          '    printf "[pwd]   INODE: 20  PATH: /opt/python\\n"',
          '    printf "/21/100644/0/0/new\\nline.txt/0/\\n"',
          '    exit 0',
          '  fi',
          '  while IFS= read -r line; do',
          '    printf "debugfs: %s\\n" "$line"',
          '    case "$line" in',
          '      stat\\ *)',
          '        P=$(printf "%s" "$line" | sed -e \'s|^stat "||\' -e \'s|"$||\')',
          '        case "$P" in',
          '          "/"|"/opt"|"/opt/python") printf "Inode: 12   Type: directory    Mode:  0755\\n" ;;',
          '          *) printf "%s: File not found by ext2_lookup\\n" "$P" >&2 ;;',
          '        esac ;;',
          '    esac',
          '  done < "$2"',
          '  exit 0',
          'fi',
          'exit 0',
        ].join('\n') + '\n',
      );
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'bad-ls.ext4'),
          approvedRoots: [approved],
          bundleHostPython: true,
          pythonBin: hostPyBin,
          pythonLibDir: pyStdlib,
          lddBin: argLdd,
          debugfsBin: badLsDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/unparseable debugfs ls -p entry/);

      // 7. R5-5: ldd `=> not found` fails closed naming the missing shared library
      const missingLdd = join(root, 'missing-ldd');
      writeExecutable(
        missingLdd,
        '#!/bin/sh\necho "  libmissing.so.1 => not found"\n',
      );
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'missing-lib.ext4'),
          approvedRoots: [approved],
          bundleHostPython: true,
          pythonBin: hostPyBin,
          pythonLibDir: pyStdlib,
          lddBin: missingLdd,
          debugfsBin: fakeDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/missing shared library.*libmissing\.so\.1/);

      // 8. R5-4: Escaping/absolute symlinks in host stdlib are materialized if valid files
      // and fail closed if dangling.
      const escPyRoot = join(root, 'esc-py');
      const escStdlib = join(escPyRoot, 'python3.12');
      mkdirSync(join(escStdlib, 'sub'), { recursive: true, mode: 0o700 });
      const hostSite = join(root, 'host-sitecustomize.py');
      const hostExt = join(escPyRoot, 'outside-lib.so');
      writeFileSync(hostSite, '# site\n');
      writeFileSync(hostExt, 'so-bytes');
      symlinkSync(hostSite, join(escStdlib, 'sitecustomize.py'));
      symlinkSync('../../outside-lib.so', join(escStdlib, 'sub', 'ext.so'));
      const escCmdLog = join(root, 'esc-py-cmds.txt');
      const escDebugfs = join(root, 'esc-debugfs');
      makeFakeDebugfs(escDebugfs, {
        existingTypes: { '/': 'directory', '/opt': 'directory' },
        recordCommandsTo: escCmdLog,
      });
      deriveExt4GuestImage({
        baseImagePath: golden,
        outputImagePath: join(approved, 'esc-py-ok.ext4'),
        approvedRoots: [approved],
        bundleHostPython: true,
        pythonBin: hostPyBin,
        pythonLibDir: escStdlib,
        lddBin: argLdd,
        debugfsBin: escDebugfs,
        tune2fsBin: fakeTune2fs,
        tempParentDir: root,
      });
      const escCmds = readFileSync(escCmdLog, 'utf8');
      expect(escCmds).toContain(
        '"/opt/python/lib/python3.12/sitecustomize.py"',
      );
      expect(escCmds).not.toContain(
        'symlink "/opt/python/lib/python3.12/sitecustomize.py"',
      );
      expect(escCmds).not.toContain(
        'symlink "/opt/python/lib/python3.12/sub/ext.so"',
      );

      // Escaping symlink pointing into vaultDir is refused before staging
      const vaultTarget = join(vault, 'secret-py.py');
      writeFileSync(vaultTarget, 'SECRET=1\n');
      const vaultSymStdlib = join(root, 'vault-sym-stdlib');
      mkdirSync(vaultSymStdlib, { mode: 0o700 });
      symlinkSync(vaultTarget, join(vaultSymStdlib, 'leak.py'));
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'esc-py-vault.ext4'),
          approvedRoots: [approved],
          vaultDir: vault,
          bundleHostPython: true,
          pythonBin: hostPyBin,
          pythonLibDir: vaultSymStdlib,
          lddBin: argLdd,
          debugfsBin: escDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(
        /bundled Python symlink target must not reside inside vaultDir/,
      );

      // Dangling escaping symlink fails closed
      symlinkSync('/nonexistent/dangling-target', join(escStdlib, 'bad.py'));
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: join(approved, 'esc-py-dangling.ext4'),
          approvedRoots: [approved],
          bundleHostPython: true,
          pythonBin: hostPyBin,
          pythonLibDir: escStdlib,
          lddBin: argLdd,
          debugfsBin: escDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/bundled Python symlink escapes \/opt\/python/);
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'succeeds cleanly and leaves nlink=1 with no temp residue when the first temp unlinkSync after linkSync throws EBUSY, and fails closed if an injected source mutates between pre-hash and staging',
    async () => {
      const root = makeTempDir('vimg-ebusy-');
      const approved = join(root, 'approved');
      mkdirSync(approved, { mode: 0o700 });
      const golden = join(root, 'golden.ext4');
      writeFileSync(golden, 'golden-ebusy', { mode: 0o444 });
      const fakeTune2fs = join(root, 'fake-tune2fs');
      writeExecutable(fakeTune2fs, '#!/bin/sh\nexit 0\n');
      const fakeDebugfs = join(root, 'fake-debugfs');
      makeFakeDebugfs(fakeDebugfs, {
        existingTypes: { '/': 'directory', '/opt': 'directory' },
      });

      // 1. Transient EBUSY on first temp unlinkSync after linkSync still succeeds
      let injectedEbusy = false;
      vi.resetModules();
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual('node:fs');
        return {
          ...actual,
          unlinkSync(target) {
            if (
              !injectedEbusy &&
              typeof target === 'string' &&
              /\.derive\.\d+\.\d+\.tmp$/.test(target)
            ) {
              injectedEbusy = true;
              const err = new Error(`EBUSY: resource busy: ${target}`);
              err.code = 'EBUSY';
              throw err;
            }
            return actual.unlinkSync(target);
          },
        };
      });
      const outPath = join(approved, 'ebusy-out.ext4');
      let result;
      try {
        const imgMod = await import('../verify-pr-vm-image.mjs');
        result = imgMod.deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: outPath,
          approvedRoots: [approved],
          debugfsBin: fakeDebugfs,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        });
      } finally {
        vi.doUnmock('node:fs');
        vi.resetModules();
      }
      expect(injectedEbusy).toBe(true);
      expect(result.outputImagePath).toBe(outPath);
      expect(result.imageSha256).toBe(sha256File(outPath));
      expect(lstatSync(outPath).nlink).toBe(1);
      expect(readdirSync(approved)).toEqual(['ebusy-out.ext4']);

      // 2. Injected source mutated between pre-hash and staging copy fails closed
      const mutableExtra = join(root, 'mutable-wl.sh');
      writeFileSync(mutableExtra, '#!/bin/sh\necho original\n', {
        mode: 0o644,
      });
      const mutResize = join(root, 'mut-resize2fs');
      writeExecutable(
        mutResize,
        `#!/bin/sh\nprintf "#!/bin/sh\\necho tampered\\n" > "${mutableExtra}"\n`,
      );
      const mutOut = join(approved, 'mut-extra.ext4');
      expect(() =>
        deriveExt4GuestImage({
          baseImagePath: golden,
          outputImagePath: mutOut,
          approvedRoots: [approved],
          imageSizeMib: 32,
          extraFiles: [
            {
              srcPath: mutableExtra,
              target: '/opt/qwen/workload.sh',
              mode: 0o755,
            },
          ],
          debugfsBin: fakeDebugfs,
          resize2fsBin: mutResize,
          tune2fsBin: fakeTune2fs,
          tempParentDir: root,
        }),
      ).toThrow(/changed content between pre-hash and copy/);
      expect(existsSync(mutOut)).toBe(false);
    },
    15_000,
  );
});
