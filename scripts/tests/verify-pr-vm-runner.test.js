/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACK,
  GREETING,
  startCollectorServer,
} from '../../scripts/verify-pr-vm-collector.mjs';
import {
  buildExecutionRecord,
  writeExecutionRecordAndBoundary,
} from '../../scripts/verify-pr-vm-lifecycle.mjs';
import {
  buildAliyunAgentSandboxPlan,
  buildAliyunProviderPlan,
  buildFirecrackerLaunchPlan,
  buildVfkitLaunchPlan,
  isAliyunInvocationComplete,
  isAliyunTransientDeleteError,
  selectBackend,
} from '../../scripts/verify-pr-vm-runner.mjs';

const CHECK_SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-check.mjs', import.meta.url),
);

const BASE_OID = 'a'.repeat(40);
const HEAD_OID = 'b'.repeat(40);
const SHA = (ch) => ch.repeat(64);

let tmpDirs = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeTmpDir(prefix = 'qc-runner-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeFrame(kind, body = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const hdr = Buffer.allocUnsafe(5);
  hdr[0] = kind.charCodeAt(0);
  hdr.writeUInt32BE(payload.length, 1);
  return Buffer.concat([hdr, payload]);
}

function makeWholeFile(name, text) {
  const body = Buffer.from(text, 'utf8');
  const nameBuf = Buffer.from(name, 'utf8');
  const sz = Buffer.allocUnsafe(8);
  sz.writeBigUInt64BE(BigInt(body.length), 0);
  const sha = createHash('sha256').update(body).digest('hex');
  return Buffer.concat([
    makeFrame('B', Buffer.concat([sz, nameBuf])),
    makeFrame('C', body),
    makeFrame('E', sha),
  ]);
}

function sendRoundFiles(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buf = Buffer.alloc(0);
    let acked = false;
    conn.on('error', reject);
    conn.on('connect', () => conn.write(GREETING));
    conn.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!acked) {
        if (buf.length < ACK.length) return;
        buf = buf.subarray(ACK.length);
        acked = true;
        conn.write(payload);
        return;
      }
      if (buf.length >= 5) {
        const len = buf.readUInt32BE(1);
        if (buf.length >= 5 + len) {
          conn.end();
          resolve({
            kind: String.fromCharCode(buf[0]),
            reason: buf.subarray(5, 5 + len).toString('ascii'),
          });
        }
      }
    });
  });
}

describe('verify-pr-vm-runner backend selection (fail-closed)', () => {
  it('selects firecracker on Linux KVM, vfkit on macOS ARM64 with enforcing Seatbelt, and provider-vm when configured', () => {
    expect(
      selectBackend({
        executionClass: 'hardware-isolated',
        platform: 'linux',
        kvmAvailable: true,
      }),
    ).toEqual({ backend: 'firecracker', error: null });

    expect(
      selectBackend({
        executionClass: 'hardware-isolated',
        platform: 'darwin',
        arch: 'arm64',
        vfkitAvailable: true,
        seatbeltEnforcing: true,
      }),
    ).toEqual({ backend: 'vfkit', error: null });

    expect(
      selectBackend({
        executionClass: 'hardware-isolated',
        platform: 'linux',
        kvmAvailable: false,
        providerConfigured: true,
      }),
    ).toEqual({ backend: 'provider-vm', error: null });
  });

  it('refuses bare vfkit without enforcing Seatbelt and never downgrades hardware-isolated to container or host', () => {
    const bareMac = selectBackend({
      executionClass: 'hardware-isolated',
      platform: 'darwin',
      arch: 'arm64',
      vfkitAvailable: true,
      seatbeltEnforcing: false,
      providerConfigured: false,
    });
    expect(bareMac.backend).toBeNull();
    expect(bareMac.error).toMatch(/refusing silent downgrade/);

    const containerAttempt = selectBackend({
      executionClass: 'hardware-isolated',
      preferredBackend: 'container',
      platform: 'linux',
      kvmAvailable: true,
    });
    expect(containerAttempt.backend).toBeNull();
    expect(containerAttempt.error).toMatch(/not permitted/);

    // Upgrading trusted-shared-kernel to hardware backend is allowed
    expect(
      selectBackend({
        executionClass: 'trusted-shared-kernel',
        preferredBackend: 'firecracker',
        platform: 'linux',
        kvmAvailable: true,
      }),
    ).toEqual({ backend: 'firecracker', error: null });
  });
});

