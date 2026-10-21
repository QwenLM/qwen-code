# OpenTUI Vim, ordinary history and reverse search

[English](2026-10-21-opentui-vim-history.md) | [简体中文](2026-10-21-opentui-vim-history.zh-CN.md)

## Status and baseline

This is the input half of the complete interaction/live-output Draft #15067,
with [dual output](2026-10-21-opentui-dual-output.md), normally merged with UI
`c1f802b0c1d237d9641b8217bdc97e8d37049f51`. The reviewed source checkpoint is
`7a1ab30f616c5f688224b1dac1fcf0fc76e26966`; earlier A-based, B v3 and U4 v6
snapshots remain historical, not separate deliveries. Input admission,
attachments and cancellation retain their existing owners; the existing Ink
buffer now owns text, code-point cursor and undo for ordinary and Vim editing.

The actual runtime artifact was built at `194bfffcdd45e19f007aa28ceeb8dfea8402f84f`;
7a1 changes only four fixture waits to observe the visible mode, with the same
literals and 12 s limits. Production and dependency inputs are byte-identical;
tests use source 7a1 and the guarded 194b artifact, not a claimed 7a1 rebuild.
Recorded local validation is complete for this checkpoint: mapped source/native gates, the fresh 194b build/type/bundle, and all eight 7a1 continuation stages. The three full legs have 108 passing test rows: 106 functional passes and two retained Ink deny gaps; the overlapping strict four-case gate is separate. Prepare and the actual npm tar six-entry executable-mode check passed; neither establishes installed R3+B or audio capture acceptance.
The accepted installation is reused under dependency/tool/runtime guards.
Original ba04/f93 declaration/source failures, d677 Unicode failures, aab54
Escape failure, b4 stale `/vim` message and 194b raw-wait failure remain preserved.
They are not relabelled as passing. OpenTUI remains `0.5.10`, Bun `1.3.14`.
The parent UI is not merged; this checkpoint does not make the stacked PR Ready.

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
- Keep one native textarea as the view, one existing Ink TextBuffer as the sole
  text/cursor/undo owner, and the existing Vim parser. Do not add a cursor-history
  ledger, shadow undo implementation or dependency.
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
Keep the existing geometry algorithm and undo reducer unchanged. The native view
receives a projection; its display coordinates never replace the owner’s exact
code-point cursor after an edit.

The parser lives in persistent OpenTuiEntryApp, matching Ink AppContainer's
lifetime; modal changes and session reset do not invent a register/count/dot
reset. Composer still unmounts under A's ownership contract. Its buffer ref
clears on unmount, and no modal key subscription reaches Vim or retains
a disposed textarea. The existing narrow adapter forwards to that live Ink buffer
without storing text, coordinates or undo history. NORMAL Enter calls the current composer's submitDraft
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
geometry branches, while the existing Ink buffer alone records edits/undo/redo. Pending `r/f/F/t/T` owns Enter
before NORMAL submission. Only the parser's actual accepted Enter branch may
call admission; move clearing to real caller ownership, preserving Ink behavior
and OpenTUI's rejection/successor recovery. Do not intercept solely by mode.

## Unicode repair and view boundary

Exact d677 failed both the native gate and independent diagnostics: after
`i甲🙂éZ`, Ink contains `甲🙂éZ` but the adapter contains `甲🙂eŹ`;
Escape→x deletes different code points, and undo restores equal text with
different logical cursors. The three-sequence diagnostic v2 completed with
TEXT_DIVERGENCE; v1’s clipboard-stub control error remains separately preserved.
No display-cell-only assertion may replace these exact text/cursor checks.

Reuse `useTextBuffer` directly in the OpenTUI React composer. Its synchronous
state ref/getters and existing reducer supply every edit and undo; no offscreen
Ink renderer or copied reducer is needed. Keep the persistent entry’s `useVim`
parser and pass its actions through a live composer-buffer ref. Vim hot toggles
do not remount, replace, clear or migrate the buffer/history. Dialog unmount
retains the existing composer lifetime and the parser’s register/count/dot state.

The accepted history contract is Ink’s existing 100 undo entries, including
no-op Vim snapshots and one changed external-editor import. Native history is
not retained in parallel. Normal editing, raw backspace, bracketed/clipboard
paste, completion, history/search, captured input, queue/cancel restoration and
external editing must all write the same buffer. Source/attachment ownership
stays in the existing composer transaction; a text/cursor change alone cannot
claim pending images or invalidate a successor.

Native textarea remains focused and renders text, selection and the terminal
caret. Its default editing/paste handlers must not mutate a second text owner.
Mouse and selection are explicit input events: map their visible bounds once
to the buffer, perform a single existing range edit, and clear the selection.
Projection-generated cursor events must not round-trip display columns back to
code points. Native widthMethod, wrapping, scrolling and resize remain real
view boundaries; combining marks and ZWJ clusters require next-edit assertions,
not only equal cells. If the pinned API cannot preserve a required selection or
projection behavior, report that specific boundary before adding an abstraction.

Mandatory verification includes the original three strict sequences, ordinary
input and selection replacement/undo/redo, mouse then typing, small/large/image
paste, IME committed chunks and physical focus/caret, external editor and
same-text imports, hot Vim toggles, wrapped/resize motion, and queue/session
successors. Real-device IME and unexecuted platform legs remain NOT_RUN. The
checkpoint above records actual owner validation; earlier d677 unit passes are
not reused to certify the changed owner.

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
submission metadata and the same callback. No parser family changes are required for these merge boundaries. The Unicode
repair changes the editing owner without changing the metadata contract.

Search shares a renderer-free label calculation with Ink: 150 UTF-16 units,
the same match window/highlight, and `→`/`←` on the active long candidate. Preserve
149/150/151, inactive rows, head/middle/tail matches and actual expand/collapse
evidence. Do not change slash/@ completion or unrelated suggestion columns.

The existing Vim provider, `/vim` action, settings and visible mode hint have
real producers/consumers. The unified parent supplies the shared status-line
hook: the entry's enabled mode now reaches both the footer and the hook's
`vimMode` input. NORMAL, INSERT and disabled wiring have collocated regressions;
the existing hook tests cover JSON generation. The checkpoint records combined
native/product evidence within its stated scope; no U3 implementation is copied.

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
independent acceptance. The current checkpoint and its source/artifact mapping
are recorded above. Installed R3+B, real middleware and unexecuted platforms
remain separate gates.
