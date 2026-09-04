/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REQUIRED_JOBS } from '../verify-nightly-promotion.js';
import { getWorkspacePackageJsonPaths } from '../workspaces.js';

// `realpath -m` (the script's canonicalization line) is a GNU coreutils
// extension. Probe the host before asserting GNU-specific path behavior.
const hasGnuRealpath =
  spawnSync('realpath', ['-m', '--', '/'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('realpath', ['-m', '-s', '--', '/'], { stdio: 'ignore' }).status ===
    0;

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
const promotionScript = readFileSync(
  'scripts/verify-nightly-promotion.js',
  'utf8',
);
const releaseYaml = parse(workflow);
const audioCapturePrebuildsYaml = parse(
  readFileSync('.github/workflows/audio-capture-prebuilds.yml', 'utf8'),
);
const cuaReleaseWorkflow = readFileSync(
  '.github/workflows/cd-cua-driver.yml',
  'utf8',
);
const nodeReplPackage = JSON.parse(
  readFileSync('packages/node-repl/package.json', 'utf8'),
);
const rootPackageLock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const cuaSdkPackage = JSON.parse(
  readFileSync('packages/cua-driver/typescript/package.json', 'utf8'),
);
const cuaSdkPackageLock = JSON.parse(
  readFileSync('packages/cua-driver/typescript/package-lock.json', 'utf8'),
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
    expect(nodeReplPackage.version).toBe('0.1.2');
    expect(cuaReleaseWorkflow).toContain(
      "node_repl_version: '${{ steps.release.outputs.node_repl_version }}'",
    );
    expect(cuaReleaseWorkflow).not.toContain(
      'NODE_REPL_VERSION does not match release version',
    );
    expect(rootPackageLock.packages['packages/node-repl'].version).toBe(
      nodeReplPackage.version,
    );
    expect(cuaSdkPackageLock.version).toBe(cuaSdkPackage.version);
    expect(cuaSdkPackageLock.packages[''].version).toBe(cuaSdkPackage.version);
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

  it('ships the Windows UIAccess worker for target-machine signing', () => {
    expect(cuaReleaseWorkflow).toMatch(
      /Build \(release\)[\s\S]*?Remove-Item[^\n]*cua-driver-uia\.exe[^\n]*\n[^\n]*cargo build[\s\S]*?Verify unsigned UIAccess worker/,
    );
    expect(cuaReleaseWorkflow).toMatch(
      /Build \(release\)[\s\S]*?Verify unsigned UIAccess worker[\s\S]*?Get-AuthenticodeSignature[\s\S]*?NotSigned[\s\S]*?qwen-cua-driver-uia\.exe[\s\S]*?release artifact contract/,
    );
    expect(cuaReleaseWorkflow).not.toMatch(/WINDOWS_CERTIFICATE|WIN_CSC_LINK/);
    expect(cuaReleaseWorkflow).toContain(
      '- **Windows**: unsigned UIAccess worker + native SDK payload',
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

// The canonical workspace restoration script shared by all nine
// 'Restore workspace ownership' copies in release.yml. The full wipe (vs
// serve-ab.yml's keep-and-scrub) is deliberate on this lane: release
// checkouts carry CI_BOT_PAT and the npm OIDC id-token, so no pre-existing
// repo state may survive into them. Pin the WHOLE body by equality, the way
// review-worktree-cleanup-workflow.test.js pins its sweep copies: a
// commented-out find, an inserted early exit, or a uniformly dropped
// ownership ladder all ship green under substring pins, and each of those
// mutants reopens the incident class this step exists for.
const canonicalWipe = `set -uo pipefail
# Release jobs do not need cross-job workspace reuse: remove every
# persisted entry, including planted .git config/hooks/attributes,
# before actions/checkout runs with release credentials. The full
# wipe — rather than keeping and scrubbing .git like serve-ab.yml —
# is deliberate: these checkouts run with CI_BOT_PAT and the npm
# OIDC id-token, so no pre-existing repo state may survive into
# them; the accepted cost is fetching a fresh ref each run.
#
# Guards ported from serve-ab.yml's wipe (#9220, #9265): under a
# mangled env even \`/home\` or an empty string reached the rm. A
# wipe pointed at the wrong path is far worse than a skipped wipe,
# so canonicalize, strip trailing slashes, denylist the known
# roots, and require the target to sit inside the runner workspace
# before any rm.
#
# Validate the geometry BEFORE touching anything: the chown/chmod
# ladder and the wipe must never follow a runner workspace a previous
# pool job — which may have run contributor code — replaced with a
# symlink, so refuse one outright; and no ownership/permission change
# may run on a path the containment below has not accepted.
RWS="\${RUNNER_WORKSPACE:?}"
while [ "\${RWS%/}" != "$RWS" ]; do RWS="\${RWS%/}"; done
if [ -L "$RWS" ]; then
  echo "::error::refusing to wipe: runner workspace is a symlink: \${RWS}"
  exit 1
fi
# \`-L\` only sees the LEAF: the kernel resolves intermediate
# components too, so compare the symlink-blind lexical form
# against the full canonicalization — any difference means some
# component was a symlink re-rooting the whole chain below
# (heal, allow-list, wipe) at the link's target.
RWS_LEX="$(realpath -m -s -- "$RWS" 2>/dev/null)" || { echo "::error::refusing to wipe: realpath unavailable, cannot canonicalize \${RUNNER_WORKSPACE}"; exit 1; }
RWS="$(realpath -m -- "$RWS" 2>/dev/null)" || { echo "::error::refusing to wipe: realpath unavailable, cannot canonicalize \${RUNNER_WORKSPACE}"; exit 1; }
if [ "$RWS" != "$RWS_LEX" ]; then
  echo "::error::refusing to wipe: runner workspace resolves through a symlinked component: \${RWS_LEX} resolves to \${RWS}"
  exit 1
fi
while [ "\${RWS%/}" != "$RWS" ]; do RWS="\${RWS%/}"; done
if [ -z "$RWS" ]; then echo "::error::refusing to wipe: runner workspace resolved to /"; exit 1; fi
case "$RWS" in
  ..|../*|*/..|*/../*) echo "::error::refusing runner workspace path containing '..': \${RWS}"; exit 1 ;;
esac
WS="\${GITHUB_WORKSPACE:?}"
while [ "\${WS%/}" != "$WS" ]; do WS="\${WS%/}"; done
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
# Heal only guarantees the LEAF is real; a symlinked component
# between the runner workspace and the leaf re-roots the
# containment below the same way, so apply the same comparison.
WS_LEX="$(realpath -m -s -- "$WS" 2>/dev/null)" || { echo "::error::refusing to wipe: realpath unavailable, cannot canonicalize \${GITHUB_WORKSPACE}"; exit 1; }
WS="$(realpath -m -- "$WS" 2>/dev/null)" || { echo "::error::refusing to wipe: realpath unavailable, cannot canonicalize \${GITHUB_WORKSPACE}"; exit 1; }
if [ "$WS" != "$WS_LEX" ]; then
  echo "::error::refusing to wipe: workspace resolves through a symlinked component: \${WS_LEX} resolves to \${WS}"
  exit 1
fi
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
# Geometry validated — only now may ownership/permissions change.
# Shared ECS runners can retain root-owned files from an earlier
# containerized job; restore them so the wipe and checkout succeed.
RUNNER_UID="$(id -u)"
RUNNER_GID="$(id -g)"
if [ "$RUNNER_UID" != "0" ]; then
  chown -R "$RUNNER_UID:$RUNNER_GID" "$GITHUB_WORKSPACE" 2>/dev/null || sudo -n chown -R "$RUNNER_UID:$RUNNER_GID" "$GITHUB_WORKSPACE" || echo "::warning::could not restore workspace ownership; checkout may fail on leftover root-owned files"
fi
# The validation above guarantees $GITHUB_WORKSPACE is a real directory
# inside the runner workspace (a symlinked leaf was healed, a symlinked
# runner workspace refused), so the recursive chmod cannot escape it.
chmod -R u+rwX "$GITHUB_WORKSPACE" 2>/dev/null || sudo -n chmod -R u+rwX "$GITHUB_WORKSPACE" || echo "::warning::could not restore workspace write permissions; checkout may fail on leftover read-only files"
find "$WS" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
# Later steps must not read pool-persistent Git, npm, Docker, or
# gh state. A fresh directory avoids an unbounded scrub denylist
# and stale lock files before checkout runs.
#
# The pool-wide RUNNER_TOOL_CACHE stays untouched ON PURPOSE:
# lanes in three other pool workflows (qwen-autofix.yml's
# issue-autofix/build-cli/review-address, serve-ab.yml's ab,
# repo-hygiene.yml's dedup lane) resolve Node from it through
# un-gated setup-node, while the pool-routed release jobs never
# read the tool cache — their pool path is PATH Node via
# .github/actions/self-hosted-node. Purging \`_tool/node\` here
# would strip Node out from under the next such job on this
# member, and nodejs.org may be unreachable through the pool's
# egress proxy.
release_state="$(mktemp -d "\${RUNNER_TEMP:?}/release-state.XXXXXX")" || exit 1
: > "\${release_state}/gitconfig" || exit 1
: > "\${release_state}/npmrc" || exit 1
mkdir "\${release_state}/docker" || exit 1
# gh reads $HOME/.config/gh across pool jobs: a prior job could
# plant a config.yml with http_unix_socket there and capture the
# token a later \`gh\` call sends — qwen-autofix.yml isolates
# GH_CONFIG_DIR the same way.
mkdir "\${release_state}/gh" || exit 1
{
  echo 'GIT_CONFIG_COUNT=0'
  echo 'GIT_CONFIG_NOSYSTEM=1'
  echo 'GIT_CONFIG_PARAMETERS='
  echo "GIT_CONFIG_GLOBAL=\${release_state}/gitconfig"
  echo "NPM_CONFIG_USERCONFIG=\${release_state}/npmrc"
  echo "DOCKER_CONFIG=\${release_state}/docker"
  echo "GH_CONFIG_DIR=\${release_state}/gh"
} >> "\${GITHUB_ENV:?}"`;

describe('release workflow', () => {
  // The shard-completeness pin and the zero-test ratchet must gate on the
  // same workspace set, so resolve it once through
  // getWorkspacePackageJsonPaths -- the same resolver scripts/clean.js
  // consumes -- instead of letting each test carry its own selection copy.
  const getTestCiWorkspaces = () => {
    const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
    return getWorkspacePackageJsonPaths(process.cwd(), rootPackage.workspaces)
      .map((path) => [path, JSON.parse(readFileSync(path, 'utf8'))])
      .filter(([, packageJson]) => packageJson.scripts?.['test:ci']);
  };

  it('cleans every shared ECS workspace before checkout', () => {
    const checkoutJobs = Object.entries(releaseYaml.jobs).filter(([, job]) =>
      (job.steps ?? []).some((step) =>
        String(step.uses ?? '').includes('actions/checkout'),
      ),
    );

    expect(checkoutJobs.map(([id]) => id)).toEqual([
      'prepare',
      'quality_static',
      'quality_build',
      'quality_typecheck',
      'workspace_tests',
      'quality_scripts',
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
      expect(job.steps[restoreIndex]?.if, id).toBe(
        "${{ runner.environment == 'self-hosted' }}",
      );
      const checkoutIndex = job.steps.findIndex((step) =>
        String(step.uses ?? '').includes('actions/checkout'),
      );
      expect(checkoutIndex, id).toBeGreaterThan(0);
      // Full-string equality against the shared constant: commenting out
      // the find, inserting an early exit, or dropping the chown/chmod
      // ladder uniformly from all nine copies keeps every substring and
      // equality-across-copies pin green while reopening the incident.
      expect(job.steps[restoreIndex]?.run, id).toBe(canonicalWipe);
    }
  });

  it('uses shallow history only for validation jobs', () => {
    const checkoutDepth = (id) =>
      releaseYaml.jobs[id].steps.find((step) =>
        String(step.uses ?? '').includes('actions/checkout'),
      ).with['fetch-depth'];

    expect(checkoutDepth('prepare')).toBe(0);
    expect(checkoutDepth('publish')).toBe(0);
    for (const id of [
      'quality_static',
      'quality_build',
      'quality_typecheck',
      'workspace_tests',
      'quality_scripts',
      'integration_none',
      'integration_docker',
    ]) {
      expect(checkoutDepth(id), id).toBe(1);
    }
  });

  it('pins validation and publishing to the commit resolved by prepare', () => {
    expect(releaseYaml.jobs.prepare.outputs.release_sha).toBe(
      '${{ steps.source.outputs.release_sha }}',
    );
    const sourceStep = releaseYaml.jobs.prepare.steps.find(
      (step) => step.id === 'source',
    );
    expect(sourceStep.run).toContain('git rev-parse HEAD');

    for (const id of [
      'quality_static',
      'quality_build',
      'quality_typecheck',
      'workspace_tests',
      'quality_scripts',
      'integration_none',
      'integration_docker',
      'publish',
    ]) {
      const checkout = releaseYaml.jobs[id].steps.find((step) =>
        String(step.uses ?? '').includes('actions/checkout'),
      );
      expect(checkout.with.ref, id).toBe(
        '${{ needs.prepare.outputs.release_sha }}',
      );
      // The ref expression only resolves when the consumer declares prepare
      // in needs; without the edge it evaluates to '' and checkout silently
      // falls back to the event ref (the moving branch tip at fetch time).
      expect([].concat(releaseYaml.jobs[id].needs ?? []), id).toContain(
        'prepare',
      );
    }
  });

  it('allows build artifact replacement when all jobs are rerun', () => {
    const upload = releaseYaml.jobs.quality_build.steps.find((step) =>
      String(step.uses ?? '').includes('actions/upload-artifact'),
    );
    expect(upload.with.name).toBe('release-quality-build');
    expect(upload.with.overwrite).toBe(true);
  });

  it('keeps the build artifact alive long enough for re-run failed jobs', () => {
    const upload = releaseYaml.jobs.quality_build.steps.find((step) =>
      String(step.uses ?? '').includes('actions/upload-artifact'),
    );
    // "Re-run failed jobs" more than a day later does not re-run the
    // succeeded producer; with retention-days: 1 its artifact is already
    // expired and every consumer fails the download. Three days keeps the
    // re-run path recoverable without paying for long-term storage.
    expect(upload.with['retention-days']).toBe(3);
  });

  it('downloads and unpacks the build artifact in every consumer job', () => {
    // The build-once contract has one producer and three consumers; the
    // upload pin alone leaves a consumer free to drop the download/unpack
    // and silently test a checkout without build outputs.
    for (const id of [
      'quality_typecheck',
      'workspace_tests',
      'quality_scripts',
    ]) {
      const steps = releaseYaml.jobs[id].steps;
      // The download only waits for the upload when the needs edge
      // exists; without it the consumer races the producer.
      expect([].concat(releaseYaml.jobs[id].needs ?? []), id).toContain(
        'quality_build',
      );
      const downloadIndex = steps.findIndex((step) =>
        String(step.uses ?? '').includes('actions/download-artifact'),
      );
      expect(
        downloadIndex,
        `${id} lost the build download step`,
      ).toBeGreaterThanOrEqual(0);
      expect(steps[downloadIndex].with.name, id).toBe('release-quality-build');
      expect(steps[downloadIndex].with.path, id).toBe(
        '${{ runner.temp }}/release-quality-build',
      );
      const unpackIndex = steps.findIndex(
        (step) => step.name === 'Unpack Build Outputs',
      );
      // Unpack must stay after download: reversed, tar would read a path
      // that does not exist yet.
      expect(unpackIndex, id).toBeGreaterThan(downloadIndex);
      expect(steps[unpackIndex].run, id).toBe(
        'tar -xzf "${RUNNER_TEMP}/release-quality-build/release-build.tgz"',
      );
    }
  });

  it('shares generated web templates with build consumers', () => {
    const pack = releaseYaml.jobs.quality_build.steps.find(
      (step) => step.name === 'Pack Build Outputs',
    );
    expect(pack.run).toContain('packages/web-templates/src/generated');
    // npm ci leaves nested dependency dist dirs under workspace
    // node_modules; the find must prune them so only real build outputs
    // travel in release-quality-build.
    expect(pack.run).toContain('-type d -name node_modules -prune');
    // Log what is packed and fail closed on a silent under-pack: a dropped
    // `-o` in the find turns the two -prune clauses into one conjunction
    // that matches nothing, and tar would then ship only the two hardcoded
    // paths while the symptom lands in downstream consumers.
    expect(pack.run).toContain('printf');
    expect(pack.run).toContain('${#build_paths[@]} -gt 2');
  });

  it('keeps the dist producer ahead of the pack step', () => {
    // Pack hardcodes the repo-root `dist`, which only exists as a side
    // effect of check:serve-fast-path-bundle (the check runs the esbuild
    // bundle with outdir dist; scripts/build.js never writes it). The
    // dependency must stay documented and ordered: moving the check after
    // Pack, or dropping it, leaves tar without the bundle outputs.
    const names = releaseYaml.jobs.quality_build.steps.map((step) => step.name);
    const producer = names.indexOf('Check Serve Fast Path Bundle');
    const pack = names.indexOf('Pack Build Outputs');
    expect(producer).toBeGreaterThanOrEqual(0);
    expect(pack).toBeGreaterThan(producer);
    expect(workflow).toContain(
      '# This step also materializes the repo-root `dist` that Pack Build',
    );
    const packStep = releaseYaml.jobs.quality_build.steps.find(
      (step) => step.name === 'Pack Build Outputs',
    );
    expect(packStep.run).toContain(
      "build_paths=('dist' 'packages/web-templates/src/generated')",
    );
  });

  it('fans workspace tests into three complete Vitest shards', () => {
    const job = releaseYaml.jobs.workspace_tests;
    expect(job.strategy).toEqual({
      'fail-fast': false,
      matrix: { shard: [1, 2, 3] },
    });
    const testStep = job.steps.find(
      (step) => step.name === 'Run Workspace Tests',
    );
    expect(testStep.run).toContain(
      'npm run test:release:workspaces -- --shard=${{ matrix.shard }}/3 --passWithNoTests "${retry_arg[@]}"',
    );
    expect(testStep.run).toContain('::warning title=Workspace tests exited');
    // Every release schedule retries, stable included: running the stable
    // lane with no retry let one flaky test out of ~30k red a release whose
    // other gates were all green. The default is pinned here so a silent
    // drop back to a no-retry stable lane fails this test.
    expect(testStep.env.VITEST_RETRY).toBe(
      "${{ vars.QWEN_RELEASE_VITEST_RETRY || '2' }}",
    );

    const workspacePackages = getTestCiWorkspaces();

    expect(workspacePackages.length).toBeGreaterThan(0);
    for (const [path, packageJson] of workspacePackages) {
      // test:release:workspaces appends --shard/--passWithNoTests to the
      // script body, so the flags only reach vitest when the vitest
      // invocation is the LAST command in the chain; commands before it
      // (e.g. sdk-typescript's typecheck:public-surface) stay accepted.
      expect(
        packageJson.scripts['test:ci'].split('&&').pop()?.trim(),
        path,
      ).toMatch(/^vitest run(?:\s|$)/);
    }
  });

  it('passes --retry unless the operator switched it off', () => {
    // The flag reaches every workspace's vitest, where a command line option
    // outranks the config. Every schedule now retries by default; the only
    // way off is the operator sentinel, and it must omit the flag rather
    // than zero it — --retry=0 would switch off a workspace's own retry
    // (packages/sdk-typescript) on this lane alone.
    const testStep = releaseYaml.jobs.workspace_tests.steps.find(
      (step) => step.name === 'Run Workspace Tests',
    );
    const script = testStep.run.replaceAll('${{ matrix.shard }}', '1');

    for (const [retry, expected] of [
      ['2', '--retry=2'],
      ['', null],
      // 'off' must omit the flag, not pass --retry=0: that would outrank a
      // workspace's own config-level retry.
      ['off', null],
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'release-retry-'));
      try {
        const stub = join(dir, 'npm');
        writeFileSync(stub, '#!/bin/sh\nprintf "%s\\0" "$@"\n');
        chmodSync(stub, 0o755);

        const result = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', script],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env['PATH']}`,
              VITEST_RETRY: retry,
            },
            encoding: 'utf8',
          },
        );

        expect(result.status, result.stderr).toBe(0);
        const args = result.stdout.split('\0');
        expect(args.pop()).toBe('');
        expect(args, retry).toContain('--passWithNoTests');
        // An empty positional would reach vitest as a test-name filter.
        expect(args, retry).not.toContain('');
        if (expected) {
          expect(args, retry).toContain(expected);
        } else {
          expect(
            args.some((arg) => arg.startsWith('--retry')),
            retry,
          ).toBe(false);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('lets an operator retune the workspace shard timeout without a PR', () => {
    // A shard's runtime tracks how busy the reserved host is, not the suite:
    // the same third measured 6.7 minutes on a quiet host and 36 on a
    // contended one, and 45 killed shards at the boundary with every executed
    // suite green (run 33713579913, both attempts). release.yml is
    // code-owned, so a literal here costs a review every time the fleet
    // moves; the variable is the same runtime knob QWEN_CI_VITEST_MAX_WORKERS
    // and QWEN_RELEASE_VITEST_RETRY already use.
    expect(workflow).toContain(
      `timeout-minutes: "\${{ fromJSON(vars.QWEN_RELEASE_WORKSPACE_TIMEOUT_MINUTES || '45') }}"`,
    );
    // fromJSON, not the bare variable: timeout-minutes takes a number, and an
    // unset variable has to fall back rather than render an empty string.
    expect(releaseYaml.jobs.workspace_tests['timeout-minutes']).toContain(
      'fromJSON(',
    );
  });

  it('names which failure this is, and never changes the exit code', () => {
    // A shard that died on Vitest's own worker RPC timing out reads
    // identically to a real break, and this release lost two attempts before
    // anyone could tell them apart (run 33713579913). The annotation says
    // which; the child's status is re-raised untouched either way, so no
    // reading of the log can turn a failure green.
    const testStep = releaseYaml.jobs.workspace_tests.steps.find(
      (step) => step.name === 'Run Workspace Tests',
    );
    const script = testStep.run.replaceAll('${{ matrix.shard }}', '1');

    for (const [label, stub, code, annotation, expected] of [
      // A failing test names itself; an annotation would only add noise.
      ['failing test', ' FAIL  src/a.test.ts > boom', 1, null],
      // Vitest's worker RPC giving up says nothing about the product, and
      // --retry cannot cover it. Passed only with proof the run reached its
      // end: a normal exit, a passing tally, no failing tally, and no other
      // unhandled error. It cost this release three attempts before that.
      [
        'transport timeout, run completed',
        'Error: [vitest-worker]: Timeout calling "x"\n Tests  10614 passed (10614)',
        1,
        '::warning title=Workspace tests passed through a Vitest transport timeout::',
        0,
      ],
      [
        'transport timeout, killed by a signal',
        'Error: [vitest-worker]: Timeout calling "x"\n Tests  10614 passed (10614)',
        137,
        '::warning title=Workspace tests exited 137 on a Vitest transport timeout::',
      ],
      [
        'transport timeout beside a real one',
        'Error: [vitest-worker]: Timeout calling "x"\nError: write after end\n Tests  10614 passed (10614)',
        1,
        '::warning title=Workspace tests exited 1 on a Vitest transport timeout::',
      ],
      [
        'transport timeout, no tally to back it',
        'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',
        1,
        '::warning title=Workspace tests exited 1 on a Vitest transport timeout::',
      ],
      [
        'unexplained',
        'something odd',
        7,
        '::error title=Workspace tests exited 7 with no failing test::',
      ],
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'release-failure-'));
      try {
        const stubPath = join(dir, 'npm');
        writeFileSync(stubPath, `#!/bin/sh\necho '${stub}'\nexit ${code}\n`);
        chmodSync(stubPath, 0o755);

        const result = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', script],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env['PATH']}`,
              VITEST_RETRY: '2',
              RUNNER_TEMP: dir,
            },
            encoding: 'utf8',
          },
        );

        expect(result.status, label).toBe(expected ?? code);
        if (annotation) {
          expect(result.stdout, label).toContain(annotation);
        } else {
          expect(result.stdout, label).not.toContain('::warning title=');
          expect(result.stdout, label).not.toContain('::error title=');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('discovers at least one test file in every test:ci workspace', () => {
    // --passWithNoTests lets a shard that received no files exit 0, but it
    // would also turn a workspace that lost every test file green in all
    // three shards; the monolithic test:release exited 1 in that case and
    // blocked the release. This ratchet runs in the same test:scripts lane
    // (quality_scripts) that gates the release, so a workspace whose test
    // discovery comes up empty blocks publish again.
    //
    // Discovery mirrors vitest's default include pattern. Every workspace's
    // test:ci runs vitest with that default or a narrower include (the
    // custom configs list 'src/**/*.test.ts' or 'scripts/**/*.test.js'),
    // so zero matches here means zero discoverable tests under vitest too.
    const testCiWorkspaces = getTestCiWorkspaces();
    expect(testCiWorkspaces.length).toBeGreaterThan(0);
    for (const [path] of testCiWorkspaces) {
      const testFiles = globSync('**/*.{test,spec}.?(c|m)[jt]s?(x)', {
        cwd: dirname(path),
        ignore: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
      });
      expect(
        testFiles.length,
        `${path} defines test:ci but matches no test file; every shard ` +
          'would pass with zero tests executed for this workspace',
      ).toBeGreaterThan(0);
    }
  });

  it('keeps publishing behind one fail-closed quality aggregate', () => {
    const quality = releaseYaml.jobs.quality;
    expect(quality.needs).toEqual([
      'prepare',
      'quality_static',
      'quality_build',
      'quality_typecheck',
      'workspace_tests',
      'quality_scripts',
    ]);
    // !cancelled(), not always(): a cancelled run leaves the aggregate
    // skipped, so notify_failure's needs.quality.result == 'failure' gate
    // stays closed for runs an operator stopped on purpose. Failed
    // components still run the aggregate and fail it. The prepare gate
    // skips the aggregate when prepare never ran (forks): otherwise
    // !cancelled() overrides the needs gate and turns five skipped lanes
    // into a quality failure that opens notify_failure on a fork dispatch.
    expect(quality.if).toBe(
      "${{ !cancelled() && needs.prepare.result == 'success' && github.event.inputs.force_skip_tests != 'true' && needs.prepare.outputs.reuse_validation != 'true' }}",
    );
    expect(quality.steps[0].run).toContain(
      'if [[ "${result}" != \'success\' ]]',
    );
    // Pin the full result mapping, not just the loop's shape: dropping one
    // loop entry or remapping an env var to another job's result must fail
    // here instead of letting a failed component publish.
    expect(quality.steps[0].env).toEqual({
      STATIC_RESULT: '${{ needs.quality_static.result }}',
      BUILD_RESULT: '${{ needs.quality_build.result }}',
      TYPECHECK_RESULT: '${{ needs.quality_typecheck.result }}',
      WORKSPACE_TEST_RESULT: '${{ needs.workspace_tests.result }}',
      SCRIPT_TEST_RESULT: '${{ needs.quality_scripts.result }}',
    });
    for (const name of [
      'STATIC_RESULT',
      'BUILD_RESULT',
      'TYPECHECK_RESULT',
      'WORKSPACE_TEST_RESULT',
      'SCRIPT_TEST_RESULT',
    ]) {
      expect(quality.steps[0].run, name).toContain('"${' + name + '}"');
    }
    expect(releaseYaml.jobs.notify_failure.if).toContain(
      "needs.quality.result == 'failure'",
    );
    expect(releaseYaml.jobs.publish.needs).toContain('quality');
    expect(releaseYaml.jobs.publish.needs).not.toContain('workspace_tests');
  });

  it('keeps every component quality job behind the force_skip_tests gate', () => {
    // The aggregate's gate alone is not enough: an emergency
    // `force_skip_tests: 'true'` dispatch must skip each component lane
    // directly too, otherwise a red lane still runs and blocks the very
    // release the override exists to unblock.
    for (const id of [
      'quality_static',
      'quality_build',
      'quality_typecheck',
      'workspace_tests',
      'quality_scripts',
    ]) {
      expect(releaseYaml.jobs[id].if, id).toContain(
        "github.event.inputs.force_skip_tests != 'true'",
      );
    }
  });

  it('only reuses validation from an explicitly verified nightly', () => {
    expect(releaseYaml.on.workflow_dispatch.inputs.promote_nightly.type).toBe(
      'string',
    );
    expect(releaseYaml.jobs.prepare.permissions.actions).toBe('read');
    expect(releaseYaml.jobs.prepare.outputs.reuse_validation).toBe(
      '${{ steps.promotion.outputs.reuse_validation }}',
    );

    const prepareSteps = releaseYaml.jobs.prepare.steps;
    const source = prepareSteps.find((step) => step.id === 'source');
    expect(source.run).toContain('release-source.txt');
    // release_sha must bind to the verified nightly source: the wiring is
    // promotion.outputs.source_sha -> PROMOTION_SHA env -> release_sha,
    // with the fallback shape pinned so neither half can be dropped. On a
    // promotion run the checkout ref is github.sha, so losing this wiring
    // would silently publish commits no successful Release run validated.
    expect(source.env.PROMOTION_SHA).toBe(
      '${{ steps.promotion.outputs.source_sha }}',
    );
    expect(source.run).toContain(
      'release_sha="${PROMOTION_SHA:-$(git rev-parse HEAD)}"',
    );
    // The wiring only resolves while the promotion step runs first:
    // reordered, steps.promotion.outputs.source_sha evaluates to '' and
    // release_sha silently falls back to the dispatch HEAD while
    // reuse_validation still skips every validation job.
    expect(
      prepareSteps.findIndex((step) => step.id === 'promotion'),
    ).toBeLessThan(prepareSteps.findIndex((step) => step.id === 'source'));
    const sourceEvidence = prepareSteps.find(
      (step) => step.name === 'Record release source',
    );
    expect(sourceEvidence.with.name).toBe(
      'release-source-${{ steps.source.outputs.release_sha }}',
    );
    expect(sourceEvidence.with.overwrite).toBe(true);

    // Evidence for a later, optional promotion must not be able to fail a
    // release: a flaky upload here would otherwise fail prepare and open a
    // "Release Failed" issue.
    expect(sourceEvidence['continue-on-error']).toBe(true);

    const promotion = prepareSteps.find((step) => step.id === 'promotion');
    expect(promotion.run).toContain('verify-nightly-promotion.js');
    expect(promotion.run).toContain('force_skip_tests');
    // Without the gate every scheduled nightly and ordinary dispatch would
    // run the script with an empty input and fail prepare; inverted, the
    // promotion input would be silently ignored on promote dispatches.
    expect(promotion.if).toBe(
      "${{ github.event.inputs.promote_nightly != '' }}",
    );
    // The step's outputs are written by the script, not by jq in the
    // workflow, so the output name has to stay in step with it.
    expect(promotionScript).toContain('reuse_validation=true');
    expect(promotionScript).toContain('source_sha=');
    // The gate's deterministic evidence refusals are a correct outcome, not
    // a release failure: the script marks them so notify_failure can keep
    // them out of the release-failed issue and autofix dispatch.
    expect(promotionScript).toContain('promotion_refusal=true');
    expect(releaseYaml.jobs.prepare.outputs.promotion_refusal).toBe(
      '${{ steps.promotion.outputs.promotion_refusal }}',
    );

    // The nightly tag selects the source revision; the stable version is a
    // release decision taken from the `version` input (or derived from the
    // `latest` dist-tag), because the tag's own numeric base is published by
    // the ordinary stable path.
    const version = prepareSteps.find((step) => step.id === 'version');
    expect(version.run).toContain('--promote_nightly_stable_version=');
    expect(version.run).not.toContain(
      'version cannot be combined with promote_nightly',
    );
    // The prepare-time "already shipped" refusal exits 3 and is marked like
    // the publish-side push-time guard, so a re-dispatched promotion whose
    // version a first attempt published does not notify as a failure.
    expect(version.run).toContain('version_refusal=true');
    expect(releaseYaml.jobs.prepare.outputs.version_refusal).toBe(
      '${{ steps.version.outputs.version_refusal }}',
    );
    expect(releaseYaml.jobs.notify_failure.if).toContain(
      "needs.prepare.outputs.version_refusal != 'true'",
    );
    expect(releaseYaml.jobs.notify_failure.if).toContain(
      "needs.prepare.outputs.promotion_refusal != 'true'",
    );

    // promote_nightly ignores `ref`, which is a required input with a
    // default: refuse a non-default value rather than releasing a different
    // revision than the operator chose.
    const vars = releaseYaml.jobs.prepare.steps.find(
      (step) => step.id === 'vars',
    );
    expect(vars.run).toContain('promote_nightly ignores the ref input');
  });

  // The promotion check matches these by display name, so a rename would
  // silently make every promotion fail closed forever.
  it('keeps the promotion check bound to jobs that exist', () => {
    const jobNames = new Set(
      Object.values(releaseYaml.jobs).map((job) => job.name),
    );
    for (const required of REQUIRED_JOBS) {
      expect(jobNames, required).toContain(required);
    }

    for (const id of [
      'quality_static',
      'quality_build',
      'quality_typecheck',
      'workspace_tests',
      'quality_scripts',
      'quality',
      'integration_none',
      'integration_docker',
    ]) {
      expect(releaseYaml.jobs[id].if, id).toContain(
        "needs.prepare.outputs.reuse_validation != 'true'",
      );
    }
    expect(releaseYaml.jobs.publish.if).toContain(
      "needs.prepare.outputs.reuse_validation == 'true'",
    );
    expect(releaseYaml.jobs.audio_capture_prebuilds.with.source_ref).toBe(
      '${{ needs.prepare.outputs.release_sha }}',
    );
    expect(
      audioCapturePrebuildsYaml.on.workflow_call.inputs.source_ref.type,
    ).toBe('string');
    expect(audioCapturePrebuildsYaml.jobs.build.steps[0].with.ref).toBe(
      '${{ inputs.source_ref || github.sha }}',
    );
  });

  it('keeps workspace cleanup from inspecting or signaling host processes', () => {
    expect(canonicalWipe).not.toMatch(/(?:^|\s)(?:ps|kill|pkill)\s/m);
  });

  it.skipIf(
    !hasGnuRealpath || process.getuid?.() === 0 || process.platform === 'win32',
  )('executes the workspace wipe against guard branches', () => {
    const wipeScript = canonicalWipe;

    const runWipe = (envOverrides, { preCreateWorkspace } = {}) => {
      const base = mkdtempSync(join(tmpdir(), 'release-wipe-behavioral-'));
      const workspace = join(base, 'workspace');
      mkdirSync(workspace);
      if (preCreateWorkspace) preCreateWorkspace(base, workspace);
      const env = {
        ...process.env,
        GITHUB_WORKSPACE: workspace,
        RUNNER_WORKSPACE: base,
        RUNNER_TEMP: join(base, 'temp'),
        RUNNER_TOOL_CACHE: join(base, 'tool-cache'),
        GITHUB_ENV: join(base, 'github-env'),
        HOME: join(base, 'home'),
        XDG_CONFIG_HOME: join(base, 'home', '.config'),
        ...envOverrides,
      };
      mkdirSync(env.HOME);
      mkdirSync(env.RUNNER_TEMP);
      mkdirSync(join(env.RUNNER_TOOL_CACHE, 'node'), { recursive: true });
      mkdirSync(join(env.HOME, '.docker'));
      writeFileSync(
        join(env.HOME, '.gitconfig'),
        '[credential]\n\thelper = !false\n',
      );
      writeFileSync(join(env.HOME, '.gitconfig.lock'), 'stale');
      writeFileSync(
        join(env.HOME, '.docker', 'config.json'),
        '{"proxies":{"default":{"httpProxy":"http://attacker"}}}',
      );
      env.GIT_CONFIG_GLOBAL = join(env.HOME, '.gitconfig');
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'credential.helper';
      env.GIT_CONFIG_VALUE_0 = '!false';
      return {
        result: spawnSync('bash', ['-e', '-o', 'pipefail', '-c', wipeScript], {
          encoding: 'utf8',
          env,
        }),
        base,
        workspace,
        githubEnv: env.GITHUB_ENV,
        env,
      };
    };

    // Happy path: a normal workspace inside the runner workspace is wiped,
    // including subdirectories (the wipe's core property: recursive removal
    // of all persisted entries, not just files).
    {
      const { result, base, workspace, githubEnv, env } = runWipe(
        {},
        {
          preCreateWorkspace: (_base, ws) => {
            writeFileSync(join(ws, 'leftover.txt'), 'stale');
            mkdirSync(join(ws, 'leftover-dir'));
            writeFileSync(join(ws, 'leftover-dir', 'nested.txt'), 'stale');
          },
        },
      );
      try {
        expect(result.status).toBe(0);
        const entries = readdirSync(workspace);
        expect(entries).toHaveLength(0);
        const stateEnv = readFileSync(githubEnv, 'utf8');
        expect(stateEnv).toContain('GIT_CONFIG_COUNT=0\n');
        expect(stateEnv).toContain('GIT_CONFIG_NOSYSTEM=1\n');
        expect(stateEnv).toContain('GIT_CONFIG_PARAMETERS=\n');
        expect(stateEnv).toMatch(
          /GIT_CONFIG_GLOBAL=.*\/release-state\.[^/]+\/gitconfig\n/,
        );
        expect(stateEnv).toMatch(
          /NPM_CONFIG_USERCONFIG=.*\/release-state\.[^/]+\/npmrc\n/,
        );
        expect(stateEnv).toMatch(
          /DOCKER_CONFIG=.*\/release-state\.[^/]+\/docker\n/,
        );
        expect(stateEnv).toMatch(
          /GH_CONFIG_DIR=.*\/release-state\.[^/]+\/gh\n/,
        );
        const isolatedEnv = { ...env };
        for (const line of stateEnv.trimEnd().split('\n')) {
          const separator = line.indexOf('=');
          isolatedEnv[line.slice(0, separator)] = line.slice(separator + 1);
        }
        expect(
          spawnSync(
            'git',
            ['config', '--global', '--get', 'credential.helper'],
            { env: isolatedEnv },
          ).status,
        ).not.toBe(0);
        expect(readdirSync(isolatedEnv.DOCKER_CONFIG)).toHaveLength(0);
        // The sibling tool cache SURVIVES the wipe: the sweep is scoped
        // to the workspace, and the pool-wide cache stays untouched on
        // purpose — the pool-routed release lane never reads it, while
        // other pool lanes resolve Node from it through un-gated
        // setup-node.
        expect(lstatSync(join(base, 'tool-cache', 'node')).isDirectory()).toBe(
          true,
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }

    // Symlink heal: a workspace replaced with a symlink inside the runner
    // workspace is removed and recreated, then wiped. The decoy target
    // is a real file so the test can verify `rm -f` removed only the
    // link itself and did not follow/delete the target.
    {
      const { result, base, workspace } = runWipe(
        {},
        {
          preCreateWorkspace: (b, ws) => {
            rmSync(ws, { recursive: true, force: true });
            const decoyTarget = join(b, 'decoy-target');
            writeFileSync(decoyTarget, 'must-survive');
            symlinkSync(decoyTarget, ws);
          },
        },
      );
      try {
        expect(result.status).toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          'healing workspace',
        );
        const stat = lstatSync(workspace);
        expect(stat.isDirectory()).toBe(true);
        // The decoy target must survive: rm -f on the raw path removes
        // the link itself and never follows it.
        expect(readFileSync(join(base, 'decoy-target'), 'utf8')).toBe(
          'must-survive',
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }

    // Pool geometry: the tool cache is a SIBLING of the runner workspace
    // (<root>/_work/_tool vs <root>/_work/qwen-code) — the standard
    // self-hosted layout. The wipe must leave it untouched: other pool
    // lanes resolve Node from it through un-gated setup-node, while the
    // pool-routed release jobs never read it.
    {
      const runnerRoot = mkdtempSync(join(tmpdir(), 'release-wipe-pool-'));
      const rws = join(runnerRoot, '_work', 'qwen-code');
      const workspace = join(rws, 'qwen-code');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, 'leftover.txt'), 'stale');
      try {
        const env = {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          RUNNER_WORKSPACE: rws,
          RUNNER_TEMP: join(runnerRoot, 'temp'),
          RUNNER_TOOL_CACHE: join(runnerRoot, '_work', '_tool'),
          GITHUB_ENV: join(runnerRoot, 'github-env'),
          HOME: join(runnerRoot, 'home'),
          XDG_CONFIG_HOME: join(runnerRoot, 'home', '.config'),
        };
        mkdirSync(env.HOME);
        mkdirSync(env.RUNNER_TEMP);
        mkdirSync(join(env.RUNNER_TOOL_CACHE, 'node'), { recursive: true });
        writeFileSync(
          join(env.RUNNER_TOOL_CACHE, 'node', 'marker.txt'),
          'pool-node',
        );
        const result = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipeScript],
          { encoding: 'utf8', env },
        );
        expect(result.status).toBe(0);
        expect(readdirSync(workspace)).toHaveLength(0);
        // The sibling tool cache's node directory SURVIVES the wipe.
        expect(
          lstatSync(join(env.RUNNER_TOOL_CACHE, 'node')).isDirectory(),
        ).toBe(true);
        expect(
          readFileSync(
            join(env.RUNNER_TOOL_CACHE, 'node', 'marker.txt'),
            'utf8',
          ),
        ).toBe('pool-node');
      } finally {
        rmSync(runnerRoot, { recursive: true, force: true });
      }
    }

    // Workspace outside runner workspace: refused.
    {
      const outside = mkdtempSync(join(tmpdir(), 'release-wipe-outside-'));
      const base = mkdtempSync(join(tmpdir(), 'release-wipe-runner-'));
      try {
        const env = {
          ...process.env,
          GITHUB_WORKSPACE: outside,
          RUNNER_WORKSPACE: base,
          RUNNER_TEMP: join(base, 'temp'),
          RUNNER_TOOL_CACHE: join(base, 'tool-cache'),
          GITHUB_ENV: join(base, 'github-env'),
          HOME: join(base, 'home'),
          XDG_CONFIG_HOME: join(base, 'home', '.config'),
        };
        mkdirSync(env.HOME);
        mkdirSync(env.RUNNER_TEMP);
        const result = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipeScript],
          { encoding: 'utf8', env },
        );
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          'refusing to wipe workspace outside the runner workspace',
        );
      } finally {
        rmSync(outside, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
      }
    }

    // Path with '..' that realpath resolves inside the runner workspace:
    // canonicalization succeeds, containment passes, wipe proceeds.
    {
      const base = mkdtempSync(join(tmpdir(), 'release-wipe-dots-'));
      const workspace = join(base, 'workspace');
      mkdirSync(workspace);
      mkdirSync(join(base, 'sub'));
      writeFileSync(join(workspace, 'leftover.txt'), 'stale');
      try {
        const env = {
          ...process.env,
          // String concatenation preserves the literal '..' segment —
          // path.join would normalize it away before the script sees it.
          GITHUB_WORKSPACE: `${base}/sub/../workspace`,
          RUNNER_WORKSPACE: base,
          RUNNER_TEMP: join(base, 'temp'),
          RUNNER_TOOL_CACHE: join(base, 'tool-cache'),
          GITHUB_ENV: join(base, 'github-env'),
          HOME: join(base, 'home'),
          XDG_CONFIG_HOME: join(base, 'home', '.config'),
        };
        mkdirSync(env.HOME);
        mkdirSync(env.RUNNER_TEMP);
        const result = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipeScript],
          { encoding: 'utf8', env },
        );
        expect(result.status).toBe(0);
        const entries = readdirSync(workspace);
        expect(entries).toHaveLength(0);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }

    // Symlinked runner workspace: refused BEFORE any chown/chmod/wipe —
    // a prior pool job may have replaced it with a link to redirect the
    // whole guard chain (heal, containment, wipe) to an attacker-chosen
    // location.
    {
      const outside = mkdtempSync(join(tmpdir(), 'release-rws-target-'));
      mkdirSync(join(outside, 'qwen-code'));
      const decoy = join(outside, 'qwen-code', 'decoy.txt');
      writeFileSync(decoy, 'must-survive');
      chmodSync(decoy, 0o400);
      const base = mkdtempSync(join(tmpdir(), 'release-rws-runner-'));
      const rwsLink = join(base, 'rws-link');
      symlinkSync(outside, rwsLink);
      try {
        const env = {
          ...process.env,
          GITHUB_WORKSPACE: join(rwsLink, 'qwen-code'),
          RUNNER_WORKSPACE: rwsLink,
          RUNNER_TEMP: join(base, 'temp'),
          RUNNER_TOOL_CACHE: join(base, 'tool-cache'),
          GITHUB_ENV: join(base, 'github-env'),
          HOME: join(base, 'home'),
          XDG_CONFIG_HOME: join(base, 'home', '.config'),
        };
        mkdirSync(env.HOME);
        mkdirSync(env.RUNNER_TEMP);
        const result = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipeScript],
          { encoding: 'utf8', env },
        );
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          'refusing to wipe: runner workspace is a symlink',
        );
        // Decoy intact — and the ownership ladder did not reach it.
        expect(readFileSync(decoy, 'utf8')).toBe('must-survive');
        expect(lstatSync(decoy).mode & 0o777).toBe(0o400);
      } finally {
        rmSync(outside, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
      }
    }

    // Same refusal when the redirected target has no qwen-code subdir:
    // the heal arm must not mkdir at the attacker-chosen location.
    {
      const outside = mkdtempSync(join(tmpdir(), 'release-rws-empty-'));
      const base = mkdtempSync(join(tmpdir(), 'release-rws-runner2-'));
      const rwsLink = join(base, 'rws-link');
      symlinkSync(outside, rwsLink);
      try {
        const env = {
          ...process.env,
          GITHUB_WORKSPACE: join(rwsLink, 'qwen-code'),
          RUNNER_WORKSPACE: rwsLink,
          RUNNER_TEMP: join(base, 'temp'),
          RUNNER_TOOL_CACHE: join(base, 'tool-cache'),
          GITHUB_ENV: join(base, 'github-env'),
          HOME: join(base, 'home'),
          XDG_CONFIG_HOME: join(base, 'home', '.config'),
        };
        mkdirSync(env.HOME);
        mkdirSync(env.RUNNER_TEMP);
        const result = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipeScript],
          { encoding: 'utf8', env },
        );
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          'refusing to wipe: runner workspace is a symlink',
        );
        expect(existsSync(join(outside, 'qwen-code'))).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
      }
    }

    // Trailing slash on a symlinked runner workspace: [ -L ] does not see
    // the link through a trailing slash — path resolution dereferences it —
    // while realpath -m canonicalizes THROUGH it, re-rooting the containment
    // allow-list at the link's target. The raw value must be stripped
    // before the -L test (the GITHUB_WORKSPACE side's ordering), or a
    // mangled env carrying one trailing slash defeats the refusal.
    {
      const outside = mkdtempSync(join(tmpdir(), 'release-rws-slash-'));
      mkdirSync(join(outside, 'qwen-code'));
      const decoy = join(outside, 'qwen-code', 'decoy.txt');
      writeFileSync(decoy, 'must-survive');
      const base = mkdtempSync(join(tmpdir(), 'release-rws-slash-runner-'));
      const rwsLink = join(base, 'rws-link');
      symlinkSync(outside, rwsLink);
      try {
        const env = {
          ...process.env,
          GITHUB_WORKSPACE: join(rwsLink, 'qwen-code'),
          // String concatenation keeps the literal trailing slash —
          // path.join would normalize it away before the script sees it.
          RUNNER_WORKSPACE: `${rwsLink}/`,
          RUNNER_TEMP: join(base, 'temp'),
          RUNNER_TOOL_CACHE: join(base, 'tool-cache'),
          GITHUB_ENV: join(base, 'github-env'),
          HOME: join(base, 'home'),
          XDG_CONFIG_HOME: join(base, 'home', '.config'),
        };
        mkdirSync(env.HOME);
        mkdirSync(env.RUNNER_TEMP);
        const result = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipeScript],
          { encoding: 'utf8', env },
        );
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          'refusing to wipe: runner workspace is a symlink',
        );
        expect(readFileSync(decoy, 'utf8')).toBe('must-survive');
      } finally {
        rmSync(outside, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
      }
    }

    // Symlinked INTERMEDIATE runner-workspace component: [ -L ] only
    // sees the leaf, so a `_work` replaced with a link passes it, and
    // realpath then re-roots the whole chain (heal, containment, wipe)
    // at the link's target — the leaf test alone accepts the geometry
    // and wipes the attacker-chosen tree. The lexical-vs-canonical
    // comparison must refuse BEFORE any chown/chmod/wipe.
    {
      const outside = mkdtempSync(join(tmpdir(), 'release-rws-mid-'));
      mkdirSync(join(outside, 'qwen-code', 'qwen-code'), { recursive: true });
      const decoy = join(outside, 'qwen-code', 'qwen-code', 'decoy.txt');
      writeFileSync(decoy, 'must-survive');
      chmodSync(decoy, 0o400);
      const runnerRoot = mkdtempSync(join(tmpdir(), 'release-rws-mid-runner-'));
      symlinkSync(outside, join(runnerRoot, '_work'));
      const rws = join(runnerRoot, '_work', 'qwen-code');
      try {
        const env = {
          ...process.env,
          GITHUB_WORKSPACE: join(rws, 'qwen-code'),
          RUNNER_WORKSPACE: rws,
          RUNNER_TEMP: join(runnerRoot, 'temp'),
          RUNNER_TOOL_CACHE: join(runnerRoot, 'tool-cache'),
          GITHUB_ENV: join(runnerRoot, 'github-env'),
          HOME: join(runnerRoot, 'home'),
          XDG_CONFIG_HOME: join(runnerRoot, 'home', '.config'),
        };
        mkdirSync(env.HOME);
        mkdirSync(env.RUNNER_TEMP);
        const result = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipeScript],
          { encoding: 'utf8', env },
        );
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          'refusing to wipe: runner workspace resolves through a symlinked component',
        );
        // Decoy intact — and the ownership ladder did not reach it.
        expect(readFileSync(decoy, 'utf8')).toBe('must-survive');
        expect(lstatSync(decoy).mode & 0o777).toBe(0o400);
        expect(existsSync(env.GITHUB_ENV)).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
        rmSync(runnerRoot, { recursive: true, force: true });
      }
    }

    // Same refusal when the redirected target lacks the leaf: without
    // the comparison the heal arm would judge the re-rooted parent
    // INSIDE the re-rooted runner workspace and mkdir the leaf at the
    // attacker-chosen location.
    {
      const outside = mkdtempSync(join(tmpdir(), 'release-rws-mid-empty-'));
      mkdirSync(join(outside, 'qwen-code'));
      const runnerRoot = mkdtempSync(
        join(tmpdir(), 'release-rws-mid-empty-runner-'),
      );
      symlinkSync(outside, join(runnerRoot, '_work'));
      const rws = join(runnerRoot, '_work', 'qwen-code');
      try {
        const env = {
          ...process.env,
          GITHUB_WORKSPACE: join(rws, 'qwen-code'),
          RUNNER_WORKSPACE: rws,
          RUNNER_TEMP: join(runnerRoot, 'temp'),
          RUNNER_TOOL_CACHE: join(runnerRoot, 'tool-cache'),
          GITHUB_ENV: join(runnerRoot, 'github-env'),
          HOME: join(runnerRoot, 'home'),
          XDG_CONFIG_HOME: join(runnerRoot, 'home', '.config'),
        };
        mkdirSync(env.HOME);
        mkdirSync(env.RUNNER_TEMP);
        const result = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipeScript],
          { encoding: 'utf8', env },
        );
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          'refusing to wipe: runner workspace resolves through a symlinked component',
        );
        expect(existsSync(join(outside, 'qwen-code', 'qwen-code'))).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
        rmSync(runnerRoot, { recursive: true, force: true });
      }
    }

    // Symlinked intermediate component BELOW the runner workspace: RWS
    // itself is clean, so only the workspace-side comparison catches
    // the re-rooting. The link points INSIDE the runner workspace,
    // where the containment allow-list alone would pass — without the
    // comparison the wipe would run on the wrong sibling directory.
    {
      const base = mkdtempSync(join(tmpdir(), 'release-ws-mid-'));
      const rws = join(base, 'rws');
      mkdirSync(join(rws, 'elsewhere', 'qwen-code'), { recursive: true });
      const decoy = join(rws, 'elsewhere', 'qwen-code', 'decoy.txt');
      writeFileSync(decoy, 'must-survive');
      symlinkSync(join(rws, 'elsewhere'), join(rws, 'qwen-code'));
      const workspace = join(rws, 'qwen-code', 'qwen-code');
      try {
        const env = {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          RUNNER_WORKSPACE: rws,
          RUNNER_TEMP: join(base, 'temp'),
          RUNNER_TOOL_CACHE: join(base, 'tool-cache'),
          GITHUB_ENV: join(base, 'github-env'),
          HOME: join(base, 'home'),
          XDG_CONFIG_HOME: join(base, 'home', '.config'),
        };
        mkdirSync(env.HOME);
        mkdirSync(env.RUNNER_TEMP);
        const result = spawnSync(
          'bash',
          ['-e', '-o', 'pipefail', '-c', wipeScript],
          { encoding: 'utf8', env },
        );
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          'refusing to wipe: workspace resolves through a symlinked component',
        );
        expect(readFileSync(decoy, 'utf8')).toBe('must-survive');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
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

  it('coordinates Docker image use with other shared-pool workflows', () => {
    const steps = releaseYaml.jobs.integration_docker.steps;
    const setupStep = steps.find((step) => step.name === 'Set up Docker');
    const testStep = steps.find(
      (step) => step.name === 'Run Docker Integration Tests',
    );

    expect(setupStep.if).toBe("${{ runner.environment != 'self-hosted' }}");
    expect(testStep.run).toContain(
      'docker-sandbox-build-release-${sandbox_revision}.lock',
    );
    expect(testStep.run).toContain('flock --wait 1800 8');
    expect(testStep.run).toContain(
      'exec 9>"${HOME}/.cache/qwen-code-ci/docker-sandbox-daemon.lock"',
    );
    expect(testStep.run).toContain('-release-${sandbox_revision}');
    expect(testStep.run).toContain('--no-prune -i "$sandbox_image"');
    expect(testStep.run).toContain(
      'export QWEN_SANDBOX_IMAGE="$sandbox_image_id"',
    );
    expect(testStep.run).toContain('flock --shared --wait 1800 9');
    // The daemon lock stays shared for the whole step: upgrading it to
    // exclusive to build an image starves the build behind the test phase of
    // any run already on the host (run 33637097713). Builds serialize on a
    // separate host mutex that no test phase holds.
    expect(testStep.run).toContain(
      'exec 7>"${HOME}/.cache/qwen-code-ci/docker-sandbox-build.lock"',
    );
    expect(testStep.run).toContain('flock --wait 1800 7');
    expect(testStep.run).not.toContain('acquire_daemon_write_lock');
    expect(testStep.run).not.toContain('flock --unlock 9');
    expect(testStep.run).not.toContain('flock --nonblock 9');
    // A flock lives on the open file description: a descendant inheriting
    // the descriptor past the job would keep the lock on the host.
    expect(testStep.run).toContain('-i "$sandbox_image" 7>&- 8>&- 9>&-');
    expect(testStep.run).toContain('exec 7>&-');
    expect(testStep.run).toContain('exec 8>&-');
    expect(testStep.run).toContain('integration-tests cli 9>&-');
    expect(testStep.run).toContain('integration-tests interactive 9>&-');
  });

  it('digest-pins every sandbox base image', () => {
    // integration_docker builds on the shared pool, whose docker daemon
    // store persists across jobs: a co-resident job can retag a mutable
    // base tag with a poisoned image, but a digest cannot be moved by
    // `docker tag`. Every FROM must carry an @sha256: digest.
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    const fromLines = dockerfile
      .split('\n')
      .filter((line) => /^FROM\s/.test(line));
    expect(fromLines.length).toBeGreaterThan(0);
    for (const line of fromLines) {
      expect(line, line).toMatch(/@sha256:[0-9a-f]{64}(\s|$)/);
    }
  });

  it('bounds shared-pool jobs and skips redundant remote npm caches', () => {
    expect(
      Object.fromEntries(
        [
          'prepare',
          'quality_static',
          'quality_build',
          'quality_typecheck',
          'workspace_tests',
          'quality_scripts',
          'quality',
          'integration_none',
          'integration_docker',
          'notify_failure',
        ].map((id) => [id, releaseYaml.jobs[id]['timeout-minutes']]),
      ),
    ).toEqual({
      prepare: 30,
      quality_static: 30,
      quality_build: 45,
      quality_typecheck: 30,
      // The one bound an operator can retune without a PR; its default is
      // pinned by its own test above.
      workspace_tests:
        "${{ fromJSON(vars.QWEN_RELEASE_WORKSPACE_TIMEOUT_MINUTES || '45') }}",
      quality_scripts: 30,
      quality: 5,
      integration_none: 120,
      integration_docker: 120,
      notify_failure: 10,
    });

    for (const id of [
      'prepare',
      'quality_static',
      'quality_build',
      'quality_typecheck',
      'workspace_tests',
      'quality_scripts',
      'integration_none',
      'integration_docker',
    ]) {
      const steps = releaseYaml.jobs[id].steps;
      // In-tree precedent says nodejs.org may be unreachable through the
      // ECS egress proxy: pool runs must reuse the machine's Node, with
      // setup-node reserved for the hosted fallback.
      const setupNode = steps.find((step) =>
        String(step.uses ?? '').includes('actions/setup-node'),
      );
      expect(setupNode?.if, id).toBe(
        "${{ runner.environment != 'self-hosted' }}",
      );
      expect(setupNode?.with.cache, id).toBe('npm');
      expect(setupNode?.with['package-manager-cache'], id).toBe(false);
      const machineNode = steps.find((step) =>
        String(step.uses ?? '').includes('.github/actions/self-hosted-node'),
      );
      expect(machineNode?.if, id).toBe(
        "${{ runner.environment == 'self-hosted' }}",
      );
    }
    // publish stays hosted-only and keeps its unconditional setup-node.
    const publishSetupNode = releaseYaml.jobs.publish.steps.find((step) =>
      String(step.uses ?? '').includes('actions/setup-node'),
    );
    expect(publishSetupNode?.with.cache).toBe(
      "${{ runner.environment != 'self-hosted' && 'npm' || '' }}",
    );
    expect(publishSetupNode?.with['package-manager-cache']).toBe(false);
  });

  it('stages every integration package manifest after versioning', () => {
    expect(workflow).toContain(
      'git add package.json package-lock.json packages/*/package.json packages/channels/*/package.json integrations/*/package.json integrations/*/qwen-extension.json',
    );
  });

  it('publishes the Mem0 Extension only after trusted publishing bootstrap', () => {
    const publishSteps = releaseYaml.jobs.publish.steps;
    const mem0Step = publishSteps.find(
      (step) => step.name === 'Publish @qwen-code/external-context-mem0',
    );
    const audioStepIndex = publishSteps.findIndex(
      (step) => step.name === 'Publish @qwen-code/audio-capture',
    );

    expect(mem0Step.if).toContain(
      "vars.NPM_EXTERNAL_CONTEXT_MEM0_TRUSTED_PUBLISHING_ENABLED == 'true'",
    );
    expect(mem0Step['working-directory']).toBe(
      'integrations/external-context-mem0',
    );
    expect(publishSteps.indexOf(mem0Step)).toBeLessThan(audioStepIndex);
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
    // the scripts suite — the quality_scripts job that gates it does, but
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
  const ecsRunsOn =
    '${{ (github.repository == \'QwenLM/qwen-code\' && vars.MAINTAINER_ECS_RUNNER_DISABLED != \'true\') && fromJSON(\'["self-hosted", "linux", "x64", "ecs-qwen-hk4-host"]\') || fromJSON(\'["ubuntu-latest"]\') }}';

  it('routes validation jobs to ECS with a hosted emergency fallback', () => {
    const validationJobs = [
      'prepare',
      'quality_static',
      'quality_build',
      'quality_typecheck',
      'workspace_tests',
      'quality_scripts',
      'integration_none',
      'integration_docker',
    ];
    for (const name of validationJobs) {
      const job = releaseYaml.jobs[name];
      expect(job, `job missing from release.yml: ${name}`).toBeTruthy();
      expect(job['runs-on'], `runs-on drifted on job: ${name}`).toBe(ecsRunsOn);
    }
  });

  it('classifies each schedule cron by the exact string it fires with', () => {
    // prepare tells nightly from preview by comparing github.event.schedule
    // against the cron text; a cron edited here without its comparison
    // silently turns that schedule into a no-op run.
    const crons = releaseYaml.on.schedule.map((entry) => entry.cron);
    expect(crons).toHaveLength(2);
    const vars = releaseYaml.jobs.prepare.steps.find(
      (step) => step.id === 'vars',
    );
    for (const cron of crons) {
      expect(vars.run).toContain(`"\${CRON}" == "${cron}"`);
    }
  });

  it('serializes scheduled release validation without coupling manual runs', () => {
    expect(releaseYaml.concurrency).toEqual({
      group:
        "${{ github.event_name == 'schedule' && 'release-scheduled-validation' || format('release-{0}', github.run_id) }}",
      'cancel-in-progress': false,
    });
  });

  it('passes the runner environment to integration test configuration', () => {
    for (const [name, expectedSteps] of [
      ['integration_none', 2],
      ['integration_docker', 1],
    ]) {
      const job = releaseYaml.jobs[name];
      expect(job.env.RUNNER_ENVIRONMENT, name).toBeUndefined();
      const testSteps = job.steps.filter((step) =>
        /(?:vitest|test:integration)/.test(String(step.run ?? '')),
      );
      expect(testSteps, name).toHaveLength(expectedSteps);
      for (const step of testSteps) {
        expect(step.env.RUNNER_ENVIRONMENT, `${name}: ${step.name}`).toBe(
          '${{ runner.environment }}',
        );
      }
    }
  });

  it('keeps publishing and failure notification on hosted runners', () => {
    expect(releaseYaml.jobs.quality['runs-on']).toBe('ubuntu-latest');
    expect(releaseYaml.jobs.quality['runs-on']).not.toContain('ecs-qwen');
    expect(releaseYaml.jobs.publish['runs-on']).toBe('ubuntu-latest');
    expect(releaseYaml.jobs.publish['runs-on']).not.toContain('ecs-qwen');
    expect(releaseYaml.jobs.notify_failure['runs-on']).toBe('ubuntu-latest');
    expect(releaseYaml.jobs.notify_failure['runs-on']).not.toContain(
      'ecs-qwen',
    );
  });
});
