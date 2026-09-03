/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  REQUIRED_JOBS,
  verifyNightlyPromotion,
} from '../verify-nightly-promotion.js';

const nightlyVersion = '0.22.4-nightly.20260903.abcdef1234';
const nightlyTag = `v${nightlyVersion}`;
const sourceSha = 'abcdef1234567890abcdef1234567890abcdef12';
const releaseCommitSha = '1111111111111111111111111111111111111111';
const otherSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const currentSha = '2222222222222222222222222222222222222222';
const runHeadSha = '3333333333333333333333333333333333333333';

function runner({
  taggedParent = sourceSha,
  jobs = Object.fromEntries(REQUIRED_JOBS.map((name) => [name, 'success'])),
  artifactSource = sourceSha,
  artifactExpired = false,
  runAttempt = 1,
  extraArtifacts = [],
  npm = 'published',
  totalRuns = 1,
  workflowShaByRef = { [runHeadSha]: 'wf1', [currentSha]: 'wf1' },
} = {}) {
  let lastTagLookup = '';
  return (command, args) => {
    const joined = `${command} ${args.join(' ')}`;
    if (joined.includes('git/ref/tags/')) {
      lastTagLookup = joined;
      return JSON.stringify({
        object: { type: 'commit', sha: releaseCommitSha },
      });
    }
    if (joined.includes(`commits/${releaseCommitSha}`)) {
      const tagged = /git\/ref\/tags\/(\S+)/.exec(lastTagLookup)?.[1];
      return JSON.stringify({
        parents: [{ sha: taggedParent }],
        commit: { message: `chore(release): ${tagged}` },
      });
    }
    if (joined.includes('release view')) {
      return JSON.stringify({
        isPrerelease: true,
        publishedAt: '2026-09-03T10:00:00Z',
        tagName: args[2],
        url: `https://github.com/QwenLM/qwen-code/releases/tag/${nightlyTag}`,
      });
    }
    if (joined.startsWith('npm view @qwen-code/qwen-code@')) {
      if (npm === 'absent') {
        const error = new Error('command failed');
        error.stderr = 'npm error code E404\nnpm error 404 No match found';
        throw error;
      }
      if (npm === 'unreachable') {
        const error = new Error('socket hang up');
        error.stderr = 'npm error network ETIMEDOUT';
        throw error;
      }
      return JSON.stringify(args[1].split('@').pop());
    }
    if (joined.includes('actions/workflows/release.yml/runs?')) {
      // The candidate search must be bounded to the publication window
      // rather than scanning the head of the run list.
      expect(joined).toContain('created=2026-08-31..2026-09-04');
      return JSON.stringify({
        total_count: totalRuns,
        workflow_runs: [
          {
            id: 42,
            run_attempt: runAttempt,
            event: 'schedule',
            conclusion: 'success',
            created_at: '2026-09-03T09:00:00Z',
            updated_at: '2026-09-03T10:05:00Z',
            head_sha: runHeadSha,
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
          ...extraArtifacts,
        ],
      });
    }
    if (joined.includes('actions/runs/42/jobs')) {
      return JSON.stringify({
        jobs: Object.entries(jobs).map(([name, conclusion]) => ({
          name,
          conclusion,
        })),
      });
    }
    const workflowMatch =
      /contents\/\.github\/workflows\/release\.yml\?ref=(\w+)/.exec(joined);
    if (workflowMatch) {
      return JSON.stringify({ sha: workflowShaByRef[workflowMatch[1]] });
    }
    throw new Error(`Unexpected command: ${joined}`);
  };
}

function verify(options, sha = currentSha) {
  return verifyNightlyPromotion(
    nightlyTag,
    'QwenLM/qwen-code',
    runner(options),
    sha,
  );
}

describe('verifyNightlyPromotion', () => {
  it('binds a published nightly to its successful release validation', () => {
    expect(verify()).toMatchObject({
      nightlyTag,
      baseVersion: '0.22.4',
      sourceSha,
      taggedSourceSha: sourceSha,
      validationRunId: 42,
      warnings: [],
    });
  });

  it('takes the source from the recorded artifact, not the tag name', () => {
    // The tag's short SHA is a label written by `prepare`; a re-run whose
    // `prepare` outputs were reused can leave it naming an older revision
    // than the one `publish` built. The recorded artifact and the tagged
    // release parent still agree, so promotion proceeds with a warning.
    const result = verifyNightlyPromotion(
      'v0.22.4-nightly.20260903.9999999999',
      'QwenLM/qwen-code',
      runner(),
      currentSha,
    );
    expect(result.sourceSha).toBe(sourceSha);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('was built from');
  });

  it('rejects a run whose recorded source disagrees with the tagged parent', () => {
    expect(() => verify({ artifactSource: otherSha })).toThrow(
      'does not match the tagged release parent',
    );
  });

  it('names the required job that was not successful', () => {
    expect(() =>
      verify({
        jobs: {
          ...Object.fromEntries(REQUIRED_JOBS.map((name) => [name, 'success'])),
          'Quality Checks': 'skipped',
        },
      }),
    ).toThrow('required jobs not successful: Quality Checks=skipped');
  });

  it('reports missing source evidence instead of a bare no-match', () => {
    expect(() => verify({ artifactExpired: true })).toThrow(
      'no unexpired release-source-<sha> artifact',
    );
  });

  it('rejects a run that recorded conflicting source SHAs', () => {
    expect(() =>
      verify({
        extraArtifacts: [
          { name: `release-source-${otherSha}`, expired: false },
        ],
      }),
    ).toThrow('conflicting source SHAs');
  });

  it('rejects reruns whose artifacts and jobs may come from different attempts', () => {
    expect(() => verify({ runAttempt: 2 })).toThrow(
      'run_attempt is 2, not a first attempt',
    );
  });

  it('distinguishes an absent npm version from an unusable probe', () => {
    expect(() => verify({ npm: 'absent' })).toThrow(
      `${nightlyVersion} is not published on npm`,
    );
    expect(() => verify({ npm: 'unreachable' })).toThrow(
      `Cannot verify ${nightlyVersion} on npm`,
    );
  });

  it('refuses to promote when the run window cannot be searched exhaustively', () => {
    expect(() => verify({ totalRuns: 5000 })).toThrow(
      'the evidence search would be incomplete',
    );
  });

  it('warns when the release workflow changed since the validation run', () => {
    const result = verify({
      workflowShaByRef: { [runHeadSha]: 'wf1', [currentSha]: 'wf2' },
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('changed since run 42');
  });

  it('skips the workflow drift check when the current revision is unknown', () => {
    expect(verify({}, undefined).warnings).toEqual([]);
  });
});
