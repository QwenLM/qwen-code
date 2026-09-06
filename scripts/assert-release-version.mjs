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
    throw new Error(
      'assert-unreleased requires a version in release format, e.g. --assert-unreleased=1.2.3',
    );
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
    return error.code === 'VERSION_SHIPPED' ? 3 : 2;
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
