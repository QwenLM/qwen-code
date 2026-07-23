# Gateway policy engine — correct extraction + core-grade matching (2026-07-22)

Fixes a verified defect in the rc-gateway policy engine (its rule matching
has never worked against real daemon frames) and upgrades its matching to
reuse `packages/core`'s tested path-matching and shell-semantics.
Approved approach: **A + B — path-candidate enrichment plus an
`operation` match dimension** (chosen over C: delegating wholesale to
core's `PermissionManager`; see Alternatives).

Scope: **P1 + P2** of the permissions arc. Out of scope: any daemon
change, the remote approval-mode/plan-mode surface (P3), runtime
decision "why" (P4), OS-level sandboxing, credential filtering.

## Premise correction (the second one)

The Claude Code gap analysis
(`docs/2026-07-13-claude-code-vs-qwen-code-gap-analysis.md`, "Permissions")
claims Claude Code adds "classifier-based auto mode, plan mode with
approval gates, parameter-level permission rules, protected paths" over
qwen-code. **For the fork's `packages/core`, all four already exist:**

| Claimed missing               | Reality in the fork                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| classifier-based auto mode    | `packages/core/src/permissions/classifier.ts` + `classifier-prompts/` + `dangerousRules.ts`; `AutoModeSettings` (`config.ts:261`), `stripDangerousRulesForAutoMode` (`permission-manager.ts:986`) |
| plan mode with approval gates | `isPlanModeBlocked` (`core/permissionFlow.ts:132`) enforced at `coreToolScheduler.ts:2000` and `Session.ts:2080`; `ExitPlanMode` tool; prePlanMode save/restore; subagent inheritance             |
| parameter-level rules         | `Tool(specifier)` grammar — `Bash(git *)`, `Read(./secrets/**)`, `WebFetch(domain:x.com)` — `permissions/types.ts:45`, `rule-parser.ts:250,974`, picomatch path matching                          |
| protected paths               | expressible as `Read`/`Edit(./secrets/**)` deny rules, with 1685 lines of `shell-semantics.ts` extracting file operations out of shell commands                                                   |

`packages/core/src/permissions/` is 10,113 lines with ~2,900 lines of
tests. This is the **second** time the gap-analysis doc has been wrong
(the first: it claimed qwen-code had no code review, while `/review`
ships upstream). It was written by comparing Claude Code's feature list
against an assumed qwen baseline without checking the fork's actual
core. **Treat it as a hypothesis generator, not a roadmap — verify each
remaining item against the code before committing to it.**

What is genuinely missing is **remote**: the rc-gateway runs a second,
parallel, much coarser policy engine, and that engine is silently
broken.

## The verified defect

The gateway engine (`packages/rc-gateway/src/policy/`) intercepts the
daemon's `permission_request` SSE frame and auto-votes. Its extraction
does not match the wire:

- `enforcer.ts:96-101` reads the tool as
  `toolCall.name ?? toolCall.title ?? data.toolName ?? ''` and the args
  as `toolCall.input ?? toolCall.args ?? toolCall ?? {}`.
- The real frame's `toolCall` is the ACP shape —
  `{ toolCallId, title, kind, rawInput, … }` (`sdk/daemon/events.ts:78-84`,
  emitted verbatim by the daemon bridge). It has **no `name`** and **no
  `input`/`args`**.
- Consequences, all silent:
  1. `tool` degrades to `title`, a humanized description. A rule written
     `tool: run_shell_command` can never match.
  2. `args` becomes the **entire toolCall**, so
     `evaluator.ts:70-82`'s `candidatePaths` — which reads only
     `args.path`, `args.cwd`, `args.files[]` — always returns `[]`.
     Every `pathGlob` rule is dead (`no-path-candidates`).
  3. `enforcer.ts:117` builds `{ tool, args }` only; `originScope` and
     `sessionTag` are **never populated**, so those two dimensions are
     dead in production and reachable only via the offline
     `policy explain` CLI.
  4. `enforcer.test.ts:37,163,253` construct the synthetic shape
     `{ name: tool, input: args }` — **the tests encode the bug**, which
     is why nine prior policy cycles never caught it.

Net: every `tool:` and `pathGlob:` rule anyone has written has never
matched. The engine fails toward `prompt` (a human is asked), so this is
not an open hole — but the policy configuration does not do what it says,
which for a security control is its own defect.

Two further weaknesses this change addresses:

- `glob.ts:20` is a hand-rolled matcher where `*` and `**` are identical
  and there is no path normalization or symlink resolution — a `pathGlob`
  deny is bypassable by an equivalent spelling (`./x`, `a/../x`).
- Args are matched as one flattened JSON string
  (`canonicalArgString`, `evaluator.ts:64-67`), so a rule cannot address a
  specific parameter, and a shell command's _effects_ are invisible.

## Scope decisions (user-confirmed)

- **P1 + P2 in one arc** — they share the extraction path; fixing
  extraction without upgrading matching leaves a coarse engine, and
  upgrading matching on broken extraction is pointless.
- **No daemon change.** The frame will not gain a tool-name field. Tool
  identity is therefore the ACP `kind` only
  (`read | search | edit | execute | fetch | other`). Accepted cost:
  no `Bash(git *)`-style per-tool-name rules; `write_file` and `edit`
  are indistinguishable (both `edit`); the remote-review auto-approve
  follow-up stays "assisted".
- **`match.tool` accepts both** a kind and a known tool-name alias
  (backward compatible — existing files keep working and finally match).
  The lossy corner is called out below.
- **Fix outright.** No shadow mode, no `version: 2` gate. Previously
  dormant rules go live immediately; this is documented prominently and
  surfaced by lint.

## Approach

**A — path-candidate enrichment.** A new single seam turns a real frame
into a `ToolCallContext`: args come from `rawInput`; path candidates are
collected from every real parameter key; and for `kind: 'execute'`,
core's `extractShellOperations(command)` contributes the paths the shell
command actually touches. Existing `pathGlob` rules then cover shell
commands with no schema change — `{ pathGlob: ['**/.env*'], action: deny }`
blocks both `write_file .env` and `cat .env`.

**B — an `operation` dimension.** `match.operation: read | write | execute`
lets a rule distinguish "deny _writes_ to this path, allow reads", which
is what makes A's extraction expressive rather than merely broader.

Both reuse core directly — rc-gateway **already imports
`@qwen-code/qwen-code-core`** (`cli.ts:83`,
`workflows/sessionSpawner.ts:12-13`, `routes/workflows.ts:15`; precedent
set by the workflow-orchestration change), and core re-exports the
permissions module publicly (`core/index.ts:16` →
`permissions/index.ts`, which exports `rule-parser`,
`extractShellOperations`, and the auto-mode surface). The long-standing
"no edits outside `packages/rc-gateway/`" invariant concerns _editing_
core, not importing it; nothing in core is modified.

## Components

### `policy/frameContext.ts` (new)

The single place that understands the wire shape. Everything else stays
frame-agnostic.

```ts
export interface FrameContext extends ToolCallContext {
  /** ACP kind, used as `tool`. */
  tool: string;
  /** The real arguments (toolCall.rawInput), NOT the whole toolCall. */
  args: unknown;
  /** Every path the call touches, incl. shell-derived ones. */
  paths: string[];
  /** Operations the call implies, for `match.operation`. */
  operations: Array<'read' | 'write' | 'execute'>;
  /** Anchors path matching and relative-path resolution. */
  projectRoot: string;
  cwd: string;
  originScope?: string;
  sessionTag?: string;
}

export function frameToContext(
  data: unknown, // permission_request `data`
  ctx: {
    /** Daemon workspaceCwd. */
    projectRoot: string;
    originScope?: string;
    sessionTag?: string;
  },
): FrameContext;
```

`cwd` is the call's own working directory when it declares one
(`rawInput.directory` / `rawInput.cwd`, as `run_shell_command` does),
otherwise `projectRoot`. Both are carried on the context because core's
`matchesPathPattern(specifier, filePath, projectRoot, cwd)`
(`rule-parser.ts:826`) and `extractShellOperations(cmd, cwd)` each
require them; the gateway already resolves `workspaceCwd` from daemon
capabilities (it is what selects the workspace policy layer today).

Rules:

- `tool` = `toolCall.kind`; a missing/non-string kind yields `''`, which
  matches only a `tool: '*'` rule (fail-closed toward the default).
- `args` = `toolCall.rawInput` (falling back to `{}`), never the toolCall.
- **Path candidates** are read from the real parameter keys used by the
  tools behind each kind — `file_path`, `notebook_path`, `absolute_path`,
  `path`, `cwd`, `files[]` — kept as a single exported constant so the
  list cannot drift. For `kind: 'execute'`, the command is first split
  with core's `splitCompoundCommand` (`extractShellOperations` takes a
  _simple_ command, `shell-semantics.ts:1587`), then each part is passed
  to `extractShellOperations(simpleCommand, cwd)`; the resulting
  absolute `filePath`s join the candidate list.
