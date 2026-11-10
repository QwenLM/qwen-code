# Attribute `gh pr create` in the directory the command actually runs in

[English](2026-11-09-gh-pr-create-directory-attribution.md) | [简体中文](2026-11-09-gh-pr-create-directory-attribution.zh-CN.md)

Date: 2026-11-09
Status: Implemented (local verification complete; not yet merged)

## Problem

A session that creates a PR from inside a worktree does not get the PR bound
automatically. Two live daemon sessions reproduced it on 2026-11-09:

| Session                               | Create command                                                                         | Launch directory      | PR created |
| ------------------------------------- | -------------------------------------------------------------------------------------- | --------------------- | ---------- |
| `d0911852` (workspace `qwen-code-x4`) | `cd <root>/.qwen/worktrees/fix-16712 && gh pr create …`                                | `<root>`, branch `x4` | #16719     |
| `195215bf` (workspace `qwen-code-x9`) | `cd <root> && … && cd .qwen/worktrees/deflake-boot-retry && gh pr create … \| tail -5` | `<root>`, branch `x9` | #16717     |

Neither passed the shell tool's `directory` parameter. Both PRs were registered
only after the operator asked, 13.6 and 4 minutes after creation.

The backfill path cannot recover either session: the first prompt was an
Actions `?pr=N` link (deliberately not a source), no `/review` or `/verify-pr`
command was ever typed, and the worktrees were created with a plain
`git worktree add`, so no `<sessionId>.worktree.json` sidecar exists for the
`pr-<N>` convention to read. The `bindGhPrCreate` docstring's claim that
"backfill recovers the rest" is therefore over-broad for the most common
worktree flow.

## Current state

`ShellTool.execute` computes `cwd = this.params.directory || this.config.getTargetDir()`
and uses that one directory for both attribution legs:

- the pre-run snapshot (`fetchCurrentBranchPullRequest`, `fetchCurrentBranchName`,
  `fetchAttributionRepoKeys`), taken before spawn;
- the post-run `bindGhPrCreate` gate, which asks gh again for the branch's PR.

`bindGhPrCreate` documents the choice explicitly: it resolves the _launch_
directory, "not a repo the command may have `cd`'d into". When the launch
directory's branch has no PR, gh answers `no pull requests found`, the snapshot
is `{status: 'none'}`, and the gate declines at its post-run resolution arm.

Every decline is written to `debugLogger.debug` only. The daemon's default log
level hides it, so the operator sees a successful create and no badge, with no
indication that anything was skipped.

## Goals

1. Bind the PR when the command's own `cd` chain statically determines the
   directory the create runs in.
2. Make the remaining unattributable shapes visible to the model instead of
   silent.
3. Leave every existing attribution gate unchanged.

## Scope boundaries (not doing)

- **No new attribution authority.** gh remains the only authority. The five
  gates stay: pre-run snapshot not `error`, resolved number different from the
  pre-run number, repo identity within the pre-run resolved/parent keys, head
  branch equal to the pre-run branch, and the resolved URL present in the
  command output.
- **No dynamic tracking.** The resolver never runs the command, never asks the
  shell where it ended up, and never guesses an expansion's value.
- **No modelling of ambient shell state.** A `CDPATH` assigned inside the
  command makes relative targets `opaque`, but a `CDPATH` inherited from the
  environment is not inspected — the walk models the command, not the
  environment it runs in. The same boundary already applies to `$HOME` and
  every other expansion.
- **No change to the execution gate.** `commandRunsGhPrCreate` keeps its closed
  grammar; the resolver reuses it verbatim to recognise the create node.
- **No change to background or promoted runs.** They still settle through the
  background registry and are not bound live.
- **No backfill extension.** Teaching backfill about plain `git worktree add`
  cannot work: the PR number does not exist yet when the worktree is created.

## Proposed solution

### Effective-directory resolver

A new module-level helper in `packages/core/src/tools/shell.ts`:

```ts
type GhPrCreateDirectory =
  | { kind: 'launch' }
  | { kind: 'resolved'; directory: string }
  | { kind: 'opaque' };

async function resolveGhPrCreateDirectory(
  command: string,
  launchDir: string,
): Promise<GhPrCreateDirectory>;
```

It parses the command with the existing `parseShellCommand` (web-tree-sitter +
tree-sitter-bash, already imported by `shell.ts` for the read-only classifier)
and walks the tree in execution order, threading a directory and stopping at
the first create node.

Node handling:

