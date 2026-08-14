/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
const desktopReleaseWorkflow = readFileSync(
  '.github/workflows/desktop-release.yml',
  'utf8',
);
const liveHostReleaseWorkflow = readFileSync(
  '.github/workflows/live-host-release.yml',
  'utf8',
);
const liveHostCiWorkflow = readFileSync(
  '.github/workflows/live-host.yml',
  'utf8',
);
const liveHostInstaller = readFileSync(
  'packages/cli/src/serve/live/live-host-installer.ts',
  'utf8',
);

describe('release workflow', () => {
  it('fires the fleet-moving npm-published dispatch on stable releases only', () => {
    // This gate is the sole protection keeping a nightly/preview/dry-run
    // release from moving the ECS fleet; the triggered update workflow
    // installs whatever version it is handed, so there is no downstream
    // guard. Pin all three clauses together so dropping or inverting one
    // fails review instead of silently shipping a non-stable fleet.
    expect(workflow).toContain(
      'if: |-\n' +
        "          ${{ github.repository == 'QwenLM/qwen-code' &&\n" +
        "              needs.prepare.outputs.is_dry_run == 'false' &&\n" +
        "              needs.prepare.outputs.npm_tag == 'latest' }}",
    );
    expect(workflow).toContain("-f 'event_type=npm-published'");
    expect(workflow).toContain(
      '-f "client_payload[version]=${RELEASE_VERSION}"',
    );
  });

  it('fails the release when the review source stamp did not land', () => {
    // The runtime staleness check degrades to "could not check" without the
    // stamp this step is guarding. The publish job itself does not re-run
    // the scripts suite — the quality job that gates it does (`npm run
    // test:release` ends with `npm run test:scripts`), but
    // `force_skip_tests: 'true'` skips that job entirely — so a future
    // change that removes the stamp step or this guard must fail here
    // instead of shipping a release that silently lost its digest.
    // The ordering — bundle, then the stamp gate, then packaging — not the
    // gate's prose or indentation: rewording the comment above the check must
    // not fail a test whose subject is the guard itself.
    expect(workflow).toMatch(
      /npm run bundle[\s\S]*?test -f dist\/review-sources\.sha256[\s\S]*?npm run prepare:package/,
    );
  });

  it('force-pushes the release branch so a retry replaces a failed attempt', () => {
    // A failed attempt leaves release/<tag> on an older head, and the
    // retry's divergent bump commit makes a plain push fail as
    // non-fast-forward, blocking every retry of the release. Force is safe
    // only while nothing for this version has shipped, so the push is
    // pinned INSIDE the dry-run guard: the dry-run contract (release.yml's
    // dispatch input) promises no branch is created, and no other test
    // pins this guard — a force push outside it would turn a dry run into
    // a destructive overwrite of the remote branch.
    expect(workflow).toMatch(
      /if \[\[ "\$\{IS_DRY_RUN\}" == "false" \]\]; then[\s\S]*?git push --force --set-upstream origin "\$\{BRANCH_NAME\}" --follow-tags\n {10}else\n {12}echo "Dry run enabled\. Skipping push\."/,
    );
  });

  it('serializes publish jobs per release tag', () => {
    // The pre-push re-validation below is only sound while at most one
    // publish job pushes and publishes a given version at a time; --force
    // removed the non-fast-forward rejection that used to serialize the
    // push itself. The group must sit on the publish job — in-progress
    // runs are never cancelled, and of queued same-tag runs only the
    // latest survives, but whichever run reaches the push re-validates
    // first — and it must be keyed by the computed tag, which only exists
    // as a prepare output, plus is_dry_run, so a dry run (which ships
    // nothing) never queues ahead of the real release for the same tag.
    expect(workflow).toMatch(
      / {2}publish:\n {4}name: 'Publish Release'[\s\S]*?concurrency:\n {6}group: 'release-publish-\$\{\{ needs\.prepare\.outputs\.release_tag \}\}-\$\{\{ needs\.prepare\.outputs\.is_dry_run \}\}'\n {6}cancel-in-progress: false[\s\S]*?environment:\n {6}name: 'production-release'/,
    );
  });

  it('re-validates that the version is still unshipped right before force-pushing', () => {
    // prepare computed and validated the version minutes to hours before
    // this push (the validation jobs and the production-release approval
    // gate sit in between). A concurrent same-version run can ship in that
    // window; the force push would then replace the branch tip that the
    // shipped npm packages, tag, and merge to main anchor to. Pin the
    // re-validation of prepare's invariant directly before the push, and
    // pinned to the script that owns the published-package list so the
    // guard cannot silently drift from it: the call must sit inside the
    // dry-run guard, before the push, as an anchored full line (moving it
    // out of the guard, inverting it, or narrowing it fails), and the
    // step must receive RELEASE_VERSION — without it the check aborts
    // every release — and GITHUB_TOKEN, which its gh release view probe
    // needs: without a token the probe errors, and the guard fails closed
    // on probe errors, so every push would abort. The script-side checks
    // (every published package, the remote tag, the release, aborting on
    // a hit, failing closed on a probe error) are unit-tested in
    // get-release-version.test.js.
    expect(workflow).toMatch(
      /name: 'Commit and Conditionally Push package versions'\n {8}env:\n[\s\S]*?GITHUB_TOKEN: '\$\{\{ github\.token \}\}'[\s\S]*?RELEASE_VERSION: '\$\{\{ needs\.prepare\.outputs\.release_version \}\}'[\s\S]*?if \[\[ "\$\{IS_DRY_RUN\}" == "false" \]\]; then\n[\s\S]*?\n {12}node scripts\/get-release-version\.js --assert-unreleased="\$\{RELEASE_VERSION\}"\n[\s\S]*?git push --force --set-upstream origin "\$\{BRANCH_NAME\}" --follow-tags/,
    );
  });

  it('keeps a dispatch failure from failing an already-published release', () => {
    // The packages are published before this step runs, so it must not fail
    // the release; but the failure must still surface (as an error, not a
    // warning) so the fleet can be reconciled via a manual re-run.
    expect(workflow).toContain(
      'continue-on-error: true\n' +
        '        env:\n' +
        "          GITHUB_TOKEN: '${{ secrets.CI_BOT_PAT }}'",
    );
    expect(workflow).toContain('echo "::error::npm-published dispatch failed;');
  });
});

