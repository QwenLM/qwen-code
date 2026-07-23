# System prompt tiers

## Problem

Qwen Code currently assembles prompt context in several places. The main system instruction flattens user instructions, workspace instructions, managed memory, `--append-system-prompt`, and Git state before their different lifetimes can influence ordering. Startup reminders similarly mix the date with workspace context. This makes the cache boundary implicit and lets frequently changing text invalidate slower-changing suffixes.

## Design

`buildSystemPromptParts(config, systemMessage)` returns exactly three ordered
strings:

- `stable`: identity, MCP and deferred-tool guidance, skills, environment and
  platform hints, and model-family operational guidance.
- `context`: caller-supplied system messages and workspace context files.
- `volatile`: managed-memory and user-profile snapshots, Git state, and the
  startup date.

`joinSystemPrompt` accepts these three groups directly and preserves insertion order inside each group. It does not introduce a generic fragment object, wire-role metadata, or source markers. Message role remains owned by the API request that carries the rendered text.

The main system instruction uses:

| Tier     | Content                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------- |
| stable   | base or overridden system prompt; MCP guidance; deferred tools; skills; OS, cwd, and directory tree  |
| context  | caller system message; workspace `QWEN.md` / `AGENTS.md`, rules, local and extension instructions    |
| volatile | managed auto-memory; user-level instructions and output-language profile; Git snapshot; startup date |

Instruction discovery retains user- and workspace-scoped text separately instead of flattening both into `userMemory`. The configured output-language file is explicitly classified as user profile content, while extension instructions remain workspace context. Configuration then exposes only the aggregate `context` and `volatile` prompt buckets; the legacy combined getter remains available to consumers that do not participate in tiered main-session prompt assembly.

The joined string is cached on the client for the session. Normal turns and
explicit memory/config refreshes do not rebuild it. A new session, resume, or
context-compression boundary performs one complete rebuild. Forked subagents
inherit the parent's rendered prompt verbatim; non-fork subagents build the same
three tiers around their own stable agent prompt.

There is no startup user-role prelude. Existing saved preludes are stripped on
resume for compatibility. MCP tools, skills, or agents that change after startup
continue to use tail user-role delta reminders without mutating the cached system
prompt.

SessionStart hook `additionalContext` remains an API-time suffix outside the
cached three-tier core, matching Hermes's separate ephemeral-system-prompt
path. It is applied only at session and compression boundaries.

## Behavioral changes

- Workspace instruction files and `--append-system-prompt` form the context tier.
- MCP guidance, deferred tools, skills, and environment hints move from startup history into the stable system-prompt tier.
- Managed auto-memory, user-level instructions, Git, and the startup date form the volatile tier.
- The startup synthetic user message is removed from new histories.
- Blank sections continue to be omitted. Existing text is otherwise retained.

## Verification

- Unit-test aggregate tier ordering and blank handling.
- Unit-test user/workspace instruction discovery and managed-memory separation.
- Assert the complete `systemInstruction` at the content-generator request boundary with workspace context, caller message, user profile, managed memory, and Git state present.
- Assert that startup `contents` contains only real/restored conversation history.
- Assert that normal turns preserve the cached string and compaction rebuilds it.
- Run the targeted core tests, then the core build and repository typecheck.
