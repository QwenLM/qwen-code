/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
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

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
const releaseYaml = parse(workflow);
const cuaReleaseWorkflow = readFileSync(
  '.github/workflows/cd-cua-driver.yml',
  'utf8',
);
const nodeReplPackage = JSON.parse(
  readFileSync('packages/node-repl/package.json', 'utf8'),
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
    expect(nodeReplPackage.version).toBe('0.1.0');
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
    expect(cuaReleaseWorkflow).toContain(
      "needs: ['release', 'publish-sdk', 'publish-node-repl']",
    );
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

// The canonical wipe + user-state neutralization script shared by all five
// 'Restore workspace ownership' copies in release.yml. The full wipe (vs
// serve-ab.yml's keep-and-scrub) is deliberate on this lane: release
// checkouts carry CI_BOT_PAT and the npm OIDC id-token, so no pre-existing
// repo state may survive into them. Pin the WHOLE body by equality, the way
// review-worktree-cleanup-workflow.test.js pins its sweep copies: a
// commented-out find, an inserted early exit, or a uniformly dropped
// ownership ladder all ship green under substring pins, and each of those
// mutants reopens the incident class this step exists for.
const canonicalWipe = `set -uo pipefail
RUNNER_UID="$(id -u)"
RUNNER_GID="$(id -g)"
if [ "$RUNNER_UID" != "0" ]; then
  chown -R "$RUNNER_UID:$RUNNER_GID" "$GITHUB_WORKSPACE" 2>/dev/null || sudo -n chown -R "$RUNNER_UID:$RUNNER_GID" "$GITHUB_WORKSPACE" || echo "::warning::could not restore workspace ownership; checkout may fail on leftover root-owned files"
fi
chmod -R u+rwX "$GITHUB_WORKSPACE" 2>/dev/null || sudo -n chmod -R u+rwX "$GITHUB_WORKSPACE" || echo "::warning::could not restore workspace write permissions; checkout may fail on leftover read-only files"
# Release jobs do not need cross-job workspace reuse: remove every
# persisted entry, including planted .git config/hooks/attributes,
# before actions/checkout runs with release credentials. The full
# wipe — rather than keeping and scrubbing .git like serve-ab.yml —
# is deliberate: these checkouts run with CI_BOT_PAT and the npm
# OIDC id-token, so no pre-existing repo state may survive into
# them; the accepted cost is re-fetching full history each run.
#
# Guards ported from serve-ab.yml's wipe (#9220, #9265): under a
# mangled env even \`/home\` or an empty string reached the rm. A
# wipe pointed at the wrong path is far worse than a skipped wipe,
# so canonicalize, strip trailing slashes, denylist the known
# roots, and require the target to sit inside the runner workspace
# before any rm.
WS="\${GITHUB_WORKSPACE:?}"
while [ "\${WS%/}" != "$WS" ]; do WS="\${WS%/}"; done
RWS="\${RUNNER_WORKSPACE:?}"
RWS="$(realpath -m -- "$RWS" 2>/dev/null)" || { echo "::error::refusing to wipe: realpath unavailable, cannot canonicalize \${RUNNER_WORKSPACE}"; exit 1; }
while [ "\${RWS%/}" != "$RWS" ]; do RWS="\${RWS%/}"; done
if [ -z "$RWS" ]; then echo "::error::refusing to wipe: runner workspace resolved to /"; exit 1; fi
case "$RWS" in
  ..|../*|*/..|*/../*) echo "::error::refusing runner workspace path containing '..': \${RWS}"; exit 1 ;;
esac
# Heal a workspace a previous job replaced with a symlink (or any
# non-directory) BEFORE canonicalizing it: afterwards the path
# resolves to the link's target, the containment below refuses it,
# and every later job on this runner would die here permanently on
# corruption that is itself inside the runner workspace and safe
# to unlink.
if [ -L "$WS" ] || [ ! -d "$WS" ]; then
  # Judge the PARENT, canonicalized: the kernel resolves
  # intermediate components too, so a raw containment match is not
  # enough. Never resolve $WS itself — that would resolve through
  # the very link being removed.
  HEAL_PARENT="$(realpath -m -- "$(dirname -- "$WS")" 2>/dev/null)" || { echo "::error::refusing to heal: realpath unavailable, cannot canonicalize the parent of \${WS}"; exit 1; }
  case "$HEAL_PARENT" in
    "$RWS"|"$RWS"/*) ;;
    *) echo "::error::refusing to heal workspace outside the runner workspace: \${WS} (parent: \${HEAL_PARENT}, runner workspace: \${RWS})"; exit 1 ;;
  esac
  if [ -L "$WS" ]; then
    # The link target is bytes a PREVIOUS job chose — on this pool
    # that job may have run contributor code — and the runner
    # parses \`::\` at the start of any stdout line as a workflow
    # command: keep untrusted bytes off the command line itself,
    # strip the line breaks that could start a new one, and cap
    # the length.
    heal_target="$(readlink -- "$WS" 2>/dev/null || printf '%s' '<unreadable>')"
    heal_target="$(printf '%s' "$heal_target" | tr -d '\\r\\n' | cut -c1-200)"
    echo "::warning::healing workspace \${WS}: it was a symlink"
    printf 'heal: %s pointed at %s\\n' "$WS" "$heal_target"
  else
    echo "::warning::healing workspace \${WS}: it was not a directory"
  fi
  # \`rm -f\` on the RAW path removes the link itself and never
  # follows it. Both legs fail closed: a swallowed failure here
  # would leave the wipe running against a corrupt path.
  rm -f -- "$WS" || { echo "::error::refusing to continue: could not remove \${WS}"; exit 1; }
  mkdir -- "$WS" || { echo "::error::refusing to continue: could not recreate \${WS}"; exit 1; }
fi
WS="$(realpath -m -- "$WS" 2>/dev/null)" || { echo "::error::refusing to wipe: realpath unavailable, cannot canonicalize \${GITHUB_WORKSPACE}"; exit 1; }
while [ "\${WS%/}" != "$WS" ]; do WS="\${WS%/}"; done
case "$WS" in
  ..|../*|*/..|*/../*) echo "::error::refusing to wipe path containing '..': \${WS}"; exit 1 ;;
esac
case "$WS" in
  /|/home|/root|/usr*|/etc*|/var|"") echo "::error::refusing to wipe suspicious workspace path: \${WS}"; exit 1 ;;
esac
# A denylist can only enumerate known roots — the allowlist closes
# every other one (/tmp, /opt, ...): only a directory inside the
# runner workspace may be wiped.
case "$WS" in
  "$RWS"/*) ;;
  *) echo "::error::refusing to wipe workspace outside the runner workspace: \${WS} (runner workspace: \${RWS})"; exit 1 ;;
esac
find "$WS" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
# The workspace wipe cannot see the runner user's HOME, which
# survives across jobs on this pool: a planted ~/.npmrc
# script-shell wraps every verdict-determining \`npm run\` in an
# attacker shell (and can redirect \`npm publish\`), and global git
# config exec knobs (core.hooksPath, filter.*, url.*.insteadOf,
# include.*) govern this job's checkout and credential-bearing
# git steps. Remove the npmrc outright — publish's setup-node
# recreates the registry config it needs after this step — and
# strip the git exec keys with the same denylist as
# qwen-autofix.yml's pre-checkout sanitize and
# .github/scripts/resanitize-git-config.sh (the inline form is the
# pre-checkout doctrine: the script file does not exist on disk
# before checkout). No-op on a fresh hosted runner.
rm -f -- "\${HOME:?}/.npmrc"
git_exec_key_pattern='^(core\\.(hookspath|fsmonitor|pager|editor|sshcommand|askpass|alternaterefscommand|gitproxy)$|diff\\.external$|diff\\..+\\.(command|textconv)$|merge\\..+\\.driver$|filter\\.|alias\\.|pager\\.|difftool\\.|mergetool\\.|interactive\\.difffilter$|sequence\\.editor$|gpg\\.(.+\\.)?program$|init\\.templatedir$|remote\\..+\\.(uploadpack|receivepack)$|submodule\\..+\\.update$|url\\..+\\.(insteadof|pushinsteadof)$|http\\.(.+\\.)?(sslverify|sslcainfo)$|include\\.|includeif\\.|protocol\\.(ext\\.)?allow$)'
for global_file in "\${HOME}/.gitconfig" "\${XDG_CONFIG_HOME:-\${HOME}/.config}/git/config"; do
  [ -e "$global_file" ] || continue
  { GIT_CONFIG_GLOBAL="\${global_file}" git config --global --name-only --list 2>/dev/null || true; } \\
    | { grep -iE "$git_exec_key_pattern" || true; } \\
    | while IFS= read -r key; do GIT_CONFIG_GLOBAL="\${global_file}" git config --global --unset-all "$key" 2>/dev/null || true; done
  remaining_keys="$(GIT_CONFIG_GLOBAL="\${global_file}" git config --global --name-only --list)" || { echo "::error::could not verify the global git config scrub in \${global_file}"; exit 1; }
  if printf '%s\\n' "$remaining_keys" | grep -qiE "$git_exec_key_pattern"; then
    echo "::error::git exec keys survived the pre-checkout scrub in \${global_file}"
    exit 1
  fi
done`;

describe('release workflow', () => {
  it('cleans every shared ECS workspace before checkout', () => {
    const checkoutJobs = Object.entries(releaseYaml.jobs).filter(([, job]) =>
      (job.steps ?? []).some((step) =>
        String(step.uses ?? '').includes('actions/checkout'),
      ),
    );

    expect(checkoutJobs.map(([id]) => id)).toEqual([
      'prepare',
      'quality',
      'integration_none',
      'integration_docker',
      'publish',
    ]);
    for (const [id, job] of checkoutJobs) {
      const restoreIndex = job.steps.findIndex(
        (step) => step.name === 'Restore workspace ownership',
      );
      // The step must stay FIRST: it is the only defence between
      // cross-job-persistent state and every later state read in the job,
      // so a demotion must fail even while it remains ahead of checkout.
      expect(restoreIndex, id).toBe(0);
      const checkoutIndex = job.steps.findIndex((step) =>
        String(step.uses ?? '').includes('actions/checkout'),
      );
      expect(checkoutIndex, id).toBeGreaterThan(0);
      // Full-string equality against the shared constant: commenting out
      // the find, inserting an early exit, or dropping the chown/chmod
      // ladder uniformly from all five copies keeps every substring and
      // equality-across-copies pin green while reopening the incident.
      expect(job.steps[restoreIndex]?.run, id).toBe(canonicalWipe);
    }
  });

  it('fails closed when a global git exec key cannot be removed', () => {
    const base = mkdtempSync(join(tmpdir(), 'release-wipe-'));
    const home = join(base, 'home');
    mkdirSync(home);
    try {
      const env = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
      };
      // An ambient GIT_CONFIG_GLOBAL would redirect `git config --global`
      // (setHook and the post-scrub assertion) away from the synthetic HOME
      // and defeat the hermetic scrub; the sibling scrub harness in
      // qwen-autofix-workflow.test.js deletes it for the same reason.
      delete env['GIT_CONFIG_GLOBAL'];
      const scrubStart = canonicalWipe.indexOf('rm -f -- "${HOME:?}/.npmrc"');
      expect(scrubStart).toBeGreaterThan(0);
      const scrubHome = () =>
        spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', canonicalWipe.slice(scrubStart)],
          { encoding: 'utf8', env },
        );
      const setHook = () =>
        spawnSync(
          'git',
          ['config', '--global', 'core.hooksPath', join(base, 'hooks')],
          { env },
        );

      expect(setHook().status).toBe(0);
      expect(scrubHome().status).toBe(0);
      expect(
        spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], {
          env,
        }).status,
      ).not.toBe(0);

      expect(setHook().status).toBe(0);
      writeFileSync(join(home, '.gitconfig.lock'), '');
      const result = scrubHome();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'git exec keys survived the pre-checkout scrub',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('checks docker availability before the docker checkout', () => {
    const steps = releaseYaml.jobs.integration_docker.steps;
    const preflightIndex = steps.findIndex(
      (step) => step.name === 'Check docker daemon',
    );
    const checkoutIndex = steps.findIndex((step) =>
      String(step.uses ?? '').includes('actions/checkout'),
    );
    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(preflightIndex).toBeLessThan(checkoutIndex);
    // Pin the full fail-closed form, not just a substring: deleting
    // 'exit 1' degrades the preflight to a warning (a dead daemon proceeds
    // into checkout and dies deep in the docker tests), inverting the guard
    // fails every healthy runner, and discarding docker's own output leaves
    // the oncall unable to tell dockerd-down from socket-permission
    // failures without first reaching the runner — all mutants probed
    // green under the old substring pin.
    expect(steps[preflightIndex].run).toMatch(
      /^if ! docker_info_output="\$\(docker info 2>&1\)"; then\n {2}echo "::error::docker daemon is not reachable on this runner; docker integration tests cannot run\."\n {2}printf '%s\\n' "\$docker_info_output"\n {2}exit 1\nfi$/,
    );
  });

  it('bounds shared-pool jobs and skips redundant remote npm caches', () => {
    expect(
      Object.fromEntries(
        [
          'prepare',
          'quality',
          'integration_none',
          'integration_docker',
          'notify_failure',
        ].map((id) => [id, releaseYaml.jobs[id]['timeout-minutes']]),
      ),
    ).toEqual({
      prepare: 30,
      quality: 120,
      integration_none: 120,
      integration_docker: 120,
      notify_failure: 10,
    });

    for (const id of [
      'prepare',
      'quality',
      'integration_none',
      'integration_docker',
      'publish',
    ]) {
      const setupNode = releaseYaml.jobs[id].steps.find((step) =>
        String(step.uses ?? '').includes('actions/setup-node'),
      );
      expect(setupNode?.with.cache, id).toBe(
        "${{ runner.environment != 'self-hosted' && 'npm' || '' }}",
      );
      expect(setupNode?.with['package-manager-cache'], id).toBe(false);
    }
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

describe('release lane runner routing', () => {
  // The exact conditional runs-on the ECS migration routes the release
  // lanes through: repository guard + MAINTAINER_ECS_RUNNER_DISABLED kill
  // switch + both the ecs-qwen and ubuntu-latest branches. Same pinning
  // shape as qwen-autofix-workflow.test.js's heavy-job runs-on tripwire.
  const ecsRunsOn =
    '${{ (github.repository == \'QwenLM/qwen-code\' && vars.MAINTAINER_ECS_RUNNER_DISABLED != \'true\') && fromJSON(\'["self-hosted", "linux", "x64", "ecs-qwen"]\') || fromJSON(\'["ubuntu-latest"]\') }}';

  it('pins every routed release job to the conditional ECS runs-on', () => {
    const conditionalJobs = [
      'prepare',
      'quality',
      'integration_none',
      'integration_docker',
    ];
    for (const name of conditionalJobs) {
      const job = releaseYaml.jobs[name];
      expect(job, `job missing from release.yml: ${name}`).toBeTruthy();
      // Reverting any lane to a hosted runner, dropping the kill-switch
      // clause, or typoing the expression must fail here — an unpinned
      // revert would silently re-pin releases to hosted capacity (the
      // stall this migration exists to fix) or defeat the kill switch.
      expect(job['runs-on'], `runs-on drifted on job: ${name}`).toBe(ecsRunsOn);
    }
  });

  it('keeps publishing and failure notification on hosted runners', () => {
    expect(releaseYaml.jobs.publish['runs-on']).toBe('ubuntu-latest');
    expect(releaseYaml.jobs.publish['runs-on']).not.toContain('ecs-qwen');

    // notify_failure exists to report failures OF the ECS pool; in
    // post-claim pool failures (runner crash, pool-wide loss) its `if:`
    // gate opens while the pool is wedged, so routing it back onto the
    // pool would kill the alert chain. The job is gh/jq-only, so hosted
    // capacity costs nothing — sibling failure notifiers (release-sdk*,
    // release-vscode-companion, qwen-code-pr-review's fallback comment)
    // stay hosted for exactly this reason.
    expect(releaseYaml.jobs.notify_failure['runs-on']).toBe('ubuntu-latest');
    expect(releaseYaml.jobs.notify_failure['runs-on']).not.toContain(
      'ecs-qwen',
    );
  });
});
