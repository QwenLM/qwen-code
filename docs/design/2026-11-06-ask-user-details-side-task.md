# Ask User "Ask for details" Side Task

[English](2026-11-06-ask-user-details-side-task.md) | [简体中文](2026-11-06-ask-user-details-side-task.zh-CN.md)

Status: implemented and verified (unit tests, mock-daemon visuals, and a
real-daemon + real-model E2E round; evidence in `.qwen/e2e-tests/`).

## Problem

When an `ask_user_question` permission is pending, Web Shell hides the main
composer (`composerHidden`) and the btw shortcut ignores `pendingApproval`.
The user can only pick an option, type a free-text answer, or Ignore. There is
no way to ask a follow-up question about the pending question itself — for
example what an option means, what it changes, or what the risks are — without
first committing to an answer or discarding the question.

## Current state

- `/btw <question>` runs a lightweight side question (`btwSessionStream`) that
  does not enter the main conversation context. It is handled only by the main
  view composer.
- `/btw side <question>` creates a side task when the daemon advertises
  `session_side_task` and a workspace session exists (`sideTasksAvailable`):
  `createSideTask(initialPrompt)` opens a right-panel tab, and
  `createSideTaskSession` provisions a child session that inherits the parent
  transcript context. The tab's `initialPrompt` is sent as the child session's
  first prompt.
- Files written by a session surface as turn outputs; `.html` files are
  renderable artifacts and open in the right panel's HTML preview.
- The pending AskUser panel (`AskUserQuestion`) offers Submit / Ignore /
  Previous / Next and an "Other" free-text input, but no details action.

## Goals

- Let the user learn the details of a pending question before answering,
  without answering it, discarding it, or polluting the main conversation.
- Reuse the existing side-task infrastructure end to end; no daemon changes.
- The explanation is delivered as a self-contained single-file HTML document
  written in controlled, unambiguous sentences (ASD-STE100 sentence rules),
  in the UI language.

## Non-goals

- No details action in split-view panes or inside side-task panes. This matches
  `/btw side`, which is also main-view-only; a pane-scoped variant would need
  per-pane parent-session scoping that the side-task panel does not have today.
- No new daemon routes, capabilities, or settings.
- No automatic answering: the side task must never submit the pending
  permission or send a prompt to the main session.

## Proposed solution

1. `AskUserQuestion` accepts an optional `onAskDetails?: () => void`. When
   provided, the actions row renders an "Ask for details" text button (muted
   styling, left of Ignore). The button is outside the option radiogroup, so
   option digit shortcuts and roving-tabindex navigation are unchanged. It is
   disabled while a submission is in flight.
2. App wires the callback only for the main-view overlay, gated on
   `sideTasksAvailable` (same gate as `/btw side`). The callback formats the
   pending payload with `formatAskUserQuestions(rawInput)` — a language-neutral
   snapshot of numbered questions with option labels/descriptions — and calls
   `createSideTask(t('askUser.detailsPrompt', { questions }))`.
3. The localized prompt template instructs the side task to: read the relevant
   code and context first; mark unverified claims; explain each question's
   background and every option's meaning, differences, impact, and risks; give
   a recommendation with reasons; not answer for the user or change the main
   session; write a self-contained single-file HTML (inline CSS, no external
   resources) under `.qwen/tmp/` using ASD-STE100 sentence rules (one idea per
   sentence, active voice, short sentences, one term per concept, conditions
   before actions, lists for three or more items, no metaphors or
   exclamations); keep code, commands, paths, and config keys verbatim; reply
   with the file path and a one-sentence summary.
4. The HTML file appears as a turn output in the side-task chat and opens in
   the existing right-panel HTML preview. The pending question stays pending;
   the user returns to the main view to answer or Ignore.

## Design decisions

- **Side task, not lightweight btw.** The details conversation may need code
  reading, file writing, and follow-up turns; a side task is a full child
  session with inherited context, while `btwSessionStream` is a single-shot
  answer. The HTML deliverable also requires file tools.
- **Prefilled prompt, not an empty draft.** The user's intent ("explain this
  pending question") is known at click time; prefilling removes a typing step
  and pins the scope. The user can still steer with follow-up prompts.
- **Prompt-carried style rules.** The side-task model does not share the
  user's personal memory, so the controlled-language and HTML requirements
  must be self-contained in the prompt. Only the core sentence rules are
  included; heavier verification rituals stay out of the product default.
- **Optional prop, conditional render.** Hosts without a side-task surface
  (embedded hosts, split panes, daemons without the capability) simply do not
  pass the callback, and the button does not exist. No disabled-state UI.
- **UI language for the explanation.** The prompt template is localized
  (en/zh-CN; ru falls back to en via the existing i18n fallback), so the
  explanation language follows the UI language rather than the daemon's
  output-language setting.
