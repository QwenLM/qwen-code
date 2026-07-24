# Default system prompt and startup context

## Summary

Replace the current Qwen Code default base system prompt with the concise
prompt validated by the JobBench experiment. Keep the base prompt compiled
into the package and byte-stable across users, projects, and sessions.
Runtime-specific material is delivered with the first eligible model-bound
user-role request instead of being appended to the system instruction or
emitted as a separate synthetic user turn. This is normally the first real user
request, but a top-level notification or teammate message can carry it first.

The first request therefore has two API roles: one system message and one user
message. The user message contains ordered content parts for runtime capability
metadata, a `<system-reminder>` carrying session context, and the user's
original input. This avoids adjacent user turns for providers that reject or
mis-handle them.

## Current state and reference behavior

| Concern                   | Previous experiment                                            | Reference request                                         | Target                                                        |
| ------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| Default base              | New concise prompt, but managed memory is inserted dynamically | General behavior prompt                                   | Fixed compiled prompt                                         |
| Hierarchical instructions | Appended to the system instruction                             | In a `<system-reminder>` next to the user input           | In the first request's context reminder                       |
| Memory protocol           | Dynamic protocol, paths, and indexes in the system instruction | General protocol in system; active index in reminder      | General protocol in fixed base; paths and indexes in reminder |
| Capabilities              | Separate startup user entry with XML skill metadata            | Dynamic capability catalog in user-role content           | Content parts at the start of the first real user message     |
| Git snapshot              | Removed                                                        | Appended to the reference system prompt                   | Untrusted session context inside the reminder                 |
| User turns                | Synthetic startup user entry followed by the real user entry   | Context and user input share content in one request entry | Exactly one first user entry with multiple parts              |

## Goals

- Make the JobBench-validated prompt the default for every model and
  interaction mode.
- Keep the default base prompt compiled into the package with no runtime file
  dependency or local absolute path.
- Keep the base independent of QWEN/AGENTS files, language settings, memory
  indexes, environment data, hooks, skills, MCP servers, and git state.
- Preserve `QWEN_SYSTEM_MD`, `--system-prompt`, append-system-prompt, and
  `QWEN_WRITE_SYSTEM_MD` behavior with explicit composition boundaries.
- Deliver startup capability metadata, session context, and the first real
  user input in one user message with multiple ordered content parts.
- Preserve tool declarations, registration, and runtime feature behavior.

## Non-goals

- Changing tool registration or schemas.
- Moving the dynamic agent-type catalog out of the Agent tool declaration.
- Changing WebSearch, WebFetch, bare mode, safe mode, or memory storage.
- Changing package version or publishing workflow.
- Adding a prompt selector or model-specific prompt variants.
- Redesigning later per-turn reminders such as plan, arena, MCP/skill deltas,
  worktree notices, or tool-result guidance beyond the formatting needed for
  the new skill listing.

## System instruction

The default system instruction is assembled in this order:

1. The fixed default base prompt.
2. Append-system-prompt content, when explicitly configured.

The fixed base contains `# Harness`, general software-engineering behavior,
`# Session-specific guidance`, a general `# Memory` protocol, and
`# Context management`. The Memory section follows Session-specific guidance.
It describes the persistent file-based memory format, Qwen Code's
`user`/`feedback`/`project`/`reference` semantics, USER/PROJECT/TEAM routing,
index maintenance, exclusions, and stale-memory handling. It does not contain
an active directory, a `MEMORY.md` index, or a memory-directory tree.

`QWEN_SYSTEM_MD` and `--system-prompt` replace only the default base. Explicit
append content still follows the selected base. Startup capability metadata
and context remain available because they are user-message content rather than
default-prompt suffixes.

`QWEN_WRITE_SYSTEM_MD` writes only the fixed default base. It does not write
append content, startup metadata, runtime context, or git state. Loading that
file through `QWEN_SYSTEM_MD` therefore cannot duplicate a dynamic Memory
section or preserve stale indexes.

## First user-role message

No standalone startup user entry is sent. At the first eligible model-bound
user-role request, Qwen Code prepends optional startup content parts and sends
one user message. User queries, cron prompts, notifications, teammate messages,
steering input, and text retries are eligible. Tool results, hook continuations,
and function-response retries defer the parts. The ordering invariant is:

1. MCP server instructions and metadata, when present.
2. Available skills, when present.
3. Deferred-tool metadata, when present.
4. One `<system-reminder>` containing user and session context.
5. The request's original content parts.

Optional capability parts are omitted rather than emitted empty, so code and
tests must assert relative ordering instead of fixed array indexes. The request
content is always last. This ordering keeps the capability catalog at the
stable front of the message, places the authoritative runtime reminder after
externally supplied metadata, and keeps the reminder adjacent to the user's
request as in the reference request.

Providers may serialize multiple text parts as one string. The design relies
only on their token order and single user role, not on content-part boundaries
surviving conversion.

### Capability metadata

MCP server instructions, the skill catalog, and deferred-tool descriptions
remain registry-derived runtime data. Names and descriptions continue to be
escaped and framed as metadata rather than user instructions.

Skills use a plain, deterministic `- name: description` format. The
`<available_skills>` and nested `<skill>`, `<name>`, `<description>`, and
`<location>` XML structures are removed from both the startup listing and
later skill delta reminders. Only currently registered and model-invocable
skills or commands are listed.

