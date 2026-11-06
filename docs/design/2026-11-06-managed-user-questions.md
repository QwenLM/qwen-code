# Managed structured user questions

[English](2026-11-06-managed-user-questions.md) | [简体中文](2026-11-06-managed-user-questions.zh-CN.md)

Status: implemented and locally verified, including MySQL with a forced Harness
restart and Java service context restart while waiting. Full CI and
deployed-service acceptance remain pending.

## Problem and current state

Before this change, the daemon offered `ask_user_question`, but ordinary Hosted
tools did not. The public and WebShell contracts described question Actions as
planned. The Java projection, response outbox, SDK connector and WebShell accepted
only permission Actions. Permission waits already persisted an Action and a native
batch continuation, fence stale writers and resume the same wait after takeover.

The change must make a model question durable before presenting it, preserve
the answer across delivery failures, and continue the original tool call once.
Reloading the page must rediscover the question without replaying a prompt.

## Scope

Support root Sessions on ordinary `hosted-workspace-files/1`, `/2`, `/3` and
`hosted-workspace-shell/1`, including public Plan mode. A question is the only
tool call in its batch. Reject mixed batches before executing any sibling.
Initially omit the tool from MCP/Hook Sessions, foreground-only workers,
resident CSI profiles and child Sessions because their continuation contracts
need separate qualification. Existing permission behavior remains compatible.

Match the native input vocabulary: one to four questions, each with `question`,
`header`, two to four options containing `label` and `description`, and optional
`multiSelect`. Optional `metadata.source` is descriptive only. Questions are
required and always permit custom text. Single choice accepts either one option
or custom text; multiple choice permits several options and custom text.

## Design by layer

| Layer          | Change                                                                                                                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted tools   | Declare and validate the tool on eligible profiles. Persist its assistant batch, input, definition and native continuation before committing a `question` Action. Wait even in `yolo` and `auto` modes.                                                                                              |
| Durable Action | Preserve permission options versions 1–3. Add question options version 4 with the existing identities, revisions, timestamps, `inputRef`, `continuationRef`, `requiresHumanDecision: true`, `policyRevision: hosted-user-question/1`, and `questions`. Keep the existing opaque Action ID namespace. |
| Answer         | Persist decision version 2 with `answers`, `inputRevision` and `policyRevision`. Each answer has `questionId`, optional `optionIds` and optional `text`. Canonicalize in original question/option order so reordered selections have identical decision bytes.                                       |
| Java           | Validate the question projection and answer against the original options. Reuse actor-scoped idempotency, authorization, reservation, `ACTION_RESPONSE` outbox and durable decision receipts. No schema migration or new queue/table.                                                                |
| SDK            | Deliver structured answers through the existing resolve endpoint. Preserve the existing permission overload.                                                                                                                                                                                         |
| WebShell       | Project question Actions, render a form using existing primitives, submit stable IDs and retain the draft during uncertain/failed delivery. Reload fetches pending Actions.                                                                                                                          |

Generate question IDs `q1` through `q4`, and option IDs `q1o1` through `q4o4`
from the immutable input order. Labels never act as identity. The public API
uses snake_case; WebShell and private resources use camelCase. Reuse the
planned question schemas and add source/tool identity fields where needed.

Bound question prompts to 2048 characters, labels to 256, descriptions to
1024, and answer text to 8192. Limit serialized tool input to 16 KiB and
canonical answers to 32 KiB, keeping options, decisions and continuation
resources within the existing 64 KiB limit. Invalid or oversized model input
returns a tool error before the wait. Invalid answers leave the Action pending.

## Lifecycle and recovery

Use the existing approval timeout and requested/decided/cancelled/expired
states. A question cannot be answered by policy changes, an allow rule, a
classifier or an approval button. The answer must validate IDs, cardinality,
text eligibility, input revision and policy revision. A repeated equivalent
answer returns the original result; a conflicting answer cannot replace it.

Reuse the existing native continuation descriptor and original Runtime binding;
question execution itself creates no Runtime tool execution. On restart, verify
the saved input/definition and question decision, resume the same Action ID,
and commit the original call's result before the next model request. A crash
after decision but before the result must reuse the stored answer. Cancellation
and expiry settle the existing wait without inventing an answer. Writer lease,
activation and Workspace generation checks remain in force.

The browser computes a bounded idempotency key from canonical structured
answers and Action/revision identity. It does not store answer text in the key
or browser storage. It uses the repository's pinned browser SHA-256 library so
ordinary LAN HTTP works without Web Crypto. An in-flight guard prevents duplicate clicks. Failed or
unconfirmed delivery keeps the exact draft available for retry; success hides
the question after the durable response operation confirms completion.

## Affected sources and consumers

- Hosted declaration/execution and approval helpers, native batch continuation,
  Harness resume and their focused tests.
- Java Action projection/repository/service/controller, journal reader-version
  promotion, recovery reference validation and tests.
- Hosted Java SDK client and connector, with permission compatibility tests.
- Public OpenAPI and generated WebShell types, provider/hook, question form,
  Sessions page, translations and tests.
- Capability documentation and the Managed server README.

## Validation and acceptance

Dry-run the test plan against global `qwen` before implementation. Use a
deterministic model fixture to request the exact question tool; fixture success
does not establish real-model or deployed-service acceptance.

Acceptance covers single/multiple/custom answers, duplicate labels, all approval
modes, Plan, required answers and size limits; refresh before answering; Java
and Harness restart while waiting and after decision; same-answer retry versus
conflicting answers; cancellation/expiry; tenant/actor isolation and unchanged
permission Actions. Focused UI and adapter tests verify request shape and draft
retention. Real-process and MySQL evidence must be identified separately.

Run root build/typecheck/bundle and affected TypeScript tests. Follow the Java
module's shared ten-minute local verification budget, including prerequisites;
leave full Maven, MySQL and Hosted/fault gates to CI where local evidence is
unavailable. Read the full diff until two consecutive clean self-audits, then
perform independent review. Report unrun checks explicitly.

Local verification passed root build/typecheck/bundle, focused UI, SDK and Java
tests, and the affected permission/native-continuation regressions. The selected
MySQL 8.4 test force-kills the packaged Harness, restarts the Java Spring context
in the same test JVM and starts a replacement Harness, reloads
the original pending question, answers it and observes exactly two model requests
and no Runtime tool execution. It uses a deterministic model fixture. Recovery
after a persisted decision is covered by the local journal takeover tests;
the corresponding real-process fault case, Java process crash, full profiles,
SpotBugs, complete browser acceptance and real-model/deployed-service acceptance
remain pending. A Chromium probe verifies that ordinary HTTP and localhost
produce the same answer key, including Unicode and reordered selections.

## Risks and open questions

The main risks are cross-language decision canonicalization, accidentally
auto-answering questions, and recovering after the decision/result boundary.
Tests must exercise these boundaries rather than only schema acceptance.
There are no unresolved product decisions for this scope. Broader profile and
mixed-batch support are follow-up work, not silently advertised capability.
