# OpenTUI foreground shell input parity

[English](opentui-foreground-shell-input-parity.md) | [简体中文](opentui-foreground-shell-input-parity.zh-CN.md)

Status: implementation candidate, 2026-10-26. The changes are being verified against a frozen Node+Ink, Bun+Ink and strict Bun+OpenTUI candidate. This document does not authorize release, default-renderer changes or Ink removal. The narrow voice-border regression is included in the same composer batch.

## Problem and evidence

The Ink interface supports promoting one running foreground shell with Ctrl+B, switching keyboard focus to its actual PTY with Ctrl+F, preserving the composer draft, and releasing focus when the shell finishes. Before this change, OpenTUI ran the real interactive tool scheduler and painted structured shell output, but did not expose the executing shell owner to those interactions. A history row's PID is not an authority to control a process.

Before-change real foreground shell fixtures reproduced the gap. Global Ink, Node+Ink and Bun+Ink promote the same still-running child and publish its background task ID. Strict Bun+OpenTUI does not publish that handoff. On main64 plus the narrow composer fix, Node+Ink and Bun+Ink deliver the exact bytes for INNER_A, Left, Return and INNER_B while preserving the separate composer draft. Strict OpenTUI delivers none at the first focus step. These observations use a fake loopback model, real scheduler, real PTY and real keys; they do not qualify an installed candidate or other platforms.

The strengthened resize test also fails in all three Ink controls: the inner width remains 89 after the outer viewport changes from 100 to 72 columns. Preserve that failure as a reference limitation under investigation. Do not describe it as an OpenTUI-only regression or count an earlier focus-induced height change as successful resize. The initial test's broad PASS does not qualify resize.

## Scope and constraints

Restore the foreground shell's existing user interactions as one complete input batch, using InteractiveModToolScheduler, CoreToolScheduler, ShellExecutionService, the original command matchers and keyToAnsi. Reuse existing structured ANSI output rendering and background task registration. Do not add a PTY implementation, runtime switch, dependency upgrade, new shell command or alternate task registry. The separate empty-buffer ! shell mode keeps its existing owner.

Include the small voice-border correction in the same composer batch: use the already calculated topBorderLine when a voice label cannot fit. Widths 1, 5 and 6 have regression coverage, and the actual compiled five-column native composer has been checked. This does not resolve the separate four narrow recording frame differences or qualify a real microphone/provider.

## Execution ownership

Publish the actual executing shell call snapshots from the scheduler callback in live-session, through a production-populated callback in live-turn. Keep controllers and PIDs out of serialized transcript events and persisted history. The live-turn owner must reject updates from an obsolete turn sequence and clear the snapshot when a batch finishes, aborts, resets or unmounts. A previous callback cannot clear a newer owner.

Select exactly one currently executing PTY for input. Promotion separately selects exactly one executing shell with a live promotion controller, matching Ink's selection rules and the core guard. Never infer either owner from the last tool card, a queued/approved call, a completed call, a process-global list or the ! shell's controller. Every newly added callback must have its production setter in the renderer entry; a declaration plus tests is insufficient wiring.

Route promotion through the existing controller's background reason. Do not abort the foreground turn, terminate its child or synthesize a task result. Core remains responsible for the background registry, response and task lifecycle. Existing /tasks and task_stop consumers must observe that actual entry.

## Keyboard and focus

Keep focus identity tied to the current call and PID, rather than a boolean that can transfer to a later process. Ctrl+F toggles between the selected PTY and the unchanged composer draft. Consume the focus key itself; it must not reach the PTY, editor or model. Clear focus when that identity ceases to be current, including natural completion, promotion, cancellation, reset and replacement.

When the shell owns focus, use toOriginalKey and keyToAnsi to forward the same printable, navigation, Return and control sequences as Ink. Reuse the existing PTY scrolling behavior for Ctrl+Shift+Up/Down. Prevent double delivery through both global handlers and the textarea. On return to the composer, restore ordinary editing, Vim/history/paste and draft submission without copying child input into the draft.

