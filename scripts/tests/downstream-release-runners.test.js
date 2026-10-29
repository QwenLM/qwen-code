/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = (name) =>
  parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
// Every release-only label must stay architecture-free: the runners carrying
// ecs-qwen-release-host are ARM64, so an "x64" component would queue the job
// until it times out. Jobs that genuinely need an amd64 host (the OSS mirrors
// and the managed runtime, which execute a hardcoded linux-amd64 ossutil) are
// deliberately not routed here.
const routes = [
  ['release-vscode-companion', 'prepare'],
  ['release-vscode-companion', 'build'],
  ['release-vscode-companion', 'publish'],
  ['finalize-release', 'finalize'],
  ['desktop-release', 'publish'],
  ['release-chrome-extension', 'build'],
  ['release-chrome-extension', 'publish'],
  ['build-and-publish-image', 'build-and-push-to-ghcr'],
];
// The VSCode build is a matrix: only the universal leg is architecture-free.
const matrixLeg = (file, id) =>
  file === 'release-vscode-companion' && id === 'build';

describe('downstream release pool', () => {
  it.each(routes)(
    '%s / %s opts in to the isolated pool with a hosted fallback',
    (file, id) => {
      const job = workflow(file).jobs[id];
      const route = (
        enabled,
        repository = 'QwenLM/qwen-code',
        matrix = { os: 'ubuntu-latest', universal: true },
      ) =>
        // Evaluate these fixed repository expressions for the supported routing cases.
        Function(
          'github',
          'vars',
          'matrix',
          'fromJSON',
          `return (${job['runs-on'].slice(3, -2)})`,
        )(
          { repository },
          { ECS_RELEASE_HOST_RUNNER_ENABLED: enabled },
          matrix,
          JSON.parse,
        );
      expect(route('true')).toEqual([
        'self-hosted',
        'linux',
        'ecs-qwen-release-host',
      ]);
      expect([route(''), route('false'), route('true', 'fork/repo')]).toEqual(
        matrixLeg(file, id)
          ? ['ubuntu-latest', 'ubuntu-latest', 'ubuntu-latest']
          : [['ubuntu-latest'], ['ubuntu-latest'], ['ubuntu-latest']],
      );
      if (matrixLeg(file, id)) {
        // Native legs keep their own platforms, including the linux-x64 one:
        // it resolves native dependencies for the host it builds on.
        for (const os of ['windows-latest', 'macos-latest', 'macos-15-intel'])
          expect(
            route('true', 'QwenLM/qwen-code', { os, universal: false }),
          ).toBe(os);
        expect(
          route('true', 'QwenLM/qwen-code', {
            os: 'ubuntu-latest',
            universal: false,
          }),
        ).toBe('ubuntu-latest');
      }
      const init = job.steps.findIndex(
        (s) => s.uses === '$/.github/actions/prepare-release-runner',
      );
      expect(init).toBe(id === 'build-and-push-to-ghcr' ? 1 : 0);
      for (const setup of job.steps.filter((s) =>
        s.uses?.startsWith('actions/setup-node@'),
      )) {
        expect(setup.if).toContain("runner.environment != 'self-hosted'");
      }
    },
  );

  // The preflight wipes the workspace before actions/checkout, so it must use
  // the '$/' self-repository reference: a './' local action resolves against
  // GITHUB_WORKSPACE and would need a checkout first (and on a persistent
  // machine would execute whatever tree the previous job left behind).
  it('runs the shared preflight from the running commit, before checkout', () => {
    const action = parse(
      readFileSync('.github/actions/prepare-release-runner/action.yml', 'utf8'),
    );
    const [step] = action.runs.steps;
    expect(action.runs.using).toBe('composite');
    expect(step.if).toContain("runner.environment == 'self-hosted'");
    expect(step['working-directory']).toBe('${{ runner.temp }}');
    expect(step.env.WORKFLOW_SHA).toBe('${{ github.workflow_sha }}');
    expect(step.run).toContain('set -euo pipefail');
    expect(step.run).toContain('export GH_CONFIG_DIR="$bootstrap/gh"');
    expect(step.run).toContain('?ref=${WORKFLOW_SHA}');
    expect(step.run).toContain('bash "$bootstrap/prepare-release-runner.sh"');

    for (const [file, id] of routes) {
      const steps = workflow(file).jobs[id].steps;
      const uses = steps.map((s) => s.uses);
      const preflight = uses.indexOf(
        '$/.github/actions/prepare-release-runner',
      );
      const checkout = uses.findIndex((u) =>
        u?.startsWith('actions/checkout@'),
      );
      expect(preflight).toBeGreaterThanOrEqual(0);
      if (checkout !== -1) expect(preflight).toBeLessThan(checkout);
    }
  });

  it('keeps incompatible native builds and npm provenance publishers hosted', () => {
    expect(workflow('desktop-release').jobs.build['runs-on']).toBe(
      '${{ matrix.os }}',
    );
    expect(workflow('release-sdk').jobs['release-sdk']['runs-on']).toBe(
      'ubuntu-latest',
    );
    expect(workflow('live-host-release').jobs.publish['runs-on']).toBe(
      'ubuntu-latest',
    );
    // These execute a hardcoded linux-amd64 ossutil, so they cannot ride the
    // ARM64 release-only pool and must stay on their hosted runners until the
    // download selects a binary for the host architecture.
    for (const [file, id] of [
      ['sync-release-to-oss', 'sync'],
      ['sync-desktop-to-oss', 'sync'],
      ['sync-live-host-to-oss', 'sync'],
      ['release-managed-runtime', 'release'],
    ]) {
      const text = readFileSync(`.github/workflows/${file}.yml`, 'utf8');
      expect(text).toContain('linux-amd64.zip');
      expect(workflow(file).jobs[id]['runs-on']).toBe('ubuntu-latest');
    }
  });

  it('isolates persistent tool and credential state', () => {
    const script = readFileSync(
      '.github/scripts/prepare-release-runner.sh',
      'utf8',
    );
    for (const setting of [
      'GIT_CONFIG_GLOBAL',
      'NPM_CONFIG_USERCONFIG',
      'NPM_CONFIG_PREFIX',
      'DOCKER_CONFIG',
      'GH_CONFIG_DIR',
      'MAVEN_OPTS',
    ])
      expect(script).toContain(setting);
  });
});

