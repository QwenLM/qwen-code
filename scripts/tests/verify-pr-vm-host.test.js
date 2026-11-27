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
    },
  );

  it('rejects non-char /dev/kvm, symlinked binaries, invalid uid, and broken version probes on Linux mode', () => {
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
  });
});

describe('verify-pr-vm-host asset staging, rollback, and runner integration', () => {
  it('copies golden assets to independent inodes, refuses unsafe paths/overwrites, and rolls back on failure', () => {
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

    // Refuses outside approvedRoots and inside vaultDir
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
  });

  it('stages Firecracker jailRoot, verifies disk config.json against tampering, and rolls back on mid-staging error', () => {
    const root = makeTempDir('vh-fc-');
    const kernel = join(root, 'vmlinuz');
    const rootfs = join(root, 'rootfs.ext4');
    writeFileSync(kernel, 'kernel-image-bytes', { mode: 0o444 });
    writeFileSync(rootfs, 'rootfs-image-bytes', { mode: 0o444 });

    const plan = buildFirecrackerLaunchPlan({
      runId: 'fc-stg-1',
      jailBaseDir: join(root, 'j'),
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
    expect(verifyFirecrackerDiskConfig(plan, { requireExists: true }).ok).toBe(
      true,
    );

    // Reordered keys still match plan.vmConfig via deep strict equality
    const reordered = {
      vsock: plan.vmConfig.vsock,
      'machine-config': plan.vmConfig['machine-config'],
      drives: plan.vmConfig.drives,
      'boot-source': plan.vmConfig['boot-source'],
    };
    writeFileSync(staged.configPath, JSON.stringify(reordered));
    expect(verifyFirecrackerDiskConfig(plan, { requireExists: true }).ok).toBe(
      true,
    );

    // Tampering with config.json on disk (e.g., injecting a NIC) is caught
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

    staged.cleanup();
    expect(existsSync(staged.jailRoot)).toBe(false);

    // Rollback on mid-staging failure: kernel copy must be cleaned when rootfs is a symlink
    const symRootfs = join(root, 'sym-rootfs.ext4');
    symlinkSync(rootfs, symRootfs);
    const badPlan = buildFirecrackerLaunchPlan({
      runId: 'fc-stg-bad',
      jailBaseDir: join(root, 'j'),
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
  });

  it('stages vfkit assets with a generated deny-default Seatbelt profile', () => {
    const root = makeTempDir('vh-vf-');
    const kernel = join(root, 'vz-vmlinuz');
    const initrd = join(root, 'initramfs.gz');
    const rootfs = join(root, 'rootfs.ext4');
    writeFileSync(kernel, 'vz-kernel', { mode: 0o444 });
    writeFileSync(initrd, 'vz-initrd', { mode: 0o444 });
    writeFileSync(rootfs, 'vz-rootfs', { mode: 0o444 });

    const pocDir = join(root, 'poc');
    const sockDir = join(root, 's');
    const plan = buildVfkitLaunchPlan({
      runId: 'vf-stg-1',
      vfkitBin: '/usr/bin/true',
      seatbeltProfile: join(root, 'launcher', 'vfkit.sb'),
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
      approvedRoots: [root],
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

    // Broken symlink at seatbeltProfile path must be rejected and roll back copies
    const brokenProfile = join(root, 'launcher', 'broken.sb');
    symlinkSync(join(root, 'does-not-exist.sb'), brokenProfile);
    const brokenPlan = buildVfkitLaunchPlan({
      runId: 'vf-stg-2',
      vfkitBin: '/usr/bin/true',
      seatbeltProfile: brokenProfile,
      pocDir: join(root, 'poc2'),
      socketDir: join(root, 's2'),
      kernelPath: join(root, 'poc2', 'vmlinuz'),
      initramfsPath: join(root, 'poc2', 'initramfs.gz'),
      rootfsPath: join(root, 'poc2', 'rootfs.ext4'),
      guestLogPath: join(root, 'poc2', 'guest.log'),
      pidFile: join(root, 'poc2', 'vfkit.pid'),
      homeDir: join(root, 'poc2', 'home'),
      tmpDir: join(root, 'poc2', 'tmp'),
    });
    expect(() =>
      stageLocalVmRound({
        plan: brokenPlan,
        sourceKernelPath: kernel,
        sourceInitramfsPath: initrd,
        sourceRootfsPath: rootfs,
        approvedRoots: [root],
      }),
    ).toThrow(/Seatbelt profile rejected \(symlink\)/);
    expect(existsSync(brokenPlan.kernelPath)).toBe(false);
    expect(existsSync(brokenPlan.ownershipTemplate.workDiskPath)).toBe(false);
  });

  it('runs runHardwareRound end to end with stageAssets=true, cleans staged files, and blocks tampered disk config.json', async () => {
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

    // 1. Happy path with stageAssets: true (caller creates no jailRoot, copies no disk, writes no config.json)
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

    // 2. Pre-launch rejection cleans up already-staged files
    const badInputPlan = buildFirecrackerLaunchPlan({
      runId: 'e2e-stage-bad',
      jailBaseDir: join(root, 'j'),
      firecrackerBin: '/opt/firecracker',
      jailerBin: '/opt/jailer',
      vmmUid: 65534,
      vmmGid: 65534,
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
    expect(existsSync(badInputPlan.jailRoot)).toBe(false);

    // 3. Default spawn path refuses a tampered on-disk config.json before spawning
    const tamperPlan = buildFirecrackerLaunchPlan({
      runId: 'e2e-tamper',
      jailBaseDir: join(root, 'j'),
      firecrackerBin: '/opt/firecracker',
      jailerBin: '/bin/sh',
      vmmUid: 65534,
      vmmGid: 65534,
    });
    mkdirSync(tamperPlan.jailRoot, { recursive: true });
    copyFileSync(goldenKernel, tamperPlan.kernelPath);
    copyFileSync(goldenRootfs, tamperPlan.ownershipTemplate.workDiskPath);
    writeFileSync(
      join(tamperPlan.jailRoot, 'config.json'),
      JSON.stringify({
        ...tamperPlan.vmConfig,
        'network-interfaces': [{ iface_id: 'eth0', host_dev_name: 'tap0' }],
      }),
    );
    const tamperedRun = await runHardwareRound({
      contextPath: ctx.path,
      contextSha256: ctx.sha256,
      launcherDir: join(root, 'launcher-tamper'),
      vaultDir: join(root, 'vault-tamper'),
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
  });

  it('supports CLI probe, select --probe, and rejects mixing --probe with manual capability flags', () => {
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
    expect(['firecracker', 'vfkit', 'provider-vm']).toContain(decision.backend);
    expect(decision.probe.platform).toBe(process.platform);

    // Mixing --probe with --kvm is refused with usage error 2
    const mixed = spawnSync(
      process.execPath,
      [RUNNER_SCRIPT, 'select', '--context', ctx.path, '--probe', '--kvm'],
      { encoding: 'utf8' },
    );
    expect(mixed.status).toBe(2);
    expect(mixed.stderr).toMatch(/cannot be combined/);

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
  });
});
