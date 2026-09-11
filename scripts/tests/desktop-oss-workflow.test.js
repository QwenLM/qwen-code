/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';

const releaseWorkflow = readFileSync(
  '.github/workflows/desktop-release.yml',
  'utf8',
);
const syncWorkflow = readFileSync(
  '.github/workflows/sync-desktop-to-oss.yml',
  'utf8',
);
const syncCallerWorkflow = readFileSync(
  '.github/workflows/desktop-release-sync.yml',
  'utf8',
);
const tauriConfig = JSON.parse(
  readFileSync('packages/desktop-shell/src-tauri/tauri.conf.json', 'utf8'),
);

describe('Desktop OSS mirror workflow', () => {
  it('mirrors only published stable Desktop releases', () => {
    expect(syncWorkflow).not.toContain('pull_request:');
    expect(releaseWorkflow).toContain(
      "desktop-release-${{ inputs.dry_run && inputs.version || 'publish' }}",
    );
    const prepare = getWorkflowStep(
      getWorkflowJob(releaseWorkflow, 'prepare'),
      'Resolve version',
    );
    expect(prepare).toContain("IS_DRAFT: '${{ inputs.draft }}'");
    expect(prepare).toContain("IS_DRY_RUN: '${{ inputs.dry_run }}'");
    expect(prepare).toContain("IS_PRERELEASE: '${{ inputs.prerelease }}'");
    expect(prepare).toContain(
      'Published stable Desktop versions must use X.Y.Z',
    );
    expect(prepare).toContain(
      'Desktop prereleases must use a SemVer prerelease suffix',
    );

    const syncOss = getWorkflowJob(releaseWorkflow, 'sync-oss');
    expect(syncOss).toContain(
      "if: \"${{ (github.event_name == 'workflow_dispatch' || github.event_name == 'release') && inputs.dry_run == false && inputs.draft == false && inputs.prerelease == false && github.repository == 'QwenLM/qwen-code' }}\"",
    );
    expect(syncOss).toContain("- 'publish'");
    expect(syncOss).toContain("source: 'artifact'");
    expect(syncOss).not.toContain('secrets: inherit');
  });

  it('passes only the OSS credentials into the reusable workflow', () => {
    expect(releaseWorkflow).toContain("permissions:\n  contents: 'read'");
    const syncOss = getWorkflowJob(releaseWorkflow, 'sync-oss');
    expect(syncOss).toContain(
      "permissions:\n      actions: 'read'\n      contents: 'read'",
    );
    for (const secret of [
      'ALIYUN_OSS_ACCESS_KEY_ID',
      'ALIYUN_OSS_ACCESS_KEY_SECRET',
    ]) {
      expect(syncWorkflow).toContain(`${secret}:\n        required: true`);
      expect(syncOss).toContain(`${secret}: '\${{ secrets.${secret} }}'`);
    }
  });

  it('publishes verified versioned assets before advancing the OSS feed', () => {
    const sync = getWorkflowJob(syncWorkflow, 'sync');
    const prepare = getWorkflowStep(sync, 'Verify and prepare mirror assets');
    expect(prepare).toContain(
      '--base-url "${ALIYUN_OSS_PUBLIC_BASE_URL}/desktop/v${VERSION}"',
    );
    expect(prepare).toContain('sha256sum -- * > SHA256SUMS.txt');

    const upload = getWorkflowStep(
      sync,
      'Upload versioned assets to Aliyun OSS',
    );
    expect(upload).toContain('--prefix "desktop/v${VERSION}"');

    const latest = getWorkflowStep(
      sync,
      'Publish latest manifest to Aliyun OSS',
    );
    expect(latest).toContain("--prefix 'desktop/latest'");
    expect(latest).toContain('dist/desktop/desktop-latest.json');
    expect(latest).not.toContain('.dmg');

    const verifyIndex = sync.indexOf(
      "name: 'Verify versioned assets on Aliyun OSS'",
    );
    expect(verifyIndex).toBeGreaterThan(0);
    expect(verifyIndex).toBeLessThan(
      sync.indexOf("name: 'Publish latest manifest to Aliyun OSS'"),
    );
    expect(
      getWorkflowStep(sync, 'Verify versioned assets on Aliyun OSS'),
    ).toContain('sha256sum -c SHA256SUMS.txt');
    expect(
      getWorkflowStep(sync, 'Verify latest manifest on Aliyun OSS'),
    ).toContain('cmp ');
  });

  it('advances the OSS feed only for the current GitHub stable version', () => {
    const publish = getWorkflowJob(releaseWorkflow, 'publish');
    const updateFeed = getWorkflowStep(publish, 'Update stable updater feed');
    expect(updateFeed).toContain('sort -V');
    expect(updateFeed).toContain(
      'Desktop $RELEASE_VERSION will not replace newer stable feed $current',
    );

    const sync = getWorkflowJob(syncWorkflow, 'sync');
    const check = getWorkflowStep(
      sync,
      'Check whether release matches GitHub stable feed',
    );
    expect(check).toContain("gh release download 'desktop-latest'");
    expect(check).toContain("SOURCE: '${{ steps.release.outputs.source }}'");
    expect(check).toContain('elif [ "$SOURCE" = \'artifact\' ]; then');
    expect(check).toContain('sort -V');
    expect(check).toContain('GitHub stable feed is already newer at $actual');
    expect(check).toContain(
      'GitHub stable feed is $actual after publishing Desktop $expected',
    );
    expect(check).toContain('echo \'matches=true\' >> "$GITHUB_OUTPUT"');
    expect(check).toContain('echo \'matches=false\' >> "$GITHUB_OUTPUT"');
    expect(check).toContain(
      'expected="$(jq -r \'.version\' dist/desktop/desktop-latest.json)"',
    );
    expect(check).toContain(
      'actual="$(jq -r \'.version\' "$directory/desktop-latest.json")"',
    );
    expect(
      getWorkflowStep(sync, 'Publish latest manifest to Aliyun OSS'),
    ).toContain('if: "${{ steps.latest.outputs.matches == \'true\' }}"');
    expect(
      getWorkflowStep(sync, 'Verify latest manifest on Aliyun OSS'),
    ).toContain('if: "${{ steps.latest.outputs.matches == \'true\' }}"');
  });

  it('sync workflow validates stable-only releases in the reusable job', () => {
    expect(syncWorkflow).not.toContain('pull_request:');
    const sync = getWorkflowJob(syncWorkflow, 'sync');
    const resolve = getWorkflowStep(sync, 'Resolve release');
    expect(resolve).toContain('^[0-9]+\\.[0-9]+\\.[0-9]+$');
    expect(resolve).toContain("!= 'artifact'");
    expect(resolve).toContain("!= 'release'");
    expect(getWorkflowStep(sync, 'Download GitHub release assets')).toContain(
      '.isDraft == false and .isPrerelease == false',
    );
  });

  it('keeps the workflow default aligned with the shipped updater endpoint', () => {
    const firstEndpoint = tauriConfig.plugins.updater.endpoints[0];
    expect(syncWorkflow).toContain(new URL(firstEndpoint).origin);
  });

  it('admits the release path in the reusable sync job gate', () => {
    const sync = getWorkflowJob(syncWorkflow, 'sync');
    expect(sync).toContain(
      "if: \"${{ github.repository == 'QwenLM/qwen-code' && (github.ref == 'refs/heads/main' || github.event_name == 'release') }}\"",
    );
  });

  it('resolves the release tag parent before the main ancestry check', () => {
    const source = getWorkflowStep(
      getWorkflowJob(releaseWorkflow, 'prepare'),
      'Resolve Qwen Code source',
    );
    expect(source).toContain(
      'if [ "$GITHUB_REF_NAME" != \'main\' ] && [ "$GITHUB_EVENT_NAME" != \'release\' ]; then',
    );
    expect(source).toContain(
      '::error::Published desktop releases must run from main or follow a published release.',
    );
    expect(source).toContain('ancestor="$sha"');
    expect(source).toContain('if [ "$GITHUB_EVENT_NAME" = \'release\' ]; then');
    expect(source).toContain('ancestor="$(git rev-parse "${sha}^")"');
    expect(source).toContain(
      'git merge-base --is-ancestor "$ancestor" refs/remotes/origin/main',
    );
    expect(
      source.indexOf('ancestor="$(git rev-parse "${sha}^")"'),
    ).toBeGreaterThan(source.indexOf('ancestor="$sha"'));
    expect(
      source.indexOf('ancestor="$(git rev-parse "${sha}^")"'),
    ).toBeLessThan(source.indexOf('git merge-base --is-ancestor "$ancestor"'));
  });
});