| Node                                                                                                      | Handling                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `program` / `list`, separator `&&`                                                                        | Carry the directory left to right. `&&` is the only separator that proves the preceding statement succeeded, so it is the only one across which a `cd` may be carried.                                                                                                                                                                                                                              |
| `program` / `list`, separator `;`, newline, `&` or `\|\|`                                                 | `opaque` once the left has moved the directory. The next statement runs regardless of the previous one's success (or, for `\|\|`, only on its failure), so a skipped (`false && cd w`), failed (`cd /missing`) or backgrounded (`cd w &`) `cd` never moved us. A create already found in the left is unaffected, and a left that never moved costs nothing.                                         |
| `pipeline`                                                                                                | Visit every element with the same incoming directory; the directory after the pipeline is the incoming one (bash runs pipeline elements in subshells, so a `cd` inside does not leak).                                                                                                                                                                                                              |
| `redirected_statement`                                                                                    | Walk the body, ignoring `*_redirect` children.                                                                                                                                                                                                                                                                                                                                                      |
| `command` recognised by `commandRunsGhPrCreate(createCandidateText(node))`                                | Record the current directory and stop. The gate runs over text rebuilt from the AST's own tokens, with any argument carrying a separator or expansion replaced by a placeholder, so a quoted mention such as `printf 'example; gh pr create'` cannot forge a create. A cwd-shifting wrapper flag (`env -C/--chdir`, `sudo -D/--chdir`, via the existing `isShiftCwdFlag` tables) makes it `opaque`. |
| `command` named `cd` / `pushd`                                                                            | Resolve a literal target against the current directory; otherwise `opaque`. A `pushd +N` / `-N` stack rotation is `opaque`, not a path named `+1`. When the command assigns `CDPATH` anywhere, a relative target is `opaque` (CDPATH reroutes it) while an absolute one still resolves.                                                                                                             |
| `command` named `popd`, `eval`, `source`, `.`                                                             | `opaque` — `popd` rotates a stack that is not modelled; the other three run code in the current shell that can move it without naming a target in the command text. Executing a script (`./move.sh`) is not in this set: it runs in a child and cannot move us.                                                                                                                                     |
| any other command                                                                                         | Directory unchanged.                                                                                                                                                                                                                                                                                                                                                                                |
| any other node (`subshell`, `compound_statement`, `if_statement`, loops, `case`, function definitions, …) | `opaque` if the subtree contains a `cd`/`pushd`/`popd`/`eval`/`source`/`.` command, otherwise directory unchanged. A subshell's `cd` must not leak into the enclosing scope.                                                                                                                                                                                                                        |

A `cd` target is literal only when it is a plain word, a single-quoted
`raw_string` (wholly literal in bash, so the body is the path with the quotes
removed), or a double-quoted `string` whose body is plain content — with no
expansion, no command substitution, no leading `~`, no `$`, no backtick, no
backslash, no glob or brace character, and not `-` (previous directory) or
absent (`cd` alone goes to `$HOME`). Flags before the target are skipped.
Resolution is `path.resolve(currentDirectory, target)`, which is
platform-native: the tests derive their expectations the same way rather than
hard-coding POSIX strings, because the Windows workspace lane runs them.

Parse failure or a root node with `hasError` returns `{kind: 'launch'}` — the
parser proved nothing, so behaviour is exactly today's and no notice is emitted.

### Wiring

The pre-run block already runs only when the execution gate matches and the
session is not sandboxed. It resolves the directory first, then takes all three
snapshots in the resolved directory:

```ts
const ghPrCreateDirectory = await resolveGhPrCreateDirectory(
  commandToExecute,
  cwd,
);
const attributionDir =
  ghPrCreateDirectory.kind === 'resolved' ? ghPrCreateDirectory.directory : cwd;
```

`attributionDir` replaces `cwd` in the three pre-run fetches and in the
`bindGhPrCreate` call. Both legs therefore ask gh about the same directory,
which is what the pre-run/post-run comparison already assumes.

A directory that does not exist YET is a special case, not a no-op:
`findGitRoot` walks UP from a non-existent path and finds the enclosing launch
repository, so the pre-run snapshot would record the launch branch while the
post-run leg queries the newly created worktree's branch. That is why a
`git worktree add` in the same command is treated as directory-affecting and
fails closed (see the round-4/round-7 records) rather than relying on
`findGitRoot` returning null.

### Visible fallback notice

When the resolver returns `opaque`, the tool result appends a model-facing
notice through the existing `appendedMetadata` → `notices` channel (the same
channel as `attributionWarning` and the long-run hint):

> PR auto-binding fell back to the launch directory: this command's directory
> change is not statically resolvable. Set the shell tool's `directory`
> parameter to the repository you create the PR in, or register the PR on the
> session after creating it.

The notice accompanies only a FOREGROUND run that settled with exit code 0 —
an uninterrupted one, or one whose promote was refused after the child had
already exited — which are exactly the runs the binding gate sees. A failed or
cancelled create produced no PR to register, so nothing is told: the condition
is `kind === 'opaque' && (!result.aborted || wasPromoteRefused) && exitCode === 0`.
The resolver outcome is computed before spawn, so the notice never depends on
the fire-and-forget binding hook completing, but that settled-success condition
applies in every case, not merely for `opaque`. `launch` and `resolved` emit
nothing.

## Design decisions and rationale

- **AST, not a second textual walk.** `gitCommitContext` already walks segments
  textually, but its `cdTargetMayChangeRepo` heuristic answers the opposite
  question ("could this have left the repo?") and conservatively gives up on
  absolute paths and `~`. Reusing it would reject the motivating case. The AST
  distinguishes a subshell from a quoted parenthesis in a PR title, and an
  expansion from a literal path, without new quoting heuristics. Both incident
  commands contain `fix(managed-agent)` / `test(web-shell)` titles and a `>`
  redirect; a textual paren/operator scan would bail on them.
- **Stop at the first create.** The gate binds one PR — the branch's. A `cd`
  after the create, or a `|| gh pr view` retry tail, cannot change the answer.
- **`opaque` falls back rather than declines.** Falling back to the launch
  directory preserves today's behaviour for every shape the resolver cannot
  prove, so the change can only add bindings, never remove one.
- **No new bundle edge.** The helper lives in `shell.ts`, which already imports
  `shellAstParser.js`. Putting it in `utils/github-prs.ts` or
  `services/session-pr-service.ts` would pull the WASM parser into the serve
  bundle closure — the reason `session-pr-service.ts` keeps its own textual
  gate today.

## Constraints

- The resolver runs only for non-sandboxed commands that pass the execution
  gate, so its cost (one parse on an already-initialised singleton parser) is
  paid only on `gh pr create` runs.
- Recognition of the create node must stay identical to the execution gate;
  the resolver calls `commandRunsGhPrCreate` rather than restating its grammar.
