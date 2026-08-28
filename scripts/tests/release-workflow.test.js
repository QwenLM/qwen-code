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
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// `realpath -m` (the script's canonicalization line) is a GNU coreutils
// extension. Probe the host before asserting GNU-specific path behavior.
const hasGnuRealpath =
  spawnSync('realpath', ['-m', '--', '/'], { stdio: 'ignore' }).status === 0;

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

// The canonical workspace restoration script shared by all five
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
# them; the accepted cost is re-fetching full history each run.
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
if [ -L "$RWS" ]; then
  echo "::error::refusing to wipe: runner workspace is a symlink: \${RWS}"
  exit 1
fi
RWS="$(realpath -m -- "$RWS" 2>/dev/null)" || { echo "::error::refusing to wipe: realpath unavailable, cannot canonicalize \${RUNNER_WORKSPACE}"; exit 1; }
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
      expect(job.steps[restoreIndex]?.if, id).toBe(
        "${{ runner.environment == 'self-hosted' }}",
      );
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
  const ecsRunsOn =
    '${{ (github.repository == \'QwenLM/qwen-code\' && vars.MAINTAINER_ECS_RUNNER_DISABLED != \'true\') && fromJSON(\'["self-hosted", "linux", "x64", "ecs-qwen"]\') || fromJSON(\'["ubuntu-latest"]\') }}';

  it('routes validation jobs to ECS with a hosted emergency fallback', () => {
    const validationJobs = [
      'prepare',
      'quality',
      'integration_none',
      'integration_docker',
    ];
    for (const name of validationJobs) {
      const job = releaseYaml.jobs[name];
      expect(job, `job missing from release.yml: ${name}`).toBeTruthy();
      expect(job['runs-on'], `runs-on drifted on job: ${name}`).toBe(ecsRunsOn);
    }
  });

  it('keeps publishing and failure notification on hosted runners', () => {
    expect(releaseYaml.jobs.publish['runs-on']).toBe('ubuntu-latest');
    expect(releaseYaml.jobs.publish['runs-on']).not.toContain('ecs-qwen');
    expect(releaseYaml.jobs.notify_failure['runs-on']).toBe('ubuntu-latest');
    expect(releaseYaml.jobs.notify_failure['runs-on']).not.toContain(
      'ecs-qwen',
    );
  });
});
