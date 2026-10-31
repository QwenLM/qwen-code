# Interactive program status (OSC 7501)

[English](program-status.md) | [简体中文](program-status.zh-CN.md)

## Problem and scope

Issue #13870 requests terminal-visible agent status without screen parsing. Existing OSC 9;4 progress only shows tool activity. Add OSC 7501 to the interactive Ink UI, with no dependencies, terminal allowlist, feature query, notification setting, or focus tracking. The OpenTUI renderer is outside this change.

## State mapping

Every state report other than `clear` identifies `app=qwen-code`. At startup report `idle`; responding reports `working`. Tool approvals and trust dialogs report `blocked:kind=permission`; question tools and other visible dialogs report `blocked:kind=question`; authentication reports `blocked:kind=auth`, taking precedence over other dialogs. An active turn becoming idle latches `done`, or `error` when the stream reports a terminal failure, including authentication expiry or a failed retry. This per-turn failure signal resets on new model or shell turns without clearing the previous error banner. A terminal failure reported during asynchronous finalization upgrades a latched done result to error. Individual tool errors that the model recovers from do not fail the turn. Failures in concurrent side queries and their detached tool continuations do not change the foreground turn outcome. Cancelling reports `idle` and suppresses completion for the cancelled turn; a visible input dialog still reports its blocked kind during cancellation. Starting the next turn replaces the latched result with working/blocked. Opening a dialog temporarily overrides the latched result; closing it restores that result. Startup dialogs alone do not create a completed turn.

## Emission and lifecycle

`use-program-status.ts` builds reports using the OSC code map and existing builder/multiplexer wrapper. It writes directly to stdout to bypass Ink interception and suppresses duplicate reports. Only a TTY stdout enables the hook or its cleanup listeners. The hook is mounted in `AppContainer.tsx` after dialog aggregation and is absent from headless, JSON and ACP entry points.

Unmount and process exit clear unfinished states and remove listeners, preserving done/error so the terminal can retain the result. A dialog overriding a result is still cleared to avoid leaving a blocked tab. Configured terminal editors and recognized terminal commands in the file launcher and prompt buffer, plus terminal diff editing from a tool confirmation, emit terminal release/acquire events: clear before handoff and restore the current report after return, including failed launches. Configured GUI editors emit neither event. Untyped environment/explicit commands are matched against core editor commands and a bounded set of terminal-only names; unknown or mode-dependent commands such as emacsclient emit neither event. Users needing handoff reporting for an unrecognized editor can select a supported terminal editor. Acquire is paired only with a release, including when preparing a temporary file fails. SIGCONT restores the report after resuming only while the CLI owns the terminal. Separate status and last-written refs preserve duplicate suppression across clears and StrictMode effect remounts. No SIGTSTP handler is installed: adding one would replace Node's default suspension semantics. Pre-suspend clearing is deferred until the CLI owns an explicit suspend lifecycle; SIGSTOP and operating-system sleep cannot be intercepted. Embedded PTY shells retain UI ownership and do not clear the report.

## Validation and acceptance

Focused hook tests assert exact wire bytes for idle, working, all three blocked kinds, latched done/error, next-turn reset, cancellation, duplicate suppression, exit/unmount cleanup, handoff restoration, and non-TTY silence. Existing OSC tests cover framing and multiplexer wrapping. Run the full build and typecheck, focused tests, and changed-file lint/format checks. Capture raw PTY bytes for interactive startup/exit and use a deterministic model server for turns when feasible; validate machine output contains no OSC 7501. Supporting-terminal presentation remains a manual check.

## Risks and follow-up

The terminal decides how to display or ignore this vendor-origin protocol. Completion is inferred from the existing UI state and history rather than adding a core lifecycle API. No free-text payloads or credentials are sent. Focus resets, pre-suspend clearing, and OpenTUI support can be separate follow-ups. There are no new settings or migration requirements.