- **Operations** are derived from the kind for non-execute calls
  (`read`/`search` → `read`; `edit` → `write`; `fetch` → `read`;
  `other` → none). For `kind: 'execute'` they come from
  `extractShellOperations`, whose `ShellOperation.virtualTool`
  (`shell-semantics.ts:46-62`) maps concretely:

  | `virtualTool`                                | operation |
  | -------------------------------------------- | --------- |
  | `read_file`, `list_directory`, `grep_search` | `read`    |
  | `edit`, `write_file`                         | `write`   |
  | `web_fetch`                                  | `read`    |

  Note the shell path yields _more_ identity than the frame does: a
  shell call resolves to a virtual tool name and an **absolute**
  `filePath`, whereas a direct tool call is only a `kind`. That
  asymmetry is intentional and free — it is not a reason to add a
  daemon field.

- `originScope`/`sessionTag` are **passed through** if a caller supplies
  them, but this arc does **not** populate them, and they remain dead in
  production. Correcting an earlier overreach in this design: there is no
  source wired for either. A `permission_request` originates from the
  local model, not a remote token, so `originScope` has no meaning to
  read; `sessionTag` could plausibly resolve to the session name (the
  precedent is routing, which matches its own `sessionTag` against
  `ev.sessionName`, `routing/rules.ts:659`), but that needs new
  session-name plumbing through the pump for a dimension nobody has
  asked for. Both move to Follow-ups; the finding that they are dead is
  recorded above as a defect, not silently fixed here.

