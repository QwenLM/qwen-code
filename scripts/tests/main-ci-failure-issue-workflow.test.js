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
import { renderFailureComment } from '../../.github/scripts/ci/main-failure-signature.mjs';

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
    // their only failure signal, so both ride the same deduplicated issue and
    // autofix route as the nightly CLI checks.
    const watchedFiles = {
      'E2E Tests': 'e2e',
      'Managed Agent gate': 'managed-agent-gate',
      'SDK Java': 'sdk-java',
      'SDK Python': 'sdk-python',
      'Qwen Code CI': 'ci',
      'Desktop Checks': 'desktop-packaging-check',
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
        'contains(fromJSON(\'["Qwen Code CI","SDK Java","Desktop Checks"]\'), github.event.workflow.name)))) || ' +
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
    it('also files an issue when the failed PR already merged', () => {
      expect(resolve([pr({ merged_at: '2026-10-17T16:15:57Z' })]).output).toBe(
        'pr_number=14472\nfile_issue=true\n',
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
    it('files a main dispatch failure without a PR', () => {
      const resolved = resolve([], {
        EVENT_NAME: 'workflow_dispatch',
        HEAD_BRANCH: 'main',
      });
      expect(resolved.output).toBe('pr_number=\nfile_issue=true\n');
      expect(resolved.args).toBe('');
      expect(resolved.stdout).not.toContain('::warning::');
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
    const plan = jobs.analyze.steps.find((step) => step.id === 'plan');
    expect(plan.env.WORKFLOW_NAME).toBe('${{ github.event.workflow.name }}');
  });

  it('creates an issue that the existing autofix worker can pick up', () => {
    expect(workflow).toContain("issues: 'write'");
    expect(workflow).toContain('CI_DEV_BOT_PAT');
    expect(workflow).toContain(
      'AUTOFIX_BOT: "${{ vars.AUTOFIX_BOT_LOGIN || \'qwen-code-dev-bot\' }}"',
    );
    expect(workflow).toContain("BUG_LABEL: 'type/bug'");
    expect(workflow).toContain(
      "READY_FOR_AGENT_LABEL: 'status/ready-for-agent'",
    );
    expect(workflow).toContain("AUTOFIX_APPROVED_LABEL: 'autofix/approved'");
    expect(workflow).toContain('gh issue edit "$1"');
    expect(workflow).toContain(
      '--add-label "${BUG_LABEL},${READY_FOR_AGENT_LABEL},${AUTOFIX_APPROVED_LABEL}"',
    );
    expect(workflow).toContain('--add-assignee "${AUTOFIX_BOT}"');
    expect(workflow).toContain('apply_autofix_route "${issue_url}"');
  });

  it('deduplicates by failing test and includes run context', () => {
    // The dedupe key is the failing test, not the commit: a standing red used to
    // open one issue per merge. The markers themselves live in the helper.
    expect(workflow).toContain('main-failure-signature.mjs');
    expect(workflow).toContain('searchMarkers');
    // The failing tests are read from the triggering run's failed-job logs, so
    // the dedupe key is recovered even when the run reported no test result.
    expect(workflow).toContain('actions/runs/${WORKFLOW_RUN_ID}/jobs');
    expect(workflow).toContain('actions/jobs/${job_id}/logs');
    expect(workflow).toContain('gh issue list');
    expect(workflow).toContain('gh issue create');
    expect(workflow).toContain('apply_autofix_route "${EXISTING_ISSUE}"');
    expect(workflow).toContain('${WORKFLOW_RUN_URL}');
    expect(workflow).toContain('${HEAD_SHA}');
  });

  it('hands the helper the failed job and step of a run with no test result', () => {
    // A lane that dies before printing any test result leaves no failing test to
    // dedupe on, so the issue falls back to one per commit — and without the job
    // list the fallback body named nothing but the commit, which is what made a
    // standing red lane undiagnosable from its own issue.
    //
    // Each pin below is scoped to the step that owns it and spans a producer
    // together with its consumer. Isolated substrings cannot express this
    // contract — one fetch feeding two jq projections feeding two consumers —
    // and every fragment of it stays green on its own when the wiring between
    // them is cut. Collapsing the line continuations first keeps the pins
    // reading like the shell they pin rather than like this file's indentation.
    const steps = jobs.analyze.steps;
    const download = oneLine(
      steps.find((step) => step.name === 'Download failed job logs').run,
    );
    const summary = oneLine(steps.find((step) => step.id === 'summary').run);

    // `gh api` writes a non-2xx body to stdout before exiting non-zero, so the
    // fetch has to stay non-fatal AND say so — with the warning inside the
    // `then` block, since outside it a successful fetch raises an annotation
    // claiming the opposite. `--paginate` rides the same span because this one
    // fetch feeds both projections, so dropping it caps a wide run at page 1.
    // The slurp merge rides it too: `--paginate` prints one document per page
    // while the comment helper reads the file with a single JSON.parse, so a
    // run wider than one page would silently render a comment naming no job
    // without it.
    expect(download).toContain(
      'if ! gh api "repos/${REPO}/actions/runs/${WORKFLOW_RUN_ID}/jobs?per_page=100" --paginate | jq -s \'{jobs: [ .[].jobs[]? ]}\' > "${jobs_json}"; then echo "::warning::Could not list the jobs of run ${WORKFLOW_RUN_ID}" fi',
    );
    // Counted over the whole workflow: both projections read the file this one
    // fetch wrote, so the payload must be fetched exactly once.
    expect(
      (workflow.match(/actions\/runs\/\$\{WORKFLOW_RUN_ID\}\/jobs/g) ?? [])
        .length,
    ).toBe(1);
    // The ids projection is bound to the array the download loop iterates and to
    // the payload the fetch wrote. Swapping it with the TSV projection below
    // hands `mapfile` whole TSV lines so every log download 404s; renaming the
    // array on one side only returns every run to the per-commit fallback while
    // the failed-jobs section still renders.
    expect(download).toContain(
      'mapfile -t job_ids < <( jq -r \'.jobs[] | select(.conclusion == "failure") | .id\' "${jobs_json}" 2>/dev/null )',
    );
    expect(download).toContain('for job_id in "${job_ids[@]}"; do');
    // The same bindings for the projection this PR adds, plus the `|| true` that
    // keeps an errored jobs response from aborting the step under `bash -e`
    // before the issue is planned at all, and the `2>/dev/null` that keeps the
    // resulting jq parse error out of the log.
    expect(download).toContain(
      'jq -r \'.jobs[] | select(.conclusion == "failure") | [.name] + [.steps[] | select(.conclusion == "failure") | .name] | @tsv\' "${jobs_json}" 2>/dev/null > "${RUNNER_TEMP}/failed-jobs.tsv" || true',
    );
    // `--jobs` has to ride the `analyze` invocation: `plan` never reads
    // `options.jobs`, so moving the flag there drops the section silently. The
    // span ends at the first analysis redirect, so no later helper call in the
    // step can satisfy it.
    const analyzeInvocation = summary.match(
      /node "\$\{helper\}" analyze .*?> "\$\{RUNNER_TEMP\}\/analysis\.json"/,
    )?.[0];
    expect(analyzeInvocation, 'the analyze invocation').toContain(
      '--jobs "${RUNNER_TEMP}/failed-jobs.tsv"',
    );
  });

  it('passes --allow-escape-sequences so gh does not refuse the colourised logs', () => {
    // gh >= 2.97.0 (GHSA-3m3g-3wcr-px46) refuses to print a raw response
    // carrying terminal escape sequences unless the flag opts out, and the
    // colourised vitest/pytest logs always carry them: without the flag
    // every download fails deterministically — a retry would hit the
    // identical refusal — and the plan falls back to a per-commit issue
    // naming no failing test. The analyzer strips ANSI before matching, so
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

  it('re-reads an existing issue so recorded recurrences survive the update', () => {
    expect(workflow).toContain('gh issue view "${existing_issue}"');
    expect(workflow).toContain('--existing "${existing_body}"');
  });

  it('uses a random heredoc delimiter for the multiline body output', () => {
    // A constant delimiter lets issue-body prose (which the autofix agent
    // writes into) end the heredoc early and inject fresh GITHUB_OUTPUT keys.
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
    // the break persists.
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
        'jq -r \'.jobs[] | select(.conclusion == "failure") | select(([(.steps // [])[] | select(.conclusion == "failure") | .name] | index("Report the tier result")) | not) | [(.id | tostring), ((.check_run_url // "") | split("/")[-1])] | @tsv\'',
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
      // The attempt guard is what stops a rerun loop: a persistent break
      // re-fails at attempt 2 and files then. Negate it and the pin below
      // goes red.
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

  it('prepares the PR summary before a failed issue lookup and exports it to the writer', () => {
    const summary = jobs.analyze.steps.find((step) => step.id === 'summary');
    const plan = jobs.analyze.steps.find((step) => step.id === 'plan');
    expect(jobs.analyze.steps.indexOf(summary)).toBeLessThan(
      jobs.analyze.steps.indexOf(plan),
    );
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
      expect(body.endsWith(`${delimiter}\n`)).toBe(true);
      expect(body).toContain('### `Managed Agent gate` failed');
      expect(body).toContain('GitHub runner infrastructure failed');
      const planned = spawnSync('bash', ['-eo', 'pipefail', '-c', plan.run], {
        env,
        encoding: 'utf8',
      });
      expect(planned.status).toBe(1);
      expect(readFileSync(output, 'utf8')).toBe(body);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  describe('file or update the autofix issue', () => {
    const issueStep = jobs.file_issue.steps.find((step) => step.id === 'issue');
    const runStep = (overrides, ghScript) => {
      const tmp = mkdtempSync(join(tmpdir(), 'java-ci-issue-'));
      try {
        writeFileSync(join(tmp, 'gh'), ghScript);
        chmodSync(join(tmp, 'gh'), 0o755);
        const output = join(tmp, 'output');
        writeFileSync(output, '');
        const result = spawnSync(
          'bash',
          ['-eo', 'pipefail', '-c', issueStep.run],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${tmp}:${process.env.PATH}`,
              RUNNER_TEMP: tmp,
              GITHUB_OUTPUT: output,
              GH_TOKEN: 'fake',
              REPO: 'QwenLM/qwen-code',
              EXISTING_ISSUE: '',
              ISSUE_TITLE: 'Main CI failed: SDK Java — FooTest.bar',
              ISSUE_BODY: 'body',
              AUTOFIX_BOT: 'qwen-code-dev-bot',
              BUG_LABEL: 'type/bug',
              READY_FOR_AGENT_LABEL: 'status/ready-for-agent',
              AUTOFIX_APPROVED_LABEL: 'autofix/approved',
              ...overrides,
            },
          },
        );
        return { result, output: readFileSync(output, 'utf8') };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };
    // Only the route edit fails: a renamed label or a non-collaborator
    // assignee makes gh issue edit exit non-zero while the create and the
    // body edit succeed.
    const routeEditFails = [
      '#!/usr/bin/env bash',
      'if [[ "$*" == *--add-label* ]]; then exit 1; fi',
      'if [[ "$*" == *create* ]]; then',
      '  echo "https://github.com/QwenLM/qwen-code/issues/14500"',
      'fi',
    ].join('\n');

    it('publishes the issue url even when the autofix route edit fails', () => {
      // bash -e aborts the step on the failed edit; the output must already
      // be written, or report_pr posts its comment without the tracking
      // link and nothing ever restores it.
      const created = runStep({}, routeEditFails);
      expect(created.result.status).toBe(1);
      expect(created.output).toContain(
        'issue_url=https://github.com/QwenLM/qwen-code/issues/14500',
      );
      const existing = runStep({ EXISTING_ISSUE: '14499' }, routeEditFails);
      expect(existing.result.status).toBe(1);
      expect(existing.output).toContain(
        'issue_url=https://github.com/QwenLM/qwen-code/issues/14499',
      );
    });

    it('creates, routes and publishes the url when nothing fails', () => {
      const allSucceed = [
        '#!/usr/bin/env bash',
        'if [[ "$*" == *create* ]]; then',
        '  echo "https://github.com/QwenLM/qwen-code/issues/14500"',
        'fi',
      ].join('\n');
      const { result, output } = runStep({}, allSucceed);
      expect(result.status, result.stderr).toBe(0);
      expect(output).toContain(
        'issue_url=https://github.com/QwenLM/qwen-code/issues/14500',
      );
    });
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
    ],
    ['contributor', 'POST', 'issues/14472/comments', '', 0],
    ['github-actions[bot]', 'PATCH', 'issues/comments/456', '', 1],
    ['github-actions[bot]', null, null, '', 3],
  ])(
    'upserts a %s comment via %s with %s and issue=%s after %s lookup errors',
    (login, method, endpoint, issueUrl, failures) => {
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
        writeFileSync(
          join(tmp, 'comments.json'),
          JSON.stringify(
            [123, 456].map((id) => ({ id, user: { login }, body: comment })),
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
          },
        });
        expect(result.status, result.stderr).toBe(method ? 0 : 1);
        const published = join(tmp, 'published-args');
        if (method)
          expect(readFileSync(published, 'utf8')).toContain(
            `${method}\nrepos/QwenLM/qwen-code/${endpoint}\n`,
          );
        else expect(existsSync(published)).toBe(false);
        expect(
          readFileSync(join(tmp, 'pr-comment.md'), 'utf8').includes(
            '[Tracking issue]',
          ),
        ).toBe(Boolean(issueUrl));
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
      issues: 'read',
      'pull-requests': 'read',
    });
    expect(privilegedJobs[0][1].needs).toEqual(['analyze', 'rerun_infra']);
  });
});
