# Linux kernel sandbox (bwrap + landlock-run) design

[English](2026-09-09-linux-kernel-sandbox.md) | [简体中文](2026-09-09-linux-kernel-sandbox.zh-CN.md)

Internal design document for giving qwen-code kernel-level isolation on Linux
hosts that have no container runtime — closing the gap where today
`--sandbox` on Linux means "docker/podman or nothing", and
`QWEN_SANDBOX=false` is the default of the entire integration-test matrix, so
most Linux users run the agent with no OS-level confinement at all.

Reference points verified against source in this repo and against the
published sources of three comparable agents (Codex CLI, Claude Code,
DeepSeek Harness) on 2026-09-09; see § Evidence.

## Phase 0 — Verified baseline before this PR

This section records the pre-implementation state inspected on 2026-09-09. P0 below describes the delivered bwrap changes; the baseline statements are not claims about the current branch. References to changed code use file names and symbols rather than obsolete line offsets.

| Fact                                                                                           | Evidence                                                                                                         |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Sandbox is a whole-CLI re-exec ("hop"), never per-command                                      | `packages/cli/src/llm.tsx` (`main`, sandbox hop) calls `loadSandboxConfig` → `start_sandbox` → `process.exit(0)` |
| Backends today: `docker`, `podman`, `sandbox-exec` only                                        | `packages/cli/src/config/sandboxConfig.ts` (`VALID_SANDBOX_COMMANDS`)                                            |
| On Linux, container backends are only candidates when sandbox was enabled explicitly           | `sandboxConfig.ts` (`getSandboxCommand`) — `sandbox === true` gates the docker/podman push                       |
| No landlock/seccomp/bwrap/unshare isolation implementation exists in the repo                  | grep over `packages/**/*.ts` — only incidental matches                                                           |
| macOS Seatbelt: 6 builtin `.sb` profiles, `(allow default)` + deny-write whitelist posture     | `packages/cli/src/serve/sandbox-macos-*.sb`; `sandbox.ts` (`BUILTIN_SEATBELT_PROFILES`)                          |
| The sandbox-exec branch of `start_sandbox` is the structural template for any in-place backend | `packages/cli/src/serve/sandbox.ts` (`start_sandbox`, Seatbelt)                                                  |
| `SANDBOX` env var marks "already inside the sandbox" and is consumed by UI/warnings/preconnect | `sandboxConfig.ts` (`getSandboxCommand`), `headlessSafetyWarnings.ts:43`, `systemInfo.ts:141`                    |
| `SandboxConfig.image` is currently required for every command                                  | `packages/core/src/config/config.ts` (`SandboxConfig`), `sandboxConfig.ts` (`loadSandboxConfig`)                 |
| Update-relaunch handoff branches on `command !== 'sandbox-exec'` (container vs non-container)  | `packages/cli/src/llm.tsx` (`main`, sandbox handoff)                                                             |
| Vendored platform binaries are committed to git and shipped via `files: [dist, vendor, ...]`   | `packages/core/vendor/ripgrep/<arch>-<platform>/rg`, `git ls-files packages/core/vendor/`                        |
| Integration matrix default is `QWEN_SANDBOX=false`                                             | root `package.json:57,61,64` (`test:integration:*:sandbox:none`)                                                 |

Comparator facts (verified against Codex CLI source, dsh source, and Claude
Code binary evidence; details in § Evidence):

- Codex: `seccompiler` + `landlock` crates + vendored bubblewrap; Seatbelt
  `.sbpl` with `(deny default)`; two native Windows sandbox backends;
  `codex sandbox` first-class subcommand; `SandboxPolicy` variants carry
  `network_access`.
- dsh: bwrap preferred, fallback to a self-written 299-line C11
  `landlock-run` (musl-static, self-restrict-then-exec, fail-closed,
  `full`/`partial` enforcement reporting, launcher-failure exit 125
  contract); distributed as platform optional npm packages.
- Claude Code: bwrap + seccomp on Linux without a container runtime;
  `CLAUDE_CODE_FORCE_SANDBOX`; `--no-sandbox` itself blocked by its own
  auto-mode rules.

## Goals / non-goals

**Goals**

1. Linux confinement that needs **no root, no daemon, no image, no compiler
   on the consumer host** — usable on rootless CI, shared build machines,
   and minimal containers.
2. Slot into the existing hop architecture (`loadSandboxConfig` →
   `start_sandbox`) with the same writable-root semantics the macOS Seatbelt
   path already exposes.
3. Fail-closed everywhere a sandbox was explicitly requested; honestly
   report enforcement level (`full` / `partial` / `none`) everywhere it was
   not.
4. Ship in reviewable increments: opt-in first, default flip last.

**Non-goals**

- No Starlark-style policy language (the existing tree-sitter AST + rule
  layer is the command-decision plane; this design is the isolation plane).
- No built-in MITM network proxy (Codex's five-figure-line network-proxy).
  The existing `QWEN_SANDBOX_PROXY_COMMAND` hook remains the proxied story.
- No Windows native sandbox (a separate, larger investment; dsh's
  ACL/restricted-token design is the reference when that work starts).
- No per-command confinement in v1 (see D2).
- No change to macOS Seatbelt profiles or the container backends.

## Design decisions

### D1 — Two Linux backends: system `bwrap` preferred, vendored `landlock-run` fallback

**Decision.** Add two new sandbox commands:

- `bwrap` — uses the host's bubblewrap (in every mainstream distro's repos).
  Probe is **functional**: run a minimal confined `true`, not `--version`
  (an installed bwrap still fails where `kernel.unprivileged_userns_clone=0`
  or an LSM denies `mount`).
- `landlock` — uses a vendored `qwen-landlock-run` helper: a ~300-line C11
  program over the raw Landlock UAPI, statically linked with musl, committed
  per-arch under `packages/core/vendor/landlock-run/`. Landlock is an
  independent syscall family that needs neither user namespaces nor mount
  privileges, so it works exactly where bwrap cannot.

**Why this shape.** Node cannot link seccomp/Landlock libraries the way
Codex's Rust does; the confinement must be applied by an executable we
spawn. dsh proved the fallback-helper pattern is cheap (299 lines, one
file, zero libraries beyond musl) and shippable without ever compiling on
the consumer host.

**Why bwrap first.** Zero new bytes to ship, and `--ro-bind / /` gives a
read-only host root with per-directory writable overrides in a single flag. It
can also unshare the PID and network namespaces; only the network one is used
here — D6 explains why the PID namespace is left alone.

### D2 — Hop granularity (match the Seatbelt branch), not per-command

**Decision.** The new backends wrap the whole CLI re-exec in
`start_sandbox`, exactly like `sandbox-exec` today. Per-command confinement
(wrapping each `run_shell_command` spawn, as Codex/dsh do) is explicitly
deferred.

**Rationale.** The hop requires touching only `sandboxConfig.ts`,
`sandbox.ts`, `config.ts` (type), `llm.tsx` (handoff branch), and
`systemInfo.ts`. Per-command confinement requires a policy carrier through
core's tool scheduler, per-call network decisions (the LLM client must stay
unconfined — the reason our Seatbelt `proxied` profile exists), and a
denial-escalation UX. It is a separate design; the hop gets ~90% of the
protection (agent-executed commands cannot escape the workspace) for ~10%
of the surgery.

**Accepted cost — denial visibility.** A hop confines the whole process, so a
refused write reaches the model as a bare `EROFS`/`EACCES` from
`run_shell_command` with nothing marking it as a _policy_ denial. dsh recorded
the failure mode that produces: "a denial with no escalation path is terminal —
the model can only give up, which pressure-cooks operators into configuring
`danger-full-access` globally and defeats the sandbox." A denial marker plus a
one-shot escalation is exactly what per-command confinement buys, so v1
mitigates rather than solves — and the mitigation is an edit to machinery that
already exists:

