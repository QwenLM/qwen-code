/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
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
  inspectPidState,
  writeExecutionRecordAndBoundary,
} from '../../scripts/verify-pr-vm-lifecycle.mjs';
import {
  buildAliyunAgentSandboxPlan,
  buildAliyunProviderPlan,
  buildFirecrackerLaunchPlan,
  buildVfkitLaunchPlan,
  isAliyunInvocationComplete,
  isAliyunTransientDeleteError,
  runHardwareRound,
  selectBackend,
} from '../../scripts/verify-pr-vm-runner.mjs';

const CHECK_SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-check.mjs', import.meta.url),
);
const RUNNER_SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-vm-runner.mjs', import.meta.url),
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

describe('verify-pr-vm-runner runHardwareRound orchestrator', () => {
  const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
  ]);

  function makeBinaryFile(name, buf) {
    const nameBuf = Buffer.from(name, 'utf8');
    const sz = Buffer.allocUnsafe(8);
    sz.writeBigUInt64BE(BigInt(buf.length), 0);
    const sha = createHash('sha256').update(buf).digest('hex');
    return Buffer.concat([
      makeFrame('B', Buffer.concat([sz, nameBuf])),
      makeFrame('C', buf),
      makeFrame('E', sha),
    ]);
  }

  function writeHostContext(root, overrides = {}) {
    const snap = {
      repo: 'QwenLM/qwen-code',
      number: 18181,
      baseRefOid: BASE_OID,
      headRefOid: HEAD_OID,
      trustClassification: {
        prTrust: 'external',
        executionClass: 'hardware-isolated',
        escalationReasons: [],
        headRefOid: HEAD_OID,
      },
      ...overrides,
    };
    const text = `${JSON.stringify(snap, null, 2)}\n`;
    const path = join(root, 'host-context.json');
    writeFileSync(path, text);
    return {
      contextPath: path,
      contextSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    };
  }

  it('orchestrates model proxy (auth/budget/revocation), UDS collector (incl. PNG), live worker reap, finalize, and verify-pr-check end to end', async () => {
    const root = mkdtempSync('/tmp/qc-orch-');
    tmpDirs.push(root);
    const { contextPath, contextSha256 } = writeHostContext(root);
    const launcherDir = join(root, 'launcher');
    const vaultDir = join(root, 'vault');
    const sockDir = join(root, 's');
    const srcKernel = join(root, 'golden-vmlinuz');
    const srcRootfs = join(root, 'golden-rootfs.ext4');
    const workDisk = join(root, 'work-rootfs.ext4');
    mkdirSync(sockDir, { recursive: true });
    writeFileSync(srcKernel, 'kernel-bytes');
    writeFileSync(srcRootfs, 'golden-rootfs-bytes');
    writeFileSync(workDisk, 'golden-rootfs-bytes');

    const REAL_KEY = 'orchestrator-host-only-secret';
    let upstreamCalls = 0;
    const upstream = http.createServer((req, res) => {
      upstreamCalls += 1;
      expect(req.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upPort = upstream.address().port;

    const plan = buildVfkitLaunchPlan({
      runId: 'orch01',
      vfkitBin: '/opt/vfkit',
      seatbeltProfile: '/opt/vfkit.sb',
      pocDir: root,
      socketDir: sockDir,
      kernelPath: srcKernel,
      initramfsPath: srcKernel,
      rootfsPath: workDisk,
      guestLogPath: join(root, 'guest.log'),
      pidFile: join(root, 'vf.pid'),
      homeDir: join(root, 'home'),
      tmpDir: root,
    });

    let spawnedPid = null;
    try {
      const res = await runHardwareRound({
        contextPath,
        contextSha256,
        launcherDir,
        vaultDir,
        approvedRoots: [root],
        plan,
        backendVersion: 'v0.6.4',
        platform: 'darwin-arm64',
        sourceKernelPath: srcKernel,
        sourceRootfsPath: srcRootfs,
        trustedInputDigest: SHA('a'),
        modelProxy: {
          baseUrl: `http://127.0.0.1:${upPort}`,
          apiKey: REAL_KEY,
          maxRequests: 2,
        },
        launchBackend: async ({ proxyInfo, collectorSocketPath }) => {
          const worker = spawn(
            process.execPath,
            ['-e', 'setTimeout(() => {}, 60000); /* orch-worker */'],
            { stdio: 'ignore' },
          );
          spawnedPid = worker.pid;
          // Exercise model proxy: 1 wrong token (401), 2 valid (200), 1 over budget (429)
          const rWrong = await fetch(`${proxyInfo.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { authorization: 'Bearer wrong' },
            body: '{}',
          });
          expect(rWrong.status).toBe(401);
          for (let i = 0; i < 2; i += 1) {
            const rOk = await fetch(`${proxyInfo.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: { authorization: `Bearer ${proxyInfo.token}` },
              body: '{}',
            });
            expect(rOk.status).toBe(200);
          }
          const rOver = await fetch(`${proxyInfo.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${proxyInfo.token}` },
            body: '{}',
          });
          expect(rOver.status).toBe(429);

          // Deliver complete report + PNG evidence through the live collector UDS
          void sendRoundFiles(
            collectorSocketPath,
            Buffer.concat([
              makeFrame('H', 'report-v1'),
              makeWholeFile('verdict.txt', 'merge-ready\n'),
              makeWholeFile(
                'assertions.json',
                '{"pass":2,"fail":0,"total":2}\n',
              ),
              makeWholeFile(
                'report.md',
                `merge-ready · 2 passed · 0 failed · 2 total · ${HEAD_OID}\n\n## Methodology\n\n**Boundary.** Sandboxed vfkit microVM (hardware-isolated).\n`,
              ),
              makeBinaryFile('evidence/01-ab.png', PNG_BYTES),
              makeFrame('R'),
            ]),
          );
          return {
            workerPid: worker.pid,
            supervisorPid: worker.pid,
            workerExe: process.execPath,
            expectedExeTokens: ['node'],
            child: worker,
          };
        },
      });

      expect(res.ok).toBe(true);
      expect(res.outputStatus).toBe('complete');
      expect(res.teardownStatus).toBe('destroyed');
      expect(res.sourceRootfsUnchanged).toBe(true);
      expect(res.checkExitCode).toBe(0);
      expect(res.modelProxyStats).toEqual({
        acceptedRequests: 2,
        rejectedUnauthorized: 1,
        rejectedRevoked: 0,
        rejectedBudget: 1,
      });
      expect(upstreamCalls).toBe(2);
      expect(inspectPidState(spawnedPid).alive).toBe(false);
      expect(existsSync(workDisk)).toBe(false);
      expect(
        JSON.parse(readFileSync(join(launcherDir, 'token.json'), 'utf8'))
          .revoked,
      ).toBe(true);
      expect(JSON.parse(readFileSync(res.boundaryPath, 'utf8')).mode).toBe(
        'microvm',
      );
    } finally {
      await new Promise((done) => upstream.close(done));
    }
  });

  it('blocks fail-closed on source rootfs mutation, provider disk non-deletion, and contradictory trustClassification before launch', async () => {
    // 1. Contradictory trustClassification refuses before launchBackend is even called
    const r1 = mkdtempSync('/tmp/qc-orch-pre-');
    tmpDirs.push(r1);
    const badCtx = writeHostContext(r1, {
      trustClassification: {
        prTrust: 'external',
        executionClass: 'trusted-shared-kernel',
        escalationReasons: [],
        headRefOid: HEAD_OID,
      },
    });
    let launched = false;
    const preBlocked = await runHardwareRound({
      ...badCtx,
      launcherDir: join(r1, 'l'),
      vaultDir: join(r1, 'v'),
      approvedRoots: [r1],
      plan: buildAliyunProviderPlan({
        runId: 'pv09',
        headRefOid: HEAD_OID,
        region: 'cn-hangzhou',
        zone: 'cn-hangzhou-b',
        vpcId: 'vpc-1',
        vSwitchId: 'vsw-1',
        imageId: 'debian_12.vhd',
      }),
      trustedInputDigest: SHA('b'),
      providerDriver: {
        allocate: async () => {
          launched = true;
          return {};
        },
        destroy: async () => ({ terminated: true, diskDeleted: true }),
      },
    });
    expect(preBlocked.ok).toBe(false);
    expect(launched).toBe(false);
    expect(preBlocked.errors.join('\n')).toMatch(/contradicts itself/);

    // 2. provider-vm deletion gate: diskDeleted:false blocks, diskDeleted:true allows
    for (const [diskDeleted, expectOk] of [
      [false, false],
      [true, true],
    ]) {
      const rp = mkdtempSync('/tmp/qc-orch-pv-');
      tmpDirs.push(rp);
      const ctx = writeHostContext(rp);
      const vault = join(rp, 'vault');
      mkdirSync(join(vault, 'evidence'), { recursive: true });
      writeFileSync(join(vault, 'evidence', '01-pv.png'), PNG_BYTES);
      writeFileSync(join(vault, 'verdict.txt'), 'merge-ready\n');
      writeFileSync(
        join(vault, 'assertions.json'),
        '{"pass":1,"fail":0,"total":1}\n',
      );
      writeFileSync(
        join(vault, 'report.md'),
        `merge-ready · 1 passed · 0 failed · 1 total · ${HEAD_OID}\n\n## Methodology\n\n**Boundary.** Aliyun provider-vm (hardware-isolated).\n`,
      );
      const pvRes = await runHardwareRound({
        ...ctx,
        launcherDir: join(rp, 'launcher'),
        vaultDir: vault,
        approvedRoots: [rp],
        plan: buildAliyunProviderPlan({
          runId: diskDeleted ? 'pvok1' : 'pvno1',
          headRefOid: HEAD_OID,
          region: 'cn-hangzhou',
          zone: 'cn-hangzhou-b',
          vpcId: 'vpc-1',
          vSwitchId: 'vsw-1',
          imageId: 'debian_12.vhd',
        }),
        backendVersion: 'aliyun-ecs-2014-05-26',
        platform: 'aliyun-cn-hangzhou',
        trustedInputDigest: SHA('c'),
        providerDriver: {
          allocate: async () => ({
            allocationId: 'i-bp1test99',
            freshDiskId: 'd-bp1test99',
            outputStatus: 'complete',
          }),
          destroy: async () => ({ terminated: true, diskDeleted }),
        },
      });
      expect(pvRes.ok).toBe(expectOk);
      if (expectOk) {
        expect(pvRes.checkExitCode).toBe(0);
        expect(JSON.parse(readFileSync(pvRes.boundaryPath, 'utf8')).mode).toBe(
          'vm',
        );
      } else {
        expect(pvRes.teardownStatus).toBe('failed');
        expect(pvRes.boundaryPath).toBeNull();
        expect(existsSync(join(vault, 'boundary.json'))).toBe(false);
      }
    }

    // 3. Local VMM source golden rootfs mutation during round forces failure and blocks boundary.json
    const rm = mkdtempSync('/tmp/qc-orch-mut-');
    tmpDirs.push(rm);
    const ctxM = writeHostContext(rm);
    const sockDirM = join(rm, 's');
    mkdirSync(sockDirM, { recursive: true });
    const kM = join(rm, 'k');
    const rM = join(rm, 'golden-r');
    const wM = join(rm, 'work-r');
    writeFileSync(kM, 'k');
    writeFileSync(rM, 'original-golden');
    writeFileSync(wM, 'original-golden');
    const mutRes = await runHardwareRound({
      ...ctxM,
      launcherDir: join(rm, 'l'),
      vaultDir: join(rm, 'v'),
      approvedRoots: [rm],
      plan: buildVfkitLaunchPlan({
        runId: 'mut01',
        vfkitBin: '/opt/vfkit',
        seatbeltProfile: '/opt/sb',
        pocDir: rm,
        socketDir: sockDirM,
        kernelPath: kM,
        initramfsPath: kM,
        rootfsPath: wM,
        guestLogPath: join(rm, 'g.log'),
        pidFile: join(rm, 'p.pid'),
        homeDir: join(rm, 'h'),
        tmpDir: rm,
      }),
      sourceKernelPath: kM,
      sourceRootfsPath: rM,
      trustedInputDigest: SHA('d'),
      launchBackend: async ({ collectorSocketPath }) => {
        const w = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
          stdio: 'ignore',
        });
        // Simulate golden source tampering
        writeFileSync(rM, 'tampered-golden');
        void sendRoundFiles(
          collectorSocketPath,
          Buffer.concat([
            makeFrame('H', 'report-v1'),
            makeWholeFile('verdict.txt', 'merge-ready\n'),
            makeWholeFile('assertions.json', '{"pass":1,"fail":0,"total":1}\n'),
            makeWholeFile(
              'report.md',
              `merge-ready · 1 passed · 0 failed · 1 total · ${HEAD_OID}\n\n## Methodology\n\n**Boundary.** vfkit.\n`,
            ),
            makeBinaryFile('evidence/01-ab.png', PNG_BYTES),
            makeFrame('R'),
          ]),
        );
        return {
          workerPid: w.pid,
          workerExe: process.execPath,
          expectedExeTokens: ['node'],
          child: w,
        };
      },
    });
    expect(mutRes.ok).toBe(false);
    expect(mutRes.sourceRootfsUnchanged).toBe(false);
    expect(mutRes.teardownStatus).toBe('failed');
    expect(mutRes.boundaryPath).toBeNull();
    expect(mutRes.errors).toContain('source-rootfs-digest-mutated');

    // 4. Refuses misconfiguration where working disk aliases sourceRootfsPath (golden protection)
    const aliasRes = await runHardwareRound({
      ...ctxM,
      launcherDir: join(rm, 'l-alias'),
      vaultDir: join(rm, 'v-alias'),
      approvedRoots: [rm],
      plan: buildVfkitLaunchPlan({
        runId: 'ali01',
        vfkitBin: '/opt/vfkit',
        seatbeltProfile: '/opt/sb',
        pocDir: rm,
        socketDir: sockDirM,
        kernelPath: kM,
        initramfsPath: kM,
        rootfsPath: rM,
        guestLogPath: join(rm, 'g2.log'),
        pidFile: join(rm, 'p2.pid'),
        homeDir: join(rm, 'h2'),
        tmpDir: rm,
      }),
      sourceKernelPath: kM,
      sourceRootfsPath: rM,
      trustedInputDigest: SHA('e'),
    });
    expect(aliasRes.ok).toBe(false);
    expect(aliasRes.errors.join('\n')).toMatch(
      /distinct from sourceRootfsPath/,
    );
    expect(existsSync(rM)).toBe(true);

    // 5. Refuses existing modelProxy.socketPath without deleting the pre-existing file
    const existingSock = join(rm, 'preexisting-proxy.sock');
    writeFileSync(existingSock, 'do-not-delete');
    const sockRes = await runHardwareRound({
      ...ctxM,
      launcherDir: join(rm, 'l-sock'),
      vaultDir: join(rm, 'v-sock'),
      approvedRoots: [rm],
      plan: buildVfkitLaunchPlan({
        runId: 'sck01',
        vfkitBin: '/opt/vfkit',
        seatbeltProfile: '/opt/sb',
        pocDir: rm,
        socketDir: sockDirM,
        kernelPath: kM,
        initramfsPath: kM,
        rootfsPath: wM,
        guestLogPath: join(rm, 'g3.log'),
        pidFile: join(rm, 'p3.pid'),
        homeDir: join(rm, 'h3'),
        tmpDir: rm,
      }),
      sourceKernelPath: kM,
      sourceRootfsPath: rM,
      trustedInputDigest: SHA('f'),
      modelProxy: {
        baseUrl: 'http://127.0.0.1:9999',
        apiKey: 'fake',
        socketPath: existingSock,
      },
    });
    expect(sockRes.ok).toBe(false);
    expect(sockRes.errors.join('\n')).toMatch(/refusing existing socket path/);
    expect(existsSync(existingSock)).toBe(true);

    // 6. Missing sourceKernelPath and symlinked launcherDir/token.json fail cleanly without throwing
    const missingKernel = await runHardwareRound({
      ...ctxM,
      launcherDir: join(rm, 'l-mk'),
      vaultDir: join(rm, 'v-mk'),
      approvedRoots: [rm],
      plan: buildVfkitLaunchPlan({
        runId: 'mk01',
        vfkitBin: '/opt/vfkit',
        seatbeltProfile: '/opt/sb',
        pocDir: rm,
        socketDir: sockDirM,
        kernelPath: kM,
        initramfsPath: kM,
        rootfsPath: wM,
        guestLogPath: join(rm, 'g4.log'),
        pidFile: join(rm, 'p4.pid'),
        homeDir: join(rm, 'h4'),
        tmpDir: rm,
      }),
      sourceKernelPath: join(rm, 'does-not-exist-kernel'),
      sourceRootfsPath: rM,
      trustedInputDigest: SHA('1'),
    });
    expect(missingKernel.ok).toBe(false);
    expect(missingKernel.errors.join('\n')).toMatch(
      /sourceKernelPath rejected/,
    );

    const lTokSym = join(rm, 'l-toksym');
    mkdirSync(lTokSym, { recursive: true });
    symlinkSync(join(rm, 'nope'), join(lTokSym, 'token.json'));
    const tokSymRes = await runHardwareRound({
      ...ctxM,
      launcherDir: lTokSym,
      vaultDir: join(rm, 'v-toksym'),
      approvedRoots: [rm],
      plan: buildVfkitLaunchPlan({
        runId: 'ts01',
        vfkitBin: '/opt/vfkit',
        seatbeltProfile: '/opt/sb',
        pocDir: rm,
        socketDir: sockDirM,
        kernelPath: kM,
        initramfsPath: kM,
        rootfsPath: wM,
        guestLogPath: join(rm, 'g5.log'),
        pidFile: join(rm, 'p5.pid'),
        homeDir: join(rm, 'h5'),
        tmpDir: rm,
      }),
      sourceKernelPath: kM,
      sourceRootfsPath: rM,
      trustedInputDigest: SHA('2'),
    });
    expect(tokSymRes.ok).toBe(false);
    expect(tokSymRes.errors.join('\n')).toMatch(/token-file-rejected/);

    // 7. Reap error (unapproved workDiskPath) forces teardownStatus=failed and writes NO boundary.json
    const outsideRoot = mkdtempSync('/tmp/qc-outside-disk-');
    tmpDirs.push(outsideRoot);
    const outsideDisk = join(outsideRoot, 'outside.ext4');
    writeFileSync(outsideDisk, 'original-golden');
    const sockDirR = join(rm, 'sr');
    mkdirSync(sockDirR, { recursive: true });
    const reapFailRes = await runHardwareRound({
      ...ctxM,
      launcherDir: join(rm, 'l-rf'),
      vaultDir: join(rm, 'v-rf'),
      approvedRoots: [rm],
      plan: buildVfkitLaunchPlan({
        runId: 'rf01',
        vfkitBin: '/opt/vfkit',
        seatbeltProfile: '/opt/sb',
        pocDir: rm,
        socketDir: sockDirR,
        kernelPath: kM,
        initramfsPath: kM,
        rootfsPath: outsideDisk,
        guestLogPath: join(rm, 'gr.log'),
        pidFile: join(rm, 'pr.pid'),
        homeDir: join(rm, 'hr'),
        tmpDir: rm,
      }),
      sourceKernelPath: kM,
      sourceRootfsPath: rM,
      trustedInputDigest: SHA('3'),
      launchBackend: async ({ collectorSocketPath }) => {
        const w = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
          stdio: 'ignore',
        });
        void sendRoundFiles(
          collectorSocketPath,
          Buffer.concat([
            makeFrame('H', 'report-v1'),
            makeWholeFile('verdict.txt', 'merge-ready\n'),
            makeWholeFile('assertions.json', '{"pass":1,"fail":0,"total":1}\n'),
            makeWholeFile(
              'report.md',
              `merge-ready · 1 passed · 0 failed · 1 total · ${HEAD_OID}\n\n## Methodology\n\n**Boundary.** vfkit.\n`,
            ),
            makeBinaryFile('evidence/01-ab.png', PNG_BYTES),
            makeFrame('R'),
          ]),
        );
        return {
          workerPid: w.pid,
          workerExe: process.execPath,
          expectedExeTokens: ['node'],
          child: w,
        };
      },
    });
    expect(reapFailRes.ok).toBe(false);
    expect(reapFailRes.teardownStatus).toBe('failed');
    expect(reapFailRes.boundaryPath).toBeNull();
    expect(existsSync(join(rm, 'v-rf', 'boundary.json'))).toBe(false);
    expect(existsSync(outsideDisk)).toBe(true);

    // 8. Pre-flight guards (context inside vault, nested dirs, non-hardware backend) & CLI run usage errors
    const vIn = join(rm, 'v-ctx-inside');
    mkdirSync(vIn, { recursive: true });
    const ctxInside = join(vIn, 'ctx.json');
    const ctxInsideText = readFileSync(ctxM.contextPath, 'utf8');
    writeFileSync(ctxInside, ctxInsideText);
    const inVaultRes = await runHardwareRound({
      contextPath: ctxInside,
      contextSha256: ctxM.contextSha256,
      launcherDir: join(rm, 'l-ctx-inside'),
      vaultDir: vIn,
      plan: buildVfkitLaunchPlan({
        runId: 'ci01',
        vfkitBin: '/opt/vfkit',
        seatbeltProfile: '/opt/sb',
        pocDir: rm,
        socketDir: sockDirM,
        kernelPath: kM,
        initramfsPath: kM,
        rootfsPath: wM,
        guestLogPath: join(rm, 'gci.log'),
        pidFile: join(rm, 'pci.pid'),
        homeDir: join(rm, 'hci'),
        tmpDir: rm,
      }),
      trustedInputDigest: SHA('4'),
    });
    expect(inVaultRes.ok).toBe(false);
    expect(inVaultRes.errors.join('\n')).toMatch(
      /must not reside inside vaultDir/,
    );

    const nestRes = await runHardwareRound({
      ...ctxM,
      launcherDir: rm,
      vaultDir: vIn,
      plan: { backend: 'vfkit' },
      trustedInputDigest: SHA('4'),
    });
    expect(nestRes.ok).toBe(false);
    expect(nestRes.errors.join('\n')).toMatch(/must not overlap/);

    const nonHwRes = await runHardwareRound({
      ...ctxM,
      launcherDir: join(rm, 'l-nhw'),
      vaultDir: join(rm, 'v-nhw'),
      plan: { backend: 'container' },
      trustedInputDigest: SHA('4'),
    });
    expect(nonHwRes.ok).toBe(false);
    expect(nonHwRes.errors.join('\n')).toMatch(/must be a hardware backend/);

    const runCli = (args) =>
      spawnSync(process.execPath, [RUNNER_SCRIPT, ...args], {
        encoding: 'utf8',
      });
    expect(runCli(['run']).status).toBe(2);
    expect(runCli(['run', '--unknown']).status).toBe(2);
    const symCfg = join(rm, 'sym-cfg.json');
    symlinkSync(ctxM.contextPath, symCfg);
    expect(runCli(['run', '--config', symCfg]).status).toBe(1);
    const pvCfg = join(rm, 'pv-cfg.json');
    writeFileSync(pvCfg, JSON.stringify({ backend: 'provider-vm' }));
    expect(runCli(['run', '--config', pvCfg]).status).toBe(2);
  });

  it('supports UDS modelProxy in runHardwareRound and fails fast on missing hostVsockPath, spawn ENOENT, and early worker exit', async () => {
    const root = mkdtempSync('/tmp/qc-orch-uds-');
    tmpDirs.push(root);
    const ctx = writeHostContext(root);
    const kPath = join(root, 'k');
    const rPath = join(root, 'golden-r');
    const wPath = join(root, 'work-r');
    writeFileSync(kPath, 'k');
    writeFileSync(rPath, 'golden-r');
    writeFileSync(wPath, 'golden-r');

    // 1. Missing hostVsockPath and missing argv on local VMM fail closed pre-flight
    const noSock = await runHardwareRound({
      ...ctx,
      launcherDir: join(root, 'l-ns'),
      vaultDir: join(root, 'v-ns'),
      plan: { backend: 'vfkit', runId: 'ns01' },
      sourceKernelPath: kPath,
      sourceRootfsPath: rPath,
      trustedInputDigest: SHA('5'),
    });
    expect(noSock.ok).toBe(false);
    expect(noSock.errors.join('\n')).toMatch(/requires hostVsockPath/);

    const noArgv = await runHardwareRound({
      ...ctx,
      launcherDir: join(root, 'l-na'),
      vaultDir: join(root, 'v-na'),
      plan: {
        backend: 'vfkit',
        runId: 'na01',
        hostVsockPath: join(root, 'c.sock'),
      },
      sourceKernelPath: kPath,
      sourceRootfsPath: rPath,
      trustedInputDigest: SHA('5'),
    });
    expect(noArgv.ok).toBe(false);
    expect(noArgv.errors.join('\n')).toMatch(/requires non-empty argv/);

    // 2. UDS modelProxy end-to-end inside runHardwareRound (cleaned up in finally)
    const upstream = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer real-uds-key') {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const uPort = upstream.address().port;
    const sockDir = join(root, 's');
    mkdirSync(sockDir, { recursive: true });
    const proxySock = join(sockDir, 'proxy.sock');
    const udsReq = (socketPath, path, headers = {}, body = null) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { socketPath, path, method: body ? 'POST' : 'GET', headers },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                text: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });

    let udsHealth = null;
    let udsUnauth = null;
    let udsOk = null;
    try {
      const udsRes = await runHardwareRound({
        ...ctx,
        launcherDir: join(root, 'l-uds'),
        vaultDir: join(root, 'v-uds'),
        approvedRoots: [root],
        plan: buildVfkitLaunchPlan({
          runId: 'uds01',
          vfkitBin: '/opt/vfkit',
          seatbeltProfile: '/opt/sb',
          pocDir: root,
          socketDir: sockDir,
          kernelPath: kPath,
          initramfsPath: kPath,
          rootfsPath: wPath,
          guestLogPath: join(root, 'g.log'),
          pidFile: join(root, 'p.pid'),
          homeDir: join(root, 'h'),
          tmpDir: root,
        }),
        sourceKernelPath: kPath,
        sourceRootfsPath: rPath,
        trustedInputDigest: SHA('6'),
        modelProxy: {
          baseUrl: `http://127.0.0.1:${uPort}/v1`,
          apiKey: 'real-uds-key',
          socketPath: proxySock,
          maxRequests: 2,
        },
        launchBackend: async ({ proxyInfo, collectorSocketPath }) => {
          const w = spawn(
            process.execPath,
            ['-e', 'setTimeout(()=>{},60000)'],
            { stdio: 'ignore' },
          );
          udsHealth = await udsReq(proxyInfo.socketPath, '/__health');
          udsUnauth = await udsReq(
            proxyInfo.socketPath,
            '/v1/chat/completions',
            { authorization: 'Bearer wrong' },
            '{}',
          );
          udsOk = await udsReq(
            proxyInfo.socketPath,
            '/v1/chat/completions',
            { authorization: `Bearer ${proxyInfo.token}` },
            '{"messages":[]}',
          );
          void sendRoundFiles(
            collectorSocketPath,
            Buffer.concat([
              makeFrame('H', 'report-v1'),
              makeWholeFile('verdict.txt', 'merge-ready\n'),
              makeWholeFile(
                'assertions.json',
                '{"pass":1,"fail":0,"total":1}\n',
              ),
              makeWholeFile(
                'report.md',
                `merge-ready · 1 passed · 0 failed · 1 total · ${HEAD_OID}\n\n## Methodology\n\n**Boundary.** vfkit.\n`,
              ),
              makeBinaryFile('evidence/01-ab.png', PNG_BYTES),
              makeFrame('R'),
            ]),
          );
          return {
            workerPid: w.pid,
            workerExe: process.execPath,
            expectedExeTokens: ['node'],
            child: w,
          };
        },
      });
      expect(udsRes.errors).toEqual([]);
      expect(udsRes.ok).toBe(true);
      expect(udsHealth.status).toBe(200);
      expect(udsUnauth.status).toBe(401);
      expect(udsOk.status).toBe(200);
      expect(udsRes.modelProxyStats).toEqual({
        acceptedRequests: 1,
        rejectedUnauthorized: 1,
        rejectedRevoked: 0,
        rejectedBudget: 0,
      });
      expect(existsSync(proxySock)).toBe(false);
    } finally {
      upstream.close();
    }

    // 3. Default spawn ENOENT fails cleanly without unhandled error and revokes token.json
    const wEnoent = join(root, 'work-enoent');
    writeFileSync(wEnoent, 'golden-r');
    const sockEnoent = join(root, 's-en');
    mkdirSync(sockEnoent, { recursive: true });
    const lEnoent = join(root, 'l-en');
    const enoentRes = await runHardwareRound({
      ...ctx,
      launcherDir: lEnoent,
      vaultDir: join(root, 'v-en'),
      approvedRoots: [root],
      plan: {
        ...buildVfkitLaunchPlan({
          runId: 'en01',
          vfkitBin: '/opt/vfkit',
          seatbeltProfile: '/opt/sb',
          pocDir: root,
          socketDir: sockEnoent,
          kernelPath: kPath,
          initramfsPath: kPath,
          rootfsPath: wEnoent,
          guestLogPath: join(root, 'gen.log'),
          pidFile: join(root, 'pen.pid'),
          homeDir: join(root, 'hen'),
          tmpDir: root,
        }),
        argv: ['/nonexistent/verify-pr-vmm-binary'],
      },
      sourceKernelPath: kPath,
      sourceRootfsPath: rPath,
      trustedInputDigest: SHA('7'),
    });
    expect(enoentRes.ok).toBe(false);
    expect(enoentRes.boundaryPath).toBeNull();
    expect(enoentRes.errors.join('\n')).toMatch(/ENOENT/);
    expect(
      JSON.parse(readFileSync(join(lEnoent, 'token.json'), 'utf8')).revoked,
    ).toBe(true);

    // 4. Default spawn early worker exit fails fast instead of waiting out acceptDeadlineMs
    const wEarly = join(root, 'work-early');
    writeFileSync(wEarly, 'golden-r');
    const sockEarly = join(root, 's-ea');
    mkdirSync(sockEarly, { recursive: true });
    const t0 = Date.now();
    const earlyRes = await runHardwareRound({
      ...ctx,
      launcherDir: join(root, 'l-ea'),
      vaultDir: join(root, 'v-ea'),
      approvedRoots: [root],
      plan: {
        ...buildVfkitLaunchPlan({
          runId: 'ea01',
          vfkitBin: '/opt/vfkit',
          seatbeltProfile: '/opt/sb',
          pocDir: root,
          socketDir: sockEarly,
          kernelPath: kPath,
          initramfsPath: kPath,
          rootfsPath: wEarly,
          guestLogPath: join(root, 'gea.log'),
          pidFile: join(root, 'pea.pid'),
          homeDir: join(root, 'hea'),
          tmpDir: root,
        }),
        argv: [process.execPath, '-e', 'process.exit(1)'],
      },
      sourceKernelPath: kPath,
      sourceRootfsPath: rPath,
      trustedInputDigest: SHA('8'),
      collectorOptions: { acceptDeadlineMs: 30_000 },
    });
    const elapsedMs = Date.now() - t0;
    expect(earlyRes.ok).toBe(false);
    expect(earlyRes.boundaryPath).toBeNull();
    expect(earlyRes.errors).toContain('worker-exited-before-collector-done');
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
