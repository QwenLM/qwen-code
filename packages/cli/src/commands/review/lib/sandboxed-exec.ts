/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Running the reviewed PR's own code behind a container boundary (#9556).
 *
 * A review executes the code it is reviewing. `build-test` runs the commands
 * the reviewed repository's `package.json` names — `npm ci` with its
 * `preinstall`/`postinstall` scripts, the build, the suite — and
 * `test-efficacy` runs that suite again once per baseline, control, mutant,
 * hunk probe and revert. Both did it as the invoking identity, in that
 * identity's environment: measured at the two call sites, the PR's code was
 * handed `process.env` entire, which on CI carries `OPENAI_API_KEY` and
 * `GH_TOKEN`. Reading them is one line in a `postinstall`, and it needs none
 * of the git-config machinery the review pipeline's threat findings are built
 * on.
 *
 * So the boundary goes around the EXECUTIONS, not around the review agent.
 * Wrapping the agent was tried first and is the wrong shape: its secrets do
 * not survive the container's env allowlist, its `timeout` reaps the host-side
 * client rather than the container, its CLI version stops matching the
 * runner's — and after all of it the mount is the whole checkout, so
 * `<repo>/.git` (the `filter.*`, `core.fsmonitor` and `refs/replace` surface)
 * stays writable anyway. Wrapping the commands costs none of that and closes
 * more.
 *
 * Three properties do the work, and each is a decision this module encodes
 * rather than a default it inherits:
 *
 * 1. **The mount is the review temp dir, not the tree the command runs in.**
 *    The dependency farm links OUT of each tree: `exposeDependencies` points
 *    every package in the probe tree's `node_modules` at the review
 *    worktree's copy (measured on a live CI review: 1 722 links). Mounting
 *    one tree would leave all of them dangling. Every tree the pipeline
 *    builds — the review worktree, `-probe`, `-base`, every `-scratch-*` —
 *    is a sibling under `.qwen/tmp`, so one mount covers both ends of every
 *    link while `<repo>/.git` stays outside it.
 * 2. **The environment is an allowlist**, not the inherited one. The PR's
 *    code gets the npm knobs the pipeline sets deliberately and nothing else.
 * 3. **The network is per command kind.** An install needs the registry; a
 *    build and a suite do not. `--network none` keeps loopback, so a suite
 *    that stands up a local fixture server still runs.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { operatorReviewSettings } from './review-settings.js';
import { REVIEW_TMP_DIR } from './paths.js';
import { redirectedAncestor } from './worktree.js';
import { CUSTOM_SANDBOX_IMAGE_ENV_VAR } from '../../../utils/processUtils.js';
import { isFileSourcedEnvKey } from '../../../config/environment.js';

/**
 * The fallback when neither override names an image: the published sandbox
 * image for this CLI line. Pinned by tag rather than digest on purpose — a
 * digest would go stale in a file nobody updates, and the override exists for
 * anyone who needs reproducibility.
 */
const DEFAULT_IMAGE = 'ghcr.io/qwenlm/qwen-code/sandbox:latest';

/** Container runtimes this module knows how to drive, in preference order. */
const RUNTIMES = ['docker', 'podman'] as const;
export type ContainerRuntime = (typeof RUNTIMES)[number];

/**
 * What the operator asked for.
 *
 * - `off` — run the PR's commands directly, as every review does today.
 * - `auto` — use a container when one is available, run directly when not.
 * - `required` — refuse to run the PR's commands unsandboxed. The caller
 *   reports the affected evidence unavailable; it does not abandon the review.
 */
export type SandboxPolicy = 'off' | 'auto' | 'required';

const POLICIES: readonly string[] = ['off', 'auto', 'required'];

/**
 * The policy for this run.
 *
 * `QWEN_REVIEW_SANDBOX` wins, so CI can require containment without depending
 * on a settings file the runner may not carry. Below it, `review.sandbox` is
 * read through {@link operatorReviewSettings}, which loads the operator scopes
 * ONLY — a repository must not be able to switch off the containment that
 * exists to contain it, and `.qwen/settings.json` is repository content the
 * review reads.
 *
 * The default is `off`: today every review runs the PR's code directly, and
 * turning that into a container by default would change what `npm ci` builds
 * (native modules against a different libc) on machines nobody asked. CI opts
 * in explicitly; a local operator opts in when they want it.
 */
