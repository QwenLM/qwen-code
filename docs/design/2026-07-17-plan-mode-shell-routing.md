---
title: 'Plan Mode Shell Routing and Exact One-Off Approval'
date: '2026-07-17'
status: 'implemented'
---

# Plan Mode Shell Routing and Exact One-Off Approval

## Problem

Plan mode historically treated confirmation shape as a proxy for whether a tool was read-only. That is insufficient for `run_shell_command` and `monitor`: both tools can represent read-only, state-modifying, or parser-unknown shell programs, while permission rules, hooks, ACP hosts, stream-json, TUI, teammate, and background bridges can all resolve the same approval through different paths.

The security boundary must distinguish a known write from an unknown command without turning `unknown` into a way to evade Plan mode. An approval must also remain bound to the exact model request that produced the prompt; a later mode change, permission-policy change, host rewrite, editor modification, or racing response must not reuse it.

This design depends on the tri-state shell classifier merged in #7053.

## Goals

- Apply one routing policy to model-initiated Shell and Monitor calls in Core and ACP.
- Execute only commands classified `read-only` without a new Plan-specific prompt.
- Block commands classified `write` before confirmation hooks or hosts can approve them.
- Permit `unknown` only through an exact, one-time confirmation while keeping Plan mode active.
- Preserve an explicit PermissionManager deny over every Plan-specific route.
- Carry warnings and the actual allowed choices through TUI, ACP, stream-json, dual-output, teammate, subagent, and background bridges.
- Keep non-Shell Plan behavior and explicit plan-exit semantics unchanged.

## Non-goals

- Changing Plan gate lifecycle or injecting a new reminder during an already-running ACP turn.
- Governing user-entered `!command` shell input.
- Adding a confirmation type, setting, cache, feature flag, or persistent one-off capability.
- Changing DataWorks-specific query tools.
- Making speculation provide an interactive approval surface.

## Threat model

The protected asset is the user's filesystem, processes, network-visible state, repository state, and approval-mode boundary while Plan mode is active. Untrusted inputs include model tool arguments, shell syntax the parser cannot prove safe, hook-returned `updatedInput`, ACP option IDs, stream-json host rewrites, IDE edit callbacks, teammate/background responses, and duplicate responses from concurrently attached hosts.

The relevant attacks are:

- using an allow rule or YOLO-like bridge to bypass Plan mode;
- disguising a known write with a wrapper so it reaches a weaker path;
- approving one command and executing a modified request or validated invocation;
- leaving Plan mode and re-entering it while an old prompt remains visible;
- adding a deny rule after prompt display but before approval consumption;
- forging an unoffered persistent or modify option;
- approving twice through TUI, remote input, IDE, or background bridges;
- using a sibling call's persistent approval to auto-approve the Plan Shell call.

## Routing policy

PermissionManager L3/L4 evaluation remains authoritative for hard deny. After that decision and the plan-required teammate gate, Plan Shell routing classifies the validated command.

| Classification | PM deny | PM allow             | PM ask/default       | No approval host                                 |
| -------------- | ------- | -------------------- | -------------------- | ------------------------------------------------ |
| `read-only`    | deny    | execute              | exact one-off prompt | deny when the ordinary PM prompt cannot be shown |
| `write`        | deny    | Plan block           | Plan block           | Plan block                                       |
| `unknown`      | deny    | exact one-off prompt | exact one-off prompt | Plan-safe refusal                                |

Monitor classification uses `normalizeMonitorCommand(command).safetyCommand`; Shell classification uses the validated invocation's original command string. Speculation executes only when the tri-state result is exactly `read-only`; `write`, `unknown`, parser failure, and empty input stop at the speculation boundary.

## Exact invocation capability

Classification creates an immutable snapshot containing:

- the original tool request arguments;
- the validated invocation parameters;
- the current approval-mode revision;
- the PermissionManager check context, including the effective Shell/Monitor working directory;
- the raw Shell or Monitor command used for display.

Core and ACP clone the Plan Shell/Monitor invocation before classification so host-visible raw input cannot retain an alias to the executable parameters. When the model omits `directory`, that clone is also bound to the current session working directory. The original request remains unchanged, while execution no longer follows a later daemon/ACP directory relocation or request-object mutation after approval has been consumed.