`core/src/core/prompts.ts` (`getCoreSystemPrompt`) already branches the system prompt on
`process.env['SANDBOX']`: `'sandbox-exec'` yields a "# macOS Seatbelt"
section, any other non-empty value yields a "# Sandbox" section, and unset
yields "# Outside of Sandbox". Two consequences:

- Without an edit, `SANDBOX=bwrap` falls into the generic branch and the model
  is told it "is running in a sandbox **container**" — wrong, and it names
  `Operation not permitted` while bwrap denials read `Read-only file system`.
- With a small added branch the boundary becomes accurate and self-describing:
  name the backend and writable-root boundary, distinguish read-only mount
  refusals (`EROFS`) from ordinary permissions (`EACCES`), and instruct the
  model to report a confinement refusal instead of detouring around it.

That branch is a P0 work item (see § Phase P0), not a follow-up.

### D3 — Vendored binary committed to git, with a reproducibility CI gate

**Decision.** `qwen-landlock-run` binaries live at
`packages/core/vendor/landlock-run/{x64,arm64}-linux/qwen-landlock-run`,
committed to git — following the existing ripgrep/tree-sitter precedent
(`git ls-files packages/core/vendor/`). The C source lives alongside at
`packages/core/vendor/landlock-run/src/qwen-landlock-run.c` with
`scripts/build_landlock_run.mjs` (`musl-gcc -static -O2`). A CI job rebuilds
from source on both arches and fails if the committed bytes differ.

**Alternatives considered.**

