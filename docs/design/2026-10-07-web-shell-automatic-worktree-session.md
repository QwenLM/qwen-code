# Automatic Worktree Creation for Web Shell Sessions

[English](2026-10-07-web-shell-automatic-worktree-session.md) | [简体中文](2026-10-07-web-shell-automatic-worktree-session.zh-CN.md)

## Problem and Current Behavior

The empty-session composer requires selecting Worktree and then clicking
“Create worktree”. That confirmation only records a draft intent; it does not
create a checkout. The first prompt already sends `worktree: {}` with
`POST /session`, which generates a name, creates the worktree, and enters it.
The confirmation incorrectly suggests a separate setup step is necessary.

The sidebar and Worktrees manager already start worktree drafts directly.

## Proposed Change

Selecting Worktree in `GitModePopover` immediately records the existing
`{ mode: 'worktree' }` intent and closes the popover, matching the Current
branch selection. The description explains that an isolated copy is created
when the first message is sent. Remove the redundant confirmation button and
its unused styling and translations.

The composer chip shows the selected mode. Its existing reset button lets the
user return to the current branch before sending. Worktree selection alone
does not send a session request or create files. The existing first-prompt
path supplies the intent to the daemon, which chooses the worktree name.

## Scope and Constraints

Only the Web Shell selector, styles, English/Chinese copy, and its browser
tests change. Keep the existing eligibility checks, workspace intent reset,
session creation, ownership, failure handling, and cleanup behavior. Do not
add settings, new API fields, naming inputs, or automatic isolation for normal
sessions. Branch mode still needs its name and confirmation.

No daemon route or core module changes are required.

## Validation and Acceptance Criteria

- One click on Worktree selects it and closes the popover without a second
  confirmation or naming step.
- Selection alone does not create a session. Sending the first message sends
  exactly one `POST /session` with `worktree: {}` and no `branch`.
- Resetting a worktree draft before sending creates a normal session.
- Existing branch selection, default mode, and non-Git eligibility tests pass.
- Run focused unit and browser tests, build, typecheck, and bundle. Record
  baseline and verification results in `.qwen/e2e-tests/`.

## Risks and Open Questions

The change removes a selection confirmation, so accidental selection must
remain reversible before sending. The existing reset control provides this.
There are no open design questions.
