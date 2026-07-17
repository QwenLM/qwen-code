# Explicit Plan Exit Approval

## Problem

`exit_plan_mode` previously mixed approval and execution. Its confirmation callback changed `ApprovalMode` before hooks and execution completed, and AUTO/YOLO sessions could bypass the user through an LLM Plan Approval Gate. Permission-manager allow rules, permission hooks, and sibling auto-approval could also satisfy an `ask` decision without an actual host/user response. This made a model-originated tool call capable of attempting to leave Plan mode without a user decision and created misleading mode notifications when later execution failed.

## Design

Tool invocations may declare `requiresUserInteraction()`. This is an intrinsic interaction requirement, not another permission level: intrinsic or permission-manager denies still win, while allow rules and automatic approval modes cannot satisfy it. Main-session `exit_plan_mode` declares the requirement. Plan-required teammates retain their leader-approval path, and ordinary subagents retain the existing lifecycle-tool rejection.

The plan confirmation callback records only one of four decisions: restore the pre-plan mode, switch to auto-edit, switch to default, or cancel. It never changes mode. Creating the confirmation freezes the plan text, pre-plan mode, and the current approval-mode revision. `execute()` checks that approval exists, the signal is active, the session is still in Plan mode, and the revision still matches before applying the mode transition synchronously. This makes stale, re-entered, and concurrent exits fail closed. Plan persistence happens best-effort only after the transition succeeds.

`Config` owns a monotonic approval-mode revision that increments only when the mode actually changes. Approval-mode overrides own independent revisions. The existing optional `enteredByModel` setter argument remains temporarily as an ignored compatibility parameter; model origin has no effect on approval.

The LLM Plan Approval Gate and its AskUserQuestion metadata coupling are removed. `prePlanMode` remains because it is a user-visible exit choice. `originalRequest` and `researchSummary` remain for plan-required teammate leader review. `resolutionSummary` remains only as a deprecated TypeScript input property for source compatibility and is no longer accepted by the runtime schema.

## Host behavior

CLI and IDE confirmation, ACP `requestPermission`, and stream-json `can_use_tool` allow responses count as explicit interaction. PermissionRequest allow hooks, PM allow rules, YOLO/AUTO/AUTO_EDIT, and sibling auto-approval do not. Hook deny decisions remain authoritative. Non-interactive callers without an approval-capable host fail closed.

ACP sends no mode update when permission is pending or when confirmation, hooks, execution, or the transition fails. After successful plan lifecycle execution and an actual mode change, it sends one update using the mode read from `Config`. Legacy notification failure is advisory and the extension side-channel is still attempted with an accurate `legacyFrameSent` value.

## Failure behavior

- Calls outside Plan mode are denied before a confirmation is constructed.
- Invalid confirmation outcomes, cancellation, aborts, stale revisions, and transition failures leave Plan mode active.
- Two exits approved against the same revision cannot both succeed.
- If an ACP host cannot present `switch_mode`, Plan mode remains active and the error directs the user to the host mode selector or `/plan exit`.
- Saving an already approved plan is best-effort and does not roll back a successful mode transition.

## Compatibility and scope

This change intentionally does not broaden general shell execution in Plan mode and does not add DataWorks-specific read tools. Those are separate permission/tooling changes. The public invocation method is optional with a default `false`, so existing tools and external implementations remain compatible.
