# Survey Phase

You are read-only. Produce candidates and file them; change no source file,
create no branch, open no PR. The phase ends at STOP.

All `file:line` citations below were re-verified at `5c56b67182` (2026-08-18).
**Treat every one as a lead whose line number is expected to be wrong** — re-locate by symbol name, and if the surface is
gone, that is a finding about this document, not about the repo.

## 0 — Before searching

1. **Survey fresh code** — run SKILL.md § Rotation's setup block verbatim
   (fetch, then a throwaway worktree at the fixed path
   `${TMPDIR:-/tmp}/find-simplifications-survey/main`), never switching the
   user's checkout, and run every grep below from that worktree: the
   consuming harness spawns a fresh shell per command, so each later call
   re-derives the fixed path and `cd`s into it itself. This phase is
   read-only, and a detached HEAD left sitting in the user's checkout
   belongs to no branch. Fetch only updates the ref, while every grep in
   this phase reads the working tree, so "work against `origin/main`" means
   actually being on it. A local checkout drifts hundreds of commits behind;
   a stale base invents dead surface someone already deleted, and misses
   what landed since. Both guards matter: when the fetch fails,
   `git worktree add` still succeeds against the stale cached ref, and no
   grep below can see the staleness. A failed or interrupted run leaves at
   most one leftover worktree at the fixed path, and the next run's setup
   block removes it first — that is the accumulation guard; an EXIT trap
   cannot serve it across per-command shells.
2. **Read the ledger** (SKILL.md § The ledger). Collect every tombstoned id.
   If the ledger cannot be read, stop per that section — surveying without
   the tombstones can re-propose a permanently declined id.
3. **Pick the slice** and note it — you will report which territory you swept.
4. **Calibrate the search.** Grep a symbol you know exists and confirm a hit.
   A broken search returns zero for everything, which reads exactly like a
   clean repository.

## 1 — What to look for, by yield

Six classes. Anything not on this list needs a consumer argument before you
spend a run on it.

**1. Orphan file or directory.** Nothing imports it; it compiles because
TypeScript compiles what it is given. Cleanest proof there is: one grep of
the basename over the whole corpus. _Instance:
`packages/cli/src/ui/hooks/useTomlMigration.ts` is **0 bytes**, and its only
reference repo-wide is the lint allowlist entry at
`eslint.legacy-filenames.mjs:490`._ Landable.

**2. Dead component with its test and snapshot.** A React component reachable
only from its own test file and `__snapshots__`. The test and snapshot are
part of the deletion, not a reason to keep it. _Instance: `EnumSelector`
resolves to exactly three paths —
`ui/components/shared/EnumSelector.tsx`, its `.test.tsx`, and its
`__snapshots__` entry._ Landable.

**3. Stale rows in an allowlist or registry.** Scaffolding that names files or
symbols that no longer exist. Zero runtime risk, and it shrinks a list every
future contributor reads. _Instance: 7 of the 559 entries in
`eslint.legacy-filenames.mjs` match no file — but see worked example 3 before
you count them._ Landable.

**4. Orphan i18n locale keys.** A key present in
`packages/cli/src/i18n/locales/*.js` (9 locales) with no lookup anywhere. One
cluster per PR, and the cluster must be justified by the commit that removed
its owning feature — cite that SHA. Cap at ~25 keys; a 1,300-line locale diff
gets rubber-stamped or closed, never reviewed. Landable.

**5. Added-then-removed scaffolding.** A flag, constant, route, or helper
whose feature left.
`git log --pickaxe-regex -S '(^|[^A-Za-z0-9_])<symbol>($|[^A-Za-z0-9_])' --format='%ad %h %s' --date=short`
shows the arrival and the departure. Landable **only** outside report-only
territory — a settings key or a `packages/core` symbol in this shape is a
deprecation decision, not cleanup.

**6. An export with no consumer.** In landable territory, when the symbol is
still used inside its own file, the fix is deleting the `export` keyword, not
the symbol. Smaller diff, same surface reduction, no behavior change at all.

## 2 — Classes with nothing in them