Modal, permission, command-dialog and exit ownership take priority. Do not route keys to a shell hidden behind an unrelated modal. Check entry-level Ctrl+C/quit handling as well as the composer handler: focused shell Ctrl+C and empty-draft Ctrl+D reach the global exit/cancel guard before any PTY input, as in Ink. Draft-bearing Ctrl+D retains terminal input and does not stop the global broadcast; first Ctrl+C cancels/arms the hint and the next press follows the existing exit window. Shift+Tab still reaches the app-wide approval cycle, and Ctrl+O/Alt+T still reaches the global thinking toggle; shell focus must not swallow those broadcasts. Preserve their original terminal-byte mapping where it applies. Idle Ctrl+B/F retain their existing editing meaning when no eligible shell exists. Key release events do not perform actions.

## Size and display

Initialize the real shell execution dimensions from the native viewport and resize only its current live owner. Match the declared Ink sizing contract where it is applicable: 0.89 of terminal columns and positive available rows after layout padding. Record reference failures honestly; investigate outer resize delivery before changing shared infrastructure. No test may call resizePty itself to manufacture the product result.

Keep structured shell output in its existing tool card, with visible focus/shortcut information matching the reference behavior. Preserve ANSI token colors and bounded viewport handling. This batch does not claim complete curses/alternate-screen compatibility without actual fixtures and frame evidence.

## Affected layers

- live-session.ts: observe real executing calls and close the batch owner.
- live-turn.ts: own the current turn's selection, actions and stale-update guards.
- start-opentui-ui.tsx: populate the app's actual live-shell props/actions.
- opentui-app-shell.tsx and input-prompt.tsx: arbitrate modal/composer/PTy focus, input consumption and viewport size.
- Collocated tests and an interactive integration scenario: verify callbacks reach production consumers, ownership transitions, bytes, task handoff and cleanup.

No core refactor is planned. If a confirmed shared defect requires a core change, trace all affected consumers and obtain the required maintainer review before widening this batch.

## Verification and acceptance

Run the global Ink baseline and the same frozen candidate as Node+Ink, Bun+Ink and strict Bun+OpenTUI. The controlled model must schedule a real run_shell_command with is_background:false. Require a live unique child PID with actual TTY input/output before evaluating focus or promotion.

For Ctrl+B, require the exact call's tool response to contain the actual background ID, the original child to keep running, and /tasks to show that ID's running and later completed states. A normal response after releasing the child is not promotion. For Ctrl+F, compare the independent literal hex 494e4e45525f411b5b440d494e4e45525f42, no leaked focus byte or extra request, retained draft, natural child exit and exactly one subsequent draft request.

For resize, capture the child event boundary immediately before outer resize72x28 and require a new same-PID event at 64 columns with positive rows. A pre-resize or same-width height change cannot pass. Current Ink failures stay FAIL while investigated; later assertions not reached by an earlier failure remain NOT_RUN, not implicitly green.

Cover zero/one/multiple eligible calls, non-shell calls, unset PID/controller, stale turn callbacks, controller replacement, promotion failure/no-op, normal and aborted completion, dialogs, Ctrl+C, key release, repeated focus toggles and preservation of Vim/history/paste/voice behavior. Integration tests retain raw frames, HTTP requests, child byte/resize events, exact source/runtime/bundle identities and natural exit evidence. The permanent interactive/tui-foreground-shell.test.ts and its owned-shell-child.mjs fixture cover promotion, real focus/draft input and first-C cancellation in all three renderer/runtime legs. The resize case is explicitly OpenTUI-only: the two Ink skips in this regression file do not replace the separate retained Ink resize FAIL evidence. The fixture uses POSIX exec; Windows product acceptance remains separate. The existing three-leg TUI workflow runs the entire file without retries and retains its evidence. Final validation includes build, typecheck, changed whole-file tests, lint and two clean full-diff self-audit passes.

Real installed npm/npx/standalone acceptance, Windows and other declared platforms, real terminal IME/accessibility, complex VT and the final rollout gates remain separate required migration work. Do not promote this local source-bundle evidence into those rows.

## Open decisions

Determine why the actual outer resize does not change inner width in the Ink controls before proposing shared changes. Existing double-interrupt exit policy also differs (Ink 0, OpenTUI 130); observing those current policies is not a final compatibility approval. Final frame parity for the four narrow voice recording cases remains open. The Windows focused bare-Tab approval fallback also needs the full Tab-consumer signal and real platform validation; this batch does not claim it is implemented or accepted. These open questions do not authorize a permanent compatibility exception or an unverified expansion of this PR.
