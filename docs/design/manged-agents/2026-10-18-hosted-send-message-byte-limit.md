# Recoverable Hosted send_message byte-limit refusals

[English](2026-10-18-hosted-send-message-byte-limit.md) | [简体中文](2026-10-18-hosted-send-message-byte-limit.zh-CN.md)

Status: implemented in the working tree within the bounded scope below; local verification complete, physical-stack acceptance unperformed. Updated: 2026-10-19.

## 1. Problem and evidence

[#14062](https://github.com/QwenLM/qwen-code/issues/14062) reports that a Hosted `send_message` can pass its raw UTF-8 limit and then fail the sender's entire Turn at `encodeToolInput`. The model receives no tool response with which to correct its arguments. A separate branch gap leaves a team member's `to: "parent"` without the raw-content check applied to an ordinary child.

This design is based on local HEAD `7d6dcc8c95ec85b94a1836de17f192c4a2a2113e` on `feat/managed-agents/mirror`. The worktree was clean before these documents were added. The baseline source map below pins this revision. GitHub state was read with `gh` on 2026-10-18:

- #14062 is OPEN, labeled `priority/P2`. Its body, all four comments, and the linked [real-stack report](https://github.com/QwenLM/qwen-code/pull/13955#issuecomment-6139614564) were inspected. The runtime results in those reports are their authors' evidence; this document does not claim to have reproduced them.
- [#13822](https://github.com/QwenLM/qwen-code/pull/13822) (H4d-b) and [#13955](https://github.com/QwenLM/qwen-code/pull/13955) (member messaging) are MERGED. Their routing exists in this checkout.
- [#14118](https://github.com/QwenLM/qwen-code/pull/14118) is OPEN, with head `96c0b290578e7cbcee29da6a2921f17d3fad3568`. Its production patch already proposes the two small changes below. Its report and reviews disclose a residual assistant-record overflow. It is a reference proposal, not an implemented or accepted upstream fix.
- [#14054](https://github.com/QwenLM/qwen-code/issues/14054) is the fault-gate umbrella; its FG9 tracker [#14164](https://github.com/QwenLM/qwen-code/issues/14164) is CLOSED. The [local FG9 design](../2026-10-15-session-relay-fault-gates.md) explicitly says its small fixtures do not exercise or fix #14062. FG9 completion is not acceptance evidence for this change.

One issue-comment sentence says “no message” can pass the raw check and fit the encoding. That is too broad: small messages fit both. The valid conclusion is that the 65,536-byte raw maximum is not a guaranteed usable message size; wrapper and escaping overhead consume the same inline budget.

## 2. Current execution and limits

### 2.1 Source map

| Source                                                                                                                                                                                         | Responsibility and observed behavior                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [hosted-harness-model.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/cli/src/serve/hosted-harness-model.ts#L719)                               | Copies the complete model parts, restores tool call IDs, calls `toolTurn.execute`, then feeds returned responses to the next model round.                                                                                                                          |
| [hosted-workspace-tool-turn.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/cli/src/serve/hosted-workspace-tool-turn.ts#L2943)                  | `prepareRequests` validates and encodes each call. Member routing starts at line 3380; the member branch bypasses the later raw-content check. The encode catch at line 3545 only recovers valid `workflow` calls, or calls already carrying a validation refusal. |
| [encodeToolInput](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/cli/src/serve/hosted-workspace-tool-turn.ts#L4791)                                | Encodes `{toolName,input}` into `payloadJson`, then encodes `{harnessSessionId,runtimeSessionId,payloadJson}`. Throws the private `HostedToolInputInlineLimitError` when those UTF-8 bytes exceed 65,536.                                                          |
| [hosted-harness-session.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/cli/src/serve/hosted-harness-session.ts#L3145)                          | Supplies the complete ChatRecord builder, durable commit callback and `messageFitsInline` predicate, including record metadata, model and all parts.                                                                                                               |
| [managed-session-message-record.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/core/src/managed-runtime/managed-session-message-record.ts#L32) | `MANAGED_SESSION_MESSAGE_LIMITS.maxContentBytes = 64 * 1024`.                                                                                                                                                                                                      |
| [managed-child-operations.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/core/src/managed-runtime/managed-child-operations.ts#L46)             | `MANAGED_CHILD_LIMITS.maxEnvelopeBytes = 32 * 1024`.                                                                                                                                                                                                               |
| [http-managed-session-store.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/core/src/managed-runtime/http-managed-session-store.ts#L58)         | `HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes = 64 * 1024`.                                                                                                                                                                                          |
| [hosted-session-message-session.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/cli/src/serve/hosted-session-message-session.ts#L128)           | `memberMessageContent` adds the sender header and footer measured by the member-envelope check.                                                                                                                                                                    |

The table records the pre-fix HEAD; its source permalinks stay pinned when implementation moves lines. Section 8 records the working-tree implementation and checks.

### 2.2 Content, encoded-input and transcript budgets

Let `R` be UTF-8 message bytes, `W` the member envelope bytes, `E` the exact bytes produced by `encodeToolInput`, and `A` the complete serialized assistant ChatRecord bytes. Acceptance requires every applicable bound. Passing the raw/envelope content bound does not guarantee that the exact encoded input or complete assistant record fits:

| Lane                                   | Local content bound today                                            | Delivery path after validation                                   |
| -------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Member → member / `"*"`                | `W <= 32,768`                                                        | `session_command` of kind `member_message`, then leader delivery |
| Member → `"parent"`                    | Missing                                                              | `session_message` to the lineage parent                          |
| Ordinary child → `"parent"`            | `R <= 65,536`                                                        | `session_message` to the lineage parent                          |
| Parent / lead → task or member / `"*"` | `R <= 65,536`, plus existing downstream envelope/routing constraints | Child funnel, team fan-out, or continuation                      |

All calls additionally require `E <= 65,536`. Their complete assistant record requires `A <= 65,536`; the cancellation response and eventual refusal/result record must also fit their own inline budgets. These checks use bytes, not JavaScript string length. Equality fits; the existing checks reject `>`.

The issue's JSON-array example is 32,501 raw bytes and 32,549 envelope bytes, but its reported encoded request is 71,710 bytes. Exact encoded size varies with Session IDs and normalized arguments. It must be measured by the actual encoder, not copied as a universal fixture constant.

### 2.3 Ordering and durable evidence

The ordinary path is:

1. Prepare arguments, validate and encode them.
2. Check the complete assistant record and cancellation records.
3. If any prepared request has a validation error, produce an error response for every call in that batch, check the full response record, commit assistant and tool result, and return to the model. Siblings get the existing “another call in the batch has invalid arguments” response.
4. Otherwise continue admission, commit assistant, apply approval and `PreToolUse`, and dispatch accepted calls. `PreToolUse.updatedInput` is re-prepared after the original assistant record is committed; revised validation errors become per-call refusals through the existing post-hook path.

`PermissionRequest.updatedInput` runs before the first preparation. It can therefore differ from the original assistant parts too. Both preparation passes must receive the same narrow overflow policy.

The assistant record is checked **after** initial preparation, not written before every encoding attempt. It is written before `PreToolUse` rewrites. A throw from initial encoding currently prevents even reaching the assistant-record check; recovering that throw can expose a second, independent assistant-record failure.

## 3. Goals and scope decision

For an otherwise valid native Hosted `send_message` whose assistant and refusal records fit, turn input-encoding overflow into a durable, call-associated `byte_limit` refusal. The model can shorten the message and retry in the same Turn. Fill the missing member→parent raw-content guard.

This is a deliberately bounded repair. A model-authored 65,400-byte ASCII message can overflow its complete assistant record despite fitting the raw-content limit. This design preserves that failure rather than truncating arguments or inventing transcript evidence. Such a message does **not** become recoverable merely by extending the encoding catch. A Hook can produce escape-dense effective arguments that fit its own resource limit but overflow the tool-input encoding, allowing an encoded-size refusal after a small original assistant record. A raw message above 65,536 bytes cannot arrive through the normal Hook path: [HostedHookSession](../../../packages/cli/src/serve/hosted-hook-session.ts#L90) caps serialized raw results and aggregate outputs at 60 KiB (61,440 bytes), before returning `updatedInput`. Oversized raw Hook results become `non_blocking_error`; oversized aggregates become a blocking `byteLimitOutput`. These existing Hook outcomes are not send-message recovery.

**Implementation scope accepted:** on 2026-10-19 the user authorized implementation of this bounded slice. Assistant-record overflow remains explicit. This does not establish full #14062 closure; requiring recovery of oversized assistant records would need a separate transcript-durability design.

Excluded from this slice: larger Store limits, externalized/chunked transcripts, argument truncation, automatic splitting or retries, new configuration, new public error schemas, changes to Legacy `send_message`, message/command relay semantics, and the later-Turn duplicate-send behavior discussed in #14063. No daemon route, ownership scope, Java schema, migration or core constant changes are proposed.

## 4. Proposed repair

### 4.1 Close the member→parent raw-content gap

Inside the existing member branch, after validating the nonempty text and before the member-envelope check, reject when `!memberMessageCommand && Buffer.byteLength(text, 'utf8') > MANAGED_SESSION_MESSAGE_LIMITS.maxContentBytes`.

Keep the existing raw-content refusal wording: `Hosted send_message message exceeds 65536 bytes.` Keep member-addressed sends on their 32 KiB wrapper bound. Preserve validation precedence for invalid recipient, self-send, `leader`, plan mode and unsupported keys. Do not move checks above these more specific refusals or replace the whole branch chain.

This raw guard is a domain bound, not an estimate of safe transport size. Model-authored input above it generally also exceeds the assistant budget. It restores domain-validation parity even though earlier transcript and real Hook budgets prevent a raw message above this bound from reaching a recoverable refusal in the normal path at this HEAD. An isolated direct-call or stubbed `Hook.fire` test can prove the guard and its precedence; it cannot prove production reachability or end-to-end recovery.

### 4.2 Reuse the encoding catch

In the existing `HostedToolInputInlineLimitError` catch, permit conversion when there is already a `validationError`, or the valid call name is `workflow` or `send_message`. Keep all other error types and valid tool surfaces propagating as before. Do not broaden the catch to every tool. No extra MCP condition is needed: [HostedMcpSession.toolName](../../../packages/cli/src/serve/hosted-mcp-session.ts#L1026) advertises and resolves MCP tools only as `mcp_<32-character digest>`, so a valid MCP tool cannot be named `send_message`.

Use `validationError ??=` so an existing recipient, raw-size, plan-mode or other refusal is preserved. For a new message overflow use:

```text
Hosted send_message exceeds the 65536-byte inline Session Store limit once encoded (byte_limit); shorten the message or other arguments and retry.
```

A member-lane send names the bound that lane actually enforces. It has already fit the 32768-byte member wrapper, so an encoder overflow there comes from escape inflation rather than from the raw message size:

```text
Hosted send_message to a member exceeds the 65536-byte inline Session Store limit once encoded (byte_limit) although it fits the 32768-byte member wrapper; shorten escape-dense content and retry.
```

Keep the existing `workflow` text. `byte_limit` remains a token in the function error text, not a newly introduced response field. Keep the original function name and call ID through `convertToFunctionErrorResponse`.

Assign the existing `UNENCODED_TOOL_INPUT` sentinel only to a refused request. The sentinel must never be published, hashed as valid execution evidence, dispatched or used to mint delivery records. The current digest calculation hashes normalized `input`, not sentinel bytes. Initial validation refusal returns before capture; post-hook capture is excluded when Hooks are present, and reservation loops skip refused calls. Keep those boundaries and the empty-input capture exclusion intact.

### 4.3 Refusal, batches and retries

- On initial preparation, retain the existing all-batch refusal rule. If one message overflows, no sibling executes. Commit the original assistant and all paired error results only if their full records fit.
- After a `PreToolUse` rewrite, retain existing per-call refusal and sibling behavior. The original assistant stays intact; the effective oversized arguments must not reach the delivery funnel.
- A refused member send creates no `session_command`, no leader `msgc_` delivery and no command-wait entry for that call. A refused lineage send creates no `session_message`; a refused parent send creates no continuation `child_run` or fan-out deliveries.
- No new Broker execution or Workspace acquisition may be introduced by this repair. Constructor warming and already-run Hooks may exist; “no side effects” here means no message/command/continuation dispatch, not an empty journal or an absence of Hook activity.
- Return the refusal to the model. A shortened new call uses a new call ID and the existing delivery path. Replay of committed work retains its existing identity rules; do not automatically retry a message whose delivery outcome is uncertain.
- If assistant/refusal records exceed the inline budget, or a durable write fails, preserve the existing Turn failure or recovery-required behavior. Do not report an uncommitted refusal as successful recovery.

### 4.4 Why this approach

The encoder is already the exact size oracle. Catching its private size exception avoids a second serialization implementation, guessed byte headroom and per-lane threshold calculations. Lowering a fixed raw bound would unnecessarily reject otherwise storable escape-light inputs and still fail to model variable metadata. Raising Store limits or changing transcript storage crosses protocol and persistence boundaries that this small repair does not need to change.

Coordinate with #14118 rather than implement a second competing fix. Its name-based catch extension matches the verified MCP naming invariant and is sufficient for this scope.

## 5. Implementation and verification plan

Expected production edit: `packages/cli/src/serve/hosted-workspace-tool-turn.ts` only. Extend its command and session-message suites; use the existing workflow suite for regression coverage. Add a real Harness-level case using the existing model/Hook test seams for the transcript and retry claims. Update both H4d-b design languages at implementation time if their bounds/acceptance wording is changed; link this supplement rather than rewrite the historical architecture.

The following matrix is the acceptance plan. Section 8 distinguishes executed checks from remaining physical-stack acceptance:

| Case                                                                                  | Required oracle                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Member → member and member → `"*"`: issue JSON array or equivalent escape-dense input | Assert raw wrapper fits, exact encoded request exceeds the limit, complete assistant fits; get message-specific `byte_limit` with original name/ID; no commands or delivery records.                                                                                                                          |
| Member and ordinary child → `"parent"`: escape-dense text                             | Same recoverable refusal with no `session_message`; a shorter retry reaches the existing route.                                                                                                                                                                                                               |
| Parent/lead → `task_id`, named member and `"*"`                                       | Encoded overflow refuses before child routing, continuation or fan-out; no new delivery/child records. Use fixtures that pass recipient checks.                                                                                                                                                               |
| Raw member→parent guard                                                               | Isolate preparation using a direct call or stubbed `Hook.fire` returning a message above 65,536 bytes. Assert the raw refusal wins over encoding overflow, and ordinary-child parity. Explicitly record that this bypasses production Hook limits.                                                            |
| Real Hook encoding overflow                                                           | Use a small original assistant and escape-dense `updatedInput`; assert complete raw Hook result and aggregate output each fit 61,440 bytes while exact tool encoding exceeds 65,536. Verify the encoding refusal through real `PreToolUse`; oversized Hook outputs retain existing Hook error/block behavior. |
| Near-limit ASCII, `"x".repeat(65_400)`, member and ordinary child → parent            | Through the real complete-record predicate, assert assistant overflow remains a Turn failure and no message is minted. Never advertise this row as recovered.                                                                                                                                                 |
| UTF-8 and exact boundaries                                                            | Include CJK, emoji, quotes, backslashes, newlines and control characters. For the exact encoder, `E = 65,536` fits and `E = 65,537` fails. Test `R`/`W` equality separately from end-to-end record fit.                                                                                                       |
| Existing refusal plus encoding overflow                                               | Preserve invalid-recipient/plan-mode/raw-size text, not overwrite it with workflow/message overflow wording.                                                                                                                                                                                                  |
| Batch semantics                                                                       | Initial invalid batch pairs every call with an error and executes none; post-hook revised refusal follows existing per-call behavior.                                                                                                                                                                         |
| Error and surface isolation                                                           | Workflow keeps its existing refusal; valid ordinary tools still throw their size error; unrelated encoder/Store errors still propagate; MCP names retain the verified `mcp_` namespace and remain outside the added catch exemption.                                                                          |
| Durable recovery                                                                      | Assistant and paired result are durable and reloadable; scripted model sees the refusal, emits a shorter call, and completes the same Turn. Record-write failure must not be counted as recovery.                                                                                                             |

Avoid relying only on the command/session-message suites' current `messageFitsInline = () => true`: it cannot prove real transcript acceptance. Direct `execute` tests isolate encoding and branch logic, but the same-Turn claim needs the actual model loop and production ChatRecord sizing through Harness wiring. Do not copy a simplified ChatRecord shape into tests and treat it as the production oracle. Use existing test seams without introducing a public serializer API solely for testing.

Before implementation, capture baseline behavior with global `qwen` where the Hosted path is available and record its version/environment in `.qwen/e2e-tests/`; CLI startup alone is not reproduction. Run the failing focused cases first, then repair and re-run from `packages/cli`:

```bash
npx vitest run src/serve/hosted-workspace-tool-turn.commands.test.ts src/serve/hosted-workspace-tool-turn.session-message.test.ts src/serve/hosted-workspace-tool-turn.workflow-child.test.ts
```

Run the selected Harness regression file from that package, then `npm run build && npm run typecheck` at the repository root. For physical acceptance, use the existing packaged Hosted stack with the real server, MySQL, Broker and Harness and a scripted model; assert sender Turn completion, paired refusal, no outbox for the refused call, and one delivery for the short retry. Follow the server's local AGENTS.md if any Java test changes become necessary. On macOS, a Linux-only runtime boundary is not a pass; record unavailable tests explicitly. No new fault-gate round is required for this bounded slice.

Two discriminating checks should fail directly, not merely time out: restoring the old catch makes the escape-dense case throw; removing only the member-parent guard loses the specific raw refusal in the explicitly stubbed/direct-call guard test. That test bypasses real Hook resource limits and is not production recovery evidence. Both baseline and fixed code must fail the near-limit ASCII Turn; after encoding recovery the regression must additionally name the assistant-record guard, rather than accept any unrelated Turn failure.

## 6. Acceptance, risks and review questions

Accept the bounded implementation only when:

1. Every in-scope native lane returns a durable message-specific encoding refusal when all transcript budgets fit, and a scripted shortened retry completes the same Turn.
2. Member→parent has the same 65,536-byte raw-content guard as an ordinary child; existing 32 KiB member-envelope, recipient and plan-mode checks retain precedence.
3. Refused calls create no message, command, fan-out or continuation records; initial batch and post-hook behavior remain as described.
4. Workflow and unrelated-tool/error behavior remain unchanged. No Store/protocol constants or public tool declarations change.
5. Real-record tests expose the near-limit ASCII residual, and verification evidence distinguishes direct tests, actual Harness execution and real-stack acceptance. Two clean self-audit passes and independent review are complete before claiming implementation done.

The main risks are false recovery caused by a permissive transcript mock, accidental widening of the catch, overwriting a more specific error, and sentinel data escaping a refusal path. Exact encoded boundary tests, real Harness coverage and a review of both preparation passes address them.

The user accepted the bounded implementation. Full #14062 closure still needs a maintainer decision about assistant-record recovery. If that recovery is required, keep the issue open and design transcript durability separately; do not silently shrink the acceptance criterion. There is no proposal here to enable a capability or change deployment flags.

## 7. Audit record

One independent Sub Agent audited both languages against the pinned source and live issue/PR evidence. The initial report found one P2 design-correctness issue and three P3 suggestions. All four were incorporated:

- D1: removed the impossible real-Hook raw-overflow recovery claim; documented the earlier 60 KiB Hook budget and separated the isolated raw-guard test from real-Hook encoded-overflow verification.
- S1: removed the unnecessary MCP guard after verifying the generated-name invariant; retained the minimal name-based catch extension.
- S2: corrected the relationship between raw/envelope, encoded-input and transcript budgets.
- S3: moved source anchors to the actual relevant symbols.

The audit report is retained locally at `.qwen/pr-reviews/issue-14062-design-audit.md` (git-ignored). Independent recheck: completed; D1 and S1–S3 are closed, with no unaddressed audit findings or new substantive issues. The user subsequently authorized the bounded implementation; section 8 records its evidence and the remaining full-issue boundary.

## 8. Implementation evidence (2026-10-19)

The working tree implements only the two production changes in section 4: member→parent raw-content parity and a narrow `send_message` encoding-overflow refusal. Store limits, public declarations, schemas, and relay behavior remain unchanged.

- The independent test engineer reproduced five baseline failures before the source edit, after an actual global `qwen` 0.23.3 attempt could not reach Hosted tools. Its ordinary CLI returned `Tool "send_message" not found in registry`; that attempt is not Hosted acceptance.
- The command, session-message and workflow suites pass 102 tests. They cover member/broadcast/parent lanes, UTF-8 raw limits, exact encoder boundaries at 65,536 and 65,537 bytes, initial batch refusal, recipient-error precedence, refusal-write failure, and unchanged ordinary-tool overflow. The member lane is told its 32768-byte wrapper bound instead of the store bound. Direct-call tests with a permissive transcript predicate remain isolated guard/encoder evidence.
- The complete Harness suite passes 611 tests, including seven new regressions that use the actual model loop with a local OpenAI-compatible scripted endpoint, production ChatRecord sizing, and the HTTP resource-store inline check. The original five cover member and ordinary-child sends to `parent`, the two assistant-record cases and the real Hook rewrite; the two added modes cover command-lane recovery for member→`bob` and member→`*` (broadcast). Member, command-lane and ordinary-child escape-dense messages recover and retry within the same prompt; a real `HostedHookSession` processes/persists the scripted worker result before the rewritten message is refused and shortened. The two 65,400-byte ASCII cases still fail the assistant record with no message record.
- These Harness tests use local journal/resources and mocked Broker/worker access. One locally queued `session_message` is not proof of a remote recipient receiving it. Real managed-agent-server/MySQL/Broker/Harness/worker acceptance is unperformed: Docker was installed but its daemon was unavailable.
- `npm run build`, `npm run bundle`, full workspace/integration `npm run typecheck`, targeted ESLint, Prettier and reference checks pass. The two source mutations are detected directly, and fixed source is restored byte-for-byte. Independent post-fix verification passes the original five reproduction cases and 24 selected acceptance/happy-path cases. Independent code review has no unaddressed findings after two suggestions were incorporated. Local reports and the E2E plan are under `.qwen/issues/issue-14062.md` and `.qwen/e2e-tests/issue-14062/`; code review is recorded at `.qwen/pr-reviews/issue-14062-implementation-review.md`.

The implementation can be reviewed as a bounded repair; oversized assistant records and unperformed physical acceptance must not be counted as fixed or verified.
