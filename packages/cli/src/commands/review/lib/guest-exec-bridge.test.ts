/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import {
  DARWIN_MAX_UDS_BYTES,
  GUEST_EXEC_PROTOCOL,
  GuestExecFrameDecoder,
  LINUX_MAX_UDS_BYTES,
  encodeFrame,
  evaluateGuestResponseWire,
  executeViaGuestBridge,
  executeViaGuestBridgeSync,
  packWorkspaceFiles,
  reapVmWorker,
  sha256Hex,
  validateBridgeSocketEndpoint,
  validateUdsPathLength,
  validateWorkspaceRelativePath,
} from './guest-exec-bridge.js';
import { isolateOperatorReviewSettings } from './test-utils.js';
import { runBuildTest } from '../build-test.js';
import { runTestDelta } from '../test-delta.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Standalone child-process `guest-exec-v1` server running in its own Node
 * process over a real Unix domain socket. Unpacks uploaded files into an
 * isolated scratch directory (never touching the host worktree) and executes
 * commands in that scratch directory with only the received env allowlist.
 */
const GUEST_AGENT_CHILD_SCRIPT = `
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const guestDir = mkdtempSync(join(scratchBase, 'guest-'));

  const cleanup = () => {
    try { rmSync(guestDir, { recursive: true, force: true }); } catch {}
  };

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const kind = String.fromCharCode(buf[0]);
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) break;
      const payload = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);

      if (kind === 'H') {
        if (mode === 'bad-ack') {
          sock.write(enc('A', 'wrong-protocol'));
          sock.end();
          cleanup();
          return;
        }
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
          cleanup();
          return;
        }
        const dest = join(guestDir, curFile.path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content);
        curFile = null;
        fileChunks = [];
      } else if (kind === 'X') {
        const req = JSON.parse(payload.toString('utf8'));
        if (mode === 'truncate') {
          sock.write(enc('O', 'partial output before drop'));
          sock.end();
          cleanup();
          return;
        }
        if (mode === 'forged-digest') {
          sock.write(enc('O', 'hello'));
          sock.write(enc('Z', JSON.stringify({
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdoutSha256: '0'.repeat(64),
            stderrSha256: sha(Buffer.alloc(0)),
          })));
          sock.end();
          cleanup();
          return;
        }
        if (mode === 'hang') {
          // Intentionally ignore request until host deadline kills the bridge.
          return;
        }
        const child = spawn('/bin/sh', ['-c', req.command], {
          cwd: join(guestDir, req.workdir || '.'),
          env: { PATH: process.env.PATH || '/usr/bin:/bin', ...req.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const outParts = [];
        const errParts = [];
        const writeChunked = (kind, buf) => {
          for (let off = 0; off < buf.length; off += 65536) {
            sock.write(enc(kind, buf.subarray(off, Math.min(off + 65536, buf.length))));
          }
        };
        child.stdout.on('data', (d) => {
          outParts.push(d);
          writeChunked('O', d);
        });
        child.stderr.on('data', (d) => {
          errParts.push(d);
          writeChunked('E', d);
        });
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

server.listen(socketPath, () => {
  process.stdout.write('READY\\n');
});
`;

async function startGuestAgentChild(
  socketPath: string,
  scratchBase: string,
  mode: 'normal' | 'truncate' | 'forged-digest' | 'bad-ack' | 'hang' = 'normal',
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      GUEST_AGENT_CHILD_SCRIPT,
      socketPath,
      scratchBase,
      mode,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(
      () =>
        reject(new Error(`guest-agent child timed out starting: ${stderr}`)),
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
      reject(new Error(`guest-agent child exited early (${code}): ${stderr}`));
    });
  });
  return child;
}

