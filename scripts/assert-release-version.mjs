#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PUBLISHED_PACKAGES = [
  '@qwen-code/qwen-code',
  '@qwen-code/external-context-mem0',
  '@qwen-code/audio-capture',
  '@qwen-code/channel-base',
  '@qwen-code/channel-dingtalk',
  '@qwen-code/channel-dws',
  '@qwen-code/channel-feishu',
  '@qwen-code/channel-github',
  '@qwen-code/channel-qqbot',
  '@qwen-code/channel-telegram',
  '@qwen-code/channel-wecom',
  '@qwen-code/channel-weixin',
];

// Deliberately a copy of `scripts/lib/release-helpers.js`, not an import:
// the workflow checks this file out alone (`/scripts/assert-release-version.mjs`
// in release.yml's sparse-checkout set), so importing from `scripts/lib/`
// resolves in every test lane and throws ERR_MODULE_NOT_FOUND only in the
// publish job. `scripts/tests/release-workflow.test.js` pins the two bodies
// identical — widen or harden them together, and never widen this copy alone:
// treating a rate-limited probe as "release absent" would let the force push
// proceed over a shipped version.
function isExpectedMissingGitHubRelease(error) {
  const stderr = error.stderr?.toString() ?? '';
  const stdout = error.stdout?.toString() ?? '';
  const message = `${error.message}\n${stderr}\n${stdout}`;
  return message.includes('release not found') || message.includes('Not Found');
}

export function assertVersionUnreleased(version) {
  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-preview\.\d+|-nightly\.\d{8}\.[0-9a-f]+)?$/.test(
      version,
    )
  ) {
    const error = new Error(
      'assert-unreleased requires a version in release format, e.g. --assert-unreleased=1.2.3',
    );
    // Not a probe failure: a malformed version is refused identically on
    // every attempt, so it must not land in the exit-2 bucket that
    // run-release-step.sh retries three times while logging it as one
    // transient probe error.
    error.code = 'VERSION_FORMAT';
    throw error;
  }

  const shippedTo = [];
  for (const pkg of PUBLISHED_PACKAGES) {
    try {
      const output = execSync(`npm view ${pkg}@${version} version`)
        .toString()
        .trim();
      if (output === version) shippedTo.push(pkg);
    } catch (error) {
      if (shippedTo.length === 0 && !error.message?.includes('E404')) {
        throw new Error(
          `Failed to verify ${pkg}@${version} on npm: ${error.message}`,
        );
      }
    }
  }

  if (shippedTo.length === 0) {
    try {
      execSync(`git ls-remote --exit-code origin "refs/tags/v${version}"`);
      shippedTo.push(`origin tag v${version}`);
    } catch (error) {
      if (error.status !== 2) {
        throw new Error(
          `Failed to verify tag v${version} on origin: ${error.message}`,
        );
      }
    }
  }

  if (shippedTo.length === 0) {
    try {
      const output = execSync(
        `gh release view "v${version}" --json tagName --jq .tagName`,
      )
        .toString()
        .trim();
      if (output === `v${version}`)
        shippedTo.push(`GitHub release v${version}`);
    } catch (error) {
      if (!isExpectedMissingGitHubRelease(error)) {
        throw new Error(
          `Failed to verify release v${version} on GitHub: ${error.message}`,
        );
      }
    }
  }

  if (shippedTo.length > 0) {
    const error = new Error(
      `Version ${version} has already shipped; refusing to force-push the release branch over it. Found on: ${shippedTo.join(', ')}. If a previous attempt published only part of the release, complete the remaining artifacts manually — re-running this job will keep failing here while the version stays published.`,
    );
    error.code = 'VERSION_SHIPPED';
    throw error;
  }
}

export function runAssertVersionCli(version) {
  try {
    assertVersionUnreleased(version);
  } catch (error) {
    console.log(`::error::${error.message}`);
    // 3 = already shipped (decisive, marked so the workflow skips the
    // release-failed notification); 4 = malformed version (decisive, not
    // retryable, and not a benign refusal); 2 = probe failure, retried.
    if (error.code === 'VERSION_SHIPPED') return 3;
    if (error.code === 'VERSION_FORMAT') return 4;
    return 2;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const prefix = '--assert-unreleased=';
  const arg = process.argv[2] ?? '';
  const exitCode = runAssertVersionCli(
    arg.startsWith(prefix) ? arg.slice(prefix.length) : '',
  );
  if (exitCode !== 0) process.exit(exitCode);
}