- _Platform optional npm packages (dsh's model)_ — cleaner supply chain,
  but adds a second publish pipeline; qwen-code already pays the
  committed-binary cost for ripgrep, so one mechanism covers both. Revisit
  if the vendored set grows.
- _Compile on install_ — rejected (dsh's words: "a fallback that exists
  only where a compiler happens to be is not a fallback"; also our
  `postinstall` is already load-bearing for ripgrep and must stay fast).
- _Commit binary without a rebuild gate_ — rejected: an unverifiable blob
  is an unreviewable diff; the rebuild-and-compare CI job is the compromise
  that keeps the ripgrep-style distribution honest.

### D4 — Enforcement honesty: `full` / `partial` / `none` is reported, never promised

**Decision.**

- Every backend probe reports an enforcement level: bwrap ⇒ `full` for
  the selected mount policy (the functional probe exercises mount setup,
  not isolation from all host capabilities); landlock ⇒ `full` or `partial` by kernel ABI negotiation (older
  ABIs cannot govern newer access bits — e.g. `truncate` before ABI 3);
  containers ⇒ `full` (their boundary is the runtime's problem).
- Explicitly requested sandbox (`--sandbox`/`QWEN_SANDBOX` naming a command,
  or `=true`) whose probe fails ⇒ `FatalSandboxError` (existing behavior,
  kept). **Silent unconstrained passthrough is never legal for an explicit
  request.**
- Implicit absence (Linux, sandbox not requested) ⇒ run unconfined. No new UI
  surface is added for it: `getSandboxEnv()` already answers `no sandbox`
  (`systemInfo.ts:143-148`), and `headlessSafetyWarnings.ts` already covers the
  headless-yolo case.
- The level travels into the sandboxed child via `SANDBOX_ENFORCEMENT` so
  the UI can render it (e.g. `landlock (partial, kernel ABI 3)`).

### D5 — Network policy: three modes mapped onto the existing proxy hook

**Decision.** `open` (share net) / `closed` (`--unshare-net`) / `proxied`
(share net + inject `HTTP(S)_PROXY` toward a host-side
`QWEN_SANDBOX_PROXY_COMMAND`). Resolution: a non-empty `QWEN_SANDBOX_NET` that
is not one of `closed`/`open`/`proxied` is rejected at startup (`Invalid
QWEN_SANDBOX_NET …`) — a typo on the hard-deny switch must never fall through
to the least restrictive mode. Otherwise:

1. `QWEN_SANDBOX_NET=closed` ⇒ closed (hard deny, wins over proxy config).
2. `QWEN_SANDBOX_NET=proxied` without a non-blank `QWEN_SANDBOX_PROXY_COMMAND` ⇒ startup error.
3. else `QWEN_SANDBOX_PROXY_COMMAND` set ⇒ proxied.
4. else ⇒ open.

This mirrors the Seatbelt profile matrix (open/closed/proxied) without
introducing a new profile vocabulary in v1.

`closed` is a whole-network-namespace cut, not an egress filter: it also
removes loopback, so the IDE companion (discovered through a port in the
`~/.qwen/ide` lock file, `core/src/ide/ide-client.ts:644-678`), a host-side
`qwen serve` on `:4170`, and any localhost MCP server all become unreachable.
Abstract-namespace unix sockets are per-network-namespace too, so an X11
connection that resolves to the abstract socket dies with them. `closed` is
therefore correct only for single-shot confined runs; the § Verified
compatibility impacts table records this rather than hiding it behind a mode
name.

### D6 — No PID namespace, because PID liveness is load-bearing

**Decision.** The bwrap profile does **not** unshare the PID namespace, and no
switch is added to turn it on. `--proc /proc` is likewise absent — but not for
the reason an earlier draft of this document gave. That draft claimed mounting a
fresh procfs from inside a user namespace requires owning the PID namespace;
measured on kernel 7.0.0 with bwrap 0.11.1, `--proc /proc` **without**
`--unshare-pid` mounts fine, so the claim was wrong. The flag is omitted because
it is unnecessary and slightly looser: the recursive `--ro-bind / /` already
brings the host `/proc` in read-only — measured at 133 visible numeric entries,
which is all Node needs — whereas a fresh procfs instance would be mounted
read-write.

**Rationale.** qwen-code arbitrates cross-process ownership by PID. The following are examples, not an exhaustive list of readers:

- `cli/src/serve/conversations/conversation-runtime-ownership.ts:44-65` — an
  owner record carries `pid`, and `processIsAlive()` treats anything that is not
  `ESRCH` as alive;
- `cli/src/serve/live/discovery.ts:147` — the same predicate;
- `core/src/services/worktreeSessionService.ts:424-446` — the same predicate,
  behind a `status.hostname !== os.hostname()` guard that conservatively answers
  `active` for a record written by another machine.

Additional readers include `packages/core/src/services/session-writer-lease.ts` (`isProcessAlive`) and `packages/qwen-live/src/host/discovery.ts` (`processIsAlive`). Any future PID-namespace change must account for every producer and reader of shared ownership records, including readers added after this inventory.

These ownership records can be shared across the confinement boundary through the writable Qwen state directories.

Inside a private PID namespace the confined CLI's own PID is namespace-local
(1, 2, 3…). Writing that number into shared state is not merely useless, it is
**actively wrong**: host PID 2 is `kthreadd`, root-owned, so a host-side
`kill(2, 0)` returns `EPERM`, which every predicate above reads as _alive_. The
result is an owner that never appears dead, so handoff and reclaim never fire —
a silent hang rather than a visible failure. Isolation is not worth trading a
correctness invariant the daemon depends on, and the filesystem boundary is what
this design is actually for.

**Cost accepted.** The confined process can see and signal host processes, and
procfs magic links (`/proc/<pid>/root/…`) remain a way to name a host path.
That path is not read-only: the kernel reopens it against the _target_ task's
root mount, so for a same-uid host process it reaches the host's writable root,
subject to `ptrace_may_access` READ checks rather than this namespace's
read-only bind. Yama's ATTACH restrictions do not establish protection for
these links (see § Security considerations). On the Landlock
backend the ruleset governs the reopened path too.

**Precondition for ever adding it.** The owner record must first carry a
namespace identity and readers must treat "recorded in a different PID
namespace" as _unknown_, never as alive — the fail-closed direction for an
arbitration predicate. `worktreeSessionService`'s hostname guard is the shape to
follow (`/proc/self/ns/pid`'s inode is the standard handle). Until that exists,
a PID-namespace switch would be a footgun with no caller, so this design ships
no switch at all.

### D7 — Selection order and rollout

**Decision.** Named commands are always explicit: `QWEN_SANDBOX=bwrap` /
`landlock` / `docker` / `podman` / `sandbox-exec`. For
`--sandbox`/`QWEN_SANDBOX=true` (unnamed), candidate order is unchanged in
P0–P2 (Linux: `docker`, `podman` only — no behavior change for existing
users). **P3** flips the unnamed Linux candidate order to
`bwrap` → `landlock` → `docker` → `podman`, and (behind its own PR +
compatibility data) makes Linux sandbox auto-detected the way
`sandbox-exec` already is on macOS (`sandboxConfig.ts` (`getSandboxCommand`)), with
`QWEN_SANDBOX=false` (the existing spelling — `0` / `false` / empty are what
`getSandboxCommand()` accepts at `sandboxConfig.ts` (`getSandboxCommand`); an invented value
like `off` would be parsed as a command name and rejected) as the escape hatch.

**Rationale.** Preferring the kernel backends under an explicit `true`
changes what `--sandbox` means for docker users; doing that silently in P0
would be a behavior break. The flip is cheap once the backends are proven.

## Phase P0 — `bwrap` backend (pure TypeScript)

### Config surface

- `packages/core/src/config/config.ts`: widen `SandboxConfig.command` with
  `'bwrap'` (`'landlock'` joins in P1 with its helper), and make
  `image?: string` optional — required by convention only for container
  commands, which `loadSandboxConfig` already enforces by returning no config
  when a container command has no image (unchanged behavior).
- `packages/cli/src/config/sandboxConfig.ts`:
  - `VALID_SANDBOX_COMMANDS` += `'bwrap'`.
  - Generalize `runSandboxProbe` to per-command probe argv:
    `docker`/`podman` → `['version']` (unchanged); `sandbox-exec` → skip
    (unchanged); `bwrap` → functional probe
    `['--ro-bind','/','/','--dev','/dev','--die-with-parent','--','true']`
    — the same namespace-affecting flags the profile uses, so a probe pass
    means the profile's namespace setup will succeed (D6: the profile carries
    no `--unshare-pid`/`--proc`). The probe deliberately omits `--bind` and
    `--chdir`, which depend on the resolved roots rather than on host
    capability.
  - Candidate list: unchanged in P0 (named-command path only).

### `start_sandbox` bwrap branch

New branch in `packages/cli/src/serve/sandbox.ts`, structurally mirroring
the seatbelt branch (`sandbox.ts` (`start_sandbox`, Seatbelt)):

1. **Writable roots** — the same set the Seatbelt permissive profile
   grants, each `realpathSync`'d (the kernel compares resolved paths; the
   seatbelt branch already canonicalizes for the same reason,
   `sandbox.ts` (`start_sandbox`, `TARGET_DIR`)):

   | Root            | Value                                                                                                                                                           |
   | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `TARGET_DIR`    | `realpathSync(process.cwd())`                                                                                                                                   |
   | `TMP_DIR`       | `realpathSync(os.tmpdir())` — bound writable; `/tmp` is never replaced by a fresh tmpfs (see below)                                                             |
   | `CACHE_DIR`     | `XDG_CACHE_HOME` or `~/.cache` when empty/unset (create leaf only, then realpath)                                                                               |
   | `QWEN_DIR`      | `Storage.getGlobalQwenDir()` (mkdir -p, realpath)                                                                                                               |
   | `RUNTIME_DIR`   | `Storage.getRuntimeBaseDir()` (mkdir -p, realpath)                                                                                                              |
   | git dirs        | `git rev-parse --git-dir` and `--git-common-dir`, when they resolve outside `TARGET_DIR`                                                                        |
   | npm cache       | `~/.npm` if it exists                                                                                                                                           |
   | `INCLUDE_DIR_n` | `workspaceContext.getDirectories()` minus `TARGET_DIR` (no 5-cap; argv has no profile-parameter limit; entries resolving inside the home directory are refused) |

   **Why the git roots.** In a worktree checkout `.git` is a file pointing
   elsewhere, so the index, `HEAD`, reflogs, and objects all live outside the
   workspace. Verified against this repository's own worktree layout:

   ```text
   toplevel (cwd):   /…/.qoder/worktree/qwen-code/o2qocx
   --git-dir:        /…/Projects/qwen-code/.git/worktrees/o2qocx
   --git-common-dir: /…/Projects/qwen-code/.git
   ```

   Without those roots every `git add` / `commit` / `stash` inside a worktree
   workspace fails `EROFS`, taking `enter_worktree`, Arena, and `/review` down
   with it — and worktrees are a first-class qwen-code workflow, not an edge
   case. Resolution runs once at hop time; a non-repo cwd yields nothing and
   contributes no roots. Note the asymmetry this repairs: none of the six
   Seatbelt profiles grants a git common dir either, so macOS has the same hole
   today. Fixing Seatbelt is out of scope (§ Non-goals), but the gap is now
   recorded.

   **Why `/tmp` is bound, not tmpfs.** A fresh `--tmpfs /tmp` would contradict
   the `TMP_DIR` row above and mask paths the host puts there:
   `/tmp/.X11-unix` (no GUI launch) and `/tmp/ssh-*/agent.*` (no ssh-agent auth
   for `git push`). Since `os.tmpdir()` is already a writable root and host
   `/tmp` is world-writable anyway, a private tmpfs buys little and costs two
   visible features, so it is not offered — not as a default and not as a
   switch.

   Paths the container branch mounts read-only — `~/.config/gcloud` and a
   `GOOGLE_APPLICATION_CREDENTIALS` file (`sandbox.ts` (`start_sandbox`, `GOOGLE_APPLICATION_CREDENTIALS`)) — need no
   counterpart here: `--ro-bind / /` already makes them readable, and they were
   never writable in the container either.

   The Seatbelt profile additionally grants `/dev/stdout`, `/dev/stderr`,
   `/dev/null`, `/dev/ptmx`, `/dev/ttys*` (`sandbox-macos-permissive-open.sb:23-27`);
   bwrap's `--dev /dev` covers that set (null/zero/full/random/urandom, tty,
   pts/ptmx, and the std\* symlinks). It also masks everything else under
   `/dev`, including `/dev/snd` — voice input is unavailable under confinement
   (§ Verified compatibility impacts).

   Roots that don't exist are skipped (bwrap fails on a missing bind
   source); roots already covered by an earlier root are dropped.

2. **argv template** (the shape dsh uses in
   `packages/sandbox/sandbox-local/src/profiles.ts`):

   ```text
   bwrap
     --ro-bind / /                     # recursive: /proc /sys /run come along read-only
     --dev /dev
     --die-with-parent
     [--unshare-net]                   # closed mode only
     --bind <root> <root>              # one pair per writable root
     --chdir <TARGET_DIR>
     -- <cliArgs...>                   # process.argv with the stdin /
                                       # session-id injections llm.tsx
                                       # already performs
   ```