- The notice must be budgeted with the other model-facing notices
  (`appendedMetadataChars`), like the existing hint and warning.

## Risks

- **Mis-resolution binds the wrong directory's PR.** The five gates still
  apply, and both legs use the same resolved directory, so a wrong resolution
  fails the output-URL or pre-run-number gate exactly as a wrong `directory`
  parameter does today. The trust model is unchanged.
- **`||` and subshell shapes lose a binding they could have had.** They fall
  back to today's behaviour and now emit a notice; no regression.
- **Parser unavailable.** `parseShellCommand` rejects when WASM init has
  permanently failed; the resolver catches and returns `launch`.

## Validation plan

1. Unit tests in the existing `gh pr create binding` block (real AST, mocked gh
   legs), asserting the directory both legs receive: single and chained literal
   `cd`, relative `cd`, a pipe after the create, a redirect in an earlier
   segment, quoted titles containing parentheses, `cd` after the create, and
   the `directory` parameter combined with an internal `cd`.
2. Negative tests asserting fallback to the launch directory plus the notice:
   `cd $VAR`, `cd ~/x`, bare `cd`, `cd -`, `popd`, `(cd /other) && …`,
   `cd /a || …`, `env -C /other gh pr create`, and a control-flow body.
3. A no-`cd` control asserting no notice is emitted.
4. Real-filesystem A/B: a real repository with a real linked worktree, a
   PATH-stubbed `gh` that answers `pr view` per directory, and the real
   `findGitRoot` / `fetchCurrentBranchPullRequest` chain. Before the change the
   internal-`cd` create binds nothing; after it, the worktree's PR binds.
5. Mutation witness: removing the directory threading, and removing the notice,
   each turn a named test red.
6. `npm run build && npm run typecheck`, the touched test files, lint and
   Prettier on the changed files.

### Verified results (2026-11-09, local, final tree)

- `npm run build && npm run typecheck`: **exit 0**, re-run after the last
  source change, with `dist/src/tools/shell.js` confirmed newer than the source
  and containing the resolver and every guard, so the build evidence is about
  the final tree.
- ESLint on the three changed TypeScript files: **clean**. Prettier applied to
  all five changed files.
- `src/tools/shell.test.ts` + `src/tools/shell.pr-binding-directory.test.ts`
  together: **429 passed** — 422 in the existing file (22 pre-existing binding
  tests plus 43 new directory-resolution tests) and 7 real-filesystem tests.
- The real-filesystem suite runs against a real `git init` repository, a real
  `git worktree add` linked worktree, and a real `gh` subprocess stub that
  reports a PR for a branch only after `pr create` ran in it. No attribution
  helper is mocked. It is guarded with
  `describe.skipIf(process.platform === 'win32')`, matching the existing
  executable-entry guard in `autofix-pr.test.ts`, because the Windows workspace
  lane runs `test:ci:workspaces` and the stub is a bash script.
- **Adversarial probe.** A temporary mock-free harness drove 38 hostile command
  shapes through the real tool against a real repository plus a real linked
  worktree, with a `gh` stub logging the cwd and argv of every call. Only the
  attribution calls (`pr view` / `repo view`) reveal the resolved directory —
  the command's own `pr create` runs wherever the shell cd'd and proves
  nothing. The worktree is essential to the oracle: `findGitRoot` collapses a
  plain subdirectory to the repo root, so a same-repo `cd` is indistinguishable
  in the log. The probe found the two silent-miss defects below; after the
  fixes all 38 shapes landed in the intended bucket — 12 resolved to the
  worktree, 17 fell back with a notice, and 9 stayed on the launch repo without
  one (6 because nothing moved, 3 because the create itself failed and the
  notice is suppressed on a non-zero exit by design). The harness was deleted
  before commit; its findings live on as the eight permanent cases they
  motivated.
- Mutation A — drop the `attributionDir` assignment, keep the resolver call:
  **13 failed / 398 passed**. The reds are the two real-filesystem binding
  tests and every unit test that asserts a resolved directory; the
  `directory`-param and notice controls survive, so the reds pin the threading
  rather than a broken fixture.
- Mutation B — force the notice to `null`: **19 failed / 392 passed**. The reds
  are exactly the eighteen unit fallback shapes plus the real-filesystem
  notice test; every directory-resolution test stays green. A and B kill
  disjoint sets.
- Mutation C — drop only the `pushd` stack-rotation guard: the named
  `pushd stack rotation` case goes red on the directory assertion.
- Mutation D — drop only the `current !== dir` condition on the `||` arm: the
  named `|| branch whose left never moves` case goes red on the notice
  assertion.
- Mutation E — drop `eval`/`source`/`.` from the opaque arm: **3 failed / 30
  passed** in the resolution block. The `function body that evals` case
  survives, because the subtree scan catches it independently — the two
  mechanisms are separately load-bearing.
- Mutation F — drop only the CDPATH guard: **2 failed / 31 passed**, exactly
  the two CDPATH shapes; the absolute-target control survives.
- Every mutation was reverted from a byte-level backup; the restored
  `shell.ts` matched its pre-mutation SHA-256
  (`4d9cbf2b389b69f1567254f6080e1d784fdfd75eccb8d2f7b361759bce9ce676`).
- Seven defects were found and fixed during implementation, self-audit and the
  adversarial probe: `cd -` resolving as a literal path named `-`; an outer
  `||` marking the whole chain opaque before the walk reached a create in its
  left subtree; the resolver never calling `tree.delete()`, leaking WASM memory
  in a long-lived daemon; `pushd +N` resolving as a path named `+1`; the `||`
  arm emitting a notice for `false || gh pr create`, a directory change that
  never happened; `eval`/`source`/`.` moving the directory invisibly so the
  create ran in the worktree while attribution stayed on the launch repo with
  no notice; and `CDPATH` rerouting a relative `cd` while the walk treated it
  as provable. The last two were found only by the adversarial probe — reading
  the diff had already passed clean twice.

