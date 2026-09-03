/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { verifyNightlyPromotion } from '../verify-nightly-promotion.js';

const nightlyVersion = '0.22.4-nightly.20260903.abcdef1234';
const nightlyTag = `v${nightlyVersion}`;
const sourceSha = 'abcdef1234567890abcdef1234567890abcdef12';

function runner({
  source = sourceSha,
  quality = 'success',
  artifactSource = sourceSha,
  artifactExpired = false,
  runAttempt = 1,
} = {}) {
  return (command, args) => {
    const joined = `${command} ${args.join(' ')}`;
    if (joined.includes(`git/ref/tags/${nightlyTag}`)) {
      return JSON.stringify({
        object: {
          type: 'commit',
          sha: '1111111111111111111111111111111111111111',
        },
      });
    }
    if (joined.includes('commits/1111111111111111111111111111111111111111')) {
      return JSON.stringify({
        parents: [{ sha: source }],
        commit: { message: `chore(release): ${nightlyTag}` },
      });
    }
    if (joined.includes('release view')) {
      return JSON.stringify({
        isPrerelease: true,
        publishedAt: '2026-09-03T10:00:00Z',
        tagName: nightlyTag,
        url: `https://github.com/QwenLM/qwen-code/releases/tag/${nightlyTag}`,
      });
    }
    if (joined.startsWith(`npm view @qwen-code/qwen-code@${nightlyVersion}`)) {
      return JSON.stringify(nightlyVersion);
    }
    if (
      joined.includes(
        'actions/workflows/release.yml/runs?status=completed&per_page=100',
      )
    ) {
      return JSON.stringify({
        workflow_runs: [
          {
            id: 42,
            run_attempt: runAttempt,
            event: 'schedule',
            conclusion: 'success',
            created_at: '2026-09-03T09:00:00Z',
            updated_at: '2026-09-03T10:05:00Z',
            html_url: 'https://github.com/QwenLM/qwen-code/actions/runs/42',
          },
        ],
      });
    }
    if (joined.includes('actions/runs/42/artifacts')) {
      return JSON.stringify({
        artifacts: [
          {
            name: `release-source-${artifactSource}`,
            expired: artifactExpired,
          },
        ],
      });
    }
    if (joined.includes('actions/runs/42/jobs')) {
      return JSON.stringify({
        jobs: [
          { name: 'Quality Checks', conclusion: quality },
          { name: 'Integration Tests (No Sandbox)', conclusion: 'success' },
          { name: 'Integration Tests (Docker)', conclusion: 'success' },
          { name: 'Publish Release', conclusion: 'success' },
        ],
      });
    }
    throw new Error(`Unexpected command: ${joined}`);
  };
}

describe('verifyNightlyPromotion', () => {
  it('binds a published nightly to its successful release validation', () => {
    expect(
      verifyNightlyPromotion(nightlyTag, 'QwenLM/qwen-code', runner()),
    ).toMatchObject({
      nightlyTag,
      stableVersion: '0.22.4',
      sourceSha,
      validationRunId: 42,
    });
  });

  it('rejects a nightly whose tag does not point to the named source', () => {
    expect(() =>
      verifyNightlyPromotion(
        nightlyTag,
        'QwenLM/qwen-code',
        runner({ source: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
      ),
    ).toThrow('names source abcdef1234');
  });

  it('rejects a successful run when a required validation job was skipped', () => {
    expect(() =>
      verifyNightlyPromotion(
        nightlyTag,
        'QwenLM/qwen-code',
        runner({ quality: 'skipped' }),
      ),
    ).toThrow('no matching successful Release run');
  });

  it('rejects a run without evidence for the resolved release source', () => {
    expect(() =>
      verifyNightlyPromotion(
        nightlyTag,
        'QwenLM/qwen-code',
        runner({ artifactSource: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
      ),
    ).toThrow('no matching successful Release run');
  });

  it('rejects expired source evidence', () => {
    expect(() =>
      verifyNightlyPromotion(
        nightlyTag,
        'QwenLM/qwen-code',
        runner({ artifactExpired: true }),
      ),
    ).toThrow('no matching successful Release run');
  });

  it('rejects reruns whose artifacts and jobs may come from different attempts', () => {
    expect(() =>
      verifyNightlyPromotion(
        nightlyTag,
        'QwenLM/qwen-code',
        runner({ runAttempt: 2 }),
      ),
    ).toThrow('no matching successful Release run');
  });
});
