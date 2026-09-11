# Web Shell Manage Remotes

[English](git-manage-remotes.md) | [简体中文](git-manage-remotes.zh-CN.md)

## Problem statement

The Web Shell workspace git popover (`BranchPickerPopover`, opened from the
left-sidebar workspace git pill or the composer branch chip) can pull, commit,
push, create/checkout branches, and lists remote-tracking branches grouped by
remote name — but there is no way to manage the remotes themselves. A user who
clones-from-zip (no `origin`), works triangular (fork + upstream), or wants to
drop a stale remote must leave the Web Shell and use a terminal.

There is no daemon route, SDK method, or core CRUD helper for git remotes
today (grep-verified 2026-09-06). `git remote` otherwise appears in the
shell read-only classifier, a worktree-service error message, push-remote
resolution inside `gitPush`, and two read-only `git remote -v` parsers under
`packages/cli/src/commands/review/` (`lib/remote-match.ts`,
`match-remote.ts`) plus simple-git's `getRemotes` in
`packages/core/src/extension/github.ts` — precedent that the rendered
`git remote -v` surface is unstable (remote-match already carries a
regression test for the partial-clone `[filter]` annotation), which is one
more reason the new reader below reads the repository's config scope
directly rather than any rendered or per-name accessor output.

Scope (confirmed with the maintainer): **list + add + remove**, surfaced as a
panel **inside the BranchPicker popover**. No set-url, rename, or fetch/prune.

## Current state

| Layer         | What exists                                                                                                                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| daemon routes | `packages/cli/src/serve/routes/workspace-git-branches.ts` registers `GET …/git/branches`, `POST …/git/{checkout,branch,push,pull,commit}` in both legacy (`/workspace/…`) and scoped (`/workspaces/:workspace/…`) forms; mounted in `packages/cli/src/serve/server.ts` ~L2403-2413 |
| core          | `packages/core/src/utils/git-branches.ts`: private `runGit(cwd, args, env)` (execFile, 30 s, 10 MB, `gitEnv`), exported `gitEnv`, `fetchGitBranches`, `gitPush`, …; re-exported from `packages/core/src/index.ts` (`export * from './utils/git-branches.js'`)                      |
| SDK           | `WorkspaceDaemonClient` in `packages/sdk-typescript/src/daemon/DaemonClient.ts` (~L6600-6770 git block) calls `client.workspaceJsonRequest(selector, suffix, label, opts)`; types in `packages/sdk-typescript/src/daemon/types.ts`, re-exported in `daemon/index.ts`               |
| UI            | `packages/web-shell/client/components/BranchPickerPopover.tsx` + `.module.css`; i18n keys `branchPicker.*` in `packages/web-shell/client/i18n.tsx` (en ~L34-80, zh ~L3523-3566)                                                                                                    |
| e2e mock      | `packages/web-shell/client/e2e/utils/mockDaemon.ts`: scenario fields (~L106-120), `isDaemonPath` regex (~L744-753), `isDaemonRoute` regex (~L887-905), response fixtures (~L1450-1593)                                                                                             |

Scoped-only precedent: `workspace-github-prs.ts` registers only
`/workspaces/:workspace/…` routes (no legacy form).

## Proposed changes

### 1. Core — new `packages/core/src/utils/git-remotes.ts`

```ts
export interface GitRemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  extraFetchUrls: number;
  extraPushUrls: number;
  promisor: boolean;
  partialCloneFilter?: string;
  customRefspec: boolean;
  otherSettings: number;
}

export function isValidRemoteName(name: string): boolean;
export function isValidRemoteUrl(url: string): boolean;
export function isRemovableRemoteName(name: string): boolean;
export async function fetchGitRemotes(cwd, env?): Promise<GitRemoteInfo[]>;
export async function gitRemoteAdd(
  cwd,
  name,
  url,
  env?,
): Promise<GitRemoteInfo[]>;
export async function gitRemoteRemove(
  cwd,
  name,
  env?,
): Promise<GitRemoteInfo[]>;
```

- `fetchGitRemotes` reads the repository's **own editable scope** with a
  single `git config --list --show-scope -z`, keeping only the `local` and
  `worktree` scope records. `git config --local` alone is narrower than
  that scope: an `include.path` entry in `.git/config` contributes keys git
  still labels `local`, and `extensions.worktreeConfig` remotes live in
  `config.worktree`, so a `--local`-only read under-lists, dead-ends
  `git remote add` (git's duplicate check sees the included name), and lets
  `git remote remove` report success over a split section whose included
  half survives. Inherited (`global`/`system`/`unknown`/`command`) remotes stay unlisted (git
  cannot remove those either, so claiming them would certify a removal
  that never happens). Reading config rather than `git remote` + `get-url`
  keeps the listing immune to `insteadOf` rewriting, complete for
  multi-valued `url`/`pushurl` (carried as `extraFetchUrls`/
  `extraPushUrls`), and free of the `git remote` + `get-url` accessor
  fan-out (two visits per remote); the listing itself is one git process,
  plus one extra `--type=bool` read per promisor-carrying section (such
  sections appear only in partial clones). Section extras
  (`promisor`, `partialclonefilter`, non-default fetch refspecs, and a
  count of other `remote.<name>.*` settings as `otherSettings`) ride along
  so the UI can name what removal destroys. The `promisor` VALUE is
  resolved by the host git itself (`git config --type=bool --get-all` per
  promisor-carrying section): git's integer-bool grammar (strtoimax
  spelling rules, unit factors, the `maybe_bool` bound) is the host
  git's to answer — an in-module parse table duplicates a parser it
  cannot version-match — and the key is read additively (`--get-all`), because git
  registers a promisor remote on ANY true record, not the last. Records are NUL-framed: under
  `-z --show-scope` each is `scope\0key\nvalue\0` (a valueless key is
  `scope\0key\0`), which keeps subsection names with spaces and values
  with escaped newlines parseable. A `rev-parse --git-dir` probe runs
  first: outside a repository its stderr carries git's canonical "not a
  git repository" text the route classifier keys on; `--list` itself exits
  0 with the repository's other keys when no remote is configured, so the
  empty list comes from the scope filter.