### Review round 2 (2026-11-09, independent Codex review of `e12e88be94`)

The review reported one binding regression, two resolver gaps and one test
portability problem. All four were reproduced against the head before fixing:
the separator and quoting facts were confirmed by dumping the tree-sitter AST,
and the Windows claim by evaluating `path.win32.resolve` (which yields
`\test\dir\nested`, not the POSIX literal the tests asserted).

1. **Regression — an unexecuted directory change was carried forward.** The
   fold treated every separator as guaranteed-sequential, so
   `false && cd w; gh pr create`, `cd /missing; gh pr create` and
   `cd w & wait; gh pr create` all attributed in `w` while the create ran in
   the launch repository. The parent commit bound these; the head did not, and
   emitted no notice. Fixed by carrying a directory only across `&&`, the one
   separator that proves the preceding statement succeeded. `;`, newline, `&`
   and `||` now fall back once the left has moved. This also supersedes the
   earlier `||`-specific rule, which was a special case of the same principle.
2. **Gap — single-quoted targets were rejected.** tree-sitter spells them
   `raw_string`, not `string`, so the ordinary single-quoted spelling of the
   very command this design fixes stayed unbound while the double-quoted one
   worked. `raw_string` is now accepted with its quotes removed; single quotes
   are wholly literal in bash, so no expansion check is needed inside them.
3. **Gap — a quoted argument could forge a create.** The execution gate splits
   on separators without tracking quotes, so `printf 'example; gh pr create'`
   produced a segment starting `gh pr create`; the walk stopped there at the
   launch directory and never reached the real create. The gate now runs over
   text rebuilt from the AST's own tokens, with any argument carrying a
   separator or expansion replaced by a placeholder. The gate's grammar stays
   authoritative; only its input is sanitised.
4. **Portability — resolved-directory expectations were POSIX literals.** The
   resolver joins with the platform-native `path.resolve`, and the Windows
   workspace lane runs this suite (only the separate real-filesystem suite is
   skipped). Expectations for resolved directories are now derived with
   `path.resolve`; expectations for the launch directory stay literal, because
   that value is passed through untouched.

Round-2 verification: **429 passed** (422 in the existing file, including 43
directory-resolution tests, plus 7 real-filesystem tests), core typecheck
exit 0, ESLint and Prettier clean. Four new mutation witnesses, each reverted
from a byte-level backup with the checksum verified
(`68bf56c06236ce5e5826e6316e5bc0d3e79a13d032aba61ae2ef693452acacc0`):

| Mutation                                 | Result                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| G — restore the unconditional fold       | 7 failed / 420 passed: the five new separator shapes, the pre-existing `\|\|` case, and the new real-filesystem skipped-`cd` regression |
| H — drop `raw_string` handling           | 4 failed / 423 passed: both single-quote unit cases and both real-filesystem cases that quote the worktree path                         |
| I — feed the gate the node's raw text    | 2 failed / 425 passed: exactly the quoted-argument unit and real-filesystem cases                                                       |
| J — pass assignments through unsanitised | the named quoted-assignment case goes red on the directory assertion                                                                    |

The real-filesystem suite gained three cases: a single-quoted worktree path
containing a space, a quoted argument that merely mentions `gh pr create`, and
a skipped `cd` that must still bind the launch branch's PR while leaving the
worktree's marker unwritten.

Auditing the round-2 diff found a twelfth defect in the fix for the third
finding: sanitising arguments but passing `variable_assignment` nodes through
raw left the same forgery open through an assignment's own quoted value
(`X='; gh pr create' printf hi`). Assignments are now sanitised by the same
rule, with two cases pinning both directions — the forgery is rejected, and an
ordinary inline credential (`GH_TOKEN=abc gh pr create`) still resolves and
still reaches the verification legs. Writing that control also caught a mistake
in the test itself: with an inline credential the env argument is an overlay,
not the `undefined` the shared helper asserts.

Twelve defects have now been found and fixed across implementation, self-audit,
the adversarial probe and this review. The regression is the notable one: it
was introduced by this design's own first implementation, survived two clean
diff-reading passes and a 38-shape probe, and was caught only by a reviewer
comparing binding outcomes against the parent commit. The probe's shapes all
used `&&`, so none of them exercised a non-guaranteed separator.

### Review round 3 (2026-11-09, re-review of `062a15ada7d`)

The re-review confirmed two round-2 findings fully fixed (single-quoted paths,
quoted-argument and assignment forgery) and reported four remaining P2 issues —
**two of them regressions introduced by the round-2 follow-up itself**. All four
were reproduced against the head before fixing, three by AST dump and one by
`path.win32` simulation.

1. **Regression — an OR-list's success was taken as proof its `cd` ran.**
   `true || cd w && gh pr create` parses as `list(list(true || cd w) && create)`.
   The round-2 rule only asked whether the _left_ of `||` had moved, so the
   skipped right-hand `cd` was visited and its directory returned to the outer
   `&&`. Bash succeeds through `true` and never runs the `cd`. `||` is now
   ambiguous in **both** directions: either side being able to move the
   directory makes the outcome unprovable.
