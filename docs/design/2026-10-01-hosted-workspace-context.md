# Hosted Workspace project context

[English](2026-10-01-hosted-workspace-context.md) | [简体中文](2026-10-01-hosted-workspace-context.zh-CN.md)

Status: implemented. Part of #13057. Stacks on #13166.

## Problem and scope

A Hosted model turn runs with `safeMode: true`, so `refreshHierarchicalMemory`
returns before discovery and the turn starts without the Workspace's
`QWEN.md` / `AGENTS.md`. Safe mode is an indivisible bundle (hooks, extensions,
skills, MCP, tool lists), so it must stay on; the turn's `cwd` is the Harness's
own bound workspace, which the design forbids the model from depending on.
Instructions therefore need a Workspace-sourced path, not a lifted guard.

This slice delivers one: the first time a Hosted Workspace turn acquires the
Runtime, the Harness reads the Session working directory’s instruction files (`QWEN.md`, `AGENTS.md`)
through a `workspace-context` Runtime control and keeps the assembled text
on the attached Session. The Harness injects the fetched
text through `Config.setUserMemory` and refreshes the cached system instruction
with `refreshSystemInstruction` before the next model request — after `initialize()` for the first
request when the Session already holds it, and between model rounds when a
fetch landed mid-turn.

Out of scope: project settings, skills, and rules directories (safe mode keeps
them off deliberately); nested or hierarchical discovery outside the Session working directory; an `InstructionsLoaded` hook event for the injected files (safe mode skips core's only firing site, and the Hosted hook dispatcher does not synthesize one); a durable record of the fetched context. Durability needs a new Session
domain, which is a cross-language contract change (the Java store mirrors the
closed domain namespace), so it is deferred: a cold-loaded Session refetches on
its next ordinary tool turn. Recovery of an already-running tool turn fetches
under the same once-per-attachment latch: an attachment that already holds
text never re-reads, while a cold-loaded attachment (a cross-process takeover
builds a fresh one) reads once as its recovered turn re-acquires the Runtime,
so the turn that writes the user-visible answer never runs with the slot
silently empty. This slice covers the native files/shell profiles; MCP turns
skip this read.

## Timing and the Stage A invariant

The first model request never waits for the Runtime: the read rides the first
tool batch's acquisition, which already exists when a turn uses tools. A turn
that calls no tools never fetches, and never pays. The Stage A criterion —
model output starts first even with a delayed Runtime — is untouched because
nothing on the first request's path changed.

The consequence is explicit: a Session's very first turn answers its first
request without project instructions. The fetch lands before that turn's first
tool dispatch, so the same turn's follow-up requests and later turns on that attachment have
them after a successful fetch.

## Failure semantics

The read is a Runtime control, not a tool execution: it reserves nothing in
the execution ledger, writes no `qwen_tool_execution` row, and leaves nothing
to cancel or recover, so the fault gates' execution counts and broker
operation sequences are unchanged. The Runtime reads the files from the
Session directory, skips any whose real path leaves the Workspace (a planted
symlink must not promote a host file into the system instruction), and caps
each at 64 Ki characters so the reply stays under the 1 MiB control limit.

The read is best-effort. A missing file, a transport failure, or a Broker
refusal leaves the Session without context and the turn unaffected; the
failure is logged on the Harness's stderr. Cancellation stops waiting for the read immediately and never latches the
slot, even if the underlying request finishes later. The slot records a completed
fetch — including "the Workspace has no instruction files" — so the read
happens once per attached Session until something the Harness sees changes
an instruction file: a native `write_file`/`edit` batch naming `QWEN.md` or
`AGENTS.md` (invalidated before it runs, whatever its outcome), or a file
rewind whose `filesChanged` names one. Either returns the slot to undefined,
and the next native tool turn reads again (#13564).

## Assembly

Each file that reads back non-blank contributes one section in the same shape
the local hierarchical memory uses: `--- Context from: <name> ---`, the
file's trimmed content, and the closing marker. Sections join with
a blank line. Names stay relative to the Session working directory; the Runtime host's physical paths
never appear.

## Implementation boundaries

- CLI tool turn: the post-acquisition read, once per attached Session, with
  failure isolation from the turn it rode in on.
- CLI model turn: the per-request injection point; safe mode unchanged.
- CLI session: the attached Session holds the fetched text for its lifetime.
- CLI Runtime worker: the `workspace-context` provider control, answered
  from the executor outside the execution ledger.
- Java Runtime Broker: admits `workspace-context` on the provider control
  shape and forwards it without acquiring a provider Session, as raw file
  history does.
- Core: unchanged.

## Validation and acceptance

Turn-level tests pin: the read happens on the first acquisition, reserves no
execution, and never repeats for the attached Session; a missing file
contributes nothing; an aborted turn leaves the slot unset; a transport
failure neither blocks nor fails the turn. Worker-level tests pin symlink
confinement and the per-file cap; protocol tests pin the closed result
shape in both languages. Model-level tests pin the
injection order — pre-fetched context is set before the first request, and a
fetch landing mid-turn is set before the next request. Session-level tests
keep their recovery and redispatch guarantees, with the context reads named
explicitly where dispatch counts are asserted.

## Deployment and rollout

Upgrade the Broker and worker bundle before the Hosted Harness. An older
Broker rejects the `workspace-context` control with
`400 runtime_control_operation_invalid`, and an older worker refuses it
through its own closed operation union. Because the read is best-effort, the
skew is silent to the API and the model: no Session receives `QWEN.md` or
`AGENTS.md`, the slot never latches, and the read repeats on every turn. The
signal is a recurring `qwen serve: Hosted Workspace context read failed`
line on the Harness's stderr.

## Risks and open questions

Whether the
context should be pinned durably (and revisioned through the ContextBinding
contract) remains the maintainers' call; the injection point built here does
not change under either answer.

The latch is directory-blind: a committed
`POST /v1/agents/sessions/{id}/cwd` settles without Harness or worker
involvement, so the attachment keeps injecting the previous directory's rules
while its tools already run in the new one, and the new directory's files are
never read. A shell command that writes an instruction file is equally
invisible: the Harness does not know which files a shell call touched. Invalidating these needs the resolved directory or the ContextBinding
`contextRevision` on the `workspace-context` result, whose shape is closed —
the same revisioning question as above, not a local fix.
