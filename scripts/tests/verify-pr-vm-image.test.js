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
    },
    15_000,
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
    },
    15_000,
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
