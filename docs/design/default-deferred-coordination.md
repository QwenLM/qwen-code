# Default deferred coordination tools

[English](default-deferred-coordination.md) | [简体中文](default-deferred-coordination.zh-CN.md)

## Status and problem

Candidate for #12326 under #12028. Agent and Goal declarations are paid for even
in sessions that never delegate or use a Goal. Earlier explicit `tools.eager`
experiments do not measure this candidate's savings or natural discovery rate.

## Decision and scope

Mark `agent`, `list_agents`, `get_goal`, `update_goal`, and `propose_goal` as
natively deferred. Reuse the existing short discovery catalog and
`tool_search` → `tool_call` bridge; do not introduce settings, change schemas,
remove tool instructions, or change execution and approval semantics.

Common file tools remain unchanged. `tools.eager` retains its existing meaning;
listing a natively deferred tool there does not force it resident. `tools.visible`
can force a declaration up front. Existing preload behavior and eager fallback
when either bridge half is unavailable still apply. Code Mode keeps its existing
discovery path. Declared-tool system-prompt gating still applies, with one
added input: Agent reachability. The Subagent Delegation and Codebase Search
lines survive when `agent` is declared, or when it is registered behind both
bridge halves and listed in the deferred summary. Reachability satisfies only
the Agent prerequisite; Codebase Search still requires declared `grep_search`
and `glob`. An Agent withheld from the
eager reveal in an incomplete-bridge session is neither, so both lines drop. No
other gated line gains an exception, and no further prompt-trimming policy is
added. Memory, history, and the schemas that subagents receive are unchanged.

ACP batches resolve a bridge call's target before applying the existing
Agent-only concurrency rule. Bridged Agent results retain the immediate todo
reminder using their validated execution observations; other bridge targets
keep their existing scheduling and reminder cadence. Keyword discovery filters
out declarations that are unavailable in the current context before applying
`max_results`, including Goal proposal when its host turn key is absent.

Shared Goal continuation instructions name the discovery and invocation path
for hidden `get_goal` and `update_goal`: `tool_search` then `tool_call` in Direct
mode, or the returned JavaScript binding through `exec` in Code Mode. This
applies to ordinary, objective-updated, and wind-down turns on every host.

Agent and message descriptions, and the recovered-agent model notice, also
explain how to discover a missing `list_agents` in Direct mode. Reuse the
conditional bridge sentence so eager visibility and later reveals remain valid;
no registry predicate or execution policy changes are needed.

All five recording sites classify Goal discovery from the finalized returned
schemas, not the query spelling. A complete result containing only `get_goal`,
`update_goal`, or `propose_goal` declarations is Goal runtime bookkeeping,
including keyword discovery and Code Mode's invocation hint. Mixed work
schemas, capability diagnostics, and incomplete or unreadable results retain
ordinary tool-result provenance for the verifier.

## Risks and acceptance

An extra discovery request can offset the first-request saving. Natural
delegation and Goal completion must not become less reliable. Before this
candidate leaves Draft, compare the same model, settings, workspace, memory,
and prompts on the base and candidate, with no `tools.eager` override:

1. A greeting and an ordinary read-only file question: compare actual first
   request schemas, provider input/cache usage, and total per-task input.
2. An independent multi-part investigation, without naming tools: verify Agent
   discovery, launch, result retrieval, and successful final answer.
3. A user-requested Goal: verify proposal consent, progress, completion evidence,
   and verifier outcome through the bridge; refusal must not start a Goal.
   Hidden Goal tools must have actionable continuation instructions on every
   host, including objective-updated and wind-down turns.
   Goal-only discovery must stay out of external-fact evidence regardless of
   quoting, casing, or search mode; mixed work and missing-capability results
   must remain in the evidence window.
4. `tools.visible`, a disabled bridge, denied tools, and a resumed direct-call
   history: verify the existing visibility and permission contracts.
5. ACP direct and bridged Agent calls: verify concurrent delegation and the
   immediate todo reminder. Non-Agent bridge calls remain sequential and do not
   force that reminder. Goal keyword search must follow turn-key availability.
6. A settings file with a nonzero `tools.toolSearch.threshold`, shaped like a
   real deployment: record `/context` and the first request's schemas on the
   base and the candidate, and state whether the deferred pool still fits the
   preload budget (the whole pool is revealed) or now reveals none of it, since
   the preload is all-or-nothing over the whole pool and this change adds five
   large declarations to it. Report this separately from the discovery-overhead
   line below.

Keep raw requests and task outcomes, not only declaration character counts.
Report regressions and discovery overhead separately; do not claim a percentage
from the earlier allowlist experiment. #12333's external benchmark-pool overlay
is separate infrastructure, not a new unused input in this repository.
