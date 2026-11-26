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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildExecutionRecord,
  inspectPidState,
  isPathWithinApprovedRoots,
  reapOwnership,
  resolveFirecrackerWorkerPid,
  writeExecutionRecordAndBoundary,
  writeOwnershipRecord,
} from '../../scripts/verify-pr-vm-lifecycle.mjs';
import { reapedPid } from './reaped-pid.js';

const LIFECYCLE_SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-vm-lifecycle.mjs', import.meta.url),
);
const CHECK_SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-check.mjs', import.meta.url),
);

const BASE_OID = 'a'.repeat(40);
const HEAD_OID = 'b'.repeat(40);
const SHA = (ch) => ch.repeat(64);
const sha256 = (text) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

let tmpDirs = [];
let children = [];

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  children = [];
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function makeTmpDir(prefix = 'verify-pr-vm-lc-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function spawnSleeper(tag) {
  const child = spawn(
    process.execPath,
    ['-e', `setTimeout(() => {}, 60000); /* ${tag} */`],
    { stdio: 'ignore' },
  );
  children.push(child);
  return child;
}

function makePrepareSnapshot(overrides = {}) {
  return {
    repo: 'QwenLM/qwen-code',
    number: 18099,
    title: 'External PR fixture',
    baseRefOid: BASE_OID,
    headRefOid: HEAD_OID,
    trustClassification: {
      prTrust: 'external',
      executionClass: 'hardware-isolated',
      escalationReasons: [],
      sponsored: false,
      headRefOid: HEAD_OID,
    },
    ...overrides,
  };
}

function makeFirecrackerMeta(overrides = {}) {
  return {
    runId: 'fc-lc-01',
    backend: 'firecracker',
    backendVersion: 'v1.18.0',
    platform: 'linux-aarch64',
    startedAt: '2026-11-23T12:00:00Z',
    endedAt: '2026-11-23T12:00:05Z',
    destroyedAt: '2026-11-23T12:00:06Z',
    outputStatus: 'complete',
    teardownStatus: 'destroyed',
    diskDestroyed: true,
    tokenRevoked: true,
    trustedInputDigest: SHA('1'),
    launchPolicyDigest: SHA('2'),
    kernelDigest: SHA('3'),
    rootfsDigest: SHA('4'),
    supervisorPid: reapedPid(),
    workerPid: reapedPid(),
    workerExe: '/firecracker-v1.18.0-aarch64',
    workerExitEvidence: 'absent',
    ...overrides,
  };
}

