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
// Architecture-free jobs can use either reserved ARM64 or x64 slots.
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
const canonicalPreflightBootstrap = `set -euo pipefail
bootstrap=$(mktemp -d "\${RUNNER_TEMP:?}/release-bootstrap.XXXXXX")
trap 'rm -rf -- "$bootstrap"' EXIT
export GH_CONFIG_DIR="$bootstrap/gh"
mkdir -p "$GH_CONFIG_DIR"
for script in prepare-release-runner.sh check-disk-floor.sh; do
  gh api "repos/\${GITHUB_REPOSITORY}/contents/.github/scripts/\${script}?ref=\${WORKFLOW_SHA}" --jq .content | base64 --decode > "$bootstrap/$script"
done
bash "$bootstrap/prepare-release-runner.sh"
node -e 'if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Release hosts require Node 22")'
bash "$bootstrap/check-disk-floor.sh" "$GITHUB_WORKSPACE" "$RUNNER_TEMP"`;

const isInlinePreflight = (step) =>
  step?.uses === undefined &&
  step?.if === "${{ runner.environment == 'self-hosted' }}" &&
  step?.['working-directory'] === '${{ runner.temp }}' &&
  step?.shell === 'bash' &&
  step?.env?.GH_TOKEN === '${{ github.token }}' &&
  step?.env?.WORKFLOW_SHA === '${{ github.workflow_sha }}' &&
  step?.run === canonicalPreflightBootstrap;

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
      const init = job.steps.findIndex(isInlinePreflight);
      expect(init).toBe(id === 'build-and-push-to-ghcr' ? 1 : 0);
      for (const setup of job.steps.filter((s) =>
        s.uses?.startsWith('actions/setup-node@'),
      )) {
        expect(setup.if).toContain("runner.environment != 'self-hosted'");
      }
    },
  );

  // The preflight wipes the workspace before actions/checkout, so it cannot
  // use a './' local action (which resolves against GITHUB_WORKSPACE and would
  // need a checkout first) and must not use a '$/' self-repository action
  // (which downloads the entire ~100 MB repository archive during Set up job).
  // Instead, every routed job runs the exact same inline bootstrap in
  // runner.temp to fetch the pinned scripts at github.workflow_sha via gh api.
  it('runs the shared inline preflight from the running commit, before checkout', () => {
    for (const [file, id] of [
      ...routes,
      ['release-sdk', 'build-sdk'],
      ['audio-capture-prebuilds', 'build'],
      ['audio-capture-prebuilds', 'collect'],
    ]) {
      const steps = workflow(file).jobs[id].steps;
      const preflight = steps.findIndex(isInlinePreflight);
      const checkout = steps.findIndex((s) =>
        s.uses?.startsWith('actions/checkout@'),
      );
      expect(preflight, `${file}/${id}`).toBeGreaterThanOrEqual(0);
      if (checkout !== -1)
        expect(preflight, `${file}/${id}`).toBeLessThan(checkout);
      for (const step of steps) {
        expect(String(step.uses ?? ''), `${file}/${id}`).not.toMatch(/^\$\//);
      }
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
    // architecture-free routes. Their migration to the reserved x64 slot is
    // separate from this change.
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
    // pool has both architectures and this job only bundles with Node.
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

describe('audio release slots', () => {
  const audio = workflow('audio-capture-prebuilds');
  const release = workflow('release');
  const route = (job, matrix, enabled, repository = 'QwenLM/qwen-code') =>
    Function(
      'github',
      'vars',
      'matrix',
      'fromJSON',
      'startsWith',
      'format',
      `return (${job['runs-on'].slice(3, -2)})`,
    )(
      { repository },
      { ECS_RELEASE_HOST_RUNNER_ENABLED: enabled },
      matrix,
      JSON.parse,
      (value, prefix) => value.startsWith(prefix),
      (template, value) => template.replace('{0}', value),
    );

  it('selects matching Linux architecture and preserves hosted fallbacks', () => {
    for (const matrix of audio.jobs.build.strategy.matrix.include) {
      const linux = matrix.os.startsWith('ubuntu');
      expect(route(audio.jobs.build, matrix, 'true')).toEqual(
        linux
          ? ['self-hosted', 'linux', matrix.arch, 'ecs-qwen-release-host']
          : matrix.runner,
      );
      expect(route(audio.jobs.build, matrix, '')).toBe(matrix.runner);
      expect(route(audio.jobs.build, matrix, 'false')).toBe(matrix.runner);
      expect(route(audio.jobs.build, matrix, 'true', 'fork/repo')).toBe(
        matrix.runner,
      );
    }
    expect(route(audio.jobs.collect, {}, 'true')).toEqual([
      'self-hosted',
      'linux',
      'ecs-qwen-release-host',
    ]);
    expect(route(audio.jobs.collect, {}, '')).toEqual(['ubuntu-latest']);
  });

  it('builds the selected release commit', () => {
    expect(release.jobs.audio_capture_prebuilds.uses).toBe(
      './.github/workflows/audio-capture-prebuilds.yml',
    );
    expect(release.jobs.audio_capture_prebuilds.with).toMatchObject({
      ref: '${{ needs.prepare.outputs.release_sha }}',
    });
    expect(
      audio.jobs.build.steps.find((s) =>
        s.uses?.startsWith('actions/checkout@'),
      ).with.ref,
    ).toBe('${{ inputs.ref || github.sha }}');
    for (const job of [audio.jobs.build, audio.jobs.collect]) {
      expect(isInlinePreflight(job.steps[0])).toBe(true);
    }
  });

  it('keeps newer host glibc out of Linux native binaries', () => {
    const steps = audio.jobs.build.steps;
    const container = steps.find((s) => s.name === 'Build Linux prebuild');
    expect(container.if).toBe("${{ startsWith(matrix.os, 'ubuntu') }}");
    expect(container.run).toContain('node:22.22.3-bookworm');
    expect(container['working-directory']).toBe('.');
    expect(container.run).toContain('--frozen-lockfile --ignore-scripts');
    expect(container.run).toContain('npm run prebuildify -- --target 22.22.3');
    expect(container.run).toContain('--user "$(id -u):$(id -g)"');
    for (const name of ['Install build deps', 'Build prebuild']) {
      expect(steps.find((s) => s.name === name).if).toBe(
        "${{ !startsWith(matrix.os, 'ubuntu') }}",
      );
    }
  });
});
