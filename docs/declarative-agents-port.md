# Declarative Agent Definitions — Port from Claude Code 2.1.168

Internal design document for porting Claude Code's declarative agent (markdown +
YAML frontmatter) schema to qwen-code, addressing issue [#4821][i4821] and
coordinating with the workflow port in issue [#4721][i4721] / PR [#4732][p4732].

[i4821]: https://github.com/QwenLM/qwen-code/issues/4821
[i4721]: https://github.com/QwenLM/qwen-code/issues/4721
[p4732]: https://github.com/QwenLM/qwen-code/pull/4732

**Implementation status:** PR [#4842](https://github.com/QwenLM/qwen-code/pull/4842) ships `permissionMode`, `maxTurns`, and a tightened `color` allowlist. The other fields documented below are reference material for follow-up PRs once their prerequisite infra exists (`effort` → model-layer param; `mcpServers`/`hooks` → nested YAML parser; `memory` → scoped memory subsystem; `isolation` → workflow PR #4732; `initialPrompt` → `--agent` flag; `skills` → SkillManager wiring).

---

## Phase 0 — Boundaries

| Item                     | Value                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Latest upstream verified | Claude Code **2.1.168** (issue #4821 references ≥ 2.1.167, we are one bump above)                                                       |
| Native binary            | `/private/tmp/cc-2.1.168/package/claude` (220 MB)                                                                                       |
| Strings extract          | `/private/tmp/cc-2.1.168/claude.strings` (~342 k lines)                                                                                 |
| Worktree                 | `.claude/worktrees/gifted-hamilton-684741`                                                                                              |
| Branch                   | `lazzy/gifted-hamilton-684741` off `main @ 45efb1d3a`                                                                                   |
| Out of scope             | PR #4732 workflow code (separate worktree `lazzy/lucid-pare-974192`) — coordinate via interface only                                    |
| Authoring rule           | Author is **LaZzyMan**; **no** `Co-Authored-By` or AI-tooling trailers in commits, PRs, issues, or comments (per `~/.claude/CLAUDE.md`) |

---

## Phase 1 — Reverse engineering findings

All claims here have been independently grepped against `claude.strings` and
survived adversarial refutation. Confidence levels: **C** = Confirmed (direct
binary evidence), **I** = Inferred (synthesized from multiple confirmed facts),
**O** = Open (still uncertain).

### Schema — the 15 fields, refuted and reconfirmed

The agent frontmatter shadow schema is `Ig5`, used inside `ug5.agent` for
`tengu_frontmatter_shadow_unknown_key` / `_mismatch` telemetry. The
**production loader is `DL7`** (`parseAgentFromMarkdown`), which performs
hand-rolled per-field validation with custom error messages. A separate
**JSON-form schema `JL7`** (used by `fL7` / `parseAgentFromJson`) is tighter,
but is a different code path (used by `--agents <json>` and
`settings.agents`).

| #   | Field             | Type (Ig5 / DL7)                        | Required | Default        | Enum / Constraint                                                                                                                       | Conf                                        |
| --- | ----------------- | --------------------------------------- | -------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | `name`            | string, non-empty                       | **yes**  | —              | none — DL7: `if(!T\|\|typeof T!=="string")return null`                                                                                  | **C** strings:308120, 309074                |
| 2   | `description`     | string, non-empty                       | **yes**  | —              | JL7: `.min(1, "Description cannot be empty")`                                                                                           | **C** strings:308120, 309074, 309076        |
| 3   | `model`           | string                                  | no       | undefined      | `inherit` (case-insensitive) normalised to literal `"inherit"`; otherwise pass-through trimmed                                          | **C** strings:308120, 309075, 309076        |
| 4   | `tools`           | string\|array (MDH union)               | no       | undefined      | single token `*` → `undefined` (means "inherit all"); duped via `AXH`/`FbK`                                                             | **C** strings:308120 (MDH/AXH), 309075      |
| 5   | `disallowedTools` | string\|array (MDH)                     | no       | undefined      | "Ignored if `tools` is set" (per describe text); enforced by callers                                                                    | **C** strings:308120, 309075                |
| 6   | `effort`          | string\|integer                         | no       | undefined      | enum `GN=["low","medium","high","xhigh","max"]` OR `int`; alias `P37={med:"medium"}`                                                    | **C** strings:308120, 309075, GN/P37 inline |
| 7   | `permissionMode`  | string                                  | no       | undefined      | enum `$E = Gmq = [...kc]` where `kc=["acceptEdits","auto","bypassPermissions","default","dontAsk","plan"]` (6 values)                   | **C** strings:307649 (kc), 308120, 309075   |
| 8   | `mcpServers`      | `z.unknown()` (Ig5); `array(jL7)` (JL7) | no       | undefined      | each item: string OR `record(string, MCPServerSpec)`; per-item `safeParse` in DL7                                                       | **C** strings:308120, 309075, 309076        |
| 9   | `hooks`           | `z.unknown()` (Ig5); `_u()` (JL7)       | no       | undefined      | validated lazily at run time via `TKO` → `_u().safeParse` (settings.json hooks shape)                                                   | **C** strings:308120, 309073 (TKO), 309076  |
| 10  | `maxTurns`        | `union(number, string, null)`           | no       | undefined      | positive integer (parsed by `W46` — accepts numeric or numeric string)                                                                  | **C** strings:308120, 309075 (W46), 309076  |
| 11  | `skills`          | string\|array (MDH)                     | no       | `[]` (emitted) | normalised via `ml(q.skills) = FbK(H) ?? []`; no `*` wildcard (unlike `tools`)                                                          | **C** strings:308120, 309075                |
| 12  | `initialPrompt`   | string                                  | no       | undefined      | whitespace-only → undefined; only auto-submitted when agent is the **main session** (via `--agent` / settings), ignored as subagent     | **C** strings:308120, 309075                |
| 13  | `memory`          | string                                  | no       | undefined      | enum `["user","project","local"]`                                                                                                       | **C** strings:308120, 309075, 309076        |
| 14  | `background`      | string\|bool (eiH=EL8)                  | no       | undefined      | accepts `true` / `false` / `"true"` / `"false"`; only truthy normalised to `true`, else `undefined`                                     | **C** strings:308120, 309075                |
| 15  | `isolation`       | string                                  | no       | undefined      | enum **only** `["worktree"]` (NOT `["none","worktree"]` — that is a different schema at strings:313284 for background-session settings) | **C** strings:308120, 309075, 309076        |

Subtle observation that survived refutation: even though `skills` is "optional",
DL7's emit clause is `...I !== void 0 && {skills: I}` and `ml(undefined)`
returns `[]` (non-undefined), so the **final emitted record will carry
`skills: []` even when the frontmatter omits the field**. This affects equality
checks downstream — flag for the qwen-code port.

### Possible additional fields beyond the 15

| #   | Field       | Type   | Default   | Enum / Constraint                                                                                                                                                                                                                                                            | Conf                                     |
| --- | ----------- | ------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 16  | **`color`** | string | undefined | enum `_Y = ["red","blue","green","yellow","purple","orange","pink","cyan"]`; described as `"@internal — display color in the agents UI"`; values outside `_Y` are silently dropped at parse time (DL7 emits `...z && typeof z === "string" && _Y.includes(z) && {color: z}`) | **C** strings:308120, 309075, \_Y inline |

This is the **only** new agent-frontmatter field beyond #4821's list. Fields
that were searched but **NOT** found on `Ig5` / `JL7`: `version`, `tags`,
`labels`, `category`, `icon`, `alias` / `aliases`, `experimental`, `deprecated`,
`owner`, `author`, `homepage`, `displayName`, `shortDescription` (these all
turned up only on the skill schema `bg5` or unrelated identifiers).

### Loader — file and function map

| Concern                                                       | Function                                                                                                                                                     | Location               | Conf  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ----- |
| Top-level registry assembler                                  | `QL` (export name `getAgentDefinitionsWithOverrides`)                                                                                                        | strings:309076         | **C** |
| Filesystem walker (shared with skills/commands/output-styles) | `Gm` (memoised via `h6`)                                                                                                                                     | strings:312887         | **C** |
| Per-`.md` discovery                                           | `d_q` (= `loadMarkdownFiles`, ripgrep with `--files --hidden --follow --no-ignore --glob *.md`, 3 s `AbortSignal.timeout`, fallback `wY3` when `__("true")`) | strings:312887         | **C** |
| Per-file parser (markdown)                                    | `DL7` (= `parseAgentFromMarkdown`)                                                                                                                           | strings:309074         | **C** |
| Per-file parser (JSON)                                        | `fL7` (= `parseAgentFromJson`), uses `JL7` schema                                                                                                            | strings:309073         | **C** |
| Plugin agent loader                                           | `b0_` → per-dir `oR7` → per-file `sR7`                                                                                                                       | strings:308780, 308779 | **C** |
| Built-ins                                                     | `naH()` — emits `[JqH=general-purpose, KL7=statusline-setup, …]` plus implicit `YI=fork`                                                                     | strings:309073, 308663 | **C** |
| Override resolver                                             | `DS()` (= `getActiveAgentsFromList`) — see Resolution Order                                                                                                  | strings:309073         | **C** |
| Cache invalidation                                            | `u0_()` (= `clearAgentDefinitionsCache`) — clears `QL.cache` + `Gm.cache`                                                                                    | strings:309073         | **C** |
| FS watcher (chokidar)                                         | `s_T()` → `Q4_=s_T()` at module init (`WB6`)                                                                                                                 | strings:316417         | **C** |

`Gm("agents", _)` reads three baseDirs (`policySettings`, `userSettings`,
`projectSettings`), each tagged on the record, then dedupes by **inode** (drops
same-inode duplicates from symlinks / hardlinks, logs `Skipping duplicate file
'<path>' from <source> (same inode already loaded from <firstSource>)`).
Telemetry: `tengu_dir_search` with `managedFilesFound`, `userFilesFound`,
`projectFilesFound`, `projectDirsSearched`, `subdir`.

### Resolution order — definitive precedence

The function `DS()` filters its input by `source`, then iterates a fixed-order
array into a `Map` keyed by `agentType`. Because `Map.set` overwrites, the
**LAST bucket touched wins**:

```text
[built-in, plugin, userSettings, projectSettings, flagSettings, policySettings]
                                                                       ^
                                                                  highest precedence
```

| Source            | Origin                                                                                                                                                                            | Override priority | Conf                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------- |
| `built-in`        | `naH()` (hardcoded in binary)                                                                                                                                                     | 1 (lowest)        | **C** strings:309073              |
| `plugin`          | `b0_` → per-plugin `agentsPath`/`agentsPaths`                                                                                                                                     | 2                 | **C** strings:308780              |
| `userSettings`    | `~/.claude/agents/` (`CLAUDE_CONFIG_DIR` or `~/.claude`)                                                                                                                          | 3                 | **C** strings:312887, 307489      |
| `projectSettings` | `<cwd>/.claude/agents/` PLUS `iV_()` walk up to homedir / git root                                                                                                                | 4                 | **C** strings:312887, iV\_ inline |
| `flagSettings`    | `--agents <json>` CLI flag (schema `qKO = h.record(h.string(), JL7())`)                                                                                                           | 5                 | **C** strings:330190, 309076      |
| `policySettings`  | system-managed dir: macOS `/Library/Application Support/ClaudeCode/.claude/agents`, Linux `/etc/claude-code/.claude/agents`, Windows `C:\Program Files\ClaudeCode\.claude\agents` | 6 (highest)       | **C** strings:307649 (H2), 312887 |

Collisions are resolved **silently** — only the `tengu_plugin_name_collision`
telemetry event fires (`winner_source: T.at(-1)`); there is no
"X overrides built-in" warning shown to the user. (strings:308742 `hMH`.)

Subtle behaviour: `iV_()` walks **innermost-first** from `cwd` up, but Map.set
last-wins, so **outer-tree `.claude/agents/` wins over inner-tree** within
projectSettings. This is surprising — flag in open questions.

### Frontmatter parser

| Question                                                   | Answer                                                                                                                                                                                                                                         | Conf                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Library used?                                              | **None** — hand-rolled splitter `lz` calling `Bun.YAML.parse` (via wrapper `l5H`). No `gray-matter`, `js-yaml`, or `front-matter` in the binary.                                                                                               | **C** strings:307902 (l5H), 307905 (lz), 110303 (Bun.YAML errors) |
| Regex                                                      | `n5H = /^---\s*\n([\s\S]*?)---\s*\n?/`                                                                                                                                                                                                         | **C** strings:307905                                              |
| Failure handling                                           | YAML parse fail → retry with tab-to-2-space normalisation; if it still fails, log `Failed to parse YAML frontmatter in <file>: <err>` at warn and return `{frontmatter: {}, content: body}` (NEVER throws)                                     | **C** strings:307905, 151839                                      |
| Body extraction                                            | Plain string slice `H.slice(K[0].length)` after closing `---`; later normalised by `v$H` (likely leading-newline strip)                                                                                                                        | **C** strings:307905                                              |
| Shared between agents / skills / commands / output-styles? | **Yes** — same `lz` reused by `Iq_` (skill loader), `f13` (deprecated commands loader), and the agent loader via `Gm` → `d_q`                                                                                                                  | **C** strings:312690                                              |
| Schema validator                                           | **Zod v4** (bundled). v4-only markers `looseObject`, `treeifyError`, `prettifyError`, `toJSONSchema` present                                                                                                                                   | **C** strings:141270-141395, 141586                               |
| Validation mode                                            | **Shadow** — `ahH("agent", frontmatter)` runs `ug5.agent().strict().safeParse()` for telemetry **only**; DL7 ignores the result and proceeds with its own per-field validation. The lenient frontmatter object is the runtime source of truth. | **C** strings:308120 (ahH/ug5), 309074 (DL7 calls but ignores)    |
| Telemetry events                                           | `tengu_frontmatter_shadow_unknown_key`, `tengu_frontmatter_shadow_mismatch` (dedup'd via in-process `Set A37`)                                                                                                                                 | **C** strings:154634, 154636                                      |

### Wiring — Agent tool + CLI flag

| Layer                          | What it does                                                                                                                                                                       | Conf                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Task/Agent tool schema (`$_3`) | Declares `subagent_type: string.optional()`; when omitted, falls back to `general-purpose` (or `fork` if `AI()` returns true)                                                      | **C** strings:~309220        |
| Subagent lookup                | `activeAgents.find(a => a.agentType === requestedType)` against `toolUseContext.options.agentDefinitions.activeAgents`                                                             | **C** strings:~309220        |
| Fuzzy fallback                 | `MWK(s) = s.normalize("NFKC").toLowerCase().replace(/[\p{White_Space}\p{Pd}_]+/gu, "")`; ambiguous match → `AgentTypeError`; clean rematch → `tengu_subagent_type_normalized`      | **C** strings:~309220        |
| Permission gate                | `lV_(toolPermissionContext, "Task", agentType)` — denial → `Agent type '<x>' has been denied by permission rule 'Task(<x>)' from <source>.`                                        | **C** strings:~309220        |
| System-prompt source           | Markdown body becomes `getSystemPrompt: () => body + ('\n\n' + UVH(agentType, memoryScope) when memory enabled)` — closure captured at parse time                                  | **C** strings:309074-6 (DL7) |
| Main-thread render             | `Pp({mainThreadAgentDefinition, …})` — if agent has `appendSystemPrompt: true` (the catch-all `claude` built-in), body is appended to default; otherwise **REPLACES** default      | **C** strings:311015         |
| `--agent <name>` CLI           | Declared via Commander; action handler `if(I) process.env.CLAUDE_CODE_AGENT = I;` — stuffs into env var, read elsewhere into `appState.agent`. Also recorded in pid file.          | **C** strings:330190, 142138 |
| `--agents <json>` CLI          | Separate flag; JSON record `{name: {description, prompt, …}}` validated by `qKO = h.record(h.string(), JL7())`; joins the same `activeAgents` registry with `source: flagSettings` | **C** strings:330190, 309076 |

### Lifecycle — cold load + hot reload

| Aspect                          | Behaviour                                                                                                                                                                                                                  | Conf                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Cold load                       | Lazy — `QL` is memoised via `h6` (cache wrapper); first access reads filesystem + plugins, subsequent accesses return cached                                                                                               | **C** strings:309076         |
| Hot reload mechanism            | **chokidar watcher** `s_T()` registered at module init (`WB6`); watches `.claude/agents` (user + project) plus skills + commands dirs                                                                                      | **C** strings:316417         |
| Watcher flags                   | `persistent:true, ignoreInitial:true, depth:2, awaitWriteFinish:{stabilityThreshold,pollInterval}, ignored:(p,s) => s?.isFile() ? !p.endsWith(".md") : false, usePolling:kZ4` (macOS true), events `add`/`change`/`unlink` | **C** strings:316417         |
| Debounce                        | 300 ms (`l_T = 300`); handler calls `RIH(), Vv(), u0_(), …` — `u0_()` invalidates agent cache                                                                                                                              | **C** strings:316417, 309073 |
| Adaptive polling                | active = `n_T = 2000 ms` interval; idle (no interaction for `r_T = 60000 ms`) → `i_T = 30000 ms`; re-creates chokidar instance on switch                                                                                   | **C** strings:316417         |
| `/agents` slash command         | `local-jsx` UI for managing agents (Library/create/edit/delete/run) — **NOT** a rescan command                                                                                                                             | **C** strings:314593         |
| `/reload-plugins` slash command | Re-runs `QL(W8())`, re-counts agents; covers plugin-sourced agents (which chokidar does NOT watch)                                                                                                                         | **C** strings:314595, 190948 |
| Other invalidation paths        | `clearSessionCaches` (used by `/clear`) also calls `u0_()`                                                                                                                                                                 | **C** strings:313246         |

### Open questions (Phase 1)

| #   | Question                                                                                                                                  | Conf  | Resolution path                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------- |
| Q1  | Is `color`'s omission from #4821 intentional (it is `@internal`) or oversight?                                                            | **O** | Treat as **intentional** — port the field but mark as internal/UI-only  |
| Q2  | Is the lenient DL7 behaviour (background accepts strings, maxTurns accepts strings) a documented user-facing feature or back-compat hack? | **O** | Mirror it for parity, but warn in port docs                             |
| Q3  | Why is `isolation` enum `["worktree"]` only for agents while the background-session settings schema accepts `["none","worktree"]`?        | **O** | Likely "no isolation" = omitted field; document explicitly              |
| Q4  | Does `--agents <json>` (flagSettings) intentionally sit at precedence 5 (above project, below policy)?                                    | **O** | qwen-code can skip the flag in v1, defer the decision                   |
| Q5  | Innermost-first push by `iV_` + Map.set last-wins → **outer-tree wins** for projectSettings collisions. Footgun or intentional?           | **O** | qwen-code should pick **innermost-wins** semantics to avoid the footgun |

---

## Phase 2 — Implementation plan for qwen-code

### Current state — one-paragraph map

qwen-code already ships substantial subagent infrastructure:
`SubagentManager` (`packages/core/src/subagents/subagent-manager.ts`) implements
CRUD over markdown+YAML frontmatter files in `.qwen/agents/` (project) and
`~/.qwen/agents/` (user), backed by a custom YAML parser
(`packages/core/src/utils/yaml-parser.ts` — no `gray-matter` / `yaml` dep,
confirmed by `package.json`). `SubagentConfig`
(`packages/core/src/subagents/types.ts:41-122`) already has `name`,
`description`, `tools`, `disallowedTools`, `approvalMode`, `systemPrompt`,
`model`, `runConfig`, `color`, `background`. `SubagentLevel` already supports
five scopes (session, project, user, extension, builtin) with precedence
`session > project > user > extension > builtin`
(`subagent-manager.ts:189-220`). The Agent tool
(`packages/core/src/tools/agent/agent.ts`) declares `subagent_type` and
dynamically refreshes its schema enum via `subagentManager.changeListener`.
A `convertClaudeAgentConfig()` bridge already exists in
`packages/core/src/extension/claude-converter.ts:162-220` with a tool-name
mapping and `permissionMode → approvalMode` mapping. The **gap** is: (a) the
schema is missing 8 fields from #4821 (`effort`, `permissionMode` as
first-class, `mcpServers`, `hooks`, `maxTurns` as top-level,
`skills`, `initialPrompt`, `memory`, `isolation`); (b) no `--agent <name>`
CLI flag; (c) no chokidar-style hot reload (extension-style invalidation
exists, but not for filesystem agents); (d) `maxTurns` is currently nested
under `runConfig.max_turns` — needs to be promoted to top-level per #2409.

### Architectural decisions

#### D1. Reuse the existing yaml-parser for frontmatter

**Decision:** Reuse `packages/core/src/utils/yaml-parser.ts` (already used by
`SubagentManager.parseSubagentContent` and the skill loader).
**Rationale:** Claude Code's `lz` is the same shared parser used for skills +
commands + agents; qwen-code already mirrors that pattern. Adding `gray-matter`
or `js-yaml` is unnecessary churn. The existing parser handles `--- … ---`
splitting and is silent on malformed input (matches `lz`'s
`warn-and-return-empty` posture).

#### D2. Resolution / precedence order

**Decision:** Use `session > project (.qwen/agents/) > user (~/.qwen/agents/)

> extension > builtin`— i.e. **keep the existing qwen-code SubagentLevel
order, do NOT mirror Claude Code's`flagSettings`/`policySettings` buckets in
v1**.
**Rationale:** Claude Code's policySettings (managed dir) is an enterprise
deploy story qwen-code does not have. Flag-injected agents (`--agents <json>`)
is a power-user feature that can land in P4. The existing five-level qwen-code
precedence already covers the cases #4821 cares about: project overrides user
overrides built-in. The `extension` level slots in cleanly between user and
> builtin.

#### D3. Validation — keep the existing SubagentValidator

**Decision:** Extend `SubagentValidator`
(`packages/core/src/subagents/`) to validate the eight new fields. **Do
NOT** introduce zod unless skillManager's pipeline already uses it; if the
existing validator is hand-rolled, keep it hand-rolled.
**Rationale:** Claude Code's `Ig5` is shadow-only — runtime validation is
hand-rolled `DL7`. Matching that pattern keeps error messages legible
(e.g. `Agent file <path> has invalid permissionMode '<x>'. Valid options: …`)
without dragging in another dep. If skillManager already uses zod, follow that
choice for consistency — TBD by reading the skill code in P1 prep.

#### D4. Hot reload — defer; rely on cold load + explicit reload

**Decision:** v1 does **NOT** ship a chokidar watcher. Cache invalidation
hooks already exist (`subagentManager` has `changeListener` and explicit
CRUD-driven refresh). Project-level reload happens on session start; in-session
edits via `/agents` UI invalidate. A `/reload-agents` (or piggyback on
`/reload-plugins`) slash command can land in P4 if user demand exists.
**Rationale:** Hot reload via FS watcher is expensive (chokidar adds a polling
loop with adaptive scheduling — Claude Code's implementation alone is ~150
lines of bookkeeping). Cold-load-on-startup is plenty for v1 and matches how
`SubagentManager` is wired today. Open the door for P4.

#### D5. Wire `--agent <name>` CLI flag — v1 in scope

**Decision:** Add `--agent <name>` to `packages/cli/src/config/config.ts`
CliArgs. Behaviour: look up against the resolved registry, set the agent as
the main-thread agent, throw a clear error if name doesn't resolve. Match
Claude Code semantics (replace default system prompt unless agent has
`appendSystemPrompt: true`). Do NOT use a `CLAUDE_CODE_AGENT` env-var
indirection — qwen-code's `Config` object can carry it directly.
**Rationale:** This is the user-facing handle on #4821 — without it, declarative
agents are only reachable via the Agent tool's `subagent_type` param, which
is too indirect for a "set my default agent" use case. `--agents <json>`
(plural) can defer to P4.

#### D6. Workflow.agentType coordination — interface contract

**Decision:** Surface a stable resolver interface that PR #4732's
`createProductionDispatch` can call when it lands. Specifically:

| Contract                                                                                                                                                                                                                                                                                                     | Owner                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| Frontmatter `name` IS the workflow `agentType` string (key-equality, case-sensitive)                                                                                                                                                                                                                         | this PR              |
| Workflow's hardcoded `disallowedTools` floor (`[SEND_MESSAGE, EXIT_PLAN_MODE]`, mirrored from upstream `Tg8`; verified in PR #4732 as `ToolNames.SEND_MESSAGE`, `ToolNames.EXIT_PLAN_MODE`) **UNIONs** with agent-level `disallowedTools` — floor is always applied, even when agent definition sets `tools` | workflow PR consumes |
| Per-call `opts.isolation` overrides per-agent `isolation: 'worktree'` default                                                                                                                                                                                                                                | workflow PR consumes |
| `model`, `effort`, `permissionMode`, `maxTurns` from agent definition override workflow defaults when set                                                                                                                                                                                                    | workflow PR consumes |
| Agent body becomes the subagent's `systemPrompt`; workflow's `WORKFLOW_SUBAGENT_SYSTEM_PROMPT` is the fallback when `agentType` does not resolve                                                                                                                                                             | workflow PR consumes |
| When `agentType` is unset or fails to resolve, workflow falls back to built-in workflow subagent (graceful, no throw)                                                                                                                                                                                        | workflow PR consumes |

**Resolution of the #4721 / #4821 contradiction** (`tools` vs
`disallowedTools` precedence): this port writes the agent registry such that
`disallowedTools` is **always carried separately** from `tools`. The "ignored
if tools is set" rule from #4821's table is **enforced by the Agent-tool
callers** (i.e. when constructing the subagent's `ToolConfig`), not at parse
time. This lets the workflow always union its floor with `disallowedTools`
independently of whether the agent sets `tools`. The agent registry is a
**dumb data carrier**; precedence rules live at the dispatch site. This
resolves the apparent conflict between #4821's "ignored" rule and #4721's
"union" rule.

**Tool-name canonicalisation:** Use `ToolNames.SEND_MESSAGE` and
`ToolNames.EXIT_PLAN_MODE` (verified against the PR #4732 diff), exported as named constants from
`packages/core/src/agents/runtime/workflow-orchestrator.ts` once it lands. The
declarative-agents port itself does NOT need to import these — they are the
workflow's floor, applied at the workflow dispatch site.

### Module layout

| Path                                                               | New / Touched | Purpose                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/subagents/types.ts`                             | **Touched**   | Add 8 new fields to `SubagentConfig`: `effort`, `permissionMode` (already maps via `approvalMode` — keep both? see D7 below), `mcpServers`, `hooks`, `maxTurns` (promote to top-level, deprecate `runConfig.max_turns`), `skills`, `initialPrompt`, `memory`, `isolation` |
| `packages/core/src/subagents/subagent-manager.ts`                  | **Touched**   | Extend `parseSubagentContent` / `serializeSubagent` to round-trip new fields; extend `SubagentValidator` calls                                                                                                                                                            |
| `packages/core/src/subagents/subagent-validator.ts` (assumed path) | **Touched**   | Add per-field validation matching DL7's error messages: `Agent file <path> has invalid permissionMode '<x>'. Valid options: …` etc.                                                                                                                                       |
| `packages/core/src/subagents/agent-frontmatter-schema.ts`          | **New**       | Single source of truth for enum constants: `EFFORT_VALUES`, `PERMISSION_MODE_VALUES`, `MEMORY_VALUES`, `ISOLATION_VALUES`, `COLOR_VALUES`. Mirror Claude Code 2.1.168 verbatim.                                                                                           |
| `packages/core/src/subagents/builtin-agents.ts`                    | **Touched**   | New fields default to undefined; no behaviour change                                                                                                                                                                                                                      |
| `packages/core/src/tools/agent/agent.ts`                           | **Touched**   | Read new fields from resolved `SubagentConfig` when constructing subagent options (`model`, `maxTurns`, `permissionMode`, `effort`); plumb `isolation` per-call override semantics for #4721                                                                              |
| `packages/cli/src/config/config.ts`                                | **Touched**   | Add `--agent <name>` flag; resolve against `SubagentManager` on startup; error if name doesn't resolve                                                                                                                                                                    |
| `packages/cli/src/config/config.test.ts`                           | **Touched**   | Tests for `--agent` flag resolution + error path                                                                                                                                                                                                                          |
| `packages/core/src/extension/claude-converter.ts`                  | **Touched**   | Add mapping for new fields when importing Claude `.md` files (`mcpServers`, `hooks`, `maxTurns` top-level, `memory`, `isolation`, etc.)                                                                                                                                   |
| `packages/core/src/subagents/agent-frontmatter-schema.test.ts`     | **New**       | Snapshot tests for enum lists; round-trip parse/serialise tests                                                                                                                                                                                                           |
| `packages/core/src/subagents/subagent-manager.test.ts`             | **Touched**   | Tests for new field validation, precedence, error messages                                                                                                                                                                                                                |
| `packages/core/src/tools/agent/agent.test.ts`                      | **Touched**   | Tests for new field plumbing into subagent runtime                                                                                                                                                                                                                        |
| `docs/cli/agents.md` (if exists) or `docs/declarative-agents.md`   | **New**       | User-facing reference: 16-field schema + examples                                                                                                                                                                                                                         |

### D7. permissionMode vs approvalMode — bridge, don't replace

**Decision:** Accept BOTH `permissionMode` (Claude-compatible) and existing
`approvalMode` (qwen-compatible) in frontmatter. On parse, if `permissionMode`
is set, map it to `approvalMode` using the existing table in
`claude-converter.ts:195-208` (`default → default`, `plan → plan`,
`acceptEdits → auto-edit`, `dontAsk → default`, `bypassPermissions → yolo`).
If both are present, `approvalMode` wins (more specific to qwen-code) and emit
a `tengu_frontmatter_shadow_*`-style telemetry event noting both were set.
**Rationale:** Preserves backward compat with existing `.qwen/agents/*.md`
that use `approvalMode`, while accepting Claude Code's `permissionMode`
verbatim so users can drop in Claude Code agent files unchanged.

### Schema mapping table

| Claude Code 2.1.168 field  | qwen-code field                                    | Adaptation                                                                                                   | Notes                                                                                                    |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `name`                     | `name`                                             | none                                                                                                         | identical, required                                                                                      |
| `description`              | `description`                                      | none                                                                                                         | identical, required                                                                                      |
| `model`                    | `model`                                            | accept `inherit`, `fast`, `haiku`, `sonnet`, `opus`, or `authType:model-id`                                  | qwen-code already supports the broader vocabulary; `inherit` is new                                      |
| `tools`                    | `tools`                                            | accept string\|array; `*` → undefined (inherit-all)                                                          | already supported as array; add string + `*` handling                                                    |
| `disallowedTools`          | `disallowedTools`                                  | accept string\|array; **always carried separately from `tools`**                                             | precedence rule (#4821 "ignored if tools is set") enforced by **callers**, not parser                    |
| `effort`                   | `effort` (new)                                     | enum `low/medium/high/xhigh/max` + integer; alias `med → medium`                                             | runtime effect is qwen-specific (map to existing thinking-effort knob if present, else store and ignore) |
| `permissionMode`           | `permissionMode` (new) + bridges to `approvalMode` | enum `acceptEdits/auto/bypassPermissions/default/dontAsk/plan`; mapping table per D7                         | accept Claude-format verbatim                                                                            |
| `mcpServers`               | `mcpServers` (new)                                 | array of (string \| `{name: spec}`); validate per-item, drop bad entries with warn                           | wiring into MCP runtime in P4                                                                            |
| `hooks`                    | `hooks` (new)                                      | object matching settings.json hooks shape                                                                    | wiring into hook runtime in P4                                                                           |
| `maxTurns`                 | `maxTurns` (new top-level)                         | positive integer; accept numeric string for parity                                                           | **promote from `runConfig.max_turns`**; keep nested form as deprecated alias                             |
| `skills`                   | `skills` (new)                                     | array of skill names; comma-separated string also accepted                                                   | runtime: preload via skillManager when agent starts                                                      |
| `initialPrompt`            | `initialPrompt` (new)                              | string; whitespace-only → undefined; only fires when agent is main session                                   | wired via `--agent` flag path                                                                            |
| `memory`                   | `memory` (new)                                     | enum `user/project/local`; loads from `.qwen/agent-memory/<name>/` etc.                                      | runtime in P4                                                                                            |
| `background`               | `background`                                       | accept bool or string `"true"/"false"`; only truthy → true                                                   | already supported; loosen parse rules                                                                    |
| `isolation`                | `isolation` (new)                                  | enum **only** `["worktree"]`                                                                                 | runtime owned by workflow PR (#4732 P3+); registry just carries the field                                |
| `color` (undocumented #16) | `color`                                            | enum `_Y = ["red","blue","green","yellow","purple","orange","pink","cyan"]`; values outside silently dropped | already in qwen `SubagentConfig`; tighten validation to match Claude Code allowlist                      |

### TDD test plan

| Chunk                        | Test file                                | What it asserts                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema enum constants        | `agent-frontmatter-schema.test.ts` (new) | `EFFORT_VALUES`, `PERMISSION_MODE_VALUES`, `MEMORY_VALUES`, `ISOLATION_VALUES`, `COLOR_VALUES` match Claude Code 2.1.168 byte-for-byte (snapshot)                                                     |
| Parser — happy path          | `subagent-manager.test.ts`               | Round-trip parse `.qwen/agents/test.md` with all 16 fields → emitted record has expected shape                                                                                                        |
| Parser — required fields     | `subagent-manager.test.ts`               | Missing `name` returns null + warn log; missing `description` returns null + warn log                                                                                                                 |
| Parser — enum validation     | `subagent-manager.test.ts`               | Bad `permissionMode` / `memory` / `isolation` / `effort` / `color` each emit specific warn (matching DL7 wording) and field is dropped                                                                |
| Parser — lenient field types | `subagent-manager.test.ts`               | `background: "true"` → `true`; `maxTurns: "5"` → `5`; `effort: "med"` → `"medium"`; `tools: "Read,Edit"` → `["Read","Edit"]`; `tools: "*"` → undefined                                                |
| Parser — color allowlist     | `subagent-manager.test.ts`               | `color: "magenta"` is silently dropped (no error), `color: "blue"` is preserved                                                                                                                       |
| Skills field idiosyncrasy    | `subagent-manager.test.ts`               | omitting `skills` results in `skills: []` (matches Claude Code DL7 emit behaviour)                                                                                                                    |
| Resolution precedence        | `subagent-manager.test.ts`               | Same `name` in project + user → project wins; in user + builtin → user wins; in extension + builtin → extension wins                                                                                  |
| Inode dedup                  | `subagent-manager.test.ts`               | Two paths to same inode (symlink) → only one record, log emitted                                                                                                                                      |
| permissionMode bridge        | `subagent-manager.test.ts`               | `permissionMode: bypassPermissions` → resolved `approvalMode: yolo`; both set → `approvalMode` wins + telemetry                                                                                       |
| `--agent` CLI flag           | `packages/cli/src/config/config.test.ts` | Flag sets main-thread agent; unresolved name throws with `Agent type '<x>' not found. Available agents: …`                                                                                            |
| Agent tool fuzzy fallback    | `agent.test.ts`                          | `subagent_type: "Test_Engineer"` resolves to a registered `test-engineer` via NFKC-lowercase normalisation                                                                                            |
| Agent tool not-found error   | `agent.test.ts`                          | Unresolved `subagent_type` → error message matches `Agent type '<x>' not found. Available agents: <list>`                                                                                             |
| Workflow contract            | `agent-frontmatter-schema.test.ts`       | Exported `getAgentByName(name)` interface returns the full SubagentConfig including `isolation`, `disallowedTools`, `model`, `effort`, `permissionMode`, `maxTurns` (consumable by workflow PR #4732) |

### Phased PR plan

| Phase  | Title                                                                                                                          | Scope                                                                                                                                              | Blocks                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **P1** | `feat(core): declarative agent schema fields (effort, permissionMode, maxTurns top-level, memory, isolation, color allowlist)` | Add fields to `SubagentConfig`; extend parser + validator + serializer; deprecate `runConfig.max_turns`; add enum constants module; tests          | None                               |
| **P2** | `feat(core): wire new agent fields into Agent tool runtime`                                                                    | Plumb `model`, `effort`, `maxTurns`, `permissionMode`/`approvalMode` bridge into `AgentTool.execute()` → `AgentHeadless.create()` call site; tests | P1                                 |
| **P3** | `feat(cli): --agent flag for main-thread agent selection`                                                                      | Add `--agent <name>` to `CliArgs`; resolve at startup; error path; tests                                                                           | P1                                 |
| **P4** | (optional, scope-creep) `feat(core): mcpServers + hooks + skills + initialPrompt + memory runtime`                             | Wire the four "metadata only in v1" fields into actual runtime effects                                                                             | P1, plus skill/MCP/hook subsystems |

Each PR target ≤ 800 LOC delta (excluding tests); P1 is the largest at ~600
LOC of validator + tests.

---

## Phase 3 — Coordination matrix with workflow port (#4721 / PR #4732)

| Declarative-agents feature                                             | Workflow interaction                                                                                                                                                                   | Owner                                                               | Blocked on                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| `name` field as the registry key                                       | Workflow's `opts.agentType` lookup string ([#4721][i4721] explicit)                                                                                                                    | **this PR** defines the registry contract; **workflow PR** consumes | none — registry shape can stabilise first      |
| `disallowedTools` field on agent                                       | Workflow UNIONs with hardcoded floor `[SEND_MESSAGE, EXIT_PLAN_MODE]` (per [#4721][i4721] §2 — verified against PR #4732 diff: `ToolNames.SEND_MESSAGE`, `ToolNames.EXIT_PLAN_MODE`)   | **this PR** carries field; **workflow PR** unions at dispatch       | workflow PR #4732 P3 lands                     |
| `tools` field on agent                                                 | Workflow passes through verbatim to subagent's `ToolConfig.tools`                                                                                                                      | **this PR** carries field; **workflow PR** plumbs                   | workflow PR #4732 P3                           |
| `model` field on agent                                                 | Workflow's `opts.model` overrides per-call; agent's `model` is the default                                                                                                             | **this PR** carries field; **workflow PR** resolves precedence      | workflow PR #4732 P3                           |
| `effort` field on agent                                                | Workflow's call-site override wins; agent default fallback                                                                                                                             | **this PR** carries field; **workflow PR** resolves                 | workflow PR #4732 P3                           |
| `permissionMode` field on agent                                        | Maps to subagent's approvalMode at dispatch; workflow's call-site override wins                                                                                                        | **this PR** carries field via D7 bridge; **workflow PR** plumbs     | workflow PR #4732 P3                           |
| `maxTurns` field on agent                                              | Replaces workflow's hardcoded `WORKFLOW_SUBAGENT_MAX_TURNS = 50` when agent sets it                                                                                                    | **this PR** carries field; **workflow PR** resolves precedence      | workflow PR #4732 P3                           |
| `isolation: 'worktree'` field on agent                                 | Default; per-call `opts.isolation` overrides ([#4721][i4721] §3)                                                                                                                       | **this PR** carries field; **workflow PR** owns runtime             | workflow PR #4732 P3+ (currently throws in P1) |
| `initialPrompt` field on agent                                         | Workflow does **not** use it (only fires when agent is main session via `--agent`)                                                                                                     | **this PR** + **CLI**                                               | none (independent)                             |
| `memory`, `mcpServers`, `hooks`, `skills`                              | Workflow has no special handling beyond passing through to subagent runtime                                                                                                            | **this PR** carries fields; runtime wiring in P4 / future           | future PRs                                     |
| `EXCLUDED_TOOLS_FOR_SUBAGENTS` updates                                 | Workflow PR #4732 adds `WORKFLOW` to the set (per the issue/PR-context discovery — though adversarial refutation noted this is NOT yet in `agent-core.ts` on `main`, only in worktree) | **workflow PR** owns; this PR untouched                             | none                                           |
| Tool-name canonical form for workflow floor (`ToolNames.SEND_MESSAGE`) | This PR doesn't import the floor constants; it only carries `disallowedTools` strings as authored. The workflow PR owns canonicalisation.                                              | **workflow PR**                                                     | workflow PR #4732                              |
| Shipping order                                                         | This PR (P1+P2+P3) ships independently of workflow. Workflow PR #4732 P3 is gated on this PR's `getAgentByName()`-like resolver being importable.                                      | parallel until P3-of-workflow                                       | workflow P3 reads from this PR's exports       |

**No circular block:** this PR and the workflow PR can land in parallel through
their P1/P2 phases. They synchronise at workflow-P3, which needs this PR's
registry resolver. If this PR lands first, workflow-P3 reads from it. If
workflow PR lands first, it ships with the existing `subagent_type` lookup
(returning workflow defaults on miss) and switches to the richer resolver once
this PR lands.

---

## Phase 4 — Risks and open questions

### Risks

| #   | Risk                                                                                                                                                                                                | Mitigation                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Schema drift between Claude Code minor releases (2.1.168 → 2.1.x)                                                                                                                                   | Pin the enum constants module to "verified against 2.1.168" with a doc comment; rerun the strings-grep against new releases as part of `feature-reverse` skill |
| R2  | `runConfig.max_turns` → top-level `maxTurns` is a breaking schema change for existing `.qwen/agents/*.md` files                                                                                     | Keep nested form as deprecated alias with one-cycle deprecation; emit warn on parse, document in CHANGELOG                                                     |
| R3  | `permissionMode` ↔ `approvalMode` round-trip lossy (Claude has 6 modes, qwen has 4-ish)                                                                                                            | Map both directions explicitly per D7; emit telemetry on dual-set; do NOT silently rewrite on save                                                             |
| R4  | New fields (`hooks`, `mcpServers`, `skills`, `memory`) carried in registry but no runtime in v1 → users may set them and silently get no effect                                                     | Document v1 scope clearly; emit a one-time info log per agent when a "carried but not yet runtime" field is non-empty                                          |
| R5  | Adversarial-verify flagged that `EXCLUDED_TOOLS_FOR_SUBAGENTS` does NOT include `WORKFLOW` on `main` — could mean the workflow port is not yet merged or that the recursive-fanout guard is missing | Confirm with the workflow PR author (LaZzyMan = self) that the guard lands with PR #4732, not in this port                                                     |
| R6  | The outer-tree-beats-inner-tree projectSettings behaviour (Q5) is a footgun if mirrored                                                                                                             | qwen-code chooses **innermost-wins** explicitly; tested via R5 fixture                                                                                         |
| R7  | Field `color` is documented as `@internal` in the binary's describe text — we may be porting something Anthropic explicitly does not support                                                        | Port it but mark `@internal` in qwen-code docs too; treat as UI-only; do not surface in user-facing reference docs                                             |

### Open questions — proposed resolutions

| #   | Question                                                                                                                                                       | Resolution                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Is `color`'s omission from #4821 intentional?                                                                                                                  | **Treat as intentional**. Port the field; do NOT mention in user-facing docs except as "available, internal".                                                                                                                                                                                                                                            |
| Q2  | Lenient DL7 behaviour: document or hack?                                                                                                                       | **Mirror it**. Accept `background: "true"`, `maxTurns: "5"`, `effort: "med"` for parity, even if undocumented. Add tests.                                                                                                                                                                                                                                |
| Q3  | Why isolation enum differs between agent schema and background-session schema?                                                                                 | **Document the divergence in code comment**; "no isolation" = field omitted, not an enum value.                                                                                                                                                                                                                                                          |
| Q4  | Should `--agents <json>` (plural, flagSettings) land in v1?                                                                                                    | **Defer to P4**. CLI surface for power users; v1 only ships `--agent <name>` (singular) which is what #4821 cares about.                                                                                                                                                                                                                                 |
| Q5  | Inner-tree vs outer-tree precedence for nested `.qwen/agents/`?                                                                                                | **Innermost-wins**. Override Claude Code's accidental outer-wins behaviour. Test fixture in P1.                                                                                                                                                                                                                                                          |
| Q6  | `tools` vs `disallowedTools` precedence: #4821 says "ignored if tools is set"; #4721 says "union with workflow floor"                                          | **Registry is dumb data**. Parser preserves both fields independently. Precedence rules live at the dispatch site (Agent tool / workflow). Resolves the contradiction.                                                                                                                                                                                   |
| Q7  | Tool-name canonical form for the workflow disallowedTools floor — verified against PR #4732 as `ToolNames.SEND_MESSAGE`, `ToolNames.EXIT_PLAN_MODE`            | **Not this PR's concern** — owned by the workflow PR. Document in coordination matrix only.                                                                                                                                                                                                                                                              |
| Q8  | Does #2409 close-resolution affect anything?                                                                                                                   | **Inherit #2409's "promote model + maxTurns to top-level" guidance**. Already baked into this plan.                                                                                                                                                                                                                                                      |
| Q9  | Should `extension`-level agents in qwen-code's existing `SubagentLevel` precedence stay above `builtin` (current) or below it (Claude Code has no equivalent)? | **Keep `extension > builtin`**. Extensions are user-installed; built-ins are vendor-default. User-installed wins.                                                                                                                                                                                                                                        |
| Q10 | Are issues #4821, #4721, #4732 fully specified for the contract this doc proposes?                                                                             | **Post a coordination comment on #4821** linking this doc, summarising the field-by-field decisions, and asking maintainers to ack: (a) schema parity with Claude Code 2.1.168's 16 fields, (b) D7 `permissionMode`/`approvalMode` bridge, (c) D2 precedence order, (d) registry-as-dumb-data resolution of the `tools`/`disallowedTools` contradiction. |

### Coordination action items

| #   | Action                                                                       | Where                                                |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| A1  | Post field-by-field summary + 5 decisions to #4821 for maintainer ack        | comment on #4821                                     |
| A2  | Cross-link this doc from #4721 noting Phase 3 matrix                         | comment on #4721                                     |
| A3  | Once P1 of this port lands, ping #4732 to switch to richer resolver          | comment on PR #4732 (when ready)                     |
| A4  | Rerun strings-grep against next Claude Code minor for schema-drift detection | `feature-reverse` skill cron job (manual until then) |
