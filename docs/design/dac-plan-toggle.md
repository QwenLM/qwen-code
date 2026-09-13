# DAC Chat Plan toggle

## Problem and scope

Web Shell uses one approval-mode value for both planning and execution permission. Plan appears in the permission menu, and confirming a plan may choose a different execution policy. DAC Chat needs a separate Plan toggle immediately after the permission control. The existing single-row responsive toolbar remains: narrow widths collapse labels to icons. No toolbar reorganization or CLI/TUI semantics change is included.

Generating a plan leaves Plan enabled until the user approves it. Approval exits planning and executes under the policy selected when the user confirms. Rejection leaves planning enabled. Changing permission while planning updates only the policy for execution and never auto-confirms the plan. Manual toggle-off exits planning under the selected permission; it does not submit the pending plan approval. Existing running-turn switch timing is preserved; this feature does not add cancellation or model steering.

## Runtime and transport

Retain runtime ApprovalMode.PLAN and its existing tool restrictions. Add an optional DAC-only selected execution policy to Config, populated exclusively by an explicit planMode boolean on the existing session approval-mode control. Legacy requests omit the flag and retain their behavior. Validate the flag and reject PLAN as an execution policy. Core applies the existing derived-config and folder-trust constraints before changing state. Updating execution policy while already planning does not end or restart the planning lifecycle.

For DAC selections, RestorePrevious captures the selected execution policy in the confirmation callback. Legacy confirmations still restore their original snapshot. Execution retains cancellation and approval-mode-revision checks. Policies chosen after confirmation must not silently alter that already-approved decision.

The existing route remains live-session-owner scoped through withOwnerMutableSession. Use its resolved runtime, bridge and Config throughout, with existing unknown/removed/draining failure behavior. No primary-runtime fallback, new workspace route or permission persistence is introduced. Transport the selected policy in approval responses, mode notifications and session-mode metadata; preserve it through bridge reconciliation, snapshots and client hydration. The effective runtime mode remains authoritative for whether the Plan toggle is on.

## Web Shell

Add a Plan Switch after approvalMode in ChatEditor, using the shared Switch primitive. The host must explicitly include `plan` in `composerToolbarActions` or `composerToolbarAdditionalActions`; omitted configuration hides it in main and split panes. The standalone browser host explicitly opts in. Plan never falls back into the permission menu. Wide layouts show the Plan label and switch; narrow layouts replace the label with the Plan icon and retain the switch. Preserve the single row, tooltip, accessible name and checked state. Hide the entire Composer and its status area while a plan awaits approval, matching ordinary permission and AskUserQuestion overlays. Restore them when the overlay resolves. Floating plan cards scroll only their plan content, keeping the heading and approval buttons visible, including text-only plans. Execution permission remains adjustable during planning before the approval overlay appears. Remove Plan only from Web Shell permission menus/cycling. Keep Auto alongside Default, Auto Edit and YOLO. Do not change the shared SDK approval enum or the agent-definition editor.

Main and split panes use the same daemon action contract. Plan confirmations expose one approval action labelled with the chosen execution policy and a rejection action. A permission change during Plan cannot auto-submit pending approval. Briefly disable plan confirmation while a mode update is pending, and prevent new mode updates during plan-approval handoff until the runtime exits Plan or the handoff fails; neither request may overtake the other. Buttons reflect only successful state changes; failures keep the previous state. Session-owner guards prevent late responses updating replacement sessions.

/plan toggles, /plan on enables, /plan off disables through the same action. Preserve /plan <prompt> as enter-and-send and /plan exit as a compatibility alias for off. A new session is created with its execution policy, then Plan is applied before submitting the first prompt; preparation failure prevents that prompt.

## Affected areas

- Core Config and exit-plan confirmation, with legacy and DAC regression coverage.
- Daemon session approval route, ACP control handler and mode metadata/notifications.
- ACP bridge control, cached snapshots and mode-event forwarding.
- TypeScript daemon client/state types and Web Shell session synchronization.
- Web Shell Composer, approval dialog, main/split command and permission wiring, translations and focused component tests.

## Verification

Exercise Plan with every non-Plan permission, permission changes before and while a plan awaits confirmation, approve/reject/manual exit, slash commands, welcome-session preparation, session switching and reconnect hydration. Verify core legacy confirmation snapshots remain unchanged. Validate toolbar order and one-row compact layout. Build, typecheck, bundle, focused tests and two clean full-diff audits are required.

## Open questions

None for the requested behavior. Cross-process restoration beyond existing session-mode persistence and new mid-turn steering guarantees are out of scope.

## Review corrections

Metadata reads that omit modes, fail, or are skipped during event-stream restart preserve the existing mode and execution policy together. An authoritative non-Plan mode clears the policy. Plan approval receives only the daemon-reported execution policy; a Composer display fallback must never label the approval as executing under a permission the daemon did not report.

For explicit DAC `planMode` controls, `persist: true` saves only the execution policy as the workspace default for future sessions. The requesting session publishes its actual Plan state and selected policy. Existing peer sessions receive neither a mode event nor a cache update. Requests without `planMode` retain the previous workspace-default broadcast behavior.

Regression checks cover metadata reuse after prompt restart, missing-mode context responses followed by a real Plan exit, approval with/without reported execution policy in main and split panes, DAC persistence with Plan/non-Plan peers, and the existing legacy persistence tests.

## Confirmation policy precondition

DAC RestorePrevious responses include the execution policy displayed by the approving client. The bridge preserves this permission-response extension and Session forwards it to the tool. Core reads the current DAC policy once, rejects a missing or different expected policy, and otherwise freezes that value until execution. Legacy Plan without a DAC policy keeps its pre-plan snapshot behavior. Policy equality is sufficient: a change away and back to the same policy does not change the permission the user approved. The lifecycle revision remains separate.

A rejected precondition consumes the old permission request and returns a tool error while retaining Plan. The model must request plan approval again; HTTP acknowledgement does not imply that Plan exited. No client-side retry of the consumed approval is attempted.

The Plan Switch retains its accessible name and checked state and directly references a persistent, dynamic execution-policy description. Mode controls becoming busy close the open permission menu. Slash completion includes the existing exit alias. Unused Plan & Review mode labels are removed; agent-editor Plan labels and workflow review translations remain.