Measured at `8fd0162c68`, denominators refreshed at `5c56b67182` — the
"nothing here" verdicts were not re-derived. Do not re-search these every run;
if you doubt one, recompute it and record the corrected measurement in the
run's ledger comment — this phase edits no file, including this one.

| Class                           | Measurement                                                                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unreachable slash commands      | 0 unreachable — all 68 exported `*Command` consts appear in `BuiltinCommandLoader.ts`                                                                                                                                                                                        |
| Settings keys with no read site | ~1 of 317 labeled settings, and it is report-only anyway (worked example 4)                                                                                                                                                                                                  |
| Clientless daemon routes        | none found; routes are reached by path strings, so symbol greps prove nothing here                                                                                                                                                                                           |
| TODO / FIXME markers            | not evidence of anything removable — a marker names a wish, not a dead consumer                                                                                                                                                                                              |
| Duplicate helpers               | real (`escapeRegExp` ×4 and `truncateText` ×5 inside `packages/cli` alone) but **report-only**: consolidating into `core` widens a published surface and trips the cross-package gate, and consolidating inside a package is the "more consistent" edit `/repo-hygiene` bans |
| Unused declared dependencies    | report-only — bundler plugins, postinstall scripts, and peer resolutions consume packages no import grep can see                                                                                                                                                             |

## 3 — Proof protocol

Run in order and **stop at the first failure**; the cheap disqualifiers are
first for a reason. Record which step killed a candidate — that reason is what
goes on the ledger and what stops the next run re-deriving it.

**1 — Ledger.** Is this id tombstoned? Declined once is declined forever.

**2 — Recency.** How old is the surface?

```bash
# whole file or directory:
git log --follow --diff-filter=A --format=%ad --date=short -- <path> | tail -1
# an identifier-shaped symbol, key, or export — the symbol's age, not its file's:
git log --follow --pickaxe-regex -S '(^|[^A-Za-z0-9_])<exact symbol>($|[^A-Za-z0-9_])' --format='%ad %h' --date=short -- <path> | tail -1
# a string-shaped key (an i18n sentence key) — its regex metacharacters are
# literal: `{{name}}` fatals --pickaxe-regex, and unescaped parens or `+`
# match something other than the key. Date those as fixed strings:
git log --follow --fixed-strings -S '<exact key>' --format='%ad %h' --date=short -- <path> | tail -1
```

`--follow` dates a surface at its creation, not its last rename — without it,
a path-limited `git log` records a rename as an addition, and the gate
silently suppresses surfaces that only look young. It requires exactly one
pathspec. Word boundaries matter the same way: plain `-S` matches substrings,
so an older, longer identifier that merely contains the symbol dates it
early, and `tail -1` then fails the gate open toward deletion. Write the
boundary as the explicit alternation above — never `\b` or `[[:<:]]`: Git's
pickaxe regex runs on a platform-dependent backend, and each shortcut works
on one and fails on another (measured in this repo: `\b` finds
`EnumSelector`'s introduction on Linux git while `[[:<:]]` fatals there with
`invalid regex`; the finding's probe measured the mirror image, `\b` empty
and `[[:<:]]` finding the introduction). And an empty result is not an age:
if the query prints nothing, the pattern matched no commit on this platform —
stop and do not file the candidate, because a symbol you cannot date never
passes this gate.

Branch on the surface's shape: identifiers and bare symbols take the boundary
alternation; sentence keys and other string-shaped surfaces take the
`--fixed-strings` variant above — injecting their metacharacters into the
regex form either fatals or matches a superset and dates the wrong surface.

Younger than ~90 days → **drop silently**, do not even file it. It is a
feature someone is still wiring up. (90 days is a heuristic, not a measured
threshold; widen it for a large subsystem.) Proposing deletion of something
that landed last week is the fastest way to lose a reviewer for good.

But "young" is not the fact the gate is reaching for — "still being wired
up" is, and the two come apart. A directory can keep growing for months
while its consumer never lands, and then every re-run of this survey dates
it young again and drops it again, which is how a subsystem gets to five
figures with nothing calling it. So when the gate fires on a **subsystem**
(not a single symbol), date the wiring rather than the code:

```bash
# has anything outside it ever referenced it?
"$RG" -l '<dir>/' --glob '!<dir>/**' packages
# and are the PRs that would wire it still open?
gh pr list --repo QwenLM/qwen-code --search '<feature> in:title' --state all
```

Recent commits inside the directory plus no external reference plus an open,
stalled wiring PR is **not** a deletion candidate and **not** a drop. It is a
different finding with a different owner: the wiring stalled. Report it to
that stack — the merged infrastructure has no entry point — and never as a
deletion PR. The code is wanted; the review that would connect it is what is
missing.

**3 — Published-surface escape.** Is the surface reachable from outside the
repo? SKILL.md § Territory is the authoritative list; keep the two in step.
Everything under `packages/core/src` is, via that package's `"./src/*"`
export plus ~179 `export * from` lines in its `index.ts`; everything under
`packages/audio-capture` and `packages/channels` is too — the release
workflow npm-publishes all eight packages with `--access public`. So is
everything under `packages/sdk-*` and `packages/acp-bridge`:
`release-sdk.yml:297` npm-publishes `packages/sdk-typescript` with
`--access public`, `release-sdk-python.yml:346` ships the Python SDK to PyPI,
`release-sdk-java.yml:206` deploys the Java SDK to Maven, and SDK consumers
import from the registry, never from this repo.

Reachability is not only an import. `packages/vscode-ide-companion`,
`packages/chrome-extension` and `packages/zed-extension` are consumed as
store-shipped manifests, and `.github/` is consumed GitHub-side — event
triggers, branch-protection required checks, cross-repo `uses:`. Even the
in-repo half of `uses:` hides from a careless pattern: reusable-workflow
references are quoted YAML — `uses: './.github/workflows/…'` — so the
quote-less pattern `uses: \./\.github/workflows` measures 0 in-repo while
the quoted form measures 5 (re-measure both; the count moves). Triggers and
required checks leave no in-repo trace at all, so a clean corpus grep still
says nothing about them. Any hit → report-only, no matter how clean the
consumer grep looks.

**4 — Full-corpus grep.** § 4 below. Any production consumer → drop.

**4b — Own file.** Does the declaring file use the symbol itself? A symbol
with no external consumer but a live in-file caller is not dead — at most its
`export` keyword is redundant, and that is a different, much smaller finding.
Check this before anything expensive: on the first real run it disqualified
nine of ten candidates in one class. If the only in-file callers are other
symbols in the same candidate set, the group dies together — take the id from
the outermost one.

**5 — Hidden consumers.** § 5 checklist. Run the rows that apply and record
which ones you ran.

**6 — Test-only is not automatically dead.** Ask why the test exists. A test
that pins behavior a user depends on keeps its subject alive even when
nothing else imports it; a test that exists only to cover a symbol nothing
calls dies with it. Integration tests count as consumers and live outside the
production corpus — step 4's grep strips `*.test.*` and `__snapshots__`
everywhere, so run a second pass without those exclusions:

```bash
"$RG" -n '<Symbol>' integration-tests <the candidate's own directory>
```

**7 — If it was once wired, find out why it was unwired.**

```bash
git log -S '<the binding text, e.g. completion: completeExtensions>' \
  --format='%ad %h %s' --date=short
```

A deliberate removal leaves a commit that says so. A wire-up that vanished in
an unrelated refactor is a **regression**, not dead code — hand it to
`/bugfix` and file nothing here.

**8 — Design-doc ownership.** `"$RG" -l -i '<symbol>|<file basename>'
docs/design docs/plans` (most are not date-prefixed, so grep content, not
filenames). A doc arguing for the surface beats your grep unless you can
beat the doc.

## 4 — The corpus