export function sandboxPolicy(
  env: NodeJS.ProcessEnv = process.env,
  // Injected so a test can pin the settings half without a settings file on
  // disk deciding the outcome.
  settings: { sandbox?: string } = operatorReviewSettings(),
  fileSourced: (key: string) => boolean = isFileSourcedEnvKey,
): SandboxPolicy {
  // The env layer is READ, but it may only ever tighten, and only when the
  // value is a real process variable.
  //
  // Both halves are load-bearing, and the first cut had neither. `process.env`
  // is not the operator's alone: `loadEnvironment` walks up from cwd and
  // applies `<repo>/.qwen/.env` — repository content, from the very checkout
  // under review, admitted by default because folder trust starts off. Letting
  // that outrank the setting made the guarantee this module advertises
  // ("a repository cannot switch off the containment that exists to contain
  // it") true of `settings.json` and false in practice: `QWEN_REVIEW_SANDBOX=off`
  // in a committed `.env` disabled it. So a file-sourced value is ignored here,
  // and even a genuine process variable can only raise the policy, never lower
  // it — a CI workflow's `env:` block requiring containment still works, while
  // nothing reachable by the reviewed repository can take it away.
  const raw = env['QWEN_REVIEW_SANDBOX']?.trim().toLowerCase();
  const fromEnv =
    raw && POLICIES.includes(raw) && !fileSourced('QWEN_REVIEW_SANDBOX')
      ? (raw as SandboxPolicy)
      : undefined;
  const setting = settings.sandbox;
  const fromSettings =
    setting && POLICIES.includes(setting)
      ? (setting as SandboxPolicy)
      : undefined;
  const strictest = (a: SandboxPolicy, b: SandboxPolicy) =>
    POLICIES.indexOf(a) >= POLICIES.indexOf(b) ? a : b;
  if (fromEnv && fromSettings) return strictest(fromEnv, fromSettings);
  return fromEnv ?? fromSettings ?? 'off';
}

let probed: ContainerRuntime | null | undefined;

/**
 * The first runtime whose daemon actually answers, or null.
 *
 * `<rt> info` rather than presence on `PATH`: a docker client with no
 * reachable daemon is the shape that otherwise fails deep inside the first
 * command, after an install has already burned minutes — the same reason
 * `qwen-autofix.yml` preflights the daemon before its sandboxed agent starts.
 */
export function containerRuntime(force = false): ContainerRuntime | null {
  if (!force && probed !== undefined) return probed;
  probed = null;
  for (const runtime of RUNTIMES) {
    const r = spawnSync(runtime, ['info'], {
      stdio: 'ignore',
      timeout: 30_000,
      env: runtimeClientEnv(),
    });
    if (!r.error && r.status === 0) {
      probed = runtime;
      break;
    }
  }
  return probed;
}

/** Test seam: forget the probed runtime. */
export function resetContainerRuntimeProbe(): void {
  probed = undefined;
}

/** What a caller must do with one command. */
export type SandboxVerdict =
  | { kind: 'direct'; disclose?: string }
  | { kind: 'container'; runtime: ContainerRuntime }
  | { kind: 'refused'; reason: string };

/**
 * Decide once, for this run, how the PR's commands are to be executed.
 *
 * `SANDBOX` set means this process is ALREADY inside the CLI's own sandbox
 * (`sandbox.ts` sets it to the seatbelt profile or the container name), so a
 * container here would be a container inside a container: the outer boundary
 * is the one the operator asked for, and this returns `direct`.
 */
