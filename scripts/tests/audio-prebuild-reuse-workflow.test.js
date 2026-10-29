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
const releaseYaml = workflow('release');
const audioYaml = workflow('audio-capture-prebuilds');
const step = (job, name) =>
  releaseYaml.jobs[job].steps.find((entry) => entry.name === name);

describe('audio prebuild reuse wiring', () => {
  it('only publishes a reuse ID after a trial download and payload validation', () => {
    // The ID comes from the acceptance step, not the lookup: a candidate that
    // cannot be downloaded or does not validate must leave the output empty so
    // the fresh build still runs.
    expect(releaseYaml.jobs.prepare.outputs.audio_artifact_id).toBe(
      '${{ steps.audio_reuse.outputs.artifact_id }}',
    );
    expect(releaseYaml.jobs.prepare.permissions.actions).toBe('read');

    const lookup = step('prepare', 'Find reusable audio prebuilds');
    const fingerprint = step('prepare', 'Fingerprint audio build inputs');
    const download = step('prepare', 'Try reusable audio prebuilds');
    const accept = step('prepare', 'Accept complete audio prebuilds');
    // Failure before acceptance must leave the fresh-build path available.
    for (const entry of [fingerprint, lookup, download, accept])
      expect(entry['continue-on-error']).toBe(true);
    expect(fingerprint.run).toContain('echo "directory=$directory"');
    expect(fingerprint.run.indexOf('echo "directory=$directory"')).toBeLessThan(
      fingerprint.run.indexOf('audio-prebuilds.mjs key'),
    );
    expect(download.if).toBe(
      "${{ steps.audio_candidate.outputs.artifact_id != '' }}",
    );
    // outcome, not conclusion: continue-on-error rewrites conclusion to success.
    expect(accept.if).toBe("${{ steps.audio_download.outcome == 'success' }}");
    expect(accept.run).toContain('audio-prebuilds.mjs validate');

    // The trial bytes are always discarded, including when a step failed.
    const cleanup = step('prepare', 'Remove trial audio download');
    expect(cleanup.if).toContain('always()');
    expect(cleanup.run).toBe('rm -rf -- "$AUDIO_DIRECTORY"');

    // The fingerprint has to see the producing workflow, so it must be
    // checked out alongside the helper.
    const checkout = releaseYaml.jobs.prepare.steps.find((entry) =>
      entry.with?.['sparse-checkout']?.includes('/.github/scripts'),
    );
    expect(checkout.with['sparse-checkout']).toContain(
      '/.github/workflows/audio-capture-prebuilds.yml',
    );
  });

  it('skips the native matrix on a hit and still gates the publisher', () => {
    const native = releaseYaml.jobs.audio_capture_prebuilds;
    expect(native.if).toContain(
      "needs.prepare.outputs.audio_artifact_id == ''",
    );
    expect(native.with.ref).toBe('${{ needs.prepare.outputs.release_sha }}');
    expect(native.with.cache_key).toBe(
      '${{ needs.prepare.outputs.audio_prebuild_key }}',
    );

    // A skipped matrix is only acceptable when a reuse ID was actually
    // selected, otherwise the publisher would ship without prebuilds.
    const gate = releaseYaml.jobs.publish.if;
    expect(gate).toContain("needs.audio_capture_prebuilds.result == 'success'");
    expect(gate).toContain(
      "needs.audio_capture_prebuilds.result == 'skipped' && needs.prepare.outputs.audio_artifact_id != ''",
    );
  });

  it('rechecks the reused source in the publisher and validates either path', () => {
    expect(releaseYaml.jobs.publish.permissions.actions).toBe('read');
    // prepare's decision is not trusted blindly: the publisher recomputes the
    // fingerprint from its own checkout and re-verifies the source run.
    const verify = step('publish', 'Verify reusable audio source');
    expect(verify.if).toBe(
      "${{ needs.prepare.outputs.audio_artifact_id != '' }}",
    );
    expect(verify['continue-on-error']).toBeUndefined();
    expect(verify.with.script).toContain('audioPrebuildKey');
    expect(verify.with.script).toContain('verifyAudioArtifact');

    const reused = step('publish', 'Download reusable audio prebuilds');
    const fresh = step('publish', 'Download audio capture prebuilds');
    expect(reused.if).toBe(
      "${{ needs.prepare.outputs.audio_artifact_id != '' }}",
    );
    expect(fresh.if).toContain("needs.prepare.outputs.audio_artifact_id == ''");
    expect(reused.with['artifact-ids']).toBe(
      '${{ needs.prepare.outputs.audio_artifact_id }}',
    );
    expect(reused.with['run-id']).toBe(
      '${{ needs.prepare.outputs.audio_run_id }}',
    );
    // Exactly one of the two runs, and both land in the same directory.
    expect(reused.with.path).toBe(fresh.with.path);

    // Whichever path ran, the payload is validated before the build consumes it.
    const names = releaseYaml.jobs.publish.steps.map((entry) => entry.name);
    const validate = names.indexOf('Validate complete audio prebuilds');
    expect(validate).toBeGreaterThan(names.indexOf(reused.name));
    expect(validate).toBeGreaterThan(names.indexOf(fresh.name));
    expect(validate).toBeLessThan(
      names.indexOf('Build Bundle and Prepare Package'),
    );
  });

  it('retains a fingerprint-named artifact for later releases', () => {
    const collect = audioYaml.jobs.collect;
    const retain = collect.steps.find(
      (entry) => entry.name === 'Retain reusable audio prebuilds',
    );
    // Without the keyed upload nothing can ever be reused; the fixed-name
    // artifact stays for the same-run consumer.
    expect(retain.if).toBe("${{ inputs.cache_key != '' }}");
    expect(retain.with.name).toBe(
      'audio-capture-prebuilds-${{ inputs.cache_key }}',
    );
    expect(retain.with['if-no-files-found']).toBe('error');
    expect(retain.with.overwrite).toBe(true);
    expect(
      collect.steps.find((entry) => entry.name === 'Upload combined prebuilds')
        .with.name,
    ).toBe('audio-capture-prebuilds');
    expect(
      collect.steps.find((entry) => entry.name === 'Upload combined prebuilds')
        .with.overwrite,
    ).toBe(true);
    // The producer builds the ref the release pinned, not the branch tip.
    expect(
      audioYaml.jobs.build.steps.find((entry) =>
        entry.uses?.startsWith('actions/checkout@'),
      ).with.ref,
    ).toBe('${{ inputs.ref || github.sha }}');
  });
});

