# Deterministic parallel review dispatch

[English](review-parallel-dispatch.md) | [简体中文](review-parallel-dispatch.zh-CN.md)

## Problem and current behavior

PR #11495's automated review ran fifteen foreground agents sequentially and
exhausted its six-hour budget. The scheduler supports concurrent agent calls,
but the review asks the model to emit every call in one response. A model or
endpoint returning one call per response turns that instruction into serial
execution. Ordinary background defaults do not apply because review agents
explicitly request inline results and use a caller-owned worktree.

The repository already has `review emit-workflow` and a fixed `parallel()`
script. The skill does not use them. The emitter excludes territory reviews,
and generic workflow defaults allow only ten minutes per agent and thirty
minutes per run, below the observed review durations.

## Goals and scope

- Dispatch independent review agents through a fixed workflow, including
  initial rosters and verification/reverse-audit waves.
- Preserve required roles, exact prompts, worktree ownership, transcript
  evidence, coverage checks, and the existing audit convergence rules.
- Preserve sequential dependencies between preparation, dispatch, aggregation,
  and cleanup. Concurrency is bounded; fifteen agents need not start at once.
- Do not change model selection, provider request parameters, findings policy,
  generic workflow defaults, or daemon routes.

## Design

### Builders and batch selection

Use the existing emitter for the initial roster. Add an opt-in manifest output
to `agent-prompt` for subsequent waves. A successful build returns its plan
identity and exactly the prompt-record keys it built. A budget or convergence
refusal produces no manifest. The emitter can combine these manifests, validates
their plan identity, rejects duplicate or missing records, and reads the exact
recorded prompts. It never discovers a wave by globbing historical records.

Keep the existing text output for callers that have not adopted manifests.
Give generated scripts a content-derived identity so later waves cannot
overwrite the script a previous run's resume handle names.

### Availability

Invoking the trusted bundled review skill enables workflow dispatch for the current
top-level session before the skill body reaches the model. The shared skill activation path
covers slash commands and model-invoked skills. Registration retains existing tool
permissions, bare/provisional restrictions, an explicit false workflow setting,
and the workflow kill switch. Unset settings stay distinct from false, including
on settings reload. A failed activation keeps the first load retryable; a failed
refresh of an already loaded skill reports that failure alongside its loaded
status without appending the body again.
Other sessions remain opt-in; a disabled tool is not silently replaced by serial
agent calls.

### Runtime limits

Classify generated review scripts by their canonical location under the
generated workflow review directory and the filename's content digest, not by
model-authored metadata. Hash the exact source already loaded for execution so
a second file read cannot validate different bytes. This detects modified
content under an existing name; it does not authenticate a writer with access
to the directory. Path-probe failures use generic limits, while an expired
review deadline still refuses dispatch. Reuse the
existing workflow dispatcher, queue, sandbox, transcripts, and failure handling.
The review profile supplies finite defaults of 500 turns and 100 minutes per
agent, a six-hour workflow limit, and ten concurrent agents, independent of CPU
count because the work primarily waits for model responses. Honor explicit
operator workflow limits: workflow concurrency takes priority over tool concurrency,
and an explicit limit of one intentionally serializes the queue. When a valid review deadline exists, bound the run's
launch-time allowance by the remaining time minus the compose reserve floor.
This does not replace the outer CI timeout or guarantee an absolute deadline
across interactive pauses.

Generic workflows retain their current defaults. Pass the selected bounds
through the existing host interfaces to both dispatch paths and the sandbox.
Remove the emitter's territory-only exclusion once the profile is in place.

### Skill integration and results

The skill builds a complete wave, asks the emitter for one script, and makes one
foreground workflow call. Initial review agents run together; verification
shards and the independent next audit wave share their existing prescribed
batch. Dependent later rounds still wait for aggregation.

Use the existing delivery guard and coverage gates. A failed or empty agent is
reported as missing, never as a successful clean review. Recover completed work
from the existing workflow journal/transcripts before retrying missing work.
The caller retains the worktree until the foreground workflow has settled.

## Affected components

- CLI review prompt builder, emitter, generated script, and their tests.
- Workflow runner/orchestrator limit plumbing and their tests.
- Shared skill activation, workflow registration, and their callers/tests.
- Bundled review skill and the review deadline concurrency estimate if needed
  to match the selected runtime window.

## Risks and validation

Incorrect manifest selection could omit a role or rerun an old finding. Test
cross-plan manifests, stale/missing records, duplicate keys, refused builds,
and immutable script identities. Verify ordinary workflows retain their limits.
Preserve existing transcript discovery instead of introducing another evidence
format.

Use a localhost mock with no credentials. Hold two independent agents behind a
barrier and require both to start before either is released; a serial loop must
fail this test. Exercise the generated script with a missing result and check
that the review cannot silently succeed. Run build, typecheck, focused tests,
and the E2E plan, followed by repeated reverse audits until two consecutive
rounds find no new actionable issue before committing.

## Acceptance criteria and open questions

The model can issue one workflow call and the runtime launches the full selected
wave concurrently within its configured window. Prompts and coverage evidence
remain identical to the existing builder output. Verification/audit manifests
select only the intended wave. Failures remain visible and scripts remain
resumable. No open product decisions remain; implementation findings may refine
the internal integration while keeping both language versions synchronized.
