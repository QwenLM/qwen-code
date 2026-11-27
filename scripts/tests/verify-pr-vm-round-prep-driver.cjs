/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const fs = require('node:fs');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const diagnosticBytes = 48 * 1024;
const originalSpawnSync = childProcess.spawnSync;
const bundleBuffers = [];
(async () => {
  const root = fs.mkdtempSync('/tmp/qc-round-prep-');
  const fixtureBin = join(root, 'bin');
  const repoDir = join(root, 'repo');
  let allocations = 0;
  fs.mkdirSync(fixtureBin);
  fs.mkdirSync(repoDir);
  try {
    fs.writeFileSync(
      join(fixtureBin, 'git'),
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const result = spawnSync('git', process.argv.slice(2), {
  env: { ...process.env, PATH: process.env.REAL_GIT_PATH },
  encoding: null,
});
const bundleIndex = process.argv.indexOf('bundle');
if (bundleIndex >= 0 && process.argv[bundleIndex + 1] === 'create') {
  process.stderr.write(Buffer.alloc(Number(process.env.FIXTURE_GIT_STDERR_BYTES), 0x78));
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    process.env.REAL_GIT_PATH = process.env.PATH;
    process.env.PATH = `${fixtureBin}:${process.env.PATH}`;
    childProcess.spawnSync = (command, args, options) => {
      const createIndex = args?.indexOf('create');
      if (
        command === 'git' &&
        args?.includes('bundle') &&
        createIndex >= 0 &&
        args[createIndex + 1] === '-'
      ) {
        bundleBuffers.push(options.maxBuffer);
      }
      return originalSpawnSync(command, args, options);
    };
    syncBuiltinESMExports();
    const git = (args) => {
      const result = originalSpawnSync('git', args, {
        cwd: repoDir,
        encoding: 'utf8',
        env: { ...process.env, FIXTURE_GIT_STDERR_BYTES: '0' },
      });
      if (result.status !== 0) {
        throw new Error(
          JSON.stringify({
            args,
            status: result.status,
            signal: result.signal,
            error: result.error?.message,
            stdout: result.stdout,
            stderr: result.stderr,
          }),
        );
      }
      return result.stdout.trim();
    };
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(join(repoDir, 'fixture.txt'), 'base fixture\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    const baseRefOid = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(join(repoDir, 'fixture.txt'), 'head fixture\n');
    git(['commit', '-q', '-am', 'head']);
    const headRefOid = git(['rev-parse', 'HEAD']);
    process.env.FIXTURE_GIT_STDERR_BYTES = String(diagnosticBytes);
    const { DEFAULT_MAX_BUNDLE_BYTES, createRoundInputBundle } = await import(
      pathToFileURL(
        resolve(join(process.argv[2], 'scripts', 'verify-pr-vm-channel.mjs')),
      ).href
    );
    const { buildAliyunProviderPlan, runHardwareRound } = await import(
      pathToFileURL(
        resolve(join(process.argv[2], 'scripts', 'verify-pr-vm-runner.mjs')),
      ).href
    );
    const directOut = join(root, 'direct.bundle');
    const direct = createRoundInputBundle({
      repoDir,
      baseRefOid,
      headRefOid,
      outPath: directOut,
      maxBundleBytes: 32 * 1024,
    });
    const verification = git(['bundle', 'verify', directOut]);
    const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const context = `${JSON.stringify({
      repo: 'QwenLM/qwen-code',
      number: 18400,
      baseRefOid,
      headRefOid,
      trustClassification: {
        prTrust: 'external',
        executionClass: 'hardware-isolated',
        escalationReasons: [],
        headRefOid,
      },
    })}\n`;
    const contextPath = join(root, 'context.json');
    fs.writeFileSync(contextPath, context);
    const plan = buildAliyunProviderPlan({
      runId: 'round-prep',
      headRefOid,
      region: 'cn-hangzhou',
      zone: 'cn-hangzhou-b',
      vpcId: 'vpc-1',
      vSwitchId: 'vsw-1',
      imageId: 'debian_12.vhd',
    });
    const providerDriver = {
      allocate: async () => {
        allocations += 1;
        throw new Error('round-prep-allocation-sentinel');
      },
      destroy: async () => ({ terminated: true, diskDeleted: true }),
    };
    const runRound = (suffix, roundInput) =>
      runHardwareRound({
        contextPath,
        contextSha256: digest(context),
        launcherDir: join(root, `${suffix}-launcher`),
        vaultDir: join(root, `${suffix}-vault`),
        approvedRoots: [root],
        plan,
        roundInput,
        providerDriver,
        runChecker: false,
        verifyLivePid: false,
      });
    const repoRound = await runRound('repo', {
      repoDir,
      maxBundleBytes: DEFAULT_MAX_BUNDLE_BYTES + 1,
    });
    const entropyRounds = [];
    for (const [index, entropyHex] of [
      `${'0'.repeat(63)}A`,
      'too-short',
      `${'0'.repeat(63)}g`,
    ].entries()) {
      entropyRounds.push({
        entropyShape: entropyHex.length,
        result: await runRound(`entropy-${index}`, {
          bundlePath: join(root, 'must-not-be-read.bundle'),
          entropyHex,
        }),
      });
    }
    const expectedBuffers = [
      32 * 1024 + 64 * 1024,
      DEFAULT_MAX_BUNDLE_BYTES + 64 * 1024,
    ];
    const repoBundle = join(root, 'repo-launcher', 'round-input.bundle');
    const pass =
      fs.statSync(directOut).size === direct.bundleBytes &&
      fs.statSync(directOut).size < 32 * 1024 &&
      digest(fs.readFileSync(directOut)) === direct.bundleSha256 &&
      verification.includes('The bundle records a complete history') &&
      JSON.stringify(bundleBuffers) === JSON.stringify(expectedBuffers) &&
      allocations === 1 &&
      repoRound.errors.some((error) =>
        error.includes('round-prep-allocation-sentinel'),
      ) &&
      fs.existsSync(repoBundle) &&
      entropyRounds.every(
        ({ result }, index) =>
          result.errors
            .join('\n')
            .includes('entropyHex must be a 64-char lowercase hex string') &&
          !result.errors.join('\n').includes('allocation-sentinel') &&
          !fs.existsSync(
            join(root, `entropy-${index}-launcher`, 'token.json'),
          ) &&
          !fs.existsSync(
            join(root, `entropy-${index}-launcher`, 'round-input.bundle'),
          ),
      );
    console.log(
      JSON.stringify({
        directBundleBytes: direct.bundleBytes,
        fixtureGitStderrBytes: diagnosticBytes,
        realBundleVerified: verification.includes(
          'The bundle records a complete history',
        ),
        bundleBuffers,
        expectedBuffers,
        allocations,
        repoErrors: repoRound.errors,
        entropyErrors: entropyRounds.map(({ result }) => result.errors),
        pass,
      }),
    );
    if (!pass) process.exitCode = 1;
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