export function sandboxVerdict(
  policy: SandboxPolicy = sandboxPolicy(),
  env: NodeJS.ProcessEnv = process.env,
  // Injected so a test's outcome does not depend on whether the machine
  // running it happens to have a daemon — this decides whether the reviewed
  // code is contained, and a test that answers differently on two machines
  // pins nothing.
  probe: () => ContainerRuntime | null = containerRuntime,
): SandboxVerdict {
  // NOTE: `SANDBOX` being set is NOT a shortcut past the policy. The first cut
  // returned `direct` for it, reasoning that the outer boundary is the one the
  // operator asked for — which is wrong for the property this module is about.
  // The CLI's own sandbox constrains the filesystem and the network; it hands
  // the child `process.env` entire, secrets included, and stripping those is
  // half of what `required` promises. An already-sandboxed session that also
  // wants an env allowlist gets it the same way everyone else does: the probe
  // below finds a runtime or it does not, and `required` refuses if it does
  // not. The disclosure survives on the direct path, where it is useful.
  if (policy === 'off') {
    return {
      kind: 'direct',
      disclose:
        'the PR’s own build and test commands ran as you, in your environment — ' +
        'set review.sandbox to "auto" or "required" to run them in a container',
    };
  }
  const runtime = probe();
  if (runtime) return { kind: 'container', runtime };
  if (policy === 'required') {
    return {
      kind: 'refused',
      reason:
        'review.sandbox is "required" and no container runtime answered ' +
        `(tried ${RUNTIMES.join(', ')})` +
        (env['SANDBOX']
          ? ' — this session is itself sandboxed, which constrains the ' +
            'filesystem but still hands the PR’s commands this process’s ' +
            'environment, so it does not satisfy "required"'
          : ''),
    };
  }
  return {
    kind: 'direct',
    disclose: env['SANDBOX']
      ? 'no container runtime answered; the PR’s commands ran inside this session’s own sandbox, which does not strip its environment'
      : 'no container runtime answered, so the PR’s commands ran directly',
  };
}

/**
 * The one place a `required` refusal becomes an outcome.
 *
 * `sandboxVerdict` can say `refused`, and the first cut left acting on it to
 * "the caller" — where no caller acted, so `required` ran the reviewed code
 * unsandboxed with the full environment and the policy meant nothing. It has
 * to be decided ONCE, at the top of a phase, before anything executes:
 *
 * - the two spawn sites cannot refuse usefully — by the time they are reached
 *   the phase has committed to producing a verdict, and a per-command refusal
 *   would read as a build failure rather than as absent evidence;
 * - one of them is not even on the path. When the toolchain cannot be scoped
 *   (a yarn/pnpm/bun repo, no `package-lock.json` — `unsupportedReport`), the
 *   pipeline hands the install/build/test to the AGENT's own shell, which
 *   never passes through `run()` at all. A gate at the spawn would leave that
 *   route wide open under the very policy that forbids it.
 *
 * Returns the reason when the phase must not execute the reviewed repository's
 * code, or null when it may.
 */
export function refuseUnsandboxedPhase(
  // The tree this phase would execute in. Required, because "is a runtime
  // running" is the wrong question — see below.
  root: string,
  verdict: SandboxVerdict = sandboxVerdict(),
  mountRoot: (cwd: string) => string | null = mountRootFor,
): string | null {
  if (verdict.kind === 'refused') return verdict.reason;
  if (verdict.kind === 'direct') return null;
  // A runtime answering is not containment. The first cut asked only whether
  // one did, and every route the container cannot actually serve still ran the
  // reviewed code with the full environment under `required`: a `/review` of a
  // local checkout has no `.qwen/tmp` layout to mount, so `mountRootFor`
  // returns null, the command falls through to the direct spawn, and the
  // report is indistinguishable from a contained run. The question the policy
  // asks is whether THIS phase can be contained, and the mount is the half
  // that can fail while the runtime is healthy.
  if (mountRoot(root) === null) {
    return (
      'review.sandbox is "required" and this tree cannot be mounted: it is ' +
      `not under a review temp dir (${root}), which is the layout the ` +
      'container boundary is built on — a review of a local checkout has no ' +
      'such layout, so its commands cannot be contained'
    );
  }
  return null;
}

/** Whether one command needs the network. */
export type CommandKind = 'install' | 'build' | 'test';

/**
 * The environment the PR's code is given inside the container.
 *
 * An allowlist rather than the inherited environment, which is the point:
 * today both call sites hand it `process.env`, and on CI that carries the
 * review's model and GitHub credentials. `CI` and the npm knobs are the ones
 * the pipeline sets on purpose (`buildRunEnv`), so they are the ones that
 * cross.
 */
export const CONTAINER_HOME = '/qwen-review-home';