```bash
"$RG" -n --glob '!**/*.test.ts'  --glob '!**/*.test.tsx' \
      --glob '!**/*.spec.ts'    --glob '!**/*.spec.tsx' \
      --glob '!**/__snapshots__/**' \
      --glob '!node_modules' --glob '!dist' --glob '!bundle' \
      '<Symbol>' \
      packages integrations integration-tests scripts docs docs-site \
      .github .husky .vscode patches esbuild.config.js eslint.config.js \
      eslint.legacy-filenames.mjs vitest.config.ts package.json Makefile
```

- Name the root files explicitly. A symbol's only consumer is often
  `esbuild.config.js`, `eslint.legacy-filenames.mjs`, or a `scripts/` entry,
  and a `packages`-only search will not see it.
- ripgrep skips dot-directories, so `.github`, `.husky`, `.vscode`, and
  `.qwen` are searched only when named — but naming `.qwen` is still not
  enough: the
  `.qwen/*` ignore rule hides tracked content outside the re-included subdirs
  (`commands/`, `skills/`, `agents/`, `team-memory/`, `review-context.json`)
  even from a named search, so sweep its tracked files with
  `git ls-files -z .qwen | xargs -0 "$RG" …` instead — the `-z`/`-0` pair
  keeps a tracked path containing whitespace a single argument. Do not
  substitute
  `--no-ignore`: it surfaces `.qwen/tmp/` scratch copies of this repo, the
  same phantom-consumer class as `.claude/worktrees/` — **never name that
  one**, every hit there is a phantom consumer.
- `packages/desktop-shell` is negated out of the root `workspaces` list but
  is still shipped code; `packages/mobile-mcp` and `packages/cua-driver` are
  vendored. None is a target; all three are consumers.
- Then classify every hit: production / test / snapshot / docs / lint
  scaffolding. "No consumer" means no production consumer **and** a named,
  deliberate answer for each of the others.

## 5 — Hidden-consumer checklist

Run the rows that apply to the candidate's shape; record their ids.

| id            | Check                                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `string-keys` | Grep the **literal string**, not the identifier: tool names, slash-command names, dotted settings paths, telemetry event names, daemon route paths, theme names, i18n keys                                                        |
| `build-graph` | Is the file reached only by a build script? `esbuild.config.js`, `scripts/copy_bundle_assets.js`, `patches/`, and package `exports`/`files` entries reach code no import mentions                                                 |
| `generated`   | Does a committed artifact mirror it? `packages/vscode-ide-companion/schemas/settings.schema.json` is generated from `settingsSchema.ts` and CI fails when it is stale — a failure invisible to build, typecheck, lint, and vitest |
| `vi-mock`     | `"$RG" -n '<Symbol>' -g '*.test.*'` — a `vi.mock` factory referencing a symbol is a consumer that breaks loudly and confusingly                                                                                                   |
| `mirrors`     | Do `packages/sdk-python`, `sdk-java`, `acp-bridge`, or the VS Code / Zed / Chrome extensions hand-mirror this shape? They consume over a protocol, not by import                                                                  |
| `dyn-import`  | Dynamic `import()`, `Object.entries`-driven dispatch, glob-based discovery, resolver aliases in `vitest.config.ts` / `tsconfig.json`                                                                                              |
| `cli-flags`   | `packages/cli/src/config/config.ts` calls `.strict()`, so deleting even an inert flag turns a silent no-op into a hard "Unknown argument" failure for anyone whose script still passes it                                         |
| `assets`      | Files shipped by path rather than imported — `packages/core/src/skills/bundled/**`, prompts, templates, vendored binaries                                                                                                         |

## 6 — Worked examples

**1. A clean kill.** `EnumSelector`: `"$RG" -l EnumSelector` over the whole
corpus returns three paths — the component, its test, its snapshot. No
production consumer, nothing string-keyed (it is a React component, not a
registry entry), not in `packages/core`, and `git log` puts it well past the
recency gate. Deletion is the component, its test, and its snapshot entry, in
one commit. This is what a filed candidate should look like.