3. **Child environment** — carried on the `spawn` env rather than through
   `bwrap --setenv`, so one code path serves both backends (the landlock helper
   execs with the launcher's environment unchanged) and nothing depends on a
   bwrap version that has a given flag:
   - `SANDBOX=bwrap` (or `qwen-landlock-run`) and `SANDBOX_ENFORCEMENT`.
   - `NODE_OPTIONS` merged exactly as the seatbelt branch does.
   - proxy variables in proxied mode.
   - **deleted**: `DISPLAY`, `WAYLAND_DISPLAY`, `MIR_SOCKET`.
     `shouldAttemptBrowserLaunch()` (`core/src/utils/browser.ts:52-60`) decides
     on Linux purely by the presence of those three. Left set, an OAuth login
     inside the sandbox would `xdg-open` a browser _as a confined child_, which
     then cannot write its own profile directory (`~/.config/<browser>` is not
     a writable root) and fails in a way that reads like an auth bug. Deleting
     them makes the existing print-the-URL path deterministic and the user
     opens the link in their normal host browser.

4. **Proxy** — proxied mode starts the host-side proxy the way the seatbelt
   branch does (`sandbox.ts` (`start_sandbox`, Seatbelt proxy): spawn it detached, install
   exit/SIGINT/SIGTERM handlers that kill the process group). The common bwrap runner waits up to 30 seconds for the configured proxy URL (default `http://localhost:8877`) to answer and injects `HTTP(S)_PROXY` **on the spawn env**.
   Both keys that drive this lifecycle — `QWEN_SANDBOX_PROXY_COMMAND` and
   `QWEN_SANDBOX_NET` — are confinement decisions and sit in
   `PROJECT_ENV_HARDCODED_EXCLUSIONS`: the proxy command runs through
   `bash -c` on the host, outside the confinement, before the agent starts,
   so it may only originate from the operator's launch environment or a
   home-scoped `.env`, never from repository content.

   The seatbelt block is deliberately _not_ shared as-is. It builds a
   `sandboxEnv` object, writes the proxy variables into it
   (`sandbox.ts` (`start_sandbox`, Seatbelt `sandboxEnv`)), and then never passes it to `spawn` — that call uses
   `{ ...process.env, ...childEnv }` (`start_sandbox`). On macOS the proxy variables
   are therefore computed and dropped, so `QWEN_SANDBOX_PROXY_COMMAND` starts a
   proxy the confined process is never told about. `noUnusedLocals` does not
   catch it because indexed assignment counts as a use.

   That is a pre-existing defect rather than something this phase introduces,
   and fixing it changes macOS behavior — out of scope here (§ Non-goals: no
   change to the Seatbelt path), recorded in § Open questions instead. The bwrap
   branch and the sandbox subcommand share `runBwrap` and `buildBwrapEnv`, passing the variables through the child env. Sharing this runner with Seatbelt remains a follow-up after its environment bug is fixed.

5. **Spawn contract** — `stdio: 'inherit'`, `process.stdin.pause()` before spawn / `resume()` on close, resolve with the child's exit code. The asynchronous runner uses POSIX `detached: true` to create a session without the host controlling terminal; synchronous verification probes pass bwrap `--new-session`. The asynchronous runner forwards SIGINT/SIGTERM to the sandbox process group, maps signal exits to 130/143, and relays SIGWINCH so terminal resizing still reaches the TUI. Cancellation during proxy readiness stops the proxy without launching a late payload. This session behavior is specific to bwrap; the Seatbelt path is unchanged.

### `llm.tsx` handoff

`llm.tsx` (`main`, sandbox handoff) branches on `sandboxConfig.command !== 'sandbox-exec'`
to decide the update-relaunch env handoff (container vs non-container).
Widen the non-container side: `bwrap`/`landlock` must take the
sandbox-exec branch (they are in-place hops, not images — no
`CUSTOM_SANDBOX_IMAGE_ENV_VAR`).

### UI

`packages/cli/src/ui/systemInfo.ts` needs **no change in P0**:
`getSandboxEnv()`'s final `return sandbox` (`:156`) already renders an unknown
`SANDBOX` value verbatim, so `bwrap` displays correctly as-is. The enforcement
suffix (`landlock (partial)`) lands with P1, which is the phase that can
actually produce a level other than `full` — shipping the suffix earlier would
mean an unreachable branch for a backend that does not exist yet. P0 still
surfaces the level where it is meaningful: `qwen sandbox` prints
`Enforcement: <level>` from `SANDBOX_ENFORCEMENT`.

### Model-visible boundary

`packages/core/src/core/prompts.ts` (`getCoreSystemPrompt`): add a branch for the in-place
kernel backend. Without it `SANDBOX=bwrap` lands in the generic branch, which
tells the model it runs "in a sandbox container" and teaches it to look for
`Operation not permitted` — the wrong shape for a bwrap denial. The new branch
states the backend, that the host root is read-only outside the writable roots,
the `Read-only file system` (`EROFS`) refusal, and the distinction that
`Permission denied` (`EACCES`) can be ordinary permissions inside a writable
root. Report a confinement refusal rather than detouring around it. Rationale in D2. The branch matches `bwrap` only; P1 adds
`qwen-landlock-run` to it together with the enforcement wording, for the same
reason the UI suffix waits.

The measured spelling matters. A denied `git add` in a worktree checkout reads
`fatal: Unable to create '…/index.lock': Read-only file system`, so the branch
must name `Read-only file system` in prose — naming only the `EROFS` symbol
would not match what the model actually sees.

### `qwen sandbox` self-check subcommand

New `packages/cli/src/commands/sandbox.ts` (+ test), registered beside the
existing command modules. Pulled into P0 rather than deferred: every impact in
§ Verified compatibility impacts is invisible until something fails mid-task, so
the backend and the way to prove it works have to ship together — this is also
what the proposed CI lanes and E2E table below call. The Linux bwrap CI lane is not implemented in this PR.

Use `QWEN_SANDBOX=bwrap qwen sandbox` from the project directory on the host to inspect this backend explicitly. A one-shot environment assignment on the original session does not persist in the host shell. The report uses that directory's settings; session-only `--include-directories` grants can differ.

- `qwen sandbox` — print resolved backend, probe result, enforcement level,
  writable roots (including the resolved git dirs), and network mode.
- `qwen sandbox <cmd>…` — run one command through the resolved backend and
  report the outcome (the `codex sandbox` equivalent).
- `qwen sandbox --verify` — the behavior battery: write outside the workspace
  must fail; write inside must succeed; the payload must report the same `/proc/self/ns/pid` identity as the host (the regression guard for D6); unreadable identities fail verification;
  network checks inspect interface visibility: `closed` must expose only `lo`, while `open`/`proxied` must expose a non-loopback interface. They do not test Internet reachability, proxy availability, or exclusive proxy routing; those require separate integration checks.

### Review follow-up contract

- Reject a canonical writable root equal to the home directory or any ancestor, including `/`, before spawning bwrap. The rule also applies through symlinks and to additional workspace directories, which get a stricter floor: any entry resolving inside the home directory is refused, because workspace-scope settings (`context.includeDirectories`) are repository content and must not pick home-internal roots such as `~/.ssh` or a sibling checkout carrying a `.git`. Entries already covered by a built-in root (the workspace itself, the cache/runtime dirs) stay admitted. Use a narrower workspace or cache path instead of silently granting the whole home or host filesystem.
- Derive Git roots with the shared `gitEnv()` sanitizer so ambient repository selectors cannot redirect the probe. Only a real `.git` directory or a linked worktree registered under the common repository with a matching reverse pointer receives automatic Git grants. Symlinked metadata, planted gitfiles, separate Git directories, and submodule gitfiles without that registration contribute no roots; users must explicitly include any required external metadata directory. Legitimate linked worktrees retain their entire common Git directory grant. A repository rooted at HOME also retains its `.git` grant when a child directory is the workspace. These layouts have explicit tests; the inspection report and model prompt disclose that granted config and hooks can affect later unconfined Git commands. This is a retained permission policy, not a narrower metadata allowlist.
- Inspection forwards the explicit sandbox and image flags, skips settings and `.env` loading in bare mode, and suppresses settings in safe mode. Plain inspection may exit successfully without a backend; a verification or command request that cannot run exits non-zero, including when already confined. Commands with their own flags must follow `--`; unknown flags before it fail parsing.
- Pass-through commands inherit stdin, stdout, and stderr directly. Inspection text goes to stderr for this mode, so large output and piped structured output are preserved. The verification battery retains captured output for its predicates.
- Actual command execution and the normal bwrap hop share the launcher and child environment: runtime markers are set, display variables are removed, and proxied mode starts the configured proxy, normalizes proxy variables, waits for readiness, and stops the proxy on completion or failure. Proxy startup/readiness failure prevents payload launch; proxy exit after launch terminates the payload and fails the request. Plain inspection starts neither process; captured verification uses the same environment policy plus `LC_ALL=C`, and its interface check does not start or validate the proxy.
- The bwrap re-exec appends Node launch options to the inherited options, preserves child-environment precedence, and restores Electron's Node mode when the managed launch marker requests it.
- `full` describes filesystem mount enforcement, not isolation from host services. The inspection report and prompt state that host Unix sockets remain reachable, including in closed network mode, and that proxied mode does not enforce exclusive proxy use. Writable Git configuration/hooks and Qwen settings can affect later unconfined launches; this residual capability is retained with the existing grants. Narrowing repository metadata remains a separate decision; bwrap no longer grants global `~/.gitconfig` writes by default.
- Regression acceptance: broad roots and symlinks are refused; ambient Git selectors and planted gitfiles cannot grant an unrelated repository; failed-to-run requests are non-zero; command flags are preserved or rejected; pass-through output is not captured; inherited Node options and managed Electron mode reach the child. Linux mount enforcement and the procfs edge case require a Linux host and are not claimed from mocked spawn tests.

## Phase P1 — `qwen-landlock-run` vendored fallback

### The helper (new source, ~300 lines C11)

`packages/core/vendor/landlock-run/src/qwen-landlock-run.c`. The design
follows dsh's `native/system/packages/entry/src/main.c` (BSD-3-Clause;
re-implemented, not copied):

