# OpenTUI editor transaction: editing, external editor and cancellation

[English](2026-10-21-opentui-editor-transaction.md) |
[简体中文](2026-10-21-opentui-editor-transaction.zh-CN.md)

Current delivery (2026-10-21): this work is consolidated with input ownership,
editing and status lines in [#14964](https://github.com/QwenLM/qwen-code/pull/14964).
The original batch boundaries, source bases, validation results and stack-promotion
steps below are historical. Follow the [delivery plan](2026-10-20-opentui-migration-delivery.md)
for the active sequence. Combined acceptance requires fresh results for the
integrated commit and is still pending.

## Status and boundary

The [clipboard/source lifecycle batch](2026-10-24-opentui-clipboard-source-lifetime.md) keeps external editing on the same raw expanded draft and final submit owner. Model-facing framing is applied only after pending paste settlement, never by the editor or prepared Retry. Its candidate verification is separate from the historical results below.

This A batch starts at U2A `269600799782a5c507d62f3ae0db011c768be234`
([#14946](https://github.com/QwenLM/qwen-code/pull/14946)). It is split from the
preserved U2B v10 candidate to keep one complete transaction within the intended
2–3k-line review size. Local author and independent validation passed on this
new A source and bundle: build/typecheck, 488 focused tests, two native scripts,
19 formal product scenarios on each of three legs, and the U2A ownership
regression. Independent verification passed 16 new Node+Ink controls and the
same 16 strict OpenTUI scenarios, with unchanged source/artifact guards and
successful cleanup. Linux CI and Windows remain pending. Earlier whole-candidate
results remain source evidence, separate from this new acceptance.

Include character/word/line editing, native undo/redo, external editor handoff,
and the complete main-input C/D/Escape cancellation and exit ownership path.
Keep OpenTUI 0.5.10, Bun 1.3.14, one native textarea and the existing U2A queues.
No dependency, runtime, distribution or core changes belong to this batch.

Ordinary/shell recall, current-history producers and Ctrl+R search remain in B,
to be designed with Vim navigation/key ownership. Their preserved search-arrow
failure and v10 untested repair remain open. Slash eligibility, delete/logger
purge and cancelled transcript/core/logger rollback require separate investigation;
they are not added to meet a line target. OS clipboard, IME, accessibility and
other dialog/worktree/`btw` exit contracts are outside A.

## Editing and terminal handoff

The native textarea owns text, selection and undo. Home/End and Ctrl+A/E use
visual-line boundaries; Ctrl+K/U join logical lines at their boundary. Ctrl+Z
and Shift+Ctrl+Z use native undo/redo. Word movement reuses Ink's pure logical
target calculation plus existing code-point/display-column conversion; native
buffer mutation remains the sole owner. Release events do not repeat actions.

Share Ink's external invocation: explicit override, preferred editor, `VISUAL`,
`EDITOR`, platform default; file mode `0o600`; existing Windows checks/quoting;
inherited stdio; 30-minute timeout; CRLF normalization; temporary-directory
cleanup. Preserve sandbox policy and all original failure behavior.

OpenTUI waits for the draft's pending paste before taking an editor snapshot.
Clear, submit, session replacement and unmount invalidate late output; it cannot
overwrite a successor or its attachments. Suspend before launch and resume in
`finally`. Changed output is one native replace/undo transaction with the caret
at its end; unchanged output adds no undo step. Verify subsequent input and
resize after success, unchanged output, nonzero exit, signal and delayed return.

## Cancellation and exit ownership

Read the live composer buffer for Ctrl+D: nonempty D stays editing. C arms before
cleanup, so a fast second C exits. Empty D cancels a responding turn without
pre-arming. At a pending approval, D preserves the confirmation and arms D/D exit;
C cancels it while retaining the exit window. Reuse the existing expiry/mixed-key
guard. Confirmed keyboard exits use 0 in all three renderer/runtime profiles,
after the shared cleanup drain; actual OS-signal termination retains its signal
code. Historical 0/130 observations remain baseline evidence, not acceptance
of the mismatch. Harness cleanup is not a graceful exit.

Composer cancel registers one callback on the current live-turn sequence. Keep
the callback, structured queue pop, draft restore and start-level C/D dispatch
in this batch. Once the aborted generator settles, prepend returned text/images
to the current successor. Restore the original admitted prompt only before tool
start and when the same empty draft/session remains, with no queued entry,
pending paste or claimed submission. Generated turns are not editable returns.
Reset/unmount invalidate stale callbacks; every aborted turn suppresses automatic
queue replay. Bare `/quit` neither restores nor restarts late returned steering.

U2A's pending Enter claim stays separate: clearing its successor does not cancel
that claim. Input restoration does not imply transcript/core/logger rewind.
Keep attachment bytes/provenance, exactly-once admission and successor priority.

## Production consumers

| Contract                | Consumers                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Shared word target      | Ink text-buffer reducer; OpenTUI key adapter                                                  |
| Shared external editor  | Ink TextBuffer → BaseTextInput/shared TextInput; OpenTUI composer                             |
| Preferred editor        | Existing settings → app shell → composer → invocation                                         |
| Composer handle         | Entry early-input/C-D handlers; app shell; composer                                           |
| Cancel-settled callback | Composer Escape/entry C-D → live-turn current-sequence finally → composer restore             |
| Structured pop          | Existing live-turn and deferred-command queues → composer; bare quit clears without restoring |

## Validation and acceptance

Use one coordinated heavy lease, sequential commands, one worker, zero retries
and fatal unhandled errors. Build/typecheck this A tree before changed CLI tests.
Retain shared text-buffer/editor tests plus composer/live-turn/start ownership
tests, including late steering/images, pending/claimed input, reset/unmount,
generated/tool-start exclusion and bare-abort no-replay. These seams cannot be
replaced by a successful PTY cancellation case.

Run real native editing/undo/decoder and the U2A ownership regression. The native
external backend is injected; actual process behavior is covered by an owned
editor script recording arguments, mode, input/output and exit under owned HOME
and TMPDIR. Run A's 19 product scenarios on Node+Ink, Bun+Ink and strict OpenTUI.
Assert visible text/caret effects and exact HTTP payload/count, not only exit 0.

Independent acceptance includes exit5, word8, editor2 and cancellation1: no
automatic resend, then explicit resend exactly once with the full successor.
Use A-owned fixture paths and a new source/artifact manifest; old-tree wrappers
cannot validate A by changing an environment variable. Preserve first failures,
input bytes, raw ANSI, visible frames, runtime hashes and cleanup results.
Finish two clean full-diff audits after fixes and verification.

The local A test plan in `.qwen/e2e-tests/u2b-editor-transaction-plan.md` records
the source mapping and historical evidence. The separate native Markdown rendering
of `HELD_HEAD_1HELD_TAIL_1` drops internal underscores; changing a cancellation
sentinel did not fix that transcript discrepancy. OpenTUI 0.6.6 retains the
relevant editor-binding differences, so this batch does not upgrade dependencies.
