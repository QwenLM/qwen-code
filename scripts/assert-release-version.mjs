#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RELEASE_WORKSPACES } from './release-packages.mjs';

export const PUBLISHED_PACKAGES = [
  '@qwen-code/qwen-code',
  ...RELEASE_WORKSPACES,
];

// Deliberately a copy of `scripts/lib/release-helpers.js`, not an import:
// the workflow's sparse checkout excludes `scripts/lib/`, so importing it
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
      `Version ${version} has already shipped; refusing to push the release branch over it. Found on: ${shippedTo.join(', ')}. If a previous attempt published only part of the release and its release branch still exists, re-run the failed job — the push step reuses the branch when its contents match and the publish step skips already-published packages. If the branch was deleted, restore it from the original release commit or recover the remaining packages manually.`,
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

/**
 * Resume-time guard for a partially published release. `latest` on the CLI
 * cannot speak for the workspace packages: pnpm skips already-published
 * versions but re-points the dist-tag of every package it does publish, so
 * one workspace tag ahead of the resuming version already means resuming
 * would regress that channel. Read every published package's target
 * dist-tag and refuse only when one is strictly newer than the resuming
 * version. Same-date nightlies carry unordered short SHAs, so an equal core
 * with different nightly suffixes cannot prove order and refuses too.
 * Runs from the workflow-pinned checkout before any write credential is
 * exported: its `npm view` calls and the `semver` import must not come from
 * the selected release ref.
 * Exit codes: 0 safe to resume, 1 decisive channel refusal (the workflow
 * marks version_refusal), 2 probe failure (retried), 4 malformed input.
 */
export function runAssertChannelResumableCli(version, tag) {
  const versionFormat =
    /^\d+\.\d+\.\d+(?:-preview\.\d+|-nightly\.\d{8}\.[0-9a-f]+)?$/;
  if (
    typeof version !== 'string' ||
    typeof tag !== 'string' ||
    !versionFormat.test(version) ||
    !/^[a-z][a-z0-9-]*$/.test(tag)
  ) {
    console.log(
      '::error::assert-channel-resumable requires a release version and a plain dist-tag, e.g. --version=1.2.3 --tag=latest',
    );
    return 4;
  }
  const semver = createRequire(import.meta.url)('semver');
  const target = semver.parse(version);
  const nightly = /^(\d+\.\d+\.\d+-nightly\.\d{8})\.([0-9a-f]+)$/;
  const targetNightly = nightly.exec(version);
  for (const pkg of PUBLISHED_PACKAGES) {
    let current;
    try {
      current = execSync(`npm view ${pkg} dist-tags.${tag}`).toString().trim();
    } catch (error) {
      if (!error.message?.includes('E404')) {
        console.log(
          `::error::Failed to verify ${pkg} dist-tags.${tag} on npm: ${error.message}`,
        );
        return 2;
      }
      // The package has never been published on this registry; publishing
      // it moves the channel forward, never back.
      continue;
    }
    if (current === '') continue;
    const parsed = semver.parse(current);
    if (!parsed) {
      console.log(
        `::error::Cannot compare npm ${tag} for ${pkg} (${current}) with ${version}; refusing to resume.`,
      );
      return 1;
    }
    if (semver.gt(parsed, target)) {
      console.log(
        `::error::npm ${tag} for ${pkg} is ${current}, past ${version}. Resuming would regress the dist-tag.`,
      );
      return 1;
    }
    const currentNightly = nightly.exec(current);
    if (
      targetNightly &&
      currentNightly &&
      currentNightly[1] === targetNightly[1] &&
      currentNightly[2] !== targetNightly[2]
    ) {
      console.log(
        `::error::npm ${tag} for ${pkg} is ${current}, a different same-day nightly than ${version}; short SHAs cannot prove publish order. Refusing to resume.`,
      );
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2] ?? '';
  let exitCode;
  if (arg === '--assert-channel-resumable') {
    const values = Object.fromEntries(
      process.argv.slice(3).map((entry) => {
        const eqIndex = entry.indexOf('=');
        return eqIndex === -1
          ? [entry, '']
          : [entry.slice(0, eqIndex), entry.slice(eqIndex + 1)];
      }),
    );
    exitCode = runAssertChannelResumableCli(
      values['--version'],
      values['--tag'],
    );
  } else {
    const prefix = '--assert-unreleased=';
    exitCode = runAssertVersionCli(
      arg.startsWith(prefix) ? arg.slice(prefix.length) : '',
    );
  }
  if (exitCode !== 0) process.exit(exitCode);
}