describe('Live Host release workflow', () => {
  it('publishes the tested and notarized Live Host installer contract', () => {
    expect(desktopReleaseWorkflow).not.toContain('live-host:');
    expect(liveHostReleaseWorkflow).toContain('tag=live-host-v$version');
    expect(liveHostReleaseWorkflow).toContain(
      "LIVE_HOST_FEED_TAG: 'live-host-latest'",
    );
    expect(liveHostReleaseWorkflow).toContain(
      "run: 'bun run live-host:typecheck && bun run live-host:test'",
    );
    expect(liveHostReleaseWorkflow).toContain(
      "run: 'bun run live-host:dist:mac:no-publish'",
    );
    expect(liveHostReleaseWorkflow).toContain(
      'codesign --verify --deep --strict',
    );
    expect(liveHostReleaseWorkflow).toContain('xcrun stapler validate');
    expect(liveHostReleaseWorkflow).toContain(
      'packages/desktop/apps/live-host/release/*.dmg',
    );

    for (const asset of [
      'Qwen-Live-Host-manifest.json',
      'Qwen-Live-Host-arm64.zip',
      'Qwen-Live-Host-x64.zip',
    ]) {
      expect(liveHostReleaseWorkflow).toContain(`release-assets/${asset}`);
      expect(liveHostInstaller).toContain(asset);
    }
    expect(liveHostInstaller).toContain(
      'https://github.com/QwenLM/qwen-code/releases/download/live-host-latest',
    );
  });

  it('accepts the repository macOS signing and notarization secrets', () => {
    for (const secret of [
      'MAC_CSC_LINK',
      'MAC_CSC_KEY_PASSWORD',
      'APPLE_NOTARY_ISSUER_ID',
      'APPLE_NOTARY_KEY_ID',
      'APPLE_NOTARY_API_KEY_P8_BASE64',
      'APPLE_TEAM_ID',
    ]) {
      expect(liveHostReleaseWorkflow).toContain(`secrets.${secret}`);
    }
    expect(liveHostReleaseWorkflow).toContain(
      'keychain_password="${KEYCHAIN_PASSWORD:-$(openssl rand -hex 32)}"',
    );
    expect(liveHostReleaseWorkflow).toContain(
      'certificate_data="${certificate_data#*base64,}"',
    );
    expect(liveHostReleaseWorkflow).toContain(
      'printf \'%s\' "$LEGACY_APPLE_API_KEY_P8" | base64 --decode > "$key_path"',
    );
    expect(liveHostReleaseWorkflow).toContain('echo "APPLE_API_KEY=$key_path"');
    expect(liveHostReleaseWorkflow).toContain(
      'echo "APPLE_API_KEY_ID=$api_key_id"',
    );
    expect(liveHostReleaseWorkflow).toContain(
      'identity_name="${identity#Developer ID Application: }"',
    );
    expect(liveHostReleaseWorkflow).toContain('echo "CSC_NAME=$identity_name"');
    expect(liveHostReleaseWorkflow).not.toContain('echo "CSC_NAME=$identity"');
  });
});

describe('Live Host CI workflow', () => {
  it('replaces partial package signatures before strict verification', () => {
    expect(liveHostCiWorkflow).toContain(
      'codesign --force --deep --sign - --entitlements',
    );
    expect(liveHostCiWorkflow).not.toContain('if ! /usr/bin/codesign -d');
  });
});
