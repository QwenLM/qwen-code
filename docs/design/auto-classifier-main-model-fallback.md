# Main-model review after an Auto classifier timeout

[English](auto-classifier-main-model-fallback.md) | [简体中文](auto-classifier-main-model-fallback.zh-CN.md)

## Problem and current behavior

Auto mode uses the configured fast model for permission classification. If no fast model is configured, it uses the session model. A stage-1 deadline currently produces an unavailable result and sends the pending action to manual confirmation, even when a different session model could complete the review.

## Goals and scope

Keep the pending action in the existing permission flow while a distinct session model gets one opportunity to review it after the fast classifier's stage-1 deadline. Preserve policy blocks, explicit permission rules, transcript filtering, user cancellation, and the existing manual fallback when no review can complete.

Only a stage-1 deadline triggers this fallback. API errors, malformed responses, context overflow, prompt-construction failures, and stage-2 failures retain their existing behavior. No user configuration, UI, permission transport, or model-selection setting is added or changed.

## Proposed behavior

| Outcome                                                        | Next action                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Fast stage 1 allows                                            | Continue with the existing allow result.                                     |
| Fast stage 1 flags risk                                        | Run the existing stage-2 review.                                             |
| Fast stage 1 reaches its deadline and model identifiers differ | Ask the session model for one complete independent verdict.                  |
| No fast model, or fast and session identifiers match           | Retain unavailable/manual fallback.                                          |
| Session-model review allows                                    | Resume the original pending action through the existing scheduler.           |
| Session-model review blocks                                    | Apply the existing policy-denial handling and sanitized reason.              |
| Session-model review fails or reaches its deadline             | Retain unavailable/manual fallback.                                          |
| User cancels at any point                                      | Propagate cancellation; do not request another review or execute the action. |

The main-model review is a stateless permission request, not a new agent turn. It receives the same projected transcript, trusted user answers, pending action, and policy as the fast classifier. Assistant prose and tool results are not reintroduced. The session model and conversation are not switched or rewritten.

## Model, prompt, and time budgets

Use the existing side-query model override to select the session model. Compare the configured model identifiers; do not introduce a second routing resolver. The fallback uses the existing complete-review response schema, including a boolean verdict and a short block reason, with a new neutral prompt suffix. It must not claim that stage 1 identified a risk: a timeout supplied no verdict.

Reuse the configured stage-2 timeout for this complete review, defaulting to 30 seconds. Together with the default 10-second stage-1 budget, this permits approximately 40 seconds of classifier request time when fallback is needed. The review also follows the existing stage-2 thinking setting and 4096-token output budget. It runs as one side-query with one classifier-level attempt, including unattended sessions. Existing provider SDK transport retries remain subject to that review's deadline; this is not a guarantee of one HTTP request.

Distinguish the classifier's own deadline from user cancellation and other request failures. The main review receives a fresh deadline combined with the original user signal, never the expired fast-stage signal. Check fast-stage and fallback-review signals before accepting their results so a late response cannot approve a cancelled or expired action.

## Integration and observability

Implement the behavior inside the shared classifier. CLI scheduling, ACP sessions, and hosted tool turns already consume its allow/block/unavailable contract. Add a `main` result stage and report the actual selected model; propagate the stage through Auto decisions without changing approval protocol payloads.

Diagnostics identify the stage, model, outcome, and duration. They must not log prompts, tool arguments, user or session identifiers, or model reasoning. Do not persist a transient fast timeout as a denial when the main review succeeds.

## Files affected

- `packages/core/src/permissions/classifier.ts` and its tests: timeout-only fallback, independent cancellation budget, verdict metadata, and bounded attempt count.
- `packages/core/src/permissions/classifier-prompts/system-prompt.ts` and its tests: neutral full-review instructions.
- `packages/core/src/permissions/autoMode.ts` and its tests: shared result-stage typing and existing outcome handling.
- `docs/users/features/auto-mode.md`: explain automatic fallback and remaining manual-confirmation cases.

## Risks and tradeoffs

Fallback adds latency and model cost only after the fast stage times out. Models may share an unhealthy provider or quota, so a second review is not guaranteed to recover. Identifier equality does not resolve every possible provider alias. This change does not reassess completed policy blocks or correct overly conservative classifier policy.

## Validation and acceptance criteria

Use synthetic prompts, model identifiers, commands, and local mock endpoints. Do not commit production logs, customer identifiers, credentials, or conversation content.

Focused tests must cover fallback allow and block, the same projected context, an explicit main-model override, neutral instructions, one bounded attempt, fresh/configured deadlines, identical or missing fast models, non-timeout failures, failed main review, user cancellation, and late results. Existing explicit ask/deny, protected-write, and normal two-stage behavior must remain intact.

Run a deterministic CLI baseline against the global binary, then the same controlled scenario against the built local bundle: delayed fast classification followed by main allow must execute a harmless local operation exactly once without manual confirmation. Main block and unavailable results must not execute it automatically; existing manual approval remains available where applicable. Build, typecheck, focused tests, and two clean self-audit passes precede submission.

## Open questions

None for this scope. Separate timeout knobs, provider failover policies, parallel hedged requests, and changes to permission policy remain outside this change.