The Agent tool continues to describe the runtime's actual agent types in its
tool declaration. The fixed base does not declare static agent types or skills.

### Context reminder

The startup `<system-reminder>` contains, when available:

- hierarchical QWEN.md, AGENTS.md, imported rule, extension-context, and
  output-language instructions;
- the active USER, PROJECT, and optional TEAM memory directories and the
  contents of their `MEMORY.md` indexes;
- current date, operating system, working directories, and directory context;
- the session-start git snapshot; and
- SessionStart hook additional context.

Only indexes are included for memory. Topic files and a memory-directory tree
are not enumerated or inlined. Empty optional sections are omitted.

The git snapshot is collected once per session and formatted as frozen,
untrusted repository data. It includes the current branch, short worktree
status, and recent commits, with the existing timeout and truncation behavior.
Moving it into the reminder keeps repository-controlled commit messages out of
the system role. A working-directory change invalidates the cached snapshot so
subsequent context can describe the new directory.

Safe mode omits hierarchical and managed-memory context. Bare mode preserves
its existing explicit-only discovery and managed-memory availability rules.

## Lifecycle and refresh

Startup parts are pending until an eligible request is sent, then are prepended
to that request and become part of normal chat history. Resume and compaction
must use the same mechanism so a refreshed startup context never creates an
adjacent synthetic user turn.

The chat retains a complete snapshot of the latest startup parts after they are
sent. Destructive history operations such as retry cleanup, cancel restore, and
rewind compare the remaining history with that snapshot and re-queue only the
parts that are no longer present. Restoring the removed user entry clears those
parts again. A text retry may apply re-queued startup parts, while a tool-result
retry preserves function-response ordering and does not inject unrelated
startup content into the response batch.

Later capability changes remain tail reminders and do not mutate the cached
startup catalog. A memory, language, directory, or session-context refresh is
queued for the next eligible request instead of being represented as a
standalone user message when doing so would create an adjacent user turn. A
directory change also marks earlier context with a different working directory
as stale.

Session-title extraction, rewind indexing, history display, recording, and
compression must treat prepended startup parts as structural context while
retaining the real user content from the same message.

History handed to a child runtime is part-aware. Arena inheritance removes
startup parts from every inherited user entry so each child can generate
context for its own worktree. A bounded agent fork first selects real turns
without startup metadata, then merges the parent's latest startup snapshot into
the first selected user turn; this preserves the single-user-turn request shape
without forwarding a stale snapshot from an older selected turn.
The child runtime retains that inherited snapshot separately from history so
auto-compaction can re-queue missing parts. Background fork transcripts persist
the same snapshot for resume.

## Data flow and consumers

`Config.userMemory` remains the loaded hierarchical and language content.
Managed memory is kept as a separately rendered runtime-context value so the
context reminder can place paths and indexes without parsing arbitrary project
Markdown. The fixed Memory protocol is no longer generated from this value.

The startup-context builder produces ordered `Part` values. The main client,
headless/agent runtime, Arena-launched agents, resume, and compression paths
must either pass those pending parts to the first request or intentionally opt
out. Specialized agent system prompts must not append hierarchical or managed
memory after the migration.

`/context` counts the fixed or overridden system instruction separately from
pending/sent startup user parts so its estimate matches the actual request. If
an earlier API token total exists while refreshed startup parts are pending,
their estimate is projected on top of that total and attributed to Messages;
free space and tier classification use the projected value.

## Compatibility details

- Tool schemas and tool registration are unchanged.
- WebSearch, WebFetch, safe mode, bare mode, MCP discovery, and explicit prompt
  flags keep their existing behavior.
- The base references only actual Qwen Code tool names.
- Unsupported runtime identities, model versions, Fast mode, static
  agent/skill lists,
  memory locations, hook semantics, permission modes, sandbox sections,
  action-care sections, and captured environment values are excluded.
- The Memory frontmatter example matches the parser's top-level `name`,
  `description`, and `type` fields.
- Repository instruction references use Qwen Code's QWEN.md and AGENTS.md
  names.

## Files affected

The change is expected to remain within the prompt constant and assembly,
startup-context/history construction, memory prompt rendering, main and agent
consumers, `/context` accounting, git snapshot helper, and their collocated
tests. No unrelated refactor is in scope.

## Testing

Unit tests cover the fixed base, general Memory protocol, explicit overrides,
append behavior, startup part ordering, one-user-turn construction, plain skill
formatting, context contents, memory refresh, git snapshot placement, resume,
retry/cancel/rewind recovery, Arena and bounded-fork handoff, agent consumers,
safe/bare modes, and `/context` accounting before and after an API token total
exists.

End-to-end verification uses a built bundle and raw API logging. The first
request must have one system message followed by a single user message that
contains capability metadata, the context reminder, and the original marker in
that order. The system message must contain neither project paths, memory
indexes, nor git state.

## Risks and open questions

The change intentionally affects default model behavior and startup history
across all Qwen Code surfaces. Provider converters may flatten content parts,
so both native part-level unit tests and serialized API-log checks are needed.
Moving structural context into a real user entry also requires careful handling
by title, rewind, resume, and compression code.