describe('verify-pr-vm-runner backend launch plans', () => {
  it('builds a no-NIC Firecracker/jailer plan and rejects >= 107-byte Linux UDS paths', () => {
    const plan = buildFirecrackerLaunchPlan({
      runId: 'fc01',
      jailBaseDir: '/tmp/jail',
      firecrackerBin: '/opt/fc/firecracker-v1.18.0-aarch64',
      jailerBin: '/opt/fc/jailer-v1.18.0-aarch64',
    });
    expect(plan.vmConfig['network-interfaces']).toBeUndefined();
    expect(plan.vmConfig.vsock.uds_path).toBe('/v.sock');
    expect(plan.argv).toContain('--new-pid-ns');
    expect(plan.argv).toContain('65534');
    expect(plan.launchPolicyDigest).toMatch(/^[0-9a-f]{64}$/);

    expect(() =>
      buildFirecrackerLaunchPlan({
        runId: 'fc02',
        jailBaseDir: '/tmp/j',
        firecrackerBin: '/opt/fc/firecracker-v1.18.0-aarch64',
        jailerBin: '/opt/fc/jailer-v1.18.0-aarch64',
        guestCid: 2,
      }),
    ).toThrow(/guestCid must be an integer >= 3/);

    expect(() =>
      buildFirecrackerLaunchPlan({
        runId: 'fc-very-long-run-id-1234',
        jailBaseDir: '/root/Work/qwen-microvm-poc-20261123/jail',
        firecrackerBin: '/opt/fc/firecracker-v1.18.0-aarch64',
        jailerBin: '/opt/fc/jailer-v1.18.0-aarch64',
      }),
    ).toThrow(/sun_path limit/);
  });

  it('builds a Seatbelt-wrapped no-REST no-NIC vfkit plan and refuses bare vfkit', () => {
    const plan = buildVfkitLaunchPlan({
      runId: 'vf01',
      vfkitBin: '/opt/vfkit',
      seatbeltProfile: '/opt/vfkit-probe.sb',
      pocDir: '/tmp/poc',
      socketDir: '/tmp/s1',
      kernelPath: '/tmp/vmlinuz',
      initramfsPath: '/tmp/initrd.gz',
      rootfsPath: '/tmp/rootfs.ext4',
      guestLogPath: '/tmp/guest.log',
      pidFile: '/tmp/vfkit.pid',
      homeDir: '/tmp/home',
      tmpDir: '/tmp',
    });
    expect(plan.argv[0]).toBe('/usr/bin/env');
    expect(plan.argv).toContain('/usr/bin/sandbox-exec');
    expect(plan.argv).toContain('--restful-uri');
    expect(plan.argv).toContain('none://');
    expect(plan.argv.join(' ')).not.toMatch(/virtio-net|virtio-fs|rosetta/);

    expect(() =>
      buildVfkitLaunchPlan({
        runId: 'vf02',
        vfkitBin: '/opt/vfkit',
        seatbeltProfile: '/opt/vfkit-probe.sb',
        pocDir: '/tmp/poc',
        socketDir: '/tmp/s1',
        kernelPath: '/tmp/vmlinuz,injected=1',
        initramfsPath: '/tmp/initrd.gz',
        rootfsPath: '/tmp/rootfs.ext4',
        guestLogPath: '/tmp/guest.log',
        pidFile: '/tmp/vfkit.pid',
        homeDir: '/tmp/home',
        tmpDir: '/tmp',
      }),
    ).toThrow(/must not contain commas/);

    expect(() =>
      buildVfkitLaunchPlan({
        runId: 'vf01',
        vfkitBin: '/opt/vfkit',
        seatbeltProfile: '',
        pocDir: '/tmp/poc',
        socketDir: '/tmp/s1',
        kernelPath: '/tmp/vmlinuz',
        initramfsPath: '/tmp/initrd.gz',
        rootfsPath: '/tmp/rootfs.ext4',
        guestLogPath: '/tmp/guest.log',
        pidFile: '/tmp/vfkit.pid',
        homeDir: '/tmp/home',
        tmpDir: '/tmp',
      }),
    ).toThrow(/Seatbelt profile/);
  });

  it('builds an Aliyun provider-vm plan encoding all P7 API invariants', () => {
    const plan = buildAliyunProviderPlan({
      runId: 'pv01',
      headRefOid: HEAD_OID,
      region: 'cn-hangzhou',
      zone: 'cn-hangzhou-b',
      vpcId: 'vpc-test',
      vSwitchId: 'vsw-test',
      imageId: 'debian_12_15_x64_20G_alibase_20261016.vhd',
    });
    const egress = plan.authorizeEgressArgvs('sg-test');
    expect(egress.some((a) => a.includes('--PortRange=-1/-1'))).toBe(true);
    const runArgv = plan.runInstancesArgv('sg-test');
    expect(runArgv).toContain('--InternetMaxBandwidthOut');
    expect(runArgv).toContain('0');
    expect(runArgv).toContain('--HttpTokens');
    expect(runArgv).toContain('required');
    expect(runArgv).not.toContain('--RamRoleName');
    expect(isAliyunInvocationComplete({ InvocationStatus: 'Success' })).toBe(
      true,
    );
    expect(isAliyunInvocationComplete({ InvokeRecordStatus: 'Finished' })).toBe(
      true,
    );
    expect(
      isAliyunTransientDeleteError(
        'ErrorCode: IncorrectInstanceStatus.Initializing',
      ),
    ).toBe(true);
    expect(() =>
      buildAliyunProviderPlan({
        runId: 'pv02',
        headRefOid: HEAD_OID,
        region: 'cn-hangzhou',
        zone: 'cn-hangzhou-b',
        vpcId: 'vpc-test',
        vSwitchId: 'vsw-test',
        imageId: 'debian_12.vhd',
        autoReleaseMinutes: 15,
      }),
    ).toThrow(/at least 30 minutes/);
  });

  it('builds a hardened Aliyun Agent Sandbox (fcsandbox) plan and refuses default public egress templates', () => {
    for (const badTemplate of [
      'code-interpreter-v1',
      ' Code-Interpreter-V1 ',
      'BASE',
    ]) {
      expect(() =>
        buildAliyunAgentSandboxPlan({
          runId: 'sb01',
          headRefOid: HEAD_OID,
          region: 'cn-hangzhou',
          teamId: 'team-123',
          templateName: badTemplate,
          vpcId: 'vpc-isolated',
          vSwitchIds: ['vsw-isolated'],
          securityGroupId: 'sg-drop-egress',
        }),
      ).toThrow(/default public egress is OPEN/);
    }

    const plan = buildAliyunAgentSandboxPlan({
      runId: 'sb02',
      headRefOid: HEAD_OID,
      region: 'cn-hangzhou',
      teamId: 'team-123',
      templateName: 'qwen-verify-hardened-v1',
      vpcId: 'vpc-isolated',
      vSwitchIds: ['vsw-isolated'],
      securityGroupId: 'sg-drop-egress',
      image: 'registry.cn-hangzhou.aliyuncs.com/qwen/verify:v1',
    });
    expect(plan.backend).toBe('provider-vm');
    expect(plan.domain).toBe('cn-hangzhou.sandbox.aliyuncs.com');
    expect(plan.apiUrl).toBe('https://api.cn-hangzhou.sandbox.aliyuncs.com');
    expect(plan.templateBody.runtimeConfig.internetAccess).toBe(false);
    expect(plan.templateBody.runtimeConfig.vpcConfig.securityGroupId).toBe(
      'sg-drop-egress',
    );
    expect(plan.templateBody.buildConfig.envdInject.enabled).toBe(true);
    const revokeSteps = plan.revokeApiKeyArgvs('key-123');
    expect(revokeSteps[0]).toContain('UpdateApiKey');
    expect(revokeSteps[0].join(' ')).toContain('"status":"inactive"');
    expect(revokeSteps[1]).toContain('DeleteApiKey');
    expect(plan.launchPolicyDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('chains collector -> vm-lifecycle finalize -> verify-pr-check.mjs end to end', async () => {
    const root = makeTmpDir('qc-chain-');
    const sock = join(root, 'v.sock');
    const vault = join(root, 'vault');
    const launcherDir = join(root, 'launcher');
    mkdirSync(join(vault, 'evidence'), { recursive: true });
    writeFileSync(join(vault, 'evidence', '01-ab.png'), 'png');

    const srv = startCollectorServer({ socketPath: sock, vaultDir: vault });
    await srv.ready;

    const reply = await sendRoundFiles(
      sock,
      Buffer.concat([
        makeFrame('H', 'report-v1'),
        makeWholeFile('verdict.txt', 'merge-ready\n'),
        makeWholeFile('assertions.json', '{"pass":2,"fail":0,"total":2}\n'),
        makeWholeFile(
          'report.md',
          `merge-ready · 2 passed · 0 failed · 2 total · ${HEAD_OID}\n\n## Methodology\n\n**Boundary.** Firecracker microVM (hardware-isolated).\n`,
        ),
        makeFrame('R'),
      ]),
    );
    const colSum = await srv.done;
    expect(reply).toEqual({ kind: 'O', reason: 'complete' });
    expect(colSum.outputStatus).toBe('complete');

    const plan = buildFirecrackerLaunchPlan({
      runId: 'fc09',
      jailBaseDir: '/tmp/j',
      firecrackerBin: '/opt/firecracker-v1.18.0-aarch64',
      jailerBin: '/opt/jailer-v1.18.0-aarch64',
    });
    const snap = {
      repo: 'QwenLM/qwen-code',
      number: 18099,
      baseRefOid: BASE_OID,
      headRefOid: HEAD_OID,
      trustClassification: {
        prTrust: 'external',
        executionClass: 'hardware-isolated',
        escalationReasons: [],
        headRefOid: HEAD_OID,
      },
    };
    const snapPath = join(root, 'host-context.json');
    const snapText = `${JSON.stringify(snap, null, 2)}\n`;
    writeFileSync(snapPath, snapText);
    const snapSha = createHash('sha256').update(snapText).digest('hex');

    const rec = buildExecutionRecord({
      contextSnapshot: snap,
      contextSha256: snapSha,
      runId: plan.runId,
      backend: plan.backend,
      backendVersion: 'v1.18.0',
      platform: 'linux-aarch64',
      startedAt: '2026-11-23T13:00:00Z',
      endedAt: '2026-11-23T13:00:04Z',
      destroyedAt: '2026-11-23T13:00:05Z',
      outputStatus: colSum.outputStatus,
      teardownStatus: 'destroyed',
      diskDestroyed: true,
      tokenRevoked: true,
      launchPolicyDigest: plan.launchPolicyDigest,
      trustedInputDigest: SHA('5'),
      kernelDigest: SHA('6'),
      rootfsDigest: SHA('7'),
      workerPid: 999911,
      workerExe: '/firecracker-v1.18.0-aarch64',
      workerExitEvidence: 'absent',
    });
    const fin = writeExecutionRecordAndBoundary({
      record: rec,
      launcherDir,
      artifactDir: vault,
      verifyLivePid: true,
    });
    expect(fin.ok).toBe(true);

    const chk = spawnSync(
      process.execPath,
      [
        CHECK_SCRIPT,
        '--context',
        snapPath,
        '--context-sha256',
        snapSha,
        '--execution-record',
        fin.executionRecordPath,
        '--execution-record-sha256',
        fin.executionRecordSha256,
        vault,
      ],
      { encoding: 'utf8' },
    );
    expect(chk.status).toBe(0);
    expect(chk.stdout).toMatch(/ok: verdict=merge-ready/);
  });
});