**2. Everything says dead; `git` says five days old — and says it again a
month later.** `packages/cli/src/agent-view` was ~6,000 lines whose entry flag
is passed to a spawned process but parsed nowhere; every static signal called
it rot. Then:
`git log --follow --diff-filter=A --format=%ad --date=short -- packages/cli/src/agent-view
| tail -1` → `2026-08-01`, five days before HEAD. A feature mid-wiring, so:
**do not file a deletion.** A "should we delete your new subsystem?" question
costs more trust than the finding is worth.

What this example originally got wrong was the second half — "do not mention
it". Measured again on 2026-09-04: **11,004 production lines, still zero
external references**, up ~8,000 in four weeks. The five merged PRs of its
stack shipped the supervisor, the PTY workers and the lifecycle; the two that
would give it an entry point (#7802 commands, #7803 roster TUI) have been
open since 2026-07-27, the second at +31,699 lines across 104 files and
conflicting. The recency gate kept firing and the survey kept dropping it, so
nothing ever said out loud that a five-figure subsystem had no caller.

The deletion verdict was right and stays right. The silence was not: this is
the stalled-wiring finding above, owed to that PR stack, not to a cleanup
list.

**3. The naive count is wrong in both directions.**
`eslint.legacy-filenames.mjs` lists 559 bare basenames. Checking "does a
file with this basename exist" flags **37** stale entries — and 32 of those
37 are live, because the kebab-case rule's `ignores`
(`eslint.config.js:277-282`) expand each entry to `**/${name}.ts` **and**
`**/${name}.*.ts`, so `acpAgent` also covers `acpAgent.worktree.test.ts`.
The same detector misses the other way: `eventBus` and `inMemoryChannel`
look live, but only because same-named files exist in `packages/acp-bridge`,
outside the rule's `packages/core/src` and `packages/cli/src` reach. Under
the rule's actual semantics the true count is **7**. Model the consumer's
matching semantics before counting; a candidate list built from a naive
detector is noise in both directions, and shipping it once is enough to make
a reviewer stop reading.

**4. A feature decision wearing a refactor's clothes.**
`general.dynamicCommandTranslation` (`config/settingsSchema.ts:632`) has no
read site anywhere — textbook dead scaffolding. Its five hits are the schema
declaration, two web-shell label strings, the generated
`vscode-ide-companion/schemas/settings.schema.json`, and
`docs/users/configuration/settings.md:98`: a **documented, user-settable
option**. Removing it withdraws that option: the docs row, the two label
strings, and the schema entry users' editors complete against all
disappear, while anyone who set the key keeps a settings line nothing
reads and nothing warns about — the unknown-key check compares top-level
keys only, and its output is a debug-log append, never the terminal. A
deprecation decision, not cleanup. Report-only. The `git log -S` evidence
is excellent — it is excellent evidence for an issue, not for a PR.

## Steps

1. Do § 0. Note the base SHA and the slice.
2. Search the slice for the six classes in § 1. Prefer breadth first: one
   pass per class over the whole slice beats going deep on the first hit.
3. Run § 3 against every candidate, in order, stopping at the first failure.
   Most candidates die at step 2, 4, or 5 — that is the protocol working.
4. Keep what survives. If more than one survives, rank by
   (consumers named with certainty) × (lines removed) and file them all.
5. Write the ledger comment per SKILL.md § Output: survivors with their
   evidence, plus one line per rejected id and the step that killed it.
6. **STOP.** Return to the user's checkout and remove the survey worktree.
   Nothing from §0's shell survived to this call, so the cleanup is
   self-contained: re-derive the fixed path
   (`SURVEY="${TMPDIR:-/tmp}/find-simplifications-survey/main"`), then
   `rm -rf "$(dirname "$SURVEY")"`, then `git worktree prune`. Delete the
   directory first, never `git worktree remove --force` on the fixed path:
   `remove` resolves symlinks, so if the path had been relinked to another
   registered worktree of this repo at any point during the run, it would
   force-delete that foreign tree, uncommitted work included; `rm -rf` on
   the parent only unlinks a symlink. `prune` then clears the stale
   registration — and recovers when the directory is already gone. Leave
   the checkout as §0 found it.
   Do not create a branch, do not edit code, do not open a PR. Landing
   requires an assent and `references/land.md`.