export function containerEnv(cacheDir: string): string[] {
  return [
    'CI=1',
    'npm_config_yes=true',
    'QWEN_SKIP_PREPARE=1',
    // `HOME` explicitly, because forcing a uid resets it to `/` in these
    // images — `utils/sandbox.ts` copies the host's for the same reason — and
    // `/` is not writable by the mapped user, so npm's first write fails
    // before the install starts.
    //
    // And it points at a TMPFS, not at the mount. The first cut put it under
    // the mount and shared it across every command of every tree: `sh -lc` is
    // a login shell that sources `$HOME/.profile`, and npm reads
    // `$HOME/.npmrc`, so one run's postinstall could plant both and the NEXT
    // review's install — network on — would source and read them. That is
    // cross-run execution wearing this module's own `--rm` "isolation by
    // construction" claim, and it was introduced by the fix for the `$HOME`
    // problem rather than found in the original. A tmpfs is discarded with the
    // container and never touches the host, so the claim is true again.
    `HOME=${CONTAINER_HOME}`,
    // The npm cache stays on the mount, deliberately: it is what keeps an
    // install from re-downloading ~1 700 packages every review, it holds no
    // rc file or profile, and npm verifies each entry's integrity hash on
    // read. That verification is what stands between a poisoned cache and a
    // bad install — worth naming rather than implying the cache is inert.
    `npm_config_cache=${cacheDir}`,
  ];
}

/**
 * The directory to mount for a command running in `cwd`, or null when `cwd` is
 * not one of the pipeline's trees.
 *
 * Not the tree: the dependency farm links out of every tree into the review
 * worktree's `node_modules`, so a per-tree mount leaves every link dangling.
 * Every tree the pipeline builds is a sibling under the review temp dir, so
 * that directory covers both ends of every link while `<repo>/.git` stays
 * outside it.
 *
 * `lastIndexOf`, because a review run from inside another review's worktree —
 * this pipeline's own dogfood geometry — nests one `.qwen/tmp` inside another,
 * and the FIRST occurrence would widen the mount to the outer temp dir,
 * pulling `<repo>/.git` and every sibling checkout in with it. Tree names
 * cannot contain a separator (scratch labels flatten to `[A-Za-z0-9._-]`), so
 * the deepest occurrence is always the tree's own parent.
 *
 * Null for a cwd outside any temp dir — a `/review` of a local checkout, where
 * the tree under test IS the user's working copy and there is no sibling
 * layout to mount.
 */
export function mountRootFor(cwd: string): string | null {
  const resolved = resolve(cwd);
  const marker = `${sep}${REVIEW_TMP_DIR}${sep}`;
  const at = resolved.lastIndexOf(marker);
  if (at < 0) return null;
  const root = resolved.slice(0, at + marker.length - 1);
  // A LEXICAL root is not a safe mount target. `resolve` never touches the
  // filesystem, so a symlink at or above `.qwen/tmp` — committable as mode
  // 120000 and materialised by a fresh clone — silently widens a read-write
  // bind mount to wherever it points. Every other creating or destroying path
  // in this pipeline refuses that (`runCleanup`, `releaseWorktree`,
  // `resetScratchTree`); the mount is the one place a redirect would hand the
  // reviewed code a directory nobody chose.
  try {
    if (redirectedAncestor(root, dirname(resolve(root, '..', '..'))) !== null) {
      return null;
    }
    return realpathSync(root);
  } catch {
    return null;
  }
}

export interface ContainerCommandOptions {
  /** Where the command runs — a tree under `tmpDir`. */
  cwd: string;
  /** The review temp dir (`<repo>/.qwen/tmp`): the mount, and the farm's far end. */
  tmpDir: string;
  kind: CommandKind;
  runtime: ContainerRuntime;
  image: string;
}

/**
 * The argv that runs `command` in a container, for `spawnSync` WITHOUT a
 * shell — the command itself still reaches a shell, inside.
 */
