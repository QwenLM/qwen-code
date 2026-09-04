# Auto classifier unavailable fallback

## Problem

Auto Mode currently converts every classifier infrastructure failure into an execution denial. A network error, timeout, invalid structured response, unavailable fast model, or context overflow therefore fails the pending tool call before the standard confirmation flow can ask the user what to do.

This behavior conflates two different outcomes:

- A classifier policy block is a safety verdict and should continue to deny the action.
- A classifier unavailable result means no verdict was produced and should let the user make the decision manually.

The existing consecutive-unavailable fallback only opens a confirmation after two failed classifier calls. The first failures still terminate their tool calls, and the prompt does not explain the infrastructure problem or offer a direct recovery path.

## Goals

- Route the first classifier unavailable result into the standard manual confirmation flow.
- Explain in the confirmation that Auto Mode could not classify the action.
- Offer an explicit option that approves the current action once and switches the session to Default Mode.
- Keep CLI and ACP permission behavior aligned.
- Preserve policy blocks, explicit deny rules, deterministic destructive-command guards, and user cancellation behavior.

## Non-goals

- Persisting Default Mode to user or workspace settings.
- Automatically switching modes without a user selection.
- Changing the policy classifier's allow/block rules.
- Making non-interactive or background sessions capable of presenting a prompt when they have no approval surface.

## Proposed behavior

When the classifier returns `unavailable: true`, the permission layer will still record the unavailable event, but it will return a manual-fallback outcome instead of a blocked outcome. The pending call will continue through the existing PermissionRequest and confirmation paths.

The generated confirmation will carry Auto Mode fallback metadata and suppress persistent “always allow” choices. The confirmation will show that the classifier is unavailable and recommend Default Mode if failures continue. Its choices will include:

- Allow once.
- Switch to Default Mode and allow once.
- Reject.

The switch choice is intentionally combined with an explicit one-time approval. A mode-only label would leave the disposition of the already pending action ambiguous.

| Classifier result | Current behavior        | New behavior            |
| ----------------- | ----------------------- | ----------------------- |
| Allow             | Execute automatically   | Unchanged               |
| Policy block      | Deny with policy reason | Unchanged               |
| Unavailable       | Deny the tool call      | Ask for manual approval |

## Core permission flow

`applyAutoModeDecision` will record unavailable counters and return a fallback reason dedicated to classifier unavailability. Because the outcome is no longer blocked, PermissionDenied hooks will not fire for infrastructure failures; the normal PermissionRequest hook will run before the prompt instead.

Unavailable counters remain useful. Approving a fallback resets the consecutive counters, while rejecting it preserves them. If repeated failures reach the existing threshold, later classifier-eligible calls can bypass the known-broken classifier and go directly to manual confirmation.

Confirmation details will gain optional Auto Mode fallback metadata shared across edit, execute, info, MCP, and other confirmation shapes. A new approval outcome will represent “proceed once and switch to Default.” The CLI scheduler will switch the runtime session mode and normalize that outcome to ordinary `ProceedOnce` before invoking tool-specific confirmation callbacks or recording the tool decision.

`Config.setApprovalMode` already provides the required session transition: it restores rules temporarily stripped on Auto Mode entry, resets denial counters, and increments the approval-mode revision. No settings file is changed.

## CLI presentation

The TUI confirmation component will render the fallback notice before the action details and add the switch option before Reject. Full and compact confirmation layouts will both expose the option. Height accounting must reserve space for the added warning and option so small terminals continue to show actionable choices.

## ACP presentation

ACP permission requests will include the fallback notice as text content and expose the same switch-and-allow-once option. When selected, the session will normalize the tool approval to `ProceedOnce`, switch the runtime mode to Default, and publish the existing current-mode update notification.

ACP clients that only choose Allow or Reject continue to use the existing protocol behavior.

## Failure boundaries

- User cancellation of the classifier request remains an abort and does not become an approval prompt.
- Explicit permission denies and deterministic destructive-command blocks remain errors.
- Non-interactive calls without a permission transport and background agents that cannot prompt still deny through their existing manual-confirmation fallback handling.
- A failed policy review in classifier Stage 2 is considered unavailable and therefore asks the user; a completed Stage 2 policy block remains denied.

## Files affected

- `packages/core/src/permissions/autoMode.ts` and tests: unavailable-to-fallback mapping, metadata, and hook gating.
- `packages/core/src/tools/tools.ts`: fallback confirmation metadata and switch approval outcome.
- `packages/core/src/core/coreToolScheduler.ts` and tests: decorate confirmations, track fallback resolution, switch modes, and normalize the approval.
- `packages/core/src/telemetry/tool-call-decision.ts` and tests: classify the new approval-shaped outcome.
- `packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx` and tests: notice and option rendering.
- `packages/cli/src/acp-integration/session/permissionUtils.ts` and tests: ACP content and option mapping.
- `packages/cli/src/acp-integration/session/Session.ts` and tests: ACP fallback, mode transition, and notification.
- `docs/users/features/auto-mode.md`: document immediate manual fallback and the Default Mode recovery option.

## Open questions

None. The switch is session-only and explicitly approves the pending action once.
