/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');
const { join } = require('node:path');

const budget = 1024 * 1024;
const mode = process.argv[3];
if (!['replacement', 'growth'].includes(mode)) {
  throw new Error('usage: driver <runner-url> replacement|growth');
}

(async () => {
  const root = fs.mkdtempSync('/tmp/qc-input-budget-race-');
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  let injected = false;
  let readBytes = 0;
  let initialIdentity;
  let fdIdentity;
  const bundleFds = new Set();
  const bundlePath = join(root, 'prebuilt.bundle');
  try {
    fs.writeFileSync(bundlePath, Buffer.alloc(budget, 0x31));
    const copy = (st) => ({ dev: st.dev, ino: st.ino });
    initialIdentity = copy(fs.lstatSync(bundlePath));
    const realBundlePath = fs.realpathSync(bundlePath);
    if (mode === 'replacement') {
      fs.writeFileSync(
        join(root, 'replacement.bundle'),
        Buffer.alloc(budget + 1, 0x32),
      );
    }
    fs.openSync = (file, flags, ...rest) => {
      if (file === bundlePath || file === realBundlePath) {
        if (mode === 'replacement' && !injected) {
          fs.renameSync(join(root, 'replacement.bundle'), bundlePath);
          injected = true;
        }
        const fd = originalOpenSync(file, flags, ...rest);
        bundleFds.add(fd);
        fdIdentity = copy(fs.fstatSync(fd));
        return fd;
      }
      return originalOpenSync(file, flags, ...rest);
    };
    fs.readSync = (fd, buffer, ...rest) => {
      const bytes = originalReadSync(fd, buffer, ...rest);
      if (bundleFds.has(fd)) {
        readBytes += bytes;
        if (bytes > 0 && mode === 'growth' && !injected) {
          fdIdentity = copy(fs.fstatSync(fd));
          fs.appendFileSync(bundlePath, Buffer.alloc(128, 0x32));
          injected = true;
        }
      }
      return bytes;
    };
    syncBuiltinESMExports();
    const { buildAliyunProviderPlan, runHardwareRound } = await import(
      process.argv[2]
    );
    const baseRefOid = 'a'.repeat(40);
    const headRefOid = 'b'.repeat(40);
    const context = `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`;
    const contextPath = join(root, 'context.json');
    fs.writeFileSync(contextPath, context);
    const plan = buildAliyunProviderPlan({
      runId: `budget-${mode}`,
      headRefOid,
      region: 'cn-hangzhou',
      zone: 'cn-hangzhou-b',
      vpcId: 'vpc-1',
      vSwitchId: 'vsw-1',
      imageId: 'debian_12.vhd',
    });
    let allocations = 0;
    const result = await runHardwareRound({
      contextPath,
      contextSha256: createHash('sha256').update(context).digest('hex'),
      launcherDir: join(root, 'launcher'),
      vaultDir: join(root, 'vault'),
      approvedRoots: [root],
      plan,
      roundInput: { bundlePath, maxBundleBytes: budget },
      providerDriver: {
        allocate: async () => {
          allocations += 1;
          throw new Error('budget-probe-allocation');
        },
        destroy: async () => ({ terminated: true, diskDeleted: true }),
      },
      runChecker: false,
      verifyLivePid: false,
    });
    const finalSize = fs.lstatSync(bundlePath).size;
    const errors = result.errors.join('\n');
    const identityChanged =
      initialIdentity.dev !== fdIdentity.dev ||
      initialIdentity.ino !== fdIdentity.ino;
    const pass =
      injected &&
      finalSize === budget + (mode === 'replacement' ? 1 : 128) &&
      readBytes === (mode === 'replacement' ? 0 : budget + 128) &&
      identityChanged === (mode === 'replacement') &&
      errors.includes(`bundle-size-budget:${budget}`) &&
      allocations === 0 &&
      !fs.existsSync(join(root, 'launcher', 'token.json'));
    console.log(
      JSON.stringify({
        mode,
        injected,
        initialIdentity,
        fdIdentity,
        finalSize,
        readBytes,
        allocations,
        errors: result.errors,
        pass,
      }),
    );
    if (!pass) process.exitCode = 1;
  } finally {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
