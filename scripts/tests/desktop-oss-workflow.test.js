/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      "if: \"${{ (github.event_name == 'workflow_dispatch' || inputs.follows_release) && inputs.dry_run == false && inputs.draft == false && inputs.prerelease == false && github.repository == 'QwenLM/qwen-code' }}\"",
    );
    expect(syncOss).toContain("- 'publish'");
    expect(syncOss).toContain("source: 'artifact'");
    expect(syncOss).toContain(
      "follows_release: '${{ inputs.follows_release }}'",
    );
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
    // This workflow is itself a reusable callee, so github.event_name here is
    // always workflow_call and can never see the release that started the
    // chain. The gate has to read the input the caller hands down instead.
    expect(sync).toContain(
      "if: \"${{ github.repository == 'QwenLM/qwen-code' && (github.ref == 'refs/heads/main' || inputs.follows_release) }}\"",
    );
    expect(syncWorkflow).toContain(
      "      follows_release:\n        default: false\n        type: 'boolean'",
    );
    expect(syncWorkflow).not.toContain(
      '      follows_release:\n        required: true',
    );
  });

  it('hands the release signal down instead of reading the caller event', () => {
    // Inside a reusable workflow invoked with `uses:`, github.event_name and
    // $GITHUB_EVENT_NAME are always workflow_call — never the caller's trigger.
    // Every `event_name == 'release'` test in these two callees was therefore
    // dead: the prepare guard aborted the run before it built anything, and the
    // sync-oss job was silently skipped. The signal has to be threaded through
    // an explicit input. Pin both ends, and pin that the dead class is gone.
    expect(releaseWorkflow).toContain(
      "      follows_release:\n        default: false\n        type: 'boolean'",
    );
    expect(releaseWorkflow).not.toContain(
      '      follows_release:\n        required: true',
    );
    const source = getWorkflowStep(
      getWorkflowJob(releaseWorkflow, 'prepare'),
      'Resolve Qwen Code source',
    );
    expect(source).toContain(
      "FOLLOWS_RELEASE: '${{ inputs.follows_release }}'",
    );
    for (const [name, text] of [
      ['desktop-release.yml', releaseWorkflow],
      ['sync-desktop-to-oss.yml', syncWorkflow],
    ]) {
      expect(text, `${name} still tests the caller's event`).not.toContain(
        "github.event_name == 'release'",
      );
      expect(text, `${name} still tests the caller's event`).not.toContain(
        '$GITHUB_EVENT_NAME',
      );
    }
  });

  it('resolves the release tag parent before the main ancestry check', () => {
    const source = getWorkflowStep(
      getWorkflowJob(releaseWorkflow, 'prepare'),
      'Resolve Qwen Code source',
    );
    expect(source).toContain(
      'if [ "$GITHUB_REF_NAME" != \'main\' ] && [ "$FOLLOWS_RELEASE" != \'true\' ]; then',
    );
    expect(source).toContain(
      '::error::Published desktop releases must run from main or follow a published release.',
    );
    expect(source).toContain('ancestor="$sha"');
    expect(source).toContain('if [ "$FOLLOWS_RELEASE" = \'true\' ]; then');
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
    // The peel feeds the ancestry check only; the build still consumes the tag
    // commit. Emitting $ancestor instead would publish desktop-vX.Y.Z bundling
    // CLI X.Y.(Z-1) with every gate green.
    expect(source).toContain('sha="$(git rev-parse FETCH_HEAD)"');
    expect(source).toContain('echo "sha=$sha" >> "$GITHUB_OUTPUT"');
    expect(source).not.toContain('sha="$ancestor"');
  });

  it('says what the release arm actually establishes', () => {
    // The release arm checks the tag's parent while the build consumes the
    // tag commit, so the step cannot claim the bundled commit is reachable
    // from main. Narrowing it further was measured and abandoned — real tags
    // carry no single delta shape and none is a signed object — which leaves
    // the wording as the remediation. Pin it: an error message that overstates
    // what ran is the thing this whole thread was about. It must also name the
    // operand that was actually checked, because a tag with extra commits on
    // its release branch (a documented hotfix shape) was still cut from main,
    // and blaming provenance for that sends the operator the wrong way.
    const source = getWorkflowStep(
      getWorkflowJob(releaseWorkflow, 'prepare'),
      'Resolve Qwen Code source',
    );
    expect(source).toContain(
      "::error::Release $INPUT_REF: the tag commit's first parent $ancestor is not reachable from main",
    );
    expect(source).toContain('whoever can tag and publish a release');
    expect(source).not.toContain('This release was not cut from main');
    // The CLI's npm publish runs from main, not from the release tag; the old
    // claim gave the tag a provenance anchor it does not have.
    expect(source).not.toContain('publishes the CLI to npm from the same tag');
  });

  it('puts the feed-clobbering publish behind the deployment gate', () => {
    // The publish job overwrites desktop-latest.json with --clobber. The OSS
    // mirror job already waits on production-release; a feed move that could
    // skip that gate would publish an updater target nobody approved.
    const publish = getWorkflowJob(releaseWorkflow, 'publish');
    expect(publish).toContain("environment:\n      name: 'production-release'");
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
      // The callee cannot observe this trigger, so the caller must say so.
      'follows_release: true',
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
    expect(syncCallerWorkflow).toContain(
      "concurrency:\n  group: 'desktop-release-sync'\n  cancel-in-progress: false",
    );
    expect(`desktop-release-${calleeFallback}`).not.toBe(
      'desktop-release-sync',
    );
  });

  it('keeps the caller permissions to actions read and contents write', () => {
    expect(syncCallerWorkflow).toContain(
      "permissions:\n  actions: 'read'\n  contents: 'write'",
    );
  });

  it('reports a release-following publish that failed', () => {
    // This path is unattended: a CLI release fires it, nobody watches, and a
    // failure is invisible everywhere else — the feed simply keeps offering
    // the previous desktop version, which looks the same as no release being
    // due. The ECS fleet updater failed five times over three days before its
    // own reporter surfaced it; this is the same guard for the same shape.
    const report = getWorkflowJob(syncCallerWorkflow, 'report_failure');
    expect(report).toContain(
      "if: \"${{ always() && needs.publish.result == 'failure' && github.repository == 'QwenLM/qwen-code' }}\"",
    );
    // Hosted, not the desktop matrix: reporting that the publish path broke
    // must not queue behind the path it is reporting on.
    expect(report).toContain("runs-on: 'ubuntu-latest'");
    // The reporter must run its own copy of the script: a tag cut before the
    // job merged carries no copy of it, so checking out the tag would fail.
    expect(report).toContain("ref: 'main'");
    expect(report).toContain("issues: 'write'");
    expect(report).toContain(
      'bash .github/scripts/desktop-sync-failure-issue.sh',
    );
    expect(report).toContain(
      "RELEASE_TAG: '${{ github.event.release.tag_name }}'",
    );
  });
});

