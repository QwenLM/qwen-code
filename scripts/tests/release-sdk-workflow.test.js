/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

describe('TypeScript SDK release workflow', () => {
  const workflow = readFileSync('.github/workflows/release-sdk.yml', 'utf8');

  it('only creates a release PR when the package version changed', () => {
    expect(workflow).toContain("id: 'persist_source'");
    expect(workflow).toContain(
      'echo "HAS_PERSISTED_SOURCE=false" >> "${GITHUB_OUTPUT}"',
    );
    expect(workflow).toContain(
      'echo "HAS_PERSISTED_SOURCE=true" >> "${GITHUB_OUTPUT}"',
    );
    expect(workflow).toContain(
      'echo "::notice::No version changes in sdk-typescript; skipping release branch push and PR creation."',
    );
    expect(workflow).toContain(
      "HAS_PERSISTED_SOURCE: '${{ steps.persist_source.outputs.HAS_PERSISTED_SOURCE }}'",
    );
    expect(workflow).toContain(
      'elif [[ "${HAS_PERSISTED_SOURCE}" == "true" ]]',
    );
    expect(workflow).toContain('TARGET="${RELEASE_BRANCH}"');
    expect(workflow).toContain('TARGET="${REF}"');
    for (const stepName of [
      'Create GitHub Release and Tag',
      'Create PR to merge release branch into main',
      'Enable auto-merge for release PR',
    ]) {
      const stepStart = workflow.indexOf(`name: '${stepName}'`);
      const step = workflow.slice(
        stepStart,
        workflow.indexOf('\n      - name:', stepStart + 1),
      );
      expect(step).toContain(
        "steps.persist_source.outputs.HAS_PERSISTED_SOURCE == 'true'",
      );
    }
  });

  it('spaces PR creation out from the release to avoid secondary rate limits', () => {
    // `gh pr create` runs right after the branch push and release creation,
    // which can trip GitHub's "was submitted too quickly" GraphQL secondary
    // rate limit (issue #11402). Pin the gap in every release workflow so a
    // future removal lets the burst through again.
    for (const path of [
      '.github/workflows/release-sdk.yml',
      '.github/workflows/release-sdk-python.yml',
      '.github/workflows/finalize-release.yml',
    ]) {
      const text = readFileSync(path, 'utf8');
      const createIndex = text.indexOf('pr_url="$(gh pr create');
      // -1 when the create is gone or no `sleep 30` precedes it.
      const sleepIndex = text.lastIndexOf('sleep 30', createIndex);
      expect(sleepIndex, path).toBeGreaterThanOrEqual(0);
    }
  });
});

// Behavioral pins for the release-branch push retry/reconcile loop: the
// step body runs verbatim under bash with a stubbed git and sleep, so a
// collapse back to a single push, a flipped reconcile comparison, or a
// removed divergence abort turns a case red here instead of during a
// real stable SDK release.
describe.skipIf(process.platform === 'win32')(
  'SDK release branch push retry',
  () => {
    const dirs = [];
    afterEach(() =>
      dirs
        .splice(0)
        .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
    );

    const HEAD_SHA = 'a'.repeat(40);
    const OTHER_SHA = 'b'.repeat(40);

    function runPushStep({ failPushes, remoteSha }) {
      const root = mkdtempSync(join(tmpdir(), 'sdk-push-retry-'));
      dirs.push(root);
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const log = join(root, 'calls');
      writeFileSync(log, '');
      writeFileSync(
        join(bin, 'git'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GIT_LOG, JSON.stringify(args) + '\\n');
const pushes = () => fs.readFileSync(process.env.GIT_LOG, 'utf8')
  .trim().split('\\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((a) => a[0] === 'push').length;
if (args[0] === 'push') {
  if (pushes() <= Number(process.env.FAIL_PUSHES)) {
    console.error('fatal: simulated push failure');
    process.exit(1);
  }
} else if (args[0] === 'diff') {
  process.exit(1);
} else if (args[0] === 'ls-remote') {
  if (args.includes('--exit-code')) process.exit(2);
  if (process.env.REMOTE_SHA) console.log(process.env.REMOTE_SHA + '\\trefs/heads/' + process.env.BRANCH_NAME);
} else if (args[0] === 'rev-parse') {
  console.log(process.env.HEAD_SHA);
}
`,
      );
      chmodSync(join(bin, 'git'), 0o755);
      writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'sleep'), 0o755);
      const workflow = parse(
        readFileSync('.github/workflows/release-sdk.yml', 'utf8'),
      );
      const step = workflow.jobs['release-sdk'].steps.find(
        (s) => s.id === 'persist_source',
      );
      const result = spawnSync('bash', ['-c', step.run], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_OUTPUT: join(root, 'output'),
          GIT_LOG: log,
          BRANCH_NAME: 'release/sdk-typescript/v9.9.9',
          RELEASE_TAG: 'v9.9.9',
          FAIL_PUSHES: String(failPushes),
          REMOTE_SHA: remoteSha ?? '',
          HEAD_SHA,
        },
      });
      const calls = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      return {
        result,
        pushes: calls.filter((args) => args[0] === 'push'),
        output: result.stdout + result.stderr,
      };
    }

    it('runs the step under set -euo pipefail so the || true guard is load-bearing', () => {
      const workflow = parse(
        readFileSync('.github/workflows/release-sdk.yml', 'utf8'),
      );
      const step = workflow.jobs['release-sdk'].steps.find(
        (s) => s.id === 'persist_source',
      );
      expect(step.run.startsWith('set -euo pipefail')).toBe(true);
    });

    it('pushes once with no delay when the first push succeeds', () => {
      const { result, pushes, output } = runPushStep({ failPushes: 0 });
      expect(result.status, result.stderr).toBe(0);
      expect(pushes).toHaveLength(1);
      expect(output).not.toContain('Push attempt');
      expect(output).not.toContain('landed remotely');
    });

    it('accepts a push that landed remotely despite the reported failure', () => {
      const { result, pushes, output } = runPushStep({
        failPushes: 3,
        remoteSha: HEAD_SHA,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(pushes).toHaveLength(1);
      expect(output).toContain('landed remotely');
    });

    it('fails closed when the remote branch diverged and never force-pushes', () => {
      const { result, pushes, output } = runPushStep({
        failPushes: 3,
        remoteSha: OTHER_SHA,
      });
      expect(result.status).not.toBe(0);
      expect(pushes).toHaveLength(1);
      expect(output).toContain('diverged');
      for (const args of pushes) {
        expect(args).not.toContain('--force');
        expect(args).not.toContain('--force-with-lease');
      }
    });

    it('retries a push that never landed and gives up after three attempts', () => {
      const { result, pushes, output } = runPushStep({ failPushes: 3 });
      expect(result.status).not.toBe(0);
      expect(pushes).toHaveLength(3);
      expect(output).toContain('after 3 attempts');
      expect(output).toContain('Push attempt 1/3');
      expect(output).toContain('Push attempt 2/3');
    });

    it('annotates an absorbed failure and recovers on the next attempt', () => {
      const { result, pushes, output } = runPushStep({ failPushes: 1 });
      expect(result.status, result.stderr).toBe(0);
      expect(pushes).toHaveLength(2);
      expect(output).toContain('Push attempt 1/3');
    });
  },
);
