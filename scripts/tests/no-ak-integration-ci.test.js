/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const NO_AK_SCRIPT = 'test:integration:no-ak:sandbox:none';
const INTEGRATION_TYPECHECK_SCRIPT = 'typecheck:integration';
const GUARD_ACTION_PATH = '.github/actions/verify-checkout-head/action.yml';
const CONFIGURE_ACTION_PATH =
  '.github/actions/configure-windows-runner/action.yml';
const NODE_ACTION_PATH = '.github/actions/self-hosted-node/action.yml';
const GUARD_STEP = 'Verify checkout includes expected head commit';

describe('no-AK integration CI wiring', () => {
  it.runIf(process.platform === 'linux')(
    'keeps Linux Unix socket paths short and identity-stable',
    () => {
      const workflow = readFileSync(
        path.join(ROOT, '.github/workflows/ci.yml'),
        'utf8',
      );
      const routingBlocks = ['test', 'test_macos', 'test_windows'].map(
        (jobName) => {
          const testStep = getWorkflowStep(
            getWorkflowJob(workflow, jobName),
            'Run tests and generate reports',
          );
          const start = testStep.indexOf('export TMPDIR=');
          expect(
            start,
            `${jobName}: TMPDIR routing block`,
          ).toBeGreaterThanOrEqual(0);
          const end = testStep.indexOf('\n          ( while true', start);
          expect(end, `${jobName}: sampler sentinel`).toBeGreaterThan(start);
          return testStep.slice(start, end);
        },
      );
      expect(new Set(routingBlocks)).toHaveLength(1);
      const [routeTemp] = routingBlocks;
      const root = mkdtempSync(path.join(tmpdir(), 'ci-temp-routing-'));
      const longRunnerTemp = path.join(root, 'x'.repeat(180));

      try {
        mkdirSync(longRunnerTemp);
        const [routedTemp, resolvedTemp] = execFileSync(
          'bash',
          [
            '-c',
            `${routeTemp}\nprintf '%s\\n%s\\n' "$TMPDIR" "$(cd "$TMPDIR" && pwd -P)"`,
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              RUNNER_OS: 'Linux',
              RUNNER_TEMP: longRunnerTemp,
            },
          },
        )
          .trim()
          .split('\n');

        expect(resolvedTemp).toBe(routedTemp);
        expect(routedTemp).toMatch(/^\/var\/tmp\/qwen-ci-/);
        expect(existsSync(routedTemp)).toBe(false);
        expect(
          Buffer.byteLength(
            path.join(routedTemp, 'qwen-agent-view-XXXXXX', 'supervisor.sock'),
          ),
        ).toBeLessThan(108);
        expect(
          workflow.match(/mktemp -d \/var\/tmp\/qwen-ci-XXXXXX/g),
        ).toHaveLength(3);
        expect(workflow).toContain('QWEN_CI_TMPDIR="$(mktemp -d');
        expect(workflow).toContain('if [ -n "$QWEN_CI_TMPDIR" ]; then');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('preserves test failures in every wrapped OS job', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );

    for (const jobName of ['test', 'test_macos', 'test_windows']) {
      const testStep = getWorkflowStep(
        getWorkflowJob(workflow, jobName),
        'Run tests and generate reports',
      );
      expect(testStep).toContain(
        'trap \'rm -rf "$TMPDIR" 2>/dev/null || true\' EXIT',
      );
      let previous = -1;
      for (const command of [
        'set +e',
        'npm run test:ci',
        'RC=$?',
        'set -e',
        'pkill -TERM -P "$SAMPLER_PID" 2>/dev/null || true',
        'kill "$SAMPLER_PID" 2>/dev/null || true',
        'exit "$RC"',
      ]) {
        const index = testStep.indexOf(command);
        expect(index, `${jobName}: ${command}`).toBeGreaterThan(previous);
        previous = index;
      }
    }
  });

  it('defines a focused no-AK integration script', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    );

    expect(packageJson.scripts[INTEGRATION_TYPECHECK_SCRIPT]).toBe(
      'tsc -p integration-tests/tsconfig.json --pretty false',
    );
    expect(packageJson.scripts.typecheck).toContain(
      `npm run ${INTEGRATION_TYPECHECK_SCRIPT}`,
    );
    expect(packageJson.scripts[NO_AK_SCRIPT]).toBe(
      [
        'cross-env QWEN_SANDBOX=false vitest run --root ./integration-tests --poolOptions.forks.maxForks 2',
        './fake-openai-server.test.ts',
        './test-helper.test.ts',
        './chat-transcript-contract.test.ts',
        './cli/daemon-invocation-context.test.ts',
        './cli/list_directory.test.ts',
        './cli/qwen-serve-routes.test.ts',
        './cli/qwen-serve-streaming.test.ts',
        './sdk-typescript/abort-and-lifecycle.test.ts',
        './sdk-typescript/permission-control.test.ts',
        './sdk-typescript/sdk-mcp-server.test.ts',
        './sdk-typescript/subagents.test.ts',
        './sdk-typescript/system-control.test.ts',
        './sdk-typescript/tool-control.test.ts',
      ].join(' '),
    );
  });

  it('runs the no-AK integration script as its own check on PRs and the merge queue', () => {
    // The gate ran as a step inside the Ubuntu `test` job from #8313 until
    // it moved out: a step is invisible to anything that reads check names,
    // and the PR review bot ruled from the (merge_group-only, hence skipped
    // on every PR) `Integration Tests (CLI, No Sandbox)` check that a changed
    // integration test "never ran" while this gate had executed it and
    // passed inside `test` (#9895 round 15). A check of its own carries the
    // fact in its name. The env isolation and the two-event condition are
    // the gate's contract and must survive the move unchanged.
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    const ubuntuJob = getWorkflowJob(workflow, 'test');
    const macosJob = getWorkflowJob(workflow, 'test_macos');
    const windowsJob = getWorkflowJob(workflow, 'test_windows');
    const gateJob = getWorkflowJob(workflow, 'integration_no_ak');
    const classifyJob = getWorkflowJob(workflow, 'classify_pr');
    const permissionsIndex = workflow.indexOf('\npermissions:');
    expect(permissionsIndex).toBeGreaterThan(0);
    const workflowTriggers = workflow.slice(0, permissionsIndex);
    expect(workflowTriggers).toContain('\n  pull_request:\n');
    expect(workflowTriggers).toContain('\n  merge_group:\n');

    expect(workflow.split(`npm run ${NO_AK_SCRIPT}`).length - 1).toBe(1);
    for (const [name, job] of Object.entries({
      test: ubuntuJob,
      test_macos: macosJob,
      test_windows: windowsJob,
    })) {
      expect(job, `${name} must not run the no-AK script`).not.toContain(
        NO_AK_SCRIPT,
      );
    }

    expect(gateJob).toContain(
      "    name: 'Integration Tests (no-AK, No Sandbox)'",
    );
    expect(gateJob).toContain("    needs: 'classify_pr'");
    // Same runner routing as the Ubuntu gate, never a hard-coded pool.
    expect(gateJob).toContain('needs.classify_pr.outputs.ubuntu_runner');
    const jobIf = gateJob
      .split('\n')
      .find((line) => line.startsWith('    if:'));
    expect(jobIf).toContain("needs.classify_pr.outputs.skip_ci != 'true'");
    expect(jobIf).toContain(
      "(github.event_name == 'pull_request' || github.event_name == 'merge_group')",
    );
    // PR head ref on pull_request, queue head on merge_group — the same
    // shape the Ubuntu gate uses, so this check tests the pushed tree, not
    // the lagging merge ref.
    expect(getWorkflowStep(gateJob, 'Checkout')).toContain(
      "format('refs/pull/{0}/head', github.event.pull_request.number)",
    );
    const trustedClassifierCheckout = getWorkflowStep(
      classifyJob,
      'Checkout trusted CI classifier',
    );
    expect(classifyJob).toContain(
      "ci_profile: '${{ steps.ci_profile.outputs.ci_profile }}'",
    );
    expect(trustedClassifierCheckout).toContain(
      'if: "${{ github.event_name == \'pull_request\' }}"',
    );
    expect(trustedClassifierCheckout).toContain(
      "repository: '${{ github.repository }}'",
    );
    expect(trustedClassifierCheckout).toContain(
      "ref: '${{ github.event.pull_request.base.sha }}'",
    );
    expect(trustedClassifierCheckout).toContain(
      "path: 'trusted-ci-classifier'",
    );
    expect(trustedClassifierCheckout).toContain(
      "sparse-checkout: '.github/scripts/ci'",
    );
    expect(trustedClassifierCheckout).toContain('persist-credentials: false');
    expect(trustedClassifierCheckout).not.toContain('head.sha');

    const trustedClassifier = getWorkflowStep(
      classifyJob,
      'Classify CI profile from trusted base',
    );
    expect(trustedClassifier).toContain(
      'trusted-ci-classifier/.github/scripts/ci/classify-pr-profile.sh "${GITHUB_REPOSITORY}" "${PR_NUMBER}"',
    );
    expect(trustedClassifier).toContain('docs_only|github_ci_only|full) ;;');
    expect(trustedClassifier).toContain('profile=full');
    expect(classifyJob).not.toContain('collaborators/${PR_AUTHOR}/permission');
    expect(classifyJob).not.toContain('CI_BOT_PAT');
    expect(workflow).toContain(
      '.github/scripts/update-ecs-runner-qwen-workflow.test.mjs',
    );

    // Both consumers use the profile that was already computed from the
    // base checkout. Neither may execute a classifier from the PR checkout.
    for (const profileStep of [
      getWorkflowStep(ubuntuJob, 'Use trusted CI profile'),
      getWorkflowStep(gateJob, 'Use trusted CI profile'),
    ]) {
      expect(profileStep).toContain("id: 'ci_profile'");
      expect(profileStep).toContain(
        "TRUSTED_CI_PROFILE: '${{ needs.classify_pr.outputs.ci_profile }}'",
      );
      expect(profileStep).toContain('profile="${TRUSTED_CI_PROFILE:-full}"');
      expect(profileStep).not.toContain('classify-pr-profile.sh');
      expect(profileStep).not.toContain('GH_TOKEN');
    }
    for (const stepName of [
      'Setup Node.js (hosted)',
      'Use pre-installed Node.js (self-hosted)',
      'Disk floor gate (self-hosted)',
      'Install Dependencies',
      'Run required no-AK integration gate',
    ]) {
      expect(
        getWorkflowStep(gateJob, stepName),
        `${stepName} must honour the CI profile`,
      ).toContain("steps.ci_profile.outputs.ci_profile == 'full'");
    }

    const diskFloorGate = getWorkflowStep(
      gateJob,
      'Disk floor gate (self-hosted)',
    );
    expect(diskFloorGate).toContain(
      "if: \"${{ steps.ci_profile.outputs.ci_profile == 'full' && runner.environment == 'self-hosted' }}\"",
    );
    expect(diskFloorGate).toContain(
      'run: \'bash .github/scripts/check-disk-floor.sh "${GITHUB_WORKSPACE}" "${RUNNER_TEMP:-/tmp}"\'',
    );
    expect(diskFloorGate).not.toContain('continue-on-error');
    expect(diskFloorGate).not.toContain('|| true');
    expect(diskFloorGate).not.toContain('env:');
    expect(gateJob.indexOf("id: 'ci_profile'")).toBeLessThan(
      gateJob.indexOf("name: 'Disk floor gate (self-hosted)'"),
    );
    expect(
      gateJob.indexOf("name: 'Disk floor gate (self-hosted)'"),
    ).toBeLessThan(gateJob.indexOf("name: 'Install Dependencies'"));

    const gateStep = getWorkflowStep(
      gateJob,
      'Run required no-AK integration gate',
    );
    const integrationTypecheckCommand = `npm run ${INTEGRATION_TYPECHECK_SCRIPT}`;
    expect(gateStep).toContain(integrationTypecheckCommand);
    expect(gateStep).toContain(`npm run ${NO_AK_SCRIPT}`);
    expect(gateStep.indexOf(integrationTypecheckCommand)).toBeLessThan(
      gateStep.indexOf(`npm run ${NO_AK_SCRIPT}`),
    );
    expect(gateStep).toContain(
      "QWEN_HOME: '${{ runner.temp }}/qwen-no-ak-home/.qwen'",
    );
    expect(gateStep).toContain('timeout-minutes: 20');
    expect(gateStep).toContain(
      "\n          HOME: '${{ runner.temp }}/qwen-no-ak-home'",
    );
    expect(gateStep).toContain(
      "\n          USERPROFILE: '${{ runner.temp }}/qwen-no-ak-home'",
    );
    for (const key of [
      'API_KEY',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'BAILIAN_CODING_PLAN_API_KEY',
      'BAILIAN_TOKEN_PLAN_API_KEY',
      'DASHSCOPE_API_KEY',
      'DEEPSEEK_API_KEY',
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'GOOGLE_API_KEY',
      'GOOGLE_MODEL',
      'IDEALAB_API_KEY',
      'MINIMAX_API_KEY',
      'MODELSCOPE_API_KEY',
      'MOONSHOT_API_KEY',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
      'OPENROUTER_API_KEY',
      'QWEN_API_KEY',
      'QWEN_DEFAULT_AUTH_TYPE',
      'QWEN_MODEL',
      'REQUESTY_API_KEY',
      'XAI_API_KEY',
      'ZAI_API_KEY',
    ]) {
      expect(gateStep).toContain(`\n          ${key}: ''`);
    }
    for (const job of [ubuntuJob, gateJob]) {
      expect(job).not.toContain('secrets.OPENAI_API_KEY');
      expect(job).not.toContain('secrets.OPENAI_BASE_URL');
      expect(job).not.toContain('secrets.OPENAI_MODEL');
    }
  });

  it('checks out the immutable PR head ref instead of the lagging merge ref', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    const ubuntuJob = getWorkflowJob(workflow, 'test');
    const webShellJob = getWorkflowJob(workflow, 'web_shell_e2e_smoke');
    const macosJob = getWorkflowJob(workflow, 'test_macos');
    const windowsJob = getWorkflowJob(workflow, 'test_windows');
    const integrationJob = getWorkflowJob(workflow, 'integration_cli');
    const noAkJob = getWorkflowJob(workflow, 'integration_no_ak');

    // On PRs every gate checks out refs/pull/N/head, which is published the
    // instant the branch is pushed, instead of the merge ref that GitHub
    // rebuilds asynchronously and can serve stale for minutes.
    for (const job of [ubuntuJob, macosJob, windowsJob, noAkJob]) {
      expect(job).toContain(
        "format('refs/pull/{0}/head', github.event.pull_request.number)",
      );
    }

    // The brittle merge-ref retry/refresh machinery is gone: in particular the
    // direct GitHub fetch (the self-hosted proxy times it out) and the forced
    // merge-ref checkout no longer exist.
    expect(ubuntuJob).not.toContain(
      "name: 'Fetch current PR merge ref from GitHub'",
    );
    expect(ubuntuJob).not.toContain('https://x-access-token:${GITHUB_TOKEN}');
    expect(ubuntuJob).not.toContain('git checkout --force "${merge_ref}"');
    expect(ubuntuJob).not.toContain(
      "name: 'Back off for stale merge ref to refresh'",
    );

    // The cheap sanity guard stays: fail loud if HEAD lacks the expected head
    // (PR head, or the merge-queue head once a job also runs on merge_group).
    // Its body lives in one composite action so the four gates cannot drift;
    // each caller keeps its own run condition and expected-SHA expression.
    const guardAction = readFileSync(
      path.join(ROOT, GUARD_ACTION_PATH),
      'utf8',
    );
    // Pin the reject path as one contiguous block so ordering is part of the
    // contract: relocating `exit 1` into a never-taken branch would turn the
    // guard into a pass-through for the stale checkouts it must reject while
    // every substring pin stayed green.
    expect(guardAction).toContain(
      [
        'if ! git merge-base --is-ancestor "${EXPECTED_SHA}" HEAD; then',
        '          echo "::error::Checked out ref does not contain expected head ${EXPECTED_SHA}."',
        '          git log --oneline --decorate -5',
        '          exit 1',
        '        fi',
      ].join('\n'),
    );
    // Pin the input-to-env wiring too: re-binding EXPECTED_SHA to a context
    // value (e.g. github.sha) would pass for every checkout, including the
    // stale ones this guard must reject, while the pin above stays green.
    expect(guardAction).toContain("EXPECTED_SHA: '${{ inputs.expected_sha }}'");

    const guardCalls = {
      test: getWorkflowStep(ubuntuJob, GUARD_STEP),
      web_shell_e2e_smoke: getWorkflowStep(webShellJob, GUARD_STEP),
      test_windows: getWorkflowStep(windowsJob, GUARD_STEP),
      integration_cli: getWorkflowStep(integrationJob, GUARD_STEP),
      integration_no_ak: getWorkflowStep(noAkJob, GUARD_STEP),
    };
    for (const [jobName, call] of Object.entries(guardCalls)) {
      expect(call, `${jobName} guard must use the shared action`).toContain(
        "uses: './.github/actions/verify-checkout-head'",
      );
    }
    expect(guardCalls.test).toContain(
      'expected_sha: "${{ github.event_name == \'merge_group\' && github.event.merge_group.head_sha || github.event.pull_request.head.sha }}"',
    );
    expect(guardCalls.web_shell_e2e_smoke).toContain(
      "expected_sha: '${{ github.event.pull_request.head.sha }}'",
    );
    expect(guardCalls.test_windows).toContain(
      'expected_sha: "${{ github.event_name == \'merge_group\' && github.event.merge_group.head_sha || github.event.pull_request.head.sha }}"',
    );
    expect(guardCalls.integration_cli).toContain(
      "expected_sha: '${{ github.event.merge_group.head_sha }}'",
    );
    expect(guardCalls.integration_no_ak).toContain(
      'expected_sha: "${{ github.event_name == \'merge_group\' && github.event.merge_group.head_sha || github.event.pull_request.head.sha }}"',
    );

    // The run conditions are part of the guard's contract: scoping a guard to
    // the wrong runner class or dropping an event would silently disable it.
    // integration_cli has no step-level if; its job-level merge_group gate
    // already covers it.
    expect(guardCalls.test).toContain(
      "if: \"${{ needs.classify_pr.outputs.skip_ci != 'true' && (github.event_name == 'pull_request' || github.event_name == 'merge_group') }}\"",
    );
    expect(guardCalls.web_shell_e2e_smoke).toContain(
      'if: "${{ github.event_name == \'pull_request\' }}"',
    );
    expect(guardCalls.test_windows).toContain(
      "if: \"${{ needs.classify_pr.outputs.skip_ci != 'true' && (github.event_name == 'pull_request' || github.event_name == 'merge_group') }}\"",
    );
    expect(guardCalls.integration_cli).not.toContain('if:');
    // integration_no_ak likewise gates skip_ci and both events at job level.
    expect(guardCalls.integration_no_ak).not.toContain('if:');
  });

  it('pins the Windows gate kill-switch routing, tuning, and Node split', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    const windowsJob = getWorkflowJob(workflow, 'test_windows');

    // The runs-on expression is the Windows gate's escape hatch and its fork
    // trust policy: pull requests never reach the pool, because a
    // pull_request run executes the PR's own YAML and could rewrite runs-on
    // itself. Pin the whole line so a variable typo, a quoting regression in
    // the nested ''true'' escapes, or an && / || regrouping fails here
    // instead of surfacing only when the switch is flipped — or when a fork
    // PR finds the persistent pool.
    const windowsRunsOn = windowsJob
      .split('\n')
      .find((line) => line.startsWith('    runs-on:'));
    expect(windowsRunsOn).toBe(
      `    runs-on: '\${{ vars.MAINTAINER_ECS_RUNNER_DISABLED != ''true'' && github.event_name != ''pull_request'' && fromJSON(''["self-hosted", "Windows", "X64", "ecs-win"]'') || fromJSON(''["windows-2022"]'') }}'`,
    );
    expect(windowsJob.split('\n')).toContain('    timeout-minutes: 60');

    // The guard must stay wired to the expected head for this job: the
    // event-aware shape, since the revived triggers have no merge-queue head.
    const guard = getWorkflowStep(windowsJob, GUARD_STEP);
    expect(guard).toContain("uses: './.github/actions/verify-checkout-head'");
    expect(guard).toContain(
      'expected_sha: "${{ github.event_name == \'merge_group\' && github.event.merge_group.head_sha || github.event.pull_request.head.sha }}"',
    );

    // The self-hosted-only tuning comes from the composite action shared with
    // windows-runner-smoke.yml, and only runs on self-hosted machines.
    const configure = getWorkflowStep(
      windowsJob,
      'Configure self-hosted Windows test environment',
    );
    expect(configure).toContain(
      "if: \"${{ needs.classify_pr.outputs.skip_ci != 'true' && runner.environment == 'self-hosted' }}\"",
    );
    expect(configure).toContain(
      "uses: './.github/actions/configure-windows-runner'",
    );
    const redirectTemp = getWorkflowStep(
      windowsJob,
      'Point temp at a short-alias-free directory',
    );
    expect(redirectTemp).toContain(
      "if: \"${{ needs.classify_pr.outputs.skip_ci != 'true' && runner.environment != 'self-hosted' }}\"",
    );
    // Pin the run block as one contiguous chunk so ordering is part of the
    // contract: under PowerShell 5.1 an undefined $temp expands to empty, so
    // if the assignment moves below the Out-File lines the step still writes
    // TEMP=/TMP= to GITHUB_ENV and exits green. The shell pin matters for the
    // same reason: Out-File's default is UTF-16LE on PowerShell 5.1, so the
    // -Encoding utf8 spelling only carries its meaning there.
    expect(redirectTemp).toContain(
      [
        "$temp = Join-Path $env:RUNNER_WORKSPACE 'qwen-code-temp'",
        'New-Item -ItemType Directory -Force -Path $temp | Out-Null',
        '"TEMP=$temp" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append',
        '"TMP=$temp" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append',
      ]
        .map((line) => `          ${line}`)
        .join('\n'),
    );
    expect(redirectTemp).toContain("shell: 'powershell'");
    const verifyTemp = getWorkflowStep(
      windowsJob,
      'Verify temp paths carry no short alias',
    );
    expect(verifyTemp).toContain(
      'if: "${{ needs.classify_pr.outputs.skip_ci != \'true\' }}"',
    );
    expect(verifyTemp).toContain('fs.realpathSync(value)');
    // The guard's decisions are asserted by executing it, below; pinning the
    // JS text here only fixes its spelling in place.
    const configureAction = readFileSync(
      path.join(ROOT, CONFIGURE_ACTION_PATH),
      'utf8',
    );
    expect(configureAction).toContain("shell: 'powershell'");
    const autocrlfStep = getWorkflowStep(
      windowsJob,
      'Disable Git CRLF conversion (self-hosted)',
    );
    expect(autocrlfStep).toContain(
      "if: \"${{ needs.classify_pr.outputs.skip_ci != 'true' && runner.environment == 'self-hosted' }}\"",
    );

    // Repository-local `./` actions resolve from the job workspace, so the
    // checkout must precede them or a fresh runner fails before checking out;
    // autocrlf is turned off before the checkout itself (belt-and-braces
    // alongside .gitattributes' eol=lf) so even a freshly provisioned machine
    // checks out LF-only files.
    const windowsCheckoutIndex = windowsJob.indexOf("name: 'Checkout'");
    const autocrlfIndex = windowsJob.indexOf(
      'git config --global core.autocrlf false',
    );
    const configureUseIndex = windowsJob.indexOf(
      "uses: './.github/actions/configure-windows-runner'",
    );
    const redirectTempIndex = windowsJob.indexOf(
      "name: 'Point temp at a short-alias-free directory'",
    );
    const hostedNodeIndex = windowsJob.indexOf('actions/setup-node@');
    const selfHostedNodeIndex = windowsJob.indexOf(
      "uses: './.github/actions/self-hosted-node'",
    );
    const verifyTempIndex = windowsJob.indexOf(
      "name: 'Verify temp paths carry no short alias'",
    );
    const installIndex = windowsJob.indexOf("name: 'Install dependencies'");
    const guardUseIndex = windowsJob.indexOf(
      "uses: './.github/actions/verify-checkout-head'",
    );
    expect(windowsCheckoutIndex).toBeGreaterThanOrEqual(0);
    expect(autocrlfIndex).toBeGreaterThanOrEqual(0);
    expect(autocrlfIndex).toBeLessThan(windowsCheckoutIndex);
    expect(configureUseIndex).toBeGreaterThan(windowsCheckoutIndex);
    expect(redirectTempIndex).toBeGreaterThan(configureUseIndex);
    expect(redirectTempIndex).toBeLessThan(hostedNodeIndex);
    expect(redirectTempIndex).toBeLessThan(selfHostedNodeIndex);
    expect(redirectTempIndex).toBeLessThan(
      windowsJob.indexOf("name: 'Run tests and generate reports'"),
    );
    expect(verifyTempIndex).toBeGreaterThan(hostedNodeIndex);
    expect(verifyTempIndex).toBeGreaterThan(selfHostedNodeIndex);
    expect(verifyTempIndex).toBeLessThan(installIndex);
    expect(guardUseIndex).toBeGreaterThan(windowsCheckoutIndex);
    expect(configureUseIndex).toBeLessThan(guardUseIndex);
    for (const line of [
      '"TEMP=$env:RUNNER_TEMP"',
      '"TMP=$env:RUNNER_TEMP"',
      '"LC_ALL=C.UTF-8"',
    ]) {
      expect(configureAction).toContain(
        `${line} | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append`,
      );
    }
    expect(configureAction).toContain(
      "$gitBash = 'C:\\Program Files\\Git\\bin'",
    );
    expect(configureAction).toContain('Test-Path $gitBash');
    expect(configureAction).toContain(
      '$gitBash | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append',
    );
    // The runner-validation smoke must consume the same action, or it
    // validates a different configuration than the gate actually uses.
    const smokeWorkflow = readFileSync(
      path.join(ROOT, '.github/workflows/windows-runner-smoke.yml'),
      'utf8',
    );
    expect(smokeWorkflow).toContain(
      "uses: './.github/actions/configure-windows-runner'",
    );
    expect(smokeWorkflow).toContain('npm run test:ci');
    expect(smokeWorkflow).not.toContain(
      'npm run test:ci --workspaces --if-present',
    );
    // Same ordering as the gate: autocrlf off before the checkout, the `./`
    // configure action after it.
    const smokeCheckoutIndex = smokeWorkflow.indexOf("name: 'Checkout'");
    const smokeAutocrlfIndex = smokeWorkflow.indexOf(
      'git config --global core.autocrlf false',
    );
    expect(smokeCheckoutIndex).toBeGreaterThanOrEqual(0);
    expect(smokeAutocrlfIndex).toBeGreaterThanOrEqual(0);
    expect(smokeAutocrlfIndex).toBeLessThan(smokeCheckoutIndex);
    expect(
      smokeWorkflow.indexOf(
        "uses: './.github/actions/configure-windows-runner'",
      ),
    ).toBeGreaterThan(smokeCheckoutIndex);
    // The smoke runs behind the same caching egress proxy as the gate, so it
    // takes the same stale-checkout guard, pinned to the dispatched head.
    expect(
      smokeWorkflow.indexOf("uses: './.github/actions/verify-checkout-head'"),
    ).toBeGreaterThan(smokeCheckoutIndex);
    expect(smokeWorkflow).toContain("expected_sha: '${{ github.sha }}'");
    // The smoke is self-hosted-only, so it must take the same Node path as
    // the gate's self-hosted side: the pre-installed Node, never a nodejs.org
    // download the ECS egress proxy cannot reach.
    expect(smokeWorkflow).toContain(
      "uses: './.github/actions/self-hosted-node'",
    );
    expect(smokeWorkflow).not.toContain('actions/setup-node');
    // The gate's run steps inherit ci.yml's workflow-level bash default, so
    // the smoke must execute these commands under the same shell; a
    // powershell pin there would validate a shell the gate never runs.
    const smokeJob = getWorkflowJob(smokeWorkflow, 'validate');
    for (const stepName of [
      'Configure persistent npm cache (self-hosted)',
      'Configure npm for rate limiting',
      'Install dependencies',
      'Run tests and generate reports',
    ]) {
      expect(getWorkflowStep(smokeJob, stepName)).toContain("shell: 'bash'");
    }
    // Both workflows declare the persistent npm cache step; the gate's
    // self-hosted path exports NPM_CONFIG_CACHE for every later npm command.
    expect(
      getWorkflowStep(smokeJob, 'Configure persistent npm cache (self-hosted)'),
    ).toContain('NPM_CONFIG_CACHE=');
    const gateNpmCache = getWorkflowStep(
      windowsJob,
      'Configure persistent npm cache (self-hosted)',
    );
    expect(gateNpmCache).toContain(
      "if: \"${{ needs.classify_pr.outputs.skip_ci != 'true' && runner.environment == 'self-hosted' }}\"",
    );
    expect(gateNpmCache).toContain('NPM_CONFIG_CACHE=');

    // Node split: hosted runners download Node, self-hosted runners reuse
    // their pre-installed one: fail loud when Node is missing, warn when the
    // major is not 22.
    const hostedSetup = getWorkflowStep(
      windowsJob,
      'Set up Node.js 22.x (hosted)',
    );
    expect(hostedSetup).toContain(
      "if: \"${{ needs.classify_pr.outputs.skip_ci != 'true' && runner.environment != 'self-hosted' }}\"",
    );
    const selfHostedNode = getWorkflowStep(
      windowsJob,
      'Use pre-installed Node.js (self-hosted)',
    );
    expect(selfHostedNode).toContain(
      "if: \"${{ needs.classify_pr.outputs.skip_ci != 'true' && runner.environment == 'self-hosted' }}\"",
    );
    expect(selfHostedNode).toContain(
      "uses: './.github/actions/self-hosted-node'",
    );
    const nodeAction = readFileSync(path.join(ROOT, NODE_ACTION_PATH), 'utf8');
    expect(nodeAction).toContain('if ! command -v node >/dev/null 2>&1; then');
    expect(nodeAction).toContain('exit 1');
    expect(nodeAction).toContain(
      'if [[ "$(node -p \'process.versions.node.split(".")[0]\')" != "22" ]]; then',
    );
    expect(nodeAction).toContain('::warning::Expected Node 22.x but found');
  });

  it('keeps install-script.test.js out of the win32 exclude list', () => {
    // install-script.test.js is the only home of the nine Windows installer
    // end-to-end cases; excluding it on win32 would silently drop coverage
    // docs/design/windows-ecs-ci-validation.md declares required.
    const scriptSuiteConfig = readFileSync(
      path.join(ROOT, 'scripts/tests/vitest.config.ts'),
      'utf8',
    );
    expect(scriptSuiteConfig).not.toContain(
      "'scripts/tests/install-script.test.js'",
    );
  });

  it('pins the shared Node preflight wiring on the Linux gates', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );

    // The Windows gate and the smoke workflow are pinned above; these three
    // call sites must be pinned too, or a revert to the inline pre-PR script
    // keeps the suite green and only surfaces when a self-hosted machine
    // lacks Node on PATH and runs without the preflight's fail-fast error.
    const nodeCalls = {
      test: getWorkflowStep(
        getWorkflowJob(workflow, 'test'),
        'Use pre-installed Node.js (self-hosted)',
      ),
      web_shell_e2e_smoke: getWorkflowStep(
        getWorkflowJob(workflow, 'web_shell_e2e_smoke'),
        'Use pre-installed Node.js (self-hosted)',
      ),
      integration_cli: getWorkflowStep(
        getWorkflowJob(workflow, 'integration_cli'),
        'Use pre-installed Node.js (self-hosted)',
      ),
      integration_no_ak: getWorkflowStep(
        getWorkflowJob(workflow, 'integration_no_ak'),
        'Use pre-installed Node.js (self-hosted)',
      ),
    };
    for (const [jobName, call] of Object.entries(nodeCalls)) {
      expect(call, `${jobName} must use the shared Node preflight`).toContain(
        "uses: './.github/actions/self-hosted-node'",
      );
    }
    expect(nodeCalls.test).toContain(
      "if: \"${{ needs.classify_pr.outputs.skip_ci != 'true' && steps.ci_profile.outputs.ci_profile == 'full' && runner.environment == 'self-hosted' }}\"",
    );
    for (const jobName of ['web_shell_e2e_smoke', 'integration_cli']) {
      expect(nodeCalls[jobName]).toContain(
        'if: "${{ runner.environment == \'self-hosted\' }}"',
      );
    }
    expect(nodeCalls.integration_no_ak).toContain(
      "if: \"${{ steps.ci_profile.outputs.ci_profile == 'full' && runner.environment == 'self-hosted' }}\"",
    );
  });

  it('keeps the lightweight coverage comment job on the hosted runner', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    const coverageJob = getWorkflowJob(workflow, 'post_coverage_comment');

    expect(coverageJob).toContain("runs-on: 'ubuntu-latest'");
    expect(coverageJob).not.toContain('ubuntu_runner');
  });

  it('does not install Linux packages on self-hosted Playwright runners', () => {
    const workflow = readFileSync(
      path.join(ROOT, '.github/workflows/ci.yml'),
      'utf8',
    );
    const webShellJob = getWorkflowJob(workflow, 'web_shell_e2e_smoke');

    expect(webShellJob).toContain('ubuntu_runner');
    expect(webShellJob).toContain("run: 'npx playwright install chromium'");
    expect(webShellJob).toContain('--with-deps chromium');
  });
});