2. **Regression — sanitising an expanded credential destroyed the assignment.**
   Replacing a whole `variable_assignment` with a bare token turned
   `GH_TOKEN=$TOK gh pr create` into `X gh pr create`, which the gate no longer
   recognises, so a binding the unsanitised text used to make was lost. Only the
   _value_ is now replaced; the assignment shape survives as `NAME=X`, which
   still satisfies the gate's leading-assignment grammar and still cannot carry
   a forged separator.
3. **Regression — a comment consumed the pending separator.** tree-sitter keeps
   a comment as a _named_ child between `&&` and the following command, so
   `cd w && # note` + newline + `gh pr create` visited the comment as a
   statement and cleared the operator, making a proven chain look unprovable.
   Comment nodes are now skipped without consuming the pending separator.
4. **Incomplete fix — the same-directory comparison was still spelling-sensitive.**
   `cd /test/dir` from a launch dir of `/test/dir` is a no-op, but `path.resolve`
   spells it with platform separators, so the raw `found === launchDir` test
   reported `resolved` on Windows. The comparison now normalises both sides,
   which fixes the semantics rather than adjusting the expectation.

Round-3 verification: **434 passed** (425 in the existing file, including 46
directory-resolution tests, plus 9 real-filesystem tests), core typecheck exit 0,
ESLint and Prettier clean. Mutation witnesses K (drop the OR-list right-branch
check), L (revert to a bare assignment token) and M (drop the comment skip) each
kill exactly their own two cases — unit and real-filesystem — with 432 still
passing. Finding 4 has **no Linux-observable mutation**: `path.resolve` is
identity there, so it was verified by `path.win32` simulation instead (raw
comparison reports `resolved`, normalised reports `launch`), and is not claimed
as mutation-witnessed.

The real-filesystem suite gained two cases: an OR-list-skipped worktree that must
still bind the launch branch's PR with the worktree marker unwritten, and a
comment-interleaved AND chain that must bind the worktree's PR.

**CI gate freshness.** `Lint & Static` failed `Check lint gate freshness` on this
head. The script's own remedy is to merge or rebase the base, and the incoming
main carries `#16706 fix(ci): stop staling branches for eslint ignores they never
excluded` — a fix to that very gate. This is a stale-gate signal, not a defect in
this change, and is addressed by merging current main rather than editing code.

Fifteen defects have now been found and fixed. Three of them were introduced by
this design's own follow-up fixes, which is the pattern worth recording: each
round-2 fix narrowed one hole and opened an adjacent one, and only a reviewer
re-running binding outcomes against both the parent and the previous head caught
them. The design's own probe and diff reading did not.

### Review round 4 (2026-11-09, re-review of `96d41924410`)

The re-review confirmed round 3's fixes and reported two Critical regressions,
one Suggestion on the notice wording, and several test-efficacy gaps. All were
reproduced against the head before fixing.

1. **R1-1 (Critical) — the walk still proved directories the shell never
   entered.** `pushd -n DIR` pushes without moving; a same-named function
   (`cd() { :; }`, `gh() { … }`) shadows the builtin; `command`/`builtin`/`time`
   prefixes hide which command actually runs; `bash -c "…"` is a separate
   shell; `shopt -s lastpipe` lets a pipeline's last element move the current
   shell; `trap … DEBUG` can move between any two commands; and
   `git worktree add … && cd <new> && gh pr create` snapshots a path that does
   not exist yet. Each now returns `opaque` (launch attribution + visible
   notice) instead of silently resolving a wrong directory. Function shadowing
   is registered in execution order and scoped to the current shell, so a
   definition after the create or inside a subshell/pipeline does not poison an
   earlier `cd`.
2. **R1-2 (Critical) — a resolved directory replaced the launch directory for
   both legs with no fallback.** When the derived directory has no git repo
   (`findGitRoot` returns null) or the command names a DIFFERENT repository
   (`--repo` / `GH_REPO`), both legs now re-point at the launch directory and
   re-snapshot there — what the parent commit always did. An errored gh answer
   inside a REAL repo still fails closed (no re-point). The explicit repo is
   read from the create AST node (quote-aware) and from `ghPrCreateInlineEnv`;
   `--repo` overrides `GH_REPO`; `GITHUB_REPOSITORY` is an Actions context
   variable, not a gh repo override, and is ignored. Fork parent keys count as
   the same attribution family.
3. **R1-4 (Suggestion) — notice wording.** The notice section and acceptance
   criterion 2 now state the notice fires only on a settled, successful
   foreground run (exit 0, not aborted, or promote-refused after the child
   exited). A failed or cancelled create emits nothing.
4. **R1-5 (Suggestion) — negative assertion had no happens-before edge.** The
   real-filesystem expansion-fallback case now waits for both pre-run and
   post-run `pr view` legs to be logged (`waitForAttributionLegs`) before
   asserting nothing bound, so it cannot pass merely because the write has not
   landed yet.
5. **R1-6 (Suggestion) — promote-refused notice disjunct unpinned.** Added a
   test asserting the notice fires for an opaque create that is promote-refused
   after settling, and a control asserting no notice for a non-opaque
   promote-refused create.
6. **R1-7 (Suggestion) — pipeline non-leak unpinned.** Added a test asserting
   `cd /test/dir/nested | cat && gh pr create` attributes in the launch
   directory with no notice.
7. **R1-8 (Suggestion) — git fixture signing.** The real-git fixture sets
   `commit.gpgsign = false` repo-locally and adds a regression with a hostile
   `~/.gitconfig` enabling signing, so a developer's global config cannot fail
   every fixture commit.
8. **R2-1 (Suggestion) — raw string compare at separator arms.** The `||` and
   non-`&&` arms now compare `path.resolve(current) !== path.resolve(dir)`, so a
   `directory` param with a trailing slash no longer invents a move and emits a
   spurious notice.

