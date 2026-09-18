# Assembling the System Prompt from the Resident Tool Set

[English](2026-09-18-resident-tool-prompt-assembly.md) | [简体中文](2026-09-18-resident-tool-prompt-assembly.zh-CN.md)

**Status:** proposal for [#12032](https://github.com/QwenLM/qwen-code/issues/12032), part of [#12028](https://github.com/QwenLM/qwen-code/issues/12028). Step 1 only (session-start assembly); step 2 is named as follow-up work and is not proposed here.

Every code reference below was read on `main` at `8bd2feabba`. Nothing was built, run, or measured for this document; the token figures attributed to #12032 are that issue's own measurements and were not re-measured.

## 1. Problem

The system prompt describes the tool surface from static `ToolNames` constants and boolean config flags, independent of which tools the request actually declares. `getToolGuidanceSection` (`packages/core/src/core/prompts.ts:299`) interpolates tool names into policy bullets, and the four `# Examples` blocks are `[tool_call: …]` transcripts (21 occurrences of `tool_call:` in that file). Meanwhile the declared set is decided elsewhere, at `ToolRegistry.getFunctionDeclarations` (`packages/core/src/tools/tool-registry.ts:850`), and shrinks whenever a deployment sets `tools.eager`, adds a whole-tool `permissions.deny` rule, or leaves a tool deferred behind ToolSearch.

Two consequences, in order of importance:

1. **Correctness.** The prompt instructs the model to prefer tools it was not given. A session with `glob` demoted still reads "For file search: Use glob (NOT find or ls)", and the model's only way to discover the mismatch is a failed call or a ToolSearch round-trip.
2. **Tokens.** Per #12032, roughly 7.3 KB of the base prompt is structurally tool-bound (`## Using Your Tools` ~4,031 chars, of which ~66% of lines name a specific tool; `# Examples` 3,283 chars, entirely tool-call transcripts). That text stays resident even when the tools it describes are not.

For a **default** session every tool is resident, so the token saving is exactly zero. The payoff exists only for deployments that already trim their tool set — which is why the correctness half is the part worth paying for, and why the issue is `priority/P3` despite a P0 downstream dependency.

## 2. Current state

Verified at `8bd2feabba`:

| Fact                                                                                                                                                                                                                                 | Location                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base prompt already assembles conditionally per flag: `keepCodingInstructions === false` drops exactly the software-engineering section; `todoWriteEnabled` gates its own bullets; `codeModeOnly` swaps the whole tool-guidance body | `prompts.ts:359` (`buildDefaultBasePrompt`), `:271`, `:299`                                                                                                                       |
| Safety and dangerous-action guidance is unconditional and stays that way                                                                                                                                                             | `prompts.ts:733` (`getActionsSection`)                                                                                                                                            |
| Model-selected tool-call examples                                                                                                                                                                                                    | `prompts.ts:1375` (`getToolCallExamples`)                                                                                                                                         |
| Prompt entry point, 7 positional parameters, re-exported from the package root (`export * from './core/prompts.js'`)                                                                                                                 | `prompts.ts:577`, `packages/core/src/index.ts:99`                                                                                                                                 |
| Non-test callers of `getCoreSystemPrompt`: two                                                                                                                                                                                       | `client.ts:403` (inside `getMainSessionBaseSystemPrompt`, `client.ts:397`, whose config shape is `MainSessionPromptConfig`, `client.ts:380`), `agents/arena/ArenaManager.ts:1108` |
| The single chokepoint for "what the model was given"                                                                                                                                                                                 | `tool-registry.ts:850`                                                                                                                                                            |
| Session-start ordering is already favourable: warm → preload → prompt → declarations                                                                                                                                                 | `client.ts:2303`, `:2326`, `:2348`, `:2410`                                                                                                                                       |
| The cached system prefix is recorded when the instruction is built, and read per request; the Anthropic converter splits cache blocks only while the system text still starts with that prefix                                       | `client.ts:1672` (from `:1652`), `anthropicContentGenerator.ts:772`                                                                                                               |
| Mid-session declaration changes go through `setTools`, which never touches the prompt; `refreshSystemInstruction` exists but is called from 7 non-test files for unrelated reasons                                                   | `client.ts:1205`, `:1754`                                                                                                                                                         |
| Subagents take a different path and are unaffected by this change                                                                                                                                                                    | `agent-core.ts:796`, `:844` (`includeDeferred: true`), `:714` (`isHiddenByEagerAllowList`)                                                                                        |

Three references in the prompt are **not** interpolated from `ToolNames` and therefore cannot be gated without touching their text first:

- `subagent_type=Explore` (`prompts.ts:328`, `:348`) — subagent availability is data-driven from the subagent manager, not from the tool registry.
- Bare `read_file` in prose: the four examples (`:901`, `:1152`, `:1270`, `:1355`), the persisted-output mandate (`:420`), and the plan-mode reminder (`:1480`, a per-turn reminder rather than part of the base prompt).
- The `GlobTool` display name inside the examples (`:913`, `:1185`, `:1288`, `:1367`).

Test surface that moves with any change here: 17 full-prompt snapshots (`core/__snapshots__/prompts.test.ts.snap`), and `prompt-tool-examples.test.ts:99`, which asserts that the set of tool names appearing in the examples equals its validator keys exactly — that assertion breaks the moment any example becomes conditional. The precedent for conditional-section assertions is `prompts.test.ts:1248`.

## 3. Goals and non-goals

**Goals.** The base prompt describes only tools the session actually declares. `/context` and the real request agree on that set. The prompt-cache prefix is rewritten no more often than it is today. Safety, permission, and dangerous-action text stays unconditional.

**Non-goals.** Regenerating the prompt on every mid-session reveal (step 2, and it overlaps [#11321](https://github.com/QwenLM/qwen-code/issues/11321)). Subagent prompts. A new user-facing setting. Editing safety text. Shortening individual tool descriptions ([#12054](https://github.com/QwenLM/qwen-code/issues/12054)). Gating the skill listing or memory files ([#12030](https://github.com/QwenLM/qwen-code/issues/12030)).

## 4. Proposed design

### 4.1 Resolve the declared set once per session

In `startChat`, after `warmAll()` and the budget preload and before the instruction is built (between `client.ts:2326` and `:2348`), collect the declared tool names from `getFunctionDeclarations()` into a `ReadonlySet<string>` and record it on `Config` as the snapshot the prompt was built from. The prompt builder receives that set; it never sees the registry.

Recording the snapshot — rather than recomputing from the registry at every read — is what keeps `/context` honest: after a mid-session ToolSearch reveal the live registry and the prompt genuinely disagree, and `/context` must report what the prompt contains, not what the registry now holds. When no snapshot exists yet (a caller that builds a prompt before any `startChat`, including `ArenaManager`), the builder falls back to today's behaviour and emits every section.

### 4.2 API shape

`getCoreSystemPrompt` is re-exported from the package root and called positionally at two non-test sites, and its arity is asserted in `client.test.ts` and `contextCommand.test.ts`. Adding an eighth positional parameter would break those assertions and every external caller's expectations, so the new input arrives as a trailing options object:

```ts
getCoreSystemPrompt(
  userMemory?: string,
  model?: string,
  appendInstruction?: string,
  interactionMode?: SystemPromptInteractionMode,
  outputStyle?: OutputStyleDefinition | null,
  todoWriteEnabled?: boolean,
  codeModeOnly?: boolean,
  options?: { declaredTools?: ReadonlySet<string> },
): string;
```

`declaredTools === undefined` means "assume everything is declared", which is exactly today's output. `MainSessionPromptConfig` (`client.ts:380`) does not gain `getToolRegistry`: passing a resolved set keeps `prompts.ts` decoupled from tool internals, and a `Pick<Config, …>` that reaches the registry would also drag the warm-up contract into every caller that builds a prompt.

### 4.3 What each section gates on

| Section                                                                                   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `## Using Your Tools` bullets                                                             | A bullet is kept only when **every** tool it names is declared — a bullet that still named a missing tool would send the model after something it cannot call, which is the defect being fixed. Sub-bullets are keyed on the single tool they name, and the "prefer dedicated tools" bullet goes when none of its sub-bullets survive.                                                                                                                                                                                                                                  |
| `# Examples` transcripts                                                                  | An `<example>` block is kept only when every tool it calls is declared. Blocks are matched as `<example>`/`</example>` pairs, not split on blank lines: an example can contain blank lines of its own, and splitting on them orphans the tool calls in its later paragraphs from the tag that gates them (caught by the test suite while implementing). A block that calls no tool (`user: 1 + 2`) is never gated, the heading is kept while any block survives, and the model-specific XML and JSON formats use no `[tool_call: …]` notation so they are left ungated. |
| `## Software Engineering Tasks`, tone, communication                                      | Unchanged; already flag-gated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `getActionsSection`, security and safety rules, Core Mandates                             | Unconditional. A dangerous-action or denied-call clause must never depend on which tools are declared.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Bare tool names in prose (`:420`, `:901`, `:1152`, `:1270`, `:1355`, `:913` and siblings) | Not rewritten in step 1. The examples’ bare `read_file` mentions ride along with the block gated around them. The persisted-output mandate (`:420`) and the plan-mode reminder (`:1480`) still name `read_file` unconditionally — a known residue, recorded in §6. The `GlobTool` mention stays verbatim: `ToolDisplayNames.GLOB` is `Glob`, so interpolating the constant would change the default prompt and defeat the byte-identity guard.                                                                                                                          |
| `subagent_type=Explore`                                                                   | Left unconditional in step 1. Subagent availability is not registry state; gating it needs the subagent manager and is an open question (§9).                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 4.4 Prompt cache

The prompt depends only on the session-start snapshot, so `setStaticSystemPrefix` (`client.ts:1672`) is rewritten exactly as often as today — once per instruction build — and a mid-session reveal keeps changing only the tools block. This is a stated design constraint, not a caveat: wiring `refreshSystemInstruction` into the reveal sites would rewrite the globally cached block on every ToolSearch load, and it pulls against [#12029](https://github.com/QwenLM/qwen-code/issues/12029), whose whole purpose is to make deferral (and therefore reveals) actually happen on large windows. #12029 should reference this constraint so the net cache behaviour is chosen rather than inherited.

### 4.5 `/context`

`collectContextData` builds the prompt through `getMainSessionBaseSystemPrompt` and reads declarations separately, and it does not warm the registry. It therefore reads the same snapshot, which keeps its system-prompt row consistent with the request. This lands on top of the breakdown rework in [#12119](https://github.com/QwenLM/qwen-code/pull/12119) (#12033), whose numbers are the measurement instrument for §7.

## 5. Design decisions

| Decision                                    | Rationale                                                                                                             | Alternative rejected                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Session-start only                          | No cache regression, no wiring into ~15 mutation sites, and the ordering in `startChat` already makes it well defined | Per-reveal regeneration — step 2, and it needs measurement first |
| Pass a resolved `ReadonlySet<string>`       | Keeps `prompts.ts` free of registry coupling and of the warm-up contract                                              | Widen `MainSessionPromptConfig` with `getToolRegistry`           |
| Trailing options object                     | Preserves the 7-parameter public signature and the arity assertions                                                   | An eighth positional parameter                                   |
| Record the snapshot on `Config`             | `/context` must report what the prompt says, not what the registry now holds                                          | Recompute from the registry at each read                         |
| Absent snapshot means "everything declared" | Keeps `ArenaManager` and any external caller byte-identical                                                           | Require every caller to pass a set                               |
| Safety sections stay unconditional          | A denied-call or dangerous-action clause is not about tool availability                                               | Gate them for consistency                                        |

## 6. Constraints and risks

- **Snapshot churn in tests.** All 17 full-prompt snapshots regenerate unless the fixtures pin a declared set. Fixtures must pin one, or the snapshots stop testing the gating.
- **`prompt-tool-examples.test.ts:99` still passes.** It renders the ungated prompt, so its exact-equality assertion between example tool names and validator keys is untouched. It would only need reworking if gating ever became the default rather than opt-in.
- **`ask_user_question` stays ungated inside the gated section.** The interaction-mode bullet that names it also carries the policy for _not_ asking questions in a headless run, so gating the bullet would drop real guidance with it. The tool is exempt from `tools.eager` and therefore declared in practice; only a `permissions.deny` rule can remove it, and that configuration still reads the bullet. The exhaustive test in §7 excludes exactly this name and nothing else.
- **Two prose mentions stay ungated.** The persisted-output mandate (`prompts.ts:420`) and the plan-mode reminder (`:1480`) name `read_file` outside `## Using Your Tools`, so a session that does not declare it still reads them. That is pre-existing behaviour rather than a regression introduced here, and it is why §7's invariant test is scoped to the gated sections.
- **Dropping guidance for a tool that _is_ declared would be a regression**, and no CI test would catch it today. §7 adds the invariant test that closes this.
- **Core gate.** The change lands in `packages/core/src/core/**`, which is reviewed at the core gate's 100%-confidence bar; a `feat` reaching 500+ production lines escalates to a maintainer for awareness.
- **No recall harness exists.** There is no `evals/` directory, and the only agentic harness (`integration-tests/terminal-bench`) is manual-only, so "the model still picks the right tool" cannot be asserted in CI. The mitigation is that step 1 only removes text about tools the model does not have.

## 7. Validation plan

Items 1-4 are automated in this PR's `prompts.test.ts`, so every push re-checks them; item 5 needs a real session and is handed off in [`docs/verification/resident-tool-prompt-assembly/README.md`](../verification/resident-tool-prompt-assembly/README.md).

1. **Default-session regression (in CI).** The 17 existing full-prompt snapshots cover the no-snapshot path, and `renders identically when every tool is declared` covers the all-declared path. Together they are the guard that makes the change safe for the common case.
2. **Effect, and no drift outside it (in CI).** Two tests bracket the saving: a file-work allowlist must drop 900-1,400 characters (measured 1,104, ~276 tokens — policy bullets only, since that allowlist keeps every example), and a narrower allowlist must drop 3,800-5,000 (measured 4,327, ~1,082 tokens, three example blocks included). A third asserts all four model-specific example notations are gated, not just the bracket form. Together they fail on a lost saving and on newly added ungated tool text. `changes nothing outside the two gated sections` strips `## Using Your Tools` and `# Examples` from both renders and asserts the remainder is identical.
3. **Invariant (in CI).** `never names an undeclared tool inside the gated sections` sweeps every `ToolNames` value against the gated text with a word-boundary match, catching under-gating and, with a full set, over-gating. Scoped to those sections because of the two ungated prose mentions in §6.
4. **Reverse checks and plumbing (in CI).** `leaves CodeModeOnly guidance untouched by the declared set` asserts code mode renders identically with and without a snapshot, and `takes the declared set from the Config snapshot` asserts `getMainSessionBaseSystemPrompt` reads `Config.getPromptToolSnapshot()` — the property that keeps `/context` and the request on one source.
5. **Token measurement (handed off).** On a session with a trimmed `tools.eager` allowlist, compare the system-prompt row before and after, anchored on the provider's `input_token_count` (the category ruler itself is being fixed in #12119). The brief also carries the three-way run that separates this change's saving from `tools.eager`'s own, and the weakened recall check that is all the repo's missing eval harness allows.

## 8. Acceptance criteria

- A default session's base prompt is unchanged, byte for byte.
- In a trimmed session, no bullet or example names a tool that is not declared, and every declared tool's policy text is still present.
- Safety, permission, and dangerous-action text is present in every configuration.
- `setStaticSystemPrefix` is written no more often than before this change.
- `/context`'s system-prompt row and the request's system instruction come from the same snapshot.
- Both language versions of this design are updated together with any later decision.

## 9. Open questions

1. **`subagent_type=Explore`:** gate it on subagent availability (which needs the subagent manager, not the registry), or leave it unconditional? Step 1 leaves it.
2. **Examples floor:** is "always keep at least one example" the right rule, or is a prompt with no `# Examples` block acceptable for a heavily trimmed deployment?
3. **Subagent prompts** remain as inconsistent as today. Should that be a follow-up issue under #12028, or explicitly accepted?
4. **`ArenaManager`** builds prompts for agents that own separate registries. Should it pass each agent's own declared set in a follow-up?
5. **Ordering with #12029:** if #12029 lands first and deferral starts engaging on large windows, does the constraint in §4.4 still hold for deployments with many MCP tools, or does step 2 become necessary sooner?
