# System prompt tiers

## Problem

Qwen Code currently assembles prompt context in several places. The main system instruction appends project instructions, `--append-system-prompt`, and Git state in an order that does not reflect how frequently they change. Startup reminders similarly mix the date with workspace context. This makes the cache boundary implicit and lets a frequently changing fragment invalidate slower-changing suffixes.

## Design

Introduce a small typed prompt-fragment model with three cache tiers:

- `stable`: product-owned instructions that normally remain identical across sessions.
- `context`: workspace- or session-scoped instructions that normally remain stable during a session.
- `volatile`: run- or request-scoped additions that can change frequently.

Each fragment also records its wire role and a marker identifying its source. Rendering keeps insertion order inside a tier and always emits tiers as `stable`, `context`, then `volatile`.

The main system instruction uses:

| Tier     | Fragments                                                                                |
| -------- | ---------------------------------------------------------------------------------------- |
| stable   | base or overridden system prompt                                                         |
| context  | hierarchical `QWEN.md` / `AGENTS.md` instructions and Git snapshot                       |
| volatile | managed auto-memory, `--append-system-prompt`, followed by optional SessionStart context |

The startup user-role prelude uses:

| Tier     | Fragments                                                    |
| -------- | ------------------------------------------------------------ |
| context  | MCP server guidance, available skills, OS/cwd/directory tree |
| volatile | current date, deferred tool summary                          |

MCP and skill metadata remain in a user-role `<system-reminder>` rather than being promoted to the trusted system role. Existing per-turn reminders remain volatile user-role content.

## Behavioral changes

- The Git snapshot moves before `--append-system-prompt`, so the explicit append remains in the volatile tail of the base system instruction.
- Startup date text moves after OS/workspace context. It is emitted as a separate reminder part so a date change does not invalidate the workspace-context prefix.
- Blank fragments continue to be omitted. Existing text is otherwise retained.

## Verification

- Unit-test tier ordering, role filtering, blank-fragment handling, and stable ordering within a tier.
- Unit-test main system-instruction ordering with base, memory, Git context, and append content.
- Unit-test startup reminder ordering and separate date/workspace fragments.
- Run the targeted core tests, then the core build and repository typecheck.
