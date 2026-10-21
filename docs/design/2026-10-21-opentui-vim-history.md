# OpenTUI Vim, ordinary history and reverse search

[English](2026-10-21-opentui-vim-history.md) | [简体中文](2026-10-21-opentui-vim-history.zh-CN.md)

## Status and baseline

This is the input half of one interaction and live-output successor based on
unified UI commit `70794177c203dfbb9e39e2ad797cf28382fae991` by normal merge,
preserving B commit `e5143ba8e4cb431ef48f390f59922216544849fd`. It integrates the
frozen B v3 and [dual-output v6](2026-10-21-opentui-dual-output.md) drafts;
they are not separate deliveries. The earlier A-based designs and evidence are
preserved as provenance. Input admission, attachments, cancellation and native
undo keep their existing owners. The complete combined candidate remains
**NOT_RUN** for install, build, typecheck and runtime validation; no earlier
candidate result certifies this tree. The merged package and lock inputs require a
new frozen setup before validation. OpenTUI stays `0.5.10`, Bun `1.3.14`.

The parent reset discard outcome releases only the cancellation latch, without
popping queues or restoring old drafts. This batch retains that contract and
the guard preventing an old generation from changing successor input.

The frozen A bundle `8473becd7f80` reproduces a shared Ink defect: after real
`/vim`, the paced keys `2`, `d`, `w` turn `one two three` into `three`, but one
PTY write `2dw` leaves the original text. NORMAL Enter sends exactly one HTTP
request containing each observed result. Both cases passed real mode/settings
setup. An earlier native parser probe showed the same difference. This is not an
OpenTUI-only defect; B preserves Ink's paced semantics for batched decoded keys.
The original startup-fixture failure and both behavioral failures remain saved.

## Scope and ownership

- Reuse every existing Ink Vim command family, count, register, find/repeat and
  mode transition. Do not add visual mode, text objects or regex search.
- Keep one native textarea, one native undo history and the existing Vim parser.
  Reuse logical motion/range algorithms instead of native word/visual movement.
- Complete ordinary/shell recall and reverse search together with their actual
  live-user, host-history and session producers. Injected history is insufficient.
- Preserve A's editing, external editor, claimed/pending paste, image and cancel
  contracts. NORMAL Enter must reach the same admission owner as ordinary input.
- Do not change core history/stream protocols, distribution or dependencies.
  Slash eligibility/order, delete-log purge and cancelled transcript/logger
  rewind remain separate full-history work; this is partial history parity.

## Shared parser and native boundary

The existing `vimReducer` reduces each action into a synchronous ref, then
publishes that snapshot through React state. Character reads use the same ref.
No timer, new input queue, alternative parser or global `flushSync` is needed.
Provider changes still update the parser; the mode displayed is published state.

The parser currently reads 33 Vim actions, live `text/lines/cursor`, range edit,
undo and INSERT handling. Clearing now belongs to each real submission caller. Narrow the required input structurally;
do not implement unused TextBuffer viewport/selection methods as fake values.
Keep the existing geometry algorithm in place and retain its Ink compatibility
entry. Native converts logical code-point positions with existing utilities.

The parser lives in persistent OpenTuiEntryApp, matching Ink AppContainer's
lifetime; modal changes and session reset do not invent a register/count/dot
reset. Composer still unmounts under A's ownership contract. Its ref callback
clears the native editor, and no modal key subscription reaches Vim or retains
a disposed textarea. NORMAL Enter calls the current composer's submitDraft
handle, retaining claimed/pending and rejection recovery. Native regression
checks register/count/dot across unmount and that modal keys remain unconsumed.

The accepted A API-only probe passed all 7 caret and 6 no-op checkpoints with
real `0.5.10`: arbitrary-caret replacement, redo then typed marker, movement
without undo, and an empty `dd` retaining its Ink undo point. It had
`parserInput=false`; it does not certify this adapter. The old `2dw` and `fx;`
batch failures remain preserved, including the fixture-blocked clipboard call.

The input owner order follows current Ink: focus/release and bracketed paste,
visible category arrows, then Vim, then applicable search/completion/chip/default
handling. Raw Backspace yields to the parser when Vim is enabled. INSERT shares
the existing pure TextBuffer key dispatcher and nine editing callbacks; it never
falls through to native default bindings. Word deletion uses the existing Ink
geometry branches, while the native buffer alone records edits/undo/redo. Pending `r/f/F/t/T` owns Enter
before NORMAL submission. Only the parser's actual accepted Enter branch may
call admission; move clearing to real caller ownership, preserving Ink behavior
and OpenTUI's rejection/successor recovery. Do not intercept solely by mode.

## History, search and mode consumers

Restore the retained history/search changes as a capability, not the old whole
candidate. Reuse the history/search hooks and current key matchers. Refresh the
logger snapshot on actual host-history/session changes, discard stale responses,
and combine current ordinary user messages without rereading on every token.
Keep shell recall/search and Escape snapshots consistent with current Ink.

History recall uses `recallText` when present and retains the non-steer filter.
Selecting a reverse-search history entry is imported input even when its text
matches the current draft: discard the restored source identity before admission.
Escape restores the original text, cursor, known/unknown source, restored draft,
and paste payload/ID mappings after an edited or cleared query. A selected history
row cannot reuse the abandoned draft's paste mappings. Vim's existing nonempty
paste callback reaches the current composer and marks imported input unknown;
empty clipboard paste leaves the draft's source unchanged. Ink keeps its real
submission metadata and the same callback. No native undo or parser family changes
are required for these merge boundaries.

Search shares a renderer-free label calculation with Ink: 150 UTF-16 units,
the same match window/highlight, and `→`/`←` on the active long candidate. Preserve
149/150/151, inactive rows, head/middle/tail matches and actual expand/collapse
evidence. Do not change slash/@ completion or unrelated suggestion columns.

The existing Vim provider, `/vim` action, settings and visible mode hint have
real producers/consumers. The unified parent supplies the shared status-line
hook: the entry's enabled mode now reaches both the footer and the hook's
`vimMode` input. NORMAL, INSERT and disabled wiring have collocated regressions;
the existing hook tests cover JSON generation. These source connections still
require combined native and product validation; no U3 implementation is copied.

## Delivery and acceptance

Parser synchronization, native adapter/owners, history/search and status mode
are delivered together with the existing live-output bridge wiring. The original
B v3 draft changed 3137 lines and U4 v6 changed 1869; their sum is not the final
net diff. The frozen combined manifest reports actual production, test and
documentation size. Consolidation follows the requested single review batch;
never remove command families or negative assertions to satisfy a line target.

Acceptance requires shared parser/action tests, real native batch/caret/no-op/
undo/owner tests, and Node+Ink, Bun+Ink and strict Bun+OpenTUI product legs. Verify
real `/vim` persistence, exact submission and rejection recovery, current-session
submit→HTTP→Ctrl+R→candidate→resubmit, search arrows/window, shell history and
resize. Include A's input/attachment/cancel regressions. Unit callbacks do not
prove decoder, clipboard, native ownership or HTTP behavior. Freeze complete
source/dist/fixture/runtime identities; retain first failures and verify owned
cleanup. Build/typecheck, affected gates and two clean full-diff audits precede
independent acceptance. All combined candidate execution is currently **NOT_RUN**.