// The 8.3 alias this guard exists for (`C:\Users\RUNNER~1` realpathing to
// `C:\Users\runneradmin`) cannot be reproduced off Windows, but every
// decision the guard makes is a comparison between an env value and its
// realpath — and a symlink reproduces each of those on any platform. Run the
// real script rather than pinning its text: the case-insensitive comparison
// below is the whole point of the step, and a substring pin cannot tell a
// working comparison from a reverted one.
describe('Windows temp short-alias guard', () => {
  const workflow = readFileSync(
    path.join(ROOT, '.github/workflows/ci.yml'),
    'utf8',
  );
  const step = getWorkflowStep(
    getWorkflowJob(workflow, 'test_windows'),
    'Verify temp paths carry no short alias',
  );
  // The script is single-quoted throughout precisely so this stays a
  // delimiter-safe extraction.
  const match = /node -e "([^"]+)"/.exec(step);
  const script = match?.[1];

  // Invoked exactly as the workflow does: `node -e <script>`, no extra argv.
  const runGuard = (env) =>
    execFileSync(
      process.execPath,
      ['-e', script],
      // Only TEMP/TMP may reach the guard: inheriting the ambient
      // environment would let the host's own temp decide the verdict.
      // stdio 'pipe' captures stderr too, so a failure's message reaches
      // the assertion instead of the test runner's console.
      { env, encoding: 'utf8', stdio: 'pipe' },
    );

  it('extracts a runnable script from the workflow', () => {
    expect(script).toBeTruthy();
  });

  it.runIf(process.platform === 'linux')(
    'accepts, warns, or fails on the three ways an env path can meet its realpath',
    () => {
      const base = realpathSync(
        mkdtempSync(path.join(tmpdir(), 'temp-guard-')),
      );
      try {
        const canonical = path.join(base, 'runneradmin');
        mkdirSync(canonical);

        // 1. Alias-free: the env value already IS its realpath.
        expect(() =>
          runGuard({ TEMP: canonical, TMP: canonical }),
        ).not.toThrow();

        // 2. Casing-only difference — the regression this guard had to stop
        // producing. On Windows realpath returns the on-disk casing, so this
        // is one directory under one spelling: warn, do not fail the lane.
        const casing = path.join(base, 'RUNNERADMIN');
        symlinkSync(canonical, casing);
        let stdout = '';
        expect(() => {
          stdout = runGuard({ TEMP: casing, TMP: casing });
        }).not.toThrow();
        expect(stdout).toContain('::warning::');
        expect(stdout).toContain('only by casing');

        // 3. A genuine second spelling, as the 8.3 alias produces: fail.
        const alias = path.join(base, 'RUNNER~1');
        symlinkSync(canonical, alias);
        expect(() => runGuard({ TEMP: alias, TMP: alias })).toThrow(
          /carries a short alias/,
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it('fails loudly when temp is unset instead of throwing on undefined', () => {
    // configure-windows-runner and the hosted redirect both set TEMP and TMP,
    // so an unset value means one of them stopped running — a clear message
    // beats realpathSync(undefined)'s TypeError.
    expect(() => runGuard({})).toThrow(/TEMP is not set/);
  });
});
