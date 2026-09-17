/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('main CI failure issue workflow', () => {
  const workflow = readFileSync(
    '.github/workflows/main-ci-failure-issue.yml',
    'utf8',
  );
  const yml = parse(workflow);
  const jobs = yml.jobs;

  it('opens an autofix-ready issue only for failed main CI runs', () => {
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain(
      "workflows: ['E2E Tests', 'SDK Python', 'Qwen Code CI']",
    );
    expect(workflow).toContain("types: ['completed']");
    // 'Qwen Code CI' joined the list when the macOS and Windows lanes got a
    // nightly run on main: that run is their only trigger outside a
    // pull request, and a red lane nobody is told about is the same silence
    // the merge-queue-only gate produced. It completes on every pull request
    // too, so the branch filter keeps those events out entirely rather than
    // raising one per run just to skip it.
    expect(workflow).toContain("branches: ['main']");
    expect(workflow).toContain("github.repository == 'QwenLM/qwen-code'");
    expect(workflow).toContain(
      "github.event.workflow_run.conclusion == 'failure'",
    );
    expect(workflow).toContain(
      "github.event.workflow_run.head_branch == 'main'",
    );
    // Push covers the other two watched workflows AND 'Qwen Code CI''s own
    // post-merge lane on `main` — ci.yml restored that trigger, so main's
    // squash commits now carry Test check-runs and a red one files an issue
    // here. Schedule is scoped to
    // 'Qwen Code CI' — that nightly is the platform lanes' only trigger
    // outside a pull request, and the other watched workflows' own
    // nightlies must not dispatch the autofix agent through this watcher.
    // A pull-request run of any of them must never open an issue — that is
    // contributor-triggered, and the branch filter plus this clause are
    // what keep it out. Pin the whole event clause so a connective or
    // scope mutation fails here.
    expect(workflow).toContain(
      "(github.event.workflow_run.event == 'push' || (github.event.workflow_run.event == 'schedule' && github.event.workflow_run.name == 'Qwen Code CI'))",
    );
    expect(workflow).not.toContain(
      "github.event.workflow_run.event == 'pull_request'",
    );
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
    const oneLine = (script) =>
      script.replace(/\\\n/g, '\n').replace(/\s+/g, ' ');
    const steps = jobs.analyze.steps;
    const download = oneLine(
      steps.find((step) => step.name === 'Download failed job logs').run,
    );
    const plan = oneLine(steps.find((step) => step.id === 'plan').run);

    // `gh api` writes a non-2xx body to stdout before exiting non-zero, so the
    // fetch has to stay non-fatal AND say so — with the warning inside the
    // `then` block, since outside it a successful fetch raises an annotation
    // claiming the opposite. `--paginate` rides the same span because this one
    // fetch feeds both projections, so dropping it caps a wide run at page 1.
    expect(download).toContain(
      'if ! gh api "repos/${REPO}/actions/runs/${WORKFLOW_RUN_ID}/jobs?per_page=100" --paginate > "${jobs_json}"; then echo "::warning::Could not list the jobs of run ${WORKFLOW_RUN_ID}" fi',
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
    // The never-started classification rides the same single fetch: the meta
    // projection is the only writer of the file --jobs-meta hands to analyze.
    // The population is every job that did not pass — a leg cancelled at its
    // timeout DID execute repository code, and a `failure`-only filter would
    // read a real regression as a fleet failure — and the count covers
    // repository steps only, so a runner that died during setup still reads
    // as zero. runner_name rides along so the fleet issue can name the host.
    // `-s` is load-bearing: --paginate writes one JSON document per page, and
    // projecting per document would leave N concatenated arrays that the
    // helper's JSON.parse rejects, silently reading every run with more than
    // 100 jobs as not never-started.
    expect(download).toContain(
      'jq -c -s \'[.[].jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | {name: .name, runner_name: .runner_name, steps: ([.steps[]? | select(.name != "Set up job" and .name != "Complete job" and .conclusion != "skipped")] | length)}]\' "${jobs_json}" 2>/dev/null > "${RUNNER_TEMP}/failed-jobs-meta.json" || true',
    );
    // `--jobs` has to ride the `analyze` invocation: `plan` never reads
    // `options.jobs`, so moving the flag there drops the section silently. The
    // span ends at the first `> "${analysis}"`, so no later helper call in the
    // step can satisfy it.
    const analyzeInvocation = plan.match(
      /node "\$\{helper\}" analyze .*?> "\$\{analysis\}"/,
    )?.[0];
    expect(analyzeInvocation, 'the analyze invocation').toContain(
      '--jobs "${RUNNER_TEMP}/failed-jobs.tsv"',
    );
    expect(analyzeInvocation, 'the analyze invocation').toContain(
      '--jobs-meta "${RUNNER_TEMP}/failed-jobs-meta.json"',
    );
  });

  // The meta projection above is pinned as a literal; here it is EXECUTED
  // against recorded payload shapes, end to end into the helper's analyze —
  // the literal cannot see the classifier's two halves disagreeing, only
  // this replay can. jq runs only where the platform provides it (this file
  // is not win32-excluded), so the capability guard mirrors
  // build-and-publish-image-workflow.test.js's replayable gate.
  const jqReplayable =
    process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0;

  it.skipIf(!jqReplayable)(
    'classifies the recorded fleet, timeout and setup-death shapes end to end',
    () => {
      const download = String(
        jobs.analyze.steps.find(
          (step) => step.name === 'Download failed job logs',
        ).run,
      );
      const logical = download.replace(/\\\n\s*/g, ' ');
      const metaCommand = logical
        .split('\n')
        .find((line) => line.includes('failed-jobs-meta.json'));
      const projection = metaCommand?.match(/jq -c -s '([^']+)'/)?.[1];
      expect(projection).toBeTruthy();

      const helper = '.github/scripts/ci/main-failure-signature.mjs';
      const analyze = (jobsPayload) => {
        const dir = mkdtempSync(join(tmpdir(), 'main-ci-failure-meta-'));
        const jobsJson = join(dir, 'run-jobs.json');
        const metaPath = join(dir, 'failed-jobs-meta.json');
        writeFileSync(jobsJson, JSON.stringify(jobsPayload));
        const jq = spawnSync('jq', ['-c', '-s', projection, jobsJson], {
          encoding: 'utf8',
        });
        expect(jq.status).toBe(0);
        writeFileSync(metaPath, jq.stdout);
        const analyzeRun = spawnSync(
          process.execPath,
          [
            helper,
            'analyze',
            '--workflow',
            'E2E Tests',
            '--jobs-meta',
            metaPath,
          ],
          { encoding: 'utf8' },
        );
        expect(analyzeRun.status).toBe(0);
        return JSON.parse(analyzeRun.stdout);
      };

      // The motivating incident (run 35051269368): one queue-starved leg,
      // one successful sibling — the never-started class, host carried.
      const neverStarted = analyze({
        jobs: [
          {
            name: 'E2E Test (Linux) - sandbox:docker - shard 1/1',
            conclusion: 'failure',
            runner_name: 'ecs-qwen-hk4-30',
            steps: [],
          },
          {
            name: 'E2E Test (Linux) - sandbox:none - shard 1/1',
            conclusion: 'success',
            runner_name: 'ecs-qwen-hk5-21',
            steps: [{ name: 'Checkout', conclusion: 'success' }],
          },
        ],
      });
      expect(neverStarted.neverStarted).toBe(true);

      // A leg cancelled at its timeout DID run repository code (the shape of
      // run 34030617765's Test leg): the run is NOT the never-started class.
      const timedOut = analyze({
        jobs: [
          {
            name: 'Lint & Static (ubuntu-latest, Node 22.x)',
            conclusion: 'failure',
            runner_name: 'ecs-qwen-hk4-2',
            steps: [],
          },
          {
            name: 'Test (ubuntu-latest, Node 22.x)',
            conclusion: 'cancelled',
            runner_name: 'ecs-qwen-hk3-32',
            steps: [
              { name: 'Set up job', conclusion: 'success' },
              { name: 'Checkout', conclusion: 'success' },
              {
                name: 'Run tests and generate reports',
                conclusion: 'cancelled',
              },
              { name: 'Upload coverage', conclusion: 'skipped' },
              { name: 'Complete job', conclusion: 'success' },
            ],
          },
        ],
      });
      expect(timedOut.neverStarted).toBe(false);

      // A runner that died during setup ran no repository code either: the
      // runner-internal entries must not count against the class.
      const setupDeath = analyze({
        jobs: [
          {
            name: 'Build for E2E',
            conclusion: 'failure',
            runner_name: 'ecs-qwen-hk4-9',
            steps: [
              { name: 'Set up job', conclusion: 'failure' },
              { name: 'Checkout', conclusion: 'skipped' },
              { name: 'Complete job', conclusion: 'success' },
            ],
          },
        ],
      });
      expect(setupDeath.neverStarted).toBe(true);
    },
  );

  it('re-runs a never-started run once instead of filing an issue for it', () => {
    // A failed job with zero executed steps ran no repository code at all —
    // the runner died after accepting the assignment — so the per-commit
    // issue can only misattribute a fleet flake to an innocent commit. The
    // one bounded re-run absorbs the flake; its own completion re-triggers
    // this workflow, and a recurrence on attempt 2 files normally, so a
    // persistent outage still surfaces.
    const rerun = jobs.rerun_never_started;
    expect(rerun).toBeDefined();
    expect(rerun.needs).toBe('analyze');
    // Both ends of the producer wiring, pinned like the consumer `if:` below:
    // cutting either link turns the whole feature into a silent no-op behind
    // a green suite — jq's `// false` fallback prints false for every run and
    // no re-run ever fires.
    expect(jobs.analyze.outputs.never_started).toBe(
      '${{ steps.plan.outputs.never_started }}',
    );
    const planRun = String(
      jobs.analyze.steps.find((step) => step.id === 'plan').run,
    );
    expect(planRun).toContain(
      'echo "never_started=$(jq -r \'.neverStarted // false\' "${analysis}")" >> "${GITHUB_OUTPUT}"',
    );
    // The route stand-down is the stricter flag, produced and consumed with
    // the same wiring discipline: a setup death keeps the autofix route.
    expect(jobs.analyze.outputs.stand_down).toBe(
      '${{ steps.plan.outputs.stand_down }}',
    );
    expect(planRun).toContain(
      'echo "stand_down=$(jq -r \'.standDown // false\' "${analysis}")" >> "${GITHUB_OUTPUT}"',
    );
    // file_issue re-runs the dedupe lookup on this marker right before
    // creating (see below); cutting either link silently re-opens the
    // two-watchers-one-commit duplicate.
    expect(jobs.analyze.outputs.search_marker).toBe(
      '${{ steps.plan.outputs.search_marker }}',
    );
    expect(planRun).toContain(
      'echo "search_marker=$(jq -r \'.searchMarkers[0]\' "${plan}")" >> "${GITHUB_OUTPUT}"',
    );
    expect(String(rerun.if)).toContain(
      "needs.analyze.outputs.never_started == 'true'",
    );
    expect(String(rerun.if)).toContain(
      'github.event.workflow_run.run_attempt == 1',
    );
    // The re-run needs actions:write, and it must not live on the job holding
    // the bot PAT — that job's { issues: write } scope is pinned below.
    expect(rerun.permissions).toEqual({ actions: 'write' });
    // Deliberately hosted, NOT the ECS pool: the class this job exists for
    // is a dead pool runner, so queueing the re-run behind that pool would
    // turn the feature off exactly when it is needed.
    expect(rerun['runs-on']).toBe('ubuntu-latest');
    expect(jobs.file_issue['runs-on']).toBe('ubuntu-latest');
    expect(JSON.stringify(rerun)).not.toContain('CI_DEV_BOT_PAT');
    expect(JSON.stringify(rerun)).not.toContain('actions/checkout');
    expect(JSON.stringify(rerun)).toContain(
      'actions/runs/${WORKFLOW_RUN_ID}/rerun-failed-jobs',
    );
    // The request pinned with its method and the env that fills the URL: the
    // URL substring alone stays green when `-X POST` is dropped (a GET on
    // this path 404s) or the env goes (the URL renders
    // runs//rerun-failed-jobs) — gh exits non-zero, the job fails, file_issue
    // files, and no run is ever re-run again: the feature silently off.
    expect(rerun.steps[0].env.WORKFLOW_RUN_ID).toBe(
      '${{ github.event.workflow_run.id }}',
    );
    // The URL fills from REPO and every call authenticates with GH_TOKEN:
    // dropping either line fails the step at its first gh call behind a
    // green suite.
    expect(rerun.steps[0].env.REPO).toBe('${{ github.repository }}');
    expect(rerun.steps[0].env.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(String(rerun.steps[0].run)).toContain(
      'gh api -X POST "repos/${REPO}/actions/runs/${WORKFLOW_RUN_ID}/rerun-failed-jobs"',
    );
    // The supersession check is a pre-POST snapshot; a run created inside
    // the gap is displaced with no record. The same query runs again AFTER
    // the POST and annotates the race, so a displaced commit is traceable.
    expect(
      (
        String(rerun.steps[0].run).match(
          /actions\/workflows\/\$\{WORKFLOW_ID\}\/runs\?branch=main/g,
        ) ?? []
      ).length,
    ).toBe(2);
    expect(String(rerun.steps[0].run)).toMatch(
      /gh api -X POST[\s\S]*?::warning::/,
    );
    expect(rerun.steps[0].env.WORKFLOW_RUN_URL).toBe(
      '${{ github.event.workflow_run.html_url }}',
    );
    // The one decision in the workflow that suppresses a filing must announce
    // itself — once the re-run absorbs the flake, the notice and the step
    // summary are the only record the suppression ever happened.
    expect(String(rerun.steps[0].run)).toContain('::notice::');
    expect(String(rerun.steps[0].run)).toContain('GITHUB_STEP_SUMMARY');
    // The step holds TWO notice/summary pairs, so the load-bearing pins are
    // scoped to their branch: the superseded branch's copy must not satisfy
    // the absorbed-flake branch's pin.
    const branchOf = (marker) =>
      String(rerun.steps[0].run).match(
        new RegExp(
          `if \\[\\[ "\\$\\{${marker}\\}"[^;]*; then(?<block>[\\s\\S]*?)\\n\\s*fi`,
        ),
      )?.groups?.block;
    const supersededBlock = branchOf('superseded');
    expect(supersededBlock).toBeDefined();
    expect(supersededBlock).toContain('::notice::');
    expect(supersededBlock).toContain('GITHUB_STEP_SUMMARY');
    expect(supersededBlock).toContain('exit 0');
    const successBlock = branchOf('conclusion');
    expect(successBlock).toBeDefined();
    expect(successBlock).toContain('::notice::');
    expect(successBlock).toContain('GITHUB_STEP_SUMMARY');
    expect(successBlock).toContain('exit 0');

    // A re-run re-enters the watched workflow's concurrency group as the
    // newest pending entry, and GitHub keeps at most one pending run per
    // group (e2e.yml): the attempt would cancel a NEWER main run waiting
    // there, and that run's `cancelled` conclusion never reaches analyze's
    // failure gate — main's newest tree would drop with no record anywhere.
    // The supersession check is pinned ordered BEFORE the POST: deleting the
    // check, its `exit 0`, or moving it below the POST must red this test.
    const rerunRun = String(rerun.steps[0].run);
    expect(rerun.steps[0].env.WORKFLOW_ID).toBe(
      '${{ github.event.workflow_run.workflow_id }}',
    );
    expect(rerun.steps[0].env.WORKFLOW_RUN_CREATED_AT).toBe(
      '${{ github.event.workflow_run.created_at }}',
    );
    expect(rerunRun).toContain(
      'gh api "repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?branch=main&per_page=10"',
    );
    expect(rerunRun).toContain(
      'echo \'superseded=true\' >> "${GITHUB_OUTPUT}"',
    );
    expect(rerunRun).toMatch(
      /if \[\[ "\$\{superseded\}" != "0" \]\]; then[\s\S]*?exit 0\n[\s\S]*?fi\n[\s\S]*?gh api -X POST/,
    );
    // The predicate counts only a run this re-run could actually DISPLACE:
    // one still queued in the same event-scoped concurrency group (e2e.yml
    // keys the group on workflow + event + ref). Counting any newer run
    // whatever its status or event suppressed the re-run in the large
    // majority of cases — measured over 1012 real main runs, 98 of 102
    // suppressions had no pending suppressor at all — so removing either
    // term must red this pin. `.event` is the runs-API field (as
    // qwen-autofix.yml reads it); the context name event_name does not exist
    // in the payload and would silently disable the guard.
    expect(rerun.steps[0].env.WORKFLOW_RUN_EVENT).toBe(
      '${{ github.event.workflow_run.event }}',
    );
    expect(rerunRun).toContain('--arg event "${WORKFLOW_RUN_EVENT}"');
    expect(rerunRun).toContain('.status == "queued"');
    expect(rerunRun).toContain('.event == $event');
    // …and the predicate pinned as ONE conjunction: an `and` -> `or` flip, a
    // dropped recency term, or a dropped binding each leave the term pins
    // green while inverting what the guard counts.
    expect(rerunRun).toContain('--arg created "${WORKFLOW_RUN_CREATED_AT}"');
    expect(rerunRun).toContain(
      'select((.id | tostring) != $id and .created_at > $created and .status == "queued" and .event == $event)',
    );
    // A skipped-as-superseded re-run must still file the fleet issue (the
    // failure is real; only the re-run would be harmful), so the skip rides
    // an output file_issue's gate admits.
    expect(rerun.outputs.superseded).toBe(
      '${{ steps.rerun.outputs.superseded }}',
    );

    // The suppression is keyed on the re-run's OBSERVED outcome, never on the
    // request: a re-run cancelled before it starts (the next merge takes the
    // group's single pending slot) never passes analyze's failure-only gate,
    // so request-keyed suppression dropped main's failure with no record
    // (measured: 455 of 458 cancelled E2E main runs raised a watcher that
    // concluded skipped). The poll must sit AFTER the POST and gate the
    // suppression on the observed conclusion; deleting the poll and exiting 0
    // right after the POST reds all three pins. timeout-minutes sits above
    // the 90x30s (~45min) poll loop so the loop's own error, not the
    // platform's, is the bound.
    expect(rerunRun).toMatch(
      /gh api -X POST[\s\S]*?run_attempt[\s\S]*?conclusion/,
    );
    expect(rerunRun).toMatch(
      /if \[\[ "\$\{conclusion\}" == 'success' \]\]; then/,
    );
    expect(Number(rerun['timeout-minutes'])).toBeGreaterThanOrEqual(45);
    // The break must read attempt 2's record, not attempt 1's: the first
    // poll runs right after the POST, and `-ge 1` would report the
    // already-completed first attempt as the re-run's outcome.
    expect(rerunRun).toContain(
      '"${attempt}" -ge 2 && "${status}" == \'completed\'',
    );
    // The poll's total wait derives from the script, not a hardcoded guess:
    // widening the loop past the job's ceiling lets the platform kill it
    // mid-poll; shrinking either turns the absorb path into always-file.
    const iterations = Number(rerunRun.match(/seq 1 (\d+)/)?.[1]);
    const sleepSeconds = Number(rerunRun.match(/sleep (\d+)/)?.[1]);
    expect(iterations * sleepSeconds).toBeGreaterThanOrEqual(45 * 60);
    expect(iterations * sleepSeconds).toBeLessThan(
      Number(rerun['timeout-minutes']) * 60,
    );
    // The fail-closed tail is the behaviour the design rests on: with
    // `exit 0` the job reads success and file_issue is skipped, silently
    // dropping a main failure whose re-run did not pass.
    expect(rerunRun.trimEnd().endsWith('exit 1')).toBe(true);

    // file_issue files unless the re-run actually started: a skipped rerun
    // job (ordinary failure with steps) and a failed one (the API call
    // errored) both fall through to the normal issue path.
    expect(String(jobs.file_issue.if)).toContain(
      "needs.analyze.result == 'success'",
    );
    expect(String(jobs.file_issue.if)).toContain(
      "needs.rerun_never_started.result != 'success'",
    );
    // always() is the token that makes the two pins above reachable: without
    // a status check function Actions implicitly prepends success() to the
    // expression, and a skipped rerun job is not a success, so file_issue
    // would be skipped — on every ordinary failure and every attempt-2
    // recurrence — before the condition is ever evaluated.
    expect(String(jobs.file_issue.if)).toContain('always()');

    // A never-started run that files anyway either recurred after its
    // re-run or could not even be re-run — either way the issue records a
    // fleet failure for a human rather than pitching the agent a repair no
    // commit can make. The decision stays in analyze and crosses
    // over as a plain string; file_issue only gates the route on it — no new
    // checkout, helper call, or scope for the job holding the bot PAT.
    expect(jobs.file_issue.steps[0].env.STAND_DOWN).toBe(
      '${{ needs.analyze.outputs.stand_down }}',
    );
    expect(String(jobs.file_issue.if)).toContain(
      "needs.rerun_never_started.outputs.superseded == 'true'",
    );
    const routeRun = String(jobs.file_issue.steps[0].run);
    expect(routeRun).toContain('if [[ "${STAND_DOWN}" == \'true\' ]]; then');
    // The guard must actually short-circuit the route, not just name its
    // condition: the block — echo, label correction, `return 0` — sits
    // BEFORE the route's edit call, so deleting `return 0` or moving the
    // guard below the route call reds this pin.
    expect(routeRun).toMatch(
      /if \[\[ "\$\{STAND_DOWN\}" == 'true' \]\]; then[\s\S]*?return 0[\s\S]*?\n\s+fi\n[\s\S]*?gh issue edit "\$1"/,
    );
    // ...and the fleet branch keeps the issue human-findable WITHOUT
    // borrowing the human-owned opt-out: it adds type/bug alone and strips
    // ALL route state — both autofix intake gates key on ready-for-agent +
    // approved (the scan's label filter, the real-time route's two flags),
    // and in-progress is the agent's claim marker the same gates reject — so
    // a same-commit issue an ordinary failure already routed, or one the
    // agent had already claimed, comes fully back off the route.
    // autofix/skip is deliberately never referenced anywhere in this step:
    // the ordinary branch below only ever ADDS labels, so a machine-applied
    // skip would survive a class flip and veto a real regression at every
    // intake gate with no code path left to clear it.
    expect(jobs.file_issue.steps[0].env.AUTOFIX_IN_PROGRESS_LABEL).toBe(
      'autofix/in-progress',
    );
    expect(jobs.file_issue.steps[0].env.AUTOFIX_SKIP_LABEL).toBeUndefined();
    const guard = routeRun.match(
      /if \[\[ "\$\{STAND_DOWN\}" == 'true' \]\]; then(?<block>[\s\S]*?)\n\s+fi/,
    )?.groups?.block;
    expect(guard).toBeDefined();
    expect(guard).toContain('--add-label "${BUG_LABEL}"');
    expect(guard).toContain(
      '--remove-label "${READY_FOR_AGENT_LABEL},${AUTOFIX_APPROVED_LABEL},${AUTOFIX_IN_PROGRESS_LABEL}"',
    );
    expect(guard).toContain('--remove-assignee "${AUTOFIX_BOT}"');
    expect(guard).not.toContain('--add-label "${AUTOFIX_APPROVED_LABEL}"');
    expect(routeRun).not.toContain('AUTOFIX_SKIP_LABEL');
  });

  it('re-reads an existing issue so recorded recurrences survive the update', () => {
    expect(workflow).toContain('gh issue view "${existing_issue}"');
    expect(workflow).toContain('--existing "${existing_body}"');
    // The update also re-sets the title: the per-commit dedupe key is the sha
    // alone and every watched workflow runs on the same main commit, so the
    // existing issue can belong to the OTHER failure class of this commit —
    // the body is re-rendered for the current class and the title must
    // follow it, or the issue keeps the first filer's workflow name over
    // prose describing another failure. The pin is scoped to the branch: the
    // step's later `gh issue create` carries the same two tokens in the same
    // order, so a whole-script pin stays green when the EDIT call loses them.
    // The branch's closing `fi` sits at column 0 in the parsed block scalar.
    const routeRun = String(jobs.file_issue.steps[0].run);
    expect(routeRun).toMatch(
      /gh issue edit "\$\{EXISTING_ISSUE\}"[\s\S]*?--title "\$\{ISSUE_TITLE\}"[\s\S]*?--body-file "\$\{body_file\}"/,
    );
    const existingBranch = routeRun.match(
      /if \[\[ -n "\$\{EXISTING_ISSUE\}" \]\]; then(?<branch>[\s\S]*?)\nfi/,
    )?.groups?.branch;
    expect(existingBranch).toBeDefined();
    expect(existingBranch).toContain('gh issue edit "${EXISTING_ISSUE}"');
    expect(existingBranch).toContain('--title "${ISSUE_TITLE}"');
    expect(existingBranch).toContain('--body-file "${body_file}"');
  });

  it('re-runs the dedupe lookup right before creating, after the re-run poll', () => {
    // analyze's EXISTING_ISSUE snapshot predates rerun_never_started's poll
    // (up to ~45 minutes), so a second watcher on the same commit can file
    // first; without a fresh lookup the commit's record splits across two
    // issues and the cross-class merge never runs.
    expect(jobs.file_issue.steps[0].env.SEARCH_MARKER).toBe(
      '${{ needs.analyze.outputs.search_marker }}',
    );
    const routeRun = String(jobs.file_issue.steps[0].run);
    const lookup = routeRun.match(
      /if \[\[ -z "\$\{EXISTING_ISSUE\}" \]\]; then(?<branch>[\s\S]*?)\nfi/,
    )?.groups?.branch;
    expect(lookup).toBeDefined();
    expect(lookup).toContain('gh issue list');
    expect(lookup).toContain('--search "${SEARCH_MARKER} in:body"');
    // The fresh lookup feeds the same EXISTING_ISSUE the update branch reads
    // and must precede the create call.
    expect(routeRun.indexOf('if [[ -z "${EXISTING_ISSUE}" ]]')).toBeLessThan(
      routeRun.indexOf('gh issue create'),
    );
  });

  it('uses a random heredoc delimiter for the multiline body output', () => {
    // A constant delimiter lets issue-body prose (which the autofix agent
    // writes into) end the heredoc early and inject fresh GITHUB_OUTPUT keys.
    expect(workflow).toContain('openssl rand -hex 16');
    expect(workflow).toContain('echo "body<<${delim}"');
    expect(workflow).toContain('echo "${delim}"');
    expect(workflow).not.toContain('body<<QWEN_MAIN_CI_FAILURE_BODY\n');
  });

  const privilegedJobs = Object.entries(jobs).filter(([, job]) =>
    JSON.stringify(job).includes('CI_DEV_BOT_PAT'),
  );

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
    // Reading job logs needs `actions: read`; nothing here needs write.
    expect(analyze.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      issues: 'read',
    });
    expect(privilegedJobs[0][1].needs).toEqual([
      'analyze',
      'rerun_never_started',
    ]);
  });
});