Self-audit during this round found and fixed four additional defects introduced
by the fixes themselves: global function pre-scanning poisoned creates before
the definition and leaked subshell/pipeline scope; whole-command `--repo` regex
matched PR-body text and quoted values incorrectly; `--repo`/`GH_REPO`
precedence was inverted; and `GITHUB_REPOSITORY` was wrongly treated as a repo
override. Each is pinned by a dedicated test.

Round-4 verification: **469 passed** (458 in the existing file, including 74
directory-resolution tests, plus 11 real-filesystem tests), core typecheck
exit 0, ESLint and Prettier clean. Mutation witnesses N–X each kill their named
cases with controls surviving:

| Mutation                                                | Result                                                 |
| ------------------------------------------------------- | ------------------------------------------------------ |
| N — drop separator normalisation                        | trailing-slash case reds                               |
| O — disable wrapper fail-closed                         | 4 wrapper cases red, 2 unrelated-prefix controls green |
| P — disable nested-shell guard                          | nested-shell case red, `sh -c 'echo ok'` control green |
| Q — drop lastpipe check                                 | lastpipe case red, ordinary pipeline control green     |
| R — disable worktree-add guard                          | unit + real-filesystem cases red                       |
| S — disable trap guard                                  | DEBUG-trap case red                                    |
| T — restore global function pre-scan                    | 3 scope/order controls red, direct-shadow case green   |
| U — revert to text repo matching                        | 5 repo cases red, equals-form + parent controls green  |
| V — relax error re-point                                | fail-closed case red, non-repo fallback green          |
| W — drop fork parent key                                | parent-repo case red                                   |
| X — disable current-shell subtree function registration | compound-shadow case red, subshell controls green      |

Every mutation was restored from a byte-level backup; the final `shell.ts`
SHA-256 matches the pre-mutation freeze (`5d00698edc5738c1f5880a12104c3936d91f0b92ec7b0a097a22bd5a9cf59dfc`).

### Review round 5 (2026-11-09, re-review of `29d8b326b9`)

The re-review confirmed the round-4 fixes and reported two new P2 binding
regressions plus one remaining R1-1 witness. All three reproduced against the
head with a real linked worktree before fixing.

1. **Host-qualified `--repo` treated as a different repository.** The derived
   key was reduced to bare `o/r` while the explicit value kept its host
   (`github.com/o/r`), so `cd <worktree-of-o/r> && gh pr create --repo
github.com/o/r` re-pointed both legs to launch and bound nothing. Both sides
   are now canonicalised to `host/owner/repo` (a host-less explicit value
   defaults to the derived host) before comparing.
2. **Quoted equals-form `--repo='o/r'` kept its quotes.** tree-sitter spells it
   as a `concatenation` of the `--repo=` word and a quoted value; the raw slice
   stored `'o/r'` (with quotes) and the identity compare treated it as another
   repo. A new `literalShellValue` decoder resolves word / raw_string / string /
   concatenation to the string Bash passes, for both the separated and equals
   forms.
3. **R1-1 remaining witness — a quoted executable forging a create.**
   `'gh; gh pr create' 2>/dev/null; cd <worktree> && gh pr create` stopped the
   walk at launch because `createCandidateText` copied the `command_name`
   verbatim and the quote-blind gate found `gh pr create` inside it. The
   command name is now sanitised like an argument (backslash/slash stay legal so
   path-qualified gh still matches).

Round-5 verification: **475 passed** (462 unit + 13 real-filesystem), core
typecheck exit 0, ESLint and Prettier clean. Mutation witnesses Y (command-name
sanitisation), Z (equals-form decoding) and AA (host canonicalisation) each red
their named cases with the bare/quoted controls green; every mutation restored
from a byte-level backup (final `shell.ts` SHA-256
`352239efcf047ac37f931da6edd23154cff7e940f1e42fc704639a88a9688b22`).

### Review round 6 (2026-11-09, re-review of `27989984d5`)

The re-review confirmed all three round-5 witnesses now pass and reported two
remaining binding defects. Both reproduced against the head before fixing.

1. **Repository-name case (P2).** `repoKeyFromWebUrl` lowercases every derived
   key, but the explicit `--repo` value kept its case, so `--repo O/R` (or
   `--repo github.com/O/R`) compared unequal to a worktree of `o/r` and
   re-pointed to launch, losing the created PR. GitHub repository identity is
   case-insensitive; `canonicalRepo` now lowercases both sides.
2. **R1-1 remaining witness — a quoted directory-changing command.**
   `"cd" <worktree> && gh pr create` created on the worktree branch while both
   legs queried launch: `commandNodeProgram` read the raw quoted name, so the
   directory-changing check did not recognise the literal builtin. It now
   strips one layer of matching surrounding quotes before the basename, so
   `"cd"`/`'cd'` resolve like `cd`.

Round-6 verification: **479 passed** (465 unit + 14 real-filesystem), core
typecheck exit 0, ESLint and Prettier clean. Mutation witnesses AB (drop the
case normalisation) and AC (drop the quote stripping) each red their named cases
with the lower-case / unquoted controls green; every mutation restored from a
byte-level backup (final `shell.ts` SHA-256
`1a1a4c45458f056eccb47813901632ee9e8e987154c20e62f27b19a0dd3e1b41`).

### Review round 7 (2026-11-09, re-review of `525f144933`)

The re-review confirmed the round-6 fixes and reported one new P2 (maintainer)
plus a bot batch of 5 Critical + 4 Suggestion. The recurring root cause is that
the walk must distinguish what the _executing shell_ actually does from a
look-alike spelling. Fixed by root cause, not by enumerating spellings:

