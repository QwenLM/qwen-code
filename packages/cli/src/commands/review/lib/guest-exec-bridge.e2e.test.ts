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

const SESSION_GUEST_AGENT_SCRIPT = `
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
        const sid = payload.toString('utf8');
        rmSync(join(scratchBase, 'session-' + sid), { recursive: true, force: true });
        sock.write(enc('Z', JSON.stringify({
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
            : req.command;

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
  mode: 'normal' | 'fake-install-no-marker' = 'normal',
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
        });

        // Host worktree remained untouched (no RW mount) and guest session was cleaned up via 'C'.
        expect(existsSync(join(wt, 'node_modules'))).toBe(false);
        expect(existsSync(join(wt, 'dist'))).toBe(false);
        expect(
          readdirSync(scratch).filter((d) => d.startsWith('session-')),
        ).toEqual([]);

        // Also exercise runTestDelta through the firecracker bridge on Linux CI & macOS.
        const failedBt = join(dir, 'failed-bt.json');
        writeFileSync(
          failedBt,
          JSON.stringify({
            toolchain: 'npm',
            affected: ['.'],
            buildSet: ['.'],
            widenedWith: [],
            install: null,
            build: [],
            test: [
              {
                command: 'node -e "console.log(\'DELTA_IN_FIRECRACKER\')"',
                exitCode: 1,
                seconds: 1,
                timedOut: false,
                output: 'FAIL src/index.test.ts',
                failingFiles: ['src/index.test.ts'],
              },
            ],
            timedOut: [],
            ok: false,
            note: 'failed',
          }),
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
        });
      } finally {
        settingsGuard.dispose();
      }
    }, 60_000);

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