describe('guest-exec-bridge protocol & safety invariants', () => {
  const tmpDirs: string[] = [];
  const servers: Server[] = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const c of children.splice(0)) {
      try {
        c.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
    for (const s of servers.splice(0)) {
      await new Promise<void>((r) => s.close(() => r()));
    }
    for (const d of tmpDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('validates UDS sun_path limits per OS and rejects NUL/empty paths', () => {
    expect(validateUdsPathLength('', 'linux').ok).toBe(false);
    expect(validateUdsPathLength('/tmp/a\0b', 'linux').ok).toBe(false);
    expect(
      validateUdsPathLength('/' + 'a'.repeat(DARWIN_MAX_UDS_BYTES), 'darwin')
        .ok,
    ).toBe(false);
    expect(
      validateUdsPathLength('/' + 'a'.repeat(LINUX_MAX_UDS_BYTES), 'linux').ok,
    ).toBe(false);
    expect(validateUdsPathLength('/tmp/v.sock', 'darwin').ok).toBe(true);
  });

  it('validates frame encoding/decoding and rejects oversized, invalid, or truncated frames', () => {
    expect(() => encodeFrame('O', Buffer.alloc(32), 16)).toThrow(
      /exceeds maxFrameBytes/,
    );

    const decoder = new GuestExecFrameDecoder(16, 64);
    const badKind = decoder.push(Buffer.from([0x3f, 0, 0, 0, 0]));
    expect(badKind.error).toContain('invalid guest-exec frame kind');

    const dec2 = new GuestExecFrameDecoder(8, 64);
    const headerOver = Buffer.alloc(5);
    headerOver[0] = 'O'.charCodeAt(0);
    headerOver.writeUInt32BE(99, 1);
    expect(dec2.push(headerOver).error).toContain('exceeds maxFrameBytes');

    const truncatedWire = Buffer.concat([
      encodeFrame('A', GUEST_EXEC_PROTOCOL),
      encodeFrame('O', 'hello'),
    ]);
    const truncRes = evaluateGuestResponseWire(truncatedWire);
    expect(truncRes.ok).toBe(false);
    expect(truncRes.protocolError).toContain('before end frame');

    const forgedWire = Buffer.concat([
      encodeFrame('A', GUEST_EXEC_PROTOCOL),
      encodeFrame('O', 'hello'),
      encodeFrame(
        'Z',
        JSON.stringify({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutSha256: 'a'.repeat(64),
          stderrSha256: sha256Hex(''),
        }),
      ),
    ]);
    const forgedRes = evaluateGuestResponseWire(forgedWire);
    expect(forgedRes.ok).toBe(false);
    expect(forgedRes.protocolError).toContain('digest mismatch');

    // Non-positive/non-safe-integer budgets and impossible exitCode+signal combos must fail closed.
    expect(() => encodeFrame('O', 'hi', Number.NaN)).toThrow(
      /positive safe integer/,
    );
    expect(() => new GuestExecFrameDecoder(0, 64)).toThrow(
      /positive safe integer/,
    );
    const badEndWire = Buffer.concat([
      encodeFrame('A', GUEST_EXEC_PROTOCOL),
      encodeFrame(
        'Z',
        JSON.stringify({
          exitCode: 0,
          signal: 'SIGKILL',
          timedOut: false,
          stdoutSha256: sha256Hex(''),
          stderrSha256: sha256Hex(''),
        }),
      ),
    ]);
    expect(evaluateGuestResponseWire(badEndWire).protocolError).toContain(
      'malformed guest-exec end frame',
    );
  });

  it('packs regular workspace files by content while refusing symlinks, traversal, and over-budget trees', () => {
    expect(validateWorkspaceRelativePath('src/app.ts')).toBe(true);
    expect(validateWorkspaceRelativePath('../secret')).toBe(false);
    expect(validateWorkspaceRelativePath('/etc/passwd')).toBe(false);
    expect(validateWorkspaceRelativePath('a\\b')).toBe(false);

    const dir = mkdtempSync(join('/tmp', 'qvm-pack-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');

    const ok = packWorkspaceFiles(dir);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.files.map((f) => f.path)).toEqual(['src/a.ts']);
      expect(ok.files[0]?.sha256).toBe(sha256Hex('export const a = 1;\n'));
    }

    const overBudget = packWorkspaceFiles(dir, { maxTotalBytes: 4 });
    expect(overBudget.ok).toBe(false);
    if (!overBudget.ok) {
      expect(overBudget.reason).toContain('total bytes exceeds budget');
    }

    if (!IS_WINDOWS) {
      symlinkSync('/etc/passwd', join(dir, 'src', 'escape.ts'));
      const withSymlink = packWorkspaceFiles(dir);
      expect(withSymlink.ok).toBe(false);
      if (!withSymlink.ok) {
        expect(withSymlink.reason).toContain('refusing symlink');
      }
    }
  });

  it.skipIf(IS_WINDOWS)(
    'rejects symlinked or non-socket bridge endpoints via lstat',
    async () => {
      const dir = mkdtempSync(join('/tmp', 'qvm-sock-'));
      tmpDirs.push(dir);
      const realSock = join(dir, 'real.sock');
      const server = createServer();
      servers.push(server);
      await new Promise<void>((r) => server.listen(realSock, r));

      expect(validateBridgeSocketEndpoint(realSock).ok).toBe(true);

      const linkSock = join(dir, 'link.sock');
      symlinkSync(realSock, linkSock);
      const linkCheck = validateBridgeSocketEndpoint(linkSock);
      expect(linkCheck.ok).toBe(false);
      if (!linkCheck.ok) {
        expect(linkCheck.reason).toContain('symlinked bridge socket');
      }

      const regularFile = join(dir, 'not-a-sock');
      writeFileSync(regularFile, 'hi');
      const fileCheck = validateBridgeSocketEndpoint(regularFile);
      expect(fileCheck.ok).toBe(false);
      if (!fileCheck.ok) {
        expect(fileCheck.reason).toContain('not a Unix domain socket');
      }

      const relCheck = validateBridgeSocketEndpoint('./relative.sock');
      expect(relCheck.ok).toBe(false);
      if (!relCheck.ok) {
        expect(relCheck.reason).toContain('must be absolute');
      }
    },
  );

  it.skipIf(IS_WINDOWS)(
    'reapVmWorker checks executable identity, kills TERM-ignoring live worker, and preserves unrelated canary',
    async () => {
      const dir = mkdtempSync(join('/tmp', 'qvm-reap-'));
      tmpDirs.push(dir);

      const target = spawn(
        '/bin/sh',
        ['-c', 'trap "" TERM; sleep 60 # qvm-target-token'],
        { stdio: 'ignore' },
      );
      const canary = spawn(
        '/bin/sh',
        ['-c', 'sleep 60 # qvm-innocent-canary'],
        { stdio: 'ignore' },
      );
      children.push(target, canary);
      expect(target.pid).toBeGreaterThan(1);
      expect(canary.pid).toBeGreaterThan(1);

      const pidFile = join(dir, 'worker.pid');
      writeFileSync(pidFile, `${target.pid}\n`);

      // Self-PID must never be signalled.
      const selfRefused = reapVmWorker({
        pid: process.pid,
        expectedExeTokens: ['node'],
      });
      expect(selfRefused.status).toBe('failed');
      expect(selfRefused.detail).toContain('current host process');

      // Symlinked pid file must be refused.
      const linkPidFile = join(dir, 'link.pid');
      symlinkSync(pidFile, linkPidFile);
      expect(
        reapVmWorker({
          pidFile: linkPidFile,
          expectedExeTokens: ['qvm-target-token'],
        }).status,
      ).toBe('failed');

      // Mismatched executable identity must NOT kill the process.
      const mismatch = reapVmWorker({
        pidFile,
        expectedExeTokens: ['firecracker-definitely-not-here'],
      });
      expect(mismatch.status).toBe('failed');
      expect(mismatch.detail).toContain('identity mismatch');
      expect(() => process.kill(target.pid!, 0)).not.toThrow();

      // Matching identity escalates SIGTERM -> SIGKILL and verifies exit.
      const reaped = reapVmWorker({
        pidFile,
        expectedExeTokens: ['qvm-target-token'],
        killWaitMs: 150,
      });
      expect(reaped.status).toBe('clean');
      // Canary remains untouched.
      expect(() => process.kill(canary.pid!, 0)).not.toThrow();
    },
  );

  it.skipIf(IS_WINDOWS)(
    'executes commands end-to-end over a real UDS child guest-agent without touching host files and rejects truncation/forged digests/timeouts',
    async () => {
      const dir = mkdtempSync(join('/tmp', 'qvm-e2e-'));
      tmpDirs.push(dir);
      const scratch = join(dir, 'guest-scratch');
      const hostTree = join(dir, 'host-wt');
      mkdirSync(scratch, { recursive: true });
      mkdirSync(join(hostTree, 'src'), { recursive: true });
      writeFileSync(
        join(hostTree, 'src', 'hello.txt'),
        'original-host-bytes\n',
      );

      // 1. Normal execution: mutating files inside guest leaves host untouched.
      const sockOk = join(dir, 'ok.sock');
      children.push(await startGuestAgentChild(sockOk, scratch, 'normal'));
      const asyncRes = await executeViaGuestBridge(sockOk, {
        command:
          'cat src/hello.txt && echo MUTATED > src/hello.txt && echo SECRET=${HOST_SECRET:-STRIPPED}',
        kind: 'test',
        timeoutMs: 10_000,
        env: { CI: 'true' },
        workspaceDir: hostTree,
      });
      expect(asyncRes.ok).toBe(true);
      expect(asyncRes.exitCode).toBe(0);
      expect(asyncRes.stdout).toContain('original-host-bytes');
      expect(asyncRes.stdout).toContain('SECRET=STRIPPED');
      expect(readFileSync(join(hostTree, 'src', 'hello.txt'), 'utf8')).toBe(
        'original-host-bytes\n',
      );

      // Synchronous adapter used by build-test / test-efficacy / test-delta,
      // including multi-frame >512 KiB output to prove stdout drains cleanly
      // without truncating trailing frames.
      const syncRes = executeViaGuestBridgeSync(sockOk, {
        command:
          "node -e \"process.stdout.write('A'.repeat(524288)); process.stdout.write('\\nSYNC_BRIDGE_OK\\n')\"",
        kind: 'test',
        timeoutMs: 10_000,
        env: { CI: 'true' },
        workspaceDir: hostTree,
      });
      expect(syncRes.ok).toBe(true);
      expect(syncRes.stdout.length).toBe(524288 + '\nSYNC_BRIDGE_OK\n'.length);
      expect(syncRes.stdout.endsWith('\nSYNC_BRIDGE_OK\n')).toBe(true);

      // 2. Truncated stream fails closed.
      const sockTrunc = join(dir, 'trunc.sock');
      children.push(await startGuestAgentChild(sockTrunc, scratch, 'truncate'));
      const truncRes = executeViaGuestBridgeSync(sockTrunc, {
        command: 'echo hi',
        kind: 'test',
        timeoutMs: 5_000,
        env: {},
      });
      expect(truncRes.ok).toBe(false);
      expect(truncRes.protocolError).toContain('before end frame');

      // 3. Forged SHA-256 digest fails closed.
      const sockForge = join(dir, 'forge.sock');
      children.push(
        await startGuestAgentChild(sockForge, scratch, 'forged-digest'),
      );
      const forgeRes = executeViaGuestBridgeSync(sockForge, {
        command: 'echo hi',
        kind: 'test',
        timeoutMs: 5_000,
        env: {},
      });
      expect(forgeRes.ok).toBe(false);
      expect(forgeRes.protocolError).toContain('digest mismatch');

      // 4. Hung guest hits deadline and reports timedOut: true.
      const sockHang = join(dir, 'hang.sock');
      children.push(await startGuestAgentChild(sockHang, scratch, 'hang'));
      const hangRes = executeViaGuestBridgeSync(sockHang, {
        command: 'sleep 30',
        kind: 'test',
        timeoutMs: 300,
        env: {},
      });
      expect(hangRes.ok).toBe(false);
      expect(hangRes.timedOut).toBe(true);
    },
  );

  it.skipIf(
    IS_WINDOWS || !(process.platform === 'darwin' && process.arch === 'arm64'),
  )(
    'runs tiered external fork PR end-to-end through real vfkit UDS bridge in runBuildTest and runTestDelta',
    async () => {
      const settingsGuard = isolateOperatorReviewSettings();
      const dir = mkdtempSync(join('/tmp', 'qvm-bt-'));
      tmpDirs.push(dir);
      try {
        const scratch = join(dir, 'guest-scratch');
        const binDir = join(dir, 'bin');
        const wt = join(dir, 'external-wt');
        mkdirSync(scratch, { recursive: true });
        mkdirSync(binDir, { recursive: true });
        mkdirSync(join(wt, 'src'), { recursive: true });

        // Stub vfkit binary + readable kernel/rootfs so host prerequisites pass.
        const vfkitStub = join(binDir, 'vfkit');
        writeFileSync(vfkitStub, '#!/bin/sh\nexit 0\n');
        chmodSync(vfkitStub, 0o755);
        const kernel = join(dir, 'Image');
        const rootfs = join(dir, 'rootfs.img');
        writeFileSync(kernel, 'kernel-placeholder');
        writeFileSync(rootfs, 'rootfs-placeholder');

        const sockPath = join(dir, 'vf.sock');
        children.push(await startGuestAgentChild(sockPath, scratch, 'normal'));

        // Minimal npm single-package worktree (NOT under .qwen/tmp — proving no host mount needed).
        writeFileSync(
          join(wt, 'package.json'),
          JSON.stringify({
            name: 'ext-fork-pkg',
            version: '1.0.0',
            scripts: {
              build: 'node -e "console.log(\'VM_BUILD_OK\')"',
              test: 'node -e "console.log(\'VM_TEST_OK secret=\' + Boolean(process.env.HOST_GH_TOKEN))"',
            },
          }),
        );
        writeFileSync(
          join(wt, 'package-lock.json'),
          '{"name":"ext-fork-pkg","lockfileVersion":3}\n',
        );
        mkdirSync(join(wt, 'node_modules'), { recursive: true });
        writeFileSync(join(wt, 'node_modules', '.package-lock.json'), '{}');
        writeFileSync(join(wt, 'src', 'index.ts'), 'export const v = 1;\n');

        const planPath = join(dir, 'fork-plan.json');
        writeFileSync(
          planPath,
          JSON.stringify({
            prNumber: '888',
            isCrossRepository: true,
            authorAssociation: 'NONE',
            diffStat: { files: 1 },
            files: [{ path: 'src/index.ts', binary: false }],
          }),
        );

        vi.stubEnv('PATH', `${binDir}:${process.env['PATH'] ?? ''}`);
        vi.stubEnv('QWEN_REVIEW_SANDBOX', 'tiered');
        vi.stubEnv('QWEN_REVIEW_VM_KERNEL', kernel);
        vi.stubEnv('QWEN_REVIEW_VM_ROOTFS', rootfs);
        vi.stubEnv('QWEN_REVIEW_VM_BRIDGE_SOCKET', sockPath);
        vi.stubEnv('HOST_GH_TOKEN', 'must-not-enter-microvm');

        const btOut = join(dir, 'bt.json');
        const btReport = runBuildTest({
          plan: planPath,
          worktree: wt,
          out: btOut,
          timeout: 30,
          install: false,
          buildOnly: false,
        });
        expect(btReport.toolchain).toBe('npm');
        expect(btReport.ok).toBe(true);
        expect(btReport.build[0]?.output).toContain('VM_BUILD_OK');
        expect(btReport.test[0]?.output).toContain('VM_TEST_OK secret=false');
        expect(btReport.executionBoundary).toMatchObject({
          policy: 'tiered',
          prTrust: 'external',
          executionClass: 'hardware-isolated',
          backend: 'vfkit',
        });

        // Also prove runTestDelta executes inside the microVM bridge under tiered + fork PR.
        const failedBtPath = join(dir, 'failed-bt.json');
        writeFileSync(
          failedBtPath,
          JSON.stringify({
            toolchain: 'npm',
            affected: ['.'],
            buildSet: ['.'],
            widenedWith: [],
            install: null,
            build: [],
            test: [
              {
                command: 'npm test',
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
        const deltaReport = runTestDelta({
          report: failedBtPath,
          baseline: wt,
          plan: planPath,
          timeout: 30,
        });
        expect(deltaReport.executionBoundary).toMatchObject({
          policy: 'tiered',
          prTrust: 'external',
          executionClass: 'hardware-isolated',
          backend: 'vfkit',
        });
        expect(existsSync(btOut)).toBe(false); // runBuildTest returns report; CLI handler writes --out.
      } finally {
        settingsGuard.dispose();
      }
    },
  );
});