describe('Desktop release sync caller', () => {
  it('gates the release-following publish on the CLI release signal', () => {
    expect(syncCallerWorkflow).toContain("release:\n    types: ['published']");
    const publish = getWorkflowJob(syncCallerWorkflow, 'publish');
    expect(publish).toContain("github.repository == 'QwenLM/qwen-code'");
    expect(publish).toContain("vars.RELEASE_DESKTOP_SYNC_PUBLISH == 'true'");
    expect(publish).toContain("startsWith(github.event.release.tag_name, 'v')");
    expect(publish).toContain('github.event.release.prerelease == false');
    expect(publish).toContain(
      "github.repository == 'QwenLM/qwen-code' &&\n" +
        "        vars.RELEASE_DESKTOP_SYNC_PUBLISH == 'true' &&\n" +
        "        startsWith(github.event.release.tag_name, 'v') &&\n" +
        '        github.event.release.prerelease == false',
    );
    for (const withValue of [
      "version: '${{ github.event.release.tag_name }}'",
      "qwen_code_ref: '${{ github.event.release.tag_name }}'",
      'electron_bridge: false',
      'dry_run: false',
      'draft: false',
      'prerelease: false',
      'clobber: false',
    ]) {
      expect(publish).toContain(withValue);
    }
    expect(publish).toContain(
      "uses: './.github/workflows/desktop-release.yml'",
    );
    expect(publish).toContain("secrets: 'inherit'");
  });

  it('uses a concurrency group distinct from the callee publish group', () => {
    const calleeFallback =
      /group: "desktop-release-\$\{\{[^}]*\|\| '([^']+)' \}\}"/.exec(
        releaseWorkflow,
      )?.[1];
    expect(calleeFallback).toBe('publish');
    expect(syncCallerWorkflow).toContain("group: 'desktop-release-sync'");
    expect(`desktop-release-${calleeFallback}`).not.toBe(
      'desktop-release-sync',
    );
  });

  it('keeps the caller permissions to actions read and contents write', () => {
    expect(syncCallerWorkflow).toContain(
      "permissions:\n  actions: 'read'\n  contents: 'write'",
    );
  });
});
