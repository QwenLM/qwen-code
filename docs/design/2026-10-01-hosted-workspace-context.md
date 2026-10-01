# Hosted Workspace project context

[English](2026-10-01-hosted-workspace-context.md) | [简体中文](2026-10-01-hosted-workspace-context.zh-CN.md)

Status: implemented. Resolves #13057. Stacks on #13166.

## Problem and scope

A Hosted model turn runs with `safeMode: true`, so `refreshHierarchicalMemory`
returns before discovery and the turn starts without the Workspace's
`QWEN.md` / `AGENTS.md`. Safe mode is an indivisible bundle (hooks, extensions,
skills, MCP, tool lists), so it must stay on; the turn's `cwd` is the Harness's
own bound workspace, which the design forbids the model from depending on.
Instructions therefore need a Workspace-sourced path, not a lifted guard.

This slice delivers one: the first time a Hosted Workspace turn acquires the
Runtime, the Harness reads the root instruction files (`QWEN.md`, `AGENTS.md`)
through the existing Broker prepare/execute path and keeps the assembled text
on the attached Session. Every model request assembles its system prompt from
`Config.getUserMemory()` at request time, so the Harness injects the fetched
text through `Config.setUserMemory` — after `initialize()` for the first
request when the Session already holds it, and between model rounds when a
fetch landed mid-turn.

Out of scope: project settings, skills, and rules directories (safe mode keeps
them off deliberately); nested or hierarchical discovery beyond the Workspace
root; a durable record of the fetched context. Durability needs a new Session
domain, which is a cross-language contract change (the Java store mirrors the
closed domain namespace), so it is deferred: a cold-loaded Session refetches on
its next tool turn.

## Timing and the Stage A invariant

The first model request never waits for the Runtime: the read rides the first
tool batch's acquisition, which already exists when a turn uses tools. A turn
that calls no tools never fetches, and never pays. The Stage A criterion —
model output starts first even with a delayed Runtime — is untouched because
nothing on the first request's path changed.

The consequence is explicit: a Session's very first turn answers its first
request without project instructions. The fetch lands before that turn's first
tool dispatch, so the same turn's follow-up requests and every later turn have
them.

## Failure semantics

The read is best-effort. A missing file, a tool error, a transport failure, or
a Broker refusal leaves the Session without context and the turn unaffected;
the failure is logged on the Harness's stderr. The slot records a completed
fetch — including "the Workspace has no instruction files" — so the read
happens at most once per attached Session.

## Assembly

Each file that reads back non-blank contributes one section in the same shape
the local hierarchical memory uses: `--- Context from: <name> ---`, the
content as `read_file` returned it, and the closing marker. Sections join with
a blank line. Names stay Workspace-relative; the Runtime host's physical paths
never appear.

## Implementation boundaries

- CLI tool turn: the post-acquisition read, once per attached Session, with
  failure isolation from the turn it rode in on.
- CLI model turn: the per-request injection point; safe mode unchanged.
- CLI session: the attached Session holds the fetched text for its lifetime.
- Core and Java: unchanged.

## Validation and acceptance

Turn-level tests pin: the two reads happen on the first acquisition and never
again for the attached Session; a missing file contributes nothing; a
transport failure neither blocks nor fails the turn. Model-level tests pin the
injection order — pre-fetched context is set before the first request, and a
fetch landing mid-turn is set before the next request. Session-level tests
keep their recovery and redispatch guarantees, with the context reads named
explicitly where dispatch counts are asserted.

## Risks and open questions

The two reads pay the full durable prepare/execute cost once per attached
Session; a lighter read-only dispatch is tracked separately. Whether the
context should be pinned durably (and revisioned through the ContextBinding
contract) remains the maintainers' call; the injection point built here does
not change under either answer.
