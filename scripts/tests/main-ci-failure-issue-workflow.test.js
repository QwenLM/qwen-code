/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
import {
  renderFailureComment,
  testKey,
} from '../../.github/scripts/ci/main-failure-signature.mjs';

describe('main CI failure issue workflow', () => {
  const workflow = readFileSync(
    '.github/workflows/main-ci-failure-issue.yml',
    'utf8',
  );
  const yml = parse(workflow);
  const jobs = yml.jobs;
  // Collapse line continuations first so pins read like the shell they pin
  // rather than like this file's indentation.
  const oneLine = (script) =>
    script.replace(/\\\n/g, '\n').replace(/\s+/g, ' ');

  it('watches main failures and Managed Agent PR failures', () => {
    expect(workflow).toContain('workflow_run:');
    // 'SDK Java' and 'Desktop Checks' joined when #14205 moved both suites
    // off pull_request/push onto a daily schedule: a red scheduled run is now
    // their only failure signal, so both ride the same workflow issue as the nightly CLI checks.
    const watchedFiles = {
      'E2E Tests': 'e2e',
      'Managed Agent gate': 'managed-agent-gate',
      'SDK Java': 'sdk-java',
      'SDK Python': 'sdk-python',
      'Qwen Code CI': 'ci',
      'Desktop Checks': 'desktop-packaging-check',
      'tui-parity': 'tui-parity',
    };
    // workflow_run matches the list as a set, so its order is not pinned.
    expect([...yml.on.workflow_run.workflows].sort()).toEqual(
      Object.keys(watchedFiles).sort(),
    );
    // workflow_run.workflows matches the watched workflow's name: key, so a
    // watch entry is live only while its file still carries that name —
    // renaming one silently unhooks the suite's failure issues, and nothing
    // else here reads the coupling for all of them.
    for (const [watchedName, watchedFile] of Object.entries(watchedFiles)) {
      const definition = parse(
        readFileSync(`.github/workflows/${watchedFile}.yml`, 'utf8'),
      );
      expect(definition.name, watchedFile).toBe(watchedName);
    }
    expect(workflow).toContain("types: ['completed']");
    // Approval runs use the PR branch, including when they finish after merge.
    expect(Object.keys(yml.on.workflow_run).sort()).toEqual([
      'types',
      'workflows',
    ]);
    expect(workflow).toContain("github.repository == 'QwenLM/qwen-code'");
    expect(workflow).toContain(
      "github.event.workflow_run.conclusion == 'failure'",
    );
    expect(workflow).toContain(
      "github.event.workflow_run.head_branch == 'main'",
    );
    // Pin the whole expression; substring checks miss an appended `|| true`
    // that would admit unrelated contributor-triggered runs.
    expect(jobs.analyze.if).toBe(
      "${{ github.repository == 'QwenLM/qwen-code' && " +
        "github.event.workflow_run.conclusion == 'failure' && " +
        "((github.event.workflow_run.head_branch == 'main' && " +
        "(github.event.workflow_run.event == 'push' || " +
        "(github.event.workflow_run.event == 'schedule' && " +
        'contains(fromJSON(\'["Qwen Code CI","SDK Java","Desktop Checks","tui-parity"]\'), github.event.workflow.name)))) || ' +
        "(github.event.workflow_run.event == 'workflow_dispatch' && github.event.workflow.name == 'SDK Java') || " +
        "(github.event.workflow.name == 'Managed Agent gate' && " +
        'contains(fromJSON(\'["pull_request","pull_request_review"]\'), github.event.workflow_run.event))) }}',
    );
    // Only a watched workflow ever raises the event, so a schedule-arm name
    // missing from the watch list is dead — and the pin above, updated in
    // the same edit, would not notice.
    const scheduledNames = JSON.parse(
      /fromJSON\('(\[[^']*\])'\)/.exec(jobs.analyze.if)[1],
    );
    for (const name of scheduledNames) {
      expect(Object.keys(watchedFiles), name).toContain(name);
    }
  });

  it.each([
    ['SDK Java', 'workflow_dispatch', 'main', 'failure', true],
    ['SDK Java', 'workflow_dispatch', 'feature', 'failure', true],
    ['SDK Python', 'workflow_dispatch', 'main', 'failure', false],
    ['SDK Java', 'schedule', 'main', 'failure', true],
    ['tui-parity', 'schedule', 'main', 'failure', true],
    ['tui-parity', 'schedule', 'main', 'success', false],
    ['tui-parity', 'schedule', 'main', 'cancelled', false],
    ['tui-parity', 'schedule', 'main', 'skipped', false],
    ['tui-parity', 'schedule', 'feature', 'failure', false],
    ['tui-parity', 'pull_request', 'feature', 'failure', false],
    ['tui-parity', 'workflow_dispatch', 'feature', 'failure', false],
    ['tui-parity', 'workflow_dispatch', 'main', 'failure', false],
    ['Managed Agent gate', 'push', 'main', 'failure', true],
    ['Managed Agent gate', 'pull_request_review', 'feature', 'failure', true],
    ['Managed Agent gate', 'pull_request', 'feature', 'failure', true],
    ['Qwen Code CI', 'pull_request', 'feature', 'failure', false],
    ['Managed Agent gate', 'pull_request_review', 'feature', 'success', false],
  ])(
    'routes %s / %s / %s / %s to reporting: %s',
    (name, event, branch, conclusion, expected) => {
      const evaluate = new Function(
        'github',
        'contains',
        'fromJSON',
        `return (${jobs.analyze.if.slice(3, -2)});`,
      );
      expect(
        evaluate(
          {
            repository: 'QwenLM/qwen-code',
            event: {
              workflow: { name },
              workflow_run: { event, head_branch: branch, conclusion },
            },
          },
          (list, value) => list.includes(value),
          JSON.parse,
        ),
      ).toBe(expected);
    },
  );

  describe('failure destination', () => {
    const destination = jobs.analyze.steps.find(
      (step) => step.id === 'destination',
    );
    const resolve = (prs, overrides = {}, ghScript) => {
      const tmp = mkdtempSync(join(tmpdir(), 'java-ci-destination-'));
      try {
        writeFileSync(join(tmp, 'pulls.json'), JSON.stringify(prs));
        writeFileSync(
          join(tmp, 'gh'),
          ghScript ??
            `#!/usr/bin/env bash
printf '%s\\n' "$@" > "\${RUNNER_TEMP}/lookup-args"
cat "\${RUNNER_TEMP}/pulls.json"
`,
        );
        chmodSync(join(tmp, 'gh'), 0o755);
        const output = join(tmp, 'output');
        const result = spawnSync(
          'bash',
          ['-eo', 'pipefail', '-c', destination.run],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${tmp}:${process.env.PATH}`,
              RUNNER_TEMP: tmp,
              GITHUB_OUTPUT: output,
              REPO: 'QwenLM/qwen-code',
              EVENT_NAME: 'pull_request_review',
              HEAD_BRANCH: 'ci/java',
              // An approval run records the BASE repository here even when
              // the PR head lives in a fork; the step no longer consults it,
              // and the fork cases below keep passing it to document that.
              HEAD_REPO: 'QwenLM/qwen-code',
              HEAD_SHA: 'tested-head',
              // A fresh approval run, which is what the guard keeps filing.
              RUN_ATTEMPT: '1',
              ...overrides,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        return {
          output: existsSync(output) ? readFileSync(output, 'utf8') : '',
          stdout: result.stdout,
          args: existsSync(join(tmp, 'lookup-args'))
            ? readFileSync(join(tmp, 'lookup-args'), 'utf8')
            : '',
        };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };
    const pr = (extra = {}) => ({
      number: 14472,
      head: { sha: 'tested-head', repo: { full_name: 'QwenLM/qwen-code' } },
      base: { ref: 'main', repo: { full_name: 'QwenLM/qwen-code' } },
      merged_at: null,
      ...extra,
    });

    it('reports an approval failure with no workflow_run pull_requests association', () => {
      const resolved = resolve([pr()]);
      expect(resolved.output).toBe('pr_number=14472\nfile_issue=false\n');
      expect(resolved.stdout).not.toContain('::warning::');
      expect(resolved.args).toContain('state=all');
      expect(resolved.args).toContain('--paginate');
    });
    it('resolves a fork approval run, which records the base repository as its head repository', () => {
      // On a pull_request_review run head_repository is the BASE repository
      // even when the PR head lives in a fork, so a listing filter derived
      // from it finds nothing; the exact head SHA qualifies the PR instead.
      // Measured against the live API on 2026-10-17: 21 of the 60 most
      // recent Managed Agent gate approval runs are fork PRs.
      const resolved = resolve([
        pr({
          head: {
            sha: 'tested-head',
            repo: { full_name: 'CanReader/qwen-code' },
          },
        }),
      ]);
      expect(resolved.output).toBe('pr_number=14472\nfile_issue=false\n');
    });
    it('passes the attempt to the destination guard', () => {
      // Without this wiring the guard reads an empty attempt and every
      // rerun files exactly as before.
      expect(destination.env.RUN_ATTEMPT).toBe(
        '${{ github.event.workflow_run.run_attempt }}',
      );
    });
    it('wires the filed issue URL into the PR commenter', () => {
      // A renamed output renders ISSUE_URL empty, which now selects the
      // recovery branch instead of linking a first comment to its issue.
      expect(jobs.report_pr.steps[0].env.ISSUE_URL).toBe(
        '${{ needs.file_issue.outputs.issue_url }}',
      );
      expect(jobs.file_issue.outputs.issue_url).toBe(
        '${{ steps.issue.outputs.issue_url }}',
      );
    });
    it('also files an issue when the failed PR already merged', () => {
      expect(resolve([pr({ merged_at: '2026-10-17T16:15:57Z' })]).output).toBe(
        'pr_number=14472\nfile_issue=true\n',
      );
    });
    it.each(['pull_request', 'pull_request_review'])(
      'does not file for a %s rerun of a merged PR workflow',
      (eventName) => {
        // Run 39768204855's attempt 2 re-ran the PR's pre-merge workflow; the
        // lock timeout it hit could not describe main, and filing it created
        // #15239. Main's own push and nightly runs carry that signal. That
        // rerun carried `pull_request`; a rerun of an approval run carries
        // the harness's default. Both are the PR's pre-merge workflow.
        const resolved = resolve([pr({ merged_at: '2026-10-17T16:15:57Z' })], {
          EVENT_NAME: eventName,
          RUN_ATTEMPT: '2',
        });
        expect(resolved.output).toBe('pr_number=14472\nfile_issue=false\n');
        expect(resolved.stdout).toContain(
          "Attempt 2 of the PR's pre-merge workflow",
        );
      },
    );
    it('files a fresh dispatch on a merged PR branch', () => {
      // A maintainer's manual run is attempt 1 even when it starts long
      // after the merge; only reruns are stale.
      expect(
        resolve([pr({ merged_at: '2026-10-17T16:15:57Z' })], {
          EVENT_NAME: 'workflow_dispatch',
          HEAD_BRANCH: 'ci/java',
        }).output,
      ).toBe('pr_number=14472\nfile_issue=true\n');
    });

    it('files a rerun of a fresh dispatch on a merged PR branch', () => {
      // A dispatch's attempt counts its own manual runs, not a rerun of the
      // PR's pre-merge workflow; suppressing it would drop a real failure of
      // the tree the merged branch now carries.
      expect(
        resolve([pr({ merged_at: '2026-10-17T16:15:57Z' })], {
          EVENT_NAME: 'workflow_dispatch',
          HEAD_BRANCH: 'ci/java',
          RUN_ATTEMPT: '2',
        }).output,
      ).toBe('pr_number=14472\nfile_issue=true\n');
    });
    it('falls back to filing when the attempt is unreadable', () => {
      // The guard must not turn a missing payload field into silence: before
      // this change every merged-PR failure filed, and an unreadable attempt
      // keeps that direction — and says so.
      const resolved = resolve([pr({ merged_at: '2026-10-17T16:15:57Z' })], {
        RUN_ATTEMPT: '',
      });
      expect(resolved.output).toBe('pr_number=14472\nfile_issue=true\n');
      expect(resolved.stdout).toContain(
        'No run_attempt in the workflow_run payload',
      );
    });
    it('does not report a superseded head, wherever the same-named branch lives', () => {
      // The exact head SHA qualifies the PR: a branch whose head is another
      // commit must not attract the comment meant for this run's commit —
      // including a same-named branch on an unrelated fork.
      for (const repo of ['QwenLM/qwen-code', 'someone/qwen-code']) {
        const resolved = resolve([
          pr({ head: { sha: 'new-head', repo: { full_name: repo } } }),
        ]);
        expect(resolved.output).toBe('pr_number=\nfile_issue=false\n');
        expect(resolved.stdout).toContain('::warning::');
      }
    });
    it('does not report a PR closed without merging', () => {
      // The listing widened to state=all so a merged PR resolves; a
      // closed-unmerged PR satisfies every other term but must not be handed
      // a permanent bot comment.
      const closed = resolve([pr({ state: 'closed' })]);
      expect(closed.output).toBe('pr_number=\nfile_issue=false\n');
      expect(closed.stdout).toContain('::warning::');
      expect(
        resolve([pr({ state: 'closed', merged_at: '2026-10-17T16:15:57Z' })])
          .output,
      ).toBe('pr_number=14472\nfile_issue=true\n');
    });
    it('never files an issue for a contributor-triggered run, even on a main-named branch', () => {
      // A fork PR can be opened from the contributor's own main branch
      // (managed-agent-gate.yml accepts it); the event allow-list in the
      // first arm is the only thing routing such a run to the PR instead of
      // to a main-regression issue for unmerged code.
      const resolved = resolve(
        [
          pr({
            head: {
              sha: 'tested-head',
              repo: { full_name: 'someone/qwen-code' },
            },
          }),
        ],
        {
          EVENT_NAME: 'pull_request',
          HEAD_BRANCH: 'main',
          HEAD_REPO: 'someone/qwen-code',
        },
      );
      expect(resolved.output).toBe('pr_number=14472\nfile_issue=false\n');
    });
    it.each(['workflow_dispatch', 'schedule'])(
      'files a main %s failure without a PR',
      (event) => {
        const resolved = resolve([], {
          EVENT_NAME: event,
          HEAD_BRANCH: 'main',
        });
        expect(resolved.output).toBe('pr_number=\nfile_issue=true\n');
        expect(resolved.args).toBe('');
        expect(resolved.stdout).not.toContain('::warning::');
      },
    );
    it('still files for a later attempt of a main run', () => {
      // The attempt guard lives in the PR-lookup else branch, so a main run
      // files at every attempt; hoisting it below the `fi` would silently
      // delete main's attempt-2 recovery path.
      expect(
        resolve([], {
          EVENT_NAME: 'push',
          HEAD_BRANCH: 'main',
          RUN_ATTEMPT: '2',
        }).output,
      ).toBe('pr_number=\nfile_issue=true\n');
    });
    it('warns and reports nothing when the run resolves to no destination', () => {
      // A manual dispatch on a branch with no open PR is admitted and then
      // dropped; the warning keeps the miss distinguishable from "correctly
      // nothing to report".
      const resolved = resolve([], {
        EVENT_NAME: 'workflow_dispatch',
        HEAD_BRANCH: 'ci/java-experiment',
      });
      expect(resolved.output).toBe('pr_number=\nfile_issue=false\n');
      expect(resolved.stdout).toContain('::warning::');
    });
    it('degrades to no destination when the PR listing fails', () => {
      // The lookup must fail soft like its neighbouring reads: a transient
      // API error aborting this step would fail the analyze job and lose
      // BOTH the PR comment and the issue for a real failure.
      for (const body of ['{"message": "Bad credentials"}', '']) {
        const gh = `#!/usr/bin/env bash\nprintf '%s' '${body}'\nexit 1\n`;
        const resolved = resolve([], {}, gh);
        expect(resolved.output).toBe('pr_number=\nfile_issue=false\n');
        expect(resolved.stdout).toContain('::warning::');
      }
    });
  });

  describe('superseded attempts', () => {
    const live = jobs.analyze.steps.find((step) => step.id === 'live');
    const destination = jobs.analyze.steps.find(
      (step) => step.id === 'destination',
    );
    const detect = (liveAttempt, overrides = {}, options = {}) => {
      const {
        ghScript,
        mainTip,
        successor = 'completed success',
        failCall = '',
      } = options;
      const tmp = mkdtempSync(join(tmpdir(), 'java-ci-live-'));
      try {
        writeFileSync(
          join(tmp, 'gh'),
          ghScript ??
            `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${RUNNER_TEMP}/calls.log"
case '${failCall}' in
  tip)
    if [[ "$*" == *commits/main* ]]; then
      printf '%s' '{"message":"Bad credentials"}'
      exit 1
    fi
    ;;
  newer-runs)
    if [[ "$*" == *actions/workflows/*/runs* ]]; then
      printf '%s' '{"message":"Bad credentials"}'
      exit 1
    fi
    ;;
esac
if [[ "$*" == *commits/main* ]]; then
  printf '%s\\n' '${mainTip}'
elif [[ "$*" == *actions/workflows/*/runs* ]]; then
  printf '%s\\n' '${successor}'
else
  printf '%s\\n' "$@" > "\${RUNNER_TEMP}/lookup-args"
  printf '%s\\n' '${liveAttempt}'
fi
`,
        );
        chmodSync(join(tmp, 'gh'), 0o755);
        const output = join(tmp, 'output');
        const summary = join(tmp, 'summary');
        const result = spawnSync('bash', ['-eo', 'pipefail', '-c', live.run], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${tmp}:${process.env.PATH}`,
            RUNNER_TEMP: tmp,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            REPO: 'QwenLM/qwen-code',
            WORKFLOW_RUN_ID: '39237270547',
            WORKFLOW_ID: '12345',
            RUN_ATTEMPT: '1',
            EVENT_NAME: '',
            HEAD_BRANCH: '',
            HEAD_SHA: '',
            ...overrides,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        return {
          output: existsSync(output) ? readFileSync(output, 'utf8') : '',
          stdout: result.stdout,
          args: existsSync(join(tmp, 'lookup-args'))
            ? readFileSync(join(tmp, 'lookup-args'), 'utf8')
            : '',
          calls: existsSync(join(tmp, 'calls.log'))
            ? readFileSync(join(tmp, 'calls.log'), 'utf8')
            : '',
          summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
        };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };

    it('skips reporting when the run has moved on to a later attempt', () => {
      // Measured on run 39237270547: attempt 1 failed on the host lock,
      // attempt 2 went green, and this job started hours later, read the green
      // attempt's empty failure list, and filed #14768 for the green head.
      // A moved tip must not add a second, contradictory suppression reason:
      // this event is already stale whatever main's head is.
      const resolved = detect(
        '2',
        {
          EVENT_NAME: 'push',
          HEAD_BRANCH: 'main',
          HEAD_SHA: 'old-head',
        },
        { mainTip: 'new-head' },
      );
      expect(resolved.output).toBe('superseded=true\nprovisional=false\n');
      expect(resolved.stdout).toContain('::warning::');
      expect(resolved.stdout).not.toContain('main is now');
      expect(resolved.calls).not.toContain('commits/main');
      expect(resolved.args).toBe(
        'api\nrepos/QwenLM/qwen-code/actions/runs/39237270547\n--jq\n.run_attempt\n',
      );
      // The own-run spellings would query this workflow's run, whose attempt
      // is always 1, and the guard could never see a re-run.
      expect(live.env.WORKFLOW_RUN_ID).toBe(
        '${{ github.event.workflow_run.id }}',
      );
      expect(live.env.RUN_ATTEMPT).toBe(
        '${{ github.event.workflow_run.run_attempt }}',
      );
      // The tip comparison reads the triggering run's event and head; the
      // own-run spellings would compare this workflow's own commit.
      expect(live.env.EVENT_NAME).toBe(
        '${{ github.event.workflow_run.event }}',
      );
      expect(live.env.HEAD_BRANCH).toBe(
        '${{ github.event.workflow_run.head_branch }}',
      );
      expect(live.env.HEAD_SHA).toBe(
        '${{ github.event.workflow_run.head_sha }}',
      );
      expect(live.env.WORKFLOW_ID).toBe(
        '${{ github.event.workflow_run.workflow_id }}',
      );
    });
    it('reports the attempt that is still the latest', () => {
      expect(detect('1').output).toBe('superseded=false\nprovisional=false\n');
      expect(detect('2', { RUN_ATTEMPT: '2' }).output).toBe(
        'superseded=false\nprovisional=false\n',
      );
      // Stale-attempt supersession is independent of the tip comparison:
      // a bare event never reaches the push arm, and the nightly schedule
      // arm is exempt from it. Folding the attempt check inside that arm
      // would file an issue for an already-green rerun (#14768's shape).
      expect(detect('2').output).toBe('superseded=true\nprovisional=false\n');
      expect(
        detect('2', {
          EVENT_NAME: 'schedule',
          HEAD_BRANCH: 'main',
          HEAD_SHA: 'old-head',
        }).output,
      ).toBe('superseded=true\nprovisional=false\n');
    });
    it('skips a push run when main has advanced past its head', () => {
      // Run 39777472391's push run tested 06e59666, main moved on to
      // 3d65e23cf62e before this job analyzed it, and that head's own push
      // run later passed. #15128 had already fixed the host-lock timeout the
      // old run reported, so the per-commit issue filed for 06e59666 (#15259)
      // could only ask for a repair main already contained.
      const resolved = detect(
        '1',
        {
          EVENT_NAME: 'push',
          HEAD_BRANCH: 'main',
          HEAD_SHA: '06e59666dfaaaa0aaf78af45bc48b0405a8e7d44',
        },
        { mainTip: '3d65e23cf62e00da033dccb8f60f9cfdd9c1b76e' },
      );
      expect(resolved.output).toBe('superseded=true\nprovisional=false\n');
      expect(resolved.stdout).toContain(
        'main is now 3d65e23cf62e00da033dccb8f60f9cfdd9c1b76e',
      );
      expect(resolved.calls).toContain('commits/main');
      // A dropped report files no issue and fails no job; the run page is
      // the only place a maintainer can see why the report is missing.
      expect(resolved.summary).toContain(
        'Superseded main-CI failure: run 39237270547 tested 06e59666dfaaaa0aaf78af45bc48b0405a8e7d44',
      );
      expect(resolved.summary).toContain(
        'main is now 3d65e23cf62e00da033dccb8f60f9cfdd9c1b76e',
      );
    });
    it('fails open when main moved but its workflow has no run there', () => {
      // A path-filtered push arm (SDK Python) and a skipped tier leave no run
      // of the same workflow at the new tip. Suppressing then would drop the
      // only report of a real regression, so the successor must exist.
      const resolved = detect(
        '1',
        {
          EVENT_NAME: 'push',
          HEAD_BRANCH: 'main',
          HEAD_SHA: 'old-head',
        },
        { mainTip: 'new-head', successor: 'none' },
      );
      expect(resolved.output).toBe('superseded=false\nprovisional=false\n');
      expect(resolved.stdout).toContain('no newer push run');
      expect(resolved.calls).toContain(
        'actions/workflows/12345/runs?event=push&branch=main&head_sha=new-head&per_page=1',
      );
    });
    it('reports a push run whose successor cannot report its result', () => {
      // The job gate admits only failures, so a successor that ended
      // cancelled/timed_out/skipped never re-enters this workflow. Crediting
      // its mere existence would drop the only report of a real regression.
      const resolved = detect(
        '1',
        {
          EVENT_NAME: 'push',
          HEAD_BRANCH: 'main',
          HEAD_SHA: 'old-head',
        },
        { mainTip: 'new-head', successor: 'completed cancelled' },
      );
      expect(resolved.output).toBe('superseded=false\nprovisional=false\n');
      expect(resolved.stdout).toContain('completed cancelled');
      expect(resolved.stdout).toContain('does not report');
      expect(resolved.summary).toBe('');
    });
    it('reports a push run whose successor has not settled, flagged provisional', () => {
      // A running successor proves nothing yet, and this job cannot wait for
      // it: the hosted pool queued the reporter for 20-100 minutes, so the
      // tip's run is usually young. The successor's own re-entry covers only
      // the failure conclusion, so discarding here loses a real regression
      // whenever that run ends cancelled (#15470). The report is filed with
      // the caveat instead, and the per-signature route hands it to a human
      // rather than autofix, so a stale one costs a close.
      // Every not-yet-final status counts, matching the vocabulary
      // qwen-autofix.yml uses for the same question.
      for (const successor of [
        'in_progress',
        'queued',
        'waiting',
        'requested',
        'pending',
      ]) {
        const resolved = detect(
          '1',
          {
            EVENT_NAME: 'push',
            HEAD_BRANCH: 'main',
            HEAD_SHA: 'old-head',
          },
          { mainTip: 'new-head', successor },
        );
        expect(resolved.output).toBe('superseded=false\nprovisional=true\n');
        expect(resolved.stdout).toContain(
          `${successor}, so this report is provisional`,
        );
        expect(resolved.summary).toBe('');
      }
    });
    it('fails open when the newer-run lookup cannot be read', () => {
      const resolved = detect(
        '1',
        {
          EVENT_NAME: 'push',
          HEAD_BRANCH: 'main',
          HEAD_SHA: 'old-head',
        },
        { mainTip: 'new-head', failCall: 'newer-runs' },
      );
      expect(resolved.output).toBe('superseded=false\nprovisional=false\n');
      expect(resolved.stdout).toContain(
        'Could not list the newer runs of workflow 12345',
      );
      expect(resolved.calls).toContain('commits/main');
    });
    it('skips a recovery attempt when a newer run owns the tip', () => {
      // #15259 itself was filed by attempt 2: the rerun queued while main
      // advanced to a commit whose own push run owned the result.
      const resolved = detect(
        '2',
        {
          RUN_ATTEMPT: '2',
          EVENT_NAME: 'push',
          HEAD_BRANCH: 'main',
          HEAD_SHA: 'old-head',
        },
        { mainTip: 'new-head', successor: 'completed failure' },
      );
      expect(resolved.output).toBe('superseded=true\nprovisional=false\n');
      expect(resolved.stdout).toContain('main is now new-head');
      expect(resolved.calls).toContain('commits/main');
    });
    it('reports a recovery attempt when the advanced tip has no run', () => {
      // An infrastructure-only attempt 1 dispatches a rerun and files
      // nothing; with no run at the new tip, attempt 2 is the chain's only
      // report of a failure main still carries.
      const resolved = detect(
        '2',
        {
          RUN_ATTEMPT: '2',
          EVENT_NAME: 'push',
          HEAD_BRANCH: 'main',
          HEAD_SHA: 'old-head',
        },
        { mainTip: 'new-head', successor: 'none' },
      );
      expect(resolved.output).toBe('superseded=false\nprovisional=false\n');
      expect(resolved.stdout).toContain('no newer push run');
      expect(resolved.calls).toContain('commits/main');
    });
    it('reports a push run while its head is still the tip of main', () => {
      const resolved = detect(
        '1',
        {
          EVENT_NAME: 'push',
          HEAD_BRANCH: 'main',
          HEAD_SHA: 'tested-head',
        },
        { mainTip: 'tested-head' },
      );
      expect(resolved.output).toBe('superseded=false\nprovisional=false\n');
      expect(resolved.stdout).not.toContain('::warning::');
      expect(resolved.calls).toContain('commits/main');
    });
    it('fails open when the tip of main is empty', () => {
      // A successful read that prints nothing must not compare as a moved
      // tip: only a non-empty sha that differs from the head suppresses.
      const resolved = detect(
        '1',
        {
          EVENT_NAME: 'push',
          HEAD_BRANCH: 'main',
          HEAD_SHA: 'old-head',
        },
        { mainTip: '' },
      );
      expect(resolved.output).toBe('superseded=false\nprovisional=false\n');
    });
    it('does not compare a scheduled run with the tip of main', () => {
      // A schedule runs at its own head and is the only signal macOS and
      // Windows lanes have; suppressing it because main moved would drop that
      // lane's report for good.
      const resolved = detect(
        '1',
        {
          EVENT_NAME: 'schedule',
          HEAD_BRANCH: 'main',
          HEAD_SHA: 'old-head',
        },
        { mainTip: 'new-head' },
      );
      expect(resolved.output).toBe('superseded=false\nprovisional=false\n');
      expect(resolved.calls).not.toContain('commits/main');
    });
    it.each([['pull_request'], ['pull_request_review'], ['workflow_dispatch']])(
      'does not compare a %s run with the tip of main',
      (event) => {
        // These are the other events the analyze gate admits: the Managed
        // Agent gate's PR arms and the manual SDK Java arm. A fork PR can be
        // opened from the contributor's own main branch, so a moved tip is a
        // real state here and must not suppress the report.
        const resolved = detect(
          '1',
          {
            EVENT_NAME: event,
            HEAD_BRANCH: 'main',
            HEAD_SHA: 'old-head',
          },
          { mainTip: 'new-head' },
        );
        expect(resolved.output).toBe('superseded=false\nprovisional=false\n');
        expect(resolved.calls).not.toContain('commits/main');
      },
    );
    it('fails open when the tip of main cannot be read', () => {
      const resolved = detect(
        '1',
        {
          EVENT_NAME: 'push',
          HEAD_BRANCH: 'main',
          HEAD_SHA: 'old-head',
        },
        { mainTip: 'new-head', failCall: 'tip' },
      );
      expect(resolved.output).toBe('superseded=false\nprovisional=false\n');
      expect(resolved.stdout).toContain('Could not read the tip of main');
      expect(resolved.calls).toContain('commits/main');
    });
    it('fails open when the event carries no head sha', () => {
      // The comparison is only meaningful with a head to compare; an empty
      // operand must not read as a moved tip.
      const resolved = detect(
        '1',
        {
          EVENT_NAME: 'push',
          HEAD_BRANCH: 'main',
          HEAD_SHA: '',
        },
        { mainTip: 'new-head' },
      );
      expect(resolved.output).toBe('superseded=false\nprovisional=false\n');
      expect(resolved.calls).not.toContain('commits/main');
    });
    it('fails open when the live run cannot be read', () => {
      // Reporting on a transient read error is the safe direction: an issue
      // for a real failure beats silently dropping it.
      const gh = `#!/usr/bin/env bash\nprintf '%s' '{"message":"Bad credentials"}'\nexit 1\n`;
      const resolved = detect('', {}, { ghScript: gh });
      expect(resolved.output).toBe('superseded=false\nprovisional=false\n');
      expect(resolved.stdout).toContain('::warning::');
      expect(resolved.stdout).toContain('Could not read run 39237270547');
    });
    it('fails open when the event carries no run attempt', () => {
      // -gt coerces an empty operand to 0, so a field-less event would read
      // as superseded and suppress every report.
      expect(detect('2', { RUN_ATTEMPT: '' }).output).toBe(
        'superseded=false\nprovisional=false\n',
      );
    });
    it('gates every failure reader on the supersession check', () => {
      // Without this wiring the check would run and still file the issue; the
      // order matters too, because a gate reading an empty output is a no-op.
      const download = jobs.analyze.steps.find(
        (step) => step.name === 'Download failed job logs',
      );
      const infra = jobs.analyze.steps.find((step) => step.id === 'infra');
      for (const step of [destination, download, infra]) {
        expect(String(step.if), step.name).toBe(
          "${{ steps.live.outputs.superseded != 'true' }}",
        );
      }
      expect(jobs.analyze.steps.indexOf(live)).toBeLessThan(
        jobs.analyze.steps.indexOf(destination),
      );
    });
  });

  it('pins the watched name to the name key of sdk-java.yml', () => {
    // `workflow_run.workflows` matches the watched workflow's `name:` key, not
    // its filename — renaming sdk-java.yml's name must fail here instead of
    // silently stopping the SDK Java failure issues.
    const sdkJava = parse(
      readFileSync('.github/workflows/sdk-java.yml', 'utf8'),
    );
    expect(sdkJava.name).toBe('SDK Java');
    expect(yml.on.workflow_run.workflows).toContain(sdkJava.name);
  });

  it('uses the workflow name rather than the rendered Desktop run title', () => {
    const desktop = parse(
      readFileSync('.github/workflows/desktop-packaging-check.yml', 'utf8'),
    );
    expect(desktop['run-name']).toBeDefined();
    expect(jobs.analyze.if).toContain('github.event.workflow.name');
    expect(jobs.analyze.if).not.toContain('github.event.workflow_run.name');
    const writer = jobs.file_issue.steps.find((step) => step.id === 'issue');
    expect(writer.env.WORKFLOW_NAME).toBe('${{ github.event.workflow.name }}');
  });

  describe('workflow issue reuse', () => {
    const writer = jobs.file_issue.steps.find((step) => step.id === 'issue');
    const botIssue = (number, suffix = '') => ({
      number,
      title: `Main CI failed: SDK Java${suffix}`,
      author: { login: 'qwen-code-dev-bot' },
    });
    const run = (issues, opts = {}) => {
      const {
        lookupFailures = 0,
        failMarkerLookup = false,
        failClosedLookup = false,
        failEdit = false,
        failBodyRead = false,
        failBodyReadFor = '',
        failCommentOnce = false,
        failReopenOnce = false,
        failCreateOnce = false,
        issueBody = '<!-- main-ci-failure-aggregate:1234 -->',
        issueBodies = {},
        signatureTitle = '',
        testMarkers = '',
        runAt = '2026-10-24T01:02:03Z',
        markerIssues = [],
        closedIssues = [],
        provisional = false,
      } = opts;
      const tmp = mkdtempSync(join(tmpdir(), 'ci-issue-reuse-'));
      try {
        writeFileSync(
          join(tmp, 'issues.json'),
          typeof issues === 'string' ? issues : JSON.stringify(issues),
        );
        writeFileSync(join(tmp, 'closed.json'), JSON.stringify(closedIssues));
        writeFileSync(join(tmp, 'current-body.md'), issueBody + '\n');
        for (const [number, body] of Object.entries(issueBodies)) {
          writeFileSync(join(tmp, `body-${number}.md`), `${body}\n`);
        }
        writeFileSync(
          join(tmp, 'marker-issues.json'),
          typeof markerIssues === 'string'
            ? markerIssues
            : JSON.stringify(markerIssues),
        );
        writeFileSync(join(tmp, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
        chmodSync(join(tmp, 'sleep'), 0o755);
        writeFileSync(
          join(tmp, 'gh'),
          `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "${tmp}/calls"
if [[ "$1 $2" == 'issue list' ]]; then
  [[ "$*" == *'--json number,title,author'* && "$*" != *'--search'* ]] || exit 2
  if [[ "$*" == *'--state open'* ]]; then
    [[ "$*" == *'--limit 3000'* ]] || exit 2
    count=0
    [[ ! -f '${tmp}/lookup-count' ]] || read -r count < '${tmp}/lookup-count'
    count=$((count + 1))
    echo "$count" > '${tmp}/lookup-count'
    [[ "$count" -gt "$LOOKUP_FAILURES" ]] || exit 1
    cat '${tmp}/issues.json'
  elif [[ "$*" == *'--state closed'* ]]; then
    [[ "$*" == *'--limit 1000'* ]] || exit 2
    ${failClosedLookup ? 'exit 1' : `cat '${tmp}/closed.json'`}
  else
    exit 2
  fi
elif [[ "$1" == api ]]; then
  [[ "$*" == *'state=open&per_page=100'* && "$*" == *'--paginate'* ]] || exit 2
  ${failMarkerLookup ? 'exit 1' : `cat '${tmp}/marker-issues.json'`}
elif [[ "$1 $2" == 'issue reopen' ]]; then
  c=0
  [[ ! -f "${tmp}/reopen-count" ]] || read -r c < "${tmp}/reopen-count"
  c=$((c + 1))
  printf '%s\\n' "$c" > "${tmp}/reopen-count"
  [[ "\${FAIL_REOPEN_ONCE:-0}" != '1' || "$c" -gt 1 ]] || exit 1
elif [[ "$1 $2" == 'issue create' ]]; then
  c=0
  [[ ! -f "${tmp}/create-count" ]] || read -r c < "${tmp}/create-count"
  c=$((c + 1))
  printf '%s\\n' "$c" > "${tmp}/create-count"
  [[ "\${FAIL_CREATE_ONCE:-0}" != '1' || "$c" -gt 1 ]] || exit 1
  # Label churn must not prevent creation of the failure record.
  [[ "$*" != *'--label'* ]] || exit 1
  echo 'https://github.com/QwenLM/qwen-code/issues/999'
elif [[ "$1 $2" == 'issue view' ]]; then
  [[ "$*" == *'--json body'* ]] || exit 2
  ${failBodyRead ? 'exit 1' : ':'}
  ${failBodyReadFor ? `[[ "$3" != "${failBodyReadFor}" ]] || exit 1` : ':'}
  if [[ -f "${tmp}/body-$3.md" ]]; then cat "${tmp}/body-$3.md"; else cat '${tmp}/current-body.md'; fi
elif [[ "$1 $2" == 'issue comment' ]]; then
  c=0
  [[ ! -f "${tmp}/comment-count" ]] || read -r c < "${tmp}/comment-count"
  c=$((c + 1))
  printf '%s\\n' "$c" > "${tmp}/comment-count"
  [[ "\${FAIL_COMMENT_ONCE:-0}" != '1' || "$c" -gt 1 ]] || exit 1
elif [[ "$1 $2" == 'issue edit' ]]; then
  ${failEdit ? 'exit 1' : ':'}
  if [[ "$*" == *'--body-file'* ]]; then
    cp "\${@: -1}" '${tmp}/migrated-body.md'
  fi
fi
`,
        );
        chmodSync(join(tmp, 'gh'), 0o755);
        const result = spawnSync(
          'bash',
          ['-eo', 'pipefail', '-c', writer.run],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${tmp}:${process.env.PATH}`,
              RUNNER_TEMP: tmp,
              GITHUB_OUTPUT: join(tmp, 'output'),
              REPO: 'QwenLM/qwen-code',
              WORKFLOW_NAME: 'SDK Java',
              WORKFLOW_ID: '1234',
              BOT_LOGIN: 'qwen-code-dev-bot',
              ISSUE_BODY: 'Run 123 failed at commit abcdef123456',
              RUN_ATTEMPT: '2',
              SIGNATURE_TITLE: signatureTitle,
              TEST_MARKERS: testMarkers,
              PROVISIONAL: provisional ? 'true' : 'false',
              RUN_AT: runAt,
              LOOKUP_FAILURES: String(lookupFailures),
              FAIL_COMMENT_ONCE: failCommentOnce ? '1' : '0',
              FAIL_REOPEN_ONCE: failReopenOnce ? '1' : '0',
              FAIL_CREATE_ONCE: failCreateOnce ? '1' : '0',
            },
          },
        );
        return {
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          migratedBody: existsSync(join(tmp, 'migrated-body.md'))
            ? readFileSync(join(tmp, 'migrated-body.md'), 'utf8')
            : null,
          calls: existsSync(join(tmp, 'calls'))
            ? readFileSync(join(tmp, 'calls'), 'utf8')
            : '',
          output: existsSync(join(tmp, 'output'))
            ? readFileSync(join(tmp, 'output'), 'utf8')
            : '',
          body: existsSync(join(tmp, 'issue-body.md'))
            ? readFileSync(join(tmp, 'issue-body.md'), 'utf8')
            : '',
          commentBody: existsSync(join(tmp, 'issue-comment.md'))
            ? readFileSync(join(tmp, 'issue-comment.md'), 'utf8')
            : '',
        };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };

    it.each(['', ' on abcdef123456', ' — Foo.test'])(
      'comments on an open workflow issue with suffix %s',
      (suffix) => {
        const result = run([botIssue(42, suffix)]);
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue comment 42');
        expect(result.output).toContain(
          'issue_url=https://github.com/QwenLM/qwen-code/issues/42',
        );
        expect(result.calls).not.toContain('issue create');
        // The dated retitle keeps the shared issue fresh in the issue list,
        // whatever shape its machine title had; the body already carries the
        // workflow marker, so a legacy-shaped title is not re-adopted.
        expect(result.calls).toContain(
          'issue edit 42 --repo QwenLM/qwen-code --title Main CI failed: SDK Java — no test identified (latest: 2026-10-24)',
        );
        expect(result.calls).not.toContain('--remove-label');
        expect(result.calls).not.toMatch(
          /--add-label|--add-assignee|--remove-assignee|autofix\/in-progress/,
        );
        expect(result.body).toContain('Run 123 failed at commit abcdef123456');
        expect(result.body).toContain('Run attempt: 2');
      },
    );

    it('heads a provisional aggregate occurrence with the caveat', () => {
      // The caveat is prepended once, ahead of the route split, so the
      // aggregate's own body file is a third write site: a prepend narrowed to
      // the per-signature branch would silently drop it here.
      const result = run([botIssue(42)], { provisional: true });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('issue comment 42');
      expect(result.body).toMatch(
        /^> \*\*Provisional\.\*\* Main advanced past this head/,
      );
      expect(result.body).toContain('Run 123 failed at commit abcdef123456');
    });

    it('retires the autofix route when adopting a legacy issue without the workflow marker', () => {
      const result = run([botIssue(42, ' on abc123')], {
        issueBody:
          'Main CI failed at commit abc123.\n\n<!-- qwen-main-ci-failure:abc123 -->',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('issue comment 42');
      expect(result.calls).toContain(
        'issue edit 42 --repo QwenLM/qwen-code --remove-label status/ready-for-agent --remove-label autofix/approved',
      );
      expect(result.calls).toContain(
        'issue edit 42 --repo QwenLM/qwen-code --title Main CI failed: SDK Java — no test identified (latest: 2026-10-24)',
      );
    });

    it('never adopts a per-signature issue as the workflow aggregate', () => {
      // With no exact-titled aggregate in the family, only the body check
      // keeps the no-test occurrence off the per-signature issue — the hijack
      // from the review round, where adoption rewrote the per-signature title
      // into the generic dated one.
      const result = run([botIssue(7, ' — Foo.test')], {
        issueBodies: {
          7: 'Tracked failure.\n\n<!-- qwen-main-ci-failure-test:aaa111bbb222 -->\n',
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('issue create');
      expect(result.calls).not.toContain('issue comment 7');
      expect(result.calls).not.toContain('issue edit 7');
    });

    it('reopens the closed aggregate instead of hijacking the only open per-signature issue', () => {
      const result = run([botIssue(7, ' — Foo.test')], {
        issueBodies: {
          7: '<!-- qwen-main-ci-failure-test:aaa111bbb222 -->\n',
        },
        closedIssues: [
          { ...botIssue(42), body: '<!-- main-ci-failure-aggregate:1234 -->' },
        ],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('issue reopen 42');
      expect(result.calls).toContain('issue comment 42');
      expect(result.calls).not.toContain('issue comment 7');
      expect(result.calls).not.toContain('issue edit 7');
    });

    it('still selects a migrated aggregate whose body carries both marker classes', () => {
      const both =
        '<!-- qwen-main-ci-failure-test:aaa111bbb222 -->\n<!-- main-ci-failure-aggregate:1234 -->\n';
      const result = run([botIssue(42, ' — Foo.test')], {
        issueBodies: { 42: both },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('issue comment 42');
      expect(result.calls).toContain(
        'issue edit 42 --repo QwenLM/qwen-code --title Main CI failed: SDK Java — no test identified (latest: 2026-10-24)',
      );
      expect(result.calls).not.toContain('--remove-label');
    });

    it('never reopens a resolved per-signature issue as the aggregate', () => {
      const result = run([], {
        closedIssues: [
          {
            ...botIssue(7, ' — Foo.test'),
            body: '<!-- qwen-main-ci-failure-test:aaa111bbb222 -->',
          },
        ],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).not.toContain('issue reopen 7');
      expect(result.calls).toContain('issue create');
    });

    it('reopens a closed aggregate sitting in a mixed closed population', () => {
      // The one population the body filter can flip: a closed per-signature
      // issue beside the closed aggregate. A jq that errs instead of
      // filtering produces no match at all and the writer files a duplicate
      // aggregate — silently, because the fallback swallows it.
      const result = run([], {
        closedIssues: [
          {
            ...botIssue(7, ' — Foo.test'),
            body: '<!-- qwen-main-ci-failure-test:aaa111bbb222 -->',
          },
          { ...botIssue(42), body: '<!-- main-ci-failure-aggregate:1234 -->' },
        ],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('issue reopen 42');
      expect(result.calls).toContain('issue comment 42');
      expect(result.calls).not.toContain('issue create');
      expect(result.calls).not.toContain('issue reopen 7');
    });

    it('reopens a closed aggregate whose body carries both marker classes', () => {
      // An adopted-and-migrated aggregate keeps its old per-test markers
      // beside the workflow marker; the workflow marker is what keeps it
      // reopenable, so a resolved aggregate is never replaced by a fresh one.
      const both =
        '<!-- qwen-main-ci-failure-test:aaa111bbb222 -->\n<!-- main-ci-failure-aggregate:1234 -->';
      const result = run([], {
        closedIssues: [{ ...botIssue(42, ' — Foo.test'), body: both }],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('issue reopen 42');
      expect(result.calls).toContain('issue comment 42');
      expect(result.calls).not.toContain('issue create');
    });

    it('refuses to write when the open-issue listing cannot be parsed', () => {
      // jq exiting non-zero must not read as an empty family: the signature
      // route would certify a false miss and file a duplicate issue.
      const result = run('this is not json{', {
        signatureTitle: 'Main CI failed: SDK Java — src/Foo.test > case',
        testMarkers: 'qwen-main-ci-failure-test:aaa111bbb222',
      });
      expect(result.status).not.toBe(0);
      expect(result.calls).not.toMatch(/issue (comment|create)/);
    });

    it('leaves labels alone when the body of a reopened legacy issue cannot be read', () => {
      const result = run([], {
        failBodyRead: true,
        closedIssues: [
          { ...botIssue(42, ' on abc123'), body: 'no markers here' },
        ],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('issue reopen 42');
      expect(result.calls).toContain('issue comment 42');
      expect(result.calls).not.toContain('--remove-label');
      expect(result.stdout).toContain('::warning::');
    });

    it('leaves adoption to the body-marker fallback when a candidate cannot be read', () => {
      // A transient read failure on the true aggregate must not hand the
      // occurrence to the next admissible filing — per-commit bodies pass the
      // marker screen, so skipping ahead can mint a zombie aggregate.
      const result = run(
        [botIssue(7, ' — Old.test'), botIssue(9, ' on abc123456789')],
        {
          failBodyReadFor: '7',
          issueBodies: { 9: 'per-commit body with no marker classes' },
          markerIssues: [
            {
              number: 42,
              title: 'Anything human-shaped',
              user: { login: 'qwen-code-dev-bot' },
              body: '<!-- main-ci-failure-aggregate:1234 -->',
            },
          ],
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('issue comment 42');
      expect(result.calls).not.toContain('issue comment 9');
      expect(result.calls).not.toMatch(/issue (edit|reopen) 9/);
      expect(result.stdout).toContain(
        'leaving adoption to the marker fallback',
      );
    });

    it('creates a fixed-title triage issue when only other workflow issues exist', () => {
      const result = run([
        botIssue(10, ' extra'),
        { ...botIssue(11), title: 'Main CI failed: SDK Python on abc123' },
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain(
        'issue create --repo QwenLM/qwen-code --title Main CI failed: SDK Java --body-file',
      );
      expect(result.calls).toContain(
        'issue edit 999 --repo QwenLM/qwen-code --add-label scope/ci-cd --add-label status/needs-triage',
      );
      expect(result.output).toContain(
        'issue_url=https://github.com/QwenLM/qwen-code/issues/999',
      );
      expect(result.body).toContain('<!-- main-ci-failure-aggregate:1234 -->');
      expect(result.calls).not.toMatch(
        /autofix|ready-for-agent|assignee|issue comment/,
      );
    });

    it('does not adopt a matching title owned by someone other than the reporting bot', () => {
      const result = run([
        { ...botIssue(7), author: { login: 'not-the-bot' } },
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('issue create');
      expect(result.calls).not.toContain('issue comment 7');
    });

    it('adopts a retitled bot aggregate by marker and excludes other authors and PRs', () => {
      const marked = {
        number: 42,
        title: 'Investigating Java CI',
        user: { login: 'qwen-code-dev-bot' },
        body: '<!-- main-ci-failure-aggregate:1234 -->',
      };
      const result = run([], {
        markerIssues: [
          { ...marked, number: 1, user: { login: 'someone-else' } },
          { ...marked, number: 2, pull_request: {} },
          { ...marked, number: 3, body: null },
          marked,
        ],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('issue comment 42');
      expect(result.calls).not.toMatch(/issue (create|edit|reopen)/);
    });

    it('migrates an adopted legacy body and reuses it after a maintainer retitles the issue', () => {
      const originalBody =
        'Main CI failed at commit abc123.\n\n<!-- qwen-main-ci-failure:abc123 -->\n\nMaintainer notes: investigate the runner lock.';
      const adopted = run([botIssue(42, ' on abc123')], {
        issueBody: originalBody,
      });
      expect(adopted.status).toBe(0);
      expect(adopted.migratedBody).toBe(
        `${originalBody}\n\n<!-- main-ci-failure-aggregate:1234 -->\n`,
      );
      // The record is pinned as comment-before-edits rather than
      // comment-before-reads because adoption must read the body to route.
      expect(adopted.calls.indexOf('issue comment 42')).toBeLessThan(
        adopted.calls.indexOf('issue edit 42'),
      );
      expect(adopted.calls).toMatch(/issue edit 42 .*--body-file/);

      const retitled = run([], {
        issueBody: adopted.migratedBody,
        markerIssues: [
          {
            number: 42,
            title: 'Investigating Java runner locks',
            user: { login: 'qwen-code-dev-bot' },
            body: adopted.migratedBody,
          },
        ],
      });
      expect(retitled.status).toBe(0);
      expect(retitled.calls).toContain('issue comment 42');
      expect(retitled.calls).not.toMatch(/issue (create|edit)/);
      expect(retitled.migratedBody).toBeNull();
    });

    it.each([
      [
        'read',
        {
          failBodyRead: true,
          markerIssues: [
            {
              number: 42,
              title: 'Main CI failed: SDK Java',
              user: { login: 'qwen-code-dev-bot' },
              body: '<!-- main-ci-failure-aggregate:1234 -->',
            },
          ],
        },
      ],
      ['edit', { failEdit: true, markerIssues: [] }],
    ])(
      'keeps the recorded occurrence when marker migration fails on %s: %j',
      (_kind, failure) => {
        // The per-issue view and the migration edit are both decoration-side
        // reads/writes after the record; the marker fallback's listing scan
        // rescues an unreadable aggregate, and a failed migration edit is
        // only warned about.
        const result = run([botIssue(42)], {
          issueBody: 'Original unmarked body',
          ...failure,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue comment 42');
        expect(result.output).toContain(
          'issue_url=https://github.com/QwenLM/qwen-code/issues/42',
        );
        expect(result.stdout).toContain('::warning::');
      },
    );

    it('prefers an exact-titled aggregate over an older legacy candidate', () => {
      // Machine-titled candidates sort first, so the standing aggregate wins
      // over an older legacy candidate that could otherwise absorb the
      // occurrence while unreadable or unmarked.
      const result = run([botIssue(50), botIssue(42, ' on abc123')]);
      expect(result.calls).toContain('issue comment 50');
      expect(result.output).toContain(
        'issue_url=https://github.com/QwenLM/qwen-code/issues/50',
      );
    });

    it('does not adopt a per-signature issue retitled to the exact machine title', () => {
      // Machine shapes are exempt from nothing: a human can retitle a
      // per-signature issue to the exact title, so every adoption candidate
      // passes the same body screen regardless of title.
      const result = run([botIssue(9)], {
        issueBodies: { 9: '<!-- qwen-main-ci-failure-test:aaa111bbb222 -->\n' },
        closedIssues: [
          { ...botIssue(42), body: '<!-- main-ci-failure-aggregate:1234 -->' },
        ],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('issue reopen 42');
      expect(result.calls).toContain('issue comment 42');
      expect(result.calls).not.toContain('issue comment 9');
      expect(result.calls).not.toContain('issue edit 9');
    });

    it('retries a transient light lookup failure and still records the failure', () => {
      const result = run([botIssue(42)], { lookupFailures: 1 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls.match(/issue list .*--state open/g)).toHaveLength(2);
      expect(result.calls).toContain('issue comment 42');
    });

    it('retries a transient failure of the record write itself', () => {
      // Every lookup retries 3x; the comment carrying the occurrence gets the
      // same tolerance, or a transient 5xx permanently loses the record.
      const result = run([botIssue(42)], { failCommentOnce: true });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls.match(/issue comment 42/g)).toHaveLength(2);
      expect(result.output).toContain(
        'issue_url=https://github.com/QwenLM/qwen-code/issues/42',
      );
    });

    it('retries a transient reopen failure on the regression path', () => {
      const tracked = `<!-- qwen-main-ci-failure-test:aaa111bbb222 -->\n<!-- main-ci-failure-scope:1234 -->\n`;
      const result = run([], {
        signatureTitle: 'Main CI failed: SDK Java — src/Foo.test > case',
        testMarkers: 'qwen-main-ci-failure-test:aaa111bbb222',
        failReopenOnce: true,
        issueBodies: { 7: tracked },
        closedIssues: [{ ...botIssue(7, ' — Foo.test'), body: tracked }],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls.match(/issue reopen 7/g)).toHaveLength(2);
      expect(result.calls).toContain('issue comment 7');
    });

    it('retries a transient create failure for a fresh aggregate', () => {
      const result = run([], { failCreateOnce: true });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls.match(/issue create/g)).toHaveLength(2);
      expect(result.output).toContain(
        'issue_url=https://github.com/QwenLM/qwen-code/issues/999',
      );
    });

    it.each([{ lookupFailures: 3 }, { failMarkerLookup: true }])(
      'does not write when an open lookup fails after retries: %j',
      (opts) => {
        const result = run([], opts);
        expect(result.status).not.toBe(0);
        expect(result.calls).not.toMatch(/issue (create|comment|reopen|edit)/);
        expect(result.calls).not.toContain('--state closed');
      },
    );

    it('publishes the issue url and recurrence comment before a failed legacy label retirement', () => {
      const result = run([botIssue(42, ' on abc123')], {
        failEdit: true,
        issueBody: 'An adopted legacy body without the workflow marker',
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(
        'issue_url=https://github.com/QwenLM/qwen-code/issues/42',
      );
      expect(result.calls.indexOf('issue comment 42')).toBeLessThan(
        result.calls.indexOf('issue edit 42'),
      );
    });

    it('keeps a newly created failure record when adding triage labels fails', () => {
      const result = run([], { failEdit: true });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toContain(
        'issue_url=https://github.com/QwenLM/qwen-code/issues/999',
      );
      expect(result.calls).toContain('issue create');
      expect(result.calls).toContain('issue edit 999');
    });

    it('merges every marker lookup page before choosing the oldest match', () => {
      const marked = {
        user: { login: 'qwen-code-dev-bot' },
        body: '<!-- main-ci-failure-aggregate:1234 -->',
      };
      const result = run([], {
        markerIssues:
          JSON.stringify([{ ...marked, number: 50 }]) +
          JSON.stringify([{ ...marked, number: 42 }]),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('issue comment 42');
      expect(result.calls).not.toContain('issue create');
    });

    it.each(['', ' — Foo.test'])(
      'reopens a closed bot issue before commenting, with suffix %s',
      (suffix) => {
        const result = run([], {
          issueBody: 'A closed legacy body without the workflow marker',
          closedIssues: [
            { ...botIssue(7), author: { login: 'not-the-bot' } },
            botIssue(42, suffix),
          ],
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue reopen 42');
        expect(result.calls).toContain('issue comment 42');
        expect(result.calls.indexOf('issue reopen 42')).toBeLessThan(
          result.calls.indexOf('issue comment 42'),
        );
        expect(result.calls).not.toContain('issue create');
        expect(result.calls.includes('--remove-label')).toBe(Boolean(suffix));
      },
    );

    it('creates a fresh aggregate when the bounded closed lookup fails', () => {
      const result = run([], { failClosedLookup: true });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('--state closed');
      expect(result.calls).toContain('issue create');
      expect(result.calls).not.toContain('issue reopen');
    });

    it('serializes lookup and write per workflow and reuses the failure renderer', () => {
      expect(jobs.file_issue.concurrency).toEqual({
        group: 'main-ci-failure-issue-${{ github.event.workflow.id }}',
        'cancel-in-progress': false,
        queue: 'max',
      });
      expect(writer.env.ISSUE_BODY).toBe(
        '${{ needs.analyze.outputs.comment_body }}',
      );
      expect(writer.env.WORKFLOW_ID).toBe('${{ github.event.workflow.id }}');
      expect(writer.env.BOT_LOGIN).toBe(
        "${{ vars.AUTOFIX_BOT_LOGIN || 'qwen-code-dev-bot' }}",
      );
      expect(jobs.analyze.outputs.comment_body).toBe(
        '${{ steps.summary.outputs.body }}',
      );
      expect(workflow).not.toContain('apply_autofix_route');
    });

    it('wires the signature route from the analysis through to the writer', () => {
      // The writer branches on SIGNATURE_TITLE, so a rename or a retyped
      // binding anywhere in the chain silently downgrades every run to the
      // aggregate. Pin every hop.
      expect(jobs.analyze.outputs.signature_title).toBe(
        '${{ steps.summary.outputs.signature_title }}',
      );
      expect(jobs.analyze.outputs.test_markers).toBe(
        '${{ steps.summary.outputs.test_markers }}',
      );
      expect(writer.env.SIGNATURE_TITLE).toBe(
        '${{ needs.analyze.outputs.signature_title }}',
      );
      expect(writer.env.TEST_MARKERS).toBe(
        '${{ needs.analyze.outputs.test_markers }}',
      );
      expect(writer.env.RUN_AT).toBe(
        '${{ github.event.workflow_run.updated_at }}',
      );
      const summary = oneLine(
        jobs.analyze.steps.find((step) => step.id === 'summary').run,
      );
      // Both values come from the same analysis the comment was rendered
      // from; a separate extraction could disagree with the reported tests.
      expect(summary).toContain(
        'echo "signature_title=$(jq -r \'.title // ""\' "${RUNNER_TEMP}/analysis.json")"',
      );
      expect(summary).toContain(
        'jq -r \'.searchMarkers[]?\' "${RUNNER_TEMP}/analysis.json"',
      );
    });

    it('wires the provisional flag from the live step through to the writer', () => {
      // Same chain shape, same failure mode: a retyped binding leaves
      // PROVISIONAL empty, so every provisional filing silently loses its
      // caveat; a dropped one is unbound and kills the writer outright.
      expect(jobs.analyze.outputs.provisional).toBe(
        '${{ steps.live.outputs.provisional }}',
      );
      expect(writer.env.PROVISIONAL).toBe(
        '${{ needs.analyze.outputs.provisional }}',
      );
    });
    describe('per-signature routing', () => {
      const signatureTitle =
        'Main CI failed: SDK Java — src/Foo.test > Suite … > case bar';
      const markerA = 'qwen-main-ci-failure-test:aaa111bbb222';
      const markerB = 'qwen-main-ci-failure-test:ccc333ddd444';

      it('files a new triaged issue when no open issue carries the test marker', () => {
        // The aggregate exists and is consulted first; its body carries only the
        // workflow marker, so a named regression never collapses into it.
        const result = run([botIssue(42)], {
          signatureTitle,
          testMarkers: `${markerA}\n${markerB}`,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain(
          `issue create --repo QwenLM/qwen-code --title ${signatureTitle} --body-file`,
        );
        expect(result.calls).not.toContain('issue comment');
        expect(result.calls).toContain(
          'issue edit 999 --repo QwenLM/qwen-code --add-label type/bug --add-label status/needs-triage',
        );
        expect(result.output).toContain(
          'issue_url=https://github.com/QwenLM/qwen-code/issues/999',
        );
        expect(result.body).toContain('Run 123 failed at commit abcdef123456');
        expect(result.body).toContain(`<!-- ${markerA} -->`);
        expect(result.body).toContain(`<!-- ${markerB} -->`);
        // The workflow scope rides in every filing: test markers alone carry
        // no workflow component, and the retitled body scan keys on it.
        expect(result.body).toContain('<!-- main-ci-failure-scope:1234 -->');
        expect(result.body).not.toContain('main-ci-failure-aggregate');
        expect(result.calls).not.toMatch(/ready-for-agent|autofix|assignee/);
      });

      it('leads a provisional filing with the caveat and still files it', () => {
        // The successor had not settled when the report was prepared, so the
        // issue is filed anyway; the caveat is what lets a reader close it
        // when the newer run turns out to cover the failure.
        const result = run([botIssue(42)], {
          signatureTitle,
          testMarkers: markerA,
          provisional: true,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.body).toMatch(
          /^> \*\*Provisional\.\*\* Main advanced past this head/,
        );
        expect(result.body).toContain('Run 123 failed at commit abcdef123456');
        expect(result.body).toContain(`<!-- ${markerA} -->`);
        // A provisional issue is still a human-triage unit, never autofix
        // work — the whole reason reporting it is affordable.
        expect(result.calls).toContain(
          'issue edit 999 --repo QwenLM/qwen-code --add-label type/bug --add-label status/needs-triage',
        );
        expect(result.calls).not.toMatch(/ready-for-agent|autofix|assignee/);
      });

      it('omits the caveat when the tip was settled', () => {
        const result = run([botIssue(42)], {
          signatureTitle,
          testMarkers: markerA,
        });
        expect(result.body).not.toContain('Provisional.');
      });

      it('comments on the issue whose body carries the test marker and accretes new ones', () => {
        const tracked =
          'Earlier report.\n\n<!-- qwen-main-ci-failure-test:aaa111bbb222 -->\n';
        const result = run([botIssue(7, ' — Foo.test'), botIssue(42)], {
          signatureTitle,
          testMarkers: `${markerA}\n${markerB}`,
          issueBodies: { 7: tracked },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue comment 7');
        expect(result.calls).not.toContain('issue create');
        expect(result.output).toContain(
          'issue_url=https://github.com/QwenLM/qwen-code/issues/7',
        );
        // The recurrence is recorded before the marker accretion edit, and a
        // per-signature match never retires the issue's labels.
        expect(result.calls.indexOf('issue comment 7')).toBeLessThan(
          result.calls.indexOf('issue edit 7'),
        );
        expect(result.calls).not.toContain('--remove-label');
        expect(result.calls).not.toContain('--title');
        expect(result.migratedBody).toContain(`<!-- ${markerA} -->`);
        expect(result.migratedBody).toContain(`<!-- ${markerB} -->`);
        // Accretion also back-fills the workflow scope, so a human retitle
        // later still finds the issue through the scoped body scan.
        expect(result.migratedBody).toContain(
          '<!-- main-ci-failure-scope:1234 -->',
        );
        expect(result.commentBody).toContain(
          'Run 123 failed at commit abcdef123456',
        );
        expect(result.commentBody).toContain('Run attempt: 2');
      });

      it('does not edit the body when every marker is already recorded', () => {
        const tracked = `<!-- ${markerA} -->\n<!-- ${markerB} -->\n<!-- main-ci-failure-scope:1234 -->\n`;
        const result = run([botIssue(7, ' — Foo.test')], {
          signatureTitle,
          testMarkers: `${markerA}\n${markerB}`,
          issueBodies: { 7: tracked },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue comment 7');
        expect(result.calls).not.toContain('issue edit');
      });

      it('heads a provisional recurrence comment with the caveat', () => {
        // A recurrence is written from a separate file than the certified-miss
        // create, so it is its own write site: scoping the prepend to the
        // filing paths would leave a provisional recurrence unmarked.
        const tracked = `<!-- ${markerA} -->\n<!-- main-ci-failure-scope:1234 -->\n`;
        const result = run([botIssue(7, ' — Foo.test')], {
          signatureTitle,
          testMarkers: markerA,
          issueBodies: { 7: tracked },
          provisional: true,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue comment 7');
        expect(result.commentBody).toMatch(
          /^> \*\*Provisional\.\*\* Main advanced past this head/,
        );
        expect(result.commentBody).toContain(
          'Run 123 failed at commit abcdef123456',
        );
      });

      it('keeps the recorded recurrence when the accretion edit fails', () => {
        const result = run([botIssue(7, ' — Foo.test')], {
          signatureTitle,
          testMarkers: `${markerA}\n${markerB}`,
          // The known marker matches; the joined one is what accretion drops.
          issueBodies: { 7: `<!-- ${markerA} -->\n` },
          failEdit: true,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue comment 7');
        expect(result.output).toContain(
          'issue_url=https://github.com/QwenLM/qwen-code/issues/7',
        );
        expect(result.stdout).toContain('::warning::');
      });

      it('falls back to the workflow aggregate when a candidate body cannot be read', () => {
        // A miss cannot be certified against an unreadable body, so the run is
        // recorded on the aggregate the way an unidentified failure is — losing
        // precision, never the record. The aggregate itself is located by the
        // marker fallback's listing scan even when its own view also fails.
        const result = run([botIssue(42)], {
          signatureTitle,
          testMarkers: markerA,
          failBodyRead: true,
          markerIssues: [
            {
              number: 42,
              title: 'Main CI failed: SDK Java',
              user: { login: 'qwen-code-dev-bot' },
              body: '<!-- main-ci-failure-aggregate:1234 -->',
            },
          ],
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          'Falling back to the workflow aggregate',
        );
        expect(result.calls).toContain('issue comment 42');
        expect(result.calls).not.toContain('issue create');
      });

      it('never scans issues owned by someone other than the reporting bot', () => {
        const result = run(
          [{ ...botIssue(7), author: { login: 'not-the-bot' } }],
          {
            signatureTitle,
            testMarkers: markerA,
            issueBodies: { 7: `<!-- ${markerA} -->\n` },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue create');
        expect(result.calls).not.toContain('issue comment 7');
      });

      it('finds a human-retitled per-signature issue by the test markers in its body', () => {
        // The retitle drops the issue out of the title family, so the miss is
        // certified only after the open bot issues' bodies are scanned — the
        // same fallback the aggregate route has always had.
        const retitled = {
          number: 9,
          title: 'Investigating the peer-messaging flake',
          user: { login: 'qwen-code-dev-bot' },
          body: `<!-- ${markerA} -->\n<!-- ${markerB} -->\n<!-- main-ci-failure-scope:1234 -->\n`,
        };
        const result = run(
          [
            {
              number: 9,
              title: 'Investigating the peer-messaging flake',
              author: { login: 'qwen-code-dev-bot' },
            },
          ],
          {
            signatureTitle,
            testMarkers: `${markerA}\n${markerB}`,
            markerIssues: [retitled],
            // The accretion re-read sees the same live body the listing had.
            issueBodies: { 9: retitled.body },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue comment 9');
        expect(result.calls).not.toContain('issue create');
        expect(result.calls).not.toContain('issue edit');
        expect(result.output).toContain(
          'issue_url=https://github.com/QwenLM/qwen-code/issues/9',
        );
      });

      it('falls back to the aggregate when the retitled-issue scan fails', () => {
        const result = run([botIssue(42)], {
          signatureTitle,
          testMarkers: markerA,
          failMarkerLookup: true,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          'Falling back to the workflow aggregate',
        );
        expect(result.calls).toContain('issue comment 42');
        expect(result.calls).not.toContain('issue create');
      });

      it('never adopts a marker match filed under another workflow', () => {
        // Test markers carry no workflow component: the same test id failing
        // in two watched workflows must not converge onto one issue — the
        // writer's concurrency group serializes only within this workflow.
        const foreign = {
          number: 9,
          title: 'Investigating the same test elsewhere',
          user: { login: 'qwen-code-dev-bot' },
          body: `<!-- ${markerA} -->\n<!-- main-ci-failure-scope:9999 -->\n`,
        };
        const result = run([], {
          signatureTitle,
          testMarkers: markerA,
          markerIssues: [foreign],
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue create');
        expect(result.calls).not.toContain('issue comment 9');
      });

      it('reopens a resolved per-signature issue when its test fails again', () => {
        // Regression reopens the tracker instead of filing beside it — the
        // same lifecycle the aggregate route has always had.
        const tracked = `<!-- ${markerA} -->\n`;
        const result = run([], {
          signatureTitle,
          testMarkers: `${markerA}\n${markerB}`,
          issueBodies: { 7: tracked },
          closedIssues: [{ ...botIssue(7, ' — Foo.test'), body: tracked }],
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls.indexOf('issue reopen 7')).toBeLessThan(
          result.calls.indexOf('issue comment 7'),
        );
        expect(result.calls).not.toContain('issue create');
        expect(result.migratedBody).toContain(`<!-- ${markerB} -->`);
        expect(result.migratedBody).toContain(
          '<!-- main-ci-failure-scope:1234 -->',
        );
        expect(result.output).toContain(
          'issue_url=https://github.com/QwenLM/qwen-code/issues/7',
        );
      });

      it('reopens nothing when a closed issue carries a different workflow scope', () => {
        const tracked = `<!-- ${markerA} -->\n<!-- main-ci-failure-scope:9999 -->\n`;
        const result = run([], {
          signatureTitle,
          testMarkers: markerA,
          closedIssues: [
            {
              number: 7,
              title: 'retitled away',
              author: { login: 'qwen-code-dev-bot' },
              body: tracked,
            },
          ],
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).not.toContain('issue reopen 7');
        expect(result.calls).toContain('issue create');
      });

      it('falls back to the aggregate when the closed-issue scan fails', () => {
        const result = run([botIssue(42)], {
          signatureTitle,
          testMarkers: markerA,
          failClosedLookup: true,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue comment 42');
        expect(result.calls).not.toContain('issue create');
      });

      it('does not accrete a marker another family tracker already owns', () => {
        // #20 tracks A, #21 tracks C; a run failing {A, C} comments on #20
        // (oldest hit), but pulling C's marker into #20 would shadow #21:
        // every later C-only run would land on the wrong-numbered issue.
        const owned = (marker) =>
          `<!-- ${marker} -->\n<!-- main-ci-failure-scope:1234 -->\n`;
        const result = run(
          [botIssue(20, ' — A.test'), botIssue(21, ' — C.test')],
          {
            signatureTitle,
            testMarkers: `${markerA}\n${markerB}`,
            issueBodies: { 20: owned(markerA), 21: owned(markerB) },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue comment 20');
        expect(result.calls).not.toContain('issue edit');
      });

      it('does not accrete a marker a human-retitled tracker already owns', () => {
        // The retitled owner is out of the title family, so ownership can
        // only be settled through the scoped-body scan the route already has.
        const retitled = {
          number: 9,
          title: 'Investigating the C flake',
          user: { login: 'qwen-code-dev-bot' },
          body: `<!-- ${markerB} -->\n<!-- main-ci-failure-scope:1234 -->\n`,
        };
        const result = run([botIssue(20, ' — A.test')], {
          signatureTitle,
          testMarkers: `${markerA}\n${markerB}`,
          issueBodies: {
            20: `<!-- ${markerA} -->\n<!-- main-ci-failure-scope:1234 -->\n`,
          },
          markerIssues: [retitled],
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue comment 20');
        expect(result.calls).not.toContain('issue edit');
      });

      it('suppresses accretion when a sibling tracker body cannot be read', () => {
        // A scan-time read failure leaves nothing reusable: without cleanup
        // the corpus would consult the truncated leftover file and silently
        // treat the unreadable sibling as owning no markers at all.
        const result = run(
          [botIssue(7, ' — C.test'), botIssue(20, ' — A.test')],
          {
            signatureTitle,
            testMarkers: `${markerA}\n${markerB}`,
            failBodyReadFor: '7',
            issueBodies: {
              20: `<!-- ${markerA} -->\n<!-- main-ci-failure-scope:1234 -->\n`,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toContain('issue comment 20');
        expect(result.calls).not.toContain('issue edit');
        expect(result.stdout).toContain(
          'Could not read every sibling tracker body',
        );
      });
    });
  });

  it('hands the helper the failed job and step of a run with no test result', () => {
    // A lane can die before printing test results. Its job/step details must
    // still reach the failure summary so the report remains diagnosable.
    //
    // Each pin below is scoped to the step that owns it and spans a producer
    // together with its consumer. Isolated substrings cannot express this
    // contract — one fetch feeding two jq projections feeding two consumers —
    // and every fragment of it stays green on its own when the wiring between
    // them is cut. Collapsing the line continuations first keeps the pins
    // reading like the shell they pin rather than like this file's indentation.
    const steps = jobs.analyze.steps;
    const downloadStep = steps.find(
      (step) => step.name === 'Download failed job logs',
    );
    const download = oneLine(downloadStep.run);
    const summary = oneLine(steps.find((step) => step.id === 'summary').run);

    // `gh api` writes a non-2xx body to stdout before exiting non-zero, so the
    // fetch has to stay non-fatal AND say so. `--paginate` rides the same span
    // because this one fetch feeds both projections, so dropping it caps a
    // wide run at page 1. The slurp merge rides it too: `--paginate` prints
    // one document per page while the comment helper reads the file with a
    // single JSON.parse, so a run wider than one page would silently render a
    // comment naming no job without it.
    // The merge alone is not enough: it merges whichever pages arrived, and
    // that partial list is what every consumer — the infra classifier included
    // — reads as the whole run. The receipt therefore gates the promotion:
    // `total_count` has to match the jobs merged before the staged file
    // replaces `run-jobs.json` — and a response carrying no `total_count` at
    // all cannot certify itself either, so `$total != null` is part of the
    // pass condition rather than a skip.
    expect(download).toContain(
      'gh api "repos/${REPO}/actions/runs/${WORKFLOW_RUN_ID}/attempts/${RUN_ATTEMPT}/jobs?per_page=100" --paginate | jq -s \'{jobs: [ .[].jobs[]? ]} as $doc | ([.[].total_count] | max) as $total | if $total != null and ($doc.jobs | length) == $total then $doc else error("incomplete job list: merged \\($doc.jobs | length) of \\($total)") end\' > "${jobs_tmp}"; then mv "${jobs_tmp}" "${jobs_json}"',
    );
    // A run whose pages cannot be read at all degrades the way a missing log
    // does: no stale staging file, an empty list, and a warning.
    expect(download).toContain(
      'else rm -f "${jobs_tmp}" printf \'{"jobs":[]}\\n\' > "${jobs_json}" echo "::warning::Could not read the whole job list of run ${WORKFLOW_RUN_ID}; reporting without it" fi',
    );
    // Producer and consumer are separate spellings: a renamed step id or a
    // retyped binding resolves the expression to '', which the summary reads
    // as "the list was short".
    const jobsCompleteRef = '${{ steps.download.outputs.jobs_complete }}';
    expect(steps.find((step) => step.id === 'download')).toBeTruthy();
    expect(steps.find((step) => step.id === 'summary').env.JOBS_COMPLETE).toBe(
      jobsCompleteRef,
    );
    expect(downloadStep.env.RUN_ATTEMPT).toBe(
      '${{ github.event.workflow_run.run_attempt }}',
    );
    // Counted over the whole workflow: both projections read the file this one
    // fetch wrote, so the payload must be fetched exactly once.
    expect(
      (
        workflow.match(
          /actions\/runs\/\$\{WORKFLOW_RUN_ID\}\/attempts\/\$\{RUN_ATTEMPT\}\/jobs/g,
        ) ?? []
      ).length,
    ).toBe(1);
    // The ids projection is bound to the array the download loop iterates and to
    // the payload the fetch wrote. Swapping it with the TSV projection below
    // hands the reader whole TSV lines so every log download 404s. Renaming
    // the array on one side loses failing-test details while the job/step
    // summary still renders.
    expect(download).toContain(
      'job_ids=() while IFS= read -r job_id; do job_ids+=("${job_id}") done < <( jq -r \'.jobs[] | select(.conclusion == "failure") | .id\' "${jobs_json}" 2>/dev/null )',
    );
    expect(download).toContain(
      'for job_id in ${job_ids[@]+"${job_ids[@]}"}; do',
    );
    // The same bindings for the projection this PR adds, plus the `|| true` that
    // keeps an errored jobs response from aborting the step under `bash -e`
    // before a failure summary is rendered, and the `2>/dev/null` that keeps the
    // resulting jq parse error out of the log.
    expect(download).toContain(
      'jq -r \'.jobs[] | select(.conclusion == "failure") | [.name] + [.steps[] | select(.conclusion == "failure") | .name] | @tsv\' "${jobs_json}" 2>/dev/null > "${RUNNER_TEMP}/failed-jobs.tsv" || true',
    );
    // Keep the TSV job details in the analysis payload. The span ends at the
    // first analysis redirect, so the later comment invocation cannot satisfy it.
    const analyzeInvocation = summary.match(
      /node "\$\{helper\}" analyze .*?> "\$\{RUNNER_TEMP\}\/analysis\.json"/,
    )?.[0];
    expect(analyzeInvocation, 'the analyze invocation').toContain(
      '--jobs "${RUNNER_TEMP}/failed-jobs.tsv"',
    );
  });

  it('reads the jobs of the event attempt, not the latest attempt', () => {
    // Measured on run 39237270547: attempt 1's jobs carry the host-lock
    // annotation while attempt 2's are green. The supersession guard clears
    // the event when it starts, but the run can move on while this step
    // paginates, so the read itself must name the event's attempt.
    const step = jobs.analyze.steps.find(
      (candidate) => candidate.name === 'Download failed job logs',
    );
    const tmp = mkdtempSync(join(tmpdir(), 'java-ci-download-'));
    try {
      writeFileSync(
        join(tmp, 'gh'),
        `#!/usr/bin/env bash
printf '%s\\n' "$@" > "\${RUNNER_TEMP}/jobs-args"
printf '%s\\n' '{"jobs":[]}'
`,
      );
      chmodSync(join(tmp, 'gh'), 0o755);
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', step.run], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${tmp}:${process.env.PATH}`,
          RUNNER_TEMP: tmp,
          REPO: 'QwenLM/qwen-code',
          WORKFLOW_RUN_ID: '39237270547',
          RUN_ATTEMPT: '1',
          GITHUB_OUTPUT: join(tmp, 'output'),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(tmp, 'jobs-args'), 'utf8')).toContain(
        'attempts/1/jobs',
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses a job list it cannot certify complete', () => {
    // Page 1 arrives and page 2 fails, so `gh api` exits non-zero — but jq has
    // already merged the page it got, and that truncated list reads exactly
    // like a whole run to the projections below and to the infra classifier
    // built on the same file. Spawned without pipefail on purpose: the
    // receipt, not the pipeline status, is what has to reject it.
    const step = jobs.analyze.steps.find(
      (candidate) => candidate.name === 'Download failed job logs',
    );
    const page = (ids) => ({
      total_count: 2,
      jobs: ids.map((id) => ({
        id,
        name: `java-${id}`,
        conclusion: 'failure',
        steps: [],
      })),
    });
    const runPages = (pages) => {
      const tmp = mkdtempSync(join(tmpdir(), 'java-ci-pages-'));
      try {
        writeFileSync(
          join(tmp, 'gh'),
          `${[
            '#!/usr/bin/env bash',
            // The log downloads that follow this fetch are a separate call;
            // only the jobs listing is under test here.
            '[[ "$*" == *"/logs"* ]] && exit 0',
            ...pages.flatMap((entry) => [
              `printf '%s\\n' '${JSON.stringify(entry.body)}'`,
              ...(entry.fail
                ? [`printf '%s\\n' '{"message":"rate limited"}'`, 'exit 1']
                : []),
            ]),
          ].join('\n')}\n`,
        );
        chmodSync(join(tmp, 'gh'), 0o755);
        const result = spawnSync('bash', ['-e', '-c', step.run], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${tmp}:${process.env.PATH}`,
            RUNNER_TEMP: tmp,
            REPO: 'QwenLM/qwen-code',
            WORKFLOW_RUN_ID: '39045740099',
            RUN_ATTEMPT: '1',
            GH_TOKEN: 'fake',
            GITHUB_OUTPUT: join(tmp, 'output'),
          },
        });
        expect(result.status, result.stderr).toBe(0);
        return {
          stdout: result.stdout,
          jobs: JSON.parse(readFileSync(join(tmp, 'run-jobs.json'), 'utf8'))
            .jobs,
          staged: existsSync(join(tmp, 'run-jobs.json.tmp')),
          complete: /jobs_complete=(\w+)/.exec(
            readFileSync(join(tmp, 'output'), 'utf8'),
          )?.[1],
        };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };

    const truncated = runPages([
      { body: page([9001]) },
      { body: page([]), fail: true },
    ]);
    expect(truncated.jobs).toEqual([]);
    expect(truncated.staged).toBe(false);
    expect(truncated.complete).toBe('false');
    expect(truncated.stdout).toContain(
      '::warning::Could not read the whole job list of run',
    );

    // A response carrying no `total_count` at all cannot be certified
    // complete either — this is the input on which a pass condition written
    // `$total == null or …` would publish page 1 as the whole run.
    const noReceipt = runPages([
      { body: { jobs: page([9001]).jobs } },
      { body: { jobs: [] }, fail: true },
    ]);
    expect(noReceipt.jobs).toEqual([]);
    expect(noReceipt.staged).toBe(false);
    expect(noReceipt.complete).toBe('false');

    // gh can also exit 0 with fewer jobs than it declares; the pipeline status
    // cannot see that, so the receipt is the only guard that does.
    const shortButClean = runPages([{ body: page([9001]) }]);
    expect(shortButClean.jobs).toEqual([]);
    expect(shortButClean.complete).toBe('false');

    // Positive control: every page arrives, and the merged list — including
    // the failure that only page 2 carries — is promoted as a whole.
    const complete = runPages([{ body: page([9001]) }, { body: page([9101]) }]);
    expect(complete.jobs.map((job) => job.id)).toEqual([9001, 9101]);
    expect(complete.staged).toBe(false);
    expect(complete.complete).toBe('true');
    expect(complete.stdout).not.toContain('::warning::');
  });

  it('passes --allow-escape-sequences so gh does not refuse the colourised logs', () => {
    // gh >= 2.97.0 (GHSA-3m3g-3wcr-px46) refuses to print a raw response
    // carrying terminal escape sequences unless the flag opts out, and the
    // colourised vitest/pytest logs always carry them: without the flag
    // every download fails deterministically — a retry would hit the
    // identical refusal — so analyze finds no tests for the comment renderer
    // and the summary degrades to job/step names. The analyzer strips ANSI, so
    // the escapes never reach an issue body.
    const download = oneLine(
      jobs.analyze.steps.find(
        (step) => step.name === 'Download failed job logs',
      ).run,
    );
    expect(download).toContain(
      'if ! gh api "repos/${REPO}/actions/jobs/${job_id}/logs" --allow-escape-sequences > "${log_dir}/${job_id}.log"; then',
    );
    // The warn-and-drop fallback is unchanged: a log that still fails only
    // costs precision, never the issue.
    expect(download).toContain(
      'echo "::warning::Could not download the log of job ${job_id}" rm -f "${log_dir}/${job_id}.log"',
    );
  });

  it('uses a random heredoc delimiter for the multiline body output', () => {
    // A constant delimiter lets failure-summary text end the heredoc early
    // and inject fresh GITHUB_OUTPUT keys.
    expect(workflow).toContain('openssl rand -hex 16');
    expect(workflow).toContain('echo "body<<${delim}"');
    expect(workflow).toContain('echo "${delim}"');
    expect(workflow).not.toContain('body<<QWEN_MAIN_CI_FAILURE_BODY\n');
  });

  describe('infrastructure-only failures', () => {
    // 2026-10-06: both ubuntu legs of an SDK Java push run were assigned to
    // one ECS pool whose runners lost the server before executing a single
    // step, and the watcher minted one autofix issue per commit for it
    // (#13510, #13511) — work no code change could resolve. The PR scan has
    // auto-rerun this annotation class for months (qwen-autofix.md#af-076);
    // this lane now does the same for main runs — once, because the rerun's
    // own completion re-enters this workflow at attempt 2 and files then if
    // the break persists (a merged PR's rerun is suppressed as a stale
    // pre-merge head).
    const infraStep = jobs.analyze.steps.find((step) => step.id === 'infra');
    const rerunJob = jobs.rerun_infra;
    const infraScript = oneLine(infraStep.run);

    it('publishes an infra_only verdict from a dedicated analyze step', () => {
      expect(jobs.analyze.outputs.infra_only).toBe(
        '${{ steps.infra.outputs.infra_only }}',
      );
      expect(infraStep.env.RUN_ATTEMPT).toBe(
        '${{ github.event.workflow_run.run_attempt }}',
      );
      // The verdict feeds the rerun job's gate; a missing or renamed output
      // leaves the rerun unreachable and this wiring green only by accident.
      expect(String(rerunJob.if)).toContain(
        "needs.analyze.outputs.infra_only == 'true'",
      );
      // The rerun holds actions: write while infra_only is classified from
      // check-run annotation text — text a fork's own steps print — so it is
      // gated to the destinations that file (main runs and merged PRs). An
      // open PR's infra death is left for its author to retrigger, and the
      // classifier's output never reaches the write token on an untrusted
      // run.
      expect(String(rerunJob.if)).toContain(
        "needs.analyze.outputs.file_issue == 'true'",
      );
      // A provisional report is for a head main already replaced: the rerun
      // would spend pool capacity on it and could not re-enter here.
      expect(String(rerunJob.if)).toContain(
        "needs.analyze.outputs.provisional != 'true'",
      );
    });

    it('uses the same signature list as the PR-scan rerun of qwen-autofix.yml', () => {
      // Two lanes classify the same failure class; a signature added on one
      // side only splits the fleet's behavior. The equality pin — not a
      // shared constant, which workflow YAML cannot express — is what keeps
      // them in lockstep.
      const autofix = parse(
        readFileSync('.github/workflows/qwen-autofix.yml', 'utf8'),
      );
      expect(infraStep.env.INFRA_FAILURE_SIGNATURES).toBe(
        autofix.env.INFRA_FAILURE_SIGNATURES,
      );
      expect(infraStep.env.INFRA_FAILURE_SIGNATURES).toContain(
        'lost communication with the server',
      );
      // A per-host lock starvation (#14550) is the same class: the annotation
      // names a lock budget, not an assertion.
      expect(infraStep.env.INFRA_FAILURE_SIGNATURES).toContain(
        'lock not acquired within',
      );
    });

    it('classifies per failed job and only when EVERY one is infrastructure', () => {
      // The annotation read is per check-run id taken from the jobs payload's
      // own check_run_url, and the match is the same grep the PR scan uses.
      expect(infraScript).toContain(
        'jq -r \'.jobs[] | select(.conclusion == "failure") | select(([(.steps // [])[] | select(.conclusion == "failure") | .name] | map(select(. == "Report the tier result" or . == "Require every macOS test group to pass")) | length) == 0) | [(.id | tostring), ((.check_run_url // "") | split("/")[-1])] | @tsv\'',
      );
      expect(infraScript).toContain(
        'gh api --paginate "repos/${REPO}/check-runs/${check_run_id}/annotations"',
      );
      expect(infraScript).toContain(
        'grep -qiE "${INFRA_FAILURE_SIGNATURES}" <<< "${annotations}"',
      );
      // A mixed run — one real test failure beside one dead runner — must
      // still file: only a unanimous vote suppresses the issue.
      expect(infraScript).toContain(
        '[[ "${total}" -gt 0 && "${infra}" -eq "${total}" ]]',
      );
    });

    it('fails closed: later attempts, empty failure lists, and unreadable annotations all file', () => {
      // The attempt guard is what stops a rerun loop: on main a persistent
      // break re-fails at attempt 2 and files then. Negate it and the pin
      // below goes red.
      expect(infraScript).toContain('if [[ "${RUN_ATTEMPT}" == \'1\' ]]; then');
      // Without the count guard an empty failure set is vacuously "all
      // infrastructure" and a run whose job list could not be fetched would
      // never be reported.
      expect(infraScript).toContain('"${total}" -gt 0');
      // The default is filing: the flag flips only inside the guarded block.
      expect(infraScript).toContain('infra_only=false');
      // An errored annotations fetch must degrade to "not infrastructure",
      // never abort the step or fabricate a match.
      expect(infraScript).toContain(
        '--jq \'[.[].message] | join("\\n")\' 2>/dev/null || true',
      );
    });

    // The gate workflow's reporter job is always() and fails with only the
    // tier-result error — no infrastructure signature — so without the
    // exclusion pinned above every Managed Agent gate lane failure counted
    // as an unclassified job and an infra-killed lane filed an issue instead
    // of rerunning. These cases run the step body against fixture job lists.
    const failedJob = (id, checkId, steps) => ({
      id,
      conclusion: 'failure',
      check_run_url: `https://api.github.com/repos/QwenLM/qwen-code/check-runs/${checkId}`,
      steps,
    });
    const REPORTER_STEP = 'Report the tier result';
    const reporterJob = (id, checkId) =>
      failedJob(id, checkId, [
        { name: 'Set up job', conclusion: 'success' },
        { name: REPORTER_STEP, conclusion: 'failure' },
        { name: 'Complete job', conclusion: 'success' },
      ]);
    const classify = (jobs, annotations) => {
      const tmp = mkdtempSync(join(tmpdir(), 'infra-classify-'));
      try {
        const bin = join(tmp, 'bin');
        mkdirSync(bin);
        writeFileSync(
          join(bin, 'gh'),
          [
            '#!/usr/bin/env bash',
            'id="$(printf \'%s \' "$@" | grep -oE \'check-runs/[0-9]+\' | cut -d/ -f2)"',
            'cat "${ANN_DIR}/${id}.txt" 2>/dev/null || true',
          ].join('\n'),
        );
        chmodSync(join(bin, 'gh'), 0o755);
        const annDir = join(tmp, 'annotations');
        mkdirSync(annDir);
        for (const [id, message] of Object.entries(annotations)) {
          writeFileSync(join(annDir, `${id}.txt`), message);
        }
        writeFileSync(join(tmp, 'run-jobs.json'), JSON.stringify({ jobs }));
        const output = join(tmp, 'output');
        writeFileSync(output, '');
        // Bash 3.2 misparses apostrophes in process-substitution comments.
        const result = spawnSync(
          'bash',
          ['-c', infraStep.run.replace(/^\s*#.*$/gm, '')],
          {
            env: {
              PATH: `${bin}:${process.env.PATH}`,
              RUNNER_TEMP: tmp,
              RUN_ATTEMPT: '1',
              REPO: 'QwenLM/qwen-code',
              GH_TOKEN: 'fake',
              INFRA_FAILURE_SIGNATURES: infraStep.env.INFRA_FAILURE_SIGNATURES,
              ANN_DIR: annDir,
              GITHUB_OUTPUT: output,
            },
            encoding: 'utf8',
          },
        );
        expect(result.status, result.stderr).toBe(0);
        return readFileSync(output, 'utf8');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };

    it('reruns when the only unannotated failure is the gate reporter', () => {
      // This PR's run 38936748280: the lane died with its runner while the
      // reporter failed with the tier-result error — infra, once the
      // derivative reporter is out of the tally.
      const out = classify(
        [
          failedJob(1001, 9001, [
            { name: 'Run Managed Agent tests', conclusion: 'failure' },
          ]),
          reporterJob(1002, 9002),
        ],
        {
          9001: 'lost communication with the server',
          9002: 'Process completed with exit code 1.\nThe fast tier cancelled.',
        },
      );
      expect(out).toContain('infra_only=true');
    });

    it('still reruns when every failed job carries an infra annotation', () => {
      const out = classify(
        [
          failedJob(1001, 9001, [
            { name: 'Run Managed Agent tests', conclusion: 'failure' },
          ]),
        ],
        { 9001: 'No space left on device' },
      );
      expect(out).toContain('infra_only=true');
    });

    it.each([
      ['No space left on device', 'true'],
      ['AssertionError: expected the daemon to answer', 'false'],
    ])(
      'classifies the shard behind a failed macOS aggregate: %s',
      (message, expected) => {
        const out = classify(
          [
            failedJob(1001, 9001, [
              { name: 'Run tests and generate reports', conclusion: 'failure' },
            ]),
            failedJob(1002, 9002, [
              {
                name: 'Require every macOS test group to pass',
                conclusion: 'failure',
              },
            ]),
          ],
          { 9001: message, 9002: 'Process completed with exit code 1.' },
        );
        expect(out).toContain(`infra_only=${expected}`);
      },
    );

    it('keeps counting the reporter when its own runner died before any step', () => {
      // Filtering by the failing STEP name is what keeps this rerun: no step
      // failed, so the job still counts and its infra annotation matches.
      const out = classify([failedJob(1002, 9002, [])], {
        9002: 'The runner has received a shutdown signal',
      });
      expect(out).toContain('infra_only=true');
    });

    it('files when a lane failure carries no infra annotation', () => {
      const out = classify(
        [
          failedJob(1001, 9001, [{ name: 'Run tests', conclusion: 'failure' }]),
          reporterJob(1002, 9002),
        ],
        {
          9001: 'AssertionError: expected the daemon to answer',
          9002: 'Process completed with exit code 1.',
        },
      );
      expect(out).toContain('infra_only=false');
    });

    it('files when a demoted lock wait sits beside a suite failure', () => {
      // The demoted sdk-java wait emits its own warning without the pinned
      // `lock not acquired within` signature, so a code failure on a
      // contended host must file an issue rather than rerun as infra.
      const out = classify(
        [
          failedJob(1001, 9001, [
            { name: 'Run Java SDK tests (self-hosted)', conclusion: 'failure' },
          ]),
        ],
        {
          9001:
            '::warning::sdk-java host lock wait exhausted after 30 minutes; Maven cache write-back skipped; the suite result above is unaffected\n' +
            'AssertionError: expected the suite to pass',
        },
      );
      expect(out).toContain('infra_only=false');
    });

    it('reruns the failed jobs once, with actions:write and no PAT or checkout', () => {
      expect(rerunJob.needs).toBe('analyze');
      expect(rerunJob.permissions).toEqual({ actions: 'write' });
      const rendered = JSON.stringify(rerunJob);
      expect(rendered).not.toContain('CI_DEV_BOT_PAT');
      expect(rendered).not.toContain('actions/checkout');
      expect(oneLine(rerunJob.steps[0].run)).toContain(
        'gh api -X POST "repos/${REPO}/actions/runs/${WORKFLOW_RUN_ID}/rerun-failed-jobs"',
      );
    });

    it('files the issue unless the infra rerun actually ran', () => {
      // rerun_infra is SKIPPED on the ordinary path, and a skipped need is
      // not a success — without always() the file job would silently never
      // run again.
      expect(jobs.file_issue.needs).toEqual(['analyze', 'rerun_infra']);
      const condition = String(jobs.file_issue.if);
      expect(condition).toContain('always()');
      expect(condition).toContain("needs.analyze.result == 'success'");
      expect(condition).toContain("needs.analyze.outputs.file_issue == 'true'");
      expect(condition).toContain("needs.analyze.outputs.infra_only != 'true'");
      // A rerun that could not be dispatched must not swallow the report:
      // the issue is then the only record of a red main.
      expect(condition).toContain("needs.rerun_infra.result != 'success'");
    });

    it('reports an open PR infra-only run without rerunning or filing', () => {
      // infra_only is only ever true at attempt 1, so this fixture is an
      // open PR's infra death, not a merged PR rerun: an untrusted run gets
      // neither actions: write nor an issue, only the comment on the PR.
      const evaluate = (condition, needs) =>
        new Function('needs', 'always', `return (${condition.slice(3, -2)});`)(
          needs,
          () => true,
        );
      const needs = {
        analyze: {
          result: 'success',
          outputs: {
            infra_only: 'true',
            file_issue: 'false',
            comment_body: 'body',
            pr_number: '14472',
          },
        },
        rerun_infra: { result: 'skipped' },
      };
      expect(evaluate(String(rerunJob.if), needs)).toBe(false);
      expect(evaluate(String(jobs.file_issue.if), needs)).toBe(false);
    });

    it('keeps the comment but suppresses the issue and rerun for a merged PR rerun', () => {
      // The reachable shape for a merged PR's attempt >= 2: infra_only is
      // forced false outside attempt 1, and the destination cleared
      // file_issue. The comment is then the failure's only record.
      const evaluate = (condition, needs) =>
        new Function('needs', 'always', `return (${condition.slice(3, -2)});`)(
          needs,
          () => true,
        );
      const needs = {
        analyze: {
          result: 'success',
          outputs: {
            infra_only: 'false',
            file_issue: 'false',
            comment_body: 'body',
            pr_number: '14472',
          },
        },
        rerun_infra: { result: 'skipped' },
      };
      expect(evaluate(String(rerunJob.if), needs)).toBe(false);
      expect(evaluate(String(jobs.file_issue.if), needs)).toBe(false);
      expect(evaluate(String(jobs.report_pr.if), needs)).toBe(true);
    });

    it.each([
      ['false', 'skipped', 'success', 'body', true],
      ['true', 'success', 'success', 'body', false],
      ['true', 'failure', 'success', 'body', true],
      ['true', 'skipped', 'success', 'body', true],
      ['false', 'skipped', 'failure', 'body', true],
      ['false', 'skipped', 'failure', '', false],
    ])(
      'reports infra=%s rerun=%s analyze=%s body=%s: %s',
      (infra, rerun, result, body, expected) => {
        const evaluate = new Function(
          'needs',
          'always',
          `return (${jobs.report_pr.if.slice(3, -2)});`,
        );
        expect(
          evaluate(
            {
              analyze: {
                result,
                outputs: {
                  infra_only: infra,
                  comment_body: body,
                  pr_number: '14472',
                },
              },
              rerun_infra: { result: rerun },
            },
            () => true,
          ),
        ).toBe(expected);
      },
    );
  });

  it('prepares the failure summary without looking up an issue', () => {
    const summary = jobs.analyze.steps.find((step) => step.id === 'summary');
    expect(jobs.analyze.outputs.comment_body).toBe(
      '${{ steps.summary.outputs.body }}',
    );
    expect(jobs.report_pr.steps[0].env.COMMENT_BODY).toBe(
      '${{ needs.analyze.outputs.comment_body }}',
    );
    const tmp = mkdtempSync(join(tmpdir(), 'java-ci-summary-'));
    try {
      writeFileSync(join(tmp, 'gh'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(tmp, 'gh'), 0o755);
      writeFileSync(
        join(tmp, 'failed-jobs.tsv'),
        'Hosted processes\tRun tests\n',
      );
      writeFileSync(join(tmp, 'run-jobs.json'), JSON.stringify({ jobs: [] }));
      const output = join(tmp, 'output');
      const env = {
        ...process.env,
        PATH: `${tmp}:${process.env.PATH}`,
        RUNNER_TEMP: tmp,
        GITHUB_OUTPUT: output,
        REPO: 'QwenLM/qwen-code',
        INFRA_ONLY: 'true',
        JOBS_COMPLETE: 'true',
        WORKFLOW_NAME: 'Managed Agent gate',
        WORKFLOW_RUN_ID: '39045740099',
        WORKFLOW_RUN_URL:
          'https://github.com/QwenLM/qwen-code/actions/runs/39045740099',
        WORKFLOW_RUN_AT: '2026-10-18T00:00:00Z',
        HEAD_SHA: 'abc123456789',
      };
      const prepared = spawnSync(
        'bash',
        ['-eo', 'pipefail', '-c', summary.run],
        { env, encoding: 'utf8' },
      );
      expect(prepared.status, prepared.stderr).toBe(0);
      const body = readFileSync(output, 'utf8');
      const delimiter = body.split('\n')[0].slice('body<<'.length);
      // The body heredoc is followed by the signature-routing outputs; its
      // closing delimiter must still land on its own line, and a run with no
      // identified test emits an empty title and an empty marker list.
      expect(body).toContain(`\n${delimiter}\n`);
      expect(body).toContain('\nsignature_title=\n');
      expect(body).toMatch(
        /test_markers<<QWEN_TEST_MARKERS_[0-9a-f]+\nQWEN_TEST_MARKERS_[0-9a-f]+\n$/,
      );
      expect(body).toContain('### `Managed Agent gate` failed');
      expect(body).toContain('GitHub runner infrastructure failed');
      // A certified job list must not carry the degradation sentence.
      expect(body).not.toContain('could not be read in full');

      // An unread list leaves the same body looking like a run with no
      // identifiable failure, so the reader has to be told. This body is also
      // what the issue record publishes, so one flag covers both surfaces.
      const degradedOut = join(tmp, 'output-degraded');
      const degraded = spawnSync(
        'bash',
        ['-eo', 'pipefail', '-c', summary.run],
        {
          env: {
            ...env,
            GITHUB_OUTPUT: degradedOut,
            JOBS_COMPLETE: 'false',
          },
          encoding: 'utf8',
        },
      );
      expect(degraded.status, degraded.stderr).toBe(0);
      expect(readFileSync(degradedOut, 'utf8')).toContain(
        'The job list could not be read in full',
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('emits the signature title and markers from the analysis', () => {
    // The writer routes on these two outputs, so pin them against a log that
    // actually names a failing test: the title is the helper's issue title,
    // the markers are the body's dedupe keys.
    const summary = jobs.analyze.steps.find((step) => step.id === 'summary');
    const tmp = mkdtempSync(join(tmpdir(), 'java-ci-summary-sig-'));
    try {
      writeFileSync(join(tmp, 'gh'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(tmp, 'gh'), 0o755);
      writeFileSync(join(tmp, 'failed-jobs.tsv'), 'Lane\tRun tests\n');
      writeFileSync(join(tmp, 'run-jobs.json'), JSON.stringify({ jobs: [] }));
      mkdirSync(join(tmp, 'failed-logs'));
      writeFileSync(
        join(tmp, 'failed-logs', 'job.log'),
        '2026-10-24T00:00:00.0000000Z  FAIL src/foo.test.ts > suite > case fails\n',
      );
      const output = join(tmp, 'output');
      const prepared = spawnSync(
        'bash',
        ['-eo', 'pipefail', '-c', summary.run],
        {
          env: {
            ...process.env,
            PATH: `${tmp}:${process.env.PATH}`,
            RUNNER_TEMP: tmp,
            GITHUB_OUTPUT: output,
            REPO: 'QwenLM/qwen-code',
            INFRA_ONLY: 'false',
            JOBS_COMPLETE: 'true',
            WORKFLOW_NAME: 'Managed Agent gate',
            WORKFLOW_RUN_ID: '39045740099',
            WORKFLOW_RUN_URL:
              'https://github.com/QwenLM/qwen-code/actions/runs/39045740099',
            HEAD_SHA: 'abc123456789',
          },
          encoding: 'utf8',
        },
      );
      expect(prepared.status, prepared.stderr).toBe(0);
      const out = readFileSync(output, 'utf8');
      expect(out).toContain(
        'signature_title=Main CI failed: Managed Agent gate — src/foo.test.ts > … > case fails\n',
      );
      const key = testKey('src/foo.test.ts > suite > case fails');
      expect(out).toContain(`qwen-main-ci-failure-test:${key}\n`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  const privilegedJobs = Object.entries(jobs).filter(([, job]) =>
    JSON.stringify(job).includes('CI_DEV_BOT_PAT'),
  );

  it.each([
    [
      'github-actions[bot]',
      'PATCH',
      'issues/comments/456',
      'https://github.com/QwenLM/qwen-code/issues/14500',
      0,
      false,
    ],
    ['contributor', 'POST', 'issues/14472/comments', '', 0, false],
    // The first report on a fresh issue is a POST carrying the link; a
    // regrouping that emits it only on PATCH would drop it from that comment.
    [
      'contributor',
      'POST',
      'issues/14472/comments',
      'https://github.com/QwenLM/qwen-code/issues/14500',
      0,
      false,
    ],
    ['github-actions[bot]', 'PATCH', 'issues/comments/456', '', 1, false],
    // A suppressed rerun finds the comment an earlier attempt linked to a
    // still-open issue; the whole-body PATCH must not drop that link.
    ['github-actions[bot]', 'PATCH', 'issues/comments/456', '', 0, true, 0],
    // A publish failure on attempt 1 re-enters the loop with the body already
    // written once; the assembly truncate must keep the link single.
    ['github-actions[bot]', 'PATCH', 'issues/comments/456', '', 0, true, 1],
    // A freshly filed issue outranks a link recovered from the earlier
    // attempt's comment, which pointed at a different issue.
    [
      'github-actions[bot]',
      'PATCH',
      'issues/comments/456',
      'https://github.com/QwenLM/qwen-code/issues/14500',
      0,
      true,
      0,
    ],
    ['github-actions[bot]', null, null, '', 3, false, 0],
  ])(
    'upserts a %s comment via %s with %s and issue=%s after %s lookup errors (existing tracking: %s)',
    (
      login,
      method,
      endpoint,
      issueUrl,
      failures,
      existingTracking,
      publishFailures = 0,
    ) => {
      const tmp = mkdtempSync(join(tmpdir(), 'java-ci-comment-'));
      try {
        const step = jobs.report_pr.steps[0];
        const comment = renderFailureComment({
          analysis: { workflow: 'Managed Agent gate', tests: [] },
          occurrence: {
            sha: 'abc123456789',
            runId: '39045740099',
            runUrl:
              'https://github.com/QwenLM/qwen-code/actions/runs/39045740099',
          },
        });
        const existingBody = existingTracking
          ? `${comment}\n[Tracking issue](https://github.com/QwenLM/qwen-code/issues/15240)\n`
          : comment;
        writeFileSync(
          join(tmp, 'comments.json'),
          JSON.stringify(
            [123, 456].map((id) => ({
              id,
              user: { login },
              body: existingBody,
            })),
          ),
        );
        writeFileSync(
          join(tmp, 'gh'),
          `#!/usr/bin/env bash
if [[ "$*" == *--paginate* ]]; then
  count=$(cat "\${RUNNER_TEMP}/lookups" 2>/dev/null || echo 0)
  count=$((count + 1))
  echo "$count" > "\${RUNNER_TEMP}/lookups"
  if [[ "$count" -le "\${LOOKUP_FAILURES}" ]]; then exit 1; fi
  cat "\${RUNNER_TEMP}/comments.json"
else
  count=$(cat "\${RUNNER_TEMP}/publishes" 2>/dev/null || echo 0)
  count=$((count + 1))
  echo "$count" > "\${RUNNER_TEMP}/publishes"
  if [[ "$count" -le "\${PUBLISH_FAILURES:-0}" ]]; then exit 1; fi
  printf '%s\n' "$@" > "\${RUNNER_TEMP}/published-args"
fi
`,
        );
        writeFileSync(join(tmp, 'sleep'), '#!/bin/sh\nexit 0\n');
        chmodSync(join(tmp, 'gh'), 0o755);
        chmodSync(join(tmp, 'sleep'), 0o755);
        const result = spawnSync('bash', ['-eo', 'pipefail', '-c', step.run], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${tmp}:${process.env.PATH}`,
            RUNNER_TEMP: tmp,
            REPO: 'QwenLM/qwen-code',
            PR_NUMBER: '14472',
            WORKFLOW_RUN_ID: '39045740099',
            COMMENT_BODY: comment,
            ISSUE_URL: issueUrl,
            LOOKUP_FAILURES: String(failures),
            PUBLISH_FAILURES: String(publishFailures),
          },
        });
        expect(result.status, result.stderr).toBe(method ? 0 : 1);
        const published = join(tmp, 'published-args');
        if (method) {
          const publishedArgs = readFileSync(published, 'utf8');
          expect(publishedArgs).toContain(
            `${method}\nrepos/QwenLM/qwen-code/${endpoint}\n`,
          );
          // Tie the body assertions to the publish call itself: a repointed
          // body argument would ship a linkless comment while the assembly
          // file this test inspects still looked right.
          expect(publishedArgs).toContain(
            `-F\nbody=@${join(tmp, 'pr-comment.md')}\n`,
          );
          const publishedBody = readFileSync(
            join(tmp, 'pr-comment.md'),
            'utf8',
          );
          expect(publishedBody).toContain(comment);
          const expectedTracking =
            issueUrl ||
            (existingTracking
              ? 'https://github.com/QwenLM/qwen-code/issues/15240'
              : '');
          if (expectedTracking) {
            expect(publishedBody).toContain(
              `[Tracking issue](${expectedTracking})`,
            );
            expect(publishedBody.match(/\[Tracking issue\]\(/g)).toHaveLength(
              1,
            );
          } else {
            expect(publishedBody.includes('[Tracking issue]')).toBe(false);
          }
          // The emitter's line must stay the one the recovery grep accepts;
          // decorating it would silently drop the link on a suppressed rerun.
          if (issueUrl) {
            const recoveryPattern = step.run.match(/grep -m1 -E '([^']*)'/)[1];
            expect(new RegExp(recoveryPattern, 'm').test(publishedBody)).toBe(
              true,
            );
          }
        } else {
          // A lookup-exhausted run must not publish, or every failed lookup
          // duplicates the bot comment.
          expect(existsSync(published)).toBe(false);
        }
        expect(JSON.stringify(jobs.report_pr)).not.toContain(
          'actions/checkout',
        );
        expect(JSON.stringify(jobs.report_pr)).not.toContain('CI_DEV_BOT_PAT');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it('grants the PR comment writer access to pull requests', () => {
    expect(jobs.report_pr.permissions).toEqual({
      issues: 'write',
      'pull-requests': 'write',
    });
  });

  it('keeps the bot PAT in a job that runs no repository code', () => {
    // The job that can write as the bot must not check out or execute anything
    // from the repository; it only consumes strings produced elsewhere.
    expect(privilegedJobs).toHaveLength(1);
    for (const [name, job] of privilegedJobs) {
      const rendered = JSON.stringify(job);
      expect(rendered, name).not.toContain('actions/checkout');
      expect(rendered, name).not.toContain('main-failure-signature.mjs');
      expect(job.permissions, name).toEqual({ issues: 'write' });
    }
  });

  it('pins the analyze checkout and drops persist-credentials', () => {
    // The read-only analyze job does check out the repo (it runs the helper),
    // so pin it to a SHA rather than a mutable tag and never leave the workflow
    // token on the runner.
    const checkout = jobs.analyze.steps.find((step) =>
      String(step.uses ?? '').startsWith('actions/checkout'),
    );
    expect(checkout).toBeDefined();
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout.with['persist-credentials']).toBe(false);
  });

  it('keeps the log analysis away from the bot PAT and from write scopes', () => {
    const analyze = jobs.analyze;
    expect(JSON.stringify(analyze)).not.toContain('CI_DEV_BOT_PAT');
    // Reading job logs needs `actions: read`; the infrastructure detector
    // reads check-run annotations, which are gated behind `checks: read`.
    // Nothing here needs write.
    expect(analyze.permissions).toEqual({
      actions: 'read',
      checks: 'read',
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(privilegedJobs[0][1].needs).toEqual(['analyze', 'rerun_infra']);
  });
});