- CLI contract (pinned in the file header and unit-tested from TS):

  ```
  qwen-landlock-run [--ro <path>]... [--rw <path>]... -- <argv>...
  qwen-landlock-run --probe
  ```

  `--ro` grants read+execute beneath the path; `--rw` grants every
  filesystem access the negotiated kernel ABI governs. Everything else is
  denied (Landlock rulesets are allow-lists).

- **Fail-closed**: `no_new_privs` → `landlock_create_ruleset` (ABI
  negotiation from max known down) → `add_rule` per grant →
  `landlock_restrict_self` → `execvp`. Any failure exits **125** with a
  `qwen-landlock-run: ` stderr prefix, without exec'ing. An unopenable
  grant root is a launch failure, never a silently narrowed profile.
- **Functional probe**: `--probe` installs a maximal ruleset on itself and
  prints exactly one line — `landlock: fully enforced` or
  `landlock: partially enforced (older ABI)` — exit 0; exit 125 when the
  kernel cannot enforce (ENOSYS/EOPNOTSUPP). A `--version`-style check
  would miss kernels that have the syscalls but refuse enforcement.
- **Partial enforcement**: on an older ABI, prints
  `qwen-landlock-run: partial enforcement (older Landlock ABI)` to stderr
  and proceeds — still confined for everything the kernel governs.
- UAPI structs/constants defined locally (kernel userspace ABI is stable;
  keeps the build independent of toolchain header vintage, and the
  definitions double as the audit record).

### Build & distribution

- `scripts/build_landlock_run.mjs` builds one arch at a time:

  ```sh
  musl-gcc -static -O2 \
    -o packages/core/vendor/landlock-run/<arch>-linux/qwen-landlock-run \
    packages/core/vendor/landlock-run/src/qwen-landlock-run.c
  ```

  The toolchain is documented alongside it (`apt install musl-tools` on Linux,
  `brew install musl-cross` on macOS).

- CI (`verify-landlock-run.yml`, ubuntu x64 + arm64 runners): rebuild from
  source, `sha256sum` compare against the committed binaries, run the
  functional probe, and run the behavior battery (deny write outside
  `--rw`, allow inside, `--probe` exit codes on a Landlock-capable kernel).
- `packages/core/package.json` `files` already includes `vendor/` — no
  publish change needed.

### TS integration

- Registration: `SandboxConfig.command` gains `'landlock'`;
  `VALID_SANDBOX_COMMANDS` += `'landlock'`; `runSandboxProbe` gains the
  `landlock` → `[launcherPath(), '--probe']` arm (a missing helper or a
  non-enforcing kernel is a probe failure, so a named `landlock` request
  fails closed with the existing `FatalSandboxError` wording).
- `packages/cli/src/utils/landlockRun.ts` (new):
  `launcherPath()` (arch resolution via `resolveBundleDir`, mirroring
  `getBuiltinRipgrep`'s traversal rules in
  `packages/core/src/utils/ripgrepUtils.ts:97-111`),
  `probe(): Promise<'full' | 'partial' | 'unusable'>`, and
  `grantArgs(roots: {ro: string[]; rw: string[]}): string[]`.
