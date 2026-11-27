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
const copyMutation = ['copy-growth', 'copy-rewrite'].includes(mode);
const unsafePrivate = ['private-multi-link', 'private-symlink'].includes(mode);
if (
  ![
    'copy-growth',
    'copy-rewrite',
    'staging-collision',
    'private-retry',
    'private-multi-link',
    'private-symlink',
  ].includes(mode)
) {
  throw new Error('usage: driver <runner-path> <supported-boundary-mode>');
}
const budget = 1024;
const original = Buffer.alloc(64, 0x31);
const growth = Buffer.alloc(1024 * 1024 + 257, 0x32);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

(async () => {
  const root = fs.mkdtempSync('/tmp/qc-copy-boundary-');
  const launcher = join(root, 'launcher');
  const source =
    mode === 'staging-collision'
      ? join(launcher, `.round-input.bundle.tmp.${process.pid}`)
      : mode === 'private-retry'
        ? join(launcher, 'round-input.bundle')
        : join(root, 'prebuilt.bundle');
  fs.mkdirSync(launcher, { recursive: true, mode: 0o700 });
  const staged = join(
    fs.realpathSync(launcher),
    `.round-input.bundle.tmp.${process.pid}`,
  );
  const originalOpen = fs.openSync;
  const originalCopy = fs.copyFileSync;
  const originalWrite = fs.writeSync;
  const stagedFds = new Set();
  const privateTarget = join(launcher, 'round-input.bundle');
  const replacement = Buffer.alloc(64, 0x32);
  let injected = !copyMutation;
  let copiedAfterHashWithSameSize = false;
  let growthAfterFirstRead = false;
  let copiedBytes = 0;
  let allocations = 0;
  let privateTargetBefore = null;
  const targetIdentity = (file) => {
    try {
      const st = fs.lstatSync(file);
      return {
        dev: st.dev,
        ino: st.ino,
        nlink: st.nlink,
        mode: st.mode,
        sha256: digest(fs.readFileSync(file)),
      };
    } catch (error) {
      return { error: error.code };
    }
  };
  try {
    fs.writeFileSync(source, original, { mode: 0o600 });
    if (unsafePrivate) {
      const existingTargets = join(root, 'existing-target.bundle');
      fs.writeFileSync(existingTargets, 'must-not-overwrite');
      if (mode === 'private-multi-link') {
        fs.linkSync(existingTargets, privateTarget);
      } else {
        fs.symlinkSync(existingTargets, privateTarget);
      }
      privateTargetBefore = targetIdentity(privateTarget);
    }
    const canonicalSource = fs.realpathSync(source);
    const rewrite = () => {
      if (injected) return;
      fs.writeFileSync(source, replacement, { mode: 0o600 });
      injected = true;
      copiedAfterHashWithSameSize = true;
    };
    const grow = (afterRead) => {
      if (injected) return;
      fs.appendFileSync(source, growth);
      injected = true;
      growthAfterFirstRead = afterRead;
    };
    let sourceOpens = 0;
    fs.openSync = (file, flags, ...rest) => {
      if (
        mode === 'copy-rewrite' &&
        (file === source || file === canonicalSource)
      ) {
        sourceOpens += 1;
        if (sourceOpens === 2) rewrite();
      }
      const fd = originalOpen(file, flags, ...rest);
      if (file === staged) stagedFds.add(fd);
      return fd;
    };
    fs.copyFileSync = (from, to, ...rest) => {
      if (copyMutation && (from === source || from === canonicalSource)) {
        if (mode === 'copy-growth') grow(false);
        else rewrite();
      }
      const result = originalCopy(from, to, ...rest);
      if (copyMutation) copiedBytes = fs.statSync(to).size;
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
    const sentinel = 'allocation-sentinel';
    const runRound = () =>
      runHardwareRound({
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
            throw new Error(sentinel);
          },
          destroy: async () => ({ terminated: true, diskDeleted: true }),
        },
        runChecker: false,
        verifyLivePid: false,
      });
    const rounds = [await runRound()];
    if (mode === 'private-retry') rounds.push(await runRound());
    const result = rounds[0];
    const sourceExistsAfter = fs.existsSync(source);
    const sourceShaAfter = sourceExistsAfter
      ? digest(fs.readFileSync(source))
      : null;
    const expectedSourceSha = digest(
      mode === 'copy-growth'
        ? Buffer.concat([original, growth])
        : mode === 'copy-rewrite'
          ? replacement
          : original,
    );
    const errors = result.errors.join('\n');
    const privateTargetAfter = unsafePrivate
      ? targetIdentity(privateTarget)
      : null;
    const privateTargetPreserved =
      !unsafePrivate ||
      JSON.stringify(privateTargetAfter) ===
        JSON.stringify(privateTargetBefore);
    const sentinelReached = rounds.every((round) =>
      round.errors.some((error) => error.includes(sentinel)),
    );
    const tokenPath = join(launcher, 'token.json');
    const tokenClean =
      mode === 'private-retry'
        ? fs.existsSync(tokenPath) &&
          JSON.parse(fs.readFileSync(tokenPath, 'utf8')).revoked === true
        : !fs.existsSync(tokenPath);
    const pass =
      injected &&
      copiedBytes <= budget &&
      sourceExistsAfter &&
      sourceShaAfter === expectedSourceSha &&
      privateTargetPreserved &&
      tokenClean &&
      (mode === 'copy-growth'
        ? growthAfterFirstRead &&
          allocations === 0 &&
          errors.includes(`bundle-size-budget:${budget}`) &&
          !fs.existsSync(staged)
        : mode === 'copy-rewrite'
          ? copiedAfterHashWithSameSize &&
            allocations === 0 &&
            errors.includes(
              'roundInput.bundlePath changed while its private copy was made',
            ) &&
            !fs.existsSync(staged)
          : mode === 'staging-collision'
            ? allocations === 0 &&
              errors.includes('EEXIST') &&
              fs.existsSync(staged)
            : mode === 'private-retry'
              ? allocations === 2 &&
                sentinelReached &&
                fs.readFileSync(source, 'utf8').length === original.length
              : allocations === 0 &&
                errors.includes(
                  'refusing to overwrite a non-regular or multi-link private bundle',
                ));
    console.log(
      JSON.stringify({
        mode,
        injected,
        copiedAfterHashWithSameSize,
        growthAfterFirstRead,
        allocations,
        copiedBytes,
        sourceExistsAfter,
        sourceShaAfter,
        expectedSourceSha,
        privateTargetBefore,
        privateTargetAfter,
        privateTargetPreserved,
        sentinelReached,
        tokenClean,
        tokenExistsAfter: fs.existsSync(tokenPath),
        stagedExistsAfter: fs.existsSync(staged),
        rounds: rounds.map((round) => ({ ok: round.ok, errors: round.errors })),
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
