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

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
const cuaReleaseWorkflow = readFileSync(
  '.github/workflows/cd-cua-driver.yml',
  'utf8',
);
const nodeReplPackage = JSON.parse(
  readFileSync('packages/node-repl/package.json', 'utf8'),
);
const cuaSdkPackage = JSON.parse(
  readFileSync('packages/cua-driver/typescript/package.json', 'utf8'),
);
const cuaInstallScript = readFileSync(
  'packages/cua-driver/scripts/install.sh',
  'utf8',
);
const computerUseGuide = readFileSync(
  'docs/users/features/computer-use.md',
  'utf8',
);
const desktopReleaseWorkflow = readFileSync(
  '.github/workflows/desktop-release.yml',
  'utf8',
);
const liveHostInstaller = readFileSync(
  'packages/cli/src/serve/live/live-host-installer.ts',
  'utf8',
);
const liveHostCiWorkflow = readFileSync(
  '.github/workflows/live-host.yml',
  'utf8',
);
const liveHostReleaseWorkflow = readFileSync(
  '.github/workflows/live-host-release.yml',
  'utf8',
);
const liveHostOssWorkflow = readFileSync(
  '.github/workflows/sync-live-host-to-oss.yml',
  'utf8',
);

describe('CUA release workflow', () => {
  it('keeps the Node REPL package independently versioned', () => {
    expect(nodeReplPackage.name).toBe('@qwen-code/node-repl-mcp');
    expect(nodeReplPackage.version).toBe('0.1.1');
    expect(cuaReleaseWorkflow).toContain(
      "node_repl_version: '${{ steps.release.outputs.node_repl_version }}'",
    );
    expect(cuaReleaseWorkflow).not.toContain(
      'NODE_REPL_VERSION does not match release version',
    );
  });

  it('dry-runs and clean-installs the packed Node REPL MCP server', () => {
    expect(cuaReleaseWorkflow).toMatch(
      /verify-node-repl-package:[\s\S]*?npm ci --ignore-scripts[\s\S]*?npm run typecheck[\s\S]*?npm test[\s\S]*?npm run smoke:mcp[\s\S]*?npm run smoke:lifecycle[\s\S]*?node packages\/node-repl\/scripts\/verify-package\.mjs[\s\S]*?node-repl-mcp-npm-\$\{\{[\s\S]*?node_repl_version/,
    );
  });

  it('publishes the verified Node REPL tarball immutably with provenance', () => {
    expect(cuaReleaseWorkflow).toMatch(
      /publish-node-repl:[\s\S]*?needs: \['validate-version', 'verify-node-repl-package', 'release'\][\s\S]*?npm view "@qwen-code\/node-repl-mcp@\$\{VERSION\}" dist\.integrity[\s\S]*?npm publish "\$TARBALL" --provenance --access public --tag "\$NPM_TAG"[\s\S]*?Verify npm registry integrity/,
    );
  });

  it('keeps installer version changes in the feature PR', () => {
    expect(cuaReleaseWorkflow).not.toContain('sync-installer-version:');
    expect(cuaReleaseWorkflow).not.toContain('gh pr create');
    expect(cuaReleaseWorkflow).not.toContain('gh pr merge');
    expect(cuaInstallScript).toContain(
      `CUA_DRIVER_RS_VERSION=${cuaSdkPackage.version}`,
    );
    expect(cuaInstallScript).toContain(
      `CUA_DRIVER_VERSION=${cuaSdkPackage.version}`,
    );
    expect(cuaReleaseWorkflow).toContain(
      'INSTALL_ENTRYPOINT_RS_VERSION=$(sed -nE',
    );
  });

  it('pins exact Computer Use package versions across the skill and user guide', () => {
    expect(computerUseGuide).toContain(
      `@qwen-code/node-repl-mcp@${nodeReplPackage.version}`,
    );
    expect(computerUseGuide).toContain(
      `@qwen-code/cua-sdk@${cuaSdkPackage.version}`,
    );
    expect(cuaReleaseWorkflow).toContain('SKILL_NODE_REPL_VERSION=$(sed -nE');
    expect(cuaReleaseWorkflow).toContain(
      'USER_GUIDE_NODE_REPL_VERSION=$(sed -nE',
    );
    expect(cuaReleaseWorkflow).toContain('SKILL_SDK_VERSION=$(sed -nE');
    expect(cuaReleaseWorkflow).toContain('USER_GUIDE_SDK_VERSION=$(sed -nE');
    expect(cuaReleaseWorkflow).not.toContain(
      'grep -Fq "@qwen-code/node-repl-mcp@',
    );
    expect(cuaReleaseWorkflow).not.toContain('grep -Fq "@qwen-code/cua-sdk@');
  });

  it('bootstraps only Node REPL without replacing an existing CUA release', () => {
    expect(cuaReleaseWorkflow).toMatch(
      /node_repl_only:[\s\S]*?type: 'boolean'[\s\S]*?default: false/,
    );
    expect(cuaReleaseWorkflow).toMatch(
      /publish-node-repl:[\s\S]*?needs\.release\.result == 'success'[\s\S]*?inputs\.node_repl_only == true[\s\S]*?inputs\.dry_run == false/,
    );
    expect(cuaReleaseWorkflow).toContain(
      'A production dispatch must run from protected main',
    );
  });
});

describe('release workflow', () => {
  it('stages every integration package manifest after versioning', () => {
    expect(workflow).toContain(
      'git add package.json package-lock.json packages/*/package.json packages/channels/*/package.json integrations/*/package.json',
    );
  });

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
    // timeout-minutes bounds the hold a wedged publish (a stalled npm
    // publish or asset upload) keeps on the group: without it the GitHub
    // default of 360 minutes leaves same-tag retries queued behind it,
    // unable to run, fail, or notify.
    expect(workflow).toMatch(
      / {2}publish:\n {4}name: 'Publish Release'[\s\S]*?concurrency:\n {6}group: 'release-publish-\$\{\{ needs\.prepare\.outputs\.release_tag \}\}-\$\{\{ needs\.prepare\.outputs\.is_dry_run \}\}'\n {6}cancel-in-progress: false\n {4}timeout-minutes: 90\n {4}environment:\n {6}name: 'production-release'/,
    );
  });

  it('refuses the force push when the checked-out ref predates the guard', () => {
    // The guard runs scripts/get-release-version.js from the checked-out
    // ref — the operator-controlled dispatch input `ref` — and a pre-PR
    // ref's entry point ignores --assert-unreleased, prints version JSON,
    // and exits 0 (probed against the merge base), so GUARD_STATUS=0
    // would read as "unreleased verified" while the guard never ran. Pin
    // the capability check that fails closed instead: inside the dry-run
    // guard, ahead of the guard invocation, refusing with a plain
    // failure so the run notifies instead of force-pushing unverified.
    expect(workflow).toMatch(
      /if \[\[ "\$\{IS_DRY_RUN\}" == "false" \]\]; then[\s\S]*?if ! grep -q "assert-unreleased" scripts\/get-release-version\.js; then\n {14}echo "::error::Checked-out ref predates the push-time guard; refusing force push\."\n {14}exit 1\n {12}fi[\s\S]*?for attempt in 1 2 3; do\n {14}GUARD_STATUS=0\n {14}node scripts\/get-release-version\.js --assert-unreleased="\$\{RELEASE_VERSION\}" \|\| GUARD_STATUS=\$\?/,
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
    // get-release-version.test.js. The `|| GUARD_STATUS=$?` suffix is
    // pinned too: notify_failure's refusal gate reads the guard's exit
    // code through it, and the retry loop is pinned around the call:
    // GUARD_STATUS is reset each attempt and only exit 2 (a probe
    // failure) retries — exit 0 and exit 3 stay decisive on the first
    // attempt.
    expect(workflow).toMatch(
      /name: 'Commit and Conditionally Push package versions'\n {8}id: 'push_release_branch'\n {8}env:\n[\s\S]*?GITHUB_TOKEN: '\$\{\{ github\.token \}\}'[\s\S]*?RELEASE_VERSION: '\$\{\{ needs\.prepare\.outputs\.release_version \}\}'[\s\S]*?if \[\[ "\$\{IS_DRY_RUN\}" == "false" \]\]; then\n[\s\S]*?for attempt in 1 2 3; do\n {14}GUARD_STATUS=0\n {14}node scripts\/get-release-version\.js --assert-unreleased="\$\{RELEASE_VERSION\}" \|\| GUARD_STATUS=\$\?\n[\s\S]*?git push --force --set-upstream origin "\$\{BRANCH_NAME\}" --follow-tags/,
    );
  });

  it('keeps a decisive version refusal out of the release-failed notification', () => {
    // The guard's exit 3 means the version already shipped (fully or
    // partially) — a correct refusal, not a release failure. The step
    // must turn exactly that exit into the version_refusal marker, the
    // publish job must export the marker, and notify_failure must skip
    // its "Release Failed" issue + autofix dispatch for it — while any
    // other guard exit (a fail-closed probe error) and every later
    // publish failure still notify — including through the propagation
    // branch pinned verbatim below: without it a probe failure falls
    // through to the force push unverified.
    expect(workflow).toMatch(
      /node scripts\/get-release-version\.js --assert-unreleased="\$\{RELEASE_VERSION\}" \|\| GUARD_STATUS=\$\?[\s\S]*?if \[\[ "\$\{GUARD_STATUS\}" -eq 3 \]\]; then\n {14}echo "version_refusal=true" >> "\$\{GITHUB_OUTPUT\}"\n {14}exit 1\n {12}fi\n {12}if \[\[ "\$\{GUARD_STATUS\}" -ne 0 \]\]; then\n {14}exit "\$\{GUARD_STATUS\}"\n {12}fi/,
    );
    expect(workflow).toContain(
      "version_refusal: '${{ steps.push_release_branch.outputs.version_refusal }}'",
    );
    expect(workflow).toMatch(
      /needs\.publish\.result == 'failure' &&\n {12}needs\.publish\.outputs\.version_refusal != 'true'/,
    );
  });

  it('wires the guard exit code to the process exit status end to end', () => {
    // The workflow reads the guard's decision from the process exit
    // status. Run the real entry point without mocks — a usage error
    // needs no network — so an inverted or dropped process.exit fails
    // here instead of letting a refusal exit 0 at push time.
    const result = spawnSync(
      process.execPath,
      ['scripts/get-release-version.js', '--assert-unreleased='],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      '::error::assert-unreleased requires a version',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'exits 3 from the real entry point when the version already shipped',
    () => {
      // The workflow reads the refusal through the entry-point exit-status
      // glue, not through runCli(); the usage-error test above never
      // exercises exit 3. A stub npm on PATH that echoes the probed
      // version makes the strict npm scan report "shipped" without
      // network, so an entry point that swallowed exit 3 fails here
      // instead of reading as GUARD_STATUS=0 at push time. The stub is a
      // '#!/bin/sh' script prepended to PATH with ':' — unresolvable on
      // Windows, so win32 skips it and Linux CI remains the authoritative
      // coverage.
      const stubDir = mkdtempSync(join(tmpdir(), 'npm-stub-'));
      writeFileSync(join(stubDir, 'npm'), '#!/bin/sh\necho "${2##*@}"\n', {
        mode: 0o755,
      });
      const result = spawnSync(
        process.execPath,
        ['scripts/get-release-version.js', '--assert-unreleased=1.2.3'],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
        },
      );
      expect(result.status).toBe(3);
      expect(result.stdout).toContain('has already shipped');
    },
  );

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

describe('Live Host feed contract', () => {
  it('keeps Live Host releases independent from desktop releases', () => {
    expect(desktopReleaseWorkflow).not.toContain('live-host:');
    expect(liveHostReleaseWorkflow).toContain(
      "working-directory: 'packages/live-host'",
    );
    expect(liveHostReleaseWorkflow).toContain(
      "run: 'npm run dist:mac:no-publish'",
    );
  });

  it('resolves the ASAR verifier through the standalone package', () => {
    expect(liveHostCiWorkflow).toContain('npx --no-install asar list');
    expect(liveHostCiWorkflow).toContain('npx --no-install asar extract');
    expect(liveHostCiWorkflow).not.toContain(
      'node_modules/@electron/asar/bin/asar.mjs',
    );
  });

  it('keeps a producer and recovery path for every installer asset', () => {
    for (const asset of [
      'Qwen-Live-Host-manifest.json',
      'Qwen-Live-Host-arm64.zip',
      'Qwen-Live-Host-x64.zip',
    ]) {
      expect(liveHostInstaller).toContain(asset);
      expect(liveHostReleaseWorkflow).toContain(asset);
      expect(liveHostOssWorkflow).toContain(asset);
    }
    expect(liveHostInstaller).toContain(
      'https://github.com/QwenLM/qwen-code/releases/download/live-host-latest',
    );
    expect(liveHostReleaseWorkflow).toContain(
      "FEED_TAG: '${{ env.LIVE_HOST_FEED_TAG }}'",
    );
    expect(liveHostOssWorkflow).toContain(
      "gh release download 'live-host-latest'",
    );
  });
});
