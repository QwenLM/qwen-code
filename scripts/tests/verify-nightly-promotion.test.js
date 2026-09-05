/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REQUIRED_JOBS,
  reportPromotion,
  runCli,
  verifyNightlyPromotion,
} from '../verify-nightly-promotion.js';

vi.mock('node:child_process');

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
  fullWindowRuns = 0,
  workflowShaByRef = { [runHeadSha]: 'wf1', [currentSha]: 'wf1' },
  // Stable releases the already-promoted scan can find; each resolves to
  // a release commit whose single parent is stableReleaseParent.
  stableReleases = [],
  stableReleaseParent = otherSha,
} = {}) {
  let lastTagLookup = '';
  const fullWindowPages = [];
  const run = (command, args) => {
    const joined = `${command} ${args.join(' ')}`;
    if (joined.includes('git/ref/tags/')) {
      lastTagLookup = joined;
      return JSON.stringify({
        object: { type: 'commit', sha: releaseCommitSha },
      });
    }
    if (joined.includes(`commits/${releaseCommitSha}`)) {
      const tagged = /git\/ref\/tags\/(\S+)/.exec(lastTagLookup)?.[1];
      // A plain vX.Y.Z tag lookup belongs to the already-promoted scan;
      // nightly-shaped tags belong to the promotion being verified.
      const stableLookup = /^v\d+\.\d+\.\d+$/.test(tagged ?? '');
      return JSON.stringify({
        parents: [{ sha: stableLookup ? stableReleaseParent : taggedParent }],
        commit: { message: `chore(release): ${tagged}` },
      });
    }
    if (joined.includes('repos/QwenLM/qwen-code/releases?')) {
      return JSON.stringify(
        stableReleases.map((tagName) => ({
          tag_name: tagName,
          prerelease: false,
          draft: false,
        })),
      );
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
      if (fullWindowRuns > 0) {
        // A window holding more runs than a short page can cover: every
        // response is a full page (RUNS_PER_PAGE = 100 runs), so the search
        // loop can only end at its page cap — the paging-cap test below
        // pins both the cap and the page=N advancement that reaches it.
        const page = Number(/[?&]page=(\d+)/.exec(joined)?.[1]);
        fullWindowPages.push(page);
        return JSON.stringify({
          total_count: fullWindowRuns,
          workflow_runs: Array.from({ length: 100 }, (_, index) => ({
            id: page * 1000 + index,
          })),
        });
      }
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
  run.fullWindowPages = fullWindowPages;
  return run;
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

  it('refuses a nightly whose source already shipped as a stable release', () => {
    // Re-dispatch of an already-promoted nightly with an empty `version`
    // input (npm `latest` caught up to the shipped stable): the version
    // step would derive a fresh next-minor from the moved latest and every
    // later guard would pass again, so the double promotion must fail
    // closed here, where the evidence lives — before the version step.
    expect(() =>
      verify({
        stableReleases: ['v0.23.0'],
        stableReleaseParent: sourceSha,
      }),
    ).toThrow('the nightly was already promoted');
  });

  it('promotes when the stable release was built on another source', () => {
    const result = verify({ stableReleases: ['v0.23.0'] });
    expect(result.sourceSha).toBe(sourceSha);
    expect(result.warnings).toEqual([]);
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

  it('rejects a run whose jobs list omits a required job entirely', () => {
    // A nightly validated by an older release.yml revision has the newer
    // REQUIRED_JOBS entry absent from its /jobs response — not 'skipped',
    // absent. The check filters REQUIRED_JOBS against the conclusions it
    // saw, so absence reads as missing evidence and refuses fail-closed;
    // reading membership over the returned jobs would accept the run and
    // promote validation that never ran the missing job.
    expect(() => verify({ jobs: { 'Quality Checks': 'success' } })).toThrow(
      'required jobs not successful: Integration Tests (No Sandbox)=absent, ' +
        'Integration Tests (Docker)=absent, Publish Release=absent',
    );
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

  it('refuses to promote when the run window outgrows the paged search', () => {
    // The test above exits through the short-page break on page one, so the
    // MAX_RUN_PAGES bound itself needs its own witness: a window holding 501
    // runs where every page comes back full (100 runs) can only stop at the
    // five-page cap, still short of the total. Raising or removing the cap
    // lets the loop page past the bound until runs.length >= total and the
    // refusal disappears.
    const run = runner({ fullWindowRuns: 501 });
    expect(() =>
      verifyNightlyPromotion(nightlyTag, 'QwenLM/qwen-code', run, currentSha),
    ).toThrow('the evidence search would be incomplete');
    expect(run.fullWindowPages).toEqual([1, 2, 3, 4, 5]);
  });

  it('warns when the release workflow changed since the validation run', () => {
    const result = verify({
      workflowShaByRef: { [runHeadSha]: 'wf1', [currentSha]: 'wf2' },
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('changed since run 42');
  });

  it('skips the workflow drift check when the current revision is unknown', () => {
    // Call the gate directly with an explicit falsy revision: the helper's
    // `sha = currentSha` default applies to undefined too and would forward
    // the known SHA, and null (unlike undefined) also bypasses the gate's
    // own `currentSha = process.env.GITHUB_SHA` default, which CI sets.
    // The fixture resolves a lookup for the falsy ref to 'wf2', so this
    // stays green only while the `currentSha ?` guard skips that lookup.
    const result = verifyNightlyPromotion(
      nightlyTag,
      'QwenLM/qwen-code',
      runner({ workflowShaByRef: { [runHeadSha]: 'wf1', null: 'wf2' } }),
      null,
    );
    expect(result.warnings).toEqual([]);
  });
});

// test-setup mocks appendFileSync, so assert on the calls, not the files.
describe('reportPromotion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const written = (name) =>
    vi
      .mocked(appendFileSync)
      .mock.calls.filter(([path]) => path === name)
      .map(([, body]) => body)
      .join('');

  it('writes the step outputs the workflow reads back', () => {
    vi.mocked(appendFileSync).mockClear();
    reportPromotion(verify(), { GITHUB_OUTPUT: 'out' });

    expect(written('out').split('\n')).toEqual([
      `source_sha=${sourceSha}`,
      'reuse_validation=true',
      '',
    ]);
  });

  it('renders the evidence, and any soft finding, into the summary', () => {
    vi.mocked(appendFileSync).mockClear();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportPromotion(
      verify({
        workflowShaByRef: { [runHeadSha]: 'wf1', [currentSha]: 'wf2' },
      }),
      { GITHUB_STEP_SUMMARY: 'summary' },
    );

    const rendered = written('summary');
    expect(rendered).toContain('### Nightly promotion');
    expect(rendered).toContain(sourceSha);
    expect(rendered).toContain('/actions/runs/42');
    expect(rendered).toContain(':warning: ');
    // The soft finding must also reach the run-level log annotation the
    // Actions UI shows at the top of the run, not only the step summary
    // someone has to open.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('::warning::');
    expect(errorSpy.mock.calls[0][0]).toContain('changed since run 42');
  });

  it('writes nothing outside a workflow run', () => {
    vi.mocked(appendFileSync).mockClear();
    reportPromotion(verify(), {});
    expect(vi.mocked(appendFileSync)).not.toHaveBeenCalled();
  });
});

describe('runCli', () => {
  const writtenTo = (name) =>
    vi
      .mocked(appendFileSync)
      .mock.calls.filter(([path]) => path === name)
      .map(([, body]) => body)
      .join('');

  beforeEach(() => {
    vi.mocked(appendFileSync).mockClear();
    vi.stubEnv('GITHUB_REPOSITORY', 'QwenLM/qwen-code');
    vi.stubEnv('GITHUB_OUTPUT', 'out');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const drive = (options) => {
    // Build one runner so its `lastTagLookup` closure state persists across
    // every gh/npm call in a single promotion check, exactly as the injected
    // runner does in the verifyNightlyPromotion suite.
    const run = runner(options);
    return vi
      .mocked(execFileSync)
      .mockImplementation((command, args) => run(command, args));
  };

  it('reports the verdict through reportPromotion and exits 0', () => {
    // Entry-point witness for the glue the prepare step invokes: the
    // verdict must reach the step outputs through reportPromotion. If it
    // regresses to printing raw JSON, the step exits 0 writing no outputs
    // and release_sha silently falls back to the dispatch HEAD.
    drive();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runCli([nightlyTag])).toBe(0);
    expect(writtenTo('out').split('\n')).toEqual([
      `source_sha=${sourceSha}`,
      'reuse_validation=true',
      '',
    ]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('marks deterministic evidence refusals for the failure notifier', () => {
    drive({ artifactExpired: true });
    // The Actions runner parses workflow commands from both stdout and
    // stderr (actions/runner's ScriptHandler wires each stream to its own
    // command-parsing OutputManager), so ::error:: annotates from either;
    // this pin keeps the stdout emitter working.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runCli([nightlyTag])).toBe(1);
    expect(logSpy.mock.calls[0][0]).toContain('::error::');
    expect(logSpy.mock.calls[0][0]).toContain(
      'no matching successful Release run',
    );
    // The marker is what keeps this correct refusal out of the
    // release-failed issue and autofix dispatch; the step still fails.
    expect(writtenTo('out')).toBe('promotion_refusal=true\n');
  });

  it('marks an already-promoted source refusal for the failure notifier', () => {
    drive({ stableReleases: ['v0.23.0'], stableReleaseParent: sourceSha });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runCli([nightlyTag])).toBe(1);
    expect(logSpy.mock.calls[0][0]).toContain('::error::');
    expect(logSpy.mock.calls[0][0]).toContain('already promoted');
    expect(writtenTo('out')).toBe('promotion_refusal=true\n');
  });

  it('marks a malformed promote_nightly input as a refusal', () => {
    // A deterministic input-shape failure: no retry or code change can make
    // a typo parse, so it carries the refusal marker exactly like an
    // evidence refusal and stays out of the release-failed issue; the step
    // still fails with exit 1, and the ::error:: still surfaces the typo.
    drive();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runCli(['bogus'])).toBe(1);
    expect(logSpy.mock.calls[0][0]).toContain('::error::');
    expect(logSpy.mock.calls[0][0]).toContain('Invalid nightly version');
    expect(writtenTo('out')).toBe('promotion_refusal=true\n');
  });

  it('leaves probe failures unmarked so they still notify', () => {
    drive({ npm: 'unreachable' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runCli([nightlyTag])).toBe(1);
    expect(writtenTo('out')).not.toContain('promotion_refusal=true');
  });

  it('leaves environment failures unmarked so they still notify', () => {
    drive();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // No GITHUB_REPOSITORY in the explicit env: a configuration failure,
    // not a deterministic refusal, stays unmarked and notifiable.
    expect(runCli([nightlyTag], { GITHUB_OUTPUT: 'out' })).toBe(1);
    expect(writtenTo('out')).toBe('');
  });
});
