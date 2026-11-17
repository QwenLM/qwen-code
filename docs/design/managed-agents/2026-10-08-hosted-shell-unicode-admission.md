# Hosted Shell Unicode admission

[English](2026-10-08-hosted-shell-unicode-admission.md) | [简体中文](2026-10-08-hosted-shell-unicode-admission.zh-CN.md)

## 1. Status and evidence

This is the fix design for [#13010](https://github.com/QwenLM/qwen-code/issues/13010),
dated 2026-10-08 and implemented in the local workspace. Section 9 records the
local verification. It does not represent production release authorization, and
the issue is not closed.

Two rounds of design audit are complete: round 1 found two problems, both
revised; a fresh round 2 found no new substantive problem. This does not mean
runtime acceptance passed.

The issue and its full comment history were read through `gh`. The historical
evidence is the
[O2 round 9 report](https://github.com/QwenLM/qwen-code/pull/12894#issuecomment-5888143498)
on `3da25b7c`: an unpaired surrogate in Shell arguments blocked both capture
paths, and a second Session on the same Workspace still received
`workspace_busy` after eight minutes. That report and its log links should be
kept. The report did not run an independent main build, so it is not a
reproduction on current main.

The source review is based on local `040f06c7b141235153d69c3c795da9f8550eb900`.
Upstream main was `fe4d4e345c3f52fd6d8455646cdd3c782ca8b227` when queried; the
GitHub comparison shows that `hosted-workspace-tool-turn.ts`,
`hosted-workspace-broker.ts` and `managed-tool-protocol.ts` did not change
between the two. Hook lifecycle code and tool-turn tests did change; the work
was fast-forwarded to that upstream main before implementation and those changes
were read. Runtime reproduction and implementation evidence are in section 9.

Baseline facts before implementation:

- `HostedWorkspaceToolTurn.executeNative` builds both the local capture and the
  O2 publication request in one place. It checks Shell argument shape, but not
  UTF-16 well-formedness.
- When a batch has a `validationError`, the existing path already persists the
  assistant message and paired tool errors without acquiring a lease or
  executing. O2 now uses this path as well; the historical O2 behaviour of
  throwing a plain validation error is obsolete.
- `PermissionRequest` currently runs before `prepareRequests`. `PreToolUse` runs
  after the lease is acquired and can rewrite arguments, after which
  `prepareRequests` runs again. `execute` also calls `completeHookResults`,
  which includes `PostToolBatch`.
- `/runtimes:warm` already starts at construction. An earlier prompt Hook or an
  earlier valid batch may already hold the Workspace lease.
- Java `BrokerValues` and the Broker/transport already reject incomplete text,
  but a late rejection does not replace the early, durable, model-correctable
  refusal this issue requires.
- `packages/core/src/tools/managed-shell.ts` from the comment no longer exists;
  the suggested `hasUnpairedSurrogate` is a private function of the
  external-context integration and cannot be imported across packages.

## 2. Problem, goals, and scope

JSON arguments can carry an escaped, unpaired UTF-16 high or low surrogate. After
parsing succeeds, a later encoder or the Java boundary may reject or replace the
value. If an execution owner was already acquired, the uncertain outcome keeps
the Workspace fenced. A malformed Shell call must therefore be rejected before
it enters that execution chain.

Goals:

1. On both Hosted Shell capture paths, reject an incomplete `command` and a
   string `description` before acquisition and reservation of the refused batch.
2. Give the model a durable, ordered, correctable function error; a corrected
   call later in the same turn can execute.
3. Preserve valid Unicode and the algorithm and bytes of the canonical digest.
4. Cover Hook rewrites so that incomplete Shell input cannot reach a later
   command Hook or the Runtime.
5. Keep blocking on uncertain persistence and on side effects that were already
   admitted.

Scope is Hosted `run_shell_command` `/1`, `/2`, local capture, and O2. When the
existing H3 branch is selected, the same field check must not disappear, but this
fix does not enable background Shell. Ordinary CLI Shell, Monitor, MCP
arguments, other file-tool text, general JSON validation, recovery of already
stuck Sessions, public Shell admission, and a new protocol version are out of
scope. Valid unrelated tools keep their current behaviour.

## 3. Chosen approach

Add one small pure Shell-text validator in
`packages/cli/src/serve/hosted-shell-input.ts`, consumed by the two real callers:
the tool turn and the Hosted Hook session. Do not export it from core and do not
build a general sanitizer. Keep the existing type, required-field, and profile
checks. Detect unpaired surrogates in string fields with
`/[\uD800-\uDFFF]/u`: the Unicode flag makes a valid surrogate pair one
supplementary-plane code point, so it does not match the surrogate range. The
`u` flag must not be omitted.

Use fixed error messages that name only the field and never contain its value:

- `Hosted Shell command contains an unpaired UTF-16 surrogate. Provide valid Unicode and retry.`
- `Hosted Shell description contains an unpaired UTF-16 surrogate. Provide valid Unicode and retry.`

Do not trim, normalize, delete, or replace code units. The printable six-character
`\ud800` sequence is valid text; a parsed unpaired `\uD800` code unit is not. An
omitted or empty description remains valid. A missing or non-string command and a
non-string description keep their existing errors; unknown keys and other shape
problems keep being rejected by the existing validation.

Reject instead of replace: changing command bytes can change side effects and
breaks the correspondence among input, approval, and execution. Keep
`managedToolDigest`, the payload JSON, Tool v3, Java validation, and the resource
schema unchanged. Do not migrate the integration's private function into core
just to reuse this one check.

## 4. Admission and Hook order

Use the following order and keep the existing profile/identity, truncated
argument, and inline-size refusal semantics:

1. Check the model's Shell text before `PermissionRequest` and before any Hook
   that carries arguments. If any call fails, refuse the whole batch through the
   persisted argument-refusal path, including valid siblings.
2. An initially Unicode-refused batch runs no command Hook and no approval
   Action, and skips the post-tool callbacks in `completeHookResults`, including
   `PostToolBatch`. The shared completion entry still rebuilds the refusal
   evidence, and its callbacks do not receive the original incomplete command.
3. Inside `HostedHookSession.fireOccurrence`, after each successfully applied
   sequential Hook result, validate the effective Shell input before admitting
   the next Hook. Cover the `tool_input` merge performed for `updatedInput` and
   `sequentialInput`, not only the final aggregate. Stop at the first invalid
   effective input even if a later Hook could repair it. Keep the results of the
   children that already ran and the original plan, aggregate the executed
   prefix through the existing result resource, and return its invalid effective
   input so the tool-turn validator produces the fixed, model-correctable
   error. Do not add a general interrupt, do not end the whole model turn, and
   do not admit a later child.
4. `settleSavedMarker` must rebuild the same ordered prefix and stop condition
   from the saved child results, and evaluate the stop condition before looking
   for a later child. Then, if the process crashes after an invalid child result
   is saved but before the plan marker result is committed, the marker can be
   finished from that prefix instead of waiting forever for a child that was
   deliberately not created. When an earlier child result is uncertain, keep
   blocking under the existing rule. Parallel Hooks keep receiving the original
   input and are validated on the final aggregate before native execution; do not
   cancel admitted sibling Hooks and do not change their ordering.
5. When `PermissionRequest` returns `updatedInput`, validate the effective Shell
   text again before publishing the approval input or native acquisition. A
   malformed rewrite refuses the whole native tool batch. The Hook itself may
   already have acquired the Runtime; keep the existing owner and let normal
   settlement handle it.
6. Check again in `prepareRequests`, including the call after `PreToolUse`. If a
   Hook introduced incomplete text, ask for no approval, reserve no publication,
   and start no native tool in that batch; refuse every call. Acquisition,
   publisher registration, or the first approval may already have happened, so
   do not claim the batch was completely inert, and do not force-clear the owner.
7. For a Unicode refusal caused by a Hook rewrite, do not forward the incomplete
   effective arguments to a post-tool callback; skip that batch's post-tool
   callbacks, keep the committed Hook decisions and results, and persist the
   tool refusal normally. Do not fabricate an executed tool intent for a refused
   call.
8. Only effective input that passes validation enters the existing
   reservation/start path. The rule that a valid rewrite is re-approved stays
   unchanged.

Reuse the existing batch-refusal persistence logic, extracting it only where
these entries need it. A refusal before the assistant message is committed writes
the assistant once and one ordered response per call; a refusal after the
assistant message is committed writes only the responses and must not append a
second assistant message.

Do not rely on a transient flag to skip post-tool callbacks. At the
`completeHookResults` entry shared by live `execute` and cold resume
`resumeHookResults`, rebuild the original assistant group and that batch's saved
`PermissionRequest`/`PreToolUse` results from the original occurrence/call
identity, and restore the effective input by the same rules used at admission,
including a prefix terminated by the Unicode check. Return the saved responses
and run no callback and re-commit no assistant/result only when invalid Shell
text, a complete paired refusal group, and the absence of native tool intents for
the batch together prove a Unicode refusal. Do not decide from the error string
alone and do not skip every batch that has no intent; an ordinary
argument/approval refusal keeps its current post-batch behaviour. Contradictory
native intent or an incomplete refusal record is a recovery error, not evidence
of a safe refusal. No new persisted flag or schema field is needed; the next
valid batch decides again from its own records.

## 5. Persistence, ownership, and compatibility

Error responses contain only the fixed reason, the original function-call
identity, and the existing response shape; valid siblings receive the existing
explicit not-executed error. Error messages and diagnostics do not echo the
invalid field value. Persist the original assistant function-call group through
the existing JSON-escaped record without rewriting the original command and
without claiming it executed. Prove that the group persists byte-for-byte and
reloads using the real Java Store, not only an in-memory TS mock.

For a fresh refusal batch without Hooks, require zero acquire, zero publisher
registration, zero publication reservation, zero prepare, zero start/execute,
and zero worker side effects. Runtime warming happens before the model output;
allow it and record it separately. The approach therefore does not promise
completely zero Broker HTTP traffic or stop independent provisioning.

A later invalid batch must not acquire, reserve, or start again, but it may
inherit the lease held by earlier valid work. Normal final settlement releases
the owner; the validator neither releases the owner nor rewrites an existing
execution to `not_started`. When the refusal commit succeeds it is a
model-correctable result, not recovery-blocked; when the assistant or result
commit fails and the outcome is uncertain, keep the existing recovery blocking.
A Shell that did not execute cannot prove journal consistency.

An incomplete command is rejected before its approval, and no approval is
created for that command. No configuration, migration, public DTO, protocol
version, new error-code enum, or Shell capability enablement is needed.
Subsequent source implementation must follow the maintainer review rules for
core and cross-package changes; this design is not PR approval and does not
authorize rollout.

## 6. Implementation and verification plan

Before implementation, a read-only `test-engineer` reproduces the issue with an
independent real Java Store/Broker/Harness/worker environment on a build of main
at that time. Try the installed global `qwen` first; when a private profile is
unreachable, record it as unavailable and do not count it as a baseline pass.
Use a deterministic model fixture to cover local capture and O2 separately;
input-admission tests do not need a real OSS bucket. Save the round 9 logs and
the new exact-head before/after results, and put the E2E plan and report in
`.qwen/e2e-tests/`.

Main implementation/test files:

- `packages/cli/src/serve/hosted-workspace-tool-turn.ts`.
- `packages/cli/src/serve/hosted-shell-input.ts` and its collocated tests.
- `packages/cli/src/serve/hosted-hook-session.ts` and tests, changing only the
  Shell effective-input boundary and saved-marker reconstruction.
- `packages/cli/src/serve/hosted-workspace-tool-turn.test.ts`, plus Hook tests as
  needed to prove callback order and suppression.
- A native Hosted integration fixture that covers real Java persistence, file
  side effects, and a second Session on the same Workspace. After rebasing,
  choose an existing driver that really drives both capture paths; do not add a
  second production admission entry just to test this fix.

| Test                      | Evidence that must be provided                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unicode negatives         | Both fields, both paths: unpaired high/low surrogate, high surrogate followed by ASCII, reversed pair, high-high, low-low, valid pair followed by an unpaired surrogate. Cover any position, including after a valid emoji.                                                                                                                                                                                                                                                                                                   |
| Unicode compatibility     | ASCII, Chinese, supplementary-plane emoji, valid surrogate pair, combining characters, ESC, U+0001, DEL, U+2028/U+2029, and the literal `\ud800` in command/description keep byte-identical bytes; command semantics stay unchanged.                                                                                                                                                                                                                                                                                          |
| Batch refusal             | Invalid call first/last, mixed with valid Shell and Write; all errors persisted in order, every sibling explicitly not executed, no tool intent and no publisher reservation.                                                                                                                                                                                                                                                                                                                                                 |
| Correction                | A call corrected in the same turn executes exactly once; the result reaches the next model request; final settlement succeeds and reload and later turns work.                                                                                                                                                                                                                                                                                                                                                                |
| Ownership                 | A new refusal holds no Workspace lease and a valid call in a second Session completes; a later refusal with an existing lease keeps the owner until normal settlement.                                                                                                                                                                                                                                                                                                                                                        |
| Persistence failure       | Fail the assistant/result write separately and lose the response of a committed operation; no execution, no false success, existing recovery blocking kept, no duplicated history.                                                                                                                                                                                                                                                                                                                                            |
| Hooks                     | The original invalid input reaches no permission/pre/post/batch Hook; an invalid `PermissionRequest` or `PreToolUse` rewrite cannot native start or reach a later callback that carries invalid arguments. A real two-Hook ordered plan covers `updatedInput` and the `tool_input` merge: H1 introduces invalid text, H2 is never admitted even if H2 could repair it. A crash after the H1 result and before the marker result resumes the marker without the H2 child; a valid rewrite is still re-approved and reaches H2. |
| Hook cold completion      | Reload the original invalid and Hook-rewritten refusal groups and Hook records into a new tool turn, call the real `resumeHookResults` caller, and prove no post-batch callback, no duplicated history, and no native operation. Ordinary refusal replay and the next valid batch keep their current behaviour.                                                                                                                                                                                                               |
| Store and model transport | The real Java Store persists and reloads the original escaped assistant group and paired errors; the deterministic model receives them and corrects the call. Acceptance fails if encoding changes or transport rejects the group.                                                                                                                                                                                                                                                                                            |
| Limits and identity       | Existing inline-size, unsupported-tool, duplicate-call, and incomplete-argument guards still apply; correctness is not promised when the existing limits are exceeded.                                                                                                                                                                                                                                                                                                                                                        |
| Regression and mutation   | Existing local/O2 refusal, approval, capture, and Hook tests pass; removing each admission check and each callback-suppression check must fail the corresponding negative case; removing the `u` flag must fail the valid-emoji witness.                                                                                                                                                                                                                                                                                      |

Run these in the respective package directories:

```bash
# Repository root
npm run build && npm run typecheck

# packages/cli
npx vitest run src/serve/hosted-workspace-tool-turn.test.ts
npx vitest run src/serve/hosted-shell-input.test.ts src/serve/hosted-hook-session.test.ts
# Add the actually changed Hook/native driver suites, then the real-stack gate.
```

Section 9 records the checks that were completed. A catalog-only or worker-only
result cannot prove pre-acquisition admission; unrelated full test suites are not
required.

## 7. Acceptance and risk

The fix is complete only when every verification above passes on the same final
source version, both capture paths refuse invalid input before the first native
side effect, valid text keeps its bytes, the corrected call and the second
Session work, and a failed refusal persistence still blocks safely. Public Shell
enablement and recovery of historically stuck Sessions remain separate work.

The main risks are a wrong validator position relative to Hooks, post-batch
completion forwarding invalid input again, duplicated assistant commits after a
rewrite, and relying only on TS persistence evidence. Inline limits and side
effects already in flight can legitimately prevent a correctable continuation;
this must be recorded explicitly.

Writing this design needs no additional product decision. Before source
delivery there must be a current-main reproduction and Java byte-for-byte
round-trip evidence; any failure must change the implementation/design, not
silently replace the invalid command or claim the issue is fixed.

## 8. Independent audit record

The user asked for a fresh Sub Agent audit and reverse audit each round, updated
between rounds, for at most seven rounds. Each round checks both whether the
approach can close the issue and whether the new refusal/ordering breaks valid
behaviour or makes a verification claim unprovable.

| Round | Problem and resolution                                                                                                                                                                                                                                                                                                                                                              | Result                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1     | The new auditor audit_round_1 found sequential Hook propagation before the outer check (P1) and lost callback suppression on cold recovery (P2). Added the shared Hosted validator, sequential-prefix terminal reconstruction, persisted completion decision, and the corresponding negative/compatibility witnesses.                                                               | Both accepted and revised; round 2 independently re-checked them.                          |
| 2     | The new auditor audit_round_2 independently checked the issue/source, auditing forward behaviour and reverse compatibility/recovery negative cases. No new substantive problem was found; the round 1 revisions covered the risks. The report keeps the implementation constraints for the event return shape and nested `PermissionRequest` without widening valid Hook semantics. | Met the user's "no new problem" stop condition and ended the audit loop (max 7, actual 2). |

Local audit reports: `.qwen/pr-reviews/issue-13010-design-round-1.md` and
`.qwen/pr-reviews/issue-13010-design-round-2.md` (git-ignored working artifacts).

## 9. Implementation and local verification

The implementation uses the shared pure validator before the permission Hook and
in request preparation, terminates an incomplete sequential Hook prefix on both
the live and saved-marker paths, and rebuilds the persisted Unicode refusal
evidence before callbacks. It shares the existing ordered refusal path; it adds
no persisted schema, core validator, digest algorithm, or production Java
protocol.

Before the fix, a build of main admitted a U+D800 command to
acquire/prepare/start on the local path and still had an active prompt after 30
seconds. Eight controlled source fallbacks independently observed acquisition.
The early O2 fixture lacked a publication endpoint, so its recovery block alone
cannot prove Unicode caused the lockup. These observations did not reproduce the
historical eight-minute incident.

The final real-process Maven verify gate passed both the local and O2 parameters.
Each path covers eight incomplete command/description batches and one more batch
that is refused and then corrected in the same turn. The model checks the
original arguments and ordered paired errors before and after detach/load. The
Broker and Store proxy observe no native admission or publication request for a
fresh invalid batch; the primary Session's SQL execution ledger has exactly one
execution, the corrected one. A second Session on the same Workspace completes a
valid call on both paths.

This stack uses temporary H2, an Embedded Broker, and a real Node worker
process. O2 uses the real Java SQL grant/data services and publication
controller, with an in-memory test adapter for the object store; this is not
MySQL, OSS, or Linux isolation acceptance. Controlled CLI regression separately
covers `/1` and `/2`, both capture paths, invalid first/last calls mixed with
valid Shell/Write siblings, persistence failure and lost replies after commit,
retention of an existing owner, real Hook rewrites, and cold completion. Seven
mutations (original admission, permission rewrite preparation, `PreToolUse`
rewrite, live/cold sequential stop, callback suppression, Unicode flag) each fail
their witness. Source was restored verbatim before the final regression.

Exact commands, environment, success conditions, results, and troubleshooting are
in the [local E2E guide](../../../HOSTED_SHELL_UNICODE_E2E.md). The local
implementation code review has no Critical and two E2E Suggestions, both accepted
and fixed.
