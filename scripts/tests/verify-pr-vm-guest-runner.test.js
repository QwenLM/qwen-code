/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFirecrackerLaunchPlan,
  runHardwareRound,
} from '../verify-pr-vm-runner.mjs';

const GUEST_RUNNER_PY = fileURLToPath(
  new URL('../verify-pr-vm-guest-runner.py', import.meta.url),
);
const GUEST_VSOCK_PY = fileURLToPath(
  new URL('../verify-pr-vm-guest-vsock.py', import.meta.url),
);
const GUEST_INIT_SH = fileURLToPath(
  new URL('../verify-pr-vm-guest-init.sh', import.meta.url),
);

const cleanups = [];

function makeTempDir(prefix = 'vgr-') {
  const base = existsSync('/tmp') ? '/tmp' : tmpdir();
  const dir = realpathSync(mkdtempSync(join(base, prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeTwoCommitRepo(repoDir) {
  mkdirSync(repoDir, { recursive: true });
  const git = (args) =>
    execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repoDir, 'hello.txt'), 'base-v1\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  const baseRefOid = git(['rev-parse', 'HEAD']);
  writeFileSync(join(repoDir, 'hello.txt'), 'head-v2-verified\n');
  git(['add', '.']);
  git(['commit', '-m', 'head']);
  const headRefOid = git(['rev-parse', 'HEAD']);
  return { baseRefOid, headRefOid };
}

function makeHostContext(dir, baseRefOid, headRefOid) {
  const ctx = {
    repo: 'QwenLM/qwen-code',
    number: 18553,
    baseRefOid,
    headRefOid,
    trustClassification: {
      prTrust: 'external',
      executionClass: 'hardware-isolated',
      escalationReasons: ['external-or-fork-pr'],
      evaluatedAtHead: headRefOid,
    },
  };
  const text = `${JSON.stringify(ctx, null, 2)}\n`;
  const path = join(dir, 'context.json');
  writeFileSync(path, text, { mode: 0o600 });
  return { path, sha256: sha256Text(text) };
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()();
  }
});

describe('verify-pr-vm-guest-runner and guest-init', () => {
  it('validates POSIX syntax of guest-init.sh and rejects invalid cmdline ports', () => {
    const shCheck = spawnSync('sh', ['-n', GUEST_INIT_SH], {
      encoding: 'utf8',
    });
    expect(shCheck.status, shCheck.stderr).toBe(0);

    const root = makeTempDir('vgr-cmd-');
    const badCmdline = join(root, 'cmdline');
    writeFileSync(
      badCmdline,
      'console=ttyS0 qwen.cid=2 qwen.input_port=53 qwen.workload_timeout=0\n',
    );
    const res = spawnSync(
      'python3',
      [GUEST_RUNNER_PY, '--from-cmdline', '--cmdline-file', badCmdline],
      { encoding: 'utf8' },
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/invalid cmdline qwen\.workload_timeout/);

    // Pure-Python bundle header check rejects wrong OIDs and accepts valid v2 headers
    const goodBundle = join(root, 'good.bundle');
    const oidA = 'a'.repeat(40);
    const oidB = 'b'.repeat(40);
    writeFileSync(
      goodBundle,
      `# v2 git bundle\n${oidA} refs/verify/base\n${oidB} refs/verify/head\n\nPACK`,
    );
    const pyCheck = spawnSync(
      'python3',
      [
        '-c',
        `import importlib.util, json; spec=importlib.util.spec_from_file_location("gr", ${JSON.stringify(GUEST_RUNNER_PY)}); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); ok=mod.verify_bundle_header(${JSON.stringify(goodBundle)}, ${JSON.stringify(oidA)}, ${JSON.stringify(oidB)}); print(json.dumps(ok))`,
      ],
      { encoding: 'utf8' },
    );
    expect(pyCheck.status, pyCheck.stderr).toBe(0);
    expect(JSON.parse(pyCheck.stdout).headerVerified).toBe(true);

    const pyBad = spawnSync(
      'python3',
      [
        '-c',
        `import importlib.util; spec=importlib.util.spec_from_file_location("gr", ${JSON.stringify(GUEST_RUNNER_PY)}); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); mod.verify_bundle_header(${JSON.stringify(goodBundle)}, ${JSON.stringify(oidA)}, ${JSON.stringify('c'.repeat(40))})`,
      ],
      { encoding: 'utf8' },
    );
    expect(pyBad.status).toBe(1);
    expect(pyBad.stderr).toMatch(/bundle header missing required OIDs/);
  });

  it.skipIf(process.platform === 'win32')(
    'drives the full 7-step guest-runner lifecycle end to end through runHardwareRound (input 53 + model proxy 54 + collector 52 + verify-pr-check)',
    async () => {
      const root = makeTempDir('vgr-e2e-');
      const repoDir = join(root, 'repo');
      const { baseRefOid, headRefOid } = makeTwoCommitRepo(repoDir);
      const ctx = makeHostContext(root, baseRefOid, headRefOid);

      const goldenKernel = join(root, 'golden-vmlinuz');
      const goldenRootfs = join(root, 'golden-rootfs.ext4');
      writeFileSync(goldenKernel, 'kernel-bytes', { mode: 0o444 });
      writeFileSync(goldenRootfs, 'rootfs-bytes', { mode: 0o444 });

      const fakeSysNet = join(root, 'sys-net');
      mkdirSync(join(fakeSysNet, 'lo'), { recursive: true });
      const fakeMounts = join(root, 'mounts');
      writeFileSync(fakeMounts, 'tmpfs /run tmpfs rw 0 0\n');
      const urandomSink = join(root, 'urandom-sink');
      const entropyHex = 'ab'.repeat(32);

      let seenAuthHeader = null;
      let upstreamHits = 0;
      const upstream = http.createServer((req, res) => {
        upstreamHits += 1;
        seenAuthHeader = req.headers.authorization;
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, model: 'fixture-upstream' }));
        });
      });
      await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
      cleanups.push(() => upstream.close());
      const { port } = upstream.address();

      const currentUid =
        typeof process.getuid === 'function' && process.getuid() > 0
          ? process.getuid()
          : 65534;
      const currentGid =
        typeof process.getgid === 'function' && process.getgid() > 0
          ? process.getgid()
          : 65534;
      const plan = buildFirecrackerLaunchPlan({
        runId: 'gr-e2e-1',
        jailBaseDir: join(root, 'j'),
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: currentUid,
        vmmGid: currentGid,
        vsockPort: 52,
        inputVsockPort: 53,
        modelVsockPort: 54,
      });

      const res = await runHardwareRound({
        contextPath: ctx.path,
        contextSha256: ctx.sha256,
        launcherDir: join(root, 'launcher'),
        vaultDir: join(root, 'vault'),
        approvedRoots: [root],
        plan,
        backendVersion: 'guest-runner-test',
        sourceKernelPath: goldenKernel,
        sourceRootfsPath: goldenRootfs,
        stageAssets: true,
        applyChown: false,
        roundInput: {
          repoDir,
          baseRefOid,
          headRefOid,
          entropyHex,
        },
        modelProxy: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'host-real-upstream-secret',
          maxRequests: 4,
        },
        collectorOptions: {
          allowedFiles: new Set([
            'report.md',
            'verdict.txt',
            'assertions.json',
            'comment.md',
            'logs/guest-runtime.json',
          ]),
        },
        launchBackend: async ({
          collectorSocketPath,
          inputSocketPath,
          proxyInfo,
        }) => {
          const guestWorkDir = join(root, 'guest-work');
          const child = spawn(
            'python3',
            [
              GUEST_RUNNER_PY,
              '--vsock-script',
              GUEST_VSOCK_PY,
              '--work-dir',
              guestWorkDir,
              '--unix-collector',
              collectorSocketPath,
              '--unix-input',
              inputSocketPath,
              '--unix-model',
              proxyInfo.socketPath,
              '--urandom-path',
              urandomSink,
              '--sys-net-dir',
              fakeSysNet,
              '--proc-mounts',
              fakeMounts,
            ],
            { stdio: 'pipe' },
          );
          let stderr = '';
          child.stderr.on('data', (d) => {
            stderr += d.toString('utf8');
          });
          await new Promise((resolveExit, rejectExit) => {
            child.once('error', rejectExit);
            child.once('exit', (code) => {
              if (code === 0) resolveExit();
              else rejectExit(new Error(`guest-runner rc=${code}: ${stderr}`));
            });
          });
          return {
            workerPid: child.pid,
            supervisorPid: child.pid,
            workerExe: 'python3',
            expectedExeTokens: ['python'],
            child,
          };
        },
      });

      expect(res.errors).toEqual([]);
      expect(res.ok).toBe(true);
      expect(res.outputStatus).toBe('complete');
      expect(res.teardownStatus).toBe('destroyed');
      expect(res.checkExitCode).toBe(0);
      expect(upstreamHits).toBe(1);
      expect(seenAuthHeader).toBe('Bearer host-real-upstream-secret');
      expect(readFileSync(urandomSink).toString('hex')).toBe(entropyHex);

      const runtimeLog = JSON.parse(
        readFileSync(join(root, 'vault', 'logs', 'guest-runtime.json'), 'utf8'),
      );
      expect(runtimeLog.isolation.noNic).toBe(true);
      expect(runtimeLog.isolation.hasDirectoryShare).toBe(false);
      expect(runtimeLog.modelProbeStatus).toBe(200);
      expect(runtimeLog.materialized.baseRefOid).toBe(baseRefOid);
      expect(runtimeLog.materialized.headRefOid).toBe(headRefOid);
      expect(runtimeLog.materialized.changedFiles).toEqual(['hello.txt']);
      expect(existsSync(join(root, 'vault', 'boundary.json'))).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'strips host secrets from custom workload env, flags non-loopback NIC/shared mounts as needs-changes, and fails closed on nonce mismatch',
    async () => {
      const root = makeTempDir('vgr-neg-');
      const repoDir = join(root, 'repo');
      const { baseRefOid, headRefOid } = makeTwoCommitRepo(repoDir);
      const ctx = makeHostContext(root, baseRefOid, headRefOid);

      const goldenKernel = join(root, 'k');
      const goldenRootfs = join(root, 'r');
      writeFileSync(goldenKernel, 'k', { mode: 0o444 });
      writeFileSync(goldenRootfs, 'r', { mode: 0o444 });

      const currentUid =
        typeof process.getuid === 'function' && process.getuid() > 0
          ? process.getuid()
          : 65534;
      const currentGid =
        typeof process.getgid === 'function' && process.getgid() > 0
          ? process.getgid()
          : 65534;

      // 1. Custom workload receives stripped env (no host SECRET_HOST_TOKEN) and materialized HEAD
      const workload = join(root, 'workload.sh');
      writeFileSync(
        workload,
        [
          '#!/bin/sh',
          'set -eu',
          'if [ -n "${SECRET_HOST_TOKEN:-}" ]; then exit 99; fi',
          'CONTENT=$(cat "$QWEN_VERIFY_WORKSPACE/hello.txt")',
          'mkdir -p "$QWEN_VERIFY_ARTIFACTS_DIR/logs"',
          'printf "%s\\n" "$CONTENT" > "$QWEN_VERIFY_ARTIFACTS_DIR/logs/head-file.txt"',
          'printf "merge-ready\\n" > "$QWEN_VERIFY_ARTIFACTS_DIR/verdict.txt"',
          'printf \'{"pass":1,"fail":0,"total":1}\\n\' > "$QWEN_VERIFY_ARTIFACTS_DIR/assertions.json"',
          'printf "merge-ready · 1 passed · 0 failed · 1 total · %s\\n\\n## Methodology\\n\\n**Boundary.** microvm.\\n" "$QWEN_VERIFY_HEAD_OID" > "$QWEN_VERIFY_ARTIFACTS_DIR/report.md"',
          'printf "merge-ready\\n\\n_— w via Qwen Code /verify-pr (v0.28.7; skill test)_\\n" > "$QWEN_VERIFY_ARTIFACTS_DIR/comment.md"',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      chmodSync(workload, 0o755);

      const plan1 = buildFirecrackerLaunchPlan({
        runId: 'gr-wl-1',
        jailBaseDir: join(root, 'j'),
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: currentUid,
        vmmGid: currentGid,
        vsockPort: 52,
        inputVsockPort: 53,
      });

      const wlRes = await runHardwareRound({
        contextPath: ctx.path,
        contextSha256: ctx.sha256,
        launcherDir: join(root, 'l1'),
        vaultDir: join(root, 'v1'),
        approvedRoots: [root],
        plan: plan1,
        sourceKernelPath: goldenKernel,
        sourceRootfsPath: goldenRootfs,
        stageAssets: true,
        applyChown: false,
        roundInput: { repoDir, baseRefOid, headRefOid },
        collectorOptions: {
          allowedFiles: new Set([
            'report.md',
            'verdict.txt',
            'assertions.json',
            'comment.md',
            'logs/head-file.txt',
          ]),
        },
        launchBackend: async ({ collectorSocketPath, inputSocketPath }) => {
          const child = spawn(
            'python3',
            [
              GUEST_RUNNER_PY,
              '--vsock-script',
              GUEST_VSOCK_PY,
              '--work-dir',
              join(root, 'gw1'),
              '--unix-collector',
              collectorSocketPath,
              '--unix-input',
              inputSocketPath,
              '--workload',
              workload,
              '--urandom-path',
              join(root, 'ur1'),
            ],
            {
              stdio: 'pipe',
              env: { ...process.env, SECRET_HOST_TOKEN: 'must-not-leak' },
            },
          );
          let stderr = '';
          child.stderr.on('data', (d) => {
            stderr += d.toString('utf8');
          });
          await new Promise((ok, fail) => {
            child.once('error', fail);
            child.once('exit', (code) =>
              code === 0 ? ok() : fail(new Error(`rc=${code}: ${stderr}`)),
            );
          });
          return {
            workerPid: child.pid,
            supervisorPid: child.pid,
            workerExe: 'python3',
            expectedExeTokens: ['python'],
            child,
          };
        },
      });
      expect(wlRes.errors).toEqual([]);
      expect(wlRes.ok).toBe(true);
      expect(
        readFileSync(join(root, 'v1', 'logs', 'head-file.txt'), 'utf8').trim(),
      ).toBe('head-v2-verified');

      // 2. Non-loopback NIC + virtiofs mount must fail self-test isolation checks
      const badNet = join(root, 'bad-net');
      mkdirSync(join(badNet, 'lo'), { recursive: true });
      mkdirSync(join(badNet, 'eth0'), { recursive: true });
      const badMounts = join(root, 'bad-mounts');
      writeFileSync(badMounts, 'hostshare /mnt/host virtiofs rw 0 0\n');

      const plan2 = buildFirecrackerLaunchPlan({
        runId: 'gr-iso-1',
        jailBaseDir: join(root, 'j'),
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: currentUid,
        vmmGid: currentGid,
        vsockPort: 52,
        inputVsockPort: 53,
      });
      const isoRes = await runHardwareRound({
        contextPath: ctx.path,
        contextSha256: ctx.sha256,
        launcherDir: join(root, 'l2'),
        vaultDir: join(root, 'v2'),
        approvedRoots: [root],
        plan: plan2,
        sourceKernelPath: goldenKernel,
        sourceRootfsPath: goldenRootfs,
        stageAssets: true,
        applyChown: false,
        roundInput: { repoDir, baseRefOid, headRefOid },
        collectorOptions: {
          allowedFiles: new Set([
            'report.md',
            'verdict.txt',
            'assertions.json',
            'comment.md',
            'logs/guest-runtime.json',
          ]),
        },
        runChecker: false,
        launchBackend: async ({ collectorSocketPath, inputSocketPath }) => {
          const child = spawn(
            'python3',
            [
              GUEST_RUNNER_PY,
              '--vsock-script',
              GUEST_VSOCK_PY,
              '--work-dir',
              join(root, 'gw2'),
              '--unix-collector',
              collectorSocketPath,
              '--unix-input',
              inputSocketPath,
              '--urandom-path',
              join(root, 'ur2'),
              '--sys-net-dir',
              badNet,
              '--proc-mounts',
              badMounts,
            ],
            { stdio: 'pipe' },
          );
          await new Promise((ok, fail) => {
            child.once('error', fail);
            child.once('exit', (code) =>
              code === 0 ? ok() : fail(new Error(`rc=${code}`)),
            );
          });
          return {
            workerPid: child.pid,
            supervisorPid: child.pid,
            workerExe: 'python3',
            expectedExeTokens: ['python'],
            child,
          };
        },
      });
      expect(isoRes.ok).toBe(true);
      expect(readFileSync(join(root, 'v2', 'verdict.txt'), 'utf8').trim()).toBe(
        'needs-changes',
      );
      const badRuntime = JSON.parse(
        readFileSync(join(root, 'v2', 'logs', 'guest-runtime.json'), 'utf8'),
      );
      expect(badRuntime.isolation.noNic).toBe(false);
      expect(badRuntime.isolation.hasDirectoryShare).toBe(true);

      // 3. Squatter / wrong-nonce model proxy must fail closed BEFORE running workload
      const fakeModelSock = join(root, 'bad-model.sock');
      const squatter = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('squatter-wrong-nonce');
      });
      await new Promise((r) => squatter.listen(fakeModelSock, r));
      cleanups.push(() => squatter.close());

      const markerIfRan = join(root, 'should-not-run.txt');
      const guardedWorkload = join(root, 'guarded-workload.sh');
      writeFileSync(
        guardedWorkload,
        `#!/bin/sh\nprintf "ran" > "${markerIfRan}"\n`,
        { mode: 0o755 },
      );
      chmodSync(guardedWorkload, 0o755);

      const plan3 = buildFirecrackerLaunchPlan({
        runId: 'gr-nonce-1',
        jailBaseDir: join(root, 'j'),
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: currentUid,
        vmmGid: currentGid,
        vsockPort: 52,
        inputVsockPort: 53,
        modelVsockPort: 54,
      });
      let nonceStderr = '';
      const nonceRes = await runHardwareRound({
        contextPath: ctx.path,
        contextSha256: ctx.sha256,
        launcherDir: join(root, 'l3'),
        vaultDir: join(root, 'v3'),
        approvedRoots: [root],
        plan: plan3,
        sourceKernelPath: goldenKernel,
        sourceRootfsPath: goldenRootfs,
        stageAssets: true,
        applyChown: false,
        roundInput: { repoDir, baseRefOid, headRefOid },
        modelProxy: {
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'unused-key',
          maxRequests: 1,
        },
        runChecker: false,
        launchBackend: async ({ collectorSocketPath, inputSocketPath }) => {
          const child = spawn(
            'python3',
            [
              GUEST_RUNNER_PY,
              '--vsock-script',
              GUEST_VSOCK_PY,
              '--work-dir',
              join(root, 'gw3'),
              '--unix-collector',
              collectorSocketPath,
              '--unix-input',
              inputSocketPath,
              '--unix-model',
              fakeModelSock,
              '--workload',
              guardedWorkload,
              '--urandom-path',
              join(root, 'ur3'),
            ],
            { stdio: 'pipe' },
          );
          child.stderr.on('data', (d) => {
            nonceStderr += d.toString('utf8');
          });
          await new Promise((ok, fail) => {
            child.once('error', fail);
            child.once('exit', (code) =>
              code === 0
                ? ok()
                : fail(new Error(`guest-runner rc=${code}: ${nonceStderr}`)),
            );
          });
          return {
            workerPid: child.pid,
            supervisorPid: child.pid,
            workerExe: 'python3',
            expectedExeTokens: ['python'],
            child,
          };
        },
      });
      expect(nonceRes.ok).toBe(false);
      expect(nonceStderr).toMatch(/\/__health nonce mismatch/);
      expect(existsSync(markerIfRan)).toBe(false);
    },
  );
});
