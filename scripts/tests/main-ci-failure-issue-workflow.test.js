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
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

  it('opens an autofix-ready issue only for failed main CI runs', () => {
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
    // Push stays admitted unscoped: it covers ci.yml's own post-merge lane
    // on `main` (restored so main's squash commits carry Test check-runs)
    // and any other watched workflow's push run. The schedule arm is
    // name-scoped, and #14205 widened that scope from 'Qwen Code CI' alone
    // to the three workflows whose only main trigger is now a schedule — the
    // platform lanes' nightly plus the daily SDK Java and Desktop checks: a
    // red run of any of them files an issue here. A pull-request run of a
    // watched workflow must never open an issue — that is
    // contributor-triggered, and the branch filter plus this clause are what
    // keep it out. Pin the whole condition: #14205 wrapped it across lines,
    // and pinning its spans one by one let an appended `|| true` admit every
    // event — pull requests included — while each span still matched. The
    // `>-` scalar is already folded by the parser, so compare it as parsed:
    // collapsing whitespace here would also collapse it inside the fromJSON
    // name literals, which GitHub's contains() matches byte for byte.
    expect(jobs.analyze.if).toBe(
      "${{ github.repository == 'QwenLM/qwen-code' && " +
        "github.event.workflow_run.conclusion == 'failure' && " +
        "github.event.workflow_run.head_branch == 'main' && " +
        "(github.event.workflow_run.event == 'push' || " +
        "(github.event.workflow_run.event == 'schedule' && " +
        'contains(fromJSON(\'["Qwen Code CI","SDK Java","Desktop Checks"]\'), github.event.workflow.name))) }}',
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
    expect(workflow).not.toContain(
      "github.event.workflow_run.event == 'pull_request'",
    );
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

    it('fails closed without evidence and never reruns later attempts', () => {
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
      // An errored annotations fetch must never abort or fabricate a match;
      // the log fallback still needs independent evidence.
      expect(infraScript).toContain(
        '--jq \'[.[].message] | join("\\n")\' 2>/dev/null || true',
      );
    });

    it('reads failed-step logs through gh in the read-only analyze job', () => {
      expect(infraScript).toContain(
        'gh run view --repo "${REPO}" --job "${job_id}" --log-failed',
      );
      expect(infraScript).toContain('maven-transfer-failure.mjs');
      expect(JSON.stringify(rerunJob)).not.toContain(
        'maven-transfer-failure.mjs',
      );
    });

    // The gate workflow's reporter job is always() and fails with only the
    // tier-result error — no infrastructure signature — so without the
    // exclusion pinned above every Managed Agent gate lane failure counted
    // as an unclassified job and an infra-killed lane filed an issue instead
    // of rerunning. These cases run the step body against fixture job lists.
    const failedJob = (id, checkId, steps) => ({
      id,
      name: `Java job ${id}`,
      conclusion: 'failure',
      check_run_url: `https://api.github.com/repos/QwenLM/qwen-code/check-runs/${checkId}`,
      steps: steps.map((step, index) => ({ number: index + 1, ...step })),
    });
    const REPORTER_STEP = 'Report the tier result';
    const reporterJob = (id, checkId) =>
      failedJob(id, checkId, [
        { name: 'Set up job', conclusion: 'success' },
        { name: REPORTER_STEP, conclusion: 'failure' },
        { name: 'Complete job', conclusion: 'success' },
      ]);
    const classify = (jobs, annotations, { logs = {}, attempt = 1 } = {}) => {
      const tmp = mkdtempSync(join(tmpdir(), 'infra-classify-'));
      try {
        const bin = join(tmp, 'bin');
        mkdirSync(bin);
        writeFileSync(
          join(bin, 'gh'),
          [
            '#!/usr/bin/env bash',
            'if [[ "$1" == api ]]; then',
            '  id="$(printf \'%s \' "$@" | grep -oE \'check-runs/[0-9]+\' | cut -d/ -f2)"',
            '  cat "${ANN_DIR}/${id}.txt" 2>/dev/null',
            'elif [[ "$1" == run && "$2" == view ]]; then',
            '  shift 2',
            '  while [[ "$#" -gt 0 ]]; do',
            '    case "$1" in',
            '      --repo) repo="$2"; shift 2 ;;',
            '      --job) id="$2"; shift 2 ;;',
            '      --log-failed) failed=true; shift ;;',
            '      *) exit 64 ;;',
            '    esac',
            '  done',
            '  [[ "$repo" == QwenLM/qwen-code && "$failed" == true ]] || exit 64',
            '  cat "${LOG_DIR}/${id}.txt" 2>/dev/null || exit 1',
            '  exit "$(cat "${LOG_DIR}/${id}.status")"',
            'else',
            '  exit 64',
            'fi',
          ].join('\n'),
        );
        chmodSync(join(bin, 'gh'), 0o755);
        const annDir = join(tmp, 'annotations');
        mkdirSync(annDir);
        for (const [id, message] of Object.entries(annotations)) {
          writeFileSync(join(annDir, `${id}.txt`), message);
        }
        const logDir = join(tmp, 'logs');
        mkdirSync(logDir);
        for (const [id, log] of Object.entries(logs)) {
          writeFileSync(
            join(logDir, `${id}.txt`),
            typeof log === 'string' ? log : log.stdout,
          );
          writeFileSync(
            join(logDir, `${id}.status`),
            String(typeof log === 'string' ? 0 : log.exitCode),
          );
        }
        writeFileSync(join(tmp, 'run-jobs.json'), JSON.stringify({ jobs }));
        const output = join(tmp, 'output');
        writeFileSync(output, '');
        const result = spawnSync('bash', ['-c', infraStep.run], {
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            RUNNER_TEMP: tmp,
            RUN_ATTEMPT: String(attempt),
            REPO: 'QwenLM/qwen-code',
            GH_TOKEN: 'fake',
            INFRA_FAILURE_SIGNATURES: infraStep.env.INFRA_FAILURE_SIGNATURES,
            ANN_DIR: annDir,
            LOG_DIR: logDir,
            GITHUB_OUTPUT: output,
          },
          encoding: 'utf8',
        });
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

    const mavenFailure = (reason = 'status: 503 Service Unavailable') => [
      '[INFO] Scanning for projects...',
      '[INFO] Building infra-probe 1.0',
      '[INFO] ------------------------------------------------------------------------',
      '[INFO] BUILD FAILURE',
      '[INFO] ------------------------------------------------------------------------',
      '[INFO] Total time:  0.118 s',
      '[INFO] Finished at: 2026-10-17T15:34:20Z',
      '[INFO] ------------------------------------------------------------------------',
      '[ERROR] Plugin org.apache.maven.plugins:maven-resources-plugin:2.6 or one of its dependencies could not be resolved: Failed to read artifact descriptor for org.apache.maven.plugins:maven-resources-plugin:jar:2.6: Could not transfer artifact org.apache.maven.plugins:maven-resources-plugin:pom:2.6 from/to central (https://repo.maven.apache.org/maven2/): transfer failed for https://repo.maven.apache.org/maven2/org/apache/maven/plugins/maven-resources-plugin/2.6/maven-resources-plugin-2.6.pom, ' +
        reason +
        ' -> [Help 1]',
      '[ERROR]',
      '[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.',
      '[ERROR] Re-run Maven using the -X switch to enable full debug logging.',
      '[ERROR]',
      '[ERROR] For more information about the errors and possible solutions, please read the following articles:',
      '[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/PluginResolutionException',
      '##[error]Process completed with exit code 1.',
    ];
    const javaJob = () =>
      failedJob(1001, 9001, [
        { name: 'Set up job', conclusion: 'success' },
        { name: 'Compile Java', conclusion: 'failure' },
        { name: 'Complete job', conclusion: 'success' },
      ]);
    const stepLog = (job, stepName, lines) =>
      lines
        .map(
          (line) =>
            `${job.name}\t${stepName}\t2026-10-17T15:34:20.0000000Z ${line}`,
        )
        .join('\n') + '\n';
    const genericAnnotation = { 9001: 'Process completed with exit code 1.' };

    it.each([
      'status: 502 Bad Gateway',
      'status: 503 Service Unavailable',
      'status: 504 Gateway Timeout',
      'Read timed out',
      'Connection timed out',
      'Connection reset',
    ])('reruns terminal Maven artifact transfer failures: %s', (reason) => {
      const job = javaJob();
      expect(
        classify([job], genericAnnotation, {
          logs: { 1001: stepLog(job, 'Compile Java', mavenFailure(reason)) },
        }),
      ).toContain('infra_only=true');
    });

    it('still accepts Maven evidence when the annotation read fails', () => {
      const job = javaJob();
      expect(
        classify(
          [job],
          {},
          {
            logs: { 1001: stepLog(job, 'Compile Java', mavenFailure()) },
          },
        ),
      ).toContain('infra_only=true');
    });

    it.each([false, true])(
      'checks whole-job BOM logs against step time boundaries (overlap: %s)',
      (overlap) => {
        const job = javaJob();
        const intervals = [
          ['00', '01'],
          ['02', '20'],
          [overlap ? '20' : '21', '22'],
        ];
        job.steps.forEach((step, index) => {
          step.started_at = `2026-10-17T15:34:${intervals[index][0]}Z`;
          step.completed_at = `2026-10-17T15:34:${intervals[index][1]}Z`;
        });
        const log = [
          stepLog(job, 'UNKNOWN STEP', ['Preparing job']).replaceAll(
            '15:34:20.',
            '15:34:00.',
          ),
          stepLog(job, 'UNKNOWN STEP', mavenFailure()),
          stepLog(job, 'UNKNOWN STEP', ['Post job cleanup.']).replaceAll(
            '15:34:20.',
            '15:34:21.',
          ),
        ]
          .join('')
          .replaceAll('\t2026-', '\t\uFEFF2026-');
        expect(
          classify([job], genericAnnotation, { logs: { 1001: log } }),
        ).toContain(`infra_only=${!overlap}`);
      },
    );

    it.each([
      'status: 401 Unauthorized',
      'status: 403 Forbidden',
      'status: 404 Not Found',
      'status: 429 Too Many Requests',
      'Could not find artifact org.example:missing:jar:1.0 in central',
    ])('files non-transient Maven failures: %s', (reason) => {
      const job = javaJob();
      expect(
        classify([job], genericAnnotation, {
          logs: { 1001: stepLog(job, 'Compile Java', mavenFailure(reason)) },
        }),
      ).toContain('infra_only=false');
    });

    it.each([
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.14.0:compile (default-compile) on project example: Compilation failure: cannot find symbol -> [Help 1]',
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.5.3:test (default-test) on project example: There are test failures. -> [Help 1]',
    ])('files when a later Maven error is a code failure: %s', (error) => {
      const job = javaJob();
      const lines = mavenFailure();
      lines.splice(-1, 0, error);
      expect(
        classify([job], genericAnnotation, {
          logs: { 1001: stepLog(job, 'Compile Java', lines) },
        }),
      ).toContain('infra_only=false');
    });

    it('does not let a recovered transfer error hide a later shell failure', () => {
      const job = javaJob();
      const lines = mavenFailure().slice(0, -1);
      lines.push(
        '[INFO] BUILD SUCCESS',
        'Schema verification failed',
        '##[error]Process completed with exit code 1.',
      );
      expect(
        classify([job], genericAnnotation, {
          logs: { 1001: stepLog(job, 'Compile Java', lines) },
        }),
      ).toContain('infra_only=false');
    });

    it('does not use a successful step network error to explain the failed step', () => {
      const job = javaJob();
      job.steps = [
        { name: 'Set up job', conclusion: 'success' },
        { name: 'Warm Maven cache', conclusion: 'success' },
        { name: 'Compile Java', conclusion: 'failure' },
        { name: 'Complete job', conclusion: 'success' },
      ].map((step, index) => ({ number: index + 1, ...step }));
      const logs =
        stepLog(job, 'Warm Maven cache', mavenFailure()) +
        stepLog(job, 'Compile Java', [
          '[ERROR] COMPILATION ERROR :',
          '[ERROR] cannot find symbol',
          '##[error]Process completed with exit code 1.',
        ]);
      expect(
        classify([job], genericAnnotation, { logs: { 1001: logs } }),
      ).toContain('infra_only=false');
    });

    it('requires every failed step of a job to be a Maven transfer failure', () => {
      const job = javaJob();
      job.steps.push({ number: 4, name: 'Run tests', conclusion: 'failure' });
      const logs =
        stepLog(job, 'Compile Java', mavenFailure()) +
        stepLog(job, 'Run tests', [
          'AssertionError: expected the daemon to answer',
          '##[error]Process completed with exit code 1.',
        ]);
      expect(
        classify([job], genericAnnotation, { logs: { 1001: logs } }),
      ).toContain('infra_only=false');
    });

    it('reruns when every failed step has its own terminal Maven evidence', () => {
      const job = javaJob();
      job.steps.push({ number: 4, name: 'Compile SDK', conclusion: 'failure' });
      const logs =
        stepLog(job, 'Compile Java', mavenFailure()) +
        stepLog(job, 'Compile SDK', mavenFailure('Read timed out'));
      expect(
        classify([job], genericAnnotation, { logs: { 1001: logs } }),
      ).toContain('infra_only=true');
    });

    it('does not hide a different job failure behind a Maven infrastructure job', () => {
      const job = javaJob();
      const other = failedJob(1002, 9002, [
        { name: 'Run tests', conclusion: 'failure' },
      ]);
      expect(
        classify(
          [job, other],
          { ...genericAnnotation, 9002: 'AssertionError' },
          { logs: { 1001: stepLog(job, 'Compile Java', mavenFailure()) } },
        ),
      ).toContain('infra_only=false');
    });

    it.each(['missing', 'unknown-step', 'failed-command', 'missing-step-log'])(
      'files when grouped log evidence is unavailable: %s',
      (scenario) => {
        const job = javaJob();
        const log = stepLog(job, 'Compile Java', mavenFailure());
        let logs = {};
        if (scenario === 'unknown-step') {
          logs = { 1001: stepLog(job, 'UNKNOWN STEP', mavenFailure()) };
        } else if (scenario === 'failed-command') {
          logs = { 1001: { stdout: log, exitCode: 1 } };
        } else if (scenario === 'missing-step-log') {
          job.steps.push({
            number: 4,
            name: 'Compile SDK',
            conclusion: 'failure',
          });
          logs = { 1001: log };
        }
        expect(classify([job], genericAnnotation, { logs })).toContain(
          'infra_only=false',
        );
      },
    );

    it('files on the second attempt even with terminal Maven evidence', () => {
      const job = javaJob();
      expect(
        classify([job], genericAnnotation, {
          attempt: 2,
          logs: { 1001: stepLog(job, 'Compile Java', mavenFailure()) },
        }),
      ).toContain('infra_only=false');
    });

    it('files an empty failure list even when a log contains a transfer failure', () => {
      const job = javaJob();
      expect(
        classify([], genericAnnotation, {
          logs: { 1001: stepLog(job, 'Compile Java', mavenFailure()) },
        }),
      ).toContain('infra_only=false');
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
      expect(condition).toContain("needs.analyze.outputs.infra_only != 'true'");
      // A rerun that could not be dispatched must not swallow the report:
      // the issue is then the only record of a red main.
      expect(condition).toContain("needs.rerun_infra.result != 'success'");
    });
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
    // Reading job logs needs `actions: read`; the infrastructure detector
    // reads check-run annotations, which are gated behind `checks: read`.
    // Nothing here needs write.
    expect(analyze.permissions).toEqual({
      actions: 'read',
      checks: 'read',
      contents: 'read',
      issues: 'read',
    });
    expect(privilegedJobs[0][1].needs).toEqual(['analyze', 'rerun_infra']);
  });
});
