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
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PUBLISHED_PACKAGES } from '../assert-release-version.mjs';
import { getTestCiWorkspacePackageJsonPaths } from '../workspaces.js';

// `realpath -m` (the script's canonicalization line) is a GNU coreutils
// extension. Probe the host before asserting GNU-specific path behavior.
const hasGnuRealpath =
  spawnSync('realpath', ['-m', '--', '/'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('realpath', ['-m', '-s', '--', '/'], { stdio: 'ignore' }).status ===
    0;

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
const releaseYaml = parse(workflow);
const releaseStepScriptPath = '.github/scripts/run-release-step.sh';
const releaseStepScriptAbsolutePath = join(
  process.cwd(),
  releaseStepScriptPath,
);
const releaseStepScript = readFileSync(releaseStepScriptPath, 'utf8');
const workspaceTestScriptPath =
  '.github/scripts/run-release-workspace-tests.sh';
const workspaceTestScript = readFileSync(workspaceTestScriptPath, 'utf8');
const dockerIntegrationScript = readFileSync(
  '.github/scripts/run-release-docker-integration.sh',
  'utf8',
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
    expect(nodeReplPackage.version).toBe('0.1.3');
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
# Reject symlinked or non-canonical paths before recursive changes.
RWS="\${RUNNER_WORKSPACE:?}"
while [ "\${RWS%/}" != "$RWS" ]; do RWS="\${RWS%/}"; done
if [ -L "$RWS" ]; then
  echo "::error::refusing to wipe: runner workspace is a symlink: \${RWS}"
  exit 1
fi
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
# Heal only a corrupt leaf whose canonical parent remains contained.
if [ -L "$WS" ] || [ ! -d "$WS" ]; then
  HEAL_PARENT="$(realpath -m -- "$(dirname -- "$WS")" 2>/dev/null)" || { echo "::error::refusing to heal: realpath unavailable, cannot canonicalize the parent of \${WS}"; exit 1; }
  case "$HEAL_PARENT" in
    "$RWS"|"$RWS"/*) ;;
    *) echo "::error::refusing to heal workspace outside the runner workspace: \${WS} (parent: \${HEAL_PARENT}, runner workspace: \${RWS})"; exit 1 ;;
  esac
  if [ -L "$WS" ]; then
    # Keep attacker-controlled link text out of workflow commands.
    heal_target="$(readlink -- "$WS" 2>/dev/null || printf '%s' '<unreadable>')"
    heal_target="$(printf '%s' "$heal_target" | tr -d '\\r\\n' | cut -c1-200)"
    echo "::warning::healing workspace \${WS}: it was a symlink"
    printf 'heal: %s pointed at %s\\n' "$WS" "$heal_target"
  else
    echo "::warning::healing workspace \${WS}: it was not a directory"
  fi
  # Remove the raw link path; never resolve its target.
  rm -f -- "$WS" || { echo "::error::refusing to continue: could not remove \${WS}"; exit 1; }
  mkdir -- "$WS" || { echo "::error::refusing to continue: could not recreate \${WS}"; exit 1; }
fi
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
# Deny known roots, then allow only runner-workspace descendants.
case "$WS" in
  /|/home|/root|/usr*|/etc*|/var|"") echo "::error::refusing to wipe suspicious workspace path: \${WS}"; exit 1 ;;
esac
case "$WS" in
  "$RWS"/*) ;;
  *) echo "::error::refusing to wipe workspace outside the runner workspace: \${WS} (runner workspace: \${RWS})"; exit 1 ;;
esac
# Path geometry is validated before ownership changes.
RUNNER_UID="$(id -u)"
RUNNER_GID="$(id -g)"
if [ "$RUNNER_UID" != "0" ]; then
  chown -R "$RUNNER_UID:$RUNNER_GID" "$GITHUB_WORKSPACE" 2>/dev/null || sudo -n chown -R "$RUNNER_UID:$RUNNER_GID" "$GITHUB_WORKSPACE" || echo "::warning::could not restore workspace ownership; checkout may fail on leftover root-owned files"
fi
chmod -R u+rwX "$GITHUB_WORKSPACE" 2>/dev/null || sudo -n chmod -R u+rwX "$GITHUB_WORKSPACE" || echo "::warning::could not restore workspace write permissions; checkout may fail on leftover read-only files"
find "$WS" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
# Isolate Git, npm, Docker, and gh state inherited across pool jobs.
release_state="$(mktemp -d "\${RUNNER_TEMP:?}/release-state.XXXXXX")" || exit 1
: > "\${release_state}/gitconfig" || exit 1
: > "\${release_state}/npmrc" || exit 1
mkdir "\${release_state}/docker" || exit 1
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
  // same workspace set, so the selection lives once in
  // getTestCiWorkspacePackageJsonPaths (scripts/workspaces.js) -- the same
  // resolver unit-vitest-configs.test.ts consumes -- instead of letting
  // each test carry its own selection copy. The pairs here only attach the
  // parsed package.json the pins below assert on.
  const getTestCiWorkspaces = () =>
    getTestCiWorkspacePackageJsonPaths(process.cwd()).map((path) => [
      path,
      JSON.parse(readFileSync(path, 'utf8')),
    ]);

  it('cleans every shared ECS workspace before checkout', () => {
    // The subject set has to be derived from a property independent of the
    // wipe itself: selecting on "has a Restore workspace ownership step"
    // would filter out any newly added pool-routed job before an assertion
    // ever ran. The pool marker is what makes state survive across jobs, and
    // it cannot be swapped for the hosted label because every pool-routed
    // runs-on expression names 'ubuntu-latest' as its fallback branch.
    const isPoolRouted = (job) =>
      String(job['runs-on'] ?? '').includes('ecs-qwen-hk4-host');
    const wipesWorkspace = (job) =>
      (job.steps ?? []).some(
        (step) => step.name === 'Restore workspace ownership',
      );
    const checkoutJobs = Object.entries(releaseYaml.jobs).filter(
      ([, job]) =>
        (job.steps ?? []).some((step) =>
          String(step.uses ?? '').includes('actions/checkout'),
        ) &&
        (isPoolRouted(job) || wipesWorkspace(job)),
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
    // Pool-routed jobs inherit root-owned leftovers whether or not they
    // check out, so the exemption above must never extend to them.
    for (const [id, job] of Object.entries(releaseYaml.jobs)) {
      if (!isPoolRouted(job)) {
        continue;
      }
      expect(wipesWorkspace(job), id).toBe(true);
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

  it('loads extracted runners from the workflow commit for old release refs', () => {
    for (const jobId of [
      'prepare',
      'quality_build',
      'workspace_tests',
      'integration_docker',
      'publish',
      'notify_failure',
    ]) {
      const steps = releaseYaml.jobs[jobId].steps;
      const targetCheckoutIndex = steps.findIndex(
        (step) => step.name === 'Checkout',
      );
      const scriptCheckoutIndex = steps.findIndex(
        (step) => step.name === 'Checkout release workflow scripts',
      );
      const scriptCheckout = steps[scriptCheckoutIndex];

      expect(scriptCheckout.with, jobId).toEqual({
        ref: '${{ github.workflow_sha }}',
        'fetch-depth': 1,
        'persist-credentials': false,
        'sparse-checkout':
          '/.github/scripts\n/scripts/assert-release-version.mjs',
        'sparse-checkout-cone-mode': false,
        path: '.release-workflow',
      });
      if (jobId !== 'notify_failure') {
        expect(scriptCheckoutIndex, jobId).toBeGreaterThan(targetCheckoutIndex);
      }
      for (const [index, step] of steps.entries()) {
        if (String(step.run ?? '').includes('.release-workflow/')) {
          expect(index, `${jobId}:${step.name}`).toBeGreaterThan(
            scriptCheckoutIndex,
          );
        }
      }
    }
  });

  it('re-pins trusted runners before every step that runs one', () => {
    // Swept, not hand-listed: a list of protected step names cannot fail for
    // the steps it omits, which is how `Build Bundle and Prepare Package`,
    // `Build Standalone Archives` and `Verify Standalone Archives` came to
    // execute the trusted runner from a tree that selected-ref npm code had
    // already run over. Every step invoking `.release-workflow/` is checked.
    let swept = 0;
    for (const [jobId, job] of Object.entries(releaseYaml.jobs)) {
      const steps = job.steps ?? [];
      for (const [index, step] of steps.entries()) {
        if (!String(step.run ?? '').includes('.release-workflow/')) continue;
        swept += 1;
        const label = `${jobId}:${step.name}`;
        const checkoutIndex = steps.findLastIndex(
          (candidate, candidateIndex) =>
            candidateIndex < index &&
            candidate.name === 'Checkout release workflow scripts',
        );
        expect(checkoutIndex, label).toBeGreaterThanOrEqual(0);
        // Nothing between the trusted checkout and the step it protects may
        // run selected-ref npm code, which could overwrite the runner in
        // place — including npm lifecycle scripts fired by `npm publish`.
        expect(
          steps
            .slice(checkoutIndex + 1, index)
            .some((candidate) => /\bnpm\b/.test(String(candidate.run ?? ''))),
          label,
        ).toBe(false);
      }

      // Every re-checkout discards the previous tree first; the job's first
      // checkout has nothing to reset.
      const checkouts = steps
        .map((step, index) =>
          step.name === 'Checkout release workflow scripts' ? index : -1,
        )
        .filter((index) => index >= 0);
      for (const [ordinal, index] of checkouts.entries()) {
        if (ordinal === 0) continue;
        expect(steps[index - 1]?.name, `${jobId}:checkout@${index}`).toBe(
          'Reset release workflow scripts',
        );
      }
    }
    expect(swept).toBeGreaterThan(10);
  });

  it('keeps the publish allowlist and the guard package set in step', () => {
    // The push-time guard only probes what `PUBLISHED_PACKAGES` lists. A
    // channel added to the publish loop but not to that array ships without
    // ever being probed, so a retry of a partial release reports
    // "unreleased" and force-pushes over the tip the shipped package anchors
    // to. Before this, the only tie was a comment pointing at publish steps
    // that no longer exist in release.yml.
    const loop = releaseStepScript.match(/for channel in ([^;]+); do/);
    expect(loop, 'publish-packages channel loop').not.toBeNull();
    const published = loop[1].trim().split(/\s+/).sort();
    const guarded = PUBLISHED_PACKAGES.filter((name) =>
      name.startsWith('@qwen-code/channel-'),
    )
      .map((name) => name.replace('@qwen-code/channel-', ''))
      .filter((name) => name !== 'base')
      .sort();
    expect(published).toEqual(guarded);
  });

  it('keeps the workflow focused on orchestration', () => {
    // 830, raised from 800 for the notify_failure fallback: that job may not
    // depend on the trusted checkout or the extracted runner, because it is
    // the job that reports their failure, so its last-resort issue filing is
    // deliberately inline. Every other step stays under the per-step cap
    // below, which is the rule that actually keeps logic out of the YAML.
    expect(workflow.split('\n').length).toBeLessThan(830);
    for (const [jobId, job] of Object.entries(releaseYaml.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.name === 'Restore workspace ownership' || !step.run) continue;
        expect(
          String(step.run).split('\n').length,
          `${jobId}:${step.name}`,
        ).toBeLessThanOrEqual(12);
      }
    }
  });

  it.skipIf(process.platform === 'win32')(
    'executes release flag classification from the extracted script',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'release-flags-'));
      const output = join(directory, 'output');
      writeFileSync(output, '');
      try {
        const result = spawnSync(
          'bash',
          [releaseStepScriptAbsolutePath, 'set-flags'],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              CREATE_NIGHTLY_RELEASE: 'false',
              CREATE_PREVIEW_RELEASE: 'false',
              CRON: '0 21 * * *',
              DRY_RUN_INPUT: 'true',
              GITHUB_OUTPUT: output,
            },
          },
        );
        expect(result.status).toBe(0);
        expect(readFileSync(output, 'utf8')).toBe(
          'is_nightly=true\nis_preview=false\nis_dry_run=true\n',
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'continues publishing after already-published packages',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'release-publish-'));
      const bin = join(directory, 'bin');
      const publishLog = join(directory, 'published');
      const channels = [
        'dingtalk',
        'dws',
        'feishu',
        'github',
        'qqbot',
        'telegram',
        'wecom',
        'weixin',
      ];
      mkdirSync(bin);
      for (const path of [
        'dist',
        'packages/channels/base',
        ...channels.map((channel) => `packages/channels/${channel}`),
      ]) {
        mkdirSync(join(directory, path), { recursive: true });
      }
      writeFileSync(join(bin, 'node'), '#!/bin/sh\nbasename "$PWD"\n', {
        mode: 0o755,
      });
      writeFileSync(
        join(bin, 'npm'),
        '#!/bin/sh\n' +
          'if [ "$1" = view ]; then\n' +
          '  case "$PWD" in */channels/base) exit 1 ;; */channels/*) exit 0 ;; *) exit 1 ;; esac\n' +
          'fi\n' +
          'if [ "$1" = publish ]; then printf "%s\\t%s\\n" "$PWD" "$*" >> "$PUBLISH_LOG"; fi\n',
        { mode: 0o755 },
      );
      try {
        const result = spawnSync(
          'bash',
          [releaseStepScriptAbsolutePath, 'publish-packages'],
          {
            cwd: directory,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              IS_DRY_RUN: 'false',
              NPM_TAG: 'latest',
              PUBLISH_AUDIO_CAPTURE: 'false',
              PUBLISH_EXTERNAL_CONTEXT_MEM0: 'false',
              PUBLISH_LOG: publishLog,
              RELEASE_VERSION: '1.2.3',
            },
          },
        );
        expect(result.status).toBe(0);
        const canonicalDirectory = realpathSync(directory);
        const publishCalls = readFileSync(publishLog, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('\t'));
        expect(publishCalls.map(([cwd]) => cwd)).toEqual([
          join(canonicalDirectory, 'dist'),
          join(canonicalDirectory, 'packages/channels/base'),
        ]);
        // The dist-tag is the reason NPM_TAG is set in this child env at all.
        // Without it `npm publish` defaults to `latest`, so the 21:00 UTC
        // nightly would take over the tag every end-user install and the ECS
        // fleet updater resolve through. `--access public` is here for the
        // same reason: one array feeds all twelve published packages.
        for (const [cwd, args] of publishCalls) {
          expect(args, cwd).toContain('--access public');
          expect(args, cwd).toContain('--tag=latest');
        }
        expect(result.stdout).toContain(
          'Every channel package was already published; nothing shipped',
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('runs the step script only from the trusted checkout', () => {
    // The whole point of the extraction is that the decision comes from the
    // workflow-pinned SHA. Every arm pin elsewhere is a substring match that
    // a bare `.github/scripts/...` invocation would satisfy just as well, so
    // pin the prefix itself: no step may reach the release-ref copy.
    let invocations = 0;
    for (const [jobId, job] of Object.entries(releaseYaml.jobs)) {
      for (const step of job.steps ?? []) {
        const run = String(step.run ?? '');
        if (!/\.github\/scripts\/run-release-[a-z-]+\.sh/.test(run)) continue;
        invocations += 1;
        expect(run, `${jobId}:${step.name}`).toContain('.release-workflow/');
        expect(run, `${jobId}:${step.name}`).not.toMatch(
          /(^|[^/])\.github\/scripts\/run-release-/m,
        );
      }
    }
    expect(invocations).toBeGreaterThan(10);
  });

  it('keeps the extracted release scripts executable', () => {
    // release.yml runs these by bare path, so the mode is load-bearing:
    // a checkout that materializes them 100644 dies with exit 126 before any
    // validation runs. Nothing else pins it — the execution tests all invoke
    // `bash <script>`, which ignores the mode, and release.yml triggers only
    // on schedule/workflow_dispatch, so no pull-request lane ever runs the
    // bare-path form. Assert the *recorded* mode, not the working tree's:
    // that is what actions/checkout materializes.
    const recorded = spawnSync('git', ['ls-tree', 'HEAD', '.github/scripts/'], {
      encoding: 'utf8',
    });
    expect(recorded.status).toBe(0);
    const modes = new Map(
      recorded.stdout
        .trim()
        .split('\n')
        .map((line) => {
          const [meta, path] = line.split('\t');
          return [path, meta.split(' ')[0]];
        }),
    );
    for (const script of [
      '.github/scripts/run-release-step.sh',
      '.github/scripts/run-release-workspace-tests.sh',
      '.github/scripts/run-release-docker-integration.sh',
    ]) {
      expect(modes.get(script), script).toBe('100755');
    }
  });

  it.skipIf(process.platform === 'win32')(
    'maps a manual preview release onto the preview override flags',
    () => {
      // `resolve-version` was the one arm no test executed or text-pinned, so
      // flipping --type=preview to --type=stable left the whole scripts lane
      // green — while at runtime the stable path ignores
      // preview_version_override entirely, publishing the operator's manual
      // preview as a stable version under npm's `latest` dist-tag.
      const directory = mkdtempSync(join(tmpdir(), 'release-resolve-'));
      const bin = join(directory, 'bin');
      const argsLog = join(directory, 'node-args');
      const output = join(directory, 'github-output');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'node'),
        '#!/bin/sh\n' +
          'printf "%s\\n" "$*" >> "$NODE_ARGS_LOG"\n' +
          'echo \'{"releaseTag":"v1.2.3-preview.0","releaseVersion":"1.2.3-preview.0","npmTag":"preview","previousReleaseTag":"v1.2.2"}\'\n',
        { mode: 0o755 },
      );
      writeFileSync(output, '');
      try {
        const result = spawnSync(
          'bash',
          [releaseStepScriptAbsolutePath, 'resolve-version'],
          {
            cwd: directory,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              IS_NIGHTLY: 'false',
              IS_PREVIEW: 'true',
              MANUAL_VERSION: '1.2.3',
              NODE_ARGS_LOG: argsLog,
              GITHUB_OUTPUT: output,
            },
          },
        );
        expect(result.status).toBe(0);
        const nodeArgs = readFileSync(argsLog, 'utf8');
        expect(nodeArgs).toContain('--type=preview');
        expect(nodeArgs).toContain(
          '--preview_version_override=1.2.3-preview.0',
        );
        expect(nodeArgs).not.toContain('--type=stable');
        expect(readFileSync(output, 'utf8')).toContain('NPM_TAG=preview');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a manual preview version that is not X.Y.Z or X.Y.Z-preview.N',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'release-resolve-bad-'));
      const output = join(directory, 'github-output');
      writeFileSync(output, '');
      try {
        const result = spawnSync(
          'bash',
          [releaseStepScriptAbsolutePath, 'resolve-version'],
          {
            cwd: directory,
            encoding: 'utf8',
            env: {
              ...process.env,
              IS_NIGHTLY: 'false',
              IS_PREVIEW: 'true',
              MANUAL_VERSION: 'not-a-version',
              GITHUB_OUTPUT: output,
            },
          },
        );
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain(
          'For preview releases, version must be X.Y.Z or X.Y.Z-preview.N',
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'aborts notify-failure instead of filing a duplicate when gh is unreachable',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'release-notify-'));
      const bin = join(directory, 'bin');
      const ghLog = join(directory, 'gh-calls');
      mkdirSync(bin);
      // Stand in for a connection-level failure: stderr only, exit 1, and
      // nothing at all on stdout, which is what jq then reads as an empty list.
      writeFileSync(
        join(bin, 'gh'),
        '#!/bin/sh\n' +
          'printf "%s\\n" "$*" >> "$GH_CALL_LOG"\n' +
          'if [ "$1" = issue ] && [ "$2" = list ]; then\n' +
          '  echo "gh: connection reset by peer" >&2\n' +
          '  exit 1\n' +
          'fi\n' +
          'exit 0\n',
        { mode: 0o755 },
      );
      try {
        const result = spawnSync(
          'bash',
          [releaseStepScriptAbsolutePath, 'notify-failure'],
          {
            cwd: directory,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              GH_CALL_LOG: ghLog,
              GH_REPO: 'QwenLM/qwen-code',
              RELEASE_TAG: 'v1.2.3',
              DETAILS_URL: 'https://github.example/run/1',
              PREPARE_RESULT: 'success',
              QUALITY_RESULT: 'failure',
              INTEGRATION_NONE_RESULT: 'skipped',
              INTEGRATION_DOCKER_RESULT: 'skipped',
              PUBLISH_RESULT: 'skipped',
              BUG_LABEL: 'type/bug',
              READY_FOR_AGENT_LABEL: 'status/ready-for-agent',
              AUTOFIX_APPROVED_LABEL: 'autofix/approved',
            },
          },
        );
        // Without pipefail this arm exits 0 and files a fresh autofix/approved
        // twin of the release-failure issue, bypassing all three reuse guards
        // (title-prefix anchor, bot-author refusal, still_eligible) because
        // those only run on the reuse branch.
        expect(result.status, result.stderr).not.toBe(0);
        expect(readFileSync(ghLog, 'utf8')).not.toContain('issue create');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'records the issue before a failed autofix dispatch',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'release-notify-dispatch-'));
      const bin = join(directory, 'bin');
      const output = join(directory, 'github-output');
      mkdirSync(bin);
      writeFileSync(output, '');
      writeFileSync(
        join(bin, 'gh'),
        '#!/bin/sh\n' +
          'case "$1 $2" in\n' +
          "  'issue list') echo '[]' ;;\n" +
          "  'issue create') echo 'https://github.example/QwenLM/qwen-code/issues/4242' ;;\n" +
          "  'workflow run') exit 1 ;;\n" +
          'esac\n',
        { mode: 0o755 },
      );
      try {
        const result = spawnSync(
          'bash',
          [releaseStepScriptAbsolutePath, 'notify-failure'],
          {
            cwd: directory,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              GITHUB_OUTPUT: output,
              GH_REPO: 'QwenLM/qwen-code',
              RELEASE_TAG: 'v1.2.3',
              DETAILS_URL: 'https://github.example/run/1',
              PREPARE_RESULT: 'success',
              QUALITY_RESULT: 'failure',
              INTEGRATION_NONE_RESULT: 'skipped',
              INTEGRATION_DOCKER_RESULT: 'skipped',
              PUBLISH_RESULT: 'skipped',
              BUG_LABEL: 'type/bug',
              READY_FOR_AGENT_LABEL: 'status/ready-for-agent',
              AUTOFIX_APPROVED_LABEL: 'autofix/approved',
            },
          },
        );
        expect(result.status).not.toBe(0);
        expect(readFileSync(output, 'utf8')).toBe(
          'issue_url=https://github.example/QwenLM/qwen-code/issues/4242\n',
        );
        const fallback = releaseYaml.jobs.notify_failure.steps.find(
          (step) => step.name === 'File a fallback failure issue',
        );
        expect(fallback.if).toBe(
          "${{ always() && steps.notify.outcome != 'success' && !steps.notify.outputs.issue_url }}",
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('pins validation and publishing to the commit resolved by prepare', () => {
    expect(releaseYaml.jobs.prepare.outputs.release_sha).toBe(
      '${{ steps.source.outputs.release_sha }}',
    );
    const sourceStep = releaseYaml.jobs.prepare.steps.find(
      (step) => step.id === 'source',
    );
    expect(sourceStep.run).toContain('run-release-step.sh resolve-commit');
    expect(releaseStepScript).toContain('git rev-parse HEAD');

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
    expect(pack.run).toContain('run-release-step.sh pack-build');
    expect(releaseStepScript).toContain('packages/web-templates/src/generated');
    // npm ci leaves nested dependency dist dirs under workspace
    // node_modules; the find must prune them so only real build outputs
    // travel in release-quality-build.
    expect(releaseStepScript).toContain('-type d -name node_modules -prune');
    // Log what is packed and fail closed on a silent under-pack: a dropped
    // `-o` in the find turns the two -prune clauses into one conjunction
    // that matches nothing, and tar would then ship only the two hardcoded
    // paths while the symptom lands in downstream consumers.
    expect(releaseStepScript).toContain('printf');
    expect(releaseStepScript).toContain('${#build_paths[@]} -gt 2');
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
      '# This materializes the repo-root dist packed below.',
    );
    expect(releaseStepScript).toContain(
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
    expect(testStep.run).toBe(
      '.release-workflow/.github/scripts/run-release-workspace-tests.sh "${{ matrix.shard }}"',
    );
    expect(workspaceTestScript).toContain(
      'npm run test:release:workspaces -- --shard="${shard}/3" --passWithNoTests "${retry_arg[@]}"',
    );
    expect(workspaceTestScript).toContain(
      '::warning title=Workspace tests exited',
    );
    // Every release schedule retries, stable included: running the stable
    // lane with no retry let one flaky test out of ~30k red a release whose
    // other gates were all green. The default is pinned here so a silent
    // drop back to a no-retry stable lane fails this test.
    expect(testStep.env.VITEST_RETRY).toBe(
      "${{ vars.QWEN_RELEASE_VITEST_RETRY || '2' }}",
    );
    // Keep the workflow invocation explicit and the script independently
    // fail-closed, so direct local execution and Actions use the same shell.
    expect(testStep.shell).toBe('bash');
    expect(workspaceTestScript).toContain('set -eo pipefail');
    // The extracted step runner has to fail closed the same way. notify-failure
    // reads `gh issue list ... | jq -c ...` inside a command substitution, and
    // a connection-level gh failure leaves jq exiting 0 on empty input, so
    // without pipefail an unreachable API reads as "no existing issue".
    expect(releaseStepScript).toMatch(/^set -eo pipefail$/m);
    // Vitest colours its summaries from the mere presence of CI, and a
    // coloured summary sits escape bytes between a label and its value, so
    // every anchored pattern in the guard matches nothing: the pass-through
    // is never granted again and each transport timeout reddens the release.
    // Quoted in YAML, so it parses to the string rather than a boolean.
    expect(testStep.env.NO_COLOR).toBe('true');

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
          ['-e', '-o', 'pipefail', workspaceTestScriptPath, '1'],
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

  it('lets an operator retune the quality lane timeouts without a PR', () => {
    // Run 33963757913 lost both lanes at their timeout boundary on a
    // contended hk4 with no failing step: quality_static at 30m13s in Run
    // Lint, quality_build at 45m13s in Pack Build Outputs. A timeout kill
    // reports as 'cancelled', the quality aggregate fails closed on it, and
    // the release failure was filed against a tree with nothing to fix. Same
    // remedy as workspace_tests: a runtime knob. The static default moved
    // 30 -> 60 on the pricing evidence its lane comment records (#11121);
    // the build default stays a fleet-load call for the operator.
    // Value format, relocated here from the release.yml lane comment this diff
    // condensed to one line: the knob is free text under a name ending in
    // MINUTES and takes a bare positive integer. `1h` is an expression error —
    // GitHub never creates the job and the run blames 'a workflow file issue'
    // instead of naming the variable — while `70 minutes` silently means 70,
    // because fromJSON keeps the leading number and drops the rest. The
    // aggregate still fails closed on a lane that never ran, so a bad value
    // refuses a release rather than shipping one unvalidated. `0` is not 'no
    // limit' either: the string '0' is truthy in a GitHub `||`, so the knob
    // wins over the fallback and GitHub then ignores the zero bound it was
    // handed. quality_static, quality_build and workspace_tests all share this
    // contract, so it lives beside the assertions that pin their expressions.
    expect(releaseYaml.jobs.quality_static['timeout-minutes']).toBe(
      "${{ fromJSON(vars.QWEN_RELEASE_STATIC_TIMEOUT_MINUTES || '60') }}",
    );
    expect(releaseYaml.jobs.quality_build['timeout-minutes']).toBe(
      "${{ fromJSON(vars.QWEN_RELEASE_BUILD_TIMEOUT_MINUTES || '45') }}",
    );
    // A budget the run never states is indistinguishable from a budget nobody
    // set: a misspelled variable name renders '' and the lane dies at its
    // default again, with nothing in the log to reconcile the two. Each
    // tunable lane reports the bound it resolved — through the SAME expression
    // the timeout uses, so the trace cannot drift from what the runner
    // enforces — and whether the variable reached the job at all.
    for (const [id, variable] of [
      ['quality_static', 'QWEN_RELEASE_STATIC_TIMEOUT_MINUTES'],
      ['quality_build', 'QWEN_RELEASE_BUILD_TIMEOUT_MINUTES'],
    ]) {
      const bound = releaseYaml.jobs[id]['timeout-minutes'];
      const report = releaseYaml.jobs[id].steps.find(
        (step) => step.env?.BUDGET === bound,
      );
      expect(report?.name, id).toBe('Report timeout budget');
      expect(report.run, id).toContain(`::notice::${id} timeout budget`);
      expect(report.run, id).toContain(`${variable} set=\${VARIABLE_SET}`);
      expect(report.env.VARIABLE_SET, id).toBe(
        `\${{ vars.${variable} != '' }}`,
      );
    }
  });

  it('names which failure this is, and never changes the exit code', () => {
    // A shard that died on Vitest's own worker RPC timing out reads
    // identically to a real break, and this release lost two attempts before
    // anyone could tell them apart (run 33713579913). The annotation says
    // which; the child's status is re-raised untouched, so no reading of the
    // log can turn a failure green except the one deliberate pass-through.
    //
    // That pass-through is granted by Vitest's own count of unhandled errors
    // (`Errors  N errors`) matching how many carried the transport's message
    // — not by recognising a crash from its header. The header is
    // producer-chosen, so a pattern over headers is incomplete by
    // construction; the rows below carry the shapes that defeat one
    // (suffix-less class, no class at all) and the shapes that defeat the
    // count (an extra error the timeouts do not account for, a summary the
    // run never reached, words a test merely printed).
    const timeout = 'Error: [vitest-worker]: Timeout calling "x"';
    const tally = ' Tests  10614 passed (10614)';
    const passedThrough =
      '::warning title=Workspace tests passed through a Vitest transport timeout::';
    const stands =
      '::warning title=Workspace tests exited 1 on a Vitest transport timeout::';

    for (const [label, stub, code, annotation, expected] of [
      // A failing test names itself; an annotation would only add noise.
      ['failing test', ' FAIL  src/a.test.ts > boom', 1, null],
      // Vitest's worker RPC giving up says nothing about the product, and
      // --retry cannot cover it — retries re-run failing TESTS while an
      // unhandled error fails the run outright. Passed only with proof the
      // run reached its end and that the transport accounts for every
      // unhandled error Vitest counted. It cost this release three attempts.
      [
        'transport timeout, run completed',
        `${timeout}\n${tally}\n     Errors  1 error`,
        1,
        passedThrough,
        0,
      ],
      [
        'transport timeout, killed by a signal',
        `${timeout}\n${tally}\n     Errors  1 error`,
        137,
        '::warning title=Workspace tests exited 137 on a Vitest transport timeout::',
      ],
      // One more error than the transport accounts for: the run broke on
      // something else as well, whatever its header said.
      [
        'transport timeout beside a real one',
        `${timeout}\nError: write after end\n${tally}\n     Errors  2 errors`,
        1,
        stands,
      ],
      // The counts can also disagree with no crash in the log at all — the
      // same transport message on two lines inflates `timeouts` past what
      // Vitest counted. That is a fifth way to reach this refusal, so the
      // annotation names it and prints both figures it compared; without
      // them the oncall is told one of four things happened when none did.
      [
        'transport timeout counted twice against one unhandled error',
        `${timeout}\n${timeout}\n${tally}\n     Errors  1 error`,
        1,
        '::warning title=Workspace tests exited 1 on a Vitest transport timeout::A transport timeout the run cannot account for — no passing tally, a failing tally, a signal death, an unhandled error that was not the transport, or the two counts disagreeing for a reason this log does not show. The failure stands (status 1, 1 counted error(s) vs 2 transport line(s)); rerun the job.',
      ],
      // The two shapes no header pattern reaches. A class whose name carries
      // no Error/Exception suffix is not hypothetical — 26 of this repo's 293
      // Error subclasses are named that way, four of them assigning the bare
      // name to err.name — and a bare string throw prints under Vitest's own
      // `Unknown Error:` heading, which a header matcher misses on the space.
      // The count sees both, because it never looks at the header.
      [
        'transport timeout beside a suffix-less crash header',
        `${timeout}\nPoolTimeout: worker pool exhausted\n${tally}\n     Errors  2 errors`,
        1,
        stands,
      ],
      [
        'transport timeout beside a bare string throw',
        `${timeout}\nUnknown Error: a bare string, no class header\n${tally}\n     Errors  2 errors`,
        1,
        stands,
      ],
      // Ordinary `Error:` lines are test output, not evidence of a break: the
      // log of the run this guard was written for carries three of them as
      // fixture data. A matcher over headers refuses the pass-through on
      // those and reddens a release the guard exists to save; the count is
      // unmoved by them.
      [
        'transport timeout beside Error: lines a test printed',
        `${timeout}\nError: boom\nError: Not implemented: navigation\n${tally}\n     Errors  1 error`,
        1,
        passedThrough,
        0,
      ],
      // `--workspaces` prints one summary per workspace into one log, so both
      // figures are whole-file sums: a passing tally cannot cover a later
      // workspace's crash, and two transport deaths in two workspaces still
      // pass.
      [
        'tally, then a later workspace crashing',
        `${timeout}\n${tally}\n Tests  8 passed (8)\n     Errors  2 errors`,
        1,
        stands,
      ],
      // The shape of the log this guard was written for: several transport
      // deaths in one run, and the plural summary Vitest prints for more than
      // one of them (run 33713579913).
      [
        'four transport deaths, four unhandled errors',
        `${timeout}\n${timeout}\n${timeout}\n${timeout}\n${tally}\n     Errors  4 errors`,
        1,
        passedThrough,
        0,
      ],
      [
        'two workspaces, both lost to the transport',
        `${timeout}\n Tests  5 passed (5)\n     Errors  1 error\nError: [vitest-worker]: Timeout calling "y"\n Tests  7 passed (7)\n     Errors  1 error`,
        1,
        passedThrough,
        0,
      ],
      // Absent evidence refuses the pass rather than granting it: no summary
      // line at all, no passing tally, or a failing tally.
      [
        'transport timeout, no error summary to count',
        `${timeout}\n${tally}`,
        1,
        stands,
      ],
      [
        'transport timeout, no tally to back it',
        'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',
        1,
        stands,
      ],
      // Vitest's own summary is the only thing that grants the pass, so a
      // run that never printed a tally does not get one even when its error
      // count is all transport.
      [
        'error summary with no tally to back it',
        `${timeout}\n     Errors  1 error`,
        1,
        stands,
      ],
      // `Timeout calling` in a test's own output is not the transport dying:
      // the branch is entered on Vitest's own `[vitest-worker]:` message, so
      // a log carrying only the words is unexplained, not passed through.
      [
        'Timeout calling printed by a test',
        `Timeout calling the vendor API\n${tally}`,
        1,
        '::error title=Workspace tests exited 1 with no failing test::',
      ],
      // ...and the count is anchored on the same message, so those words
      // beside a real transport death do not inflate it into a mismatch.
      [
        'transport timeout, and Timeout calling printed by a test',
        `${timeout}\nTimeout calling the vendor API\n${tally}\n     Errors  1 error`,
        1,
        passedThrough,
        0,
      ],
      // ...and the summary sum is anchored on the section-line shape for the
      // same reason. Vitest echoes a test's console output at column 0, so a
      // workspace printing summary-shaped fixture data lands there; an
      // unanchored `Errors  N errors` match would add it to the sum, inflate
      // `errors` past `timeouts`, and refuse a pass-through every test
      // earned — the false-red this PR exists to remove, back again.
      [
        'transport timeout, and a summary-shaped line a test printed',
        `${timeout}\nErrors 2 errors occurred in fixture data\n${tally}\n     Errors  1 error`,
        1,
        passedThrough,
        0,
      ],
      [
        'transport timeout, failing tally',
        `${timeout}\n Tests  3 failed | 10611 passed (10614)\n     Errors  1 error`,
        1,
        stands,
      ],
      // One workspace can print a passing tally while a later one fails
      // without ever emitting a FAIL line, so the failing tally is checked
      // across the whole log rather than trusted to the branch above.
      [
        'passing tally in one workspace, failing tally in another',
        `${timeout}\n Tests  10 passed (10)\n Test Files  1 failed (3)\n     Errors  1 error`,
        1,
        stands,
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
          ['-e', '-o', 'pipefail', workspaceTestScriptPath, '1'],
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
      "${{ !cancelled() && needs.prepare.result == 'success' && github.event.inputs.force_skip_tests != 'true' }}",
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
    expect(testStep.run).toBe(
      '.release-workflow/.github/scripts/run-release-docker-integration.sh',
    );
    expect(dockerIntegrationScript).toContain(
      'docker-sandbox-build-release-${sandbox_revision}.lock',
    );
    expect(dockerIntegrationScript).toContain('flock --wait 1800 8');
    expect(dockerIntegrationScript).toContain(
      'exec 9>"${HOME}/.cache/qwen-code-ci/docker-sandbox-daemon.lock"',
    );
    expect(dockerIntegrationScript).toContain('-release-${sandbox_revision}');
    expect(dockerIntegrationScript).toContain('--no-prune -i "$sandbox_image"');
    expect(dockerIntegrationScript).toContain(
      'export QWEN_SANDBOX_IMAGE="$sandbox_image_id"',
    );
    expect(dockerIntegrationScript).toContain('flock --shared --wait 1800 9');
    // The daemon lock stays shared for the whole step: upgrading it to
    // exclusive to build an image starves the build behind the test phase of
    // any run already on the host (run 33637097713). Builds serialize on a
    // separate host mutex that no test phase holds.
    expect(dockerIntegrationScript).toContain(
      'exec 7>"${HOME}/.cache/qwen-code-ci/docker-sandbox-build.lock"',
    );
    expect(dockerIntegrationScript).toContain('flock --wait 1800 7');
    expect(dockerIntegrationScript).not.toContain('acquire_daemon_write_lock');
    expect(dockerIntegrationScript).not.toContain('flock --unlock 9');
    expect(dockerIntegrationScript).not.toContain('flock --nonblock 9');
    // A flock lives on the open file description: a descendant inheriting
    // the descriptor past the job would keep the lock on the host.
    expect(dockerIntegrationScript).toContain(
      '-i "$sandbox_image" 7>&- 8>&- 9>&-',
    );
    expect(dockerIntegrationScript).toContain('exec 7>&-');
    expect(dockerIntegrationScript).toContain('exec 8>&-');
    expect(dockerIntegrationScript).toContain('integration-tests cli 9>&-');
    expect(dockerIntegrationScript).toContain(
      'integration-tests interactive 9>&-',
    );
  });

  it('reaps only the Docker integration containers owned by its job', () => {
    const owner = '${{ github.run_id }}-${{ github.run_attempt }}-release';
    const steps = releaseYaml.jobs.integration_docker.steps;
    const testStep = steps.find(
      (step) => step.name === 'Run Docker Integration Tests',
    );
    const cleanupStep = steps.find(
      (step) => step.name === 'Remove job-owned release containers',
    );

    expect(testStep.env.RELEASE_CONTAINER_OWNER).toBe(owner);
    expect(testStep.env.SANDBOX_FLAGS).toContain(
      'org.qwen-code.ci.owner=${RELEASE_CONTAINER_OWNER}',
    );
    expect(dockerIntegrationScript).toContain(
      'trap cleanup_release_containers EXIT',
    );
    expect(dockerIntegrationScript).toContain("trap 'exit 1' INT TERM");
    expect(dockerIntegrationScript).toContain(
      '--filter "label=org.qwen-code.ci.owner=${RELEASE_CONTAINER_OWNER}"',
    );
    expect(cleanupStep.if).toContain('always()');
    expect(cleanupStep.env.RELEASE_CONTAINER_OWNER).toBe(owner);
    expect(cleanupStep.run).toBe(
      '.release-workflow/.github/scripts/run-release-docker-integration.sh cleanup',
    );
    expect(dockerIntegrationScript).toContain('docker rm -f > /dev/null');
    expect(dockerIntegrationScript.match(/docker ps -aq/g)).toHaveLength(2);
    expect(dockerIntegrationScript).toContain('release containers remain');
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
      // The three bounds an operator can retune without a PR; their defaults
      // are pinned by their own tests above.
      quality_static:
        "${{ fromJSON(vars.QWEN_RELEASE_STATIC_TIMEOUT_MINUTES || '60') }}",
      quality_build:
        "${{ fromJSON(vars.QWEN_RELEASE_BUILD_TIMEOUT_MINUTES || '45') }}",
      quality_typecheck: 30,
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
    expect(releaseStepScript).toContain(
      'git add package.json package-lock.json packages/*/package.json packages/channels/*/package.json integrations/*/package.json integrations/*/qwen-extension.json',
    );
  });

  it('publishes the Mem0 Extension only after trusted publishing bootstrap', () => {
    const publishSteps = releaseYaml.jobs.publish.steps;
    const publishStep = publishSteps.find(
      (step) => step.name === 'Publish npm packages',
    );
    expect(publishStep.env.PUBLISH_EXTERNAL_CONTEXT_MEM0).toContain(
      "vars.NPM_EXTERNAL_CONTEXT_MEM0_TRUSTED_PUBLISHING_ENABLED == 'true'",
    );
    // The audio-capture switch replaced a deleted step-level
    // `if: github.repository == 'QwenLM/qwen-code'` gate. Unpinned, a fork
    // running this workflow would publish @qwen-code/audio-capture.
    expect(publishStep.env.PUBLISH_AUDIO_CAPTURE).toContain(
      "github.repository == 'QwenLM/qwen-code'",
    );
    expect(releaseStepScript).toContain(
      'if [[ "${PUBLISH_AUDIO_CAPTURE}" == "true" ]]; then',
    );
    expect(releaseStepScript).toContain('integrations/external-context-mem0');
    expect(
      releaseStepScript.indexOf('integrations/external-context-mem0'),
    ).toBeLessThan(releaseStepScript.indexOf('packages/audio-capture'));
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
    expect(releaseStepScript).toContain("-f 'event_type=npm-published'");
    expect(releaseStepScript).toContain(
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
    expect(releaseStepScript).toMatch(
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
    expect(releaseStepScript).toMatch(
      /if \[\[ "\$\{IS_DRY_RUN\}" == "false" \]\]; then[\s\S]*?git push --force --set-upstream origin "\$\{release_branch_name\}" --follow-tags\n {4}else\n {6}echo "Dry run enabled\. Skipping push\."/,
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

  it('uses the workflow-pinned guard for old release refs', () => {
    expect(releaseStepScript).toContain(
      'node .release-workflow/scripts/assert-release-version.mjs --assert-unreleased="${RELEASE_VERSION}"',
    );
    expect(releaseStepScript).not.toContain(
      'node scripts/get-release-version.js --assert-unreleased=',
    );
    expect(releaseStepScript).toContain(
      'node .release-workflow/.github/scripts/classify-release-notes.mjs',
    );
    expect(releaseStepScript).toContain(
      'node .release-workflow/.github/scripts/cap-release-notes.mjs',
    );
    expect(releaseStepScript).not.toMatch(
      /node \.github\/scripts\/(?:classify|cap)-release/,
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
    // failure) retries — exit 0, exit 3 (already shipped) and exit 4
    // (malformed version) all stay decisive on the first attempt.
    const releaseBranchStep = releaseYaml.jobs.publish.steps.find(
      (step) => step.id === 'release_branch',
    );
    const pushReleaseBranchStep = releaseYaml.jobs.publish.steps.find(
      (step) => step.id === 'push_release_branch',
    );
    expect(releaseBranchStep.env.CI_BOT_PAT).toBeUndefined();
    expect(releaseBranchStep.env.GITHUB_TOKEN).toBeUndefined();
    expect(pushReleaseBranchStep.env.GITHUB_TOKEN).toBe('${{ github.token }}');
    expect(pushReleaseBranchStep.env.BRANCH_NAME).toBe(
      '${{ steps.release_branch.outputs.BRANCH_NAME }}',
    );
    expect(pushReleaseBranchStep.env.CI_BOT_PAT).toBe(
      '${{ secrets.CI_BOT_PAT }}',
    );
    expect(pushReleaseBranchStep.env.RELEASE_VERSION).toBe(
      '${{ needs.prepare.outputs.release_version }}',
    );
    expect(pushReleaseBranchStep.run).toContain('push-release-branch');
    const guard = releaseStepScript.indexOf(
      'node .release-workflow/scripts/assert-release-version.mjs --assert-unreleased="${RELEASE_VERSION}" || guard_status=$?',
    );
    expect(guard).toBeGreaterThan(
      releaseStepScript.indexOf('if [[ "${IS_DRY_RUN}" == "false" ]]'),
    );
    expect(releaseStepScript.indexOf('for attempt in 1 2 3; do')).toBeLessThan(
      guard,
    );
    expect(
      releaseStepScript.indexOf(
        'git push --force --set-upstream origin "${release_branch_name}" --follow-tags',
      ),
    ).toBeGreaterThan(guard);
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
    expect(releaseStepScript).toMatch(
      /node \.release-workflow\/scripts\/assert-release-version\.mjs --assert-unreleased="\$\{RELEASE_VERSION\}" \|\| guard_status=\$\?[\s\S]*?if \[\[ "\$\{guard_status\}" -eq 3 \]\]; then\n {8}echo "version_refusal=true" >> "\$\{GITHUB_OUTPUT\}"\n {8}exit 1\n {6}fi\n {6}if \[\[ "\$\{guard_status\}" -ne 0 \]\]; then\n {8}exit "\$\{guard_status\}"\n {6}fi/,
    );
    expect(workflow).toContain(
      "version_refusal: '${{ steps.push_release_branch.outputs.version_refusal }}'",
    );
    expect(workflow).toMatch(
      /needs\.publish\.result == 'failure' &&\n {12}needs\.publish\.outputs\.version_refusal != 'true'/,
    );
  });

  it('keeps the guard copy of isExpectedMissingGitHubRelease in sync', () => {
    // The guard ships alone under release.yml's sparse-checkout set, so it
    // cannot import scripts/lib/release-helpers.js — the copy is deliberate.
    // Two copies of a fail-closed hinge can drift, and widening only the
    // guard's copy (a 403 or rate-limit branch) would read a throttled probe
    // as "release absent" and let the force push proceed over a shipped
    // version. Pin the bodies together so a one-sided edit goes red here.
    const bodyOf = (source) =>
      source
        .slice(source.indexOf('function isExpectedMissingGitHubRelease'))
        .split('\n}')[0]
        .replace(/^export /, '');
    const guard = readFileSync('scripts/assert-release-version.mjs', 'utf8');
    const helpers = readFileSync('scripts/lib/release-helpers.js', 'utf8');
    expect(bodyOf(guard)).toBe(bodyOf(helpers));
  });

  it('wires the guard exit code to the process exit status end to end', () => {
    // The workflow reads the guard's decision from the process exit
    // status. Run the real entry point without mocks — a usage error
    // needs no network — so an inverted or dropped process.exit fails
    // here instead of letting a refusal exit 0 at push time.
    const result = spawnSync(
      process.execPath,
      ['scripts/assert-release-version.mjs', '--assert-unreleased='],
      { encoding: 'utf8' },
    );
    // 4 rather than 2: the retry loop in run-release-step.sh breaks on any
    // status other than 2, so a usage error fails fast instead of being
    // logged three times as a transient probe failure.
    expect(result.status).toBe(4);
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
        ['scripts/assert-release-version.mjs', '--assert-unreleased=1.2.3'],
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
    expect(releaseStepScript).toContain(
      'echo "::error::npm-published dispatch failed;',
    );
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
      expect(vars.run).toContain('run-release-step.sh set-flags');
      expect(releaseStepScript).toContain(`"\${CRON}" == "${cron}"`);
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
      const testSteps = job.steps.filter((step) => {
        const command = String(step.run ?? '');
        return (
          !command.endsWith(' cleanup') &&
          /(?:vitest|test:integration|run-release-docker-integration)/.test(
            command,
          )
        );
      });
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
