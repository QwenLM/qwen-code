/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
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
    // 'SDK Java' joined for its post-merge push run: its path filter watches
    // the SDK's embedding surfaces too, so it fires on roughly half of recent
    // merges to main — and a red push run is the only signal for a merge
    // result neither PR could fail: the duplicate-V16 Flyway collision of
    // #12940 sat unnoticed for two hours without it.
    expect(workflow).toContain(
      "workflows: ['E2E Tests', 'SDK Java', 'SDK Python', 'Qwen Code CI']",
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
        'jq -r \'.jobs[] | select(.conclusion == "failure") | [(.id | tostring), ((.check_run_url // "") | split("/")[-1])] | @tsv\'',
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
      // never abort the step or fabricate a match: the fetch rides the `if`
      // condition so its exit status survives, and the silent `|| true` form
      // — which made a 403 indistinguishable from a signature-free job —
      // must not come back.
      expect(infraScript).toContain(
        'if [[ -n "${check_run_id}" ]] && annotations="$( gh api --paginate "repos/${REPO}/check-runs/${check_run_id}/annotations" --jq \'[.[].message] | join("\\n")\' 2>/dev/null )"; then',
      );
      expect(infraScript).not.toContain('2>/dev/null || true');
      // A read that never happened (or failed) must not print the "no
      // infrastructure annotation" line — that claim is reserved for a fetch
      // that actually succeeded, which is what the read_ok branch expresses.
      expect(infraScript).toContain(
        '::warning::Could not read the annotations of failed job ${job_id}',
      );
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
      // The suppression's durable record: without it a chronic pool
      // degradation leaves zero queryable trace (the run_attempt bump is
      // indistinguishable from a manual rerun), and a silently-dead lane
      // stays green. The record needs no scope beyond actions:write — the
      // permissions pin above is exact-equality, so anything heavier fails
      // there first.
      expect(oneLine(rerunJob.steps[0].run)).toContain('GITHUB_STEP_SUMMARY');
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

    // The pins above see the classifier's TEXT, not its behaviour: a loop
    // body moved into a pipeline subshell, a deleted `infra_only=true`, or a
    // producer/consumer rename of run-jobs.json each leave every pin green
    // while the verdict goes dead. So the step bodies are executed verbatim
    // against a stubbed gh (the qwen-autofix-workflow.test.js idiom), with
    // the jobs fixture written at the path the PRODUCER step declares so the
    // cross-step handoff is pinned too. The step needs bash AND jq, so gate
    // on a capability probe rather than process.platform — gating on the
    // platform would force this whole file into the win32 exclude and cost
    // the pure-YAML pins their Windows coverage.
    const canExecute =
      spawnSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }).status ===
      0;
    const execute = canExecute ? describe : describe.skip;

    execute('the classifier step, executed under a stubbed gh', () => {
      const INFRA_MESSAGE =
        'The self-hosted runner lost communication with the server.';
      const CODE_MESSAGE = 'a real test failed: expected 1 to be 2';

      const failedJob = (id, checkRunId) => ({
        id,
        conclusion: 'failure',
        ...(checkRunId === undefined
          ? {}
          : {
              check_run_url: `https://api.github.com/repos/o/r/check-runs/${checkRunId}`,
            }),
      });

      const runClassifier = ({
        jobs: jobList = [],
        annotations = {},
        attempt = '1',
        jobsPayload,
      }) => {
        const dir = mkdtempSync(join(tmpdir(), 'infra-step-'));
        try {
          const bin = join(dir, 'bin');
          mkdirSync(bin);
          const callsLog = join(dir, 'calls.log');
          // The stub answers the annotations fetch per check-run id (a null
          // entry fails the way a 403 does) and records every call; anything
          // else exits 0 silently.
          const arms = Object.entries(annotations).map(([id, message]) =>
            message === null
              ? `  *"/check-runs/${id}/annotations"*) exit 1;;`
              : `  *"/check-runs/${id}/annotations"*) printf '%s' ${JSON.stringify(message)}; exit 0;;`,
          );
          writeFileSync(
            join(bin, 'gh'),
            [
              '#!/usr/bin/env bash',
              `echo "$*" >> ${JSON.stringify(callsLog)}`,
              'args="$*"',
              'case "$args" in',
              ...arms,
              'esac',
              'exit 0',
            ].join('\n'),
          );
          chmodSync(join(bin, 'gh'), 0o755);

          const runnerTemp = join(dir, 'runner-temp');
          mkdirSync(runnerTemp);
          // The fixture lands at the path the producer step declares, so a
          // one-sided rename of run-jobs.json on either side turns the
          // all-infra case red instead of silently reading an empty list.
          const download = jobs.analyze.steps.find(
            (step) => step.name === 'Download failed job logs',
          ).run;
          const jobsFile = download.match(
            /jobs_json="\$\{RUNNER_TEMP\}\/([^"]+)"/,
          )?.[1];
          expect(
            jobsFile,
            'the producer step declares the jobs payload path',
          ).toBeTruthy();
          writeFileSync(
            join(runnerTemp, jobsFile),
            jobsPayload ?? JSON.stringify({ jobs: jobList }),
          );

          const outputFile = join(dir, 'github-output');
          writeFileSync(outputFile, '');
          let status = 0;
          let stdout = '';
          try {
            stdout = execFileSync(
              'bash',
              ['-c', `set -eo pipefail\n${infraStep.run}`],
              {
                env: {
                  PATH: `${bin}:${process.env.PATH}`,
                  GH_TOKEN: 'stub',
                  REPO: 'o/r',
                  RUN_ATTEMPT: String(attempt),
                  INFRA_FAILURE_SIGNATURES:
                    infraStep.env.INFRA_FAILURE_SIGNATURES,
                  RUNNER_TEMP: runnerTemp,
                  GITHUB_OUTPUT: outputFile,
                },
                encoding: 'utf8',
              },
            );
          } catch (error) {
            status = error.status ?? 1;
            stdout = error.stdout ?? '';
          }
          const output = readFileSync(outputFile, 'utf8');
          const calls = existsSync(callsLog)
            ? readFileSync(callsLog, 'utf8')
            : '';
          return { status, stdout, output, calls };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };

      it('reruns when every failed job died on infrastructure (attempt 1)', () => {
        const result = runClassifier({
          jobs: [
            failedJob(101, 9001),
            failedJob(102, 9002),
            { id: 103, conclusion: 'success' },
          ],
          annotations: { 9001: INFRA_MESSAGE, 9002: 'No space left on device' },
        });
        expect(result.status).toBe(0);
        expect(result.output).toContain('infra_only=true');
        // One annotations fetch per failed job — the green job's check run
        // is never queried.
        expect(result.calls.trim().split('\n')).toHaveLength(2);
      });

      it('files when a real failure stands beside an infrastructure one', () => {
        const result = runClassifier({
          jobs: [failedJob(101, 9001), failedJob(102, 9002)],
          annotations: { 9001: INFRA_MESSAGE, 9002: CODE_MESSAGE },
        });
        expect(result.status).toBe(0);
        expect(result.output).toContain('infra_only=false');
        expect(result.stdout).toContain(
          'Failed job 102 carries no infrastructure annotation; the run gets an issue.',
        );
      });

      it('files on the second attempt without reading any annotation', () => {
        // The attempt guard is the rerun-loop breaker: a persistent break
        // re-fails the rerun and must file on that second pass.
        const result = runClassifier({
          jobs: [failedJob(101, 9001)],
          annotations: { 9001: INFRA_MESSAGE },
          attempt: '2',
        });
        expect(result.status).toBe(0);
        expect(result.output).toContain('infra_only=false');
        expect(result.calls).toBe('');
      });

      it('files when the failed-job list is empty or unreadable', () => {
        for (const jobsPayload of [
          JSON.stringify({ jobs: [] }),
          '{"message":"Not Found"}',
        ]) {
          const result = runClassifier({ jobsPayload });
          expect(result.status).toBe(0);
          expect(result.output).toContain('infra_only=false');
        }
      });

      it('warns and files when the annotations fetch fails', () => {
        // A 403 and a signature-free job must read differently in the log:
        // here the read never succeeded, so the log says so — and the
        // verdict still fails closed.
        const result = runClassifier({
          jobs: [failedJob(101, 9001)],
          annotations: { 9001: null },
        });
        expect(result.status).toBe(0);
        expect(result.output).toContain('infra_only=false');
        expect(result.stdout).toContain(
          '::warning::Could not read the annotations of failed job 101; treating it as a code failure, so the run gets an issue.',
        );
        expect(result.stdout).not.toContain(
          'carries no infrastructure annotation',
        );
      });

      it('warns and files for a failed job with no check-run id', () => {
        const result = runClassifier({ jobs: [failedJob(101)] });
        expect(result.status).toBe(0);
        expect(result.output).toContain('infra_only=false');
        expect(result.stdout).toContain(
          '::warning::Could not read the annotations of failed job 101',
        );
        expect(result.calls).toBe('');
      });

      it('reports a genuinely signature-free read as such', () => {
        // The truthful arm of the diagnostic: the fetch succeeded and the
        // annotations carried no signature — the message a failed read must
        // not print.
        const result = runClassifier({
          jobs: [failedJob(101, 9001)],
          annotations: { 9001: CODE_MESSAGE },
        });
        expect(result.status).toBe(0);
        expect(result.output).toContain('infra_only=false');
        expect(result.stdout).toContain(
          'Failed job 101 carries no infrastructure annotation; the run gets an issue.',
        );
        expect(result.stdout).not.toContain('::warning::');
      });
    });

    execute('the rerun step, executed under a stubbed gh', () => {
      const runRerun = (dispatchOk) => {
        const dir = mkdtempSync(join(tmpdir(), 'infra-rerun-'));
        try {
          const bin = join(dir, 'bin');
          mkdirSync(bin);
          writeFileSync(
            join(bin, 'gh'),
            [
              '#!/usr/bin/env bash',
              'case "$*" in',
              `  *"rerun-failed-jobs"*) exit ${dispatchOk ? 0 : 1};;`,
              'esac',
              'exit 0',
            ].join('\n'),
          );
          chmodSync(join(bin, 'gh'), 0o755);
          const summaryFile = join(dir, 'step-summary');
          writeFileSync(summaryFile, '');
          let status = 0;
          let stdout = '';
          try {
            stdout = execFileSync(
              'bash',
              ['-c', `set -eo pipefail\n${rerunJob.steps[0].run}`],
              {
                env: {
                  PATH: `${bin}:${process.env.PATH}`,
                  GH_TOKEN: 'stub',
                  REPO: 'o/r',
                  WORKFLOW_RUN_ID: '12345',
                  GITHUB_STEP_SUMMARY: summaryFile,
                },
                encoding: 'utf8',
              },
            );
          } catch (error) {
            status = error.status ?? 1;
            stdout = error.stdout ?? '';
          }
          return {
            status,
            stdout,
            summary: readFileSync(summaryFile, 'utf8'),
          };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };

      it('records the suppression in the step summary on success', () => {
        const result = runRerun(true);
        expect(result.status).toBe(0);
        expect(result.summary).toContain(
          'Every failed job of run 12345 died on infrastructure; reran them and filed no issue.',
        );
        expect(result.stdout).toContain('::notice::');
      });

      it('still records — and still fails the step — when the rerun dispatch is refused', () => {
        // The record must not die with the step: a refused rerun is exactly
        // the run a maintainer needs to find, and the non-zero exit is what
        // lets file_issue fire (needs.rerun_infra.result != 'success').
        const result = runRerun(false);
        expect(result.status).not.toBe(0);
        expect(result.summary).toContain(
          'Run 12345 looked infrastructure-only, but dispatching the rerun failed; the run gets an issue.',
        );
        expect(result.stdout).toContain('::notice::');
      });
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