1. **Builtin vs external program (P2 + R1-1, Critical).** A path-qualified
   program named `cd`/`pushd`/`popd`/`eval`/`source`/`.` (`/usr/bin/cd`, `./cd`,
   `bin/cd`, `"/usr/bin/cd"`) is an external executable running in a child; it
   cannot move this shell. `commandNodeProgram` was split into
   `commandNodeProgramName` (quote-stripped) + basename, and a new
   `commandIsBuiltinDirectoryChanger` grants cwd semantics only to unqualified
   builtins; a path-qualified directory command is `opaque`. This applies both
   in the command arm and in `subtreeMayChangeDirectory`.
2. **Short `-R` repo flag (R3-1, Critical).** The explicit-repo scan now reads
   `-R o/r`, `-R=o/r` and attached `-Ro/r` like `--repo`, agreeing with
   `GH_GLOBAL_FLAGS_TAKES_VALUE`. An explicit repo flag whose value cannot be
   decoded (`--repo "$R"`) is `opaque` (unprovable), not "absent".
3. **Windows test literals (R3-2 / R3-3, Critical).** The repo-identity stub and
   the `findGitRoot` `.git` mock now key on `path.resolve(...)` so they match the
   drive-qualified paths the resolver/`findGitRoot` produce on the Windows lane.
4. **Worktree guard bypasses (R3-4, Critical).** `commandCreatesWorktree` decodes
   quoted subcommands (`git "worktree" add`, `git worktree 'add'`) and is also
   consulted by `subtreeMayChangeDirectory`, so brace/if/subshell-wrapped
   worktree creation fails closed like the plain spelling.
5. **Path-qualified create pin (R3-5, Suggestion).** Added a case asserting
   `/usr/bin/gh pr create` still resolves, pinning the sanitiser's `/`/`\` keep.
6. **Polling helpers (R3-6, Suggestion).** `waitForAttributionLegs` /
   `waitForSidecar` now throw on deadline (no silent/vacuous return) at a 10s
   poll, and the suite sets `testTimeout: 30_000` so the budget sits above the
   poll on every lane.
7. **`unset -f` (R3-7, Suggestion).** An `unset_command` arm lifts the shadow for
   literal `unset -f NAME`; an expanded name stays `opaque`.
8. **False fallback notice (R3-8, Suggestion).** A subshell / command
   substitution / process substitution runs in a child, so its `cd` provably
   cannot leak: the directory is unchanged and no notice is emitted (a worktree
   created inside it still fails closed). The earlier "subshell cd → opaque"
   behaviour and its test were superseded.

Round-7 verification: **495 passed** (481 unit + 14 real-filesystem), core
typecheck exit 0, ESLint and Prettier clean. Mutation witnesses AD (path-qualified
guard), AE (`-R` read), AF (worktree subtree detection), AG (`unset` lift) and
AH (subshell transparency) each red their named cases with controls green; every
mutation restored from a byte-level backup (final `shell.ts` SHA-256
`f5caee1084e7a17af43a43ce61e5b34918cf44128f1a0cabf1cfcde72327f8e0`).

The bot also recorded a deferred list under its convergence posture (not
requested this round). The factually-wrong `findGitRoot` returns-null premise
above is corrected here; the remaining deferred entries (e.g. `git clone` /
`gh repo clone` creating a repo, `expand_aliases`, `cd -L/-P/--` option pins,
`command gh pr create` over-conservatism, empty-string repo spec, and further
doc-wording reconciliations) are acknowledged as recorded limitations rather
than silently dropped, to avoid re-deriving the same sibling cluster each round.

### Review round 8 (2026-11-10, re-review of `c48214a576`)

The re-review confirmed all round-7 fixes (12 retained witnesses pass) and
reported one new P2 in the round-7 `unset -f` handling: the visitor lifted the
function shadow even when the `unset` was skipped (`cd() { :; }; false && unset
-f cd; cd <worktree> && gh pr create`), so the later no-op function call was
treated as the real builtin and both legs queried a directory the create never
ran in.

**Fix (execution-proof, same root cause as round 2).** `visit` now threads a
`guaranteed` flag: a statement behind `&&` / `||` (execution depends on the
previous result, which is not evaluated) or terminated by `&` (background
subshell) is not guaranteed to run in this shell. The `unset_command` arm lifts
a shadow only when `guaranteed`; otherwise the shadow is kept, so a later `cd`
stays conservatively `opaque`. Pipeline elements are never guaranteed (they run
in subshells); redirected statements inherit the flag. Adding a shadow
(function definition) remains unconditional because over-`opaque` is the safe
direction, while removing one is only safe when the `unset` provably executes.

Round-8 verification: **498 passed** (484 unit + 14 real-filesystem), core
typecheck exit 0, ESLint and Prettier clean. Mutation witness AI (drop the
`guaranteed` gate) reds the three skipped/backgrounded-unset cases while the
unconditional-unset control stays green; restored from a byte-level backup
(final `shell.ts` SHA-256
`72bbeac2f0cf7f503171225a42daf224df3b9840a4ec8ef8cb9dd1ca3199a181`).

### Review round 9 (2026-11-10, re-review of `9356d4e281`)

The re-review confirmed the round-8 conditional-unset fix (13 retained witnesses
pass) and reported one remaining P2 in the same unset-success proof:
`guaranteed` establishes execution ORDER, not that the unset SUCCEEDS. Two paths
still cleared the shadow while the no-op function survived — a failed output
redirection (`unset -f cd > <missing-parent>/out`, the redirect fails before
unset runs) and a readonly function (`readonly -f cd; unset -f cd`, the builtin
rejects removal).

