/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
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
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ACK, GREETING } from '../verify-pr-vm-collector.mjs';
import {
  copyIsolatedAsset,
  probeHostCapabilities,
  probeSeatbeltEnforcement,
  renderVfkitSeatbeltProfile,
  stageLocalVmRound,
  verifyFirecrackerDiskConfig,
} from '../verify-pr-vm-host.mjs';
import {
  buildFirecrackerLaunchPlan,
  buildVfkitLaunchPlan,
  runHardwareRound,
} from '../verify-pr-vm-runner.mjs';

const RUNNER_SCRIPT = fileURLToPath(
  new URL('../verify-pr-vm-runner.mjs', import.meta.url),
);
const BASE_OID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_OID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const cleanups = [];

function makeTempDir(prefix = 'vh-') {
  const base = existsSync('/tmp') ? '/tmp' : tmpdir();
  const dir = realpathSync(mkdtempSync(join(base, prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function writeExecutableScript(filePath, content) {
  writeFileSync(filePath, content, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

function makeHostContext(dir, overrides = {}) {
  const ctx = {
    repo: 'QwenLM/qwen-code',
    number: 18400,
    baseRefOid: BASE_OID,
    headRefOid: HEAD_OID,
    trustClassification: {
      prTrust: 'external',
      executionClass: 'hardware-isolated',
      escalationReasons: ['external-or-fork-pr'],
      evaluatedAtHead: HEAD_OID,
    },
    ...overrides,
  };
  const text = `${JSON.stringify(ctx, null, 2)}\n`;
  const path = join(dir, 'context.json');
  writeFileSync(path, text, { mode: 0o600 });
  return { path, sha256: sha256Text(text), ctx };
}

function encodeFrame(kind, payload) {
  const header = Buffer.alloc(5);
  header.write(kind, 0, 1, 'ascii');
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

async function uploadMinimalValidReport(socketPath) {
  const reportText = [
    `merge-ready · 1 passed · 0 failed · 1 total · ${HEAD_OID}`,
    '',
    '## Methodology',
    '',
    '**Boundary.** Hardware-isolated microVM staged by verify-pr-vm-host.',
    '',
  ].join('\n');
  const assertionsText = `${JSON.stringify(
    {
      pass: 1,
      fail: 0,
      total: 1,
    },
    null,
    2,
  )}\n`;
  const commentText = `merge-ready\n\n_— probe-model via Qwen Code /verify-pr (v0.28.7; skill test)_\n`;

  const files = [
    ['report.md', Buffer.from(reportText, 'utf8')],
    ['verdict.txt', Buffer.from('merge-ready\n', 'utf8')],
    ['assertions.json', Buffer.from(assertionsText, 'utf8')],
    ['comment.md', Buffer.from(commentText, 'utf8')],
  ];

  await new Promise((resolveDone, rejectDone) => {
    const sock = net.createConnection(socketPath);
    let buf = Buffer.alloc(0);
    let state = 'ack';
    sock.on('error', rejectDone);
    sock.on('connect', () => {
      sock.write(GREETING);
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (state === 'ack' && buf.length >= ACK.length) {
        if (!buf.subarray(0, ACK.length).equals(ACK)) {
          sock.destroy(new Error('unexpected collector ack'));
          return;
        }
        buf = buf.subarray(ACK.length);
        state = 'reply';
        sock.write(encodeFrame('H', Buffer.from('report-v1', 'ascii')));
        for (const [name, content] of files) {
          const header = Buffer.alloc(8);
          header.writeBigUInt64BE(BigInt(content.length));
          sock.write(
            encodeFrame(
              'B',
              Buffer.concat([header, Buffer.from(name, 'utf8')]),
            ),
          );
          sock.write(encodeFrame('C', content));
          const sha = createHash('sha256').update(content).digest('hex');
          sock.write(encodeFrame('E', Buffer.from(sha, 'ascii')));
        }
        sock.write(encodeFrame('R', Buffer.alloc(0)));
      } else if (state === 'reply' && buf.length > 0) {
        if (buf[0] !== 0x4f) {
          sock.destroy(
            new Error(`collector rejected round: ${buf.toString()}`),
          );
          return;
        }
        sock.end();
        resolveDone();
      }
    });
  });
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()();
  }
});

describe('verify-pr-vm-host Seatbelt profile and capability probes', () => {
  it('renders a deny-default Seatbelt profile and rejects unsafe vfkitBin literals', () => {
    const profile = renderVfkitSeatbeltProfile({
      vfkitBin: '/usr/bin/true',
    });
    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(deny network-inbound)');
    expect(profile).toContain('(deny network-outbound (remote ip))');
    expect(profile).toContain('(subpath (param "POC_DIR"))');
    expect(profile).toContain('(subpath (param "POC_SOCKET_DIR"))');
    expect(profile).toContain('(literal "/usr/bin/true")');
    expect(profile).not.toContain('/Users');

    expect(() =>
      renderVfkitSeatbeltProfile({ vfkitBin: 'relative/vfkit' }),
    ).toThrow(/invalid vfkitBin/);
    expect(() =>
      renderVfkitSeatbeltProfile({ vfkitBin: '/tmp/bad"quote/vfkit' }),
    ).toThrow(/invalid vfkitBin/);
    expect(() =>
      renderVfkitSeatbeltProfile({ vfkitBin: '/tmp/bad\nline/vfkit' }),
    ).toThrow(/invalid vfkitBin/);
  });

  it('fails closed on non-darwin platforms for Seatbelt enforcement and on non-linux for KVM', () => {
    const nonDarwin = probeSeatbeltEnforcement({ platform: 'linux' });
    expect(nonDarwin.enforcing).toBe(false);
    expect(nonDarwin.reasons).toContain('non-darwin-platform');

    const caps = probeHostCapabilities({
      platform: 'freebsd',
      arch: 'x64',
    });
    expect(caps.kvmAvailable).toBe(false);
    expect(caps.vfkitAvailable).toBe(false);
    expect(caps.seatbeltEnforcing).toBe(false);
    expect(caps.firecracker.reasons).toContain('non-linux-platform');
    expect(caps.vfkit.reasons).toContain('requires-darwin-arm64');
  });

  it.runIf(process.platform === 'darwin')(
    'runs a live macOS Seatbelt probe with positive/negative filesystem controls, TCP deny, and hollow-vfkit rejection',
    async () => {
      const root = makeTempDir('vh-mac-');

      // 1. Default deny-default profile enforces real read/write boundaries
      const live = probeSeatbeltEnforcement({ probeParentDir: root });
      expect(live).toEqual({
        enforcing: true,
        positiveReadOk: true,
        positiveWriteOk: true,
        canaryReadDenied: true,
        outsideWriteDenied: true,
        reasons: [],
      });

      // 2. Permissive profile negative control must fail closed
      const permissivePath = join(root, 'permissive.sb');
      writeFileSync(permissivePath, '(version 1)\n(allow default)\n', {
        mode: 0o600,
      });
      const permissive = probeSeatbeltEnforcement({
        seatbeltProfilePath: permissivePath,
        probeParentDir: root,
      });
      expect(permissive.enforcing).toBe(false);
      expect(permissive.canaryReadDenied).toBe(false);
      expect(permissive.outsideWriteDenied).toBe(false);

      // 3. Symlink and hardlink Seatbelt profile paths are refused
      const linkPath = join(root, 'link.sb');
      symlinkSync(permissivePath, linkPath);
      const symRes = probeSeatbeltEnforcement({
        seatbeltProfilePath: linkPath,
        probeParentDir: root,
      });
      expect(symRes.enforcing).toBe(false);
      expect(symRes.reasons[0]).toMatch(/seatbelt-profile:symlink/);

      const hardPath = join(root, 'hard.sb');
      linkSync(permissivePath, hardPath);
      const hardRes = probeSeatbeltEnforcement({
        seatbeltProfilePath: hardPath,
        probeParentDir: root,
      });
      expect(hardRes.enforcing).toBe(false);
      expect(hardRes.reasons[0]).toMatch(/seatbelt-profile:hardlink-alias/);

      // 4. Real TCP outbound deny with an unsandboxed positive control
      const server = net.createServer((sock) => {
        sock.on('error', () => {});
        sock.end('OK');
      });
      let hits = 0;
      server.on('connection', () => {
        hits += 1;
      });
      await new Promise((resolveListen) =>
        server.listen(0, '127.0.0.1', resolveListen),
      );
      cleanups.push(() => server.close());
      const { port } = server.address();

      const runAsync = (cmd, args, cwd) =>
        new Promise((resolveRun) => {
          const child = spawn(cmd, args, { cwd, stdio: 'pipe' });
          let stderr = '';
          child.stderr.on('data', (d) => {
            stderr += d.toString('utf8');
          });
          child.on('close', (code) => resolveRun({ code, stderr }));
        });

      const positiveTcp = await runAsync(
        '/usr/bin/nc',
        ['-z', '-w', '1', '127.0.0.1', String(port)],
        root,
      );
      expect(positiveTcp.code).toBe(0);
      expect(hits).toBe(1);

      const pocDir = join(root, 'poc');
      const sockDir = join(root, 'sock');
      mkdirSync(pocDir, { mode: 0o700 });
      mkdirSync(sockDir, { mode: 0o700 });
      const sbFile = join(root, 'deny.sb');
      writeFileSync(sbFile, renderVfkitSeatbeltProfile(), { mode: 0o600 });

      const deniedTcp = await runAsync(
        '/usr/bin/sandbox-exec',
        [
          '-f',
          sbFile,
          '-D',
          `POC_DIR=${pocDir}`,
          '-D',
          `POC_SOCKET_DIR=${sockDir}`,
          '/usr/bin/nc',
          '-z',
          '-w',
          '1',
          '127.0.0.1',
          String(port),
        ],
        pocDir,
      );
      expect(deniedTcp.code).not.toBe(0);
      expect(hits).toBe(1);

      // 5. Hollow vfkit binary (valid --version, no virtualization entitlement)
      // must be refused by real /usr/bin/codesign
      const hollowVfkit = join(root, 'fake-vfkit');
      writeExecutableScript(hollowVfkit, '#!/bin/sh\necho "vfkit 0.6.0"\n');
      const hollowCaps = probeHostCapabilities({
        vfkitBin: hollowVfkit,
        probeParentDir: root,
      });
      expect(hollowCaps.seatbeltEnforcing).toBe(true);
      expect(hollowCaps.vfkit.vfkitVersion).toBe('vfkit 0.6.0');
      expect(hollowCaps.vfkit.hasVirtualizationEntitlement).toBe(false);
      expect(hollowCaps.vfkitAvailable).toBe(false);
      expect(hollowCaps.vfkit.reasons).toContain(
        'vfkit-missing-virtualization-entitlement',
      );

      // 6. When codesign confirms virtualization entitlement + live Seatbelt,
      // vfkit reports available
      const fakeCodesign = join(root, 'fake-codesign');
      writeExecutableScript(
        fakeCodesign,
        '#!/bin/sh\necho "<key>com.apple.security.virtualization</key><true/>"\n',
      );
      const validCaps = probeHostCapabilities({
        vfkitBin: hollowVfkit,
        codesignBin: fakeCodesign,
        probeParentDir: root,
      });
      expect(validCaps.vfkitAvailable).toBe(true);
      expect(validCaps.seatbeltEnforcing).toBe(true);
      expect(validCaps.vfkit.available).toBe(true);
      expect(validCaps.vfkit.reasons).toEqual([]);
      // 7. Relative vfkitBin fails closed instead of throwing uncaught
      const relativeVfkit = probeSeatbeltEnforcement({
        vfkitBin: 'bin/vfkit',
        probeParentDir: root,
      });
      expect(relativeVfkit.enforcing).toBe(false);
      expect(relativeVfkit.reasons.join(',')).toMatch(
        /seatbelt-profile-render:.*invalid vfkitBin/,
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects non-char /dev/kvm, symlinked binaries (explicit and PATH), invalid uid, and broken version probes on Linux mode',
    () => {
      const root = makeTempDir('vh-lnx-');
      const fakeKvmFile = join(root, 'not-char-kvm');
      writeFileSync(fakeKvmFile, 'not-a-device', { mode: 0o600 });
      const fakeKvmLink = join(root, 'link-kvm');
      symlinkSync(fakeKvmFile, fakeKvmLink);
      const cgroups = join(root, 'cgroup.controllers');
      writeFileSync(cgroups, 'cpu memory pids\n');

      const goodFc = join(root, 'firecracker');
      writeExecutableScript(goodFc, '#!/bin/sh\necho "Firecracker v1.18.0"\n');
      const badJailer = join(root, 'jailer');
      writeExecutableScript(badJailer, '#!/bin/sh\nexit 1\n');
      const fcSymlink = join(root, 'fc-link');
      symlinkSync(goodFc, fcSymlink);

      const nonChar = probeHostCapabilities({
        platform: 'linux',
        arch: 'arm64',
        kvmDevice: fakeKvmFile,
        cgroupControllersPath: cgroups,
        firecrackerBin: fcSymlink,
        jailerBin: badJailer,
        vmmUid: 0,
        vmmGid: 65534,
      });
      expect(nonChar.kvmAvailable).toBe(false);
      expect(nonChar.firecracker.reasons).toContain('kvm-device-not-char');
      expect(nonChar.firecracker.reasons).toContain(
        'invalid-non-root-vmm-uid-gid',
      );
      expect(nonChar.firecracker.reasons).toContain(
        'firecracker-binary:symlink-refused',
      );
      expect(nonChar.firecracker.reasons).toContain(
        'jailer-version:exit-status:1',
      );

      // PATH discovery must enforce the exact same symlink-refused policy as explicit flags
      const pathDir = join(root, 'path-bin');
      mkdirSync(pathDir, { mode: 0o700 });
      symlinkSync(goodFc, join(pathDir, 'firecracker'));
      const savedPath = process.env.PATH;
      process.env.PATH = pathDir;
      try {
        const viaPath = probeHostCapabilities({
          platform: 'linux',
          arch: 'arm64',
          kvmDevice: fakeKvmFile,
          cgroupControllersPath: cgroups,
          jailerBin: goodFc,
          vmmUid: 65534,
          vmmGid: 65534,
        });
        expect(viaPath.firecracker.firecrackerVersion).toBeNull();
        expect(viaPath.firecracker.reasons).toContain(
          'firecracker-binary:symlink-refused',
        );
      } finally {
        process.env.PATH = savedPath;
      }

      // Relative vfkitBin fails closed even when invoked with mocked darwin sandboxExecBin
      const fakeSb = join(root, 'fake-sandbox-exec');
      writeExecutableScript(fakeSb, '#!/bin/sh\nexit 0\n');
      const relProbe = probeSeatbeltEnforcement({
        platform: 'darwin',
        sandboxExecBin: fakeSb,
        vfkitBin: 'bin/vfkit',
        probeParentDir: root,
      });
      expect(relProbe.enforcing).toBe(false);
      expect(relProbe.reasons.join(',')).toMatch(
        /seatbelt-profile-render:.*invalid vfkitBin/,
      );

      const symKvm = probeHostCapabilities({
        platform: 'linux',
        arch: 'arm64',
        kvmDevice: fakeKvmLink,
        cgroupControllersPath: join(root, 'missing-cgroup'),
        firecrackerBin: goodFc,
        jailerBin: goodFc,
        vmmUid: 65534,
        vmmGid: 65534,
      });
      expect(symKvm.kvmAvailable).toBe(false);
      expect(symKvm.firecracker.reasons).toContain('kvm-device-symlink');
      expect(symKvm.firecracker.reasons).toContain('cgroup-v2:ENOENT');
      expect(symKvm.firecracker.firecrackerVersion).toBe('Firecracker v1.18.0');
    },
  );
});

describe('verify-pr-vm-host asset staging, rollback, and runner integration', () => {
  it.skipIf(process.platform === 'win32')(
    'copies golden assets to independent inodes, blocks symlinked vault prefixes, refuses unsafe paths/overwrites',
    () => {
      const root = makeTempDir('vh-stg-');
      const approved = join(root, 'approved');
      const outside = join(root, 'outside');
      const vault = join(approved, 'vault');
      mkdirSync(approved, { mode: 0o700 });
      mkdirSync(outside, { mode: 0o700 });
      mkdirSync(vault, { mode: 0o700 });

      const src = join(root, 'golden.img');
      writeFileSync(src, 'golden-bytes-123456', { mode: 0o444 });
      const srcStat = lstatSync(src);

      const dst = join(approved, 'round1', 'work.img');
      const copied = copyIsolatedAsset(src, dst, {
        approvedRoots: [approved],
        vaultDir: vault,
        mode: 0o640,
      });
      expect(copied.bytes).toBe(19);
      expect(copied.sha256).toBe(sha256Text('golden-bytes-123456'));
      const dstStat = lstatSync(dst);
      expect(dstStat.nlink).toBe(1);
      expect(dstStat.ino).not.toBe(srcStat.ino);

      // Refuses overwrite of existing destination
      expect(() =>
        copyIsolatedAsset(src, dst, { approvedRoots: [approved] }),
      ).toThrow(/refusing to overwrite/);

      // Refuses outside approvedRoots and inside vaultDir (including via symlinked prefix)
      expect(() =>
        copyIsolatedAsset(src, join(outside, 'escape.img'), {
          approvedRoots: [approved],
        }),
      ).toThrow(/outside approvedRoots/);
      expect(() =>
        copyIsolatedAsset(src, join(vault, 'in-vault.img'), {
          approvedRoots: [approved],
          vaultDir: vault,
        }),
      ).toThrow(/must not reside inside vaultDir/);

      const vaultLink = join(approved, 'vault-link');
      symlinkSync(vault, vaultLink);
      expect(() =>
        copyIsolatedAsset(src, join(vaultLink, 'via-link.img'), {
          approvedRoots: [approved],
          vaultDir: vault,
        }),
      ).toThrow(/must not reside inside vaultDir/);

      const dirLink = join(root, 'approved-link');
      symlinkSync(approved, dirLink);
      expect(() =>
        copyIsolatedAsset(
          src,
          join(dirLink, 'vault', 'nested', 'via-prefix.img'),
          {
            approvedRoots: [dirLink],
            vaultDir: join(dirLink, 'vault'),
          },
        ),
      ).toThrow(/must not reside inside vaultDir/);

      // Refuses symlink and hardlink sources
      const symSrc = join(root, 'sym.img');
      symlinkSync(src, symSrc);
      expect(() =>
        copyIsolatedAsset(symSrc, join(approved, 'r2.img'), {
          approvedRoots: [approved],
        }),
      ).toThrow(/must not be a symlink/);

      const hardSrc = join(root, 'hard.img');
      linkSync(src, hardSrc);
      expect(() =>
        copyIsolatedAsset(hardSrc, join(approved, 'r3.img'), {
          approvedRoots: [approved],
        }),
      ).toThrow(/single-link regular file/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'stages Firecracker jailRoot, verifies disk config.json (including FIFO refusal), cleans exact created dirs, and rolls back cleanly',
    () => {
      const root = makeTempDir('vh-fc-');
      const kernel = join(root, 'vmlinuz');
      const rootfs = join(root, 'rootfs.ext4');
      writeFileSync(kernel, 'kernel-image-bytes', { mode: 0o444 });
      writeFileSync(rootfs, 'rootfs-image-bytes', { mode: 0o444 });
      const jailBase = join(root, 'j');
      mkdirSync(jailBase, { mode: 0o700 });

      const plan = buildFirecrackerLaunchPlan({
        runId: 'fc-stg-1',
        jailBaseDir: jailBase,
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: 65534,
        vmmGid: 65534,
      });

      const staged = stageLocalVmRound({
        plan,
        sourceKernelPath: kernel,
        sourceRootfsPath: rootfs,
        approvedRoots: [root],
        applyChown: false,
      });
      expect(existsSync(staged.kernelPath)).toBe(true);
      expect(existsSync(staged.workDiskPath)).toBe(true);
      expect(existsSync(staged.configPath)).toBe(true);
      expect(existsSync(staged.consoleLogPath)).toBe(true);
      expect(
        verifyFirecrackerDiskConfig(plan, { requireExists: true }).ok,
      ).toBe(true);

      // Reordered keys still match plan.vmConfig via deep strict equality
      const reordered = {
        vsock: plan.vmConfig.vsock,
        'machine-config': plan.vmConfig['machine-config'],
        drives: plan.vmConfig.drives,
        'boot-source': plan.vmConfig['boot-source'],
      };
      writeFileSync(staged.configPath, JSON.stringify(reordered));
      expect(
        verifyFirecrackerDiskConfig(plan, { requireExists: true }).ok,
      ).toBe(true);

      // Tampering with config.json on disk (e.g., injecting a NIC or extra logger) is caught
      const tampered = {
        ...plan.vmConfig,
        'network-interfaces': [{ iface_id: 'eth0', host_dev_name: 'tap0' }],
      };
      writeFileSync(staged.configPath, JSON.stringify(tampered));
      const checkTampered = verifyFirecrackerDiskConfig(plan, {
        requireExists: true,
      });
      expect(checkTampered.ok).toBe(false);
      expect(checkTampered.error).toMatch(
        /does not match validated plan.vmConfig/,
      );

      // FIFO at config.json must fail closed immediately without blocking
      rmSync(staged.configPath);
      const mkfifoRes = spawnSync('mkfifo', [staged.configPath], {
        encoding: 'utf8',
      });
      expect(mkfifoRes.status).toBe(0);
      const checkFifo = verifyFirecrackerDiskConfig(plan, {
        requireExists: true,
      });
      expect(checkFifo.ok).toBe(false);
      expect(checkFifo.error).toMatch(/non-regular/);

      staged.cleanup();
      expect(existsSync(staged.jailRoot)).toBe(false);
      // Every newly created intermediate dir under jailBase is pruned, while pre-existing jailBase survives
      expect(existsSync(join(jailBase, 'firecracker'))).toBe(false);
      expect(existsSync(jailBase)).toBe(true);

      // Rollback on mid-staging failure: kernel copy cleaned, pre-existing caller dir preserved
      const callerOwned = join(root, 'round-1');
      mkdirSync(callerOwned, { mode: 0o700 });
      const symRootfs = join(root, 'sym-rootfs.ext4');
      symlinkSync(rootfs, symRootfs);
      const badPlan = buildFirecrackerLaunchPlan({
        runId: 'fc-stg-bad',
        jailBaseDir: callerOwned,
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: 65534,
        vmmGid: 65534,
      });
      expect(() =>
        stageLocalVmRound({
          plan: badPlan,
          sourceKernelPath: kernel,
          sourceRootfsPath: symRootfs,
          approvedRoots: [root],
          applyChown: false,
        }),
      ).toThrow(/must not be a symlink/);
      expect(existsSync(badPlan.kernelPath)).toBe(false);
      expect(existsSync(badPlan.jailRoot)).toBe(false);
      expect(existsSync(callerOwned)).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'stages vfkit assets, validates pre-existing Seatbelt profiles, and cleans exact created dirs without deleting caller-owned parents',
    () => {
      const root = makeTempDir('vh-vf-');
      const approved = join(root, 'approved');
      const outside = join(root, 'outside');
      const callerRound = join(approved, 'round-1');
      mkdirSync(callerRound, { recursive: true, mode: 0o700 });
      mkdirSync(outside, { mode: 0o700 });

      const kernel = join(root, 'vz-vmlinuz');
      const initrd = join(root, 'initramfs.gz');
      const rootfs = join(root, 'rootfs.ext4');
      writeFileSync(kernel, 'vz-kernel', { mode: 0o444 });
      writeFileSync(initrd, 'vz-initrd', { mode: 0o444 });
      writeFileSync(rootfs, 'vz-rootfs', { mode: 0o444 });

      const pocDir = join(callerRound, 'poc');
      const sockDir = join(callerRound, 's');
      const launcherSubdir = join(approved, 'launcher');
      const plan = buildVfkitLaunchPlan({
        runId: 'vf-stg-1',
        vfkitBin: '/usr/bin/true',
        seatbeltProfile: join(launcherSubdir, 'vfkit.sb'),
        pocDir,
        socketDir: sockDir,
        kernelPath: join(pocDir, 'vmlinuz'),
        initramfsPath: join(pocDir, 'initramfs.gz'),
        rootfsPath: join(pocDir, 'rootfs.ext4'),
        guestLogPath: join(pocDir, 'guest.log'),
        pidFile: join(pocDir, 'vfkit.pid'),
        homeDir: join(pocDir, 'home'),
        tmpDir: join(pocDir, 'tmp'),
      });

      const staged = stageLocalVmRound({
        plan,
        sourceKernelPath: kernel,
        sourceInitramfsPath: initrd,
        sourceRootfsPath: rootfs,
        approvedRoots: [approved],
      });
      expect(existsSync(staged.kernelPath)).toBe(true);
      expect(existsSync(staged.initramfsPath)).toBe(true);
      expect(existsSync(staged.workDiskPath)).toBe(true);
      expect(existsSync(staged.seatbeltProfilePath)).toBe(true);

      if (process.platform === 'darwin') {
        const live = probeSeatbeltEnforcement({
          seatbeltProfilePath: staged.seatbeltProfilePath,
          probeParentDir: root,
        });
        expect(live.enforcing).toBe(true);
      }

      staged.cleanup();
      expect(existsSync(staged.seatbeltProfilePath)).toBe(false);
      expect(existsSync(staged.workDiskPath)).toBe(false);
      // Newly created launcherSubdir must be pruned; pre-existing callerRound must NOT be deleted
      expect(existsSync(launcherSubdir)).toBe(false);
      expect(existsSync(callerRound)).toBe(true);

      // Pre-existing permissive Seatbelt profile inside approvedRoots must be refused
      mkdirSync(launcherSubdir, { mode: 0o700 });
      const permissiveProfile = join(launcherSubdir, 'permissive.sb');
      writeFileSync(permissiveProfile, '(version 1)\n(allow default)\n', {
        mode: 0o600,
      });
      const permissivePlan = buildVfkitLaunchPlan({
        runId: 'vf-stg-perm',
        vfkitBin: '/usr/bin/true',
        seatbeltProfile: permissiveProfile,
        pocDir: join(callerRound, 'poc-perm'),
        socketDir: join(callerRound, 's-perm'),
        kernelPath: join(callerRound, 'poc-perm', 'vmlinuz'),
        initramfsPath: join(callerRound, 'poc-perm', 'initramfs.gz'),
        rootfsPath: join(callerRound, 'poc-perm', 'rootfs.ext4'),
        guestLogPath: join(callerRound, 'poc-perm', 'guest.log'),
        pidFile: join(callerRound, 'poc-perm', 'vfkit.pid'),
        homeDir: join(callerRound, 'poc-perm', 'home'),
        tmpDir: join(callerRound, 'poc-perm', 'tmp'),
      });
      expect(() =>
        stageLocalVmRound({
          plan: permissivePlan,
          sourceKernelPath: kernel,
          sourceInitramfsPath: initrd,
          sourceRootfsPath: rootfs,
          approvedRoots: [approved],
        }),
      ).toThrow(/does not match the deny-default profile/);
      expect(existsSync(permissivePlan.kernelPath)).toBe(false);
      expect(existsSync(callerRound)).toBe(true);

      // Pre-existing profile outside approvedRoots (even with valid deny-default bytes) must be refused
      const outsideProfile = join(outside, 'vfkit.sb');
      writeFileSync(
        outsideProfile,
        renderVfkitSeatbeltProfile({ vfkitBin: '/usr/bin/true' }),
        { mode: 0o600 },
      );
      const outsidePlan = buildVfkitLaunchPlan({
        runId: 'vf-stg-out',
        vfkitBin: '/usr/bin/true',
        seatbeltProfile: outsideProfile,
        pocDir: join(callerRound, 'poc-out'),
        socketDir: join(callerRound, 's-out'),
        kernelPath: join(callerRound, 'poc-out', 'vmlinuz'),
        initramfsPath: join(callerRound, 'poc-out', 'initramfs.gz'),
        rootfsPath: join(callerRound, 'poc-out', 'rootfs.ext4'),
        guestLogPath: join(callerRound, 'poc-out', 'guest.log'),
        pidFile: join(callerRound, 'poc-out', 'vfkit.pid'),
        homeDir: join(callerRound, 'poc-out', 'home'),
        tmpDir: join(callerRound, 'poc-out', 'tmp'),
      });
      expect(() =>
        stageLocalVmRound({
          plan: outsidePlan,
          sourceKernelPath: kernel,
          sourceInitramfsPath: initrd,
          sourceRootfsPath: rootfs,
          approvedRoots: [approved],
        }),
      ).toThrow(/outside approvedRoots/);
      expect(existsSync(outsidePlan.kernelPath)).toBe(false);

      // Pre-existing matching deny-default profile inside approvedRoots is accepted
      const validExisting = join(launcherSubdir, 'valid.sb');
      writeFileSync(
        validExisting,
        renderVfkitSeatbeltProfile({ vfkitBin: '/usr/bin/true' }),
        { mode: 0o600 },
      );
      const validPlan = buildVfkitLaunchPlan({
        runId: 'vf-stg-ok',
        vfkitBin: '/usr/bin/true',
        seatbeltProfile: validExisting,
        pocDir: join(callerRound, 'poc-ok'),
        socketDir: join(callerRound, 's-ok'),
        kernelPath: join(callerRound, 'poc-ok', 'vmlinuz'),
        initramfsPath: join(callerRound, 'poc-ok', 'initramfs.gz'),
        rootfsPath: join(callerRound, 'poc-ok', 'rootfs.ext4'),
        guestLogPath: join(callerRound, 'poc-ok', 'guest.log'),
        pidFile: join(callerRound, 'poc-ok', 'vfkit.pid'),
        homeDir: join(callerRound, 'poc-ok', 'home'),
        tmpDir: join(callerRound, 'poc-ok', 'tmp'),
      });
      const validStaged = stageLocalVmRound({
        plan: validPlan,
        sourceKernelPath: kernel,
        sourceInitramfsPath: initrd,
        sourceRootfsPath: rootfs,
        approvedRoots: [approved],
      });
      expect(validStaged.seatbeltProfilePath).toBe(validExisting);
      validStaged.cleanup();
      // Pre-existing caller-owned profile must not be deleted by cleanup
      expect(existsSync(validExisting)).toBe(true);

      // Broken symlink at seatbeltProfile path must be rejected and roll back copies
      const brokenProfile = join(launcherSubdir, 'broken.sb');
      symlinkSync(join(root, 'does-not-exist.sb'), brokenProfile);
      const brokenPlan = buildVfkitLaunchPlan({
        runId: 'vf-stg-2',
        vfkitBin: '/usr/bin/true',
        seatbeltProfile: brokenProfile,
        pocDir: join(callerRound, 'poc2'),
        socketDir: join(callerRound, 's2'),
        kernelPath: join(callerRound, 'poc2', 'vmlinuz'),
        initramfsPath: join(callerRound, 'poc2', 'initramfs.gz'),
        rootfsPath: join(callerRound, 'poc2', 'rootfs.ext4'),
        guestLogPath: join(callerRound, 'poc2', 'guest.log'),
        pidFile: join(callerRound, 'poc2', 'vfkit.pid'),
        homeDir: join(callerRound, 'poc2', 'home'),
        tmpDir: join(callerRound, 'poc2', 'tmp'),
      });
      expect(() =>
        stageLocalVmRound({
          plan: brokenPlan,
          sourceKernelPath: kernel,
          sourceInitramfsPath: initrd,
          sourceRootfsPath: rootfs,
          approvedRoots: [approved],
        }),
      ).toThrow(/Seatbelt profile rejected \(symlink\)/);
      expect(existsSync(brokenPlan.kernelPath)).toBe(false);
      expect(existsSync(brokenPlan.ownershipTemplate.workDiskPath)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'runs runHardwareRound end to end with stageAssets=true, rolls back post-staging pre-launch failures, and blocks tampered/extra-key disk config.json',
    async () => {
      const root = makeTempDir('vh-run-');
      const launcherDir = join(root, 'launcher');
      const vaultDir = join(root, 'vault');
      const goldenKernel = join(root, 'golden-vmlinuz');
      const goldenRootfs = join(root, 'golden-rootfs.ext4');
      writeFileSync(goldenKernel, 'golden-kernel-data', { mode: 0o444 });
      writeFileSync(goldenRootfs, 'golden-rootfs-data', { mode: 0o444 });
      const ctx = makeHostContext(root);

      const currentUid =
        typeof process.getuid === 'function' && process.getuid() > 0
          ? process.getuid()
          : 65534;
      const currentGid =
        typeof process.getgid === 'function' && process.getgid() > 0
          ? process.getgid()
          : 65534;
      const plan = buildFirecrackerLaunchPlan({
        runId: 'e2e-stage-1',
        jailBaseDir: join(root, 'j'),
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: currentUid,
        vmmGid: currentGid,
      });

      // 1. Happy path with stageAssets: true
      let observedConfigJson = null;
      const res = await runHardwareRound({
        contextPath: ctx.path,
        contextSha256: ctx.sha256,
        launcherDir,
        vaultDir,
        approvedRoots: [root],
        plan,
        backendVersion: 'firecracker-test',
        sourceKernelPath: goldenKernel,
        sourceRootfsPath: goldenRootfs,
        stageAssets: true,
        applyChown: false,
        trustedInputDigest: sha256Text('trusted-input'),
        launchBackend: async ({ collectorSocketPath }) => {
          observedConfigJson = JSON.parse(
            readFileSync(join(plan.jailRoot, 'config.json'), 'utf8'),
          );
          const worker = spawn(
            process.execPath,
            ['-e', 'setTimeout(()=>{},60000)'],
            {
              stdio: 'ignore',
            },
          );
          await uploadMinimalValidReport(collectorSocketPath);
          return {
            workerPid: worker.pid,
            supervisorPid: worker.pid,
            workerExe: process.execPath,
            expectedExeTokens: ['node'],
            child: worker,
          };
        },
      });
      expect(res.errors).toEqual([]);
      expect(res.ok).toBe(true);
      expect(res.outputStatus).toBe('complete');
      expect(res.teardownStatus).toBe('destroyed');
      expect(res.sourceRootfsUnchanged).toBe(true);
      expect(res.checkExitCode).toBe(0);
      expect(observedConfigJson).toEqual(plan.vmConfig);
      expect(existsSync(plan.jailRoot)).toBe(false);
      expect(existsSync(plan.ownershipTemplate.workDiskPath)).toBe(false);
      expect(readFileSync(goldenRootfs, 'utf8')).toBe('golden-rootfs-data');

      // 2. Post-staging pre-launch rejection (with inputVsockPort set so staging actually executes first)
      // must fail on missing bundlePath and roll back the staged jailRoot
      const badInputPlan = buildFirecrackerLaunchPlan({
        runId: 'e2e-stage-bad',
        jailBaseDir: join(root, 'j'),
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: currentUid,
        vmmGid: currentGid,
        inputVsockPort: 53,
      });
      const preLaunchFail = await runHardwareRound({
        contextPath: ctx.path,
        contextSha256: ctx.sha256,
        launcherDir: join(root, 'launcher-bad'),
        vaultDir: join(root, 'vault-bad'),
        approvedRoots: [root],
        plan: badInputPlan,
        sourceKernelPath: goldenKernel,
        sourceRootfsPath: goldenRootfs,
        stageAssets: true,
        applyChown: false,
        roundInput: {
          bundlePath: join(root, 'missing.bundle'),
          baseRefOid: BASE_OID,
          headRefOid: HEAD_OID,
        },
      });
      expect(preLaunchFail.ok).toBe(false);
      expect(preLaunchFail.errors.join('\n')).toMatch(
        /round-input-rejected:.*bundlePath rejected/,
      );
      expect(existsSync(badInputPlan.jailRoot)).toBe(false);

      // 3. Default spawn path (stageAssets: false) refuses both NIC injection and extra keys (e.g. logger)
      for (const [tag, extra] of [
        [
          'e2e-tamper',
          {
            'network-interfaces': [{ iface_id: 'eth0', host_dev_name: 'tap0' }],
          },
        ],
        ['e2e-logger', { logger: { log_path: '/tmp/fc.log' } }],
      ]) {
        const tamperPlan = buildFirecrackerLaunchPlan({
          runId: tag,
          jailBaseDir: join(root, 'j'),
          firecrackerBin: '/opt/firecracker',
          jailerBin: '/bin/sh',
          vmmUid: currentUid,
          vmmGid: currentGid,
        });
        mkdirSync(tamperPlan.jailRoot, { recursive: true });
        copyFileSync(goldenKernel, tamperPlan.kernelPath);
        copyFileSync(goldenRootfs, tamperPlan.ownershipTemplate.workDiskPath);
        writeFileSync(
          join(tamperPlan.jailRoot, 'config.json'),
          JSON.stringify({ ...tamperPlan.vmConfig, ...extra }),
        );
        const tamperedRun = await runHardwareRound({
          contextPath: ctx.path,
          contextSha256: ctx.sha256,
          launcherDir: join(root, `launcher-${tag}`),
          vaultDir: join(root, `vault-${tag}`),
          approvedRoots: [root],
          plan: tamperPlan,
          sourceKernelPath: goldenKernel,
          sourceRootfsPath: goldenRootfs,
          trustedInputDigest: sha256Text('trusted-input'),
        });
        expect(tamperedRun.ok).toBe(false);
        expect(tamperedRun.errors.join('\n')).toMatch(
          /disk config\.json does not match validated plan\.vmConfig/,
        );
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'supports CLI probe, select --probe, run --config with stageAssets=true (firecracker and vfkit), and strict flag errors',
    () => {
      const root = makeTempDir('vh-cli-');
      const ctx = makeHostContext(root);

      // probe returns structured JSON and exits 0 when --provider-configured is set
      const probeProvider = spawnSync(
        process.execPath,
        [RUNNER_SCRIPT, 'probe', '--provider-configured'],
        { encoding: 'utf8' },
      );
      expect(probeProvider.status).toBe(0);
      const caps = JSON.parse(probeProvider.stdout);
      expect(caps.providerConfigured).toBe(true);
      expect(caps.platform).toBe(process.platform);

      // select --probe with --provider-configured resolves to a valid hardware backend
      const selectProbe = spawnSync(
        process.execPath,
        [
          RUNNER_SCRIPT,
          'select',
          '--context',
          ctx.path,
          '--probe',
          '--provider-configured',
        ],
        { encoding: 'utf8' },
      );
      expect(selectProbe.status).toBe(0);
      const decision = JSON.parse(selectProbe.stdout);
      expect(decision.executionClass).toBe('hardware-isolated');
      expect(['firecracker', 'vfkit', 'provider-vm']).toContain(
        decision.backend,
      );
      expect(decision.probe.platform).toBe(process.platform);

      // Mixing --probe with --kvm is refused with usage error 2
      const mixed = spawnSync(
        process.execPath,
        [RUNNER_SCRIPT, 'select', '--context', ctx.path, '--probe', '--kvm'],
        { encoding: 'utf8' },
      );
      expect(mixed.status).toBe(2);
      expect(mixed.stderr).toMatch(/cannot be combined/);

      // Probe-only flags without --probe are refused with usage error 2 (even --vmm-uid 65534)
      const probeOnlyNoFlag = spawnSync(
        process.execPath,
        [
          RUNNER_SCRIPT,
          'select',
          '--context',
          ctx.path,
          '--kvm',
          '--firecracker-bin',
          '/x',
        ],
        { encoding: 'utf8' },
      );
      expect(probeOnlyNoFlag.status).toBe(2);
      expect(probeOnlyNoFlag.stderr).toMatch(/require --probe/);

      const uidOnlyNoFlag = spawnSync(
        process.execPath,
        [
          RUNNER_SCRIPT,
          'select',
          '--context',
          ctx.path,
          '--kvm',
          '--vmm-uid',
          '65534',
        ],
        { encoding: 'utf8' },
      );
      expect(uidOnlyNoFlag.status).toBe(2);
      expect(uidOnlyNoFlag.stderr).toMatch(/require --probe/);

      // Flag-shaped next token is treated as missing value with exit 2
      const flagAsValue = spawnSync(
        process.execPath,
        [RUNNER_SCRIPT, 'select', '--context', '--probe'],
        { encoding: 'utf8' },
      );
      expect(flagAsValue.status).toBe(2);
      expect(flagAsValue.stderr).toMatch(/missing value for --context/);

      // Invalid --vmm-uid and missing option values are refused with usage error 2
      const badUid = spawnSync(
        process.execPath,
        [RUNNER_SCRIPT, 'probe', '--vmm-uid', '0'],
        { encoding: 'utf8' },
      );
      expect(badUid.status).toBe(2);
      expect(badUid.stderr).toMatch(/positive integer/);

      const missingBin = spawnSync(
        process.execPath,
        [RUNNER_SCRIPT, 'probe', '--firecracker-bin'],
        { encoding: 'utf8' },
      );
      expect(missingBin.status).toBe(2);
      expect(missingBin.stderr).toMatch(/missing value for --firecracker-bin/);

      // CLI run --config with stageAssets=true for Firecracker reaches launch and cleans jailRoot
      const goldenKernel = join(root, 'k.bin');
      const goldenInitrd = join(root, 'initrd.gz');
      const goldenRootfs = join(root, 'r.ext4');
      writeFileSync(goldenKernel, 'cli-kernel', { mode: 0o444 });
      writeFileSync(goldenInitrd, 'cli-initrd', { mode: 0o444 });
      writeFileSync(goldenRootfs, 'cli-rootfs', { mode: 0o444 });
      const currentUid =
        typeof process.getuid === 'function' && process.getuid() > 0
          ? process.getuid()
          : 65534;
      const currentGid =
        typeof process.getgid === 'function' && process.getgid() > 0
          ? process.getgid()
          : 65534;

      const markerPath = join(root, 'fc-launched.txt');
      const fcJailBase = join(root, 'j');
      mkdirSync(fcJailBase, { mode: 0o700 });
      const expectedFcJailRoot = join(
        fcJailBase,
        'firecracker',
        'cli-fc-1',
        'root',
      );
      const fakeJailer = join(root, 'fake-jailer');
      writeExecutableScript(
        fakeJailer,
        `#!/bin/sh\nprintf "%s\\n" "$$" > "${join(expectedFcJailRoot, 'firecracker.pid')}"\nprintf "launched" > "${markerPath}"\nexit 0\n`,
      );
      const fcCfgPath = join(root, 'fc-run.json');
      writeFileSync(
        fcCfgPath,
        JSON.stringify({
          backend: 'firecracker',
          contextPath: ctx.path,
          contextSha256: ctx.sha256,
          launcherDir: join(root, 'l-fc'),
          vaultDir: join(root, 'v-fc'),
          approvedRoots: [root],
          planOptions: {
            runId: 'cli-fc-1',
            jailBaseDir: fcJailBase,
            firecrackerBin: '/opt/firecracker',
            jailerBin: fakeJailer,
            vmmUid: currentUid,
            vmmGid: currentGid,
          },
          sourceKernelPath: goldenKernel,
          sourceRootfsPath: goldenRootfs,
          stageAssets: true,
          applyChown: false,
          trustedInputDigest: sha256Text('cli-fc-input'),
        }),
      );
      const fcCli = spawnSync(
        process.execPath,
        [RUNNER_SCRIPT, 'run', '--config', fcCfgPath],
        { encoding: 'utf8' },
      );
      expect(fcCli.status, fcCli.stderr).toBe(1);
      const fcOut = JSON.parse(fcCli.stdout);
      expect(fcOut.errors.join('\n')).not.toMatch(/planned kernel must be/);
      expect(existsSync(markerPath)).toBe(true);
      expect(
        existsSync(join(fcJailBase, 'firecracker', 'cli-fc-1', 'root')),
      ).toBe(false);

      // CLI run --config with stageAssets=true + sourceInitramfsPath for vfkit stages initramfs & .sb
      const vfPocDir = join(root, 'vf-poc');
      const vfSockDir = join(root, 'vf-s');
      const vfProfile = join(root, 'vf-sb', 'vfkit.sb');
      const vfCfgPath = join(root, 'vf-run.json');
      writeFileSync(
        vfCfgPath,
        JSON.stringify({
          backend: 'vfkit',
          contextPath: ctx.path,
          contextSha256: ctx.sha256,
          launcherDir: join(root, 'l-vf'),
          vaultDir: join(root, 'v-vf'),
          approvedRoots: [root],
          planOptions: {
            runId: 'cli-vf-1',
            vfkitBin: '/usr/bin/true',
            seatbeltProfile: vfProfile,
            pocDir: vfPocDir,
            socketDir: vfSockDir,
            kernelPath: join(vfPocDir, 'vmlinuz'),
            initramfsPath: join(vfPocDir, 'initramfs.gz'),
            rootfsPath: join(vfPocDir, 'rootfs.ext4'),
            guestLogPath: join(vfPocDir, 'guest.log'),
            pidFile: join(vfPocDir, 'vfkit.pid'),
            homeDir: join(vfPocDir, 'home'),
            tmpDir: join(vfPocDir, 'tmp'),
          },
          sourceKernelPath: goldenKernel,
          sourceInitramfsPath: goldenInitrd,
          sourceRootfsPath: goldenRootfs,
          stageAssets: true,
          trustedInputDigest: sha256Text('cli-vf-input'),
        }),
      );
      const vfCli = spawnSync(
        process.execPath,
        [RUNNER_SCRIPT, 'run', '--config', vfCfgPath],
        { encoding: 'utf8' },
      );
      expect(vfCli.status, vfCli.stderr).toBe(1);
      const vfOut = JSON.parse(vfCli.stdout);
      expect(vfOut.errors.join('\n')).not.toMatch(
        /planned kernel must be|requires sourceInitramfsPath|stage-assets-failed/,
      );
      expect(existsSync(vfProfile)).toBe(false);
      expect(existsSync(join(vfPocDir, 'initramfs.gz'))).toBe(false);
    },
  );
});
