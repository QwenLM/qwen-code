/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const mode = process.argv[3];
if (!['copy-growth', 'staging-collision'].includes(mode)) {
  throw new Error('usage: driver <runner-path> copy-growth|staging-collision');
}
const budget = 1024;
const original = Buffer.alloc(64, 0x31);
const growth = Buffer.alloc(1024 * 1024 + 257, 0x32);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

(async () => {
  const root = fs.mkdtempSync('/tmp/qc-copy-boundary-');
  const launcher = join(root, 'launcher');
  const source =
    mode === 'copy-growth'
      ? join(root, 'prebuilt.bundle')
      : join(launcher, `.round-input.bundle.tmp.${process.pid}`);
  fs.mkdirSync(launcher, { recursive: true, mode: 0o700 });
  const staged = join(
    fs.realpathSync(launcher),
    `.round-input.bundle.tmp.${process.pid}`,
  );
  const originalOpen = fs.openSync;
  const originalCopy = fs.copyFileSync;
  const originalWrite = fs.writeSync;
  const stagedFds = new Set();
  let injected = mode === 'staging-collision';
  let growthAfterFirstRead = false;
  let copiedBytes = 0;
  let allocations = 0;
  try {
    fs.writeFileSync(source, original, { mode: 0o600 });
    const canonicalSource = fs.realpathSync(source);
    const grow = (afterRead) => {
      if (injected) return;
      fs.appendFileSync(source, growth);
      injected = true;
      growthAfterFirstRead = afterRead;
    };
    fs.openSync = (file, flags, ...rest) => {
      const fd = originalOpen(file, flags, ...rest);
      if (file === staged) stagedFds.add(fd);
      return fd;
    };
    fs.copyFileSync = (from, to, ...rest) => {
      if (
        mode === 'copy-growth' &&
        (from === source || from === canonicalSource)
      ) {
        grow(false);
      }
      const result = originalCopy(from, to, ...rest);
      if (mode === 'copy-growth') copiedBytes = fs.statSync(to).size;
      return result;
    };
    fs.writeSync = (fd, ...args) => {
      // The first staged write means the copy loop has read its first source chunk.
      if (mode === 'copy-growth' && stagedFds.has(fd) && !injected) {
        grow(true);
      }
      const written = originalWrite(fd, ...args);
      if (stagedFds.has(fd)) copiedBytes += written;
      return written;
    };
    syncBuiltinESMExports();
    const { buildAliyunProviderPlan, runHardwareRound } = await import(
      pathToFileURL(resolve(process.argv[2])).href
    );
    const context = `${JSON.stringify({
      repo: 'QwenLM/qwen-code',
      number: 18400,
      baseRefOid: 'a'.repeat(40),
      headRefOid: 'b'.repeat(40),
      trustClassification: {
        prTrust: 'external',
        executionClass: 'hardware-isolated',
        escalationReasons: [],
        headRefOid: 'b'.repeat(40),
      },
    })}\n`;
    const contextPath = join(root, 'context.json');
    fs.writeFileSync(contextPath, context);
    const result = await runHardwareRound({
      contextPath,
      contextSha256: digest(context),
      launcherDir: launcher,
      vaultDir: join(root, 'vault'),
      approvedRoots: [root],
      plan: buildAliyunProviderPlan({
        runId: mode,
        headRefOid: 'b'.repeat(40),
        region: 'cn-hangzhou',
        zone: 'cn-hangzhou-b',
        vpcId: 'vpc-1',
        vSwitchId: 'vsw-1',
        imageId: 'debian_12.vhd',
      }),
      roundInput: { bundlePath: source, maxBundleBytes: budget },
      providerDriver: {
        allocate: async () => {
          allocations += 1;
          throw new Error('must-not-allocate');
        },
        destroy: async () => ({ terminated: true, diskDeleted: true }),
      },
      runChecker: false,
      verifyLivePid: false,
    });
    const sourceExistsAfter = fs.existsSync(source);
    const sourceShaAfter = sourceExistsAfter
      ? digest(fs.readFileSync(source))
      : null;
    const expectedSourceSha = digest(
      mode === 'copy-growth' ? Buffer.concat([original, growth]) : original,
    );
    const errors = result.errors.join('\n');
    const pass =
      injected &&
      allocations === 0 &&
      copiedBytes <= budget &&
      sourceExistsAfter &&
      sourceShaAfter === expectedSourceSha &&
      !fs.existsSync(join(launcher, 'token.json')) &&
      (mode === 'copy-growth'
        ? growthAfterFirstRead &&
          errors.includes(`bundle-size-budget:${budget}`) &&
          !fs.existsSync(staged)
        : errors.includes('EEXIST') && fs.existsSync(staged));
    console.log(
      JSON.stringify({
        mode,
        injected,
        growthAfterFirstRead,
        allocations,
        copiedBytes,
        sourceExistsAfter,
        sourceShaAfter,
        expectedSourceSha,
        stagedExistsAfter: fs.existsSync(staged),
        errors: result.errors,
        pass,
      }),
    );
    if (!pass) process.exitCode = 1;
  } finally {
    fs.openSync = originalOpen;
    fs.copyFileSync = originalCopy;
    fs.writeSync = originalWrite;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
