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

const original = Buffer.alloc(4096, 0x31);
const replacement = Buffer.alloc(original.length, 0x32);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

(async () => {
  const root = fs.mkdtempSync('/tmp/qc-prebuilt-snapshot-');
  const sourcePath = join(root, 'prebuilt.bundle');
  const replacementPath = join(root, 'replacement.bundle');
  const originalWriteFileSync = fs.writeFileSync;
  let injected = false;
  let allocationCount = 0;
  let handoff = null;
  let fetched = null;
  let fetchError = null;
  try {
    fs.writeFileSync(sourcePath, original, { mode: 0o600 });
    fs.writeFileSync(replacementPath, replacement, { mode: 0o600 });
    fs.writeFileSync = (path, ...args) => {
      const result = originalWriteFileSync(path, ...args);
      if (String(path).endsWith('/token.json') && !injected) {
        fs.renameSync(replacementPath, sourcePath);
        injected = true;
      }
      return result;
    };
    syncBuiltinESMExports();
    const runnerUrl = pathToFileURL(resolve(process.argv[2])).href;
    const { fetchRoundInputFromSocket, startInputServer } = await import(
      new URL('verify-pr-vm-channel.mjs', runnerUrl).href
    );
    const { buildAliyunProviderPlan, runHardwareRound } = await import(
      runnerUrl
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
    originalWriteFileSync(contextPath, context);
    const result = await runHardwareRound({
      contextPath,
      contextSha256: digest(context),
      launcherDir: join(root, 'launcher'),
      vaultDir: join(root, 'vault'),
      approvedRoots: [root],
      plan: buildAliyunProviderPlan({
        runId: 'prebuilt-snapshot',
        headRefOid: 'b'.repeat(40),
        region: 'cn-hangzhou',
        zone: 'cn-hangzhou-b',
        vpcId: 'vpc-1',
        vSwitchId: 'vsw-1',
        imageId: 'debian_12.vhd',
      }),
      roundInput: {
        bundlePath: sourcePath,
        bundleSha256: digest(original),
        bundleBytes: original.length,
      },
      providerDriver: {
        allocate: async ({ roundInput }) => {
          allocationCount += 1;
          const bytes = fs.readFileSync(roundInput.bundlePath);
          const stat = fs.statSync(roundInput.bundlePath);
          handoff = {
            path: roundInput.bundlePath,
            sha256: digest(bytes),
            mode: stat.mode & 0o777,
          };
          const input = startInputServer({
            socketPath: join(root, 'input.sock'),
            manifest: roundInput.manifest,
            manifestBytes: roundInput.manifestBytes,
            bundlePath: roundInput.bundlePath,
          });
          try {
            await input.ready;
            const response = await fetchRoundInputFromSocket({
              socketPath: join(root, 'input.sock'),
              outDir: join(root, 'fetched'),
            });
            const fetchedBytes = fs.readFileSync(response.bundlePath);
            fetched = {
              sha256: digest(fetchedBytes),
              matchesManifest:
                response.manifest.bundleSha256 === digest(fetchedBytes),
            };
          } catch (error) {
            fetchError = error.message;
          } finally {
            await input.close();
          }
          throw new Error('prebuilt-snapshot-allocation-sentinel');
        },
        destroy: async () => ({ terminated: true, diskDeleted: true }),
      },
      runChecker: false,
      verifyLivePid: false,
    });
    const pass =
      injected &&
      allocationCount === 1 &&
      handoff?.sha256 === digest(original) &&
      handoff?.mode === 0o600 &&
      handoff.path !== fs.realpathSync(sourcePath) &&
      fetched?.sha256 === digest(original) &&
      fetched.matchesManifest &&
      fetchError === null;
    console.log(
      JSON.stringify({
        pass,
        injected,
        allocationCount,
        originalSha256: digest(original),
        replacementSha256: digest(replacement),
        handoff,
        fetched,
        fetchError,
        errors: result.errors,
      }),
    );
    if (!pass) process.exitCode = 1;
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