- `gitRemoteAdd` / `gitRemoteRemove` run `git remote add -- <name> <url>` /
  `git remote remove -- <name>` (the `--` terminator is what lets removal
  work on config-held names the add predicate rejects) and then return
  `fetchGitRemotes`, so each mutation response carries the fresh list. Add
  pre-flights the name across ALL config scopes first: git's remote
  family WRITES (add/remote's duplicate check, remove's section edit)
  only the repository scope (local, include-sourced, worktree), while
  fetch/push RESOLVE the name across every scope — so the duplicate
  check is blind to an inherited (`global`/`system`/`unknown`/`command`) section,
  and the panel's own Add would otherwise silently create a same-name
  collision with one: git then resolves fetch/push from records the
  panel does not show, and a multi-valued url pushes to both
  destinations. That shape refuses with 409 `remote_shadows_inherited`
  (a deliberate shadow belongs to the terminal). Removal runs the
  mirror-image pre-flight from ONE all-scope origin-annotated dump
  (`--show-origin --show-scope`), before spawning `git remote remove`
  at all: git's rm deletes the tracking refs and unsets the pointing
  branches' keys BEFORE it can fail, so any record of the section
  living outside the two files a removal edits must refuse up front —
  an INHERITED scope record (`global`/`system`/`unknown`/`command`)
  TOGETHER with a repository-scope one (the split-section case, where
  git would exit 0 over the destroyed local half while the survivor
  keeps the name resolving) refuses 409
  `remote_shadows_inherited` — a section held ONLY in an inherited scope
  has no repository half to destroy, so it falls through to git's own
  no-such-remote 404 (the answer the client's stale-row convergence keys
  on) — and a repository-scope record whose
  origin is an `include.path`'d file (scope-labeled `local`, so the
  scope read alone cannot tell it apart) refuses 409
  `remote_section_in_included_file`. Nothing is mutated on either
  refusal. The pre-flight's repository-ness ordering comes from the
  reads inside it: the config dump exits 0 outside a repository (with
  the inherited config), but its `rev-parse` probes throw there before
  any record is inspected, so git's canonical not-a-repository answer
  keeps winning (the add path pins the same ordering). Relative origins
  resolve against the worktree TOPLEVEL (git chdirs during setup), so a
  subdir cwd removes fine.
  Removal verifies the
  section is gone from the repository scope afterwards, AND that the
  name no longer resolves AT ALL — verified by the UNION of the
  all-scope section read (an inherited pushurl-only section resolves
  fetch-side as the bare name, invisible to the resolver) and git's own
  resolver (`ls-remote --get-url`, which never contacts the remote): a
  config survivor in any scope, a legacy `$GIT_DIR/remotes/<name>`
  file, a `branches/<name>` file, or an insteadOf alias all keep a
  "removed" name fetchable otherwise. A refused removal — including a split section whose
  included half survives — can never be reported as success. One scope
  needs help: `git remote remove` cannot edit a per-worktree
  `config.worktree`, and fails with "Could not remove config section"
  AFTER deleting the tracking refs, so a worktree-scope row would be
  listed yet permanently un-removable, every retry repeating the
  destruction. When the surviving section lives ONLY at worktree scope,
  removal completes it with `git config --worktree --remove-section` and
  re-verifies; a local-scope survivor keeps
  answering `remote_still_configured` (a backstop — the include shapes
  are refused by the pre-flight above), a survivor in any other scope
  surfaces the way the removal itself failed — git's refusal as 409
  `git_config_write_failed` when `git remote remove` itself failed, and
  the all-scope verification answering `remote_still_configured` when git
  exited 0 but the name still resolves — and without
  `extensions.worktreeConfig` the completion never runs (there the
  `--worktree` selector would silently mean `--local`). The completion
  also never fires when git died BEFORE mutating: git echoes a
  config-chosen refspec value verbatim inside its fatal line, and that
  value can carry a real newline, so the completion matches its refusal
  phrase at a line start only, and an `error:`/`fatal: invalid
refspec` at any line start vetoes the completion outright — that refusal has its
  own answer (409 `remote_config_unparsable`; the row stays so the user
  can fix the refspec), which a completed "removal" would bury. A remaining `Could
  not remove config section` failure is then a config-write failure —
  a lock contention, or a section that does not exist to rename at all
  (the legacy `$GIT_DIR/remotes|branches` shape above, which git answers
  with this message after unsetting the branch keys) — and surfaces as
  409 `git_config_write_failed`. Removal first sweeps the tracking refs
  git's rm can leave orphaned — it deletes them only through a fetch
  refspec it can parse, so a certified removal also sweeps the
  `refs/remotes/<name>/*` namespace a refspec-less section leaves
  (`update-ref --no-deref -d` per ref, ownership by longest-prefix
  against the configured set PLUS the removed name, the exact bare ref
  included — a prefix-sibling's namespace stays), re-verified, with the
  same sweep converging on the no-such-remote retry path. Removal also
  cleans up the upstream keys
  `git remote remove` cannot reach: git unsets the pointing branches'
  `branch.<b>.remote`, `merge` and `pushRemote` keys only in the file it
  can write and SKIPS a multi-valued key with a warning, so keys held in
  `config.worktree` — and multi-valued local keys — would survive into a
  dangling `branch.<b>.remote = <gone>` (fatal on the next pull). A
  pre-removal snapshot records the branches pointing at the remote —
  fetch-pointed by `branch.<b>.remote`, push-pointed by
  `branch.<b>.pushRemote` (each resolved worktree-over-local with the
  last value winning, so a branch effectively tracking a SURVIVING
  remote is never touched) — and after the removal is certified the
  local- and worktree-scope keys are unset (`--fixed-value --unset-all`
  for remote/pushRemote entries — a multi-valued key contributes only
  the entries naming the removed remote — `--unset-all` for merge, and
  merge only when the same scope's remote key holds no entry naming a
  surviving remote — otherwise the branch keeps its upstream there and
  the merge half stays) and re-verified on the value-matched keys only
  (a merge survivor resolves to "." and is inert, so an include-held
  merge key the sweep cannot edit must not refuse a completed removal).
  Independently of the pointed snapshot, ANY branch.<b>.remote/
  pushRemote entry value-matched to the removed remote goes: a
  multi-valued key's non-effective entry is residue whose later
  surfacing would dangle. Linked worktrees carry their own
  config.worktree files the invoking worktree's reads never see, so the
  sweep walks every linked worktree — `git worktree list --porcelain -z`,
  NUL-framed fields — and cleans those — skipping
  `prunable` records (the directory is gone; nothing is readable) and
  refusing when a sibling holds a per-worktree `remote.<name>.*` section
  override (the name still resolves there; deliberate state the panel
  must not destroy), fail-closed per live worktree — with two
  negative-answer tolerances: a sibling with no `config.worktree` yet,
  and git's `--worktree cannot be used` refusal when
  `extensions.worktreeConfig` is off (the file is inert repo-wide
  then). A sibling merge key
  is swept only when the same file's remote key is being value-swept —
  a merge whose remote lives in the shared config is not this file's to
  decide. And git
  rm's effective-value match can delete a LOCAL [branch <b>] section
  whose shadowed copy named a SURVIVING remote; the pre-removal
  snapshot carries the per-branch local value lists, and those records
  are restored immediately after rm, BEFORE every post-destruction gate
  (so no later refusal — gate-side or sibling-side — can skip the
  rollback of git's own destruction; a kill between rm and the restore
  is the documented residual — a retry's fresh snapshot post-dates the
  destruction). Only absent keys are rewritten, and "absent" is read
  with the SAME set the snapshot captured: the scope dump labels an
  include.path'd file's records `local`, so the presence check reads
  `--local --includes` — a bare `--local` (includes off) would re-add an
  include-held survivor to `.git/config`, duplicating it and shadowing
  the include forever (a `--add` appends past the include directive and
  wins last-value resolution): a
  surviving key answers `remote_still_configured` instead of a certified
  dangling state, and a retry after a failed cleanup converges on the
  no-such-remote path rather than dead-ending. A push-pointed branch
  loses only its pushRemote — its merge key belongs to its surviving
  FETCH upstream. A local- or worktree-scope
  `remote.pushDefault` resolving to the removed remote is swept the same
  way, because `git push` would otherwise resolve to the gone remote. The same upstream keys held in
  files git's rm cannot write — an `include.path`'d file (scope-local),
  or an inherited global/system file — survive too, into the identical
  dangling state, and those files are outside what this module will
  edit, so a survivor refuses `remote_still_configured` instead of being
  swept. The survivor check resolves each `branch.<b>.remote`/
  `pushRemote` and `remote.pushDefault` the way git does (the last value
  across the scope chain wins), so a record shadowed by a
  higher-precedence scope pointing at a SURVIVING remote never refuses —
  git's rm itself compares effective values before unsetting — while a
  shadowing `.git/config` copy its rm unsets can UNMASK a same-valued
  inherited record into a live dangling state, which the resolution
  check catches. The unmask check also follows the pre-removal snapshot:
  a pointed branch whose shadowing record the removal unset may fall
  back to an inherited record naming a remote with no surviving section
  anywhere (removed earlier, or never existed here) — the branch's
  upstream changed from the removed remote to a dangling name, so the
  removal refuses rather than certifying it. "Resolves" here is git's
  OWN answer, not the record set: a bare-word value is probed with
  `ls-remote --get-url` (never contacts the remote; echoes the name
  verbatim only when nothing answers it), because a URL-less
  `[remote "foo"] proxy = …` record resolves NOTHING while a legacy
  `$GIT_DIR/remotes/<name>` file resolves with no record at all — the
  record set is wrong in both polarities. The probe is FETCH-side
  (`ls-remote --get-url` never sees a pushurl-only section), so the two
  PUSH-side arms (branch pushRemote, remote.pushDefault) also count a
  `remote.<value>.pushurl` record or a `url.*.pushInsteadOf` alias
  prefix in the already-fetched dump as resolving — a push-side-only
  upstream is fetch-dangling but push-resolving. And a bare-word value naming a directory repo
  inside the worktree counts as resolving too — git's path transport
  answers it while the resolver never sees it — probed via
  `ls-remote -- <value>` from the worktree (git's own transport
  magic-sniffs directory repos AND bundles, extension-independent) (the
  name-keyed certification gate never asks this: a coincidental
  same-named directory must not make a configured remote unremovable).
  Only snapshot-pointed
  entries are checked — the pointed branches AND the pre-removal
  `remote.pushDefault` resolution: the snapshot proves their value WAS
  the removed remote, so a changed value is the removal's doing — a
  pre-existing dangling upstream elsewhere is not this removal's to
  refuse. Sectionless values git resolves without a section (the
  local-repository `.`, URLs, scp-like `host:path`, and local paths
  `/abs`/`./rel`/`a/b`) are valid upstreams, not dangling names, and
  short-circuit before the probe. The same values are also refused as
  removal TARGETS by omission: the no-such-remote converge arm (a retry
  whose section already went) gates on the name being a possible
  section name, so `remove(".")` answers git's 404 without sweeping the
  live tracking keys value-matched to `.`. A bare-word name is
  distinguishable post-hoc, so the gate also consults git's resolver: a
  name still resolving with no section at all (an insteadOf alias —
  probed to fail no-such-remote WITHOUT git touching anything) skips the
  sweep the same way, as does a bare word naming a directory repo inside
  the worktree (a live local-path upstream the resolver never sees —
  probed via `ls-remote -- <name>`); a push-side alias
  (`url.*.pushInsteadOf`, the `gh:`
  pattern) keeps a bare name push-resolving while nothing fetch-side
  answers it, and the dump itself answers there (git has no push-side
  resolver probe); a legacy `$GIT_DIR/remotes|branches` file instead
  makes git's own rm fail on the missing section after unsetting the
  branch keys (git's behavior, mirrored — outside the converge arm).
  The converged cleanup re-verifies the ref sweep the way the certify
  path does (a surviving ref — a stale lock — refuses instead of
  abandoning the namespace to a 404).
  The skip's accepted residual:
  git also accepts a colon-bearing (or `.`/`/`-shaped) SECTION name, so a
  hand-made sectionless-named remote whose first-attempt cleanup died
  mid-sweep converges nothing on retry — the two states (never-sectioned live
  upstream vs orphaned-by-failed-removal) are indistinguishable once the
  section is gone, and sweeping risks the live one.
- `runGit` stays the single exec wrapper: export it from `git-branches.ts`
  (add one keyword) and import it here; `gitEnv` is already exported.
- `isValidRemoteName` is deliberately conservative — a single refname-style
  component: it reuses `isValidRefName` (control/space and `~^:?*[\`
  rejection, dot/`.lock`/`..`/`@{` rules, per-component cap) and adds
  `no /`, `no leading -` (flag-injection guard) and the invisible-character
  class (a name that renders identically to an existing remote is a
  deletion-spoofing surface). Git validates again at `remote add` time; this
  predicate exists so the route can answer 400 before spawning git.
- `isValidRemoteUrl` accepts almost anything git accepts (https/ssh/scp-like/
  local paths, spaces included) and rejects blanks, a leading `-` (exec
  vector), the command-executing transport-helper form in general (an
  anchored `<scheme>::` prefix, with no letter-first rule — `7z::archive`
  executes `git-remote-7z` like any other helper), and the
  invisible-character class. The helper rejection is necessary even though
  git's default policy refuses them: that policy is overridable from config
  FILES, which no per-invocation env scrubbing can reach, and from the
  `GIT_ALLOW_PROTOCOL` environment variable, which `gitEnv` neutralizes by
  normalization — an inherited list keeps its deny-by-default force with
  the helper-executing entries (`ext`, `fd`) stripped, and a list that
  filters to empty stays set (deny-all) rather than becoming undefined.
  The prefix is anchored at the start so an IPv6 literal
  (`ssh://git@[::1]/repo.git`) or an scp-like path never matches; stock git
  ships no `git-remote-ssh`, so ordinary ssh/scp-like/ssh:// URLs never
  carry the `::` delimiter and stay accepted.
- The invisible-character classes are derived from the Unicode property
  (the C0/C1 controls `\p{Cc}`, the format characters `\p{Cf}`,
  `\p{Default_Ignorable_Code_Point}`, plus the line/paragraph separators
  U+2028/U+2029), not a hand list — the property grows with Unicode, so an enumeration
  always has an unlisted corner.
- `isRemovableRemoteName` is the removal predicate and is deliberately
  **more lenient** than the add one: removal targets a remote git already
  has configured (a hand-edited `.git/config` can hold names the add
  predicate rejects). It still inherits the branch-name refusals of the
  shared `isValidRefName` — including `HEAD`, which git's own remote-name
  check would accept (`refs/remotes/HEAD/foo` is an ordinary refname):
  refusing it is deliberate conservatism, pinned by the predicate table,
  not a mirror of git's remote rules. It accepts names the add
  predicate rejects (including invisible-character names the sanitizer
  strips), so its only floors are non-emptiness, the NUL byte execFile
  cannot carry in an argv entry, and no `/` (a slashed name's tracking
  namespace collides with the prefix remote's — the sweep could not tell
  their refs apart; see §2); the `--` terminator guards the exec vector
  for everything else instead of name rejection. A config key is never empty and can never
  carry a NUL, so the `/` floor is the only one a listed row can fail (a
  slashed remote lists but refuses removal — the terminal's
  `git remote remove` remains the tool; see §2); the route still applies
  the predicate to client-supplied names (400 `invalid_remote_name`
  before any git spawn).
- New file added to `packages/core/src/index.ts` next to the
  `git-branches.js` export.

### 2. Daemon routes — new `packages/cli/src/serve/routes/workspace-git-remotes.ts`

Scoped only (GitHub-PRs precedent; the Web Shell always goes through
`workspaceByCwd`):

| Method | Path                                       | Body            | Success                                                             |
| ------ | ------------------------------------------ | --------------- | ------------------------------------------------------------------- |
| GET    | `/workspaces/:workspace/git/remotes`       | — (`?cwd=` ok)  | `{ v: 1, workspaceCwd, available: true, remotes: GitRemoteInfo[] }` |
| POST   | `/workspaces/:workspace/git/remote`        | `{ name, url }` | `{ v: 1, workspaceCwd, remotes: GitRemoteInfo[] }`                  |
| POST   | `/workspaces/:workspace/git/remote/remove` | `{ name }`      | `{ v: 1, workspaceCwd, remotes: GitRemoteInfo[] }`                  |

- Registration shape mirrors `registerWorkspaceQualifiedGitBranchRoutes`:
  `registerWorkspaceQualifiedGitRemotesRoutes(app, { workspaceRegistry,
sendBridgeError, mutate })`, mounted in `server.ts` directly after the
  branch-route mounts.
- Request pipeline identical to the branch mutations: `deps.mutate({ strict:
true })` → `resolveTrustedRuntime` → `generationGuard.assertOpen()` →
  `resolveContainedCwdOrFail` (GET uses the non-fatal `resolveContainedCwd`).
- Body validation before any git spawn: `name` must satisfy
  `isValidRemoteName` (→ 400 `invalid_remote_name`); `url` must satisfy
  `isValidRemoteUrl` after trimming (→ 400 `invalid_remote_url`). Remove
  validates with the lenient `isRemovableRemoteName` and lets an unknown
  name surface git's own `error: No such remote` (see below) rather than a
  pre-check, keeping the route race-free against concurrent CLI use. The
  one shape the lenient predicate refuses is a SLASHED name: its tracking
  namespace is a subdirectory of the prefix remote's
  (`refs/remotes/origin/staging/*` lives inside `refs/remotes/origin/*`),
  so no sweep can tell the remote's own refs from the prefix remote's
  branch refs — the terminal's `git remote remove` remains the tool.
- Error mapping: the shared `sendGitError` in `workspace-git-branches.ts`
  (exported; its `redactGitMessage` helper stays private) gains seven
  remote-specific branches **ahead of every keyword branch**, because git
  echoes the user-chosen remote name (and, for config-write failures, the
  URL verbatim) in these messages. Every branch matches ONLY at the start
  of the composed detail — line 1; the config-write branch additionally
  accepts git's documented two-line `could not lock config file …` chain
  (the lock line is git's own, not echoed content). The table's patterns
  transcribe git's own casing, while the shipped code matches
  case-insensitively — a belt-and-braces margin for the loose legacy
  keyword branches (which match the CAPPED slice — an unbounded scan
  would reclassify long push/pull output by a keyword-bearing URL past
  the cap), against the
  keyword shapes the same classifier carries — not a claim that git
  re-cases these messages: a config-chosen name
  can carry any keyword, and a config-chosen VALUE (a URL or a fetch
  refspec) can carry a real newline — git unescapes `\n` in quoted
  values — so any deeper line-initial text is attacker-controllable and
  must never be claimed:
  - `^(?:error|fatal): Could not remove config section ` /
    `^(?:error|fatal): could not set 'remote\.` /
    `^(?:error|fatal): could not unset 'branch\.` → 409
    `git_config_write_failed` (a config-write failure — a lock contention,
    or a section in a file git will not edit — not a dirty tree;
    `git remote remove` unsets the pointing branches' `branch.*.remote`
    keys before it deletes refs and removes the section, so a lock can
    surface in any of the three shapes)
  - `^(?:error|fatal): remote .+ already exists\.?\s*$` → 409
    `remote_already_exists`
  - `^(?:error|fatal): No such remote: ` → 404 `no_such_remote`
  - `^remote still configured after removal$` → 409
    `remote_still_configured` (the removal-verification failure — a
    surviving section, OR a worktree upstream key the cleanup could not
    unset, OR an upstream key still RESOLVING to the removed remote from
    a file git's rm cannot write (an `include.path`'d file or an
    inherited global/system file, including an unmasked same-valued
    inherited record), OR the name still resolving through git's own
    resolver after the section is gone (a legacy `$GIT_DIR/remotes/<name>`
    file, a `branches/<name>` file, an insteadOf alias), OR a sibling
    worktree's config.worktree holding a key — or a per-worktree section
    override — for the removed remote; the message carries no name, so
    no keyword branch can claim it)
  - `^remote section lives in an included config file$` → 409
    `remote_section_in_included_file` (the remove pre-flight refusal; a
    plain Error with no git prefix, thrown before `git remote remove`
    runs so nothing is destroyed)
  - `^(?:error|fatal): invalid refspec` → 409 `remote_config_unparsable`
    (git dies parsing a configured fetch refspec before mutating anything:
    the row stays, nothing was destroyed, and the cause is nameable)
  - `^remote already configured in an inherited scope$` → 409
    `remote_shadows_inherited` (the add AND remove pre-flight refusal —
    removal runs the same inherited-scope check before spawning git rm,
    because git would exit 0 after destroying the local half — only the
    module's own post-removal all-scope verification would refuse
    afterwards; a plain Error with no git prefix)
    The remotes routes delegate to it unchanged; everything else
    (not-a-repo → 404 `not_a_git_repository`, redacted 500 fall-through)
    keeps its existing classification. Blast radius: this classifier is
    shared by all git routes, so the table is pinned from the owning file
    by a collocated `sendGitError` classification-table test (message in →
    status/code out), including keyword-carrying remote names and the
    stdout half of the classified detail.

### 3. SDK — `packages/sdk-typescript`

- `types.ts`: `DaemonGitRemoteInfo { name; fetchUrl; pushUrl;
extraFetchUrls; extraPushUrls; promisor; partialCloneFilter?;
customRefspec; otherSettings }`, `DaemonGitRemotesResult { v;
workspaceCwd; available; remotes }`, `DaemonGitRemoteMutationResult { v;
workspaceCwd; remotes }` (mutations answer the fresh list without
  `available`); re-export from `daemon/index.ts`.
- `WorkspaceDaemonClient` (scoped only, next to `workspaceGitBranches`):
  - `workspaceGitRemotes(cwd?)` — GET `…/git/remotes`
  - `workspaceGitRemoteAdd(name, url, cwd?, timeoutMs?)` — POST `…/git/remote`
  - `workspaceGitRemoteRemove(name, cwd?, timeoutMs?)` — POST
    `…/git/remote/remove` (mutations take a per-call timeout: the panel
    passes the shared remote-mutation fetch timeout, whose chain
    outlives the 30 s default)
- No legacy `DaemonClient` methods (no legacy routes exist).

### 4. Web Shell UI — `BranchPickerPopover.tsx`

- New state `view: 'branches' | 'remotes'`, reset to `'branches'` on open;
  entering the remotes view clears the pull-resolution panel **only while it
  is standing** (`pullBlocked`) — a sticky stash-restore warning survives the
  round trip, per `stickyWarningRef`'s contract (pinned by a test). The
  standing warning is also snapshotted on entry and restored on exit
  (message AND sticky flag), because a remotes mutation's own footer
  (`Added remote …`) would otherwise overwrite the only in-product
  record of the stash entry and disarm the flag — restored on the back
  button AND on a dismissal with the view up (restored at the next
  open), both gated on no in-flight mutation so a settling mutation's
  own footer is not clobbered and the held snapshot survives to a
  later open — and a standing warning always outranks a held
  snapshot (an armed flag at open time is the same warning the
  snapshot holds — a dismissal with the view up never disarms it — or
  a newer one; either way the standing message wins and the held
  snapshot is dropped).
- New action row **Manage Remotes…** (lucide `GlobeIcon`) in the second
  action group, after _Checkout Tag or Revision…_; also matched by the
  existing `actionsVisible` search filter.
- Remotes view replaces the scrollable list area (search box and footer
  status bar stay):
  - Header row: back chevron + title; sticky to the top of the scroll box,
    and focused on view entry so the switch never drops focus to
    `document.body`. Leaving the view returns focus to the row that opens
    the panel. Escape leaves the remotes view first (a second Escape
    dismisses the popover), so the typed add draft is not destroyed by the
    key that means "go back". While the popover is open a window-capture
    `preserveImeEscape` mask (mirroring `DialogShell`) hides an IME-owned
    Escape from Radix's capture-phase dismiss listener — which checks
    only `event.key` — so a composition-cancelling Escape neither tears
    down the view nor swallows the native cancel via the layer's
    preventDefault.
  - Remote rows: name (a name whose DISPLAYED form — sanitized,
    whitespace-collapsed and edge-trimmed the way CSS inks it — is empty
    renders a visible `(invisible name)` label; a name whose displayed
    form merely DIFFERS from the raw one — including one that collides with a sibling
    row's text, and one differing only by whitespace, which CSS collapses
    out of the inked text — plus the three structural arms the class list
    cannot enumerate: a name that is not NFC (a canonical twin inks
    identically), a Latin name mixing in another script's letters
    (the Cyrillic-`о` homoglyph shape), and a TR39 skeleton COLLISION
    with a sibling row — each name folds through the vendored
    `unicodeConfusables` prototype table FIRST (the table's prototype is
    authoritative: NFKC routes a Greek lunate sigma through Σ, away from
    the C the table answers), with NFKC as the fallback for the
    compatibility shapes the table does not list, and an NFC closure so
    canonically-equal skeletons compare equal (generated from
    Unicode's confusables.txt by
    `packages/web-shell/scripts/generate-confusables.mjs`, which also
    closes every emitted prototype under that same runtime fold —
    table-first, NFKC fallback, NFC last — so a value carrying a
    table-absent compatibility half (`%` → `º/₀`: its halves NFKC to
    `o/0`, and the per-half table chance lifts the `0` to `O`) cannot
    split one ink-identical class across two skeletons),
    and a row whose skeleton equals a sibling's while its raw name
    differs marks: an ink-identical twin inside Latin/Common (the
    `ofﬁce` ligature, dotless `ı`) passes every per-property arm, and
    the fold closes the class one table rule covers instead of one arm
    per family. For a group carrying a non-ASCII member the collision
    marks the row carrying the non-canonical spelling (raw ≠ skeleton —
    the odd character is the visible evidence), so a plain sibling — and
    a lone legitimate non-ASCII name with no twin — stays unmarked; for
    an all-printable-ASCII group `raw ≠ skeleton` carries no evidence
    about which spelling is the impostor (the table's `m → rn` expansion
    makes the legitimate `main` the deviant-looking side), so BOTH rows
    mark, and a prototype-spelling row whose escape would be a no-op
    gets no escape tail. The
    collision counts are computed over the UNFILTERED list, so a search
    that isolates one twin cannot strip the survivor's marker; the row
    search folds the marking skeleton as an extra name-side target, so a
    table-only twin (dotless-ı, long s) is findable by the text it inks
    as —
    appends a `(hidden characters)` marker — or, for a row marked ONLY
    by a collision inside printable ASCII (the table folds 1→l, m→rn;
    nothing is hidden), a `(lookalike name)` marker —
    and its tooltip and aria-labels carry the raw name with the
    distinguishing characters as visible codepoint escapes (every
    non-ASCII character spelled out for the canonical/script arms;
    skeleton rows also spell the fold-covered printable code points,
    so the tooltip always disambiguates), so a
    lookalike row never presents the plain row's identity), a badge
    naming what removal
    destroys beyond the URL
    (partial-clone/promisor, custom refspec, extra configured URLs, and a
    count of other `remote.<name>.*` settings), the fetch URL (truncated,
    `title` attr; push URL shown only when it differs), and a trailing
    remove icon-button.
  - Remove uses a **two-click inline confirm** (first click swaps the row's
    button to a red _Confirm_ state whose accessible name still carries the
    remote's displayed name; second click executes; any other action or
    view switch resets it) — no nested dialog inside a popover. The armed
    state has its own focus-visible style because the base hover color is
    already spent by the armed color.
  - Inline add form at the bottom of the list, sticky and wrapping so the
    Add control stays inside the fixed-width popover: name input + URL
    input + Add button (Enter submits from either input, guarded the
    house way against an IME-owned Enter — `isComposing` or keyCode 229
    — so composing a non-ASCII name cannot submit the pre-commit text;
    inputs are disabled while a mutation is in flight; the client guard
    rejects only empty and leading-`-` values — the daemon remains the
    validation authority and its 400 message lands in the footer).
  - Remote names and URLs are rendered through a display sanitizer derived
    from the Unicode property (a `.git/config` the user did not author can
    carry invisible characters that make a row render identically to
    another), and both sides of the search filter are
    sanitized AND whitespace-collapsed the way CSS inks them, plus
    NFKC-folded (a ligature inks as its letter pair), so a needle
    copied from a row's displayed text finds the row; mutation requests
    still use the raw name. URL tooltips escape whitespace alongside the
    invisible characters, so two URLs differing only by whitespace never
    tooltip identically.
  - The search input filters remotes while in this view and carries a
    remotes-specific placeholder; entering or leaving the view clears the
    query so the string used to find the action row cannot filter the
    panel to nothing.
- Data flow: entering the view fetches `workspaceGitRemotes(gitCwd)`; add /
  remove use the list returned by the mutation response directly. Only
  **remove** then calls `fetchBranches(true)` in the background —
  `git remote remove` deletes `refs/remotes/<name>/*`, so the branches
  view's remote groups must refresh before the user navigates back; an add
  creates no remote-tracking refs, so it does not. A remove refused with
  404 `no_such_remote`, 409 `git_config_write_failed` or
  `remote_still_configured` refreshes the branch list and status too: git
  deletes the tracking refs (and the tracking config of the branches that
  pointed at them) BEFORE the section write, so any refusal that proves
  or leaves that destruction — another client having removed the remote
  first, a lock-failed write, or a split section whose other half
  survives the verification — leaves the refs gone on screen otherwise.
  A **refused** mutation re-reads the remotes list **silently** (no loading
  placeholder, no error replacement) and **only** when the daemon's code
  says the list is stale (`remote_already_exists`, `no_such_remote`,
  `remote_still_configured`); every other refusal (400 validation, 503
  draining, transport failure) leaves the usable rows and the typed draft
  on screen and speaks through the footer alone. Mutation errors land in
  the existing footer status bar (`statusType: 'error'`).
- Focus: entering the view focuses the back button; leaving restores the
  manage-remotes row (search box when it is disabled). Disabling the add
  inputs or the remove buttons for an in-flight mutation blurs a focused
  control in real browsers, and a successful removal unmounts the focused
  row entirely, so focus is restored when the mutation settles: the name
  input after a successful add, the remembered field or the submit button
  otherwise. A removal restores the row's remove button when the row
  survives — including a refused removal whose silent re-read keeps it —
  and the panel's back button when the row is gone, whether the removal
  succeeded or the refused removal's awaited re-read converged it away.
  Every capture and lookup resolves from the popover content's own root
  (`getShadowAwareActiveElement` / root-scoped `querySelector`): in the
  shadow-portal embedding `document.activeElement` retargets to the host
  and `document.body` lookups cannot cross the boundary, so the whole
  restore would otherwise be inert there.
- i18n (en + zh), following the existing `branchPicker.*` block:
  `branchPicker.action.manageRemotes`, `branchPicker.remotes.title`,
  `.empty`, `.noMatches`, `.loading`, `.namePlaceholder`, `.urlPlaceholder`,
  `.add`, `.back`, `.remove`, `.removeConfirm`, `.removeConfirmFor`,
  `.invisibleName`, `.hiddenChars`, `.lookalikeName`,
  `.searchPlaceholder`, `.urlTooltipFetch`, `.urlTooltipPush`, `.promisor`,
  `.partialClone`, `.customRefspec`, `.extraUrls`, `.otherSettings`,
  `.added`, `.removed`, `.invalidInput` (client-side guard for
  empty/dash-prefixed input; the daemon remains the validation authority).
- CSS: new classes in `BranchPickerPopover.module.css` (`.remotesHeader`,
  `.backButton`, `.remotesTitle`, `.remoteRow`, `.remoteName`,
  `.remoteBadge`, `.remoteUrl`,
  `.remoteRemove`, `.remoteRemoveConfirm`, `.addRemoteForm`,
  `.addRemoteButton`), built on the same `--border` / `--muted-foreground` /
  `--destructive` vars; the header and add form are sticky inside the scroll
  box and the form wraps with `min-width: 0` inputs so it cannot overflow
  the fixed-width popover.

### 5. e2e mock — `packages/web-shell/client/e2e/utils/mockDaemon.ts`

- New optional scenario field `gitRemotes?: DaemonGitRemoteInfo[]` (default
  fixture: one `origin` with the full shape), threaded like `gitBranches`.
- Extend the git alternations in `isDaemonPath` and `isDaemonRoute` with
  `remotes|remote(?:/remove)?` (scoped paths only, matching the routes) so
  the new paths stay on the daemon route table.
- Response handlers: GET returns the fixture list; POST add/remove mutate
  the in-memory list and return it (mirrors the real contract), with
  `remote_already_exists` / `no_such_remote` error bodies.

### 6. Tests (collocated)

| File                                                                | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/utils/git-remotes.test.ts`                       | config-read listing contract (config order, push-url override via `git remote set-url --push`, promisor/partial-clone remote, url-less section → empty urls, multi-valued urls, space-bearing subsection and embedded-newline values under the NUL framing, inherited-scope exclusion, `insteadOf` immunity, invalid-refspec survival, `otherSettings` count), repository-scope cases (include.path listing, split-section and include-held-section PRE-flight refusals that leave refs and branch keys intact and answer retry-identically, worktree-scope listing and worktree-scope removal completion incl. the dotted-sibling gate, killed/no-match config-read discrimination and the killed-read stdout dump strip in `git-remotes-kill.test.ts` (incl. the killed promisor badge read, the killed resolver read, the killed worktree-list read, the killed sibling read, and the killed restore read), inherited-scope add refusal and removal refusal (incl. the not-a-repo ordering witnesses on BOTH sides), the inherited-shadowed worktree gate, and the upstream-key cleanup stage — a pre-removal snapshot of the pointing branches (worktree-over-local, last-value), then post-certification cleanup of the local- and worktree-scope `branch.<b>.remote`/`merge`/`pushRemote` keys (`--fixed-value --unset-all` for remote/pushRemote, `--unset-all` for merge, re-verify-and-refuse), incl. the local-section cleanup case, the multi-valued exact-value case, the mixed-scope merge case, the push-pointed branch losing only its pushRemote, the worktree-scope pushDefault sweep, the planted-lock refusal, the no-such-remote retry convergence, the include-held upstream-key and pushDefault refusals, the multi-valued LOCAL key swept by exact value, and the inherited-scope upstream-key cases (global-scope refusal, rm-unmasking refusal, the unmasked-gone-remote refusal and the unmasked-surviving-remote acceptance pinned by the pre-removal snapshot, shadowed-by-surviving-remote acceptance, the pushDefault unmask trio (gone-remote refusal, surviving-remote acceptance, pre-existing-dangling acceptance), the pushRemote unmask refusal, the slashed-name removal refusal (a slashed tracking namespace collides with the prefix remote's), the sectionless-value acceptances (the local-repository pseudo-remote `.`, an unmasked URL upstream, an unmasked scp-like pushDefault, an unmasked local-path upstream), the unknown-scope survivor refusal (in `git-remotes-kill.test.ts`), the include-held inert-merge acceptance, the include-held residue shadowed by a surviving worktree record acceptance, and the subdirectory-cwd removal, the sibling-worktree sweep (incl. the prunable-record skip, the extension-off acceptance, the section-override refusal, the shared-config merge keep, the multi-valued surviving-entry merge keep, and the unrelated-subkey tolerance), the destroyed-local-copy restore (incl. the multi-valued-survivor merge restore and the kill-suite ordering witness that the restore lands after rm, before every post-destruction gate), the legacy .git/remotes refusal, the pushurl-only inherited-survivor and same-name-in-global refusals landing BEFORE any destruction (local section, tracking ref and branch keys all intact, incl. the worktree-section shape), the sectionless converge gate (`.`, scp-like, insteadOf-aliased, and bare-word directory-repo targets answer git's 404 with live tracking config untouched), the inherited-only section answering git's 404 (no repository half to destroy), the bare-word-directory-repo unmask acceptance incl. the subdirectory-cwd shape (the path probe answers through git's own transport, toplevel-relative), the bare-repo `<name>` spelling, the pushRemote/pushDefault mirrors, the bundle-file pair (git's `ls-remote` transport magic-sniffs bundles, extension-independent — the `--resolve-git-dir` model it replaced refused them as "too large to be a .git file"), the empty-alias guards (an empty pushInsteadOf value would prefix-match every name), the pushInsteadOf-aliased name's converge skip AND unmasked-pushRemote acceptance (push-side aliases answer from the dump — no resolver probe exists), the converge arm's killed path-probe read (kill suite), its persistent-ref-lock refusal (the re-verified sweep), and the two race-only backstops (the union gate's section half and the worktree-completion `size !== 1` conjunct, kill suite), the unmasked URL-less-section refusal and legacy-file acceptance (the unmask gate probes git's own resolver, not the record set), the pushurl-only pushDefault acceptance (the push-side arms count a pushurl record as resolving) and its pushRemote-arm pair (pushurl-only and surviving-remote acceptances), the include-held pushDefault non-duplication (the restore's presence check reads --local --includes), the edge-whitespace AND trailing-CR name round-trips, the dotted-sibling-override acceptance, the shadowed-pushDefault restore, the converge-arm sibling sweep, the non-effective multi-valued residue sweep, and the surviving-entry merge keep)), the host-git promisor delegation (version-stable spellings only, the additive multi-valued read, the unparseable-value floor, the cross-scope key presence), the invalid-refspec completion veto (injected lowercase and exact-prefix refusal lines, section survives), the orphaned tracking-refs sweep for refspec-less removals (worktree and local shapes, dotted-sibling namespace kept, symbolic refs swept without dereferencing, the converge-arm retry after a failed sweep), the exact bare ref `refs/remotes/<name>` and the slashed-sibling namespace kept (ownership resolved by longest-prefix against the configured set plus the removed name), the pushurl-less push fan-out count, the lookalike-add refusal, the section-survival assertion on the invalid-refspec refusal, the scoped worktree-half assertion, the Default_Ignorable-only url row, the on/OFF keyword rows, and the host system-config precondition guard, add/remove round-trips in a tmp repo incl. dash/TAB/predicate-legal names, predicate tables incl. the add/remove leniency divergence and the NUL floor, trimmed-url storage, helper-URL rejection before spawn |
| `packages/cli/src/serve/routes/workspace-git-remotes.test.ts`       | mirrors `workspace-git-branches.test.ts`: trust gate, generation guard (503 `workspace_runtime_unavailable` on all three endpoints), `invalid_cwd` 400, `invalid_remote_name`/`invalid_remote_url` 400, add→list, duplicate → 409 `remote_already_exists`, remove→list, remove-missing → 404 `no_such_remote`, config-lock → 409 `git_config_write_failed` (both the section-write chain and the tracking-branch unset chain), non-repo → 404 `not_a_git_repository` (ancestor-walk ceiling), unknown workspace → `workspace_mismatch`, path redaction, NUL-name 400 on remove, strict mutation gating per POST registration, mid-flight generation close → 503, runtime-env threading into git (inherited-shadow refusal from a fixture-global section), and the host system-config precondition guard; the collocated classification table in `workspace-git-branches.test.ts` pins every `sendGitError` remote branch (including the included-file pre-flight refusal) incl. precedence over the keyword branches, keyword-carrying remote names, the dirty-named remote shapes, the stdout half of the detail, and the linked-worktree main-gitdir redaction (NUL and head-truncated targets, inherited home/XDG config files incl. the empty-XDG, no-HOME and trailing-slash verbatim-concatenation shapes, the build-time system-gitconfig path, and the arbitrary-location include-target shapes (POSIX-absolute, Windows drive-letter backslash AND forward-slash, and UNC payloads), the linear-token /etc/gitconfig arm (a 200k-char whitespace-free run answers far under the pinned 10s bound — the quadratic arm it discriminates against costs ~17s), and the fail-closed absolute-path sweep (an unenumerated `bad numeric config value … in file %s` shape redacts, the apostrophe-bearing include target keeps its prefix redacted, and the transport-URL control survives verbatim))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/sdk-typescript/test/unit/DaemonClient.test.ts`            | URL/method/body composition for the three new methods, with and without `cwd`, and the per-call timeout pass-through on add and remove (each abort races a never-settling fetch)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/web-shell/client/components/BranchPickerPopover.test.tsx` | open panel → list renders; add success/failure; local dash guard; remove two-click confirm + counted post-remove refreshes + `onBranchChanged`; back button; search filters; filtered-to-empty copy; load-failure rendering; sticky-warning survival across the round trip; reopen reset/disarm; Escape leaves the view first (cancelable-event witness for the anti-dismissal guard); focus restore to the manage row on exit with a search-box fallback while a mutation disables the row; `(invisible name)` label and armed-confirm aria-label; lookalike-row marking incl. URL tooltips; removal-consequence badge; silent re-read only on stale-list codes; rows kept while a re-read is in flight; still-configured re-read; config-write-failure and still-configured and no-such-remote branch refreshes; focus restores (add-form fields after settle, back button after a successful removal, and a shadow-portal-root removal restore), whitespace-lookalike name marking, canonical-equivalence and script-mixing lookalike marking (legitimate non-ASCII unmarked), TR39 skeleton-collision marking (the ligature, dotless-ı and long-s twins mark with codepoint-escaped tooltips — the long-s pair pins the table-first fold order — the canonical sibling and a lone non-canonical name stay plain), the printable-ASCII collision labeled `(lookalike name)` with the fold-covered code point spelled, the NFKC-folded search finding a ligature row by the text it inks as (and the marker surviving an isolating search), the consumer-fold split witness (a table-absent NFKC half inside an emitted prototype re-closes at generation time, keeping `ᵒ` and `º` in one skeleton), the hidden-characters marker surviving a URL-homoglyph × skeleton-collision co-firing (marker precedence, fetch/push arms), the non-ASCII URL fail-closed marking (URLs are an ASCII-only surface), the multi-line footer sentence boundary, IME-owned-Enter add guard, the IME-owned-Escape mask (no view teardown, no dismissal, native cancel unsuppressed, key restored before the input), sticky-warning restore across a remotes mutation, a view-up dismiss, and the settle/newer-warning races, armed-confirm disarm on filter-out/Escape/add-submit, loading-state positive witness, pull-panel clearing on entry, footer error sanitization, non-awaited branch refresh, filter clearing on add, extras-text search, needle sanitization, push-differs tooltip (localized via the i18n keys, with a zh-CN witness), consequence-naming armed aria-label, removing-row spinner, view-entry focus, and the un-prevented-Escape dismissal via the mock's DismissableLayer parity, display sanitization with raw-name removal, action-query isolation, search-focus preservation, workspace-switch focus reset and staleness drop, silent-re-read failure keeping rows and the typed draft, in-flight add-input disabling, refused-removal row-unmount focus restore, cross-popover focus isolation, and workspace-cwd read scoping, and the open-autofocus settle shared by the focus tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/web-shell/client/e2e/web-shell.git-remotes.spec.ts`       | Playwright + mockDaemon: sidebar pill → panel → list/add/remove (two-click, `@smoke`), duplicate-add error incl. submit-button focus restore, search filtering, add-form geometry inside the popover clip, and a stressed 15-row fixture pinning row/remove-button width inside the clip plus sticky header/form at both scroll extremes — all structural selectors on `data-testid` (hashed CSS-Modules class substrings over-match the moment a sibling local shares a prefix)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Files affected

- `packages/core/src/utils/git-remotes.ts` (new) + `.test.ts` (new) +
  `git-remotes-kill.test.ts` (new — killed/no-match config-read discriminator)
- `packages/core/src/utils/git-branches.ts` (export `runGit`; `gitEnv`
  normalizes an inherited `GIT_ALLOW_PROTOCOL` instead of deleting it) +
  `git-branches.test.ts` (env-isolation and normalization witnesses)
- `packages/core/src/index.ts` (one export line)
- `packages/cli/src/serve/routes/workspace-git-remotes.ts` (new) + `.test.ts` (new)
- `packages/cli/src/serve/routes/workspace-git-branches.ts` (export `sendGitError`; the shared classifier gains the seven remote-specific branches) + `workspace-git-branches.test.ts` (collocated `sendGitError` classification table)
- `packages/cli/src/serve/process-env-guard.test.ts` (registers the redaction's process-scoped `HOME`/`XDG_CONFIG_HOME` reads in the guard allowlist, per file and per access count — not an unconditional exemption)
- `packages/cli/src/serve/server.ts` (mount new register fn)
- `packages/sdk-typescript/src/daemon/types.ts`, `daemon/index.ts`, `daemon/DaemonClient.ts`
- `packages/sdk-typescript/test/unit/DaemonClient.test.ts`
- `packages/web-shell/client/components/BranchPickerPopover.tsx` + `.module.css` + `.test.tsx`
- `packages/web-shell/client/i18n.tsx`
- `packages/web-shell/client/utils/unicodeConfusables.ts` (new — vendored
  UTS #39 confusables table, generated, eslint-exempt: the type-aware rules
  OOM on the 6.5k-entry literal) + `packages/web-shell/scripts/generate-confusables.mjs`
  (new — its regenerator; refuses an HTTP error or an implausibly small
  source instead of overwriting the table)
- `eslint.config.js` (one ignore entry for the generated table)
- `packages/web-shell/client/e2e/utils/mockDaemon.ts`
- `packages/web-shell/client/e2e/utils/gitScenario.ts` (new — git-workspace fixture shared with `web-shell.git-mode.spec.ts`) + `web-shell.git-remotes.spec.ts` (new) + `web-shell.git-mode.spec.ts` (uses the shared fixture) + `capture-git-mode-screenshots.ts` (migrated to the shared fixture)

## Scope boundaries

- List + add + remove only. No set-url, rename, fetch, prune, or LFS/URL
  rewriting UI.
- Scoped routes only; no legacy `/workspace/git/remote*`.
- No changes to `GitDialog`; the only entry point is the BranchPicker
  popover.
- No daemon-side caching — every GET re-reads git (cheap, always accurate
  against concurrent CLI use).

## Security notes

- All git invocation goes through `runGit` (execFile arg vector, no shell);
  mutations terminate options with `--` so a config-held name can never read
  as a flag, and `url` rejects C1 controls and the invisible-character
  class so the panel never WRITES a URL that inks like a sibling's
  (config hygiene; mutation requests and git's own output still carry
  the raw value). The render boundary is the display sanitizer, which
  also covers pre-existing and inherited URLs the write predicate never
  sees.
- Command-executing transport helpers (the anchored `<scheme>::` form, e.g.
  `ext::`, `fd::`) are **rejected by the write predicate**. Git's default
  policy (`protocol.ext.allow=never`) also refuses them at connect time,
  but that policy is overridable from config **files** (including a global
  `[protocol] allow = always`, the standard hand-fix for a refused
  `file://` clone), which no per-invocation env scrub can remove, so the
  default policy alone is not a guarantee. The env-var override
  (`GIT_ALLOW_PROTOCOL`) is neutralized by normalization instead of
  deletion: an inherited list keeps its deny-by-default force with the
  helper-executing entries stripped, because deleting it outright would
  hand a workspace-controlled `protocol.<name>.allow` the final say.
  The prefix is anchored at the start with git's transport-name charset, so
  an IPv6 literal or scp-like path never matches; stock git ships no
  `git-remote-ssh`, so the `::` delimiter separates ordinary URL forms
  (ssh://, scp-like, https) from helper forms, and rejecting it breaks no
  legitimate remote.
- Invisible-character classes are derived from the Unicode property
  (`\p{Default_Ignorable_Code_Point}`) rather than enumerated, on both the
  write predicate and the display sanitizer, because the set grows with
  Unicode and a hand list always has an unlisted corner (the Tag block
  U+E0000-E0FFF is zero-width and zero-ink, so an unlisted code point makes
  two distinct remotes render identically).
- Mutations inherit the full strict chain: mutation gate → trusted-runtime
  resolution → generation guard → workspace-contained `cwd`.
- Error responses pass through the existing redaction (`redactGitMessage`)
  so absolute paths never reach the client. The redaction substitutes the
  workspace path, the git root, AND any gitdir outside the cwd's tree —
  a linked worktree's shared main `.git` dir (git echoes that absolute
  path for config-lock failures — `could not lock config file
/srv/main/.git/config`) or a submodule's gitdir under the
  superproject's `.git/modules` — resolved from the `.git` FILE at the
  git root (the cwd may be a sub-directory), relative `gitdir:` values
  included, plus git's own `commondir` file inside the gitdir (a
  relocated admin dir has no `worktrees`-named parent). The `.git` file
  is parsed with a deliberately over-accepting grammar (git accepts
  only a same-line target; redaction must never under-accept a form
  git might parse), and both reads are head-bounded — the files are
  workspace-controlled content on the
  daemon's shared error path. The build-time system gitconfig
  (`<prefix>/etc/gitconfig`, Homebrew/source-build locations) redacts
  per whitespace-delimited TOKEN — an unbounded `\S*` prefix arm would
  cost O(L²) of synchronous event-loop CPU on one long whitespace-free
  run (a rejected push's sideband data bypasses git's `vreportf` cap),
  before the 512-char slice ever applies. And because git's
  config-error family is an OPEN set of rendered shapes (`bad
  numeric/boolean/date config value … in file %s`, per-version wording
  drift), enumeration has no last corner: the `in file` arm keys on
  the family's shared phrase and redacts to END OF LINE (a
  space-bearing include target keeps no tail), and a final fail-closed
  sweep removes ANY surviving absolute-path token in any other
  sentence — its whitespace-token boundary is the documented limit a
  shape arm owns, never the sweep. A transport
  URL survives both: its slashes follow the scheme's `:` or a word
  character, never the sweep's prefix class. On top of that, the config
  read's own failure path strips its stdout before the error leaves core:
  a killed `git config --list --show-scope -z` can carry a partial dump of
  EVERY scope's records (global/system URLs, credential helpers,
  identities), and only git's stderr diagnostics belong in the
  client-visible message.
- Removal is verified: after `git remote remove`, the repository-scope
  listing is re-read and a surviving section throws, AND the name's
  resolution across ALL scopes is checked — a same-name inherited
  (`global`/`system`/`unknown`/`command`) survivor keeps receiving pushes after what would
  otherwise look like a successful removal, so that shape throws
  `remote_still_configured` too. BOTH sides refuse the same collision up
  front (`remote_shadows_inherited` — removal refuses whenever a
  repository-scope half exists to destroy; git's duplicate check cannot
  see the inherited section and git's rm would exit 0 over the destroyed
  local half), and the post-removal verification stays as the backstop
  for a survivor racing in after the pre-flight. A survivor held only at worktree
  scope is completed there (`git config --worktree --remove-section`),
  because `git remote remove` cannot edit `config.worktree` and would
  otherwise leave a listed row permanently un-removable after destroying
  its refs. The removal predicate's only floors are non-emptiness, the
  NUL byte (execFile refuses a NUL-bearing argv entry, which would
  otherwise surface as an unclassified 500), and no `/` (a slashed name's
  tracking namespace collides with the prefix remote's); every other
  config-held name
  stays removable and the `--` terminator guards the exec vector.

## Open questions

None blocking. Assumption to sanity-check at review: two-click inline
confirm (vs. a modal) for remove — chosen because a Radix Dialog nested in a
portaled Popover fights the dismiss layer; the pattern matches the popover's
existing inline confirm for discard-and-update.
