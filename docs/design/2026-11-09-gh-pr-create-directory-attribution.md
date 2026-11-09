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

A directory that does not exist needs no special case: `findGitRoot` returns
null there, the snapshot is `{status: 'error'}`, and the existing gate declines.

### Visible fallback notice

When the resolver returns `opaque`, the tool result appends a model-facing
notice through the existing `appendedMetadata` → `notices` channel (the same
channel as `attributionWarning` and the long-run hint):

> PR auto-binding fell back to the launch directory: this command's directory
> change is not statically resolvable. Set the shell tool's `directory`
> parameter to the repository you create the PR in, or register the PR on the
> session after creating it.

The notice is static: it is decided before spawn, so it does not depend on the
fire-and-forget binding hook completing. `launch` and `resolved` emit nothing.

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

## Acceptance criteria

- Both incident command shapes bind the PR their worktree branch resolves to.
- Every shape the resolver cannot prove behaves exactly as before, plus a
  notice when a directory change was involved.
- No existing attribution gate is weakened; all 22 pre-existing binding tests
  still pass.
- The `bindGhPrCreate` docstring and its post-run resolution comment no longer
  claim the launch directory is the only attribution directory, nor that
  backfill recovers an internal-`cd` create. (The 2026-08-20 session-PR binding
  design never made that claim; it is left untouched, and this document is the
  reference for the directory behaviour.)

## Open questions

None.