describe('verify-pr-vm-lifecycle reap', () => {
  it('reaps only verified target PID, removes approved disk/socket, revokes token, preserves innocent canary, and stays idempotent', () => {
    const root = makeTmpDir();
    const target = spawnSleeper('target-vmm-worker');
    const canary = spawnSleeper('innocent-canary-proc');

    const disk = join(root, 'rootfs.ext4');
    const sockDir = join(root, 'sockdir');
    const sock = join(sockDir, 'v.sock');
    const tokenFile = join(root, 'token.json');
    const ownership = join(root, 'ownership.json');

    mkdirSync(sockDir, { recursive: true });
    writeFileSync(disk, 'working-copy');
    writeFileSync(sock, 'sock-placeholder');
    writeFileSync(tokenFile, JSON.stringify({ token: 'fake', revoked: false }));
    writeOwnershipRecord(ownership, {
      runId: 'reap-1',
      backend: 'firecracker',
      worker: { pid: target.pid, expectedExeTokens: ['node'] },
      workDiskPath: disk,
      socketPaths: [sock],
      socketDir: sockDir,
      tokenFile,
    });

    const first = reapOwnership(ownership, { approvedRoots: [root] });
    expect(first.status).toBe('reaped');
    expect(first.errors).toEqual([]);
    expect(['terminated', 'killed']).toContain(first.processes[0].action);
    expect(inspectPidState(target.pid).alive).toBe(false);
    expect(inspectPidState(canary.pid).alive).toBe(true);
    expect(existsSync(disk)).toBe(false);
    expect(existsSync(sock)).toBe(false);
    expect(existsSync(sockDir)).toBe(false);
    expect(JSON.parse(readFileSync(tokenFile, 'utf8')).revoked).toBe(true);

    // Second invocation via CLI is also idempotent and exits 0
    const cliReap = spawnSync(
      process.execPath,
      [
        LIFECYCLE_SCRIPT,
        'reap',
        '--ownership',
        ownership,
        '--approved-root',
        root,
      ],
      { encoding: 'utf8' },
    );
    expect(cliReap.status).toBe(0);
    const second = JSON.parse(cliReap.stdout);
    expect(second.status).toBe('reaped');
    expect(second.processes[0].action).toBe('already-absent');
    expect(second.token.action).toBe('already-revoked');
    expect(inspectPidState(canary.pid).alive).toBe(true);
  });

  it('refuses to kill a PID whose executable identity does not match', () => {
    const root = makeTmpDir();
    const innocent = spawnSleeper('wrong-identity-target');
    const ownership = join(root, 'ownership.json');
    writeOwnershipRecord(ownership, {
      runId: 'reap-mismatch',
      backend: 'firecracker',
      worker: {
        pid: innocent.pid,
        expectedExeTokens: ['firecracker-v1.18.0-aarch64'],
      },
    });
    const rep = reapOwnership(ownership, { approvedRoots: [root] });
    expect(rep.status).toBe('failed');
    expect(rep.errors.join('\n')).toMatch(/pid-identity-mismatch:worker:/);
    expect(inspectPidState(innocent.pid).alive).toBe(true);

    // Self-PID protection
    const selfOwn = join(root, 'ownership-self.json');
    writeOwnershipRecord(selfOwn, {
      runId: 'reap-self',
      backend: 'firecracker',
      worker: { pid: process.pid, expectedExeTokens: ['node'] },
    });
    const selfRep = reapOwnership(selfOwn, { approvedRoots: [root] });
    expect(selfRep.status).toBe('failed');
    expect(selfRep.errors.join('\n')).toMatch(/refusing-self-pid:worker:/);
  });

  it('checks process identity before signaling an owned process group', () => {
    const root = makeTmpDir('verify-pr-group-identity-');
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)'],
      { detached: true, stdio: 'ignore' },
    );
    children.push(child);
    const ownership = join(root, 'ownership.json');
    writeOwnershipRecord(ownership, {
      runId: 'wrong-group-id',
      backend: 'firecracker',
      worker: {
        pid: child.pid,
        processGroupId: child.pid,
        expectedExeTokens: ['wrong-vmm-identity'],
      },
    });
    const report = reapOwnership(ownership, { approvedRoots: [root] });
    expect(report.status).toBe('failed');
    expect(report.errors.join('\n')).toMatch(/pid-identity-mismatch/);
    expect(inspectPidState(child.pid).alive).toBe(true);
  });

  it('refuses paths outside approved roots, filesystem root approvals, and symlink token files', () => {
    const root = makeTmpDir();
    const outside = makeTmpDir('verify-pr-vm-outside-');
    const secret = join(outside, 'host-secret.txt');
    writeFileSync(secret, 'do-not-delete');

    expect(isPathWithinApprovedRoots(secret, [root])).toBe(false);
    expect(isPathWithinApprovedRoots(secret, ['/'])).toBe(false);

    const tokenSym = join(root, 'token-link.json');
    symlinkSync(secret, tokenSym);
    const ownership = join(root, 'ownership.json');
    writeOwnershipRecord(ownership, {
      runId: 'reap-unapproved',
      backend: 'vfkit',
      workDiskPath: secret,
      tokenFile: tokenSym,
    });
    const rep = reapOwnership(ownership, { approvedRoots: [root] });
    expect(rep.status).toBe('failed');
    expect(rep.errors.join('\n')).toMatch(/unapproved-path:work-disk:/);
    expect(rep.errors.join('\n')).toMatch(/invalid-token-file:/);
    expect(existsSync(secret)).toBe(true);
  });

  it('reaps an owned process group including a child with no recorded worker PID', async () => {
    const root = makeTmpDir('verify-pr-owned-group-');
    const supervisor = spawn(
      process.execPath,
      [
        '-e',
        "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});process.stdout.write(`${child.pid}\\n`);setTimeout(()=>{},60000)",
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.push(supervisor);
    let grandchildPid = null;
    try {
      grandchildPid = await new Promise((resolve) => {
        supervisor.stdout.once('data', (chunk) =>
          resolve(Number(chunk.toString('utf8').trim())),
        );
      });
      expect(Number.isInteger(grandchildPid)).toBe(true);
      const ownership = join(root, 'ownership.json');
      writeOwnershipRecord(ownership, {
        runId: 'owned-group',
        backend: 'firecracker',
        worker: {
          pid: supervisor.pid,
          processGroupId: supervisor.pid,
          expectedExeTokens: ['node'],
        },
      });
      const report = reapOwnership(ownership, {
        approvedRoots: [root],
        graceMs: 100,
      });
      expect(report.errors).toEqual([]);
      expect(report.status).toBe('reaped');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(inspectPidState(supervisor.pid).alive).toBe(false);
      expect(inspectPidState(grandchildPid).alive).toBe(false);
    } finally {
      for (const pid of [supervisor.pid, grandchildPid]) {
        if (inspectPidState(pid).alive) process.kill(pid, 'SIGKILL');
      }
    }
  });

  it('recovers a Firecracker worker PID from /proc entries and fails closed on ambiguity or unreadable procRoot', () => {
    const procRoot = makeTmpDir('verify-pr-proc-');
    const plantProc = (pid, { exe, uid, state = 'S (sleeping)', argv }) => {
      const dir = join(procRoot, String(pid));
      mkdirSync(dir, { recursive: true });
      symlinkSync(exe, join(dir, 'exe'));
      writeFileSync(
        join(dir, 'status'),
        `Name:\tfirecracker\nState:\t${state}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
      );
      writeFileSync(join(dir, 'cmdline'), `${argv.join('\0')}\0`);
    };

    const baseRec = {
      runId: 'fc-rec-1',
      backend: 'firecracker',
      vmmUid: 65534,
      worker: { expectedExeTokens: ['firecracker-v1.18.0-aarch64'] },
    };

    // 0 candidates: zombie, wrong UID, missing --id, self PID are all ignored
    plantProc(4001, {
      exe: '/firecracker-v1.18.0-aarch64',
      uid: 65534,
      state: 'Z (zombie)',
      argv: ['/firecracker-v1.18.0-aarch64', '--id', 'fc-rec-1'],
    });
    plantProc(4002, {
      exe: '/firecracker-v1.18.0-aarch64',
      uid: 1000,
      argv: ['/firecracker-v1.18.0-aarch64', '--id', 'fc-rec-1'],
    });
    plantProc(4003, {
      exe: '/firecracker-v1.18.0-aarch64',
      uid: 65534,
      argv: ['/firecracker-v1.18.0-aarch64', '--id', 'other-run'],
    });
    plantProc(process.pid, {
      exe: '/firecracker-v1.18.0-aarch64',
      uid: 65534,
      argv: ['/firecracker-v1.18.0-aarch64', '--id', 'fc-rec-1'],
    });
    expect(
      resolveFirecrackerWorkerPid(baseRec, { procRoot, platform: 'linux' }),
    ).toEqual({ pid: null, error: null });

    // Non-Linux skips /proc scan
    plantProc(4010, {
      exe: '/firecracker-v1.18.0-aarch64',
      uid: 65534,
      argv: ['/firecracker-v1.18.0-aarch64', '--id', 'fc-rec-1'],
    });
    expect(
      resolveFirecrackerWorkerPid(baseRec, { procRoot, platform: 'darwin' }),
    ).toEqual({ pid: null, error: null });

    // Exact 1 match succeeds (even when token comes only from worker.expectedExeTokens)
    expect(
      resolveFirecrackerWorkerPid(baseRec, { procRoot, platform: 'linux' }),
    ).toEqual({ pid: 4010, error: null });

    // 2 matching candidates fail closed with ambiguity error
    plantProc(4011, {
      exe: '/firecracker-v1.18.0-aarch64',
      uid: 65534,
      argv: ['/firecracker-v1.18.0-aarch64', '--id', 'fc-rec-1'],
    });
    expect(
      resolveFirecrackerWorkerPid(baseRec, { procRoot, platform: 'linux' }),
    ).toEqual({
      pid: null,
      error: 'firecracker-worker-recovery-ambiguous:fc-rec-1',
    });

    // Unreadable/missing procRoot reports enumeration error
    const enumErr = resolveFirecrackerWorkerPid(baseRec, {
      procRoot: join(procRoot, 'missing-proc'),
      platform: 'linux',
    });
    expect(enumErr.pid).toBeNull();
    expect(enumErr.error).toMatch(/^firecracker-proc-enumeration:/);
  });

  it.skipIf(process.platform !== 'linux')(
    'reaps a live worker via real Linux /proc recovery, kills both live supervisor and recovered worker, and refuses ambiguous matches',
    async () => {
      const root = makeTmpDir('verify-pr-linux-proc-');
      const hostUid = process.getuid();
      const targetUid = hostUid === 0 ? 65534 : hostUid;
      const targetGid = hostUid === 0 ? 65534 : process.getgid();
      const spawnOpts = hostUid === 0 ? { uid: targetUid, gid: targetGid } : {};
      const exeName = process.execPath.split('/').pop();
      const spawnTagged = async (runId) => {
        const c = spawn(
          process.execPath,
          [
            '-e',
            'process.stdout.write("R");setTimeout(()=>{},60000)',
            '--',
            '--id',
            runId,
          ],
          { ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        children.push(c);
        let stderr = '';
        c.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
        await new Promise((resolve, reject) => {
          c.stdout.once('data', resolve);
          c.once('error', reject);
          c.once('exit', (code) =>
            reject(new Error(`tagged worker exited ${code}: ${stderr}`)),
          );
        });
        return c;
      };

      // 1. Dead recorded PID + 1 live matching worker -> recovered & reaped
      const w1 = await spawnTagged('fc-live-1');
      const own1 = join(root, 'own1.json');
      writeOwnershipRecord(own1, {
        runId: 'fc-live-1',
        backend: 'firecracker',
        vmmUid: targetUid,
        expectedExeTokens: [exeName],
        worker: { pid: reapedPid(), expectedExeTokens: [exeName] },
      });
      const rep1 = reapOwnership(own1, { approvedRoots: [root], graceMs: 100 });
      expect(rep1.errors).toEqual([]);
      expect(rep1.status).toBe('reaped');
      expect(rep1.resolvedWorkerPid).toBe(w1.pid);
      expect(inspectPidState(w1.pid).alive).toBe(false);

      // 2. Live supervisor + separate live matching worker -> both killed
      const sup2 = spawnSleeper('sup2');
      const w2 = await spawnTagged('fc-live-2');
      const own2 = join(root, 'own2.json');
      writeOwnershipRecord(own2, {
        runId: 'fc-live-2',
        backend: 'firecracker',
        vmmUid: targetUid,
        expectedExeTokens: [exeName],
        worker: { pid: sup2.pid, expectedExeTokens: [exeName] },
      });
      const rep2 = reapOwnership(own2, { approvedRoots: [root], graceMs: 100 });
      expect(rep2.errors).toEqual([]);
      expect(rep2.status).toBe('reaped');
      expect(rep2.resolvedWorkerPid).toBe(w2.pid);
      expect(inspectPidState(sup2.pid).alive).toBe(false);
      expect(inspectPidState(w2.pid).alive).toBe(false);

      // 3. 2 matching live workers -> fail closed ambiguous, neither killed
      const a1 = await spawnTagged('fc-ambig-3');
      const a2 = await spawnTagged('fc-ambig-3');
      const own3 = join(root, 'own3.json');
      writeOwnershipRecord(own3, {
        runId: 'fc-ambig-3',
        backend: 'firecracker',
        vmmUid: targetUid,
        expectedExeTokens: [exeName],
        worker: { pid: reapedPid(), expectedExeTokens: [exeName] },
      });
      const rep3 = reapOwnership(own3, { approvedRoots: [root], graceMs: 100 });
      expect(rep3.status).toBe('failed');
      expect(rep3.errors).toContain(
        'firecracker-worker-recovery-ambiguous:fc-ambig-3',
      );
      expect(inspectPidState(a1.pid).alive).toBe(true);
      expect(inspectPidState(a2.pid).alive).toBe(true);

      // 4. 0 matching workers (wrong --id) -> no kill, resolvedWorkerPid null
      const other = await spawnTagged('fc-other-4');
      const own4 = join(root, 'own4.json');
      writeOwnershipRecord(own4, {
        runId: 'fc-none-4',
        backend: 'firecracker',
        vmmUid: targetUid,
        expectedExeTokens: [exeName],
        worker: { pid: reapedPid(), expectedExeTokens: [exeName] },
      });
      const rep4 = reapOwnership(own4, { approvedRoots: [root], graceMs: 100 });
      expect(rep4.status).toBe('reaped');
      expect(rep4.resolvedWorkerPid).toBeNull();
      expect(inspectPidState(other.pid).alive).toBe(true);
    },
  );
});

describe('verify-pr-vm-lifecycle finalize -> verify-pr-check end-to-end', () => {
  it('writes execution-record.json and boundary.json for microvm and provider-vm rounds that pass verify-pr-check.mjs', () => {
    for (const [label, metaOverride, expectedMode, prose] of [
      [
        'firecracker',
        {},
        'microvm',
        'Firecracker microVM (hardware-isolated).',
      ],
      [
        'provider-vm',
        {
          backend: 'provider-vm',
          backendVersion: 'aliyun-ecs-2014-05-26',
          platform: 'aliyun-cn-hangzhou',
          providerLifecycle: {
            allocationId: 'i-bp1prod001',
            freshDiskId: 'd-bp1prod001',
            boundRunId: 'fc-lc-01',
            boundHeadRefOid: HEAD_OID,
            terminationState: 'terminated',
            diskDeleted: true,
          },
        },
        'vm',
        'Disposable Aliyun provider-vm (hardware-isolated).',
      ],
    ]) {
      const root = makeTmpDir(`verify-pr-e2e-${label}-`);
      const launcherDir = join(root, 'launcher');
      const artifactDir = join(root, 'artifact');
      mkdirSync(join(artifactDir, 'evidence'), { recursive: true });
      writeFileSync(join(artifactDir, 'evidence', '01-ab.png'), 'png');
      writeFileSync(
        join(artifactDir, 'report.md'),
        `merge-ready · 2 passed · 0 failed · 2 total · ${HEAD_OID}\n\n## Methodology\n\n**Boundary.** ${prose}\n`,
      );
      writeFileSync(join(artifactDir, 'verdict.txt'), 'merge-ready\n');
      writeFileSync(
        join(artifactDir, 'assertions.json'),
        JSON.stringify({ pass: 2, fail: 0, total: 2 }),
      );

      const snapPath = join(root, 'host-context.json');
      const snapText = `${JSON.stringify(makePrepareSnapshot(), null, 2)}\n`;
      writeFileSync(snapPath, snapText);
      const snapSha = sha256(snapText);

      const metaPath = join(root, 'meta.json');
      writeFileSync(
        metaPath,
        `${JSON.stringify(makeFirecrackerMeta(metaOverride), null, 2)}\n`,
      );

      const fin = spawnSync(
        process.execPath,
        [
          LIFECYCLE_SCRIPT,
          'finalize',
          '--context',
          snapPath,
          '--context-sha256',
          snapSha,
          '--launcher-dir',
          launcherDir,
          '--artifact-dir',
          artifactDir,
          '--meta',
          metaPath,
        ],
        { encoding: 'utf8' },
      );
      expect(fin.status, fin.stderr).toBe(0);
      const finOut = JSON.parse(fin.stdout);
      expect(finOut.ok).toBe(true);
      expect(finOut.boundary.mode).toBe(expectedMode);
      expect(existsSync(join(artifactDir, 'boundary.json'))).toBe(true);

      // Feed directly into production verify-pr-check.mjs
      const chk = spawnSync(
        process.execPath,
        [
          CHECK_SCRIPT,
          '--context',
          snapPath,
          '--context-sha256',
          snapSha,
          '--execution-record',
          finOut.executionRecordPath,
          '--execution-record-sha256',
          finOut.executionRecordSha256,
          artifactDir,
        ],
        { encoding: 'utf8' },
      );
      expect(chk.status, chk.stderr).toBe(0);
      expect(chk.stdout).toMatch(/ok: verdict=merge-ready/);
    }
  });

  it('blocks fail-closed and writes no boundary.json when a live worker PID is still running even if metadata claims destroyed', () => {
    const root = makeTmpDir('verify-pr-live-block-');
    const launcherDir = join(root, 'launcher');
    const artifactDir = join(root, 'artifact');
    const liveWorker = spawnSleeper('still-running-vmm');

    const snap = makePrepareSnapshot();
    const snapText = JSON.stringify(snap);
    const rec = buildExecutionRecord({
      contextSnapshot: snap,
      contextSha256: sha256(snapText),
      ...makeFirecrackerMeta({
        workerPid: liveWorker.pid,
        teardownStatus: 'destroyed',
        workerExitEvidence: 'absent',
      }),
    });

    const out = writeExecutionRecordAndBoundary({
      record: rec,
      launcherDir,
      artifactDir,
      verifyLivePid: true,
    });
    expect(out.ok).toBe(false);
    expect(out.boundaryPath).toBeNull();
    expect(existsSync(join(artifactDir, 'boundary.json'))).toBe(false);
    expect(out.errors.join('\n')).toMatch(
      new RegExp(`worker-still-alive:${liveWorker.pid}`),
    );
    const persisted = JSON.parse(readFileSync(out.executionRecordPath, 'utf8'));
    expect(persisted.teardownStatus).toBe('running');
    expect(persisted.workerExitEvidence).toBe('alive');
  });

  it('refuses stale trustClassification headRefOid, incomplete outputStatus, and overlapping launcherDir/artifactDir', () => {
    const staleSnap = makePrepareSnapshot({
      trustClassification: {
        prTrust: 'collaborator',
        executionClass: 'trusted-shared-kernel',
        escalationReasons: [],
        headRefOid: 'c'.repeat(40),
      },
    });
    expect(() =>
      buildExecutionRecord({
        contextSnapshot: staleSnap,
        contextSha256: SHA('9'),
        ...makeFirecrackerMeta(),
      }),
    ).toThrow(/stale trustClassification headRefOid/);

    const root = makeTmpDir('verify-pr-fail-closed-');
    const artifactDir = join(root, 'artifact');
    const launcherInsideArtifact = join(artifactDir, 'launcher');
    const rec = buildExecutionRecord({
      contextSnapshot: makePrepareSnapshot(),
      contextSha256: SHA('9'),
      ...makeFirecrackerMeta({ outputStatus: 'truncated' }),
    });

    const overlap = writeExecutionRecordAndBoundary({
      record: rec,
      launcherDir: launcherInsideArtifact,
      artifactDir,
      verifyLivePid: false,
    });
    expect(overlap.ok).toBe(false);
    expect(overlap.errors.join('\n')).toMatch(/must not overlap/);

    const reverseOverlap = writeExecutionRecordAndBoundary({
      record: rec,
      launcherDir: root,
      artifactDir,
      verifyLivePid: false,
    });
    expect(reverseOverlap.ok).toBe(false);
    expect(reverseOverlap.errors.join('\n')).toMatch(/must not overlap/);

    // Guest-planted symlink at artifactDir/boundary.json must fail cleanly without throwing
    const symArtifact = join(root, 'sym-artifact');
    mkdirSync(symArtifact, { recursive: true });
    symlinkSync(join(root, 'nonexistent'), join(symArtifact, 'boundary.json'));
    const validRec = buildExecutionRecord({
      contextSnapshot: makePrepareSnapshot(),
      contextSha256: SHA('9'),
      ...makeFirecrackerMeta(),
    });
    const symOut = writeExecutionRecordAndBoundary({
      record: validRec,
      launcherDir: join(root, 'launcher-sym'),
      artifactDir: symArtifact,
      verifyLivePid: false,
    });
    expect(symOut.ok).toBe(false);
    expect(symOut.errors.join('\n')).toMatch(/boundary-write-refused/);

    const trunc = writeExecutionRecordAndBoundary({
      record: rec,
      launcherDir: join(root, 'launcher'),
      artifactDir,
      verifyLivePid: false,
    });
    expect(trunc.ok).toBe(false);
    expect(trunc.errors.join('\n')).toMatch(/outputStatus must be "complete"/);
    expect(existsSync(join(artifactDir, 'boundary.json'))).toBe(false);
  });
});
