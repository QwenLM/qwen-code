/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ReviewBackendProbe } from './sandbox-backends.js';

const IS_WINDOWS = process.platform === 'win32';

const probeOverride = vi.hoisted(() => ({
  current: null as ReviewBackendProbe | null,
}));

vi.mock('./sandbox-backends.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sandbox-backends.js')>();
  return {
    ...actual,
    selectReviewSandboxBackend: (
      opts: Parameters<typeof actual.selectReviewSandboxBackend>[0],
    ) =>
      actual.selectReviewSandboxBackend({
        ...opts,
        hostProbe: opts.hostProbe ?? probeOverride.current ?? undefined,
      }),
  };
});

import { isolateOperatorReviewSettings } from './test-utils.js';
import { runBuildTest } from '../build-test.js';
import { runTestDelta } from '../test-delta.js';
import { runControlMutant } from '../test-efficacy.js';
import { closeGuestSessionSync } from './guest-exec-bridge.js';

const SESSION_GUEST_AGENT_SCRIPT = `
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

const [socketPath, scratchBase, mode] = process.argv.slice(1);
const enc = (kind, payload) => {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const h = Buffer.allocUnsafe(5);
  h[0] = kind.charCodeAt(0);
  h.writeUInt32BE(body.length, 1);
  return Buffer.concat([h, body]);
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

const server = createServer((sock) => {
  let buf = Buffer.alloc(0);
  let curFile = null;
  let fileChunks = [];
  const uploadedFiles = [];

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const kind = String.fromCharCode(buf[0]);
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) break;
      const payload = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);

      if (kind === 'H') {
        sock.write(enc('A', payload.toString('utf8')));
      } else if (kind === 'F') {
        curFile = JSON.parse(payload.toString('utf8'));
        fileChunks = [];
      } else if (kind === 'D') {
        fileChunks.push(Buffer.from(payload));
      } else if (kind === 'V') {
        const expected = payload.toString('utf8');
        const content = Buffer.concat(fileChunks);
        if (!curFile || sha(content) !== expected) {
          sock.write(enc('R', 'file digest mismatch'));
          sock.end();
          return;
        }
        uploadedFiles.push({ path: curFile.path, content });
        curFile = null;
        fileChunks = [];
      } else if (kind === 'C') {
        const closeRequest = JSON.parse(payload.toString('utf8'));
        const sid = closeRequest.workspaceSessionId;
        if (mode === 'close-refuse') {
          // Accept exec, refuse cleanup: the session survives and the client
          // must surface WHY in executionBoundary.note.
          sock.write(enc('R', 'cleanup refused by peer'));
          sock.end();
          return;
        }
        rmSync(join(scratchBase, 'session-' + sid), { recursive: true, force: true });
        sock.write(enc('Z', JSON.stringify({
          runId: closeRequest.runId,
          workspaceSessionId: sid,
          sessionSha256: sha(sid),
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutSha256: sha(Buffer.alloc(0)),
          stderrSha256: sha(Buffer.alloc(0)),
        })));
        sock.end();
        return;
      } else if (kind === 'X') {
        const req = JSON.parse(payload.toString('utf8'));
        const isSession = typeof req.workspaceSessionId === 'string' && req.workspaceSessionId.length > 0;
        const guestDir = isSession
          ? join(scratchBase, 'session-' + req.workspaceSessionId)
          : mkdtempSync(join(scratchBase, 'guest-'));
        const cleanup = () => {
          if (!isSession) rmSync(guestDir, { recursive: true, force: true });
        };

        if (isSession) {
          const wsMode = req.workspaceMode || 'replace';
          if (wsMode === 'replace') {
            rmSync(guestDir, { recursive: true, force: true });
            mkdirSync(guestDir, { recursive: true });
          } else if (!existsSync(guestDir)) {
            mkdirSync(guestDir, { recursive: true });
          }
        }
        if (req.workspaceMode !== 'reuse') {
          for (const f of uploadedFiles) {
            const dest = join(guestDir, f.path);
            mkdirSync(dirname(dest), { recursive: true });
            writeFileSync(dest, f.content);
          }
        }

        // Optional fault-injection mode: install exits 0 but omits the completeness marker.
        const cmdToRun =
          mode === 'fake-install-no-marker' && req.kind === 'install'
            ? 'mkdir -p node_modules && echo FAKE_INSTALL_NO_MARKER'
            : mode === 'install-exit-1' && req.kind === 'install'
              ? 'exit 1'
              : req.command;
        try {
          appendFileSync(
            join(scratchBase, 'requests.ndjson'),
            JSON.stringify({
              command: req.command,
              kind: req.kind,
              workspaceMode: req.workspaceMode,
              workspaceSessionId: req.workspaceSessionId,
            }) + String.fromCharCode(10),
          );
        } catch {}

        const child = spawn('/bin/sh', ['-c', cmdToRun], {
          cwd: join(guestDir, req.workdir || '.'),
          env: { PATH: process.env.PATH || '/usr/bin:/bin', ...req.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const outParts = [];
        const errParts = [];
        const writeChunked = (k, b) => {
          for (let off = 0; off < b.length; off += 65536) {
            sock.write(enc(k, b.subarray(off, Math.min(off + 65536, b.length))));
          }
        };
        child.stdout.on('data', (d) => { outParts.push(d); writeChunked('O', d); });
        child.stderr.on('data', (d) => { errParts.push(d); writeChunked('E', d); });
        child.on('close', (code, sig) => {
          const outBuf = Buffer.concat(outParts);
          const errBuf = Buffer.concat(errParts);
          sock.write(enc('Z', JSON.stringify({
            exitCode: code,
            signal: sig,
            timedOut: false,
            stdoutSha256: sha(outBuf),
            stderrSha256: sha(errBuf),
          })));
          sock.end();
          cleanup();
        });
      }
    }
  });
});

server.listen(socketPath, () => process.stdout.write('READY\\n'));
`;