describe('SDK build/publish handoff', () => {
  const jobs = workflow('release-sdk').jobs;
  const builder = jobs['build-sdk'];
  const publisher = jobs['release-sdk'];
  it('builds on opt-in only and never silently rebuilds after an ECS failure', () => {
    expect(builder.if).toContain(
      "vars.ECS_RELEASE_HOST_RUNNER_ENABLED == 'true'",
    );
    // The builder's label is a literal array rather than a switched
    // expression, so the arch-free contract needs its own assertion: the
    // release-only runners are ARM64 and this job only bundles with Node.
    expect(builder['runs-on']).toEqual([
      'self-hosted',
      'linux',
      'ecs-qwen-release-host',
    ]);
    expect(builder.permissions).toEqual({ contents: 'read' });
    expect(
      builder.steps.find((s) => s.name === 'Checkout').with[
        'persist-credentials'
      ],
    ).toBe(false);
    expect(publisher.needs).toEqual(['build-sdk']);
    expect(publisher.if).toContain("needs.build-sdk.result == 'success'");
    expect(publisher.if).toContain(
      "needs.build-sdk.result == 'skipped' && vars.ECS_RELEASE_HOST_RUNNER_ENABLED != 'true'",
    );
    const shared = builder.steps.filter((s) => s.if?.includes('env.BUILD_SDK'));
    for (const step of shared) expect(publisher.steps).toContainEqual(step);
    expect(publisher.env.BUILD_SDK).toBe(
      "${{ needs.build-sdk.result != 'success' }}",
    );
  });
  it('pins source and artifact identity and restores the chosen CLI after tests', () => {
    expect(
      publisher.steps.find((s) => s.name === 'Checkout').with.ref,
    ).toContain('needs.build-sdk.outputs.source_sha');
    expect(
      publisher.steps.find((s) => s.name === 'Download the tested SDK package')
        .with['artifact-ids'],
    ).toBe('${{ needs.build-sdk.outputs.artifact_id }}');
    const names = builder.steps.map((s) => s.name);
    for (const mode of ['npm', 'source'])
      expect(
        names.indexOf(`Restore CLI into SDK (from ${mode})`),
      ).toBeGreaterThan(names.indexOf('Run SDK Integration Tests'));
    expect(
      names.indexOf('Pack the tested SDK without lifecycle scripts'),
    ).toBeGreaterThan(names.indexOf('Record bundled CLI version'));
    const publish = publisher.steps.find(
      (s) => s.name === 'Publish @qwen-code/sdk',
    );
    expect(publish.run).toContain(
      'npm publish "$tarball" --ignore-scripts --provenance',
    );
    expect(publish.run).toContain('dist.integrity');
    expect(jobs['report-failure'].if).toContain(
      "needs.build-sdk.result == 'failure'",
    );
    expect(jobs['report-failure'].if).toContain('inputs.dry_run != true');
  });
});
