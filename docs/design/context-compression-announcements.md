# Context compression announcements

[English](context-compression-announcements.md) | [简体中文](context-compression-announcements.zh-CN.md)

## Problem

[#11810](https://github.com/QwenLM/qwen-code/issues/11810) reports duplicate live
regions when the composer context card and context detail panel show feedback
for the same compression. Removing announcements from either surface alone
would leave some workflows silent because both surfaces mount and dismiss their
feedback independently.

## Design

Keep visible feedback in both surfaces, without live roles. Style failures using
an explicit error tone so the color does not depend on accessibility semantics.
Share the existing translated messages between visual feedback and announcements.

The existing compression hook sends an internal notification when an accepted
operation starts and when it settles. The notification includes an operation
identity, workspace, session, and phase. Existing guards reject stale completions
after a session/workspace switch or unmount. They still distinguish cancellation,
provider failure, failed usage refresh, and interrupted ownership. Notifications
do not send another prompt or collect usage again.

App owns the latest notification per workspace/session. Its primary hook uses a
callback; split-pane hooks receive the same callback through a private React
context. Keep the announcer mounted beside the existing portal provider. Render
one pair of initially empty live nodes for each live workspace/session through
the Web Shell portal root. Use polite status updates for progress and normal
outcomes; preserve assertive alerts for failures and failed refreshes.

Deduplicate repeated operation/phase notifications. Remember delivered events
across feedback and owner remounts, and discard undelivered notifications once
their owner leaves. Clear the text before inserting a new announcement in a
later task so a retry with identical wording can be announced. Do not use the
retained compression results that App restores for visual feedback.

All additions are internal to Web Shell. The daemon protocol, public SDK,
compression operation, and independent dismissal of visual results are unchanged.

## Validation

- Card only, panel only, and both visible: one live message per current phase,
  with visual progress and error colors preserved in both surfaces.
- Close or dismiss one surface, change the active artifact tab, and remount:
  do not replay a completed result or lose an active operation's announcement.
- Retry with the same outcome: announce the new operation; ignore duplicate
  notifications from the old operation.
- Switch sessions or workspaces and use split panes: keep independent operations
  separate and do not announce stale completions after their owner disappears.
- Exercise normal and Shadow DOM portal roots, including a modal surface, and
  check that the live nodes remain exposed to accessibility tools.
- Verify actual VoiceOver speech on macOS in addition to browser DOM assertions.
  DOM counts alone do not establish what a screen reader says. If speech cannot
  be verified, keep the PR in Draft and record the missing check.

Use focused hook/component tests and the existing browser compression scenario.
Record completed checks, runtime versions, and before/after evidence in the PR.