export function containerCommand(
  command: string,
  opts: ContainerCommandOptions,
): { file: string; args: string[] } {
  const args = [
    'run',
    '--rm',
    '--init',
    // One ephemeral container per command, deliberately. A long-lived one per
    // phase would be cheaper by a few hundred milliseconds a run — against a
    // 540-second budget, one to two percent — and would re-introduce exactly
    // the cross-run state this pipeline has spent rounds closing: a tracked
    // file one run rewrote, an ignored plant a sweep honoured. `--rm` is
    // isolation by construction rather than by hygiene.
    '--volume',
    `${opts.tmpDir}:${opts.tmpDir}`,
    '--workdir',
    opts.cwd,
  ];
  if (opts.kind !== 'install') args.push('--network', 'none');
  // The container writes into a mount the HOST pipeline then has to clean up —
  // `node_modules` after an install timeout, the tree itself at `discardWorktree`,
  // the sweeps. The default image runs as root (`node:22-slim`, no `USER`), so
  // without this every one of those hits EACCES and the residue accumulates
  // across reviews: the cross-run-state class this pipeline has spent rounds
  // closing. `utils/sandbox.ts` maps the same pair for the same hazard on the
  // same image lineage, and honours the same opt-out.
  //
  // Known limit, stated rather than papered over: `--user` with a bare
  // uid:gid leaves that uid absent from the container's `/etc/passwd`, so a
  // tool that calls `getpwuid` (rather than reading `$HOME`) still sees an
  // unknown user. `utils/sandbox.ts` avoids that by starting as root and
  // `useradd`-ing the host's ids — machinery this does not need, because what
  // runs here is a shell command, not the CLI whose `os.userInfo()` requires
  // the entry. If a toolchain turns out to need it, that is the shape to copy.
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (
    uid !== undefined &&
    gid !== undefined &&
    // The opt-out is the operator's, not the repository's: a committed
    // `SANDBOX_SET_UID_GID=false` would put the container back to root and
    // leave root-owned residue the host cannot sweep.
    !(
      !isFileSourcedEnvKey('SANDBOX_SET_UID_GID') &&
      process.env['SANDBOX_SET_UID_GID']?.toLowerCase().trim() === 'false'
    )
  ) {
    args.push('--user', `${uid}:${gid}`);
  }
  // `mode=1777` so the mapped uid owns what it writes there: a tmpfs mounts
  // root-owned by default, and `--user` would then be unable to write its own
  // HOME — the very failure this HOME exists to prevent.
  args.push('--tmpfs', `${CONTAINER_HOME}:rw,mode=1777`);
  for (const entry of containerEnv(join(opts.tmpDir, '.npm-cache'))) {
    args.push('--env', entry);
  }
  args.push(opts.image, 'sh', '-lc', command);
  return { file: opts.runtime, args };
}

/**
 * The image the reviewed repository's commands run in.
 *
 * Defaults to the CLI's own sandbox image, which already carries a Node
 * toolchain — the same image `qwen --sandbox` uses, so a repository that
 * builds under one builds under the other. `QWEN_REVIEW_SANDBOX_IMAGE`
 * overrides it for a repository whose toolchain needs more (a JDK, a Python,
 * a specific Node major), which is the case this default cannot cover and
 * should not pretend to.
 */
export function reviewSandboxImage(
  env: NodeJS.ProcessEnv = process.env,
): string {
  // File-sourced overrides are ignored for the same reason the policy ignores
  // them, and this one is sharper: the image IS the code the reviewed
  // repository's commands run inside, so a `.env` committed in that repository
  // naming its own image would be arbitrary execution wearing the containment's
  // name.
  const pick = (key: string) =>
    isFileSourcedEnvKey(key) ? undefined : env[key]?.trim();
  return (
    pick('QWEN_REVIEW_SANDBOX_IMAGE') ||
    pick(CUSTOM_SANDBOX_IMAGE_ENV_VAR) ||
    DEFAULT_IMAGE
  );
}

/**
 * The environment the container RUNTIME CLIENT is spawned with.
 *
 * `DOCKER_HOST` and its TLS companions decide which daemon answers — so a
 * repository that ships one in `.qwen/.env` points both the availability probe
 * and every `docker run` at a daemon it controls: `required` reads as
 * satisfied, the mount is handed over, and whatever that daemon returns is
 * scored as build, test and probe evidence. An operator's own `DOCKER_HOST`
 * (a remote engine, colima, rootless) is untouched — only the file-sourced
 * ones are dropped.
 */
export function runtimeClientEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const scrubbed = { ...env };
  for (const key of [
    'DOCKER_HOST',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CONTEXT',
    'CONTAINER_HOST',
  ]) {
    if (isFileSourcedEnvKey(key)) delete scrubbed[key];
  }
  return scrubbed;
}
