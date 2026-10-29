/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const releaseStepScriptAbsolutePath = join(
  process.cwd(),
  '.github/scripts/run-release-step.sh',
);

const workflows = [
  {
    path: '.github/workflows/release-vscode-companion.yml',
    titlePrefix: 'VSCode IDE Companion Release Failed for ',
  },
  {
    path: '.github/workflows/release-chrome-extension.yml',
    titlePrefix: 'Chrome extension release failed for ',
  },
];

describe.each(workflows)('$path failure reporting', ({ path, titlePrefix }) => {
  const yml = parse(readFileSync(path, 'utf8'));

  it('files an issue for a failure but not for a cancelled run', () => {
    const job = yml.jobs['report-failure'];
    expect(job.if).toContain('always()');
    expect(job.if).toContain("needs.build.result == 'failure'");
    expect(job.if).toContain("needs.publish.result == 'failure'");
    // A cancelled run ships nothing and must not file an issue (#15840).
    expect(job.if).not.toContain("'cancelled'");
  });

  it('closes the issue an earlier attempt filed once a re-run passes', () => {
    const job = yml.jobs['reconcile-failure'];
    // report-failure is skipped on a passing re-run, so the close path has to
    // be a sibling gated on success rather than a step inside it.
    expect(job.if).toContain('always()');
    expect(job.if).toContain("needs.build.result == 'success'");
    expect(job.if).toContain("needs.publish.result == 'success'");
    expect(job.permissions).toEqual({ contents: 'read', issues: 'write' });

    const checkout = job.steps.find(
      (step) => step.name === 'Checkout release workflow scripts',
    );
    // The shared script is pinned to the workflow's own commit.
    expect(checkout.with.ref).toBe('${{ github.workflow_sha }}');
    expect(checkout.with.path).toBe('.release-workflow');

    const step = job.steps.find(
      (entry) => entry.name === 'Close the issue an earlier attempt filed',
    );
    expect(step.run).toBe(
      '.release-workflow/.github/scripts/run-release-step.sh reconcile-failure',
    );
    expect(step.env.FAILURE_TITLE_PREFIX).toBe(titlePrefix);
    // A reconciliation failure must never turn a shipped release red.
    expect(step['continue-on-error']).toBe(true);
  });
});

describe('reconcile-failure title matching', () => {
  it.skipIf(process.platform === 'win32')(
    'closes only the issue matching the given prefix and version',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'release-fanout-'));
      const bin = join(directory, 'bin');
      const ghLog = join(directory, 'gh-calls');
      const issues = join(directory, 'issues.json');
      mkdirSync(bin);
      writeFileSync(
        issues,
        JSON.stringify([
          {
            number: 101,
            url: 'https://github.example/QwenLM/qwen-code/issues/101',
            labels: [],
            author: { login: 'github-actions[bot]' },
            title:
              'VSCode IDE Companion Release Failed for v1.2.3 on 2026-10-28',
          },
          {
            number: 202,
            url: 'https://github.example/QwenLM/qwen-code/issues/202',
            labels: [],
            author: { login: 'github-actions[bot]' },
            title: 'Chrome extension release failed for v1.2.3 on 2026-10-28',
          },
        ]),
      );
      writeFileSync(
        join(bin, 'gh'),
        '#!/bin/sh\n' +
          'printf "%s\\n" "$*" >> "$GH_CALL_LOG"\n' +
          'if [ "$1" = issue ] && [ "$2" = list ]; then\n' +
          '  cat "$GH_ISSUES"\n' +
          '  exit 0\n' +
          'fi\n' +
          'if [ "$1" = issue ] && [ "$2" = edit ]; then\n' +
          '  exit 1\n' +
          'fi\n' +
          'exit 0\n',
        { mode: 0o755 },
      );
      try {
        const result = spawnSync(
          'bash',
          [releaseStepScriptAbsolutePath, 'reconcile-failure'],
          {
            cwd: directory,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              GH_CALL_LOG: ghLog,
              GH_ISSUES: issues,
              GH_REPO: 'QwenLM/qwen-code',
              RELEASE_VERSION: 'v1.2.3',
              FAILURE_TITLE_PREFIX: 'Chrome extension release failed for ',
              DETAILS_URL: 'https://github.example/run/1',
              RUN_ATTEMPT: '2',
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const calls = readFileSync(ghLog, 'utf8');
        expect(calls).toContain('issue close 202');
        expect(calls).not.toContain('issue close 101');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