// Replay the reporter under a recording gh stub, the same way the image-build
// reporter's suite does: text pins alone stay green when the body's recovery
// advice or the failed-leg listing drifts away from what the script emits.
const replayable =
  process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0;

describe.skipIf(!replayable)(
  'desktop-sync-failure-issue script behavior',
  () => {
    const runScript = ({ jobs, listFails = false, issues = [] }) => {
      const dir = mkdtempSync(join(tmpdir(), 'desktop-failure-issue-'));
      const callsLog = join(dir, 'calls.log');
      const bodyCapture = join(dir, 'captured-body.md');
      const fixture = join(dir, 'fixture-issues.json');
      const jobsFile = join(dir, 'jobs.json');
      writeFileSync(fixture, JSON.stringify(issues));
      writeFileSync(jobsFile, JSON.stringify(jobs));
      writeFileSync(
        join(dir, 'gh'),
        [
          '#!/bin/bash',
          'echo "gh $*" >> "' + callsLog + '"',
          'prev=""',
          'jqf=""',
          'for arg in "$@"; do',
          '  if [[ "$prev" == "--body-file" ]]; then cp "$arg" "' +
            bodyCapture +
            '"; fi',
          '  if [[ "$prev" == "--jq" ]]; then jqf="$arg"; fi',
          '  prev="$arg"',
          'done',
          'case "$1 $2" in',
          '  "issue list")',
          '    if [[ -n "${STUB_LIST_FAILS:-}" ]]; then exit 1; fi',
          '    cat "' + fixture + '" ;;',
          // The real gh applies --jq itself; the stub must too, or the script
          // would read the raw payload as the leg list.
          '  "api "*) jq -r "$jqf" "' + jobsFile + '" ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      chmodSync(join(dir, 'gh'), 0o755);
      const result = spawnSync(
        'bash',
        ['.github/scripts/desktop-sync-failure-issue.sh'],
        {
          encoding: 'utf8',
          env: {
            PATH: dir + ':' + (process.env.PATH ?? ''),
            REPO: 'QwenLM/qwen-code',
            RUN_ID: '1',
            RUN_URL: 'https://github.com/QwenLM/qwen-code/actions/runs/1',
            RELEASE_TAG: 'v0.23.3',
            DEDUP_LABEL: 'scope/ci-cd',
            RUNNER_TEMP: dir,
            ...(listFails ? { STUB_LIST_FAILS: '1' } : {}),
          },
        },
      );
      return {
        status: result.status,
        calls: existsSync(callsLog) ? readFileSync(callsLog, 'utf8') : '',
        body: existsSync(bodyCapture) ? readFileSync(bodyCapture, 'utf8') : '',
      };
    };

    it('names the failed legs and files a fresh issue when none is tracked', () => {
      const run = runScript({
        jobs: {
          jobs: [
            {
              name: 'Publish desktop for v0.23.3 / build',
              conclusion: 'failure',
            },
            {
              name: 'Publish desktop for v0.23.3 / prepare',
              conclusion: 'skipped',
            },
          ],
        },
      });
      expect(run.status).toBe(0);
      expect(run.body).toContain('- Failed: build');
      // A skipped leg never ran; listing it would claim a build failed that
      // was never started.
      expect(run.body).not.toContain('prepare');
      expect(run.body).toContain('desktop-v0.23.3');
      expect(run.calls).toContain('gh issue create');
      expect(run.calls).not.toContain('gh issue comment');
    });

    it('comments on the tracked issue instead of filing a duplicate', () => {
      const run = runScript({
        jobs: { jobs: [] },
        // The listing is newest-first, so the canonical (oldest) issue is last;
        // the lookup takes last(...) to skip issues that merely quote the marker.
        issues: [
          {
            number: 9,
            body: 'quotes <!-- desktop-release-sync-failure --> in a bug report',
          },
          { number: 7, body: '<!-- desktop-release-sync-failure -->' },
        ],
      });
      expect(run.status).toBe(0);
      // The empty-legs branch: no job reported a failure, so the publish job
      // itself never started.
      expect(run.body).toContain('startup_failure');
      expect(run.calls).toContain('gh issue comment 7');
      expect(run.calls).not.toContain('gh issue create');
    });

    it('still files when the dedup lookup fails', () => {
      const run = runScript({ jobs: { jobs: [] }, listFails: true });
      expect(run.status).toBe(0);
      expect(run.calls).toContain('gh issue create');
    });
  },
);