async function startSessionGuestAgent(
  socketPath: string,
  scratchBase: string,
  mode:
    | 'normal'
    | 'fake-install-no-marker'
    | 'install-exit-1'
    | 'close-refuse' = 'normal',
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      SESSION_GUEST_AGENT_SCRIPT,
      socketPath,
      scratchBase,
      mode,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(
      () => reject(new Error(`guest agent start timeout: ${stderr}`)),
      10_000,
    );
    child.stdout?.on('data', (d: Buffer) => {
      if (d.toString('utf8').includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`guest agent exited (${code}): ${stderr}`));
    });
  });
  return child;
}

function createOfflineInstallableFixture(wt: string): void {
  mkdirSync(join(wt, 'dep'), { recursive: true });
  mkdirSync(join(wt, 'src'), { recursive: true });
  writeFileSync(
    join(wt, 'dep', 'package.json'),
    JSON.stringify({
      name: 'local-dep',
      version: '1.0.0',
      main: 'index.cjs',
    }),
  );
  writeFileSync(
    join(wt, 'dep', 'index.cjs'),
    'module.exports = { greeting: "FROM_GUEST_INSTALLED_DEP" };\n',
  );
  writeFileSync(
    join(wt, 'package.json'),
    JSON.stringify({
      name: 'fork-install-fixture',
      version: '1.0.0',
      dependencies: { 'local-dep': 'file:./dep' },
      scripts: {
        build:
          "node -e \"const d=require('local-dep'); const fs=require('fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/built.txt', d.greeting); console.log('BUILD:' + d.greeting)\"",
        test: "node -e \"const d=require('local-dep'); const fs=require('fs'); const b=fs.readFileSync('dist/built.txt','utf8'); console.log('TEST:' + b + ':' + d.greeting + ':secret=' + Boolean(process.env.HOST_GH_TOKEN))\"",
      },
    }),
  );
  writeFileSync(join(wt, 'src', 'index.ts'), 'export const x = 1;\n');
  // Generate a real package-lock.json offline without installing host node_modules.
  execFileSync('npm', ['install', '--package-lock-only', '--offline'], {
    cwd: wt,
    stdio: 'ignore',
    timeout: 30_000,
  });
  rmSync(join(wt, 'node_modules'), { recursive: true, force: true });
}