### `policy/evaluator.ts` (modified)

- `candidatePaths` is removed; the evaluator consumes `ctx.paths`.
  `ToolCallContext` widens to carry `paths`, `operations`, `projectRoot`
  and `cwd` (all optional, so hand-built contexts still typecheck).
  **The `policy explain` / `policy lint` CLIs must keep working**: they
  construct a context from flags rather than a frame, so `explain`
  supplies `paths` from `--path`, and defaults `projectRoot`/`cwd` to
  `process.cwd()`. Both stay daemon-free, and `explainPolicy` continues
  to derive its authoritative decision by calling `evaluate`, so the
  trace cannot drift from enforcement.
- `pathGlob` matching uses core's `matchesPathPattern` (picomatch +
  normalization), closing the traversal-bypass hole. Two rules make that
  real, and both were learned the hard way in review:
  1. **Normalize the candidate.** `matchesPathPattern` runs only
     `toPosixPath` on the candidate — it never collapses `.`/`..`. The
     evaluator must `path.resolve` the candidate first (against the
     call's cwd, which is where the operation genuinely happens), or
     `/proj/sub/../.env` fails to match `**/.env*`.
  2. **Anchor the pattern to `projectRoot`, never to the call's cwd.**
     `resolvePathPattern` anchors an unprefixed pattern with
     `path.join(cwd, specifier)`. The call's cwd comes from
     `rawInput.directory`/`cwd` — **fields the model supplies in its own
     tool call**. Passing that as the anchor lets a prompt-injected model
     defeat a `**/.env*` deny on the literal path `/proj/.env` merely by
     declaring `directory: '/proj/somewhere/else'`. So the evaluator
     passes `projectRoot` (trusted, from daemon capabilities) as the
     anchor: `matchesPathPattern(pattern, resolvedCandidate, projectRoot,
projectRoot)`. A policy author writing `**/.env*` means "anywhere"
     and `src/auth/**` means "relative to the project" — neither may move
     because the model claimed a different working directory.
- `tool` and `argsGlob` keep the existing hand-rolled `glob.ts` matcher:
  they carry no path semantics, and the deliberate non-RegExp choice
  (ReDoS avoidance, `glob.ts:12-18`) is preserved where it costs nothing.
- New `match.operation` handled in `matchReason` as a pure-AND dimension:
  present and not intersecting `ctx.operations` → `operation-mismatch`.
  Absent → no constraint. It joins the specificity table at weight 30
  (same as `argsGlob`/`pathGlob`).
- Decisions (`allow | deny | prompt`), condition classification, ordering
  (priority → specificity → index), and fail-closed downgrade-to-prompt
  semantics are **unchanged**.

### `policy/loader.ts` (modified)

- `match.tool` accepts a kind **or** a tool-name alias, normalized at load
  through an exported table:

  | alias                                              | kind      |
  | -------------------------------------------------- | --------- |
  | `read_file`                                        | `read`    |
  | `grep_search`, `glob`, `list_directory`, `ripGrep` | `search`  |
  | `write_file`, `edit`                               | `edit`    |
  | `run_shell_command`                                | `execute` |
  | `web_fetch`                                        | `fetch`   |
  | `agent`, `task`, `lsp`                             | `other`   |

  MCP tool names (`mcp__server__tool`) have no ACP-kind equivalent and are
  NOT in this table — a rule naming one is a load-time `PolicyError` (see
  "Error handling" below), not a silent `other` mapping.

- `match.operation` added to the schema (`read | write | execute`, string
  or array), validated fail-closed like every other field.
- **Lint warns on alias widening for `allow` rules.** `allow` + a tool
  alias whose kind covers other tools (e.g. `write_file` → `edit`, which
  also matches the `edit` tool) grants more than written. This is the one
  genuinely unsafe corner of the accept-both decision, so it is called
  out by name in `policy lint` and at load. `deny` rules widen safely and
  are not warned.
- **Newly-live rules are surfaced.** Because the fix is shipped outright,
  `policy lint` reports every `allow` rule as newly effective, and boot
  emits one advisory line naming the count.

### `policy/enforcer.ts` (modified)

Replaces its own extraction with `frameToContext(...)` and supplies
`originScope`/`sessionTag`. Its security contract is untouched:
fail-closed on empty policy, fail-safe on a missing `requestId` or
approve option, never throws, one-time `allow_once` votes only, and
audit detail that never carries args/paths/prompt.

### Tests

Every policy test migrates from the synthetic `{ name, input }` shape to
**real** `{ toolCallId, title, kind, rawInput }` frames — that synthetic
shape is exactly what hid this bug for nine cycles. Each fix ships a
discrimination test that fails against the current code:

- tool matching: a `tool: execute` rule matches a real shell frame
  (fails today — `tool` is the humanized title).
- path matching: a `pathGlob` rule matches a real `write_file` frame via
  `rawInput.file_path` (fails today — zero candidates).
- shell paths: `{pathGlob:['**/.env*'], action:deny}` denies
  `cat .env` and a compound `x && cat .env` (new capability).
- traversal: `a/../secrets/x` and `./secrets/x` match a
  `**/secrets/**` deny (fails today — no normalization).
- operation: `{pathGlob:['**/.env*'], operation:'write'}` denies a write
  but not a read of the same path.
- dead dimensions: a regression test **pins** that `originScope`/
  `sessionTag` remain unpopulated by the enforcer, so the limitation is
  asserted rather than assumed (they are out of scope here — see
  `frameContext.ts` above and Follow-ups).
- alias: `tool: run_shell_command` matches an execute frame; lint warns
  for an `allow` alias with a shared kind.

## Error handling

| Failure                                         | Behavior                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `toolCall` missing/malformed                    | `tool: ''`, `args: {}`, no paths/operations → matches only `tool:'*'` rules → otherwise the policy default (fail-closed).     |
| `rawInput` absent or non-object                 | `args: {}`; no path candidates; rules requiring `pathGlob` report `no-path-candidates` and are skipped.                       |
| `extractShellOperations` throws or cannot parse | Caught; the shell contributes no extra paths/operations. The call still matches on kind/args. Never fails open into an allow. |
| Unknown/unmappable `match.tool` value           | Load-time `PolicyError` naming the value and the valid kinds — consistent with the loader's existing fail-closed validation.  |
| Malformed `match.operation`                     | Load-time `PolicyError`.                                                                                                      |
| Path pattern that picomatch rejects             | Load-time error at lint; at runtime a non-matching pattern is treated as no-match (never an accidental allow).                |

## Threat model

| Attacker                                                  | Capability                                                                                                                                                                                           | Mitigation                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local agent (possibly prompt-injected) issuing tool calls | Evade a `pathGlob` deny by spelling the path differently (`./x`, `a/../x`, symlink-ish forms)                                                                                                        | `pathGlob` uses core's `matchesPathPattern` (picomatch) instead of the depth-blind hand-rolled glob, **and** the evaluator `path.resolve`s the candidate first — core normalizes only the pattern, so without that step `a/../x` still slips through. Note: string normalization only — this does not resolve symlinks (see Residuals). |
| Same                                                      | Move the _pattern's_ anchor so a deny stops covering its target — declare `directory: '/proj/elsewhere'` in the tool call and walk out from under a `**/.env*` rule on the literal path `/proj/.env` | Unprefixed patterns anchor to `projectRoot` (trusted, from daemon capabilities), **never** to the call-supplied `cwd`. The model controls `rawInput.directory`/`cwd`; it must not control where a policy rule points. The call's cwd is still used to resolve _relative candidate_ paths — that is where the operation actually runs.   |
| Same                                                      | Perform a denied file operation by expressing it as a shell command (`cat .env`, `rm -rf x`) rather than a file tool                                                                                 | For `kind: 'execute'`, `extractShellOperations` contributes the touched paths and operations, so existing `pathGlob`/`operation` denies now cover shell-expressed effects, including compound commands.                                                                                                                                 |
| Policy author (self-inflicted)                            | Write `allow: write_file` and unknowingly also permit `edit`                                                                                                                                         | Alias→kind mapping is lossy by construction; `policy lint` and load-time advisory name every widening `allow` alias. `deny` aliases widen safely.                                                                                                                                                                                       |
| Operator upgrading the gateway                            | Dormant `allow` rules silently become live and start auto-approving                                                                                                                                  | Documented prominently here and in the walkthrough; lint reports newly-effective allow rules; boot emits an advisory count. Deliberate trade: correctness over a dry-run gate (user decision).                                                                                                                                          |
| Any                                                       | Exploit the fixed matcher to reach a _wider_ allow than before                                                                                                                                       | All new dimensions are pure-AND constraints; adding `operation` can only narrow a rule. Enriched path candidates widen only _path-matching_ rules, which for `deny` is the intent and for `allow` is covered by the lint warning.                                                                                                       |

**Residuals (accepted, documented):**

- **Kind-only tool identity.** `write_file` vs `edit`, and `agent` vs
  `lsp` vs MCP, are indistinguishable. Rules are coarser than core's
  local `Tool(specifier)` grammar. Closing this needs the additive
  daemon frame field (deferred by user decision; see Follow-ups).
- **No symlink resolution.** Path matching is string-level; a symlink
  inside the tree pointing outside is not detected here. (The
  remote-review permission bridge does `fs.realpath` for its own edit
  guard; generalizing that to the policy engine is a follow-up.)
- **Shell extraction is best-effort.** `extractShellOperations` is
  well-tested in core but cannot be complete for arbitrary shell; an
  unparsed construct simply contributes nothing, leaving the call to
  match on kind/args. It never fails open.

## Alternatives considered

- **C — delegate wholesale to core's `PermissionManager`.** Maximum
  reuse, but its rule grammar is tool-name-keyed and its config shape is
  `settings.json` `permissions.allow/ask/deny` — a direct impedance
  mismatch with kind-only frames, and it would fight the gateway's own
  decision model (`allow|deny|prompt` plus quota, time conditions,
  workspace layering, specificity ordering). Rejected; we borrow its
  _matchers_, not its manager.
- **Unify config on core's `settings.json` rules** (drop `policy.yaml`).
  Rejected: the gateway policy exists as a _remote overlay_ — tighter
  limits that apply because a request arrived remotely. Folding it into
  the local rule set erases that distinction.
- **Add the daemon tool-name field now.** Would restore full
  `Tool(specifier)` power and unlock hands-off review auto-approve, but
  the user chose to keep the daemon untouched in this arc. Kept as the
  top follow-up.
- **Shadow mode / `version: 2` opt-in rollout.** Considered and declined
  in favor of fixing outright with loud documentation and lint surfacing.

## Follow-ups (out of scope)

- **Additive `name` field on the `permission_request` frame** — restores
  exact tool-name matching, enables core's full `Tool(specifier)` grammar
  in the gateway, and upgrades remote-review auto-approve from assisted to
  hands-off. One additive line in the daemon bridge; three independent
  justifications.
- **Revive `originScope` / `sessionTag`** — currently dead match
  dimensions. `sessionTag` can resolve to the session name (routing
  already does this against `ev.sessionName`), which needs session-name
  plumbing to the enforcer; `originScope` needs a per-session record of
  the origin that started or prompted the session, which nothing tracks
  today. Either lands them, or they should be removed from the schema
  rather than left as silently-inert fields.
- **P3 — remote approval-mode / plan-mode surface**: gateway routes to
  view and set a session's approval mode (the daemon route and SDK method
  already exist; only the gateway surface is missing).
- **P4 — runtime decision "why"**: today `explainPolicy` is offline-CLI
  only and the `policy_decision` audit carries `ruleId` but not the rule's
  `reason` or trace, and there is no SSE decision frame. A remote human
  cannot see why something was denied.
- Symlink-aware path confinement in the policy engine (generalize the
  review bridge's `fs.realpath` guard).
- OS-level sandboxing and credential filtering — genuinely absent, large,
  independent subsystems.
- The walkthrough documents the policy file at
  `~/.config/qwen-rc/policy.yaml`, a path no code reads (the CLI reads
  `~/.qwen/rc/policy.yaml`); worth correcting alongside this change.