**Fix (require provable success, not just execution order).**

- A `redirected_statement` now visits its body with `guaranteed = false`: the
  redirection is set up before the command and can fail, so an `unset -f` under
  it is not guaranteed to run.
- A new `declaration_command` arm tracks functions marked readonly
  (`readonly -f`, `declare -r -f` / `typeset -r -f`) in a `readonlyFunctions`
  set; the `unset_command` arm keeps the shadow when any target is readonly,
  since such a removal cannot succeed. Marking readonly is conservative (it only
  ever keeps a shadow).

Round-9 verification: **501 passed** (487 unit + 14 real-filesystem), core
typecheck exit 0, ESLint and Prettier clean. Mutation witnesses AJ (drop the
readonly check) and AK (forward `guaranteed` through a redirection) each red
their named cases with the other controls green; restored from a byte-level
backup (final `shell.ts` SHA-256
`30e1e6dc8b945c15dd4e5642d0059749c6f1700cfdcf7a6c989e397816fd4ac9`).

### Review round 10 (2026-11-10, re-review of `3702125c45`)

The re-review confirmed the round-9 fixes (16 retained witnesses pass) and
reported three P2s, all in the round-9 readonly/declaration handling:

1. **Clustered declaration options.** `declare -rf cd` / `typeset -fr cd` do not
   produce separate `-r`/`-f` words, so the whole-word match left
   `readonlyFunctions` empty and the unset wrongly lifted the shadow. The arm now
   decodes option CHARACTERS from each flag word, so clustered forms are recognised.
2. **Readonly state leaked out of an ordinary pipeline.** `readonly -f cd | cat`
   marks the function readonly only in the pipeline subshell, but the
   `readonlyFunctions` set survived the scope restoration, forcing launch
   attribution. The pipeline arm now restores `readonlyFunctions` together with
   `shadowed` when leaving a pipeline that does not run in the current shell.
3. **Worktree guard lost for declaration subtrees.** The new declaration arm
   returned without the subtree scan, so `export WT="$(git worktree add …)"` was
   silently resolved (lost notice). The arm now applies the same
   `subtreeMayChangeDirectory` guard the default arm uses.

Round-10 verification: **505 passed** (491 unit + 14 real-filesystem), core
typecheck exit 0, ESLint and Prettier clean. Mutation witnesses AL (clustered-option
decode), AM (pipeline readonly restore) and AN (declaration subtree guard) each red
their named cases with the other controls green; restored from a byte-level backup
(final `shell.ts` SHA-256
`d7116bfb38138eb223721f89c85353b6825a4c018196e7b73850754636e5cb65`).

**CI (base, not this diff).** The Linux build / TUI / native-Windows prerequisite
failures were the document-export renderer exceeding its byte budget
(2,066,342 vs 2,060,000). This PR touches only `packages/core` shell attribution and
docs — no web build input — so the failure is main's, already fixed on main by
`4c84f269d1` (#16774, "lift the export renderer budget to the merged size"); merging
current main brings that fix in. No web-templates change is made in this PR.

### Review round 11 (2026-11-10, re-review of `865e22501f1`)

The re-review confirmed the round-10 fixes (20 retained witnesses pass) and
reported three P2s — two incomplete readonly-state cases and one regression from
the round-10 declaration subtree guard:

1. **Incomplete readonly state.** `readonly -f 'cd'` supplies a quoted
   (`raw_string`) target the declaration arm ignored, and `if true; then readonly
-f cd; fi` sits in control flow the generic arm did not record. A shared
   `readonlyFunctionDeclaration` helper now decodes literal targets
   (variable_name / word / raw_string / string), and the current-shell
   control-flow scan records readonly declarations too (skipping nested child
   contexts). A non-decodable readonly target sets a `readonlyUncertain` flag so
   no shadow is lifted while the state is unestablished.
2. **lastpipe non-final elements.** `lastpipe` runs only the FINAL pipeline
   element in the current shell; the previous code disabled state restoration for
   every element. The pipeline arm now isolates each non-final element's
   function/readonly/shopt state and only lets the final element (under lastpipe)
   affect the current shell.
3. **Declaration subtree guard too broad (regression).** The round-10 guard used
   `subtreeMayChangeDirectory`, which also flagged a harmless child-only cd in
   `export WT_PATH="$(cd … && pwd)"`. A new `subtreeCreatesWorktree` helper flags
   only worktree creation (whose filesystem effect survives the child), so a
   child-only cd no longer forces a fallback.

Round-11 verification: **509 passed** (495 unit + 14 real-filesystem), core
typecheck exit 0, ESLint and Prettier clean. Mutation witnesses AO (control-flow
readonly record), AP (quoted-target decode), AQ (lastpipe per-element isolation)
and AR (worktree-only declaration guard) each red their named cases with the other
controls green; restored from a byte-level backup (final `shell.ts` SHA-256
`7a46b770e0123e48d3de806fc2ce5f1f8fb753a9978f540479f30aa8243f49a8`).

## Acceptance criteria

- Both incident command shapes bind the PR their worktree branch resolves to.
- Every shape the resolver cannot prove behaves exactly as before. When such a
  directory change is involved, a settled, successful foreground run carries a
  notice; a failed or cancelled create emits nothing.
- No existing attribution gate is weakened; all 22 pre-existing binding tests
  still pass.
- The `bindGhPrCreate` docstring and its post-run resolution comment no longer
  claim the launch directory is the only attribution directory, nor that
  backfill recovers an internal-`cd` create. (The 2026-08-20 session-PR binding
  design never made that claim; it is left untouched, and this document is the
  reference for the directory behaviour.)

## Open questions

None.