- `start_sandbox` `landlock` branch: argv =
  `[launcherPath(), ...grantArgs({ro: ['/'], rw: writableRoots}), '--', ...cliArgs]`
  with `--setenv`-free env inheritance (helper execs with launcher's
  environment unchanged; set `SANDBOX=qwen-landlock-run` and
  `SANDBOX_ENFORCEMENT` in `process.env` for the child before spawn, same
  as the seatbelt branch's env merge).
- Enforcement plumbing: probe result is threaded into the child env so
  `systemInfo.ts` can render `landlock (partial, kernel ABI 3)`.

## Phase P2 — seccomp tightening in the helper

**seccomp in the helper** (+~80 lines C): after `no_new_privs`, install a
minimal BPF filter denying `ptrace`, `process_vm_readv`, `process_vm_writev`,
`mount`, `umount2`, `init_module`,
`finit_module`, `delete_module`, `kexec_load`, `kexec_file_load`, `bpf`,
`perf_event_open`, `keyctl`, `iopl`, `ioperm`. This is the Claude Code
`apply-seccomp` pattern folded into the same helper; it applies to the landlock
path only. bwrap has no seccomp hook of its own beyond `--seccomp <fd>`, which
would mean shipping a compiled BPF program to feed it — out of scope here.

Because the helper gains a denial it did not have before, this phase is a
behavior tightening on an existing named backend, not a pure addition: it needs
a release-notes callout and a `--verify` case per denied syscall class.

## Phase P3 — default flip (own PR, behind compatibility data)

1. Unnamed `--sandbox`/`QWEN_SANDBOX=true` on Linux: candidate order
   becomes `bwrap` → `landlock` → `docker` → `podman`.
2. Auto-detected sandbox on Linux (mirror of the macOS `sandbox-exec`
   auto-candidate at `sandboxConfig.ts` (`getSandboxCommand`)), gated behind a review of
   § Verified compatibility impacts with field data behind it — not just the
   mechanism list, but how often real workflows hit each row.
   `QWEN_SANDBOX=false` is the documented escape hatch.
3. CI: retain the `test:integration:sandbox:bwrap` follow-up lane and add
   `test:integration:sandbox:landlock`; keep `sandbox:none` lanes
   (the unconfined path remains supported), but it stops being the only
   exercised Linux configuration.

## Verified compatibility impacts

Each row is a mechanism verified against this repository, not a guess, and
applies to the two in-place backends only — container backends and macOS are
unchanged. This is the table the P3 default flip must answer to; until then
these are documented consequences of an opt-in flag.

| Area                                                                                       | Impact                        | Mechanism                                                                                                                                                                                                                                                                                                    | Handling in v1                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| git in a worktree checkout                                                                 | would break entirely          | git dir and common dir resolve outside cwd (verified layout in § Phase P0)                                                                                                                                                                                                                                   | **fixed** — both are writable roots                                                                                                              |
| Cross-process owner liveness                                                               | would hang silently           | `process.kill(pid, 0)` with non-`ESRCH` ⇒ alive, over PIDs shared through `~/.qwen` (`conversation-runtime-ownership.ts:44-65`, `serve/live/discovery.ts:147`, `worktreeSessionService.ts:424-446`)                                                                                                          | **avoided** — no PID namespace at all (D6)                                                                                                       |
| GUI launch (OAuth login, `artifact` open)                                                  | browser cannot run confined   | `xdg-open` child inherits confinement and `~/.config/<browser>` is not a writable root                                                                                                                                                                                                                       | display vars deleted ⇒ deterministic print-the-URL path                                                                                          |
| ssh-agent auth for `git push`                                                              | unaffected                    | the agent socket usually lives under `/run/user/$UID` (kept reachable by the read-only host bind); a `/tmp/ssh-*` socket also keeps working because host `/tmp` stays bound rather than replaced by a tmpfs — see § Security considerations for what sharing `/tmp` exposes                                  | —                                                                                                                                                |
| Voice input                                                                                | unavailable                   | `--dev /dev` masks `/dev/snd`; `voice-availability.ts:50` also needs `PULSE_SERVER`                                                                                                                                                                                                                          | documented — use a container backend or run unconfined                                                                                           |
| Self-update                                                                                | partly affected               | the default managed update root is `QWEN_DIR/updates/npm` (Qwen home follows `QWEN_HOME`); staging, versions, and the active manifest must be writable, and the host launcher later executes that code; custom pinned update roots may lie outside the grants and npm-global updates write the global prefix | retain the default managed update grant and its host-execution risk; update from the host when the installation target is outside writable roots |
| IDE companion, host `qwen serve`, localhost MCP                                            | unreachable in `closed` only  | `--unshare-net` removes loopback (D5)                                                                                                                                                                                                                                                                        | `open` / `proxied` keep them working                                                                                                             |
| Writes to `~/.config`, `~/.kube`, `~/.ssh`, `/usr/local`                                   | denied                        | not writable roots — this is the point of the sandbox                                                                                                                                                                                                                                                        | extra home-internal roots are refused; non-home paths can be granted with `--include-directories`                                                |
| Session data, checkpoints, worktrees, Arena, IDE lock file, MCP OAuth tokens, token ledger | unaffected                    | all under `QWEN_DIR` / `RUNTIME_DIR` (`storage.ts:193-241`, `gitWorktreeService.ts:419`, `ArenaManager.ts:136`)                                                                                                                                                                                              | —                                                                                                                                                |
| `docker.sock`, D-Bus, Wayland and other host unix sockets                                  | reachable on bwrap (measured) | the kernel's read-only-fs write check exempts `S_ISSOCK` (only `S_ISREG`/`S_ISDIR`/`S_ISLNK` yield `EROFS`), so a socket under `--ro-bind / /` still accepts `connect()`                                                                                                                                     | **verified** on bwrap — a socket outside every writable root still accepted `connect()`; the Landlock backend stays a P1 `--verify` case         |
| procfs magic links (`/proc/<pid>/root/…`)                                                  | outside the mount policy      | access uses `PTRACE_MODE_READ_FSCREDS`, not Yama's ATTACH relationship restriction                                                                                                                                                                                                                           | **retained limitation** — do not infer protection from `ptrace_scope=1`; stronger isolation needs the D6 prerequisite                            |

The extra-directory restriction applies equally to CLI and settings entries because the resolver receives merged paths without source provenance. Home-internal entries outside the built-in grants stop startup instead of silently downgrading a requested writable directory. Non-home extra roots remain writable even when declared by workspace settings; P0 does not claim operator-only grants. Separating explicit operator grants from repository settings remains a separate configuration-policy change.

## Security considerations

- **Canonicalization**: every writable root is `realpathSync`'d before
  entering the profile; bwrap/Landlock compare resolved paths. The
  seatbelt branch does the same for the same reason.
- **procfs magic links**: remain outside this mount policy because the
  profile shares the host PID namespace (D6). Links resolve against the
  target task's mount, and access is subject to credentials, dumpability,
  capabilities and LSM checks. Linux 7.0 checks procfs links with
  `PTRACE_MODE_READ_FSCREDS`; Yama's relationship restrictions apply to
  `PTRACE_MODE_ATTACH`. Therefore `kernel.yama.ptrace_scope=1` does not
  establish that these links are blocked. See the [procfs access check](https://github.com/torvalds/linux/blob/v7.0/fs/proc/base.c#L708)
  and [Yama access check](https://github.com/torvalds/linux/blob/v7.0/security/yama/yama_lsm.c#L349).
  Following a link does not call `ptrace(2)`, so denying that syscall alone
  does not close this path. Process-memory APIs use different access modes
  and must be assessed separately. P0 does not claim isolation from host
  processes; stronger isolation remains follow-up work with the D6 owner
  record prerequisite. These source checks are not a dynamic verification
  of every supported host.
- **Read-only-fs semantics are narrower than they look**: the kernel returns
  `EROFS` for write access only to `S_ISREG` / `S_ISDIR` / `S_ISLNK`. Sockets,
  FIFOs, and device nodes under `--ro-bind / /` are exempt, so host unix
  sockets remain connectable — measured, not assumed (§ Evidence). That is
  deliberate here (it is what keeps `docker.sock`, D-Bus, and Wayland usable)
  but it means "read-only root" must not be read as "no IPC out of the
  sandbox": anything reachable over a host socket is outside this boundary by
  construction. Concretely in `closed` mode: a raw TCP connect fails with
  `ENETUNREACH`, but DNS still resolves through the host's `systemd-resolved`
  pathname socket — not a network-namespace object, so `--unshare-net` does
  not cut it (measured on the PR's independent verification host, Debian 13).
  A DNS-shaped side channel therefore remains in closed mode.
- **setuid escalation**: `no_new_privs` is set before restricting (also
  mandatory for unprivileged Landlock).
- **Terminal session**: both bwrap launch sites create a separate POSIX session, while retaining standard I/O. This removes ownership of the host controlling terminal, addressing the terminal-session concern described in the [bubblewrap security documentation](https://github.com/containers/bubblewrap#sandbox-security). The asynchronous launcher uses `detached: true`, so bwrap and its payload stay in the same process group for signal forwarding. Synchronous probes use bwrap `--new-session`; they do not use the asynchronous signal relay. This does not add PID or host-process isolation.
- **Orphans**: `--die-with-parent` on bwrap; Landlock rulesets are
  process-scoped and vanish with the process.
- **Symlink swap between resolve and exec**: narrowed by resolving
  immediately before spawn; the residual race is the same class the
  seatbelt path already accepts (documented in `sandbox.ts`).
- **Env**: the bwrap/landlock hop inherits the full environment (parity
  with the seatbelt branch). Credential stripping stays with the existing
  `sanitize-child-env` consumers; this design does not change that
  boundary.
- **Env-sourced confinement inputs**: the writable-root derivation reads
  `XDG_CACHE_HOME` and (via `os.tmpdir()`) `TMPDIR`/`TMP`/`TEMP`, and the
  network mode and proxied lifecycle read `QWEN_SANDBOX_NET` /
  `QWEN_SANDBOX_PROXY_COMMAND`. All of them sit in
  `PROJECT_ENV_HARDCODED_EXCLUSIONS`, so a project `.env` or settings.env
  cannot pick the confinement roots or the host-side proxy command; only the
  operator's launch environment or a home-scoped `.env` can. Proxied mode
  executes that command through `bash -c` on the host, outside the
  confinement, before the agent starts.
- **Non-directory grants (P1 helper)**: a file grant keeps only
  file-compatible access bits (the kernel rejects directory-only accesses
  on non-directories with EINVAL — the helper masks accordingly).
- **Writable Git metadata is later executed on the host**: the git dir /
  common-dir grant lets a confined
  process rewrite `hooks/` and `config` — `core.fsmonitor`, `core.hooksPath`,
  `core.pager`, aliases, hook scripts — which a later _unconfined_ `git`
  invocation runs as the user. The grant is retained because worktree
  commits need `objects/`/`refs/`/`logs/` writable; narrowing it to exclude
  hooks/config remains follow-up work (§ Review follow-up contract). The
  bwrap defaults do not grant writes to `~/.gitconfig`: the read-only host
  root already provides read access. Seatbelt profiles are unchanged.
- **Host `/tmp` is a shared read-write grant**: `os.tmpdir()` stays bound
  rather than replaced by a tmpfs, so same-user socket and lock paths under
  it (`/tmp/.X11-unix`, `/tmp/ssh-*/agent.*`) can be unlinked and replaced
  from inside — a confined process could answer a later unconfined
  `git push`'s signature requests, or intercept the host GUI's display
  socket. Retained deliberately: a private tmpfs would break GUI launches
  and ssh-agent auth (§ P0 writable roots). Operators who do not need those
  can point `TMPDIR` at a per-session directory before launching.
- **The QWEN_DIR `.env` is pinned read-only inside the confinement**:
  QWEN_DIR is a writable root (sessions, checkpoints, worktrees, lock
  files), but its `.env` is operator-trusted execution input that every
  later launch re-reads — including `QWEN_SANDBOX_PROXY_COMMAND`, which
  proxied mode executes through `bash -c` on the host. A read-only bind
  layered over the writable root keeps a confined process from rewriting
  what the host next trusts through that path. If absent, root resolution
  creates an empty file exclusively with mode 0600 before binding it;
  existing contents are never overwritten. The empty file remains on the
  host, including after inspection, so later resolutions use the same path.
  Non-regular files, symbolic links, multiple hard links, and failures to
  prepare the file stop the operation rather than omit the protection.
- **Other Qwen state remains writable and trusted by later host runs**: the `.env` override protects only that environment-input path. User `settings.json` (including MCP and hook configuration), custom commands, memory, and managed update files remain writable. Settings changes can affect later unconfined launches, and the managed launcher executes code selected from its update root. These are retained capabilities for persistent configuration and managed updates, not a claim that all future host execution inputs are protected. Narrowing them requires a separate write-policy and update-handoff design.
- **Runtime markers are launcher-owned**: `SANDBOX` and
  `SANDBOX_ENFORCEMENT` are rejected from project and home `.env` files and
  from settings.env, including reloads and runtime snapshots. Existing
  launcher values remain inherited; backend selection through the separate
  `QWEN_SANDBOX` operator setting is unchanged.
- **Launcher/command failure attribution**: launcher failures exit 125
  with a `qwen-landlock-run: ` prefix; a successfully exec'd child may
  also exit 125, so consumers require status 125 **and** the prefix —
  same rule dsh's CLI contract pins.

## Test plan

The delivered P0 unit coverage and planned integration work are listed separately. P1 and later phases remain plans for separate PRs.

**P0 — delivered unit tests (vitest)**

- `packages/cli/src/config/sandboxConfig.test.ts`: explicit bwrap selection without an image, functional-probe argv and timeout, probe failure and caching, invalid names, and the Seatbelt no-image path.
- `packages/cli/src/serve/sandbox-bwrap.test.ts`: bind source/destination and ordering, canonical root deduplication and refusal, Git provenance and containment, registered-worktree reverse pointers, HOME-rooted dotfiles repositories, absence of `--unshare-all` / `--unshare-pid` / `--proc` / `--tmpfs`, network-mode flags, and normal-hop child environment and proxy cleanup. Git fixtures isolate both ambient repository selectors and user/system Git configuration; filesystem fixtures keep HOME, temporary storage, and workspace separate.
- `packages/core/src/core/prompts.test.ts`: bwrap wording includes `EROFS`, retained Git metadata capability, and host-service limits; other backends retain their expected text.
- `packages/cli/src/commands/sandbox.test.ts`: inspection output, final positional plus `--` command ordering, execution failure, and failed verification predicates including missing loopback.
- `packages/cli/src/commands/sandbox-command-runtime.test.ts`: real handler/runner with mocked processes verifies markers, display removal, inherited stdio/argv/exit status, proxy normalization/startup/readiness/failure/cleanup, and diagnostic-only inspection. These tests do not establish Linux mount enforcement.

**P0 — integration follow-up**

PR #11614 deferred the real Linux lane. The [bwrap integration follow-up](2026-09-16-bwrap-integration-ci.md) adds `test:integration:sandbox:bwrap` and a dedicated Ubuntu workflow installing `bubblewrap`. It exercises the built CLI, filesystem and network boundaries, linked-worktree commits, a fake-model tool round trip, process cleanup, and cross-boundary writer-lease recovery. The suite uses real bwrap and fails when its prerequisites are unavailable. Writer-lease coverage is service-level integration, not a full ACP/daemon handoff test. The dated observations in § Evidence remain historical; hosted CI results and local Linux runs must be reported separately.

**P1 — unit**

- `landlockRun.test.ts`: probe line → `full` / `partial` / `unusable` mapping;
  `grantArgs` shape; arch resolution (mocked platform/arch, the pattern in
  `ripgrepUtils.test.ts`).
- `sandbox.test.ts`: landlock argv = launcher + grants + `--` + cliArgs.
- `systemInfo.test.ts`: `landlock (partial, …)` rendering, plus the no-suffix
  case guarding the verbatim fallthrough at `:156`.
- `prompts.test.ts`: `SANDBOX=qwen-landlock-run` selects the kernel-sandbox
  branch and the `partial` wording appears only when the level says so.

**P1 — build gate and integration**

- `verify-landlock-run.yml`: rebuild from source → sha256 compare against the
  committed binaries → functional probe → behavior battery, on both arches.
- `test:integration:sandbox:landlock` lane.

**P2**

- One `--verify` case per denied syscall class, plus a battery case proving the
  helper still execs successfully for allowed syscalls (a seccomp filter that
  denies everything would otherwise pass the deny cases).

**P3**

- `sandboxConfig.test.ts`: unnamed `--sandbox` / `QWEN_SANDBOX=true` on Linux
  resolves in the new candidate order; `QWEN_SANDBOX=false` still disables
  everything; auto-detection does not fire on non-Linux.

**E2E (manual, per release until P3)**

| Check                                              | Expected                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `QWEN_SANDBOX=bwrap qwen` on a dockerless Linux VM | starts; status line shows `bwrap`                                    |
| inside a **worktree** checkout: `git commit`       | works (regression guard for the git roots)                           |
| a second CLI while a confined one holds a session  | owner handoff still fires (regression guard for D6)                  |
| inside: `touch /usr/local/bin/x`                   | EROFS                                                                |
| inside: `touch ./x && rm ./x` (workspace)          | works                                                                |
| inside: `ls /proc`                                 | host processes visible (no PID namespace — D6)                       |
| `QWEN_SANDBOX_NET=closed`: model API call          | fails fast with a clear proxy hint                                   |
| proxied: API call via `QWEN_SANDBOX_PROXY_COMMAND` | works                                                                |
| machine with `kernel.unprivileged_userns_clone=0`  | named `bwrap` ⇒ "installed but cannot run"; named `landlock` ⇒ works |
| kernel < 5.13 (no Landlock)                        | `landlock` probe ⇒ unusable; explicit request ⇒ `FatalSandboxError`  |
| Ctrl-C / CLI crash                                 | no orphaned confined processes                                       |
| `qwen sandbox --verify`                            | battery passes                                                       |

## Rollout & compatibility

- P0: no default behavior change on any platform; `bwrap` available by name.
  Additions only — `VALID_SANDBOX_COMMANDS`, one `start_sandbox` branch, the
  type widening, the handoff branch widening, the prompt branch, and the
  `qwen sandbox` subcommand.
- P1: adds vendored binaries (~70 KB × 2 arches) and the `landlock`
  named command; no default behavior change.
- P2: tightens the landlock backend with seccomp — the one phase before P3 that
  changes behavior for an already-shipped named backend; release-notes callout.
- P3: the only phase that changes what happens by default; own PR, own design
  review, own release-notes callout.

**Process note.** `packages/cli/src/config/sandboxConfig.ts` and
`packages/core/src/config/config.ts` both match `packages/*/src/config/**`, so
every phase touches core infrastructure under the AGENTS.md two-tier gate. None
of the phases is a large-scope `refactor`, so none is hard-blocked, but an
externally authored PR here escalates to a maintainer by rule rather than by
judgement. Splitting the work as P0–P3 also keeps each PR inside the
CONTRIBUTING.md size thresholds.

## Open questions

1. **WSL2**: Landlock ABI availability varies by WSL2 kernel vintage;
   probe handles it correctly, but the P3 auto-default needs WSL2 in the
   compatibility matrix.
2. **Snap/Flatpak-confined hosts**: userns may be restricted even for
   root; the landlock fallback covers most such cases, but a
   "neither works" host needs its error message to name both failures.
3. **Restrictive write-set profile**: the macOS matrix has
   `restrictive-*` profiles (97-line `.sb` files); whether Linux needs an
   equivalent narrower root set in v1 or can defer to the profile
   unification work is a P3 scoping question.
4. **Per-command confinement**: Codex-grade per-call policies (read-only
   for auto-approved commands, workspace-write after approval) require
   the tool-scheduler surgery described in D2. Worth its own design once
   P0–P3 usage data exists.
5. **Landlock and socket files**: on the bwrap backend a host unix socket under
   the read-only root is reachable (measured, § Evidence). Whether a Landlock
   ruleset that grants no access to a socket's directory blocks `connect()` is
   still open, and it decides whether the two backends have the same IPC
   surface — a P1 `--verify` case rather than an assumption.
6. **The Seatbelt git-dir gap**: the six macOS profiles grant no git common dir
   either, so `git commit` in a worktree checkout should already fail under
   `--sandbox sandbox-exec` today. If that reproduces, it is a standalone bug
   fix (a profile parameter, not a design change) and should not be bundled into
   this work.
7. **The Seatbelt proxy-env drop**: `sandbox.ts` (`start_sandbox`, Seatbelt `sandboxEnv`) fills a `sandboxEnv`
   object with the proxy variables that `start_sandbox` never passes to `spawn`, so
   `QWEN_SANDBOX_PROXY_COMMAND` on macOS starts a proxy the confined process
   cannot see. Also a standalone fix — it changes macOS behavior and wants its
   own regression test, so it is deliberately not bundled here.
8. **Optional cache creation under `/proc`**: the verification VM reported a hang with recursive Node directory creation at `/proc/nope/cache`. The cache path now uses a single non-recursive `mkdir`: an absent parent is not created and the optional root is dropped. The normal missing `~/.cache` leaf is still created. This follow-up was checked with ordinary missing-parent and first-run cases on macOS; the Linux procfs case still requires a real Linux verification. Required Qwen and runtime directory creation is unchanged.

## Evidence

- Live verification on Linux, 2026-09-10 — Lima VM, kernel `7.0.0-28-generic`,
  bubblewrap 0.11.1, git 2.53.0, `unprivileged_userns_clone=1`, Landlock present
  in `/sys/kernel/security/lsm`. The probe script lived at
  `.qwen/scripts/verify-bwrap-assumptions.sh`, which `.gitignore` excludes by
  repository convention, so it is not part of this change — the measurements it
  produced are recorded below instead, and `qwen sandbox --verify` is the
  committed four-check subset, not a replacement for the manual Git and socket checks. The original probe
  exercised ten claims from this document: nine passed and one failed (the
  `--proc` claim in D6, corrected in place above). Confirmed by measurement:
  the documented probe argv launches; a write outside the roots returns
  `EROFS`; a `--bind` root is writable; host PIDs stay visible without
  `--unshare-pid` (133 numeric `/proc` entries); a host unix socket outside
  every writable root still accepts `connect()`; `git add` in a worktree
  checkout fails with `Unable to create '…/index.lock': Read-only file system`
  when only the worktree is bound and succeeds once the git dir and common dir
  are bound; `/dev/snd` is masked inside while present on the host;
  `--unshare-net` blocks outbound resolution.
- This repo: Phase 0 records the pre-implementation inspection from 2026-09-09. Changed-code references now use current file/symbol locations; remaining line references below identify that historical inspection, not a fresh verification of the current branch. The impact sweep behind D2, D5, D6 and § Verified compatibility
  impacts was added 2026-09-10 and covers
  `cli/src/serve/conversations/conversation-runtime-ownership.ts:44-65`,
  `cli/src/serve/live/discovery.ts:147`, `core/src/core/prompts.ts` (`getCoreSystemPrompt`),
  `core/src/utils/browser.ts:25-70`, `core/src/utils/secure-browser-launcher.ts:151-181`,
  `core/src/ide/ide-client.ts:644-678`, `core/src/config/storage.ts:160-241`,
  `core/src/services/gitWorktreeService.ts:419`,
  `core/src/agents/arena/ArenaManager.ts:128-140`,
  `cli/src/ui/voice/voice-availability.ts:50`, and the worktree `git rev-parse`
  layout of this checkout.
- Codex CLI (local clone, highest tag `rust-v0.153.4`):
  `codex-rs/linux-sandbox/src/{bwrap,landlock}.rs`,
  `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl` (`(deny default)`),
  `codex-rs/Cargo.toml` (`seccompiler = "0.5.0"`, `landlock = "0.4.4"`),
  `codex-rs/vendor/bubblewrap/`,
  `codex-rs/protocol/src/protocol.rs:983-1023` (`SandboxPolicy`),
  `codex-rs/cli/src/main.rs:145` (`codex sandbox` subcommand).
- dsh (`deepseek-ai/deepseek-harness`, MIT; `native/system` BSD-3-Clause):
  `native/system/packages/entry/src/main.c` (299 lines),
  `native/system/docs/cli-contract.md`,
  `packages/sandbox/sandbox-local/src/profiles.ts` (bwrap argv form),
  `packages/sandbox/sandbox/src/index.ts` (the `SandboxEnforcement` union plus
  `denialSignatures` and `runnerFailureRules`),
  `.agents/notes/implemented/feature/2026-07-06-sandbox.md`
  (alternatives considered).
- Claude Code 2.1.266 (binary + CLI evidence): bwrap + `apply-seccomp`
  from `@anthropic-ai/sandbox-runtime`; `CLAUDE_CODE_FORCE_SANDBOX`.