describe.skipIf(IS_WINDOWS)(
  'firecracker microVM bridge cross-platform E2E (install -> build -> test & test-delta)',
  () => {
    const tmpDirs: string[] = [];
    const children: ChildProcess[] = [];

    afterEach(() => {
      probeOverride.current = null;
      vi.unstubAllEnvs();
      for (const c of children.splice(0)) {
        try {
          c.kill('SIGKILL');
        } catch {
          // Already exited.
        }
      }
      for (const d of tmpDirs.splice(0)) {
        rmSync(d, { recursive: true, force: true });
      }
    });

    it('installs dependencies, builds, and tests an external fork PR inside a persistent firecracker guest session with zero host node_modules', async () => {
      const settingsGuard = isolateOperatorReviewSettings();
      const dir = mkdtempSync(join('/tmp', 'qvm-fc-e2e-'));
      tmpDirs.push(dir);
      try {
        const scratch = join(dir, 'scratch');
        const wt = join(dir, 'fork-wt');
        mkdirSync(scratch, { recursive: true });
        createOfflineInstallableFixture(wt);
        expect(existsSync(join(wt, 'node_modules'))).toBe(false);

        const sockPath = join(dir, 'fc.sock');
        children.push(
          await startSessionGuestAgent(sockPath, scratch, 'normal'),
        );

        probeOverride.current = {
          platform: 'linux',
          arch: 'x64',
          hasKvm: true,
          hasFirecracker: true,
          hasJailer: true,
          hasVfkit: false,
          hasSandboxExec: false,
          firecrackerKernel: '/opt/vm/vmlinux',
          firecrackerRootfs: '/opt/vm/rootfs.ext4',
          bridgeSocketPath: sockPath,
        };

        const planPath = join(dir, 'fork-plan.json');
        writeFileSync(
          planPath,
          JSON.stringify({
            prNumber: '901',
            isCrossRepository: true,
            authorAssociation: 'NONE',
            diffStat: { files: 1 },
            files: [{ path: 'src/index.ts', binary: false }],
          }),
        );

        vi.stubEnv('QWEN_REVIEW_SANDBOX', 'tiered');
        vi.stubEnv('HOST_GH_TOKEN', 'secret-must-stay-on-host');

        const rep = runBuildTest({
          plan: planPath,
          worktree: wt,
          out: join(dir, 'bt.json'),
          timeout: 60,
          install: true,
          buildOnly: false,
        });

        expect(rep.toolchain).toBe('npm');
        expect(rep.ok).toBe(true);
        expect(rep.install?.exitCode).toBe(0);
        expect(rep.build[0]?.output).toContain(
          'BUILD:FROM_GUEST_INSTALLED_DEP',
        );
        expect(rep.test[0]?.output).toContain(
          'TEST:FROM_GUEST_INSTALLED_DEP:FROM_GUEST_INSTALLED_DEP:secret=false',
        );
        expect(rep.executionBoundary).toMatchObject({
          policy: 'tiered',
          prTrust: 'external',
          executionClass: 'hardware-isolated',
          backend: 'firecracker',
          // build-test's OWN aggregated close status, not just the backend:
          // dropping the closeStatus aggregation must turn this red.
          teardownStatus: 'clean',
        });

        // Host worktree remained untouched (no RW mount) and guest session was cleaned up via 'C'.
        expect(existsSync(join(wt, 'node_modules'))).toBe(false);
        expect(existsSync(join(wt, 'dist'))).toBe(false);
        expect(
          readdirSync(scratch).filter((d) => d.startsWith('session-')),
        ).toEqual([]);

        // Also exercise runTestDelta through the firecracker bridge on Linux CI & macOS.
        // Use build-test's real emitter command (`npm test`), not `node -e`,
        // which is deliberately rejected by test-delta's execution grammar.
        const failedBt = join(dir, 'failed-bt.json');
        writeFileSync(
          failedBt,
          JSON.stringify({
            ...rep,
            ok: false,
            note: 'forced failing test for the net-new control report',
            test: [
              {
                ...rep.test[0]!,
                exitCode: 1,
                output: 'FAIL src/index.test.ts',
                failingFiles: ['src/index.test.ts'],
              },
            ],
          }),
        );
        // A delta baseline is a BUILT base tree (as `base-tree` promises), not
        // merely the PR source: seed the fixture's build artifact too.
        mkdirSync(join(wt, 'dist'), { recursive: true });
        writeFileSync(
          join(wt, 'dist', 'built.txt'),
          'FROM_GUEST_INSTALLED_DEP',
        );
        const delta = runTestDelta({
          report: failedBt,
          baseline: wt,
          plan: planPath,
          timeout: 30,
        });
        expect(delta.executionBoundary).toMatchObject({
          policy: 'tiered',
          prTrust: 'external',
          executionClass: 'hardware-isolated',
          backend: 'firecracker',
          teardownStatus: 'clean',
        });
        expect(delta.entries).toHaveLength(1);
        expect(delta.entries[0]?.base.exitCode).toBe(0);
        expect(delta.netNew).toEqual(['src/index.test.ts']);
        const requests = readFileSync(join(scratch, 'requests.ndjson'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { command: string });
        expect(
          requests.filter((r) => r.command === 'npm ci --no-audit --no-fund')
            .length,
        ).toBeGreaterThanOrEqual(2);
        expect(requests.some((r) => r.command === 'npm test')).toBe(true);
        expect(
          readdirSync(scratch).filter((d) => d.startsWith('session-')),
        ).toEqual([]);
      } finally {
        settingsGuard.dispose();
      }
    }, 60_000);

    it('never retries or reruns probes after a failed guest dependency install', async () => {
      const settingsGuard = isolateOperatorReviewSettings();
      const dir = mkdtempSync(join('/tmp', 'qvm-eff-fail-install-'));
      tmpDirs.push(dir);
      try {
        const scratch = join(dir, 'scratch');
        const wt = join(dir, 'probe-wt');
        mkdirSync(scratch, { recursive: true });
        createOfflineInstallableFixture(wt);
        const probeFile = 'src/index.test.ts';
        writeFileSync(
          join(wt, probeFile),
          'import { it } from "vitest";\nit("dummy", () => {});\n',
        );
        // `runControlMutant`'s own tracked-tree guard intentionally precedes
        // the bridge: use a real Git worktree so the install path is reached.
        execFileSync('git', ['init', '-q'], { cwd: wt });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], {
          cwd: wt,
        });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wt });
        execFileSync('git', ['add', '.'], { cwd: wt });
        execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: wt });
        const sockPath = join(dir, 'eff-fail.sock');
        children.push(
          await startSessionGuestAgent(sockPath, scratch, 'install-exit-1'),
        );
        probeOverride.current = {
          platform: 'linux',
          arch: 'x64',
          hasKvm: true,
          hasFirecracker: true,
          hasJailer: true,
          hasVfkit: false,
          hasSandboxExec: false,
          firecrackerKernel: '/opt/vm/vmlinux',
          firecrackerRootfs: '/opt/vm/rootfs.ext4',
          bridgeSocketPath: sockPath,
        };
        vi.stubEnv('QWEN_REVIEW_FORCE_HARDWARE', '1');
        const vmSession: Parameters<typeof runControlMutant>[7] = {
          sessionId: 'eff-failed-install-1',
          socketPath: sockPath,
          sessionAllocated: false,
          installAttempted: false,
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(() =>
            runControlMutant(
              wt,
              probeFile,
              undefined,
              () => 1,
              wt,
              undefined,
              undefined,
              vmSession,
            ),
          ).toThrow(/microVM dependency install exited 1/);
        }
        expect(vmSession?.sessionAllocated).toBe(true);
        expect(vmSession?.installAttempted).toBe(true);
        const requests = readFileSync(join(scratch, 'requests.ndjson'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { command: string });
        expect(
          requests.filter((r) => r.command === 'npm ci --no-audit --no-fund'),
        ).toHaveLength(1);
        expect(requests.some((r) => r.command.includes('vitest'))).toBe(false);
        expect(closeGuestSessionSync(sockPath, 'eff-failed-install-1').ok).toBe(
          true,
        );
      } finally {
        settingsGuard.dispose();
      }
    }, 30_000);

    it('surfaces the close failure reason in the build-test and test-delta boundary notes', async () => {
      const settingsGuard = isolateOperatorReviewSettings();
      const dir = mkdtempSync(join('/tmp', 'qvm-close-note-'));
      tmpDirs.push(dir);
      try {
        const scratch = join(dir, 'scratch');
        const wt = join(dir, 'wt');
        mkdirSync(scratch, { recursive: true });
        createOfflineInstallableFixture(wt);
        const sockPath = join(dir, 'refuse.sock');
        children.push(
          await startSessionGuestAgent(sockPath, scratch, 'close-refuse'),
        );
        probeOverride.current = {
          platform: 'linux',
          arch: 'x64',
          hasKvm: true,
          hasFirecracker: true,
          hasJailer: true,
          hasVfkit: false,
          hasSandboxExec: false,
          firecrackerKernel: '/opt/vm/vmlinux',
          firecrackerRootfs: '/opt/vm/rootfs.ext4',
          bridgeSocketPath: sockPath,
        };
        const planPath = join(dir, 'plan.json');
        writeFileSync(
          planPath,
          JSON.stringify({
            prNumber: '903',
            isCrossRepository: true,
            authorAssociation: 'NONE',
            diffStat: { files: 1 },
            files: [{ path: 'src/index.ts', binary: false }],
          }),
        );
        vi.stubEnv('QWEN_REVIEW_SANDBOX', 'tiered');
        const rep = runBuildTest({
          plan: planPath,
          worktree: wt,
          out: join(dir, 'bt.json'),
          timeout: 60,
          install: true,
          buildOnly: false,
        });
        expect(rep.executionBoundary?.teardownStatus).toBe('partial');
        expect(rep.executionBoundary?.note).toContain(
          'cleanup could not be fully verified',
        );
        expect(rep.executionBoundary?.note).toContain(
          'no complete session-bound close ACK',
        );

        mkdirSync(join(wt, 'dist'), { recursive: true });
        writeFileSync(
          join(wt, 'dist', 'built.txt'),
          'FROM_GUEST_INSTALLED_DEP',
        );
        const failedBt = join(dir, 'failed.json');
        writeFileSync(
          failedBt,
          JSON.stringify({
            ...rep,
            ok: false,
            test: [
              {
                ...rep.test[0]!,
                exitCode: 1,
                output: 'FAIL src/index.test.ts',
                failingFiles: ['src/index.test.ts'],
              },
            ],
          }),
        );
        const delta = runTestDelta({
          report: failedBt,
          baseline: wt,
          plan: planPath,
          timeout: 30,
        });
        expect(delta.executionBoundary?.teardownStatus).toBe('partial');
        expect(delta.executionBoundary?.note).toContain(
          'cleanup could not be verified',
        );
        expect(delta.executionBoundary?.note).toContain(
          'no complete session-bound close ACK',
        );
      } finally {
        settingsGuard.dispose();
      }
    }, 60_000);

    it('syncs (not overlays) the probe tree once the guest session holds installed dependencies', async () => {
      const settingsGuard = isolateOperatorReviewSettings();
      const dir = mkdtempSync(join('/tmp', 'qvm-eff-sync-'));
      tmpDirs.push(dir);
      try {
        const scratch = join(dir, 'scratch');
        const wt = join(dir, 'probe-wt');
        mkdirSync(scratch, { recursive: true });
        createOfflineInstallableFixture(wt);
        const probeFile = 'src/index.test.ts';
        writeFileSync(join(wt, probeFile), 'it("dummy", () => {});\n');
        execFileSync('git', ['init', '-q'], { cwd: wt });
        execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: wt });
        execFileSync('git', ['config', 'user.name', 'T'], { cwd: wt });
        execFileSync('git', ['add', '.'], { cwd: wt });
        execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: wt });
        const sockPath = join(dir, 'eff-sync.sock');
        children.push(
          await startSessionGuestAgent(sockPath, scratch, 'normal'),
        );
        probeOverride.current = {
          platform: 'linux',
          arch: 'x64',
          hasKvm: true,
          hasFirecracker: true,
          hasJailer: true,
          hasVfkit: false,
          hasSandboxExec: false,
          firecrackerKernel: '/opt/vm/vmlinux',
          firecrackerRootfs: '/opt/vm/rootfs.ext4',
          bridgeSocketPath: sockPath,
        };
        vi.stubEnv('QWEN_REVIEW_FORCE_HARDWARE', '1');
        const vmSession: Parameters<typeof runControlMutant>[7] = {
          sessionId: 'eff-sync-1',
          socketPath: sockPath,
          sessionAllocated: false,
          installAttempted: false,
        };
        // The probe verdict is irrelevant here: the WIRE MODE is the oracle.
        // A `sync` -> `overlay` mutation leaves stale PR-added files in the
        // guest, so the recorded mode must stay `sync` after install.
        try {
          runControlMutant(
            wt,
            probeFile,
            undefined,
            () => 1,
            wt,
            undefined,
            undefined,
            vmSession,
          );
        } catch {
          // An unparseable probe result is fine; the request was still sent.
        }
        const requests = readFileSync(join(scratch, 'requests.ndjson'), 'utf8')
          .trim()
          .split('\n')
          .map(
            (l) => JSON.parse(l) as { command: string; workspaceMode?: string },
          );
        const probeRequests = requests.filter((r) =>
          r.command.includes('vitest'),
        );
        expect(probeRequests.length).toBeGreaterThan(0);
        expect(probeRequests.map((r) => r.workspaceMode).join(',')).toBe(
          probeRequests.map(() => 'sync').join(','),
        );
        expect(closeGuestSessionSync(sockPath, 'eff-sync-1').ok).toBe(true);
      } finally {
        settingsGuard.dispose();
      }
    }, 30_000);

    it('treats a zero-exit efficacy install without the completeness marker as not-run', async () => {
      const settingsGuard = isolateOperatorReviewSettings();
      const dir = mkdtempSync(join('/tmp', 'qvm-eff-nomarker-'));
      tmpDirs.push(dir);
      try {
        const scratch = join(dir, 'scratch');
        const wt = join(dir, 'probe-wt');
        mkdirSync(scratch, { recursive: true });
        createOfflineInstallableFixture(wt);
        const probeFile = 'src/index.test.ts';
        writeFileSync(join(wt, probeFile), 'it("dummy", () => {});\n');
        execFileSync('git', ['init', '-q'], { cwd: wt });
        execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: wt });
        execFileSync('git', ['config', 'user.name', 'T'], { cwd: wt });
        execFileSync('git', ['add', '.'], { cwd: wt });
        execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: wt });
        const sockPath = join(dir, 'eff-nomarker.sock');
        children.push(
          await startSessionGuestAgent(
            sockPath,
            scratch,
            'fake-install-no-marker',
          ),
        );
        probeOverride.current = {
          platform: 'linux',
          arch: 'x64',
          hasKvm: true,
          hasFirecracker: true,
          hasJailer: true,
          hasVfkit: false,
          hasSandboxExec: false,
          firecrackerKernel: '/opt/vm/vmlinux',
          firecrackerRootfs: '/opt/vm/rootfs.ext4',
          bridgeSocketPath: sockPath,
        };
        vi.stubEnv('QWEN_REVIEW_FORCE_HARDWARE', '1');
        const vmSession: Parameters<typeof runControlMutant>[7] = {
          sessionId: 'eff-nomarker-1',
          socketPath: sockPath,
          sessionAllocated: false,
          installAttempted: false,
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(() =>
            runControlMutant(
              wt,
              probeFile,
              undefined,
              () => 1,
              wt,
              undefined,
              undefined,
              vmSession,
            ),
          ).toThrow(/without the lockfile completeness marker/);
        }
        const requests = readFileSync(join(scratch, 'requests.ndjson'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { command: string });
        expect(requests.some((r) => r.command.includes('vitest'))).toBe(false);
        expect(closeGuestSessionSync(sockPath, 'eff-nomarker-1').ok).toBe(true);
      } finally {
        settingsGuard.dispose();
      }
    }, 30_000);

    it('fails install honestly when guest npm ci exits 0 without writing the lockfile completeness marker', async () => {
      const settingsGuard = isolateOperatorReviewSettings();
      const dir = mkdtempSync(join('/tmp', 'qvm-fc-nomark-'));
      tmpDirs.push(dir);
      try {
        const scratch = join(dir, 'scratch');
        const wt = join(dir, 'fork-wt');
        mkdirSync(scratch, { recursive: true });
        createOfflineInstallableFixture(wt);

        const sockPath = join(dir, 'fc-fake.sock');
        children.push(
          await startSessionGuestAgent(
            sockPath,
            scratch,
            'fake-install-no-marker',
          ),
        );

        probeOverride.current = {
          platform: 'linux',
          arch: 'x64',
          hasKvm: true,
          hasFirecracker: true,
          hasJailer: true,
          hasVfkit: false,
          hasSandboxExec: false,
          firecrackerKernel: '/opt/vm/vmlinux',
          firecrackerRootfs: '/opt/vm/rootfs.ext4',
          bridgeSocketPath: sockPath,
        };

        const planPath = join(dir, 'fork-plan.json');
        writeFileSync(
          planPath,
          JSON.stringify({
            prNumber: '902',
            isCrossRepository: true,
            authorAssociation: 'NONE',
            diffStat: { files: 1 },
            files: [{ path: 'src/index.ts', binary: false }],
          }),
        );

        vi.stubEnv('QWEN_REVIEW_SANDBOX', 'tiered');

        const rep = runBuildTest({
          plan: planPath,
          worktree: wt,
          out: join(dir, 'bt.json'),
          timeout: 60,
          install: true,
          buildOnly: false,
        });

        expect(rep.install?.exitCode).toBe(0);
        expect(rep.ok).toBe(false);
        expect(rep.build).toEqual([]);
        expect(rep.test).toEqual([]);
        expect(rep.note).toContain('no usable `node_modules`');
        expect(
          readdirSync(scratch).filter((d) => d.startsWith('session-')),
        ).toEqual([]);
      } finally {
        settingsGuard.dispose();
      }
    }, 60_000);
  },
);
