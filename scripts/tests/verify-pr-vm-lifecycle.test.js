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
  writeExecutionRecordAndBoundary,
  writeOwnershipRecord,
} from '../../scripts/verify-pr-vm-lifecycle.mjs';

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
    supervisorPid: 999901,
    workerPid: 999902,
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
      expect(fin.status).toBe(0);
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
      expect(chk.status).toBe(0);
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
