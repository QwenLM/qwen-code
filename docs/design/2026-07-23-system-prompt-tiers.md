# System prompt tiers

## Problem

Qwen Code currently assembles prompt context in several places. The main system instruction flattens user instructions, workspace instructions, managed memory, `--append-system-prompt`, and Git state before their different lifetimes can influence ordering. Startup reminders similarly mix the date with workspace context. This makes the cache boundary implicit and lets frequently changing text invalidate slower-changing suffixes.

## Design

Assemble the system instruction once from three ordered groups:

- `stable`: identity, tool guidance, platform and model-family operational guidance.
- `context`: workspace context files and caller-supplied system messages.
- `volatile`: managed-memory and user-profile snapshots, Git state, and other session-scoped information.

`joinSystemPrompt` accepts these three groups directly and preserves insertion order inside each group. It does not introduce a generic fragment object, wire-role metadata, or source markers. Message role remains owned by the API request that carries the rendered text.

The main system instruction uses:

| Tier     | Content                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------- |
| stable   | base or overridden system prompt                                                                |
| context  | workspace `QWEN.md` / `AGENTS.md`, rules, local and extension instructions, then caller message |
| volatile | user-level profile/instructions, managed auto-memory, and initial Git snapshot                  |

Instruction discovery retains user- and workspace-scoped text separately instead of flattening both into `userMemory`. Configuration then exposes only the aggregate `context` and `volatile` prompt buckets; the legacy combined getter remains available to consumers that do not participate in tiered main-session prompt assembly.

The startup user-role prelude remains an explicit ordered array:

1. MCP server guidance
2. available skills
3. OS/cwd/directory tree
4. current date
5. deferred tool summary

MCP and skill metadata remain in user-role `<system-reminder>` parts rather than being promoted to the trusted system role. Existing per-turn reminders are unchanged.

## Behavioral changes

- Workspace instruction files and `--append-system-prompt` form the context tier.
- User-level instructions, managed auto-memory, and the initial Git snapshot form the volatile tier.
- Startup date text moves after OS/workspace context. It is emitted as a separate reminder part so a date change does not invalidate the workspace-context prefix.
- Blank sections continue to be omitted. Existing text is otherwise retained.

## Verification

- Unit-test aggregate tier ordering and blank handling.
- Unit-test user/workspace instruction discovery and managed-memory separation.
- Assert the complete `systemInstruction` at the content-generator request boundary with workspace context, caller message, user profile, managed memory, and Git state present.
- Assert startup `contents` ordering and separate date/workspace reminder parts.
- Run the targeted core tests, then the core build and repository typecheck.