- **One details task per pending question.** The details tab uses a stable id
  derived from the permission request id (a uuid; tabs are already bucketed
  per parent session) and is upserted, not appended: repeat clicks focus the
  existing tab instead of provisioning duplicate child sessions. The
  question-to-child association is also persisted per parent session
  (localStorage), so it outlives the tab: closing the details tab and clicking
  again reopens the same child, and a child reopened from the side-task
  catalog under its own `side-task:<sessionId>` tab is focused rather than
  duplicated. Four lifecycle edges are covered: the association is recorded
  even when the draft tab closes before creation resolves (the parent identity
  is captured when creation starts, since the server does not cancel it); the
  reopened tab retains the explanation prompt, and the pane's empty-session
  guard sends it only while the child has no user prompt yet (media-only
  messages — image, file, or resource link — count; they submit with empty
  text), so a prompt interrupted by a close is delivered exactly once and
  never re-sent; a catalog-reopened tab
  carries no prompt of its own, so clicking details again supplies the pending
  prompt on the matched tab before focusing it, letting the same guard deliver
  it to a still-empty child; and archiving a child invalidates its
  association, because the daemon's load route rejects
  archived sessions (409 `session_archived`) — the next click provisions a
  fresh child instead of attaching an unloadable one. Archive can happen from
  any surface (the side-task panel, the sidebar session row, the overview
  panel, the activity catalog) or another browser tab, so the binding is
  validated at the read site: a click confirms the child is still in the
  parent's active side-task list and forgets it otherwise, rather than trusting
  the persisted id. One entry per parent supersedes the resolved question's
  association, keeping the store bounded; re-recording a parent moves it to the
  newest key slot so the oldest-first eviction never drops a live, frequently
  used parent. The tab id stays short because the pane derives its daemon
  clientId as `side-task:<parentSessionId>:<tabId>` and the daemon rejects
  client ids over 128 characters; an App-level test pins that budget with
  uuid-length inputs through the real derivation. `/btw side` keeps its unique
  per-invocation draft id.
- **The child is named from the question.** The explanation prompt leads with
  the question snapshot, so the pane's generic first-prompt naming (the first
  200 code points) yields a question-derived title in the tab strip and the
  side-task catalog, instead of the identical instruction boilerplate for every
  details task.
- **The snapshot carries selection semantics.** Multi-select questions are
  marked `[multiSelect]` so the explanation covers combinable options without
  relying on the inherited transcript alone.
- **The actions row wraps.** A fifth button can push the row past narrow
  viewports, and a flex-end row overflows to the left — invisible to
  `scrollWidth`. The row wraps, and a 320px multi-question regression test
  asserts every action button stays inside the panel and stays clickable.

## Constraints and risks

- The side task inherits the parent transcript at creation time; the pending
  question is part of that context, and the prompt embeds a snapshot as well,
  so the explanation stays scoped even if the parent transcript is long.
- `.qwen/tmp/` is the agent's scratch directory (git-ignored in this repo).
  In workspaces where it is not ignored, the file is still a normal workspace
  file the user can delete; nothing is committed automatically.
- The button must not disturb the panel's keyboard contract: it lives in the
  actions row, is not an option, and does not register digit shortcuts.
- Side-task creation can fail (daemon error, policy flip). Failure handling is
  inherited from the existing `/btw side` path (toasts, tab guards); the
  details action adds no new failure mode.

## Validation plan

- Unit: `formatAskUserQuestions` formatting, trimming, malformed-entry
  skipping (`askUserPermission.test.ts`).
- Unit: button hidden without the callback; click invokes the callback without
  submitting; outside the option group and digit shortcuts; disabled while
  submitting (`AskUserQuestion.test.tsx`).
- Unit: App wiring — with `session_side_task`, the pending-question details
  action creates a side-task tab whose `initialPrompt` contains the question
  text, the STE100 instruction, and the `.qwen/tmp/` target; no
  `submitPermission`/`sendPrompt` on the main session; without the capability
  the callback is not offered (`App.test.tsx`).
- Visuals: `client/e2e/visuals/ask-user-details.spec.ts` (mock daemon, real
  Chromium, dark/light, zh-CN UI) — the button renders on the pending panel,
  clicking it opens the side-task tab, and the question stays pending.
- E2E: `.qwen/e2e-tests/` — real daemon, pending AskUser, click details,
  verify side task creation, HTML artifact preview, and that the main question
  remains pending. Executed 2026-11-06 against a real daemon and model; all
  steps passed (evidence: `.qwen/e2e-tests/ask-details-e2e-20261106/`).

## Acceptance criteria

- With the side-task capability, a pending AskUser panel shows "Ask for
  details"; clicking it opens a side task that starts explaining the question
  without any main-session answer being submitted.
- Without the capability (or in embedded/split surfaces), the panel is
  unchanged.
- Existing AskUser keyboard behavior (digits, arrows, Enter, Esc, Ctrl+Enter)
  is unchanged.
