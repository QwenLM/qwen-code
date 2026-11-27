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
  let growthAppends = 0;
  const appendBytes = 128 * 1024;
  const maxGrowthAppends = 12;
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
      if (
        bundleFds.has(fd) &&
        mode === 'growth' &&
        growthAppends < maxGrowthAppends
      ) {
        fs.appendFileSync(bundlePath, Buffer.alloc(appendBytes, 0x32));
        growthAppends += 1;
        injected = true;
      }
      const bytes = originalReadSync(fd, buffer, ...rest);
      if (bundleFds.has(fd)) readBytes += bytes;
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
    const expectedGrowthSize = budget + appendBytes * growthAppends;
    const errors = result.errors.join('\n');
    const identityChanged =
      initialIdentity.dev !== fdIdentity.dev ||
      initialIdentity.ino !== fdIdentity.ino;
    const pass =
      injected &&
      finalSize ===
        (mode === 'replacement' ? budget + 1 : expectedGrowthSize) &&
      (mode === 'replacement'
        ? readBytes === 0
        : readBytes > budget &&
          readBytes <= budget + 256 * 1024 &&
          readBytes < expectedGrowthSize &&
          growthAppends > 0 &&
          growthAppends <= maxGrowthAppends) &&
      identityChanged === (mode === 'replacement') &&
      errors.includes(`bundle-size-budget:${budget}`) &&
      allocations === 0 &&
      !fs.existsSync(join(root, 'launcher', 'token.json'));
    console.log(
      JSON.stringify({
        mode,
        injected,
        growthAppends,
        initialIdentity,
        fdIdentity,
        finalSize,
        readBytes,
        allocations,
        expectedGrowthSize,
        identityChanged,
        tokenExistsAfter: fs.existsSync(join(root, 'launcher', 'token.json')),
        budgetRead:
          readBytes > budget &&
          readBytes <= budget + 256 * 1024 &&
          readBytes < expectedGrowthSize,
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