The scheduler validates this snapshot after classification, before displaying confirmation, and before consuming a confirmation. Validation requires:

- a live, non-aborted request;
- Plan mode with the same revision, so Plan → other mode → Plan invalidates the prompt;
- deep equality of request arguments and validated invocation parameters;
- the same effective working directory when the invocation relies on the session's ambient directory;
- a successful current PermissionManager evaluation that does not return `deny`.

Later `allow`, `ask`, or `default` changes do not reroute a prompt that was already selected. A PermissionManager exception fails closed. Once final validation succeeds, the capability is consumed; a later mode or rule change does not revoke the already-consumed invocation.

Only `ProceedOnce` and `Cancel` are accepted. `updatedInput` is accepted only when deeply equal to the snapshotted request. `newContent` is never accepted. Successful approval passes an empty payload to the tool, so answers, permission rules, or host-only metadata cannot become a persistent grant. Invalid results become `Cancel` with the stale-approval message.

The Core confirmation closure claims the response synchronously before its first `await`. Racing TUI, remote-input, teammate, IDE, or background responses therefore cannot consume the capability twice. Plan Shell edit confirmations never enter the IDE auto-diff path, and sibling persistent approvals skip confirmations marked `hideAlwaysAllow`.

## Confirmation presentation

Every Plan Shell prompt hides persistent approval. Unknown confirmations add:

> Plan mode could not determine whether this shell command is read-only. Approval applies only to this exact invocation once; it may modify system state, and Plan mode will remain active.

Unknown edit confirmations also hide modification actions and add the raw command as a second warning while retaining the diff. TUI renders edit warnings above the diff and reserves their wrapped height so the options remain visible on small terminals. ACP sends warnings before diff or plan content. Stream-json and dual-output include warnings in their existing `permission_suggestions` field.

ACP and nested subagent bridges validate the returned option ID against the exact options sent to the host. Plan-exit keeps its existing four special choices because those choices were actually sent. Missing, forged, hidden, or malformed options fail closed.

Teammate events carry optional callback-free confirmation details. Stream-json uses them for warnings while the teammate's Core scheduler remains the final exact-invocation validator. Headless YOLO cancels a non-plan confirmation marked `hideAlwaysAllow` because no interactive warning surface exists. Background approval never converts an unoffered persistent result into `ProceedOnce`; non-plan persistent results cancel, while plan confirmation retains only its actual `ProceedAlways` choice.

## Failure messages

Known writes, unavailable unknown approval surfaces, and stale approvals use the fixed messages from the implementation plan. These messages deliberately state that Plan mode remains active and prohibit retrying known writes through wrappers or obfuscation.

## Rejected alternatives

- **Treat unknown as write.** Simpler, but blocks necessary investigation when the parser cannot model an otherwise legitimate command.
- **Treat unknown as read-only after PM allow.** An allow rule is not proof of read-only behavior and would erase the Plan boundary.
- **Persist an allow rule after unknown approval.** The classifier result and exact request are transient; persistence would authorize a broader future command.
- **Reuse IDE diff acceptance.** IDE callbacks can change content and race the warning surface, so they cannot safely consume an exact shell capability.
- **Validate only raw request arguments.** Tool builders normalize and validate input; both raw and executable forms must remain bound.
- **Validate only when the prompt is created.** Mode and permission state can change while a prompt is visible.
- **Add a dedicated confirmation type or feature flag.** Existing confirmation shapes and warning fields are sufficient and keep the change smaller.

## Verification

Unit coverage exercises policy classification, snapshots, abort, revision and argument changes, PermissionManager deny/error, warning decoration, payload sanitization, Core routing, duplicate response ownership, sibling auto-approval, wrapped sed edit behavior, Monitor parity, speculation, ACP options and warnings, SubAgentTracker, teammate stream-json, background normalization, dual-output, TUI layout, and prompt wording.

Manual validation is recorded in `.qwen/e2e-tests/plan-mode-shell-routing.md`.
