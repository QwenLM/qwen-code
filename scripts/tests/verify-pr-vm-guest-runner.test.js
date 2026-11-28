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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildFirecrackerLaunchPlan,
  buildVfkitLaunchPlan,
  deriveCollectorAcceptDeadlineMs,
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
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'base']);
  const baseRefOid = git(['rev-parse', 'HEAD']);
  writeFileSync(join(repoDir, 'hello.txt'), 'head-v2-verified\n');
  git(['add', '.']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'head']);
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
    const initSource = readFileSync(GUEST_INIT_SH, 'utf8');
    expect(initSource).toMatch(/export HOME="\/work"/);
    expect(initSource).toMatch(/export TMPDIR="\/work"/);
    expect(initSource).toMatch(/mount -t devpts devpts \/dev\/pts/);
    expect(initSource).toMatch(
      /mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs \/dev\/shm/,
    );

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

    // Positive cmdline override parsing covers every supported qwen.* token
    const goodCmdline = join(root, 'good-cmdline');
    writeFileSync(
      goodCmdline,
      'console=ttyS0 qwen.cid=3 qwen.collector_port=5201 qwen.input_port=5301 qwen.model_port=5401 qwen.workload=/opt/qwen/w.sh qwen.workload_timeout=90 qwen.skill=0123456789ab qwen.skip_materialize=1\n',
    );
    const pyCmdOk = spawnSync(
      'python3',
      [
        '-c',
        `import argparse, importlib.util, json; spec=importlib.util.spec_from_file_location("gr", ${JSON.stringify(GUEST_RUNNER_PY)}); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); ns=argparse.Namespace(from_cmdline=True, cid=2, collector_port=52, input_port=53, model_port=54, workload=None, workload_timeout=mod.DEFAULT_WORKLOAD_TIMEOUT, skill_digest=None, skip_materialize=False, cmdline_file=${JSON.stringify(goodCmdline)}); mod.apply_cmdline_overrides(ns); print(json.dumps({"defaultTimeout": mod.DEFAULT_WORKLOAD_TIMEOUT, "args": vars(ns)}))`,
      ],
      { encoding: 'utf8' },
    );
    expect(pyCmdOk.status, pyCmdOk.stderr).toBe(0);
    const parsedOut = JSON.parse(pyCmdOk.stdout);
    expect(parsedOut.defaultTimeout).toBeLessThan(45);
    const parsedCmd = parsedOut.args;
    expect(parsedCmd.cid).toBe(3);
    expect(parsedCmd.collector_port).toBe(5201);
    expect(parsedCmd.input_port).toBe(5301);
    expect(parsedCmd.model_port).toBe(5401);
    expect(parsedCmd.workload).toBe('/opt/qwen/w.sh');
    expect(parsedCmd.workload_timeout).toBe(90);
    expect(parsedCmd.skill_digest).toBe('0123456789ab');
    expect(parsedCmd.skip_materialize).toBe(true);

    const badSkillCmdline = join(root, 'bad-skill-cmdline');
    writeFileSync(badSkillCmdline, 'qwen.skill=nothex123456\n');
    const badSkillRes = spawnSync(
      'python3',
      [GUEST_RUNNER_PY, '--from-cmdline', '--cmdline-file', badSkillCmdline],
      { encoding: 'utf8' },
    );
    expect(badSkillRes.status).toBe(1);
    expect(badSkillRes.stderr).toMatch(/invalid cmdline qwen\.skill/);

    const badPortCmdline = join(root, 'bad-port-cmdline');
    writeFileSync(badPortCmdline, 'qwen.collector_port=70000\n');
    const badPortRes = spawnSync(
      'python3',
      [GUEST_RUNNER_PY, '--from-cmdline', '--cmdline-file', badPortCmdline],
      { encoding: 'utf8' },
    );
    expect(badPortRes.status).toBe(1);
    expect(badPortRes.stderr).toMatch(/expected port in 1\.\.65535/);

    // deriveCollectorAcceptDeadlineMs aligns collector accept window with qwen.workload_timeout
    // including real buildVfkitLaunchPlan plans where cmdline="..." wraps the token at start or end.
    expect(
      deriveCollectorAcceptDeadlineMs(
        {
          vmConfig: {
            'boot-source': {
              boot_args: 'console=ttyS0 qwen.workload_timeout=120',
            },
          },
        },
        {},
      ),
    ).toBe(150_000);
    const vfBaseOpts = {
      pocDir: join(root, 'vf-poc'),
      socketDir: join(root, 'vf-sock'),
      homeDir: join(root, 'vf-home'),
      tmpDir: join(root, 'vf-tmp'),
      vfkitBin: '/opt/homebrew/bin/vfkit',
      seatbeltProfile: join(root, 'vf.sb'),
      kernelPath: join(root, 'vf-poc', 'vmlinuz'),
      initramfsPath: join(root, 'vf-poc', 'initramfs.gz'),
      rootfsPath: join(root, 'vf-poc', 'work.img'),
      guestLogPath: join(root, 'vf-poc', 'guest.log'),
      pidFile: join(root, 'vf-poc', 'vfkit.pid'),
    };
    const realVfkitTailPlan = buildVfkitLaunchPlan({
      ...vfBaseOpts,
      runId: 'vf-tail-90',
      cmdline: 'console=hvc0 root=/dev/vda rw qwen.workload_timeout=90',
    });
    expect(deriveCollectorAcceptDeadlineMs(realVfkitTailPlan, {})).toBe(
      120_000,
    );
    const realVfkitHeadPlan = buildVfkitLaunchPlan({
      ...vfBaseOpts,
      runId: 'vf-head-90',
      cmdline: 'qwen.workload_timeout=90 console=hvc0 root=/dev/vda rw',
    });
    expect(deriveCollectorAcceptDeadlineMs(realVfkitHeadPlan, {})).toBe(
      120_000,
    );
    expect(
      deriveCollectorAcceptDeadlineMs(
        { bootArgs: 'qwen.workload_timeout=120' },
        { acceptDeadlineMs: 5000 },
      ),
    ).toBe(5000);
    expect(
      deriveCollectorAcceptDeadlineMs({ bootArgs: 'console=ttyS0' }, {}),
    ).toBeUndefined();

    // Malformed non-JSON model-bridge announcement terminates child process instead of leaking it
    const badBridgeScript = join(root, 'bad-bridge.py');
    const badBridgePidFile = join(root, 'bad-bridge.pid');
    writeFileSync(
      badBridgeScript,
      [
        'import os, time',
        `open(${JSON.stringify(badBridgePidFile)}, "w").write(str(os.getpid()))`,
        'print("not-valid-json", flush=True)',
        'time.sleep(30)',
      ].join('\n') + '\n',
      { mode: 0o755 },
    );
    const pyBadBridge = spawnSync(
      'python3',
      [
        '-c',
        `import importlib.util, os, sys; spec=importlib.util.spec_from_file_location("gr", ${JSON.stringify(GUEST_RUNNER_PY)}); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)\ntry:\n  mod.start_model_bridge(${JSON.stringify(badBridgeScript)}, cid=2, model_port=54)\n  sys.exit(2)\nexcept RuntimeError as e:\n  assert "non-JSON" in str(e), str(e)\n`,
      ],
      { encoding: 'utf8' },
    );
    expect(pyBadBridge.status, pyBadBridge.stderr).toBe(0);
    const leakedPid = Number(readFileSync(badBridgePidFile, 'utf8').trim());
    let stillAlive = false;
    try {
      process.kill(leakedPid, 0);
      stillAlive = true;
    } catch {
      stillAlive = false;
    }
    expect(stillAlive).toBe(false);

    // Pure-Python bundle header check: accepts advertised base/head and
    // incremental `-<base>` prerequisite, but rejects `-<head>` prerequisite-only bundles.
    const goodBundle = join(root, 'good.bundle');
    const incrBundle = join(root, 'incr.bundle');
    const headPrereqBundle = join(root, 'head-prereq.bundle');
    const oidA = 'a'.repeat(40);
    const oidB = 'b'.repeat(40);
    writeFileSync(
      goodBundle,
      `# v2 git bundle\n${oidA} refs/verify/base\n${oidB} refs/verify/head\n\nPACK`,
    );
    writeFileSync(
      incrBundle,
      `# v2 git bundle\n-${oidA} base commit\n${oidB} refs/verify/head\n\nPACK`,
    );
    writeFileSync(
      headPrereqBundle,
      `# v2 git bundle\n${oidA} refs/verify/base\n-${oidB} head prerequisite only\n\nPACK`,
    );
    const pyCheck = spawnSync(
      'python3',
      [
        '-c',
        `import importlib.util, json; spec=importlib.util.spec_from_file_location("gr", ${JSON.stringify(GUEST_RUNNER_PY)}); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); ok1=mod.verify_bundle_header(${JSON.stringify(goodBundle)}, ${JSON.stringify(oidA)}, ${JSON.stringify(oidB)}); ok2=mod.verify_bundle_header(${JSON.stringify(incrBundle)}, ${JSON.stringify(oidA)}, ${JSON.stringify(oidB)}); print(json.dumps({"ok1": ok1, "ok2": ok2}))`,
      ],
      { encoding: 'utf8' },
    );
    expect(pyCheck.status, pyCheck.stderr).toBe(0);
    const pyOut = JSON.parse(pyCheck.stdout);
    expect(pyOut.ok1.headerVerified).toBe(true);
    expect(pyOut.ok1.verified).toBe(true);
    expect(pyOut.ok2.headerVerified).toBe(true);
    expect(pyOut.ok2.verified).toBe(true);

    const pyHeadPrereq = spawnSync(
      'python3',
      [
        '-c',
        `import importlib.util; spec=importlib.util.spec_from_file_location("gr", ${JSON.stringify(GUEST_RUNNER_PY)}); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); mod.verify_bundle_header(${JSON.stringify(headPrereqBundle)}, ${JSON.stringify(oidA)}, ${JSON.stringify(oidB)})`,
      ],
      { encoding: 'utf8' },
    );
    expect(pyHeadPrereq.status).toBe(1);
    expect(pyHeadPrereq.stderr).toMatch(/bundle header missing required OIDs/);

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

    // Missing /sys/class/net and /proc/mounts must fail closed (noNic=false, hasDirectoryShare=true)
    const pyMissingIso = spawnSync(
      'python3',
      [
        '-c',
        `import importlib.util, json; spec=importlib.util.spec_from_file_location("gr", ${JSON.stringify(GUEST_RUNNER_PY)}); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); print(json.dumps(mod.inspect_guest_isolation(${JSON.stringify(join(root, 'missing-net'))}, ${JSON.stringify(join(root, 'missing-mounts'))})))`,
      ],
      { encoding: 'utf8' },
    );
    expect(pyMissingIso.status, pyMissingIso.stderr).toBe(0);
    const missingIso = JSON.parse(pyMissingIso.stdout);
    expect(missingIso.netInspected).toBe(false);
    expect(missingIso.mountsInspected).toBe(false);
    expect(missingIso.noNic).toBe(false);
    expect(missingIso.hasDirectoryShare).toBe(true);
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
      // R3-1(a): No-workload self-test MUST emit inconclusive (never merge-ready)
      expect(
        readFileSync(join(root, 'vault', 'verdict.txt'), 'utf8').trim(),
      ).toBe('inconclusive');
      const selfAssertions = JSON.parse(
        readFileSync(join(root, 'vault', 'assertions.json'), 'utf8'),
      );
      expect(selfAssertions.failures.map((f) => f.id)).toEqual([
        'workload-completed',
      ]);

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
    'strips host secrets, passes verify-pr-check on inconclusive failures, gates workload on isolation/entropy, supports skip-materialize+workload, honors manifest.modelProxy.port, and uploads error diagnostics in finally',
    async () => {
      const root = makeTempDir('vgr-neg-');
      const repoDir = join(root, 'repo');
      const { baseRefOid, headRefOid } = makeTwoCommitRepo(repoDir);
      const ctx = makeHostContext(root, baseRefOid, headRefOid);

      const goldenKernel = join(root, 'k');
      const goldenRootfs = join(root, 'r');
      writeFileSync(goldenKernel, 'k', { mode: 0o444 });
      writeFileSync(goldenRootfs, 'r', { mode: 0o444 });

      const cleanNet = join(root, 'clean-net');
      mkdirSync(join(cleanNet, 'lo'), { recursive: true });
      const cleanMounts = join(root, 'clean-mounts');
      writeFileSync(cleanMounts, 'tmpfs /run tmpfs rw 0 0\n');

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
              '--sys-net-dir',
              cleanNet,
              '--proc-mounts',
              cleanMounts,
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
      expect(existsSync(join(root, 'v1', 'logs', 'guest-runtime.json'))).toBe(
        true,
      );

      // 2. Non-loopback NIC + virtiofs mount + unwritable urandom must emit `inconclusive`
      // with harness attribution and PASS verify-pr-check (`runChecker: true`)
      const badNet = join(root, 'bad-net');
      mkdirSync(join(badNet, 'lo'), { recursive: true });
      mkdirSync(join(badNet, 'eth0'), { recursive: true });
      const badMounts = join(root, 'bad-mounts');
      writeFileSync(badMounts, 'hostshare /mnt/host virtiofs rw 0 0\n');
      const unwritableUrandom = join(root, 'urandom-is-a-dir');
      mkdirSync(unwritableUrandom);

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
        runChecker: true,
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
              unwritableUrandom,
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
      expect(isoRes.errors).toEqual([]);
      expect(isoRes.ok).toBe(true);
      expect(isoRes.checkExitCode).toBe(0);
      expect(readFileSync(join(root, 'v2', 'verdict.txt'), 'utf8').trim()).toBe(
        'inconclusive',
      );
      const isoAssertions = JSON.parse(
        readFileSync(join(root, 'v2', 'assertions.json'), 'utf8'),
      );
      expect(isoAssertions.failures.map((f) => f.id)).toEqual([
        'entropy-injected',
        'guest-no-nic',
        'guest-no-directory-share',
        'workload-completed',
      ]);
      expect(
        isoAssertions.failures.every((f) => f.attribution === 'harness'),
      ).toBe(true);
      const badRuntime = JSON.parse(
        readFileSync(join(root, 'v2', 'logs', 'guest-runtime.json'), 'utf8'),
      );
      expect(badRuntime.entropy.written).toBe(false);
      expect(badRuntime.isolation.noNic).toBe(false);
      expect(badRuntime.isolation.hasDirectoryShare).toBe(true);

      // 3. Workload mode MUST refuse launch on isolation/entropy breach AND upload inconclusive diagnostics
      const breachMarker = join(root, 'breach-workload-ran.txt');
      const breachWorkload = join(root, 'breach-workload.sh');
      writeFileSync(
        breachWorkload,
        `#!/bin/sh\nprintf "ran" > "${breachMarker}"\n`,
        { mode: 0o755 },
      );
      chmodSync(breachWorkload, 0o755);

      const planBreach = buildFirecrackerLaunchPlan({
        runId: 'gr-breach-1',
        jailBaseDir: join(root, 'j'),
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: currentUid,
        vmmGid: currentGid,
        vsockPort: 52,
        inputVsockPort: 53,
      });
      let breachStderr = '';
      const breachRes = await runHardwareRound({
        contextPath: ctx.path,
        contextSha256: ctx.sha256,
        launcherDir: join(root, 'l-breach'),
        vaultDir: join(root, 'v-breach'),
        approvedRoots: [root],
        plan: planBreach,
        sourceKernelPath: goldenKernel,
        sourceRootfsPath: goldenRootfs,
        stageAssets: true,
        applyChown: false,
        roundInput: { repoDir, baseRefOid, headRefOid },
        runChecker: false,
        launchBackend: async ({ collectorSocketPath, inputSocketPath }) => {
          const child = spawn(
            'python3',
            [
              GUEST_RUNNER_PY,
              '--vsock-script',
              GUEST_VSOCK_PY,
              '--work-dir',
              join(root, 'gw-breach'),
              '--unix-collector',
              collectorSocketPath,
              '--unix-input',
              inputSocketPath,
              '--workload',
              breachWorkload,
              '--urandom-path',
              unwritableUrandom,
              '--sys-net-dir',
              badNet,
              '--proc-mounts',
              badMounts,
            ],
            { stdio: 'pipe' },
          );
          child.stderr.on('data', (d) => {
            breachStderr += d.toString('utf8');
          });
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
      expect(breachRes.ok).toBe(false);
      expect(breachStderr).toMatch(/guest isolation breach/);
      expect(existsSync(breachMarker)).toBe(false);
      // Diagnostics were still uploaded via finally block
      expect(
        readFileSync(join(root, 'v-breach', 'verdict.txt'), 'utf8').trim(),
      ).toBe('inconclusive');
      const breachLog = JSON.parse(
        readFileSync(
          join(root, 'v-breach', 'logs', 'guest-runtime.json'),
          'utf8',
        ),
      );
      expect(breachLog.error).toMatch(/guest isolation breach/);

      // 4. --skip-materialize + --workload creates repoDir so cwd does not raise ENOENT
      const skipWorkload = join(root, 'skip-workload.sh');
      writeFileSync(
        skipWorkload,
        [
          '#!/bin/sh',
          'set -eu',
          'test -d "$QWEN_VERIFY_WORKSPACE"',
          'printf "merge-ready\\n" > "$QWEN_VERIFY_ARTIFACTS_DIR/verdict.txt"',
          'printf \'{"pass":1,"fail":0,"total":1}\\n\' > "$QWEN_VERIFY_ARTIFACTS_DIR/assertions.json"',
          'printf "merge-ready · 1 passed · 0 failed · 1 total · %s\\n\\n## Methodology\\n\\n**Boundary.** microvm.\\n" "$QWEN_VERIFY_HEAD_OID" > "$QWEN_VERIFY_ARTIFACTS_DIR/report.md"',
          'printf "merge-ready\\n\\n_— w via Qwen Code /verify-pr (v0.28.7; skill test)_\\n" > "$QWEN_VERIFY_ARTIFACTS_DIR/comment.md"',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      chmodSync(skipWorkload, 0o755);

      const planSkip = buildFirecrackerLaunchPlan({
        runId: 'gr-skip-wl',
        jailBaseDir: join(root, 'j'),
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: currentUid,
        vmmGid: currentGid,
        vsockPort: 52,
        inputVsockPort: 53,
      });
      const skipRes = await runHardwareRound({
        contextPath: ctx.path,
        contextSha256: ctx.sha256,
        launcherDir: join(root, 'l-skip'),
        vaultDir: join(root, 'v-skip'),
        approvedRoots: [root],
        plan: planSkip,
        sourceKernelPath: goldenKernel,
        sourceRootfsPath: goldenRootfs,
        stageAssets: true,
        applyChown: false,
        roundInput: { repoDir, baseRefOid, headRefOid },
        launchBackend: async ({ collectorSocketPath, inputSocketPath }) => {
          const child = spawn(
            'python3',
            [
              GUEST_RUNNER_PY,
              '--vsock-script',
              GUEST_VSOCK_PY,
              '--work-dir',
              join(root, 'gw-skip'),
              '--unix-collector',
              collectorSocketPath,
              '--unix-input',
              inputSocketPath,
              '--skip-materialize',
              '--workload',
              skipWorkload,
              '--urandom-path',
              join(root, 'ur-skip'),
              '--sys-net-dir',
              cleanNet,
              '--proc-mounts',
              cleanMounts,
            ],
            { stdio: 'pipe' },
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
      expect(skipRes.errors).toEqual([]);
      expect(skipRes.ok).toBe(true);
      expect(skipRes.checkExitCode).toBe(0);

      // 5. Squatter / wrong-nonce model proxy must fail closed BEFORE running workload
      // and still upload failure diagnostics to the host collector via `finally`.
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
              '--sys-net-dir',
              cleanNet,
              '--proc-mounts',
              cleanMounts,
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
      expect(readFileSync(join(root, 'v3', 'verdict.txt'), 'utf8').trim()).toBe(
        'inconclusive',
      );
      const nonceLog = JSON.parse(
        readFileSync(join(root, 'v3', 'logs', 'guest-runtime.json'), 'utf8'),
      );
      expect(nonceLog.error).toMatch(/\/__health nonce mismatch/);
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'honors negotiated manifest.modelProxy.port over CLI --model-port default on the vsock model-bridge path',
    async () => {
      const root = makeTempDir('vgr-port-');
      const repoDir = join(root, 'repo');
      const { baseRefOid, headRefOid } = makeTwoCommitRepo(repoDir);
      const ctx = makeHostContext(root, baseRefOid, headRefOid);

      const goldenKernel = join(root, 'k');
      const goldenRootfs = join(root, 'r');
      writeFileSync(goldenKernel, 'k', { mode: 0o444 });
      writeFileSync(goldenRootfs, 'r', { mode: 0o444 });

      const cleanNet = join(root, 'clean-net');
      mkdirSync(join(cleanNet, 'lo'), { recursive: true });
      const cleanMounts = join(root, 'clean-mounts');
      writeFileSync(cleanMounts, 'tmpfs /run tmpfs rw 0 0\n');

      const currentUid =
        typeof process.getuid === 'function' && process.getuid() > 0
          ? process.getuid()
          : 65534;
      const currentGid =
        typeof process.getgid === 'function' && process.getgid() > 0
          ? process.getgid()
          : 65534;

      const portProbeScript = join(root, 'fake-vsock-port-capture.py');
      const capturedPortFile = join(root, 'captured-model-port.txt');
      writeFileSync(
        portProbeScript,
        [
          '#!/usr/bin/env python3',
          'import importlib.util, os, sys',
          `spec = importlib.util.spec_from_file_location("real_vsock", ${JSON.stringify(GUEST_VSOCK_PY)})`,
          'real = importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(real)',
          'cmd_fetch_inputs = real.cmd_fetch_inputs',
          'cmd_upload_artifacts = real.cmd_upload_artifacts',
          'if __name__ == "__main__":',
          '    argv = list(sys.argv[1:])',
          '    if argv and argv[0] == "model-bridge":',
          '        rewritten = []',
          '        i = 0',
          '        while i < len(argv):',
          '            if argv[i] == "--port" and i + 1 < len(argv):',
          `                open(${JSON.stringify(capturedPortFile)}, "w").write(argv[i + 1])`,
          '                i += 2',
          '                continue',
          '            if argv[i] == "--cid" and i + 1 < len(argv):',
          '                i += 2',
          '                continue',
          '            rewritten.append(argv[i])',
          '            i += 1',
          '        rewritten.extend(["--unix", os.environ["TEST_UNIX_MODEL_SOCK"]])',
          '        argv = rewritten',
          '    sys.exit(real.main(argv))',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );

      const planPort = buildFirecrackerLaunchPlan({
        runId: 'gr-port-1',
        jailBaseDir: join(root, 'j'),
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: currentUid,
        vmmGid: currentGid,
        vsockPort: 52,
        inputVsockPort: 53,
        modelVsockPort: 5401,
      });
      const portUpstream = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
      });
      await new Promise((r) => portUpstream.listen(0, '127.0.0.1', r));
      cleanups.push(() => portUpstream.close());
      const portUpPort = portUpstream.address().port;

      const portRes = await runHardwareRound({
        contextPath: ctx.path,
        contextSha256: ctx.sha256,
        launcherDir: join(root, 'l-port'),
        vaultDir: join(root, 'v-port'),
        approvedRoots: [root],
        plan: planPort,
        sourceKernelPath: goldenKernel,
        sourceRootfsPath: goldenRootfs,
        stageAssets: true,
        applyChown: false,
        roundInput: { repoDir, baseRefOid, headRefOid },
        modelProxy: {
          baseUrl: `http://127.0.0.1:${portUpPort}/v1`,
          apiKey: 'port-test-secret',
          maxRequests: 2,
        },
        launchBackend: async ({
          collectorSocketPath,
          inputSocketPath,
          proxyInfo,
        }) => {
          const child = spawn(
            'python3',
            [
              GUEST_RUNNER_PY,
              '--vsock-script',
              portProbeScript,
              '--work-dir',
              join(root, 'gw-port'),
              '--unix-collector',
              collectorSocketPath,
              '--unix-input',
              inputSocketPath,
              '--model-port',
              '54',
              '--urandom-path',
              join(root, 'ur-port'),
              '--sys-net-dir',
              cleanNet,
              '--proc-mounts',
              cleanMounts,
            ],
            {
              stdio: 'pipe',
              env: {
                ...process.env,
                TEST_UNIX_MODEL_SOCK: proxyInfo.socketPath,
              },
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
      expect(portRes.errors).toEqual([]);
      expect(portRes.ok).toBe(true);
      expect(portRes.checkExitCode).toBe(0);
      expect(readFileSync(capturedPortFile, 'utf8').trim()).toBe('5401');
    },
    15_000,
  );

  it.skipIf(process.platform === 'win32')(
    'kills the entire workload process group on timeout and uploads inconclusive diagnostics without spurious model-proxy-probe failure',
    async () => {
      const root = makeTempDir('vgr-pgrp-');
      const repoDir = join(root, 'repo');
      const { baseRefOid, headRefOid } = makeTwoCommitRepo(repoDir);
      const ctx = makeHostContext(root, baseRefOid, headRefOid);

      const goldenKernel = join(root, 'k');
      const goldenRootfs = join(root, 'r');
      writeFileSync(goldenKernel, 'k', { mode: 0o444 });
      writeFileSync(goldenRootfs, 'r', { mode: 0o444 });

      const cleanNet = join(root, 'clean-net');
      mkdirSync(join(cleanNet, 'lo'), { recursive: true });
      const cleanMounts = join(root, 'clean-mounts');
      writeFileSync(cleanMounts, 'tmpfs /run tmpfs rw 0 0\n');

      const childMarker = join(root, 'orphan-wrote-after-timeout.txt');
      const timeoutWorkload = join(root, 'timeout-wl.sh');
      writeFileSync(
        timeoutWorkload,
        [
          '#!/bin/sh',
          `(sleep 2 && printf "orphan" > "${childMarker}") &`,
          'wait',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      chmodSync(timeoutWorkload, 0o755);

      const up = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
      });
      await new Promise((r) => up.listen(0, '127.0.0.1', r));
      cleanups.push(() => up.close());

      const currentUid =
        typeof process.getuid === 'function' && process.getuid() > 0
          ? process.getuid()
          : 65534;
      const currentGid =
        typeof process.getgid === 'function' && process.getgid() > 0
          ? process.getgid()
          : 65534;
      const plan = buildFirecrackerLaunchPlan({
        runId: 'gr-pgrp-1',
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
        launcherDir: join(root, 'l'),
        vaultDir: join(root, 'v'),
        approvedRoots: [root],
        plan,
        sourceKernelPath: goldenKernel,
        sourceRootfsPath: goldenRootfs,
        stageAssets: true,
        applyChown: false,
        runChecker: true,
        roundInput: { repoDir, baseRefOid, headRefOid },
        modelProxy: {
          baseUrl: `http://127.0.0.1:${up.address().port}/v1`,
          apiKey: 'secret-pgrp',
          maxRequests: 2,
        },
        launchBackend: async ({
          collectorSocketPath,
          inputSocketPath,
          proxyInfo,
        }) => {
          const child = spawn(
            'python3',
            [
              GUEST_RUNNER_PY,
              '--vsock-script',
              GUEST_VSOCK_PY,
              '--work-dir',
              join(root, 'gw'),
              '--unix-collector',
              collectorSocketPath,
              '--unix-input',
              inputSocketPath,
              '--unix-model',
              proxyInfo.socketPath,
              '--workload',
              timeoutWorkload,
              '--workload-timeout',
              '1',
              '--urandom-path',
              join(root, 'ur'),
              '--sys-net-dir',
              cleanNet,
              '--proc-mounts',
              cleanMounts,
            ],
            { stdio: 'pipe' },
          );
          await new Promise((ok) => child.once('exit', ok));
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
      expect(res.checkExitCode).toBe(0);
      expect(readFileSync(join(root, 'v', 'verdict.txt'), 'utf8').trim()).toBe(
        'inconclusive',
      );
      const assertions = JSON.parse(
        readFileSync(join(root, 'v', 'assertions.json'), 'utf8'),
      );
      expect(assertions.failures.map((f) => f.id)).toEqual([
        'workload-completed',
        'guest-lifecycle-error',
      ]);
      // Wait past the background child's 2s sleep to confirm SIGKILL reaped the process group
      await new Promise((r) => setTimeout(r, 1500));
      expect(existsSync(childMarker)).toBe(false);
    },
    15_000,
  );

  it.skipIf(process.platform === 'win32')(
    'demotes workload-authored merge-ready verdict to inconclusive on timeout, derives collector acceptDeadlineMs from qwen.workload_timeout, and renders qwen.skill footer only when supplied',
    async () => {
      const root = makeTempDir('vgr-r3-');
      const repoDir = join(root, 'repo');
      const { baseRefOid, headRefOid } = makeTwoCommitRepo(repoDir);
      const ctx = makeHostContext(root, baseRefOid, headRefOid);

      const goldenKernel = join(root, 'k');
      const goldenRootfs = join(root, 'r');
      writeFileSync(goldenKernel, 'k', { mode: 0o444 });
      writeFileSync(goldenRootfs, 'r', { mode: 0o444 });

      const cleanNet = join(root, 'clean-net');
      mkdirSync(join(cleanNet, 'lo'), { recursive: true });
      const cleanMounts = join(root, 'clean-mounts');
      writeFileSync(cleanMounts, 'tmpfs /run tmpfs rw 0 0\n');

      const currentUid =
        typeof process.getuid === 'function' && process.getuid() > 0
          ? process.getuid()
          : 65534;
      const currentGid =
        typeof process.getgid === 'function' && process.getgid() > 0
          ? process.getgid()
          : 65534;

      // 1. R3-1 + yiliang114 P2: Workload writes full merge-ready artifacts, sabotages
      // logs/guest-runtime.json by replacing it with a directory, AND THEN hangs past timeout;
      // runner MUST still overwrite verdict.txt to `inconclusive` + `guest-lifecycle-error`.
      const sneakyWorkload = join(root, 'sneaky-wl.sh');
      writeFileSync(
        sneakyWorkload,
        [
          '#!/bin/sh',
          'set -eu',
          'printf "merge-ready\\n" > "$QWEN_VERIFY_ARTIFACTS_DIR/verdict.txt"',
          'printf \'{"pass":1,"fail":0,"total":1}\\n\' > "$QWEN_VERIFY_ARTIFACTS_DIR/assertions.json"',
          'printf "merge-ready · 1 passed · 0 failed · 1 total · %s\\n\\n## Methodology\\n\\n**Boundary.** microvm.\\n" "$QWEN_VERIFY_HEAD_OID" > "$QWEN_VERIFY_ARTIFACTS_DIR/report.md"',
          'printf "merge-ready\\n" > "$QWEN_VERIFY_ARTIFACTS_DIR/comment.md"',
          'rm -rf "$QWEN_VERIFY_ARTIFACTS_DIR/logs/guest-runtime.json"',
          'mkdir -p "$QWEN_VERIFY_ARTIFACTS_DIR/logs/guest-runtime.json"',
          'sleep 10',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      chmodSync(sneakyWorkload, 0o755);

      const plan1 = buildFirecrackerLaunchPlan({
        runId: 'gr-r3-1',
        jailBaseDir: join(root, 'j'),
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: currentUid,
        vmmGid: currentGid,
        vsockPort: 52,
        inputVsockPort: 53,
      });
      const res1 = await runHardwareRound({
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
        runChecker: true,
        roundInput: { repoDir, baseRefOid, headRefOid },
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
              sneakyWorkload,
              '--workload-timeout',
              '1',
              '--urandom-path',
              join(root, 'ur1'),
              '--sys-net-dir',
              cleanNet,
              '--proc-mounts',
              cleanMounts,
            ],
            { stdio: 'pipe' },
          );
          await new Promise((ok) => child.once('exit', ok));
          return {
            workerPid: child.pid,
            supervisorPid: child.pid,
            workerExe: 'python3',
            expectedExeTokens: ['python'],
            child,
          };
        },
      });
      expect(res1.errors).toEqual([]);
      expect(res1.ok).toBe(true);
      expect(res1.checkExitCode).toBe(0);
      expect(readFileSync(join(root, 'v1', 'verdict.txt'), 'utf8').trim()).toBe(
        'inconclusive',
      );
      const a1 = JSON.parse(
        readFileSync(join(root, 'v1', 'assertions.json'), 'utf8'),
      );
      expect(a1.failures.map((f) => f.id)).toEqual([
        'workload-completed',
        'guest-lifecycle-error',
      ]);
      const rt1 = JSON.parse(
        readFileSync(join(root, 'v1', 'logs', 'guest-runtime.json'), 'utf8'),
      );
      expect(rt1.error).toMatch(/timed out/);

      // 1b. R3-1(b): Workload writes merge-ready AND THEN exits non-zero (exit 7) ->
      // runner MUST demote uploaded artifacts to inconclusive + guest-lifecycle-error.
      const exit7Workload = join(root, 'exit7-wl.sh');
      writeFileSync(
        exit7Workload,
        [
          '#!/bin/sh',
          'set -eu',
          'printf "merge-ready\\n" > "$QWEN_VERIFY_ARTIFACTS_DIR/verdict.txt"',
          'printf \'{"pass":1,"fail":0,"total":1}\\n\' > "$QWEN_VERIFY_ARTIFACTS_DIR/assertions.json"',
          'printf "merge-ready · 1 passed · 0 failed · 1 total · %s\\n\\n## Methodology\\n\\n**Boundary.** microvm.\\n" "$QWEN_VERIFY_HEAD_OID" > "$QWEN_VERIFY_ARTIFACTS_DIR/report.md"',
          'printf "merge-ready\\n" > "$QWEN_VERIFY_ARTIFACTS_DIR/comment.md"',
          'exit 7',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      chmodSync(exit7Workload, 0o755);
      const planExit7 = buildFirecrackerLaunchPlan({
        runId: 'gr-r3-1b',
        jailBaseDir: join(root, 'j'),
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: currentUid,
        vmmGid: currentGid,
        vsockPort: 52,
        inputVsockPort: 53,
      });
      const resExit7 = await runHardwareRound({
        contextPath: ctx.path,
        contextSha256: ctx.sha256,
        launcherDir: join(root, 'l1b'),
        vaultDir: join(root, 'v1b'),
        approvedRoots: [root],
        plan: planExit7,
        sourceKernelPath: goldenKernel,
        sourceRootfsPath: goldenRootfs,
        stageAssets: true,
        applyChown: false,
        runChecker: true,
        roundInput: { repoDir, baseRefOid, headRefOid },
        launchBackend: async ({ collectorSocketPath, inputSocketPath }) => {
          const child = spawn(
            'python3',
            [
              GUEST_RUNNER_PY,
              '--vsock-script',
              GUEST_VSOCK_PY,
              '--work-dir',
              join(root, 'gw1b'),
              '--unix-collector',
              collectorSocketPath,
              '--unix-input',
              inputSocketPath,
              '--workload',
              exit7Workload,
              '--urandom-path',
              join(root, 'ur1b'),
              '--sys-net-dir',
              cleanNet,
              '--proc-mounts',
              cleanMounts,
            ],
            { stdio: 'pipe' },
          );
          await new Promise((ok) => child.once('exit', ok));
          return {
            workerPid: child.pid,
            supervisorPid: child.pid,
            workerExe: 'python3',
            expectedExeTokens: ['python'],
            child,
          };
        },
      });
      expect(resExit7.errors).toEqual([]);
      expect(resExit7.ok).toBe(true);
      expect(resExit7.checkExitCode).toBe(0);
      expect(
        readFileSync(join(root, 'v1b', 'verdict.txt'), 'utf8').trim(),
      ).toBe('inconclusive');
      const aExit7 = JSON.parse(
        readFileSync(join(root, 'v1b', 'assertions.json'), 'utf8'),
      );
      expect(aExit7.failures.map((f) => f.id)).toEqual([
        'workload-completed',
        'guest-lifecycle-error',
      ]);
      const rtExit7 = JSON.parse(
        readFileSync(join(root, 'v1b', 'logs', 'guest-runtime.json'), 'utf8'),
      );
      expect(rtExit7.error).toMatch(/rc=7/);

      // 1c. R3-1(c): Workload spawns a detached setsid descendant that continuously
      // rewrites $QWEN_VERIFY_ARTIFACTS_DIR/verdict.txt=merge-ready past timeout;
      // runner MUST upload demoted inconclusive artifacts from a fresh private dir.
      const setsidWorkload = join(root, 'setsid-wl.py');
      const setsidPidFile = join(root, 'setsid-writer.pid');
      writeFileSync(
        setsidWorkload,
        [
          '#!/usr/bin/env python3',
          'import os, subprocess, sys, time',
          'art = os.environ["QWEN_VERIFY_ARTIFACTS_DIR"]',
          'head = os.environ["QWEN_VERIFY_HEAD_OID"]',
          'writer = f"""import os, time',
          'open({setsidPidFile!r}, "w").write(str(os.getpid()))',
          'end = time.monotonic() + 3.0',
          'while time.monotonic() < end:',
          '    try:',
          '        open({art!r} + "/verdict.txt", "w").write("merge-ready\\\\n")',
          '        open({art!r} + "/assertions.json", "w").write(\'{"pass":1,"fail":0,"total":1}\\\\n\')',
          '        open({art!r} + "/report.md", "w").write("merge-ready · 1 passed · 0 failed · 1 total · " + {head!r} + "\\\\n\\\\n## Methodology\\\\n\\\\n**Boundary.** microvm.\\\\n")',
          '        open({art!r} + "/comment.md", "w").write("merge-ready\\\\n")',
          '    except OSError: pass',
          '    time.sleep(0.01)',
          '"""',
          'subprocess.Popen([sys.executable, "-c", writer], start_new_session=True)',
          'time.sleep(10)',
        ]
          .join('\n')
          .replace('{setsidPidFile!r}', JSON.stringify(setsidPidFile)) + '\n',
        { mode: 0o755 },
      );
      chmodSync(setsidWorkload, 0o755);
      cleanups.push(() => {
        if (existsSync(setsidPidFile)) {
          const pid = Number(readFileSync(setsidPidFile, 'utf8').trim());
          if (Number.isInteger(pid) && pid > 1) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // Already exited.
            }
          }
        }
      });
      const planSetsid = buildFirecrackerLaunchPlan({
        runId: 'gr-r3-1c',
        jailBaseDir: join(root, 'j'),
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: currentUid,
        vmmGid: currentGid,
        vsockPort: 52,
        inputVsockPort: 53,
      });
      const resSetsid = await runHardwareRound({
        contextPath: ctx.path,
        contextSha256: ctx.sha256,
        launcherDir: join(root, 'l1c'),
        vaultDir: join(root, 'v1c'),
        approvedRoots: [root],
        plan: planSetsid,
        sourceKernelPath: goldenKernel,
        sourceRootfsPath: goldenRootfs,
        stageAssets: true,
        applyChown: false,
        runChecker: true,
        roundInput: { repoDir, baseRefOid, headRefOid },
        launchBackend: async ({ collectorSocketPath, inputSocketPath }) => {
          const child = spawn(
            'python3',
            [
              GUEST_RUNNER_PY,
              '--vsock-script',
              GUEST_VSOCK_PY,
              '--work-dir',
              join(root, 'gw1c'),
              '--unix-collector',
              collectorSocketPath,
              '--unix-input',
              inputSocketPath,
              '--workload',
              setsidWorkload,
              '--workload-timeout',
              '1',
              '--urandom-path',
              join(root, 'ur1c'),
              '--sys-net-dir',
              cleanNet,
              '--proc-mounts',
              cleanMounts,
            ],
            { stdio: 'pipe' },
          );
          await new Promise((ok) => child.once('exit', ok));
          return {
            workerPid: child.pid,
            supervisorPid: child.pid,
            workerExe: 'python3',
            expectedExeTokens: ['python'],
            child,
          };
        },
      });
      expect(resSetsid.errors).toEqual([]);
      expect(resSetsid.ok).toBe(true);
      expect(resSetsid.checkExitCode).toBe(0);
      expect(
        readFileSync(join(root, 'v1c', 'verdict.txt'), 'utf8').trim(),
      ).toBe('inconclusive');
      const aSetsid = JSON.parse(
        readFileSync(join(root, 'v1c', 'assertions.json'), 'utf8'),
      );
      expect(aSetsid.failures.map((f) => f.id)).toEqual([
        'workload-completed',
        'guest-lifecycle-error',
      ]);

      // 2. R3-4: Self-test renders footer from qwen.skill=<12-hex> when supplied,
      // and omits any fabricated footer when absent.
      const cmdlineWithSkill = join(root, 'cmdline-skill');
      writeFileSync(cmdlineWithSkill, 'qwen.skill=0123456789ab\n');
      const planSkill = buildFirecrackerLaunchPlan({
        runId: 'gr-r3-4a',
        jailBaseDir: join(root, 'j'),
        firecrackerBin: '/opt/firecracker',
        jailerBin: '/opt/jailer',
        vmmUid: currentUid,
        vmmGid: currentGid,
        vsockPort: 52,
        inputVsockPort: 53,
      });
      const resSkill = await runHardwareRound({
        contextPath: ctx.path,
        contextSha256: ctx.sha256,
        launcherDir: join(root, 'l2'),
        vaultDir: join(root, 'v2'),
        approvedRoots: [root],
        plan: planSkill,
        sourceKernelPath: goldenKernel,
        sourceRootfsPath: goldenRootfs,
        stageAssets: true,
        applyChown: false,
        runChecker: true,
        roundInput: { repoDir, baseRefOid, headRefOid },
        launchBackend: async ({ collectorSocketPath, inputSocketPath }) => {
          const child = spawn(
            'python3',
            [
              GUEST_RUNNER_PY,
              '--vsock-script',
              GUEST_VSOCK_PY,
              '--from-cmdline',
              '--cmdline-file',
              cmdlineWithSkill,
              '--work-dir',
              join(root, 'gw2'),
              '--unix-collector',
              collectorSocketPath,
              '--unix-input',
              inputSocketPath,
              '--urandom-path',
              join(root, 'ur2'),
              '--sys-net-dir',
              cleanNet,
              '--proc-mounts',
              cleanMounts,
            ],
            { stdio: 'pipe' },
          );
          await new Promise((ok) => child.once('exit', ok));
          return {
            workerPid: child.pid,
            supervisorPid: child.pid,
            workerExe: 'python3',
            expectedExeTokens: ['python'],
            child,
          };
        },
      });
      expect(resSkill.ok).toBe(true);
      expect(resSkill.checkExitCode).toBe(0);
      const commentWithSkill = readFileSync(
        join(root, 'v2', 'comment.md'),
        'utf8',
      ).trim();
      expect(commentWithSkill.endsWith('skill 0123456789ab)_')).toBe(true);
      // Without qwen.skill (res1 above), comment.md must NOT fabricate a 000000000000 footer
      const commentNoSkill = readFileSync(
        join(root, 'v1', 'comment.md'),
        'utf8',
      );
      expect(commentNoSkill).not.toMatch(/000000000000/);

      // 3. R3-2: With collectorOptions left at defaults and qwen.workload_timeout=90 in bootArgs,
      // runHardwareRound raises acceptDeadlineMs past the default window so a workload running
      // longer than the scaled default window still delivers report.md/verdict.txt to the vault.
      const slowWorkload = join(root, 'slow-wl.sh');
      writeFileSync(
        slowWorkload,
        [
          '#!/bin/sh',
          'set -eu',
          'sleep 1',
          'printf "merge-ready\\n" > "$QWEN_VERIFY_ARTIFACTS_DIR/verdict.txt"',
          'printf \'{"pass":1,"fail":0,"total":1}\\n\' > "$QWEN_VERIFY_ARTIFACTS_DIR/assertions.json"',
          'printf "merge-ready · 1 passed · 0 failed · 1 total · %s\\n\\n## Methodology\\n\\n**Boundary.** microvm.\\n" "$QWEN_VERIFY_HEAD_OID" > "$QWEN_VERIFY_ARTIFACTS_DIR/report.md"',
          'printf "merge-ready\\n" > "$QWEN_VERIFY_ARTIFACTS_DIR/comment.md"',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      chmodSync(slowWorkload, 0o755);

      let observedAcceptDeadlineMs = null;
      vi.resetModules();
      vi.doMock('../verify-pr-vm-collector.mjs', async () => {
        const actual = await vi.importActual('../verify-pr-vm-collector.mjs');
        return {
          ...actual,
          startCollectorServer(opts) {
            observedAcceptDeadlineMs = opts.acceptDeadlineMs;
            // Scale an un-raised default acceptDeadlineMs down to 300ms so omitting
            // the budget derivation immediately fails with an empty vault.
            const effectiveMs =
              opts.acceptDeadlineMs === undefined ||
              opts.acceptDeadlineMs <= 45_000
                ? 300
                : opts.acceptDeadlineMs;
            return actual.startCollectorServer({
              ...opts,
              acceptDeadlineMs: effectiveMs,
            });
          },
        };
      });
      try {
        const runnerMod = await import('../verify-pr-vm-runner.mjs');
        const planLong = runnerMod.buildFirecrackerLaunchPlan({
          runId: 'gr-r3-2',
          jailBaseDir: join(root, 'j'),
          firecrackerBin: '/opt/firecracker',
          jailerBin: '/opt/jailer',
          vmmUid: currentUid,
          vmmGid: currentGid,
          vsockPort: 52,
          inputVsockPort: 53,
          bootArgs:
            'console=ttyS0 reboot=k panic=1 pci=off init=/opt/poc/init qwen.workload_timeout=90',
        });
        const resLong = await runnerMod.runHardwareRound({
          contextPath: ctx.path,
          contextSha256: ctx.sha256,
          launcherDir: join(root, 'l3'),
          vaultDir: join(root, 'v3'),
          approvedRoots: [root],
          plan: planLong,
          sourceKernelPath: goldenKernel,
          sourceRootfsPath: goldenRootfs,
          stageAssets: true,
          applyChown: false,
          runChecker: true,
          roundInput: { repoDir, baseRefOid, headRefOid },
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
                '--workload',
                slowWorkload,
                '--workload-timeout',
                '90',
                '--urandom-path',
                join(root, 'ur3'),
                '--sys-net-dir',
                cleanNet,
                '--proc-mounts',
                cleanMounts,
              ],
              { stdio: 'pipe' },
            );
            await new Promise((ok) => child.once('exit', ok));
            return {
              workerPid: child.pid,
              supervisorPid: child.pid,
              workerExe: 'python3',
              expectedExeTokens: ['python'],
              child,
            };
          },
        });
        expect(observedAcceptDeadlineMs).toBe(120_000);
        expect(resLong.errors).toEqual([]);
        expect(resLong.ok).toBe(true);
        expect(resLong.checkExitCode).toBe(0);
        expect(existsSync(join(root, 'v3', 'report.md'))).toBe(true);
        expect(
          readFileSync(join(root, 'v3', 'verdict.txt'), 'utf8').trim(),
        ).toBe('merge-ready');
      } finally {
        vi.doUnmock('../verify-pr-vm-collector.mjs');
        vi.resetModules();
      }
    },
    20_000,
  );
});
