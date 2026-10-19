# Session busy diagnostics

[English](session-busy-diagnostics.md) | [简体中文](session-busy-diagnostics.zh-CN.md)

## Problem and scope

`/branch`, `/fork`, and `/cd` reject an active session with the same generic
message. A model request without incoming content, compaction, tool approval,
and an unsubmitted tool result can all look idle to the user. The original
report does not establish which activity blocked that particular session.

This change explains the blocker. It retains the existing streaming guard and
also checks pending slash-command work before changing or copying a session.
It does not add `/branch --why`, change compaction policy, or repair an
unconfirmed stuck-tool lifecycle.

## Design and rationale

The interactive app supplies a live reason reader to the slash-command context
through its existing action bridge. A ref keeps this reader current without
rebuilding the command context on every stream update. The reader consults the
current chat's compression activity at invocation time: compaction can start
and finish without a React update. The chat counts active compression-service
calls and releases the count when each call settles, including failures and
cancellation. This is observational state and does not change compression
admission, history, persistence, or returned results.

A shared CLI helper reports, in order, pending compaction, tool approval,
subagent approval, named executing/scheduled/validating tools, and named
completed results not yet submitted to the model. Otherwise it distinguishes
incoming model content from a request with no content arriving. Pending slash
commands receive their own explanation. Contexts without the reader retain a
generic busy fallback. Every rejection names the requested operation and gives
a matching wait, approval, or cancellation action. Messages expose tool names,
never tool arguments.

The OpenTUI live-turn driver supplies a compaction-only reader through its
stable host and command context. OpenTUI queues these three commands during a
live turn, so their tool and response diagnostics have no reachable consumer
there. Its existing queue admission stays unchanged; commands that actually
dispatch read current compaction and pending slash-command activity. Ink also
defers these typed commands during a live turn. Its full action-time classifier
provides defensive diagnostics at the command boundary, including subagent
approval; the composer hides input while approval is pending. These classifier
cases do not establish typed-command reachability in those states. Both
renderers use complete sentence translation keys. All built-in locales translate the
operation prefixes and reasons, enforced by the must-translate list and
placeholder-parity checks.

Affected areas are the chat compression service boundary, the interactive apps,
the slash-command action/context bridge, the three command guards, the shared
reason helper, translations, and focused regression tests.

## Constraints and risks

The reason reader is optional for noninteractive contexts. Background agents
alone do not block these commands. The reader must not retain a stale
compaction flag or describe an unsubmitted result as an executing tool.
The additional pending-item guard prevents a session transition during manual
compaction even when the model stream is idle.

Core consumers of the compression method (automatic pre-send/reactive recovery
and manual compression via the client) keep their existing behavior. The only
consumers of the new activity accessor are the Ink and OpenTUI reason readers.

## Validation and acceptance

- All three commands explain a supplied blocker and stop before session or
  filesystem changes; idle happy paths remain available.
- Approval, executing/scheduled/validating tools, unsubmitted success/error/
  cancelled results, streaming, and requests without content have distinct
  coverage. Submitted results do not keep a session busy.
- Manual pending compaction blocks even with an idle stream. Automatic
  compaction is read live and clears on service resolution or rejection.
- Run focused CLI/core tests, build, typecheck, lint/format checks, and bundle.
- Re-run the baseline command-level reproduction and inspect actual messages.
  Full interactive reproduction depends on an available CLI/terminal harness;
  record any unavailable layer explicitly in the PR.

## Open questions

None for diagnostic scope. Whether background-only compaction should permit
session transitions, and whether the reported session had a stuck tool result,
remain separate maintainer/reporter investigations.