describe('prebuild collector hygiene', () => {
  it('wipes the workspace through the shared preflight before merging', () => {
    // download-artifact's merge-multiple merges into existing paths, so a
    // stale prebuilds/ tree on a persistent host would leak into the artifact.
    // The shared preflight wipes with path containment; the subtree rm it
    // replaced followed a leftover symlinked parent out of the workspace.
    const steps = audioYaml.jobs.collect.steps;
    expect(steps[0].uses).toBe('$/.github/actions/prepare-release-runner');
    expect(steps[1].name).toBe('Merge per-platform prebuilds');
    for (const entry of steps)
      expect(entry.run ?? '').not.toContain('rm -rf -- "${GITHUB_WORKSPACE}');
  });

  it('keeps the release-only label architecture-free', () => {
    // The runners carrying ecs-qwen-release-host are ARM64. An "x64"
    // component does not fall back to hosted — it never matches, and the job
    // queues until it times out. Resolve the expression rather than
    // substring-matching it, which would pass with the pin present.
    const route = (enabled, repository = 'QwenLM/qwen-code') =>
      Function(
        'github',
        'vars',
        'fromJSON',
        `return (${audioYaml.jobs.collect['runs-on'].slice(3, -2)})`,
      )(
        { repository },
        { ECS_RELEASE_HOST_RUNNER_ENABLED: enabled },
        JSON.parse,
      );
    expect(route('true')).toEqual([
      'self-hosted',
      'linux',
      'ecs-qwen-release-host',
    ]);
    expect([route(''), route('false'), route('true', 'fork/repo')]).toEqual([
      ['ubuntu-latest'],
      ['ubuntu-latest'],
      ['ubuntu-latest'],
    ]);
  });

  it('has a Node contract on both runner kinds before it runs node', () => {
    // The validator shells out to `node`; the collector previously inherited
    // Node from the hosted image by accident and asserted nothing.
    const steps = audioYaml.jobs.collect.steps;
    const node = steps.filter(
      (entry) =>
        entry.uses?.endsWith('.github/actions/self-hosted-node') ||
        entry.uses?.startsWith('actions/setup-node@'),
    );
    expect(node.map((entry) => entry.if)).toEqual([
      "${{ runner.environment == 'self-hosted' }}",
      "${{ runner.environment != 'self-hosted' }}",
    ]);
    const validate = steps.findIndex((entry) =>
      entry.run?.includes('audio-prebuilds.mjs validate'),
    );
    for (const entry of node)
      expect(steps.indexOf(entry)).toBeLessThan(validate);
    // self-hosted-node is resolved from the helper checkout, so that checkout
    // has to include it.
    expect(
      steps.find((entry) => entry.name === 'Checkout audio workflow helper')
        .with['sparse-checkout'],
    ).toContain('.github/actions/self-hosted-node');
  });
});
