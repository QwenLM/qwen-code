# OpenTUI parity defect sweep — frame-level acceptance against ink

[English](2026-09-10-opentui-parity-defect-sweep.md) | [简体中文](2026-09-10-opentui-parity-defect-sweep.zh-CN.md)

Design doc for the defect sweep that followed the OpenTUI migration's tenth
batch. The migration had been declared complete on the strength of its unit
and integration suites, but a first look at the running renderer next to ink
showed a UI that did not read as the same product: no banner, a footer that
did not match, missing loading states. Those three were restored separately;
this document covers what a systematic frame-by-frame comparison found behind
them, and the fixes that came out of it. Plan paragraphs and the running gap
ledger live in [#8662](https://github.com/QwenLM/qwen-code/issues/8662).

## Problem

Code correctness had been established; perceptual equivalence had not. The
two renderers share their command layer, their tool layer and their history
model, so a test that asserts on state passes identically for both while the
screen they paint diverges. Three groups of gaps, all observed on a real pty
rather than inferred from source:

1. **Decisions the confirmation dialog took away from the user.** Every tool
   confirmation was answered from one generic four-row list. The always-allow
   rows did not say what they were allowing, were offered in an untrusted
   folder where a durable rule should not be on the table at all, and plan and
   edit confirmations were offered the wrong outcome sets outright. Behind
   that sat a silent process-wide failure: every OpenTUI session lost
   AST-based shell analysis, so permission rules came back empty and
   command-safety classification dropped to its conservative fallback.
2. **Chrome that did not line up.** The footer truncated its status row to one
   line, the loading indicator advertised a token estimate no caller ever
   supplied, popups spanned the terminal edge to edge, the completion dropdown
   sized its columns without counting the source badge it never populated, and
   Shift+Tab was advertised by the footer but unbound.
3. **Conversation rows this renderer never produced.** The context-file
   announcement, the extension-refresh notice and the model-dialog cancel
   notice all exist in ink and reached the transcript there; here they were
   either never emitted or emitted into a channel that draws nothing. Two
   glyph tables had also been copied rather than imported, and the copies had
   drifted from ink's presentation-selector suffixes.

A fourth group was found while fixing the first three, and is structural
rather than cosmetic: a removed layout prop is not reset by the renderer's
reconciler, so the dialog and the composer — two `<box>` elements occupying
the same slot — leaked each other's margins and widths.

## Method — the observation channel is a reconstructed screen, compared as a sequence

Raw pty bytes cannot be diffed. A renderer that repaints in place emits cursor
addresses, erasures and partial cells, so the same screen arrives as two
different byte streams and two different screens can arrive as the same one.
The harness therefore drives each renderer through an identical scripted
scenario under a pty, reconstructs the screen at each declared checkpoint, and
writes that reconstruction out as fixed-width text. Comparison happens on the
reconstruction.

Each scenario runs twice, once per renderer, from the same bundle and the same
boot arguments, and checkpoints are declared by the scenario rather than
sampled on a timer, so both legs are captured at the same point in the script
rather than at the same wall-clock moment. Twenty-seven scenarios cover boot, a
narrow terminal, typing and completion, `@` completion, mid-stream indicators,
a tool run under auto-approval, a tool confirmation, the slash dialogs, the
approval-mode cycle, the auto-mode boot notice, an error path, a resize, clear
and exit, a long hold that cycles the loading phrases, a to-do card, the
question dialog on its own, the same dialog across three questions with a
multi-select and a typed answer, that dialog's free-text row corrected in the
middle of a typed value, the same dialog's chip row on a terminal narrow enough
to ellipsize a header, the release of a parked confirmation when the
approval mode changes, the approval of a gated server at startup, a tool call
whose arguments are long enough to be capped, a control arm that repeats that
call with the arguments row switched off, an answer long enough to overflow
the terminal, a scroll through that overflow and back, two answer rows wide
enough to show where the wrap happens, and a turn that parks two calls on
approval at once so the first waits behind the second's dialog.

Three properties of the comparison matter for reading the results.

**Vertical anchoring is a property of the reconstruction, not of the two
screens.** This renderer paints a window the size of the terminal, with the tail
of the conversation above its input line. ink's live area occupies the same place
in a real terminal, but the harness rebuilds ink's screen from what ink wrote, so
the block lands wherever ink's own repaints put it: under a tall dialog that is
rows 6 to 25 with the rest of the window blank, while this renderer sets the same
dialog flush against the last row. Absolute row indices therefore still do not
line up across the two legs in general, and a diff that aligns on rows would
report the reconstruction instead of the defect under test. The comparison strips
blank rows and diffs the two resulting sequences with a longest-common-subsequence
pass, which is invariant to where the block sits and sensitive to what it
contains. Where the content fills the window exactly the sequences do coincide,
and the overflow arm of Decision 26 is compared row for row rather than as a
sequence.

**A divergence needs a control arm before it is attributed.** The OpenTUI leg
runs under a different runtime than the ink leg, so any divergence is a
candidate for "the renderer did it" and "the runtime did it" at once. Where
that ambiguity mattered, a third leg ran ink under the OpenTUI runtime. It
reproduced the missing shell-crawler diagnostics on ink, which moved that
finding out of the renderer's column; it did not reproduce the missing
extension-refresh notice, which stayed in.

**The channel a scenario waits on is not the channel it compares on.** A
checkpoint is reached by waiting for text the script expects to see, and that
wait scanned the byte stream. A renderer that repaints whole lines satisfies
it, because the line arrives contiguously; one that repaints only the cells
that changed never does. A dialog question edited in place from one wording to
another reaches the stream as the handful of cells that differ, so the wait
times out on a screen that is already correct — the leg that failed this way
had drawn the row it was waiting for, and the stream carried a five-cell
fragment of it. Waits now poll the reconstruction as well as the stream, and
the two channels agree. Reading the stream first is not redundant: it is cheap,
and it still sees text that has scrolled out of the reconstructed window.

## Decision 1 — the confirmation dialog asks ink's per-type question

The dialog now builds its option list from the confirmation's own type rather
than from one shared shape. An execution approval names the command root it is
about to permit, so "always allow" says what it will cover later; a plan
confirmation offers to restore the approval mode it replaced; an edit
confirmation offers the session-wide allow-always that an edit actually
supports instead of the project and user persistence outcomes it does not. The
durable-scope rows are withheld in an untrusted folder, because a permission
rule for a workspace the user has not trusted is not a decision the dialog
should be putting in front of them. Rows are numbered and a digit key picks
one, matching the inline prompt.

## Decision 2 — the shell AST parser must be warm before the renderer boots

The renderer's constructor installs a bare `globalThis.window` to hang its
animation-frame shim on. The parser's UMD wrapper probes
`window.document.currentScript` when it is first evaluated, so the first
dynamic import after that point throws — and the parser latches that failure
for the rest of the process. The import is therefore forced during startup,
while `window` is still undefined, ahead of any renderer construction.

This needed one line from the core package: a re-export on its index so the
startup path can reach the warm-up helper without a deep import. The parser
stays dynamically imported everywhere else, so the deferred-runtime invariant
is unchanged. The change is committed on its own for that reason — it is the
only edit in this sweep that crosses into core.

## Decision 3 — the footer keeps ink's status rows and the loading indicator gets a real estimate

The status row wraps inside a two-line budget instead of truncating to one, so
a narrow terminal pushes the model segment onto a second row the way ink does
rather than dropping it. The hint row stays truncated, because a row that can
grow would resize the footer mid-turn and move the composer under the user's
cursor. The hint row also carries the approval-mode name that the composer
stopped drawing: ink uses that text as an accessibility label rather than a
visible row, and this renderer has no accessibility surface, so the text has
to be visible somewhere or it is nowhere.

The loading indicator declared a character counter and a receiving flag as
props that no caller set, which pinned its output-token estimate at zero and
its direction arrow permanently down. Both now come from the live turn and
count model text, thoughts and tool-call arguments as ink does, falling back
to the waiting phase when tool results go to the model.

## Decision 4 — dropdown columns are derived, and Shift+Tab is a shell-level binding

The dropdown's label column follows the mode being completed. A slash list
shares one half-width column so descriptions line up; a file list does not,
because ink only shares a column where a row carries a description to line up
against, and clamping a plain path to half the width wrapped it mid-word onto
a second row. The row budget also accounts for the dropdown nesting its own
side margins inside the composer's, which had left two columns too many for
the description and wrapped its tail.

A label and its argument hint were concatenated into one run, so a hint too
long for the column word-wrapped the whole string and grew the row to three
lines. They are laid out as separate children and broken at the column edge,
which puts the continuation at the hint's own offset.

Shift+Tab was unbound, so the footer advertised a shortcut that did nothing.
The binding lives in the shell rather than the composer: ink mounts its mode
indicator at app level, disabled only for one tab view, so the cycle keeps
working while a dialog or a confirmation has the composer unmounted. The
composer keeps only the Windows bare-Tab fallback, which is the one route that
has to know whether Tab was already spent accepting a completion. The cycle
order comes from the shared list of modes rather than a copy of the enum's
declaration order, so it cannot drift from the one ink walks.

## Decision 5 — the auto-mode notice is gated where both routes into auto mode meet

ink gates its auto-mode entry notices on the session not already holding the
mode. The rotation could never violate that, so the guard looked redundant
here and was left out — but the approval-mode dialog opens with the current
mode already selected, so a bare Enter re-picks it. The first-time message
survives a re-pick because it is acknowledged in settings; the notice listing
the allow rules auto mode stripped does not, and reprinted on every re-pick.
The gate now sits where both routes meet.

## Decision 6 — popups get ink's geometry, and the help dialog gets a window it can page

Every popup spanned the terminal edge to edge while ink wraps its popups in a
two-column margin and caps their width, so a border ran from column 2 to
column 97 and stopped there. The wrapper now supplies both, which is what
makes a dialog read as a dialog rather than a full-screen mode. The
confirmations deliberately stay outside it: their body measures the terminal
width to estimate how its text wraps, so narrowing the box without narrowing
that measurement would corrupt the estimate.

The help dialog opened on its command list rather than its overview, and its
tab keys did not match the ones the footer advertised. The overview is now the
opening tab, Tab and Shift+Tab cycle in the two directions the hint promises,
the arrow and page keys move the command window and are inert on a tab that
has none, and no other key closes or navigates — closing on a bare letter key
meant a typo dismissed the dialog.

That command window was a fixed eighteen rows whatever the terminal height,
which is more than the body budget leaves once the tab's introduction line,
its gap and the scroll hint are counted. The overflow had been resolved by
dropping the gap and clipping the hint away entirely, so the scroll position
the hint reports was simply absent. The window is now sized to what the budget
leaves after that chrome, and paging moves by the window actually on screen.
Below a 42-row terminal this shows a shorter list than ink does, which is the
smaller loss: ink keeps its eighteen rows and clips the hint instead.

The model dialog drew its detail rule twenty characters wide against ink's
full-width one and showed no line under a model's title. ink folds the runtime
and discontinued markers into the row description as well as the title, so a
runtime model with nothing of its own to say still gets an explanatory line;
the entries now carry that, and the rule is spelled out to the frame's inner
width because there is no single-sided border here to draw one with.

## Decision 7 — a tool's streamed output is a cumulative snapshot, not an increment

The stream event that carries a tool's output was shaped like the text and
thinking deltas beside it, so consumers appended. The scheduler does not
stream increments: it emits the whole display produced so far on each chunk
and then a final result carrying the whole display again, so appending painted
the tail of the output twice. The event is renamed to say what it holds, and
the card replaces rather than accumulates.

The reducer that folds these events has no production caller — only its own
test file. That predates this sweep; the rename forced the edit, and wiring or
removing the reducer is out of scope here.

## Decision 8 — the transcript, composer and footer share one inset

ink insets its conversation, its composer and its footer by the same two
columns. Here the transcript had no inset while the composer and footer had
one each, and the composer's frame sat one column right and one column narrow
of ink's. All three now take the same inset, and the composer keeps a one-row
gap above it, which is what separates a submitted prompt from the answer
arriving under it.

## Decision 9 — the error row is one line, with ink's literal cross

The error row was two stacked rows: the message, then the hint underneath. ink
renders one row with the hint inline in parentheses, and its prefix is a
literal cross at U+2715 rather than the shared icon table's U+2716 — the two
glyphs are one code point apart and visually distinct, so importing the table
here would have been the wrong kind of reuse. The row is flattened, the hint
moves inline as a secondary-coloured segment, and the prefix stays a literal
with a comment saying why it is not the shared constant.

## Decision 10 — the armed quit warning takes the footer's hint slot

The two-press exit warning was drawn inside the transcript, above the
composer, so the user was told to press Ctrl+C again in a place they were not
looking. ink gives the warning the footer's bottom hint slot and gates its
status line off while the warning is up, so it reads directly under the
composer with nothing above it. The footer now takes the warning as a prop and
returns just that row, truncated to the same budget as the hint it replaces.
The queued-message segment is a sibling of that hint rather than part of it,
so it stays visible while the warning is armed.

Moving the warning into the footer also hands it the footer's own gate, which
hides the whole footer while a dialog, a modal, a tool confirmation or the
completion dropdown is up. The warning overrides that gate. A dialog unmounts
the composer here, so nothing intercepts Ctrl+C and the guard still arms; left
gated, a second press would exit with the warning never having been on screen.

Being a sibling also decides the separator. ink renders the badge as a text
node of its own whose content begins with a literal space, so the row reads
with one space where the segments of ink's own hint are joined by `' · '`.
Both joins the badge participates in — the hint row and the armed-warning row
— use the single space. The mode segment keeps its internal `' · '`, which is
the one ink puts between the segments of that hint.

## Decision 11 — a removed layout prop is not reset, so the two branches need keys

The renderer's margin and width setters ignore the `null` its reconciler passes
for a removed prop. The dialog branch and the composer branch are both a
`<box>` in the same slot, so without keys React reuses one instance and diffs
props — and the previous branch's layout stays stuck on the node. Opening a
dialog left the composer's margins behind; closing it left the dialog's width
behind. Both branches now carry an explicit key, and the one width that has to
be relinquished rather than replaced is set to its auto value instead of being
removed.

Sites that only ever set a prop, or only ever remove it, are unaffected and
were surveyed rather than changed — a judgement that did not hold at the tool
card's header, where the collapsed branch sets a width the expanded one never
sets; Decision 50 corrects it. No renderer-level test was added: the
behaviour lives in the reconciler, and reproducing it needs a real render
surface, which the pty matrix already covers.

## Decision 12 — the glyph tables are imported, not copied

Two tables of status and message glyphs had been copied into this renderer.
Both are exported by ink's constants module, and both copies had drifted: the
message icons were missing the presentation selectors ink appends to force the
text rendering of characters that default to emoji. The copies are deleted and
ink's tables imported, which is what makes the drift impossible rather than
merely fixed. The selectors are invisible in source, so the tests that assert
them say so in a comment.

## Decision 13 — three notices ink draws and this renderer did not

The extension-refresh notice never appeared because the watcher latches during
startup, before this renderer mounts, and a latch does not re-emit: subscribing
alone drops the one notice that tells the user to run `/reload-plugins`. The
latch is now replayed on subscribe. The replay is keyed on the latch owner
rather than the construction, because the shell rebuilds its dispatcher
whenever its host identity changes and the latch outlives that rebuild —
without the key the notice printed once per rebuild, which the frames caught
as two identical rows.

The context-file announcement is a one-shot latch in ink: the files stay
attached for the whole session, so it is announced on the first submission that
reaches a model and not on every prompt. ink re-arms that latch in three places
— a session-id change, a history replacement and a clear-screen — because each
of those wipes the emitted row while the files stay attached. All three funnel
through one point here, where the visible transcript is cleared or replaced,
so the re-arm lives there. ink's history-replacement path also reconciles the
latch against the replayed history; that is not ported, because this renderer's
resume replay carries no info rows at all, which would make the reconciliation
a permanently false branch.

The model dialog's cancel notice was emitted into a feedback channel that
draws nothing rather than into the transcript. It now lands as a transcript
row, matching ink's "kept model as …".

## Decision 14 — a row's glyph prefix must not be shrinkable

The transcript rows that carry a glyph gutter build it as a separate flex
child beside the message, which is what gives the wrapped message ink's
hanging indent. That child is shrinkable by default, and a shrink is exactly
what happens when the message's first wrapped line fills the row: at 60
columns the warning row measured 57 columns inside a 56-column box, its
prefix had been reduced to one column so the space after the glyph was gone,
and the continuation started one column left of the info row above it, which
had two columns of headroom and so was never shrunk.

The prefix is now non-shrinkable. The same frame then measures 55 columns
inside the box, keeps its space, and its continuation lines up with the info
row at ink's column. This was verified by rebuild and re-capture, not by
inspection: the two rows differ only in message length, so the shrinking row
is the control for the one that was not shrinking.

ink turns out to do the same thing. Its shared status renderer puts the
prefix in its own row child with an explicit width and an explicit
non-shrinkable flag, and lets the message take the remainder, which is the
arrangement the measurement above reconstructs. So this is not a workaround
for a layout engine's default but a piece of the reference that had not been
ported, and the frame evidence and the source now agree.

The fix is applied to the four row shapes in the transcript that use it —
info, warning, error and the away recap, the last of which has two fixed
prefixes and so needs both marked. It is deliberately not applied to the
matching prefixes inside the statistics and authentication dialogs: those sit
in a fixed-width bordered box with its own width budget, no capture there
shows the defect, and changing them would be an unverified edit.

## Decision 15 — the model dialog's three close guards

Closing the model dialog without a selection announced the model that
survived, on every path that closed it. That collapses outcomes ink keeps
apart: leaving an auxiliary picker — voice, vision, compaction, image or the
fast model — announced too, and a second Escape after the first, or one
landing while a switch was still being applied, announced again.

ink guards the announcement with three pieces of state: a flag recording that
a switch committed, a latch recording that the close path already ran, and an
in-flight flag spanning the await. The close path returns early if either the
latch or the in-flight flag is set, and announces only for the main picker
when nothing committed. This renderer now carries the same three with the
same early return, and its auxiliary test is the negation of the picker's mode
being the main one — the same five modes ink enumerates, since the mode is a
required field and cannot silently fall through. None of the three is reset:
the mount unmounts when the dialog closes, so a fresh open starts from fresh
state.

Two of the three also guard the pick itself: ink's select handler returns early
when a switch is applying or one already committed, because a second Enter
before the first apply settles would start a second switch, and both would
report. On the close path the latch always fires first, so that early return is
the one place where the committed flag decides an outcome.

The announcement also moved out of the shell's notify slot and into the
transcript. ink writes all three of the dialog's outcomes — a pick, an
escape, an auxiliary pick — as transcript rows, so a row outlives the dialog;
the notify slot is a bare line inside the dialog area and closes with it.

## Decision 16 — transcript items keep ink's per-type top margin

Conversation rows printed back to back here while ink leaves a blank row above
most of them. The comparison harness had been folding that away: it normalises
each frame to a sequence of non-blank rows, so a capture could be reported
byte-identical while the two renderers disagreed on every vertical gap between
items. Fourteen of the thirty-nine compared captures differ in total blank-row
count, but that number is not usable on its own — under bottom anchoring this
renderer parks one large gap above the composer where ink leaves its blanks at
the foot of the screen. Measuring the transcript region alone, as a run-length
pattern of blank and content rows, isolates it: ink reads `b1 c5 b1 c1 b1 c1 b1
c2` across the four scenarios that carry a completed turn, while this renderer
reads `c7 b22 c2` — one unbroken content run.

ink decides the margin per item type. Its history renderer returns one row for a
model turn and for a thought, returns zero for an explicit list of statuses,
tools, notices and user rows, and returns one for everything else by default.
The user row reaches the same total by a different route: the history renderer
gives it zero, and its own message component declares the margin internally. A
shell row and the two arena cards are absent from the explicit-zero list and so
take the default. There is no first-item or last-item suppression, and the
static, pending and scrolled regions all render the same component with the same
margins, so the rule is uniform across the screen.

This renderer now wraps each item in a box carrying that margin, resolved from
its kind: one for the user row, the assistant row, the thought, the shell row
and the two arena cards; zero for everything else. Two kinds have no ink
counterpart at all. A task card is this renderer's own shape — ink renders a
subagent as the tool that spawned it, which takes the zero branch — and an image
row is likewise local, since ink draws images inline inside the message that
carries them. Both are given zero so they stay flush against the tool row they
render beside; that is a judgement call, not a reading of the reference, and
follows if either shape ever gains an ink equivalent.

The margin sits on the wrapper and the per-item row cap applies to the item's
own content, so the two are additive: the cap cannot eat the separator, and the
separator cannot cause an item to be clipped.

## Decision 17 — an approval-mode switch releases the calls it would not have parked

Rotating into an auto-approving mode left the confirmation on screen. The
keystroke and the dialog both funnel through one adoption point, and that point
set the local mode and announced an entry into auto mode, then stopped: a call
already parked behind a confirmation stayed parked under a mode that would never
have asked it.

ink pairs the switch with the release. Entering the mode that approves
everything confirms every parked call; entering the edit-only mode confirms just
the edit tools; and a call flagged as never offering "always allow" is left
alone, because that flag marks a question that exists to be answered by a human.
The selection rule was already ported here, docstring and unit tests included —
it simply had no caller, so this renderer had the rule and not the behaviour.

The adoption point now runs it and confirms each selected call once, then
reports it settled so the entry drops the row. Two details differ from the
reference and are deliberate. The release confirms without waiting for each
call in turn, where ink awaits them one at a time to keep a batch of parallel
calls from settling out of order; with a single parked call — the only case any
scenario produces — the two are the same, and this renderer already settles a
parked call without awaiting it on the exit cascade. And the row is dropped
whether the confirm resolved or threw, because a confirm that rejected would
otherwise leave a modal over a call nothing will answer.

## Decision 18 — a committed thought names its duration, and the key its hint advertises is bound

The collapsed thought printed a key hint for a binding that did not exist. Every
keyboard handler in this renderer was accounted for and none took that key; the
row's own click did toggle it, but the hint's clickable branch was off, so the
one affordance that worked was the one the row never named.

ink binds the key at app level, with a legacy alternative beside it, to a single
flag that forces every thought open. It resolves a thought as that flag or the
id the user clicked open individually, which is why turning the global back off
leaves a hand-opened thought open. The port keeps both halves: the flag lives at
the entry, the analogue of ink's app-level owner, so the keystroke still lands
while a dialog or a confirmation owns the screen, and the row keeps its own
click state. The binding goes through the shared matcher rather than a literal
key name, so a user's rebinding and the legacy alternative both work — and the
command was already reserved in this renderer's priority table, with nothing
consuming it.

The label was wrong for the same reason: the duration was measured when the
thought ended and carried all the way to the view, which never read it. Its only
readers were the arena cards. ink names the duration — under a second reads as
brief, over it names the time — and falls back to the pending wording for a
thought that never reported one. Which formatter matters: two exist, one rounding
to whole seconds and one keeping a decimal, and ink's thought uses the
whole-second one.

## Decision 19 — one precedence for a tool result's structured payload

A todo list reached the tool card as its raw JSON. Nothing was missing on the
consumption side: the event carried a todo field, the model folded it in, and
the card had a checkbox-list renderer it put ahead of every other body. The
whole chain was built with nothing producing into it.

Six paths turn a result display into events. One checked the structured payloads
— a file diff, a todo list, an ANSI grid — before falling back to text; the
other five flattened straight to text, so each of them dumped JSON for a todo
list. They now share one helper holding that precedence, with the flattening
fallback unchanged, so a display with no structured form renders exactly as
before.

Two of the six keep a convention of their own: a live chunk and a resumed
transcript emit the flattened text as an incremental output event rather than a
result event, which their tests pin and which the fold treats identically for
text. Those two share only the structured half and keep their own fallback. What
changes for them is the payload, not the event type — a todo list mid-execution
and a shell result's ANSI grid on resume now render instead of dumping.

## Decision 20 — the gated-server approval reuses the policy and ports only the view

A server list checked into a project was never offered for approval here. ink
opens that dialog whenever its approval queue is non-empty, and this renderer had
no counterpart at all, so a gated server stayed silently disconnected and nothing
told the user why or what to do about it.

The queue, the decision that persists against a hash of the configuration, the
un-gating for the session and the reconnect all live in one hook that takes only
the config and returns plain data beside a handler. It is renderer-agnostic in
the same way the provider setup flow is, which this renderer already reuses
verbatim, so the port is a view and a mount point rather than a second copy of
the policy. Nothing here decides who needs asking or what an answer means.

The mount point is the part that could have been wrong. ink ranks this approval
above both the shell confirmation and the tool confirmation, so it takes the slot
outright here too, and the update notice stays suppressed while it owns the
screen exactly as the other popups keep it suppressed.

Reading that frame line by line found a defect the port had introduced. ink's
layout drops the whole Composer — its footer included — for any dialog it counts
as visible, and this approval is one of them; here the dialog took the Composer's
slot while the footer kept its own separate gate, unaware of the new occupant, so
two rows ink does not draw stayed painted underneath the box. One term on that
gate, and the checkpoint now differs only by the two residuals below.

The geometry was measured against ink rather than assumed, and the first attempt
was wrong in two ways: it drew the box at the terminal's left edge spanning the
full width, and it printed no row numbers. ink insets this box one column further
than the popups the dialog area already positions, because it adds a margin of
its own inside that area, which leaves it one narrower than the shared popup
width; and its radio rows are numbered. Both now measure the same at a
hundred-column terminal, and declining lands on the same composer and the same
footer row in both legs.

Two residuals were recorded rather than chased; the second is since closed.
ink's box has no right border — its own margin pushes a full-width box one
column past what its parent can print and the right edge is clipped, which is an
overflow artifact rather than a choice, and every popup here draws a closed box.
The closed one: a line of the body carried an extra leading space here, and
re-measuring it on the acceptance frames puts that space on the paragraph's
**first** row rather than on its continuation — at `@opentui` 0.5.8 that row sat
one column right of ink's (`│  Approval is bound…` against ink's
`│ Approval is bound…`) while the continuation already matched. From 0.5.9 on,
both rows match ink column for column, so the pin move retires this residual
without any change to our own layout code.

## Decision 21 — the question dialog is ported whole, except where ink is wrong

The dialog that puts a question to the user had been reduced to its literal
options. It drew no free-text row, so an answer had to be one of the choices
the model happened to invent; no description under each choice, so a label had
to carry the whole meaning; and no digit keys, so a choice cost a navigation
and a confirmation instead of one keystroke. Its header and its hint were also
worded differently. The answer itself travelled correctly, which is why a
state-level suite never caught any of it: once a choice was made, both
renderers printed the same settled card word for word.

Everything ink draws is now drawn here, and the geometry was derived rather
than guessed. The chip row that names each question and marks the answered
ones is capped by a water-filling helper imported from ink's own dialog rather
than reimplemented, and reduced by every cell the row spends outside the header
text: the padding, the active-tab marker, the submit chip, one gap per chip,
two columns of prefix per header, and two more for each answered mark. It is
recomputed on every render, because answering changes the marks.

ink's overhead terms were taken line for line. The width they are subtracted
from was carried over too, and a review round found that second number wrong:
it belongs to the box ink draws the row in, and this row sits in another one,
which spends two columns of margin on the left and one of padding on each side —
the padding already being one of the overheads above. Charging that padding twice
and ink's transcript indent besides took eight columns off a row that spends
four, so a header was ellipsized where the row still had room. That the
corrected base is the row's real width, and not merely a larger number, was
settled against a laid-out frame rather than the JSX props it came from: three
twelve-cell headers in a fifty-eight-column terminal print whole here across 52
of the 54 cells the box leaves, and no row reaches the terminal's last column.
ink ellipsizes all three at the same width; that window is recorded below, and
matching it would mean clipping text this row has room for.

Two divergences are deliberate, and they are of different kinds. The first is a
defect ink has and this port does not. ink answers a typed free-text entry twice
for one keystroke — the dialog's own key handler and the input widget it mounts both
subscribe, and the key layer broadcasts to every subscriber with no notion of
focus — and each answer advances a tab, so the question after the one being
answered is skipped without ever being drawn. This was not reasoned from source
alone. The ink leg of the acceptance run timed out waiting for a question that
never appeared, and its own review tab then listed that question as
unanswered. Here one keystroke advances one tab. Matching ink would reproduce a
defect rather than the experience, and fixing ink would move the reference the
whole sweep is measured against, so the divergence is recorded instead. The
scenario was rearranged to exercise the free-text row on the last question,
where the tab index clamps and both legs arrive at the review tab together.

The second divergence is one this port loses. The option rows are drawn by hand
rather than by the shared select widget, and the widget's pointer wiring did not
cross with them: clicking an option no longer answers it and hovering no longer
highlights it. The dialog draws no list that keeps it — this branch returns with
the question flow alone — so the comparison is with the sibling confirmation
types, whose outcome rows are still that widget and still answer a click. Keys
answer every question ink's dialog answers, which is the
bar this sweep set, and the pointer is deferred to its own change rather than
argued away. A click needs a meaning on the chips, on the free-text row and on
the submit and cancel rows, each of which answers a different question; and the
hazard class these rows just went through is a pointer hazard too, since a click
landing in the same read as a keystroke is one burst from another source. No leg
measures it: the harness writes one character per stdin write and emits no mouse
sequence, and the run that reported this could not start this renderer in its own
environment.

The free-text row keeps its value in a mirror written synchronously beside the
state update. Key events can arrive inside one React batch, and a handler that
builds the next value from the one its render captured appends to a snapshot
that is already stale, so a burst keeps only its last character. ink keeps the
same mirror for the same reason. A test dispatches a burst inside a single
batch, and the fix was checked by taking the mirror back out: exactly that one
test fails, and the row shows a single character of the five typed. On a real
machine the hazard did not fire — a twenty-character answer survived intact in
both legs — so the mirror is correctness by construction rather than the fix
for an observed truncation.

Answering a question schedules the tab swap after ink's pause rather than doing
it inline, and a second answer landing inside that pause used to overwrite the
scheduled swap's handle without clearing it. Both timers then fired, each
advancing one tab, so the question between them was skipped without ever being
drawn — the same failure this decision exists to remove, reached by a different
route. ink cannot cancel that swap either: it calls `setTimeout` without keeping
the handle, so it carries the orphan as well. The ref this renderer already holds
to clear the timer on unmount makes the cancel one line. A test answers one
question twice inside the pause and asserts the next question still arrives; it
fails with the clear taken back out. Two Enters within 150 milliseconds is a fast
typist rather than a stress case, though, and no leg of any run has been observed
skipping a question this way — the cancel is correctness by construction.

Eight checkpoints were compared. Every dialog row matches ink line for line and
indent for indent, including the mark appearing on a chip as soon as its
free-text box is checked and before anything is committed, the comma-and-space
join of a multi-select answer with the typed entry counted into it, and the
review tab's own hint, which drops the cancel clause exactly where ink drops
it. One residual stands: where a long path wraps. A second listed here
originally — vertical anchoring — was retracted above: the two screens occupy the
same place in the terminal, and what differs is where the harness rebuilds ink's
block. A third recorded here originally — which frame the waiting row shows — is
closed by Decision 28, and a fourth, the startup update notice, was falsified:
that notice comes from the runtime rather than this renderer, and the harness
suppresses it on both legs.

## Decision 22 — the confirmation is drawn where the conversation is

A tool confirmation arrived as a modal: a bordered box at full width, a title
row naming the tool, its own row announcing that the call was waiting, and a
hint about navigating a list. ink draws none of that chrome. Its confirmation is
a sibling in the transcript, directly below the row of the call that is waiting,
with no border, no title row and no navigation hint. Approving a command
therefore read here as answering a dialog rather than as continuing the
conversation, and the box pushed the question and its options several columns
past where ink puts them.

The chrome is gone, and the body, the question and the outcome list sit at the
columns ink uses, and the confirmation's row sequence now matches ink's line for
line at a hundred columns.

One claim made about this change here was wrong, and the merge caught it: the
row budget that had reserved space for the removed chrome was described as inert
at the viewport heights the harness uses. It is not inert, and the harness never
exercised the height where it binds. Upstream raised that same reserve after a
long confirmation on an 80-row terminal pushed the payload's tail and the
outcome list past the bottom edge, so what was being approved could not be read
and the options could not be reached. That fix merged first, and this change was
rebased onto it.

The reserve was then re-derived rather than copied, from what the inline
confirmation still spends around its body: the banner, the startup notices a
fresh session shows, the prompt echo with its turn margin, the card's own hidden
tail row, the question row, the outcome list, and the waiting row. The border,
title, body margins and footer hint that the earlier version counted are gone
with the chrome, so the number lands below the one it replaces by roughly what
those rows cost. It was then checked both ways. The long-confirmation scenario,
which drives this renderer at 80 rows and 110 columns, is green at the value
that shipped and times out waiting for the payload's tail at zero, so that
scenario does still bound the number. It does not bound it tightly — a value
four rows smaller passes as well — so the threshold sits below the range that
mattered here, and the arithmetic is what pins the shipped value rather than
the scenario.

One further consequence was checked rather than assumed. While a call is parked,
the loading indicator swaps to ink's waiting phrase and drops its elapsed-time,
token and cancel suffixes — there is no in-flight
request to cancel and no tokens to count. That waiting row renders for a tool
confirmation only: the server-startup approval, the trust gate and the action
confirmations all arrive while the session is idle, where ink's own indicator
renders nothing, and the captured frames agree on both halves. Where the block
sits vertically is not something these frames can settle: the difference recorded
above belongs to the reconstruction, not to either screen, so it is neither
confirmed nor ruled out here.

## Decision 23 — a card's rendering preference is re-derived per event

The tool card prefers a structured payload over the flattened text beside it,
which is what lets a shell run paint a styled token grid, a diff render its
coloured lines and a todo write render its status list. The fold that feeds the
card only ever added those payloads and never cleared one, so the preference
could outlive the payload it was chosen for.

A shell command reaches exactly that state. It streams styled output while it
runs, and if the stream then trips binary detection the accumulated output is
replaced by a plain string. The card kept showing the last grid it had seen,
after the call settled as well, so the user learned nothing about the binary
output and never saw the byte counts that followed. Any tool whose display
changes kind mid-flight has the same shape, since a result carries at most one
structured payload.

Each event carries the whole display, so the structured fields are now derived
from the event instead of accumulated onto the card. The three producers of
these events each pick the structured form or the flattened form and never emit
both for one result, so re-deriving loses nothing; and the trailing flush that
could have delivered a late update after completion is cancelled before the call
returns, so no path regains a payload a later event legitimately dropped. The
egress disclosure keeps its existing sticky behaviour — it is an additional
notice under the result rather than an alternative rendering of it, and it takes
no part in the preference.

## Decision 24 — the same mirror guards the authentication inputs

The endpoint and API-key steps share one line-input helper, and it built each
next value from the value the render that registered it had captured. Keystrokes
read out of one pty buffer can be delivered inside a single React batch, where
no render separates them, so every character in the burst appended to the same
stale snapshot and the field kept only the last one. A pasted string was safe,
because a bracketed paste arrives as one event carrying the whole text, and
typing at human speed was safe, because each keystroke flushed a render first —
which is why the existing tests, one act per character, never saw it.

The helper now keeps a mirror of its value, written synchronously on every
change and re-synced on render, so each event appends to what the previous one
produced while a value set from anywhere else is still picked up. Both steps
reach it through plain state setters that store exactly what they are given, so
the mirror converges with the parent on the next render and the fix stays inside
the helper, leaving ink's own wizard untouched. Taking the mirror out fails the
burst test alone, with a twelve-character key arriving as its final character.
As with the dialog row above, no truncation was observed on a machine and no
scenario drives the authentication wizard, so this is correctness by
construction with unit coverage only.

## Decision 25 — the arguments row, and one arrow rather than a row per card

With `ui.showToolCallArgs` on, ink writes the call's raw arguments on a dim row
under the card header, capped to two wrapped rows with the remainder collapsed
into `… +N chars (ctrl+o)`, and prints them in full once the session is in the
detail state that key toggles. Here nothing read the setting and no such row
existed. The policy is not reimplemented: serialisation, the deduplication
against a description that already is the payload, the character budget scaled by
the header's own inner width, the surrogate-safe walk and the prompt-injection
sanitisation all come from the helper ink uses, which was split so that both
renderers read one source of truth. The row is placed between the header and the
body, as ink orders them.

Investigation corrected the premise before a line was written. The claim was that
no path carried a call's arguments; in fact the live path always had, in the
event that opens the card, which is the same value ink's setting reads. Only two
carriers were missing — the steering card raised by an `@`-mentioned file, and a
resumed session's transcript — and the row still rendered nowhere, because
nothing read the field off the item. A first attempt at the carriers added a
fourth source in the scheduler loop and was reverted once the tests showed it
emitting the same row twice per call; what it exposed is that the pre-existing
carrier had no test at all, so a fold that dropped it would have passed. That
carrier is pinned now, along with the two that were filled in.

On a machine, both legs draw the row, and the collapsed remainder is the same
number of characters on both. The row costs this renderer more physical rows
than ink's, which is the wrap-rule divergence recorded below and not this row's
own.

The arrow that marks an awaiting call was drawn on every pending card. ink draws
it on one: its gate is the first call awaiting approval, and this renderer shows
only that call's dialog, so every other arrow marked a call the user could not
act on. The flag now comes from the first pending id, and a test asserts that a
second pending call gets none — checked by removing the gate, which fails that
test with both arrows on screen.

## Decision 26 — the conversation gets the viewport, the chrome keeps its rows

The app laid its own column out at the height of its content, so every row the
conversation needed cost the input line a row of visibility. Reproduced at a
hundred columns by thirty with a single answer of forty-nine lines: the banner
held rows 1 to 6, the answer's opening line landed on row 15 and the fifteen
below it filled the terminal to row 30, while the composer, the loading
indicator and the footer were laid out past the last row and never painted. A
second turn then proved the consequence rather than describing it — the script
typed into the frame and nothing in it moved: the capture taken after that
typing is byte-identical to the two before it, and the turn's marker never
reached the byte stream, so the scenario's checkpoint timed out. The same
mechanism clipped a dialog: at a hundred by forty the commands help page is
thirty rows tall, and the frame that held it ended on its own footer hint with
the closing border below the terminal.

ink is immune to this without solving it. Its permanent output goes into the
terminal's own scrollback and the terminal scrolls it; the live area holds only
the current tail. The library has the equivalent — a screen mode that splits the
terminal into a scrollback region and a fixed footer — and the reason it was set
aside is in that mode's own geometry: the render tree is bounded to the footer
band and the region above it is fed by captured stdout, so adopting it would
mean rebuilding every transcript item outside of React. The accepted
trade-offs of the migration itself had already recorded dropping that mode in
favour of a single scroll region; the region was simply never connected. This
closes a hole in the documented design rather than inventing a scheme.

Four properties were needed, and none of them reads off the library's naming.
The root column is bounded by the terminal height, since a flex child's height
is otherwise its content's. Everything that flows — banner, transcript, the two
notice rows — moved into a scroll region that grows and shrinks with what is
left. That region carries a sticky bottom anchor, so it shows the tail and
re-engages after each layout until the user scrolls away from the bottom; the
anchor needs both of the library's two props, one of which is inert on its own,
and that is also why an explicit scroll to the bottom on every update was
rejected — it measures identically in a still frame and fights the wheel the
moment the user touches it. And the rows below the region, every dialog along
with the composer and the footer, are locked against shrinking: without that
lock the layout distributes the region's content height across the whole column
and squeezes the composer's three border rows into one row painted three times,
because a text row cannot shrink below its own content and overwrites its
neighbour instead of clipping. Each property was established on a synthetic
fixture at the same size before it reached the app, and the shell tests now pin
all four — verified by removing them one at a time, which fails one test each.

On a machine the overflow arm is an exact match: all three of its frames agree
with ink's row for row, from the answer's last line down to the footer's mode
row, and differ in one character — the scrollbar indicator this renderer
draws at the right edge. It stays on purpose. It is the only cue that anything
above the fold is reachable, and the dialogs already carry one.

The wheel was then measured on the same arm rather than assumed, since the
decision to let the user scroll away from the anchor rests on it. Twenty injected
notches moved the region back twenty rows, from the twenty-fifth of the answer's
numbered lines back to the fifth, with the composer and the footer not moving a
row; sixty notches the other way let the anchor take the tail again. That is the
behaviour a per-frame scroll call would have destroyed and a keyboard binding has
to match.

Two divergences this document recorded as deliberate close as a side effect, and
both are confirmed on frames. The banner is no longer persistent; it scrolls out
of the region as the conversation grows, where ink commits it to scrollback. And
a dialog now reflows the conversation: under the thirty-row help page the region
shrank to ten rows, giving up the banner's first two, while the dialog itself
fits entire. A region squeezed to no rows at all by a dialog as tall as the
terminal is that same behaviour and not a new defect, since ink pushes those
rows out of the viewport too. What is not here is scrolling the region with the
keyboard.

## Decision 27 — a long shell card is compacted for the screen, verbatim for the model

ink writes a shell command's output out twice. The transcript row goes through
the shared history-retention compaction; the string handed to the model stays
verbatim. This renderer put the raw accumulation on the card at both of its
write sites — the throttled streaming snapshot and the final result — so one
long-running command pinned its entire output in the transcript for the rest of
the session. On this branch that stopped being a cosmetic difference: Decision
26 bounds the region by the terminal, so rows that ink would have compacted now
push everything earlier above the fold.

Both sites call the same helper ink's history fold uses, so the retention limit
has one owner rather than a copy that can drift. No scenario in the harness
produces output that long, so this is pinned by unit tests rather than by a
frame: each of the two write sites asserts the card display stays within the
retained budget while the history write still receives the whole string.
Removing the compaction fails exactly those two tests and no other, with
over-length displays of forty-one thousand and thirty-seven thousand characters
named in the failing assertions.

## Decision 28 — the waiting row freezes while the dialog is open

While a call was parked on a confirmation, this renderer kept repainting the
waiting row and ink's did not. Measured rather than inferred: a probe replaying
the question-dialog scenario sampled the reconstructed screen once a second for
fifteen seconds with the dialog open, and the ink leg emitted zero bytes on
every sample while this one emitted about twelve, its row holding a different
frame each time. Twelve bytes a second is that renderer's own cadence — the
shared spinner interval is eighty milliseconds, and a repaint that changes one
cell costs roughly a byte. A leg with no dialog open emits nothing at all on
either renderer, so this was not the whole tree redrawing.

The gate lives in ink's `RespondingSpinner`: it animates in the responding state
and otherwise draws the `nonRespondingDisplay` string it is handed, and
`LoadingIndicator` hands it one static frame while the state is waiting for
confirmation — no timer runs at all in that state. This renderer's spinner owned
an unconditional interval, so the row asked for attention while the user's
answer was the only thing that could stop it. The cost is not only visual: the
acceptance harness decides a leg has settled by watching its output go quiet, so
every parked leg of a confirmation scenario burned the full sixty-second idle
timeout (measured at 60,088 ms and 39,798 bytes on one leg of one scenario).
Checkpoints are declared by the scenario rather than timed, so no verdict was
invalidated — each parked leg simply paid the wait, and the frame comparison
counted every one of those rows as the spinner-frame difference this document
already records rather than as content.

The gate is ported, and the frame it freezes on is shared rather than copied: it
joins the spinner constants both renderers already read from one place, which ink
had spelled out as a literal until now. Two tests cover the pair — the frame
advances while a turn is in flight, and holds that one frame while a call is
parked. The frame each leg shows is pinned: taking the parked branch out fails the
parked test, taking the interval out fails the in-flight one. What the first of
those did not pin was the timer itself — a row that went on ticking but kept
printing the same frame passed — so the parked test now asserts that no interval
is left running, which is the cost this decision measured on a machine.

The row's phrase also obeys the accessibility setting ink reads for its own
composer, and that gate has to reach both of the row's mounts — the composer's,
and the waiting row under a parked confirmation — since a setting that silenced
only one of them would keep rotating words on the other. Three tests pin it: the
phrase dropped at each mount when the setting is explicitly off, and both kept
when the settings say nothing, which is how ink reads an absent value. Inverting
the comparison fails both, and dropping the prop from either mount fails the test
that owns that mount.

The row's elapsed counter needed the same treatment, and the obvious wiring is
wrong. The shared timer zeroes what it has accumulated on a false-to-true edge of
its active flag, so handing it `streaming && !waiting` — which is what dropping the
suffix suggests — restarts the count when the parked call resumes, and a turn that
has been running for half a minute reports itself as four seconds old. It is handed
the timer's separate paused flag instead, which holds the accumulated time and
carries on from it. A test pins the difference: it parks a call three seconds in,
holds it for thirty, resumes it and reads four seconds one tick later, and the
wiring above fails that test with `(1s` where it asserts `(4s`. The row prints no
elapsed time while parked, as recorded above, so this is what the user sees once
they have answered rather than while the dialog is open.

That wiring is only as good as the instance it lives on, and one review round
measured the limit: the test rerenders a single row, while the shell mounts the row
twice — once under a parked confirmation, once above the composer — in two mutually
exclusive branches. A park therefore unmounts the instance that accumulated the time
and mounts a fresh one, whose flag never changes value, so the counter still restarts
after an answer in the shell even though the paused flag is wired correctly and the
unit test passes. Carrying the accumulated time across the swap means owning it above
both mounts, which is recorded as a follow-up rather than done here.

Re-running the full matrix afterwards confirms it on the machine rather than in a
test: eleven checkpoints taken while a dialog is parked each shed one row on both
sides, from four divergent rows to three, and the rows left there are the
long-path wrap break recorded under Decision 21. The overall divergent-row count
goes from 221 ink-only and 265 opentui-only to 210 and 254. The number of
checkpoints matching byte for byte stays at twenty-two, of the sixty-nine that
run scored — that wrap row is what keeps these from joining it, so the freeze
closed a row everywhere and flipped no verdict.

## Decision 29 — a call approved behind another approval waits with ink's pending glyph

One model turn can return two calls that both need approval. Approving the first
does not start it: the batch still holds the second one's approval, so the
scheduler parks the first in `scheduled` until that answer arrives. ink's card
for it reads that status and holds `o` across the whole stretch; this renderer
switched the row to `⊷` the moment the answer arrived — the glyph for work in
progress, on a call that was waiting for a person.

ink's status mapping hands `validating` and `executing` the Executing display
status and `scheduled` the Pending one, and its indicator draws Pending as
`TOOL_STATUS.PENDING` in the success green where Executing draws the toggling
spinner's `⊷`. Both renderers read the same scheduler, so the status this needed
was already in this renderer's hands — the batch update it subscribes to carries
every call with its own `status`. Only the read was missing, and no change to the
shared scheduler is involved.

What made the row worth stopping on is that `TOOL_STATUS.PENDING` had no
producer on this side at all. The comment above the status table names all six
glyphs the shared constants define, and five of them were ever emitted here, so
the row was not drawing the right state at the wrong frame. It was drawing a
state this architecture had no name for.

The scenario that surfaced it is new to the matrix: two shell calls in one turn
under the default approval mode, the screen captured between the two approvals.
Compared on the machine with one variable — the read site reverted, the rest of
the bundle and the scenario untouched — ink's row reads
`o Shell touch acceptance-two-a` where this renderer's reads `⊷ …`, and that pair
is one of the checkpoint's four divergent rows. With the read in place both rows
read `o` and the checkpoint is down to three, which are the long-path wrap break
recorded under Decision 21.

The event is edge-triggered against a per-call set: the update that first finds
a call queued emits, a repeat of that status emits nothing, and the move to
`executing` emits the clear — so a call that never left `awaiting_approval`
carries neither event nor state. Three tests carry the three layers of the path,
and four mutations fail them: deleting the glyph branch fails the render test
alone, deleting the read fails the scheduler test alone, weakening the fold
fails the model test alone, and dropping the dedupe guard fails the scheduler
test by printing a clear for every call in every batch.

The same scenario also puts a second divergence on the record, in Follow-ups:
this renderer appends the open dialog after both waiting cards where ink sets it
between them.

## Decision 30 — prompts queued mid-turn list as ink's rows above the composer

A prompt submitted while a turn is running was counted here but never shown. Its
length reached the footer badge, and the composer's up key at the top edge could
pop a text back for editing, but the texts themselves were readable only by
draining them — which empties the queue. ink lists them instead, above the
composer: three at a time, each collapsed to one line, an overflow row when more
are waiting, and a hint naming the keys, shown the first three times the queue
fills.

The port is ink's component row for row, hint included, with one addition: a
queued row is stripped of terminal escapes before it is measured, which ink's
component leaves to the terminal. What had blocked it was the read rather than
the render. The queue lives in a ref so that a turn can drain it and put it back
within one tick, and a ref is invisible to a render — so the ref stays the
synchronous source, and the five sites that move it each copy it into state
besides: the push, the drain, the restore for texts still riding when a turn
aborts, the mid-turn steering path that re-queues the remainder it did not
consume, and the transcript reset that backs `/clear`, resume and branch. The
composer's pop for editing moves the ref only by draining it, so the drain's
copy is what mirrors that path. The transcript reset is why the rows shed with a
cleared screen instead of outliving it.

This is the one decision here that no frame can evidence. Both renderers _steer_
a plain-Enter submission made mid-turn: the text is drained at the next sampling
boundary and rides into the following model request, so the rows appear and
vanish inside a single turn. A queue that outlives the turn needs the submission
deferred until it is idle, and in ink that is Ctrl+Q — which this renderer does
not bind. The command is named in the key map's priority list, but the resolvers
that read that list have no production caller, so the keystroke falls through as
text. The rows are reachable here only for the length of a turn, which is also
why no scenario in the matrix produces a durable queue on either leg.

One scope was set rather than discovered: these rows list the steering queue, and
the shell's own deferred lane is not in it. A submission made while a held command
still runs waits in a second list the shell keeps for itself, and neither the rows
nor the badge — which read the one mirrored queue — says it is waiting, so that
text appears on screen only once it runs. ink has a single queue and shows both.
Listing them together is one change with the key that would make a queue durable:
badge and rows have to move together, or the two counts disagree on the screen.

One asymmetry is recorded rather than fixed. The rows mount inside the
composer's branch, and this renderer gives that branch's slot to a parked tool
confirmation — its first awaiting call opens as a modal dialog — so the branch
swaps whole and the rows leave the screen, the hint's counter with them, until
the call settles. ink keeps its composer mounted through the same state: a
parked call is an inline card in its transcript, and its dialog gate lists the
popups the user is answering, never the tool queue. A dialog does unmount the
composer on both sides, so a completed count resets the same way here and there.
Keeping the rows through a confirmation would mean mounting them one level up,
in the chrome box, at the price of setting them above the waiting row where ink
draws them under the spinner.

Coverage is unit-level across three layers: six component tests (nothing when
the queue is empty, one row per prompt with whitespace flattened, the three-row
cap with its overflow row, the hint that shows on three fills and not the
fourth, a row cut to the terminal width minus ink's indent, and a row stripped
of terminal escapes before it reaches the screen), the hook's assertions on the
queued texts at each of those sites, and a shell test that fixes the placement —
the rows share the non-scrolling chrome with the composer instead of scrolling
away with the conversation, and sit above it rather than below. Eleven mutations —
one at each of the five behaviours the port copies from ink, one at each mirror
site and one at the mount — each fail at least one test, with one limitation: the
escape-stripping addition carries no mutation of its own. The mount's mutation is
the rows moved under the composer, which the placement test now catches by
ordering the two against each other in the chrome's own text. The five ported
component rows fail their own and no other; the mirror sites do not map one to
one, because a list never given its first entry, or never emptied, is still
being asserted turns later. Measured by dropping each copy in turn: pushing
without it fails four tests, the mid-turn re-queue without it two, and the
drain, the abort restore and the transcript reset one each.

## Decision 31 — a model dialog outcome is recorded as well as shown

The row a `/model` dialog leaves behind — the model a pick settled on, or the
one an escape kept — reached the transcript but not the session log, where ink
carries a record of each of those three outcomes. The dispatcher cannot carry
it: that result phase closes while the dialog is still open, with an empty
output list, and ink writes the same empty pair. So ink pairs each of its three
outcome sites with a second result-phase record naming the command and carrying
that one row. This renderer now makes the same pairing, over one object: the row
shown and the row recorded are the same value, built once, so the two cannot
drift apart.

Two silences are deliberate. A pick that fails to apply records nothing — ink
keeps the dialog open with the error, and a recorded row would replay a switch
that never happened. And the dialog adds no invocation-phase record: the bare
command's own invocation is already written, hidden, by the dispatcher, so a
second one would double it.

Coverage is unit-level plus one on-disk check. Three existing cases in the
dialog suite now assert the recorder alongside the row — once for an escape that
arrives twice, once for a pick still being applied, once for a repeat pick after
it lands — and a new fourth asserts a failed pick leaves no trace in either. Five
mutations — no record at all, the wrong phase, the wrong command name, an empty
payload, a failure that reports anyway — each fail at least one test. On the
real machine the slash-dialog scenario opens `/model` and escapes it on both
legs: each session log now holds nine `slash_command` records, in the same order
and with the same flags, the fifth being the dialog's own result carrying
`Kept model as fake-model` on both sides. What is not shown on screen is the
replay. The adapter that rebuilds a transcript from a log emits a row for a
slash command's invocation phase only, and this is a result phase, whereas
ink's replay reads the output rows a result phase carries. So after a resume
ink still draws the kept-model row and this renderer draws neither that row nor
any other slash result — the gap Decision 13 names for info rows in general.
Closing it changes what every slash command leaves behind a resume, so it is
recorded under Follow-ups rather than taken on here.

## Decision 32 — a dialog field's caret moves, as ink's does

Every text field in these dialogs kept its value in the dialog's own state and
only ever appended to it. The keyboard could add a character and erase the last
one; nothing else. ← and → did nothing, so did Home and End, and a mistake
anywhere but the end of the value could be repaired only by erasing everything
after it. ink routes the same fields through one text-input component whose
editing lives in a buffer with a caret measured in code points, which is why
those keys move a cursor there. Two field families were affected: the question
dialog's free-text row, whose own help line advertises ← and → as tab switches
while the row gave them up entirely, and the four text fields of the
authentication wizard.

The buffer was not reimplemented from a reading of what it ought to do. What
exists is the one-line slice of ink's own operations, and the tests assert no
hand-written expectation: each fixture replays a keystroke sequence through
ink's reducer and through this model side by side, comparing the text and the
caret offset after every step rather than at the end — across a paste that
leaves a line break behind, over characters ink weighs as one cell and as two,
and at both walls where a move has nowhere to go. ink's word segmentation is
reused as itself: two helpers that had been module-private became exported, so
the span ctrl+W erases is the span ink erases, and ink's own behaviour is
unchanged. The key order is ink's as well, restricted to the keys a one-line
field can receive, and every other key goes back to the dialog — which is what
ink needs, since its dialog stops handling the arrows once the field owns the
row. Word jumps, delete-word-right, kill-line and undo/redo are recorded as not
ported, all four of them bound by ink. Two absences are forced: ctrl+D belongs
to the app's global exit binding, which acts on the key without swallowing it —
the focused field sees it too and hands it back unhandled, so there is no edit
for that key to port — and a field whose value another keystroke replaced
wholesale has its caret pulled back inside the string rather than left pointing
past it.

Where a key's natural reading and ink's binding disagree, ink's binding is kept,
and one review-round finding came from holding that rule to the letter. The port
sent the bare End key and ctrl+E to the same value-end jump. ink separates
them: only ctrl+E is its END binding, whose handler dispatches the line-end move
and then walks to the end of the whole buffer, while a bare End falls past that
binding into the reducer, which stops at the line. So a caret parked on an
earlier line of a pasted value by ← sent the next character to the end of the
string instead of where the user left it. The fold is now split, with the bare
key taking the line-scoped move Home already used; one caveat travels with it,
because ink's line is a _visual_ row and a value wide enough to wrap splits it,
where this model has no wrapping to consult. Coverage is one differential step
beside the ctrl+E one, the wizard's base-URL case pasting a two-line value and
landing a character inside its first line, and a mutation that returns the bare
key to the value-end jump — it fails both. The split's other direction went
unwitnessed for a round: routing ctrl+E to the line-scoped move survived,
because every fixture pressing that key held a value with no break in it, where
the two keys land in the same column and the routing cannot be told from its
neighbour. A case now presses both keys through the routing on a value that
holds a break with the caret off its last line, and that mutation fails it.

A second review-round finding was a spelling rather than a behaviour: the key
that erases the word left of the caret. ink binds ctrl+W, and this port erases
a word for that and for a backspace carrying a modifier, which is what a
terminal that reports modifiers sends. A terminal that reports none sends the
bare byte 0x1f instead, and that byte reached a dialog field and did nothing —
not inserted, since a control character is not printable, and not handled,
since only the composer had been taught the byte. Both field paths now ask the
composer's own predicate, so the one spelling they had not shared is shared.
The mutation that takes it back out fails the single assertion that feeds the
byte and leaves the ctrl+W arm of the same case green, which is what makes that
case say the byte travels on its own rather than merely that word deletion
works.

Three rendering differences stand, one of them narrower than it was. ink
windows a field to a fixed column count and shows only the line the caret is
on, so a pasted multi-line value hides everything off that line. These rows
hide the same lines now, because a review round found what rendering the whole
value cost: this cursor is a frame beside the text it marks, so a newline a
paste carried in grew the row past the dialog's height budget and left the
highlighted cell on another line than the caret. The value keeps the break, as
ink's buffer does, so what reaches the model is the same text. The column
count is still not windowed, which is the limit the bare End caveat above
already ran into from the other side. ink paints its cell a gray read off the
terminal background, falling back to an underline where a block would corrupt
IME composition, while this cell carries the theme accent as the composer's
cursor does. And ink runs a 530 ms interval that toggles the cell's visibility
for as long as a field holds focus, where a steady cell keeps the dialog off a
repaint timer. That interval shows up in a measurement, not just in the
source: over a scenario that parks the caret in the free-text row, the ink leg
wrote 270 KB in each sixty-second window it sat there, four of the scenario's
seven settling waits burned their full timeout, and the leg took 251 s where
this renderer's took 13 s.

Mount semantics differ per field, because ink's do. The question dialog's row is
mounted by that dialog only while its own option is the selected one, and mounted
with the caret past the value it holds, so this port treats the row as freshly
mounted whenever it is (re)selected and drops a caret left mid-value. The wizard's
custom-model field is not unmounted when the list below it takes focus, so there
the caret is still where it was left when Tab comes back.

One field's text is not the model's own either. The context-window setter keeps
digits only, and this port renders the value it is handed, so a character that
setter rejects — a letter, or the Space that step binds — moves the caret and
never appears in the row. ink's buffer is the source of truth there and is never
re-read from the property, so it goes on showing what its own flow threw away.
The caret lands in the same column both ways, and what is displayed took this
shape before the caret existed at all — ink showing a value its flow has already
discarded is recorded as a follow-up rather than reproduced here.

Coverage is the model's own suite — sixteen new tests in a file this branch adds
whole, six of them replaying every keystroke through ink's own reducer as the
oracle and the rest asserting the model's states directly — plus the tests of the
fields that use it, counted
under Decisions 33 and 37, and eleven mutations, each failing the tests that own the
behaviour taken away: a left
arrow that moves nothing, the context-window field's typing branch, the two
end-of-line jumps, forward delete, a modified Delete that erases a character
instead of passing through, ctrl+W, a row that stops re-mounting, a bare End
folded back into the ctrl+E jump, the legacy word-erase byte handed back to the
dialog, a row that paints the line break a paste carried in, and a caret parked
on that break highlighting the break itself. On a machine, a new scenario
answers one question from its free-text row on both legs, with a single
question so that neither the tab clamp nor the double-fire recorded under
Decision 21 can be what produced the frame: six characters typed, the caret
taken back two cells, one character inserted. Both legs show
`> abcdXef` at the same column of the same row and both record `abcdXef` as
the answer. The styled capture pins the cell itself. At the two checkpoints
where ink draws it, the cell sits over the same character in the same column on
both sides and differs only in its two colours. At the checkpoint before those
the caret rests past the last character, so the cell each leg would draw is a
trailing blank the capture drops, and neither shows one. At the first, over an
empty field's placeholder, ink's cell is absent where this renderer's is
present, which is its interval rather than a missing cursor. What no scenario
reaches is the authentication wizard, as before: its four fields' editing rests
on the unit suites alone. One test-runtime note belongs here because it cost a
debugging pass: the DOM runtime the field tests use keeps earlier renders of a
re-rendered row mounted beside the live one, so the probe that reads the cursor
cell reads the last one. Rendering the same shape through the real renderer over
five state changes leaves exactly one row, so this is the harness, not the
dialog.

## Decision 33 — the keystrokes of one read are handled by the render they started in

The first review round found the class Decision 24 had closed for the line-input
helper waiting in every other place that reads dialog state and writes it back.
The renderer's key hook keeps the handler in a reference it refreshes during the
layout phase of a commit, and one stdin read hands over the keys it carries back
to back — a held arrow's auto-repeat at ~30 ms, or a bracketed paste together
with the Enter the terminal tacks on. Nothing commits between them, so every key
after the first is handled by the closure the previous commit installed, and every
value it reads is one keystroke old. At human speed the bug cannot be seen, since
each keystroke flushes a render of its own, and a suite that spends one act per
character cannot see it either — which is how the existing dialog tests missed it.

Each piece of state those handlers read to place the next keystroke now has a
mirror written in the same call as the setter, and the handler reads the mirror:
the question dialog's tab, its option cursor, its per-question checkbox sets and
its typed entries; the wizard's recommended-model set; the line editor's text and
caret. The question dialog's handler derives its whole view from the mirrors —
which question this is, single or multi select, free-text row or not — rather than
from what this render drew, so no branch can act on one keystroke's position with
another keystroke's value. Two reads of the answers themselves are the recorded
exceptions below. The line editor hands out getters over its mirror instead of
snapshots, since a consumer that captured its text once would have reintroduced
exactly this bug in one line.

One read is narrower than the mirrors. The free-text row keeps its keys only while
the burst still stands on the tab that row was drawn for: the row's buffer is
re-seeded during render, so a letter landing after a tab move inside one read would
append to the question the render drew and store it as the answer of the question
the burst reached. Those keys are dropped, as they were before this round, and a
test of an arrow held across a tab boundary pins it.

Submitting was the same bug pointed the other way. The wizard's endpoint and
key steps called their submit functions with no argument, so an Enter sharing a
read with the characters in front of it read the parent's state — still the value
from before those characters — and the wizard advanced on a half-typed endpoint,
falling back to the protocol's default host without an error. They take the live
text as an argument now, which is how ink's text input calls its submit with the
buffer's own text and how ink's question dialog declares its submit signature. The
recommended-model checkboxes came with the same finding: two ticks of a held Space
in one read, or a tick and the Enter that submits it, are one checkbox's two states
and a submission that knows about neither until the mirror is read.

The hook is shared with ink's wizard, and ink's endpoint step already passes its
buffer text into it, so in this same case the ink leg now submits the value it
shows. Away from a read that carries several keys the two strings are identical;
this is the one point where the round changes ink's behaviour.

Two mirrors are read where no keystroke sequence can show them disagreeing, and
that is written down here rather than counted as coverage. Ticking a recommended
model syncs the shared model-id string with the field's live text, and committing
the free-text row takes the tab it is standing on, but a burst cannot both edit a
field and tick a list row — the two branches are chosen by a focus the batch itself
cannot change — and a manual tab move puts the cursor on the first row, which is
the free-text row only for a question with no predefined options, which the tool's
own validation rejects. They are kept so that a handler has exactly one source for
each fact. Two siblings of the same family were closed rather than recorded: whether
a multi-select's typed entry counts, and the picked answers behind the review tab's
submit. Each took one mirror, and each is pinned by a test that puts the three
keystrokes in one read — type into a multi-select's free-text row, commit it, submit
from the review tab; answer a question, walk to the review tab, submit there. No
scenario on either leg produces that ordering, so both rest on the unit suite alone.

This change stops at the handlers the round was asked about, and the class is
wider than they are. Every other list in this renderer reads its cursor the same
way — the shared select hook seven other dialog files mount, the arena dialog's
model list, the composer's completion rows, the wizard's protocol and
endpoint-option steps, the focus of its recommended-model list (its check set is
mirrored above), its advanced-config row, and this dialog's own main
and sub menus. There the accepting key acts on the row the previous render drew
rather than the one the burst reached, and where a step is computed from that drawn
cursor — the shared hook, the endpoint-option list, and those two menus — a held
arrow moves one row per read instead of one per key. Closing it belongs to those
widgets together rather than to either dialog fixed here, and is recorded under
Follow-up.

Coverage is sixteen new unit tests, five in the authentication suite and eleven
in the confirmation dialog's, and thirteen mutations, eleven of which fail the tests
that own the behaviour taken away: a line editor back to a render snapshot, an Enter
submitting the prop value, the models step's check set read twice over (the tick
and the submission) with its field's live text read at the submission as well, a
question handler working from rendered state, the option reads of the Space
and Enter branches, a burst that moves tab editing the question it left behind, the
picked-answer mirror behind the review tab's submit — which without it fails the
answer-lock test of Decision 37 as well, since both read an answer the same burst
recorded — and the typed-entry mirror a multi-select's submit asks for.
The two surviving mutations are the unreachable reads above.
What no evidence reaches is a machine: the acceptance harness types one character
per write on purpose, so a keystroke lands in its own read, and it never pastes
into these dialogs — every burst case here rests on the unit suites.

## Decision 34 — a manual tab move calls off the swap already scheduled

The question dialog answers a question, pauses 150 ms so the tick on the row just
answered is visible, then swaps to the next one. ink schedules that swap and never
calls it off: neither a second answer inside the pause nor a left or right arrow of
the user's own clears the timer, so two swaps can run and the question between them
is never drawn. The port inherited that, and the review round caught it on the
arrow case — the user had navigated to a question and the dialog took it away again
a tenth of a second later.

The arrow now cancels a pending swap first, because the keystroke is the user's own
answer to "which question am I on". The second answer used to cancel it as well and
supersede the swap the first one scheduled; a later round put a lock in front of that
path instead, which drops an answer landing inside the pause outright (Decision 37).
Nothing is left for the cancel to see there: a live timer always belongs to the tab the
cursor is still on, since the only moves are the swap's own and the two arrows, and both
arrows cancel first. The lock is therefore the armed timer alone — the ref that also held
which tab the swap belonged to modelled a distinction no path could observe, and it went
with the dead cancel. This is one of the places where the port deliberately does not match
ink; the same 150 ms pause, the same clamping at the last tab, and the same
tick-before-swap are kept. ink's behaviour is recorded as a defect of its own rather than
reproduced, and the double-fire the acceptance matrix had already watched on ink's leg is
the same defect seen from outside.

The arrow is pinned by a mutation of its own: a right arrow that lands during a pending
pause keeps the question it moved to, and removing that cancel fails this test alone. The
answer path's cancel was taken out rather than pinned — putting it back fails nothing,
which is the measurement that showed it unreachable. What the path keeps is the drop: the
test that predates this round still asserts one advance for two answers inside a pause,
and the lock's own mutation is recorded under Decision 37. On a machine the pause and the
arrow were already covered by the matrix scenarios that answer several questions; the
cancellation itself was not observed there, since it needs two keystrokes inside 150 ms.

## Decision 35 — the cursor cell prints the character that owns the focus

The field row draws its value in three parts: before the caret, the cell the caret
is on, after it. The first version of the highlighted cell printed the middle part
only while the field was focused, so a field that lost the cursor to a sibling lost
a character as well — the row displayed a value one code point shorter than the one
stored, which is what a review round's Critical was. The character belongs to the
value whoever owns the focus; only the background says which field the caret is in,
as it does in ink, whose text input decides whether to draw the cursor's
highlight while always drawing the text under it.

The same row's caret now follows a rule the previous pass had inverted. The caret
indexes the value the field's owner acknowledged, not the one the keys typed. The two
texts are walked together and the caret is charged only for the code points the owner
dropped ahead of it, which covers both shapes a refusal takes: a single refused
keystroke — a letter into the context-window field, which keeps digits only — drops one
code point at the caret and leaves the caret exactly where it was, and an owner that
filters the middle of a pasted value (`1,024` → `1024`) keeps the caret following the
accepted tail instead of stranding it on the first character removed. A value the walk
cannot align, because the owner inserted or substituted rather than dropped, falls back
to capping the caret at the code points the two texts agree on. Before that, each refused
key moved the caret one code point right, and the first backspace after a burst of them
ate a real character. Where the two texts are equal the rule reduces to the plain clamp,
so every accepted edit still behaves as it did.

The row prints only what the flow accepted, which is the divergence Decision 32
records against ink rather than a new one: ink's buffer is the source of truth and
keeps showing the character its own flow threw away, so the same keystroke leaves a
visible trace there. Matching that would mean moving the display onto the buffer,
which is ink's defect to fix; the caret rule above was chosen so that a refused
keystroke leaves no trace of its own in either renderer's column layout. One test
had pinned the drift as the expected behaviour, since the caret it asserted was the
drift; it pins the absence of one now, and the difference from the shape the review
asked for is stated in that thread.

Four mutations, each failing exactly the test that owns the behaviour it takes away:
the cell that dropped its character when the field lost focus fails the authentication
suite's row test for a field that lost the cursor; the resync that calls the plain clamp
where this rule belongs fails that suite's context-window edit test; the fallback cap
reduced to a length clamp fails the unit test of a single refused keystroke; and the walk
reduced to that cap alone — the shape this decision used to describe — fails the unit test
of a value the owner filtered in the middle. The machine leg is unchanged here — a caret
in a field the wizard renders is still not reachable by any scenario, so the row's
rendering rests on the unit suites.

## Decision 36 — the arrow names the call the queue can answer

The arrow that marks an awaiting call had been derived from the transcript: the
first card that is pending and unfinished. That is ink's rule read from the wrong
list. ink's marker names the call whose confirmation is on screen, and only the
waiting queue knows which call that is — the same rule that decides which call
Ctrl+C settles and which call the shell dialog names. An `ask` decision from a
PreToolUse hook re-arms a call the user has already approved by appending it
_behind_ another waiting call while its card returns to pending where it stands, so
transcript order and queue order disagree, and the arrow sat on a card the user had
no dialog for.

The shell now passes the queue's first call id down, and the row still has to be a
pending, unfinished tool card to draw the marker. Keeping that second condition is
what preserves Decision 25's one-arrow rule: a card the queue names but the
transcript no longer shows pending gets no arrow, and neither does any other card.
The prop is optional on the view, so a caller that has no queue to consult gets no
marker rather than a guessed one.

The new case asserts the arrow sits on the call the queue names when that is not
the first pending row, and that exactly one arrow is drawn — it fails, one test in
a suite of eighteen, if the id is dropped and the transcript's order decides
again. A second case there pins the gate's other term: a card the queue still
names but whose call has finished draws no arrow, and deleting that term fails it,
where the sibling term was already pinned by a settled call's render. Every render
in that suite that asserts the marker supplies the id, because a marker that must
come from the queue cannot be asserted by a render that supplies none. The
wiring itself — the shell handing the queue's first id down — is pinned one level
up, by a case that mounts the tree the entry point renders and reads the props the
transcript receives, since every case in that suite mocks the transcript away;
deleting the wiring fails it. Dropping the queue from the render seam's dependency
array is the one leg no test can see, because a stale id renders identically
within a single render: the exhaustive-deps rule names that array, and CI's lint
lane allows no warnings. On a machine the
ordering this needs — a re-armed call behind a waiting one — was not reproduced;
the scenario that drove the arrow in the matrix has a single awaiting call, where
both rules agree.

## Decision 37 — a field stops taking keys once its read has submitted it

Making a mid-read submit succeed (Decision 33) made the next keystroke of that read
meaningful, and it is not: the Enter leaves the wizard on the following step while the
read still holds keys, and those keys are handled by the step the burst just left. That
step keeps its value in the flow's own state, and the review step's submit rebuilds the
install plan from that state, so a single trailing letter was written to `settings.json`
— the key step showed `sk-test`, submitted `sk-test`, and saved `sk-testZ`.

A field now settles when its Enter moves the wizard, and takes no further key of that
read. The latch sits on the shared line model, which every leaking field already goes
through, and each field's handler checks it before its branches: the endpoint and key
steps via the shared helper, the model-ID step (whose Enter also stops a Space from
ticking the recommended list behind it), the advanced-config step's context-window
field, and the question dialog's free-text row. That last one was the same defect seen
from the other end: a multi-select's answer is re-assembled from the field when the
review tab submits, so a letter trailing the Enter widened an answer the user had
already given.

The latch arms only on an Enter that reports the step moved. An Enter refused by
validation keeps the step mounted and the read belongs to it, so `abc`, Enter, `def` in
one read still leaves `abcdef` in the endpoint field. It is a ref that holds across
renders rather than a per-render flag: the render a successful submit schedules would
otherwise clear it, and in the question dialog that render leaves the submitted row
mounted and focused for the whole 150 ms pause, so the next read would keep editing a
field that had already answered. Only a changed mount key clears it, which is the key each
field is mounted under and also what re-seeds the caret past the value the way ink's text
input does on mount. A field whose submit was refused stays editable because nothing
armed the latch. A field whose submit was taken and then failed a step later does not —
the step is still on screen with the latch armed — and the wizard's last step needs the
retry counter Decision 39 records.

What stays un-latched is deliberate. The question dialog's tab arrows keep working
inside the pause Decision 34 protects, because there the keystroke is the user's answer
to "which question am I on"; the field's latch stops the field, not the dialog around it.

The dialog takes one stop of its own there, on answers rather than navigation, for as
long as a swap is armed. The field's
own latch reaches only its insert branch, and the row the armed swap settled is still
drawn and still owns the keys, so the rest of one read answered the same question a
second time and quietly replaced the answer already recorded — a digit on the option
branch, or a Space that a multi-select rebuilds its answer from at submit. Navigation is
left alone, and so is every key after the swap runs. The last question tab arms no swap
at all, clamped as it is, so it gets no lock; a trailing key there still lands on the row
it reaches.

ink cannot reach this leak. Its buffer notifies the parent from an effect run at commit
(`text-buffer.ts`), so a keystroke handled after the Enter never gets a commit where its
step is still mounted, and its text never reaches the state the plan is built from. Ours
writes through the setter synchronously, which is what makes a mid-read submit read the
live text at all, so it needs the explicit stop.

Coverage is eight new unit tests, four in the authentication suite and four in the
confirmation dialog's, and eight mutations, one per behaviour named below. Each fails
exactly the test that owns the behaviour taken away: the endpoint and key field's guard,
the guard armed on a refused Enter as well, the model-ID step's guard, the
advanced-config step's guard, the settled clause of the free-text row's burst-ownership
guard, the single-select clause of the digit branch — which without it lets a digit
that only moves the cursor on a multi-select tick the option it names — and
the answer lock's guard on the answer path — which without it lets a trailing
digit report `"staging"` over the `"xyz"` the Enter it trailed had just recorded — and
the same lock's clause on the Space branch, which without it lets a trailing tick widen
an answer already given. Nothing here was reached on a machine, for the reason
recorded in Decision 33: the acceptance harness writes one character per write and never
pastes into these dialogs.

## Decision 38 — the transcript region is not a focus target

One left click anywhere in the conversation used to end the composer's ability
to edit what it already held. The region that holds the transcript is a
`scrollbox`, and this renderer's `ScrollBoxRenderable` sets `_focusable = true`
over its base class's `false` (`@opentui/core`: `index.node.js:13859` against
`chunk-node-kr27pp2p.js:210`). The renderer walks the ancestors of every left
mouse-down and focuses the first focusable one, unless the click was handled
first and prevented the default (`chunk-node-kr27pp2p.js:9091-9104`). So the
click moved focus onto the scroll region, and `focusRenderable` blurred the
editor it was on (`:7562-7569`). Blur is not cosmetic: a renderable's key and
paste handlers exist only while it is focused, and `blur()` detaches both
(`:325-381`).

Nothing put them back. The composer passes `focused` as a constant, so the prop
the reconciler compares is unchanged and the write is skipped for the rest of
the session. Typing still looked fine, which is what nearly got this dismissed:
printable characters reach the composer through its own global key handler
rather than the editor's, so the buffer kept growing while the keys only the
focused editor handles — every caret key, and every paste — went where nothing
was listening. `Home` with a character after it, and a bracketed paste, are what
show the difference. ink parses SGR mouse reports as well, but into handlers
subscribed per surface and hit-tested against that surface's own rows — the
wheel over a scrollable list, a click inside the prompt input to place its
caret — and none of them has any route to the composer's focus, which is a
React prop. A
click on the conversation changes nothing there, measured rather than inferred.

The region is now `focusable={false}`. Two wider options were rejected. Turning
`autoFocus` off is a renderer-wide setting, and the dialogs' own fields rely on
it. Re-focusing the composer when the region steals focus means the transcript
owns a rule about who should be listening, and the composer's focus is already
declared by its own prop — two owners for one bit. One prop on the node that has
no reason to be in the chain is the narrowest statement of the same fact: a
scroll region is not an input target.

Measured on a real terminal, four arms, one variable — the same bundle and boot
arguments throughout, and `ink` under node against `opentui` under bun would
have confounded the runtime with the renderer, so `ink` under bun is its own
arm. Each arm types four characters, then — except the control — clicks a
transcript row, then measures whether three left-arrows plus a letter move the
caret, whether `Home` plus a letter reaches the front, and whether a bracketed
paste lands in the buffer.

| arm                                   | caret moves | `Home` works | paste lands |
| ------------------------------------- | ----------- | ------------ | ----------- |
| `ink`, node, clicked                  | yes         | yes          | yes         |
| `ink`, bun, clicked                   | yes         | yes          | yes         |
| `opentui`, bun, clicked — before      | **no**      | **no**       | **no**      |
| `opentui`, bun, not clicked — control | yes         | yes          | yes         |
| `opentui`, bun, clicked — after       | yes         | yes          | yes         |

The same click on the composer's own row restored the paste on every arm,
including the broken one, which is what ties the loss to the editor's focus
rather than to the keys.

What was checked to survive the fix: the mouse wheel still scrolls the region —
the dedicated wheel scenario, re-run on this renderer, sticks to the last row,
shows the rows above the fold after twenty wheel-ups and the last row again
after wheeling back. That scenario never clicks first, so the wheel
_after_ a click rests on the routing rather than on a frame: a scroll event is
routed by hit test, with focus only as the fallback (`:9134-9143`). And one unit
test pins the prop, killed by a mutation that removes it. What was not: a
click-drag text selection over the transcript, which the region answers through
the same hit-test path and which this renderer never advertised, and a click
while a dialog is open — the dialog lists are still focusable by default,
recorded under Follow-ups.

## Decision 39 — the answer row is bounded, and a submit that was not taken leaves the field open

One review round found four ways this port still closed a door on the user, and one
piece of machinery that had stopped being reachable. All five are recorded here rather
than folded into the decisions they qualify, because each was measured this round.

The question dialog's free-text answer was the one user-supplied payload in that dialog
with no width and no row bound. ink holds the same field in a text input fifty cells wide
and one row tall, and the confirmation this dialog lives in has no body window of its own,
so a single long paste grew the dialog past the terminal height and pushed the options the
user still had to pick off the screen. The bound therefore covers what the user types and
nothing else: the question itself, each option's label and each option's description are
model-authored and still render with neither a width nor a row bound, so a model returning
a long question or long descriptions grows the same dialog and pushes the same options off
the screen with no paste anywhere in it. That remainder is recorded under Follow-ups.

The answer row now draws inside a window of its own — fifty cells, less the label the
row prints in front of it, on the width the dialog has — and the caret cell is part of
that: past the window it has nowhere to go, exactly as in ink's fixed-width input. The
collapsed echo of the same value is bounded the same way, since what it prints is the
value a paste can make arbitrarily long. The bound is on the drawing alone. Submission
reads the stored value, so the answer keeps every character, including the line breaks
a pasted paragraph carries.

A bracketed paste is one event with no keypress per character, and the handler that took
it asked the render which drew the row whether the cursor was on it, while writing under
the live tab. Two questions it did not ask, both of which the key path already asked for
its own hazard: whether the burst still stands on the tab the row was drawn for, and
whether an answer the pause is still holding has locked this one out. One stdin read
carries pastes beside keys, so the arrows that move the cursor and the paste that trails
them arrive together — filed unguarded, one question's half-typed answer was concatenated
with the paste and submitted as another question's, or an answer already recorded was
widened behind the user's back. Both are now asked of the live position.

The wizard's fields latch on the Enter that submits them, and Decision 37 records the
latch as the ref it is: only a changed mount key clears it. On the last step of a flow the
submit is asynchronous, so the `true` that arms the latch means only that the install was
fired. When that install is rejected — or when it saves service models and no conversation
model, which also leaves the dialog open — the same step stays mounted for the rest of the
dialog's life with every key dead: the user could neither correct the field nor retry, and
backing out of the wizard was the only way left. The dialog now counts its retries and
hands that counter to the fields as their mount key, bumped on both paths, which re-arms
the latch and re-seeds the caret the way a fresh mount does.

A submit the answer lock rejects was still closing the row it came from: the field settled
before the call that could refuse it, against the contract the line model states for its
own latch. The call now reports whether the answer was recorded, and the field settles on
that verdict. What the user sees is the rest of the same read — the letters trailing a
rejected Enter still reach the field, so the answer they come back to give is the whole of
what they typed rather than the part that preceded the refusal.

The fifth is a removal. Decision 34 cancelled a pending tab swap on two paths; the answer
path's cancel could no longer observe a timer, because the lock Decision 37 added drops a
second answer inside the pause before it reaches the cancel, and a live timer always
belongs to the tab the cursor is still on — the only moves are the swap's own and the two
arrows, which cancel first. Putting the call back fails no test, which is the measurement
that showed it unreachable; Decision 34 is corrected to say so. The same argument took the
lock's second clause with it: the ref holding which tab the swap belonged to could never
differ from the tab the cursor is on, so the lock is now the armed timer alone and the
whole suite is green with the clause gone.

Six new tests, four in the confirmation dialog's suite and two in the authentication
one, plus the collapsed-echo assertions added to the pasted-newline test the round
before it, and ten mutations measured this round. Each mutation fails exactly the tests
that own the behaviour it takes away:

| mutation                                             | fails                          |
| ---------------------------------------------------- | ------------------------------ |
| the collapsed echo prints the raw value again        | the pasted-newline test        |
| the row's window taken out                           | the long-answer test           |
| the paste stops asking whose field it is             | the cross-tab paste test       |
| the paste stops asking whether the answer is locked  | the paste-lock test            |
| the paste handler reverted whole                     | both paste tests               |
| the retry counter not bumped on a rejected install   | the auth retry test            |
| the retry counter not bumped on service models alone | the service-model retry test   |
| the field settled before the verdict again           | the rejected-submit test       |
| the unreachable cancel restored                      | nothing — which is the finding |
| the lock's tab clause restored                       | nothing — which is the finding |

The machine leg was re-run at this head: twenty-seven scenarios on both legs,
fifty-four runs, none of them erroring. Of the seventy-eight checkpoints,
twenty-two have identical non-blank content rows and fifty-four diverge,
carrying 241 rows only ink draws and 282 only this port draws; the two that
remain are the sampled checkpoints — the spinner's phrase rotation and the
mid-stream indicator — which are counted apart, since what they hold is elapsed
time and a phrase chosen per tick. Against the previous head, 146 of the 152
plain captures are byte-identical, and the six that are not are three
checkpoints differing on both legs at once: the mid-stream indicator, `/stats`,
and the held-phrase row — the content that moves between two runs of the same
binary.

The whole matrix was run again after main was merged into the branch, and every
count above came back the same. The merge moved one thing on a frame: the
version the banner prints, which main had bumped, and which is inside the
transcript region on both legs and so appears in almost every capture. With
that string normalised away, the same 146 of the 152 plain captures are
byte-identical to the run before the merge and the same three checkpoints are
not.

Nothing recorded in this decision moves a frame, and that is the expected result
rather than a missing one. The bound on the answer row is the identity until a
value exceeds the window, and no scenario types one that does; the paste guards,
the retry counter and the settle verdict all turn on what a single stdin read
carries beside the key that submitted it, which is a property of the tty rather
than of any script. Like the caret rule in Decision 35, these five rest on the
unit suites.

## Decision 40 — the re-arm belongs to the step that submitted, and every cell of a field is sanitised

A fourth review round found three ways the machinery the rounds before it added were still
wrong, and one column of arithmetic that had never been charged. All four are recorded here
rather than folded into the decisions they qualify, because each was measured this round.

The retry counter Decision 39 added is bumped by an asynchronous verdict. Held in flight,
that verdict lands whenever the install finishes, which can be after the user has backed out
of the step that fired it and parked the caret mid-value in an earlier field; the bump then
re-seeds whichever field happens to be mounted, the caret the user parked jumps to the end of
the line, and the next Backspace deletes a character they did not mean to. The counter is now
bumped only while the dialog still stands on the step that fired the install: the step is
mirrored into a ref during render and read when the submit starts. What the guard scopes is
when the counter moves, never whether it moves on the step that failed — a rejected install
and an install that saved service models and no conversation model both still hand their own
step's field back, which is what the two tests Decision 39 pins.

Decision 37 put the answer lock on the two branches that report an answer — a digit on the
option branch, and the Space a multi-select rebuilds its answer from — and Decision 39 asked
the same of the paste path. The row's editing branch was left to the field's own latch, which
arms only on an Enter that moved the dialog: an answer recorded by an Enter on the option row
arms the pause without arming that latch, so the branch stayed open for the whole of it. And
it is not only an insert — the shared line model writes the value on a Backspace, a Delete and
a word-erase as well. On a multi-select the answer is re-assembled from the checked set and
the typed value when the review tab submits, so letters typed inside the pause widened an
answer Enter had already recorded. The branch now asks the lock, and asks it only on a
multi-select: a single-select field whose submit the pause rejected stays editable, which is
Decision 39's fourth item and what its own test pins.

The caret cell was the one span of either dialog's field drawn without sanitising, while both
spans beside it went through it. The filter the line model applies on insert drops the C0 and
C1 controls and keeps a bidi override, so a bracketed paste can park one in a value, and the
cell the user is looking at then rewrote the direction of the rest of the row: the dialog
showed an answer that was not the one being submitted. Both fields now sanitise all three
spans. The bound is on the drawing, as it is for the width bound beside it: the submitted
value keeps every code point.

The row's width budget charged the confirmation box's two columns of margin and not the two
columns of padding the same box spends, so on a terminal sixty columns wide or narrower the
last two cells it drew — the caret cell among them — fell outside the box that contains them,
and the renderer either clipped the caret or wrapped and grew the dialog by the row the bound
exists to save. The chip row's budget twenty lines above charges both. The row now charges
four, and fifty cells remains the binding cap wherever the terminal is wide enough for it,
mirroring ink's own field width.

What this round did not change is the window's anchor. Once a value passes the window the
caret cell is dropped and further keystrokes move nothing on screen, and the truncation marker
is counted as a cell the caret can sit on, so the highlighted cell can draw the marker instead
of the character being edited. ink's field scrolls to the caret on the width axis, as
Decision 32's rule already has this port doing on the newline axis. Making the window follow
the caret is its own change with its own tests, recorded under Follow-ups.

Five new unit tests — three in the confirmation dialog's suite and two in the authentication
one — and five mutations, one per behaviour named above. The two suites are a hundred tests
together and green with the fixes in place; each mutation fails exactly the test that owns the
behaviour it takes away and nothing else:

| mutation                                                 | fails                                 |
| -------------------------------------------------------- | ------------------------------------- |
| the lock's clause taken off the keystroke branch         | the keystroke-trailing-an-answer test |
| the caret cell sanitised no longer (question dialog)     | the bidi caret-cell test              |
| the width budget back to the margin alone                | the narrow-terminal test              |
| the step guard taken off the re-arm                      | the late-verdict caret test           |
| the field spans sanitised no longer (authentication one) | the bidi field test                   |

The machine leg was re-run at this head: twenty-seven scenarios on both legs, fifty-four
runs, none of them erroring. Of the seventy-eight checkpoints, nineteen have identical
non-blank content rows and fifty-nine diverge, carrying 241 rows only ink draws and 285
only this port draws once the two sampled checkpoints — the spinner's phrase rotation and
the mid-stream indicator, which hold elapsed time and a phrase chosen per tick — are
counted apart. Against the previous head, 143 of the 156 plain captures are
byte-identical with the version the banner prints normalised away. The thirteen that are
not divide into ten in three families whose content moves between two runs of the same
binary — the mid-stream indicator, `/stats` and the held-phrase row, on both legs, four of
the ten being the sample files — and three on the ink leg of the `@`-completion scenario,
which in this run did not print the extension-refresh notice the other leg printed. That
notice is the transient already recorded as a follow-up, and this is the first run in
which it landed on ink's side of the comparison rather than this port's.

The identical-checkpoint count therefore reads nineteen where the previous head's read
twenty-two, and the whole of that movement is those three checkpoints.

Nothing recorded in this decision moves a frame, and that is measured rather than argued:
no capture in any question-dialog or authentication scenario differs from the previous
head. The width budget binds only on a terminal of sixty columns or narrower holding a
value long enough to reach the cap, and the one fifty-eight-column scenario captures the
chip row before any free-text row is opened. The step guard, the lock's new term and the
two sanitising spans all turn on what arrives beside a key, or on which code point the
caret happens to sit on, and no scenario produces either. Like the five items of Decision
39, these four rest on the unit suites.

## Decision 41 — the cursor is read from a ref, and a list wraps where ink's does

Two classes of defect this round were the same shape wearing different clothes: a
handler answering from the value the last render closed over, and a list stopping at
its ends where ink's continues round.

The first is Decision 33's stale-cursor class, which that decision closed on two
handlers and left open everywhere else. It is now closed as a class. A twenty-eight
line hook holds the pattern — a state value beside a ref mirror re-synced during
render, a setter stable across renders that writes the ref synchronously, and
handlers reading the ref — and the shared select hook returns the ref beside the
index so every dialog that mounts it reads the same way. Six dialogs' wheel
handlers read it too. Where the state is not a cursor, the same mirror was written
inline beside the value it shadows: a checked set, two tab indices, and the
authentication wizard's main and sub menus, each with its own writers. The class is
closed for cursors and for those; the view and text state beside them is not, and
is recorded under Follow-ups.

The second is navigation. ink's selection list steps modulo the row count, so down
past the last row lands on the first. This port clamped. The helper that follows
ink already existed and was used in one dialog; it is now used at twelve call sites
across five dialog files, and the local clamping copy beside it was deleted. Its
signature widened from the shared list-item shape to an untyped readonly array so a
dialog whose rows are not that shape can use it too, with the disabled test done on
the row it casts. One dialog keeps clamping on three of its four steps, because
ink clamps there; it wraps on the fourth, which ink builds as a radio list. Its own
comment says which is which, so the mix reads as a decision rather than an
oversight.

Verified on frames, not only by test: a scenario boots in the last approval mode so
the list's cursor starts at its end, and one down keystroke must land on the first
row. A clamping implementation produces two identical frames, so the scenario
discriminates. Both legs wrap the same way in both directions, and the only other
difference in those frames is the vertical anchoring Decision 34 exempts.

## Decision 42 — the ink theme is applied, once at boot and once per selection

This renderer never asked the theme layer for anything. Its palette was built at
import time from a hardcoded dark surface, so a named theme in settings, a theme
picked in the dialog, and the light/dark probe were all inert: the port always
painted the same colours whatever ink beside it painted. That is a functional gap
rather than a cosmetic one, and it hid every colour divergence downstream of it.

Two call sites now apply the active ink theme. One is at boot, placed after the
deferred auto-theme probe has drained, so the theme it maps is the one ink settled
on and first paint is already correct. The other is inside the theme-selection
handler, after the shared theme manager commits, so a pick takes effect without a
restart. The mapping itself gained five tokens it did not carry: the two dimmed
status colours behind the approval-mode chrome, the symbol colour behind shell
mode, and the focused and default border colours behind the composer outline and
the banner panel. Each has a value on both surfaces.

The dark/light mode helpers remain caller-less. The theme layer reaches the port
through the ink theme, which already carries its own lightness, so the helpers are
a second path to the same destination and nothing selects between them. Recorded
under Follow-ups.

Verified on frames with a named theme pinned in the isolated settings directory.
Under it this renderer's palette and syntax tokens move off the values the
default-theme run produces, so the wiring is shown to carry a theme through, not
merely to run. The banner wordmark was originally cited here as that evidence and
was wrong to cite: its ramp was still hard-coded at the time and did not follow
the theme on either count, which is Decision 47.

## Decision 43 — five token-level colour divergences, and one separator that no shipped theme can show

Applying the theme made the next layer visible: rows that drew the right shape in
the wrong token. Five were found and corrected, each by reading the ink component
that draws the row rather than by matching a colour to the eye.

The message metadata on both sides used the link token where ink uses the accent
one; under the default dark surface the two happen to be the same colour, which is
why it survived until a theme separated them. The goal card's colour map was built
at import time out of the palette object's values, so it held whatever the palette
was before any theme was applied and never moved afterwards; it now maps a card's
colour name to a palette key and reads the palette when it draws. The footer's
status rows were dim where ink paints them with the accent token. The footer's
approval-mode label was one colour where ink colours it per mode, and its hint row
was truncated as a single joined string, so narrowing the terminal dropped the
coloured label whole instead of cutting it; the hint is now a list of coloured
parts truncated part by part against the same budget, and the two joins ink makes
— the inter-segment one and the single space before the queued badge — are each
emitted only where both of their neighbours are actually present. The tool card's
status glyph was bold where ink's is not.

A sixth row drew the right token pair the wrong way round: a separator in the
authentication wizard, painted with the dim token where ink uses the default
border one. It is swapped. What is recorded beside the swap is that no shipped
theme can show it. Eleven of the fifteen built-in themes pass no semantic tokens
to the theme constructor and so take its derivation, which reads both of these
tokens off the same grey field of the colour set; the four that do pass a shared
semantic set read them off the same grey field of that set; a custom theme that
omits them takes the derivation too. The swap is therefore observable only under a
user custom theme that sets exactly one of the two. It is a real divergence and a
correct fix, and it moves no frame on any theme this repository ships.

Colour was verified by reading the styled capture both legs produce. In a
truecolor terminal the banner panel's border carries the same source hex on each
side, so the wiring of Decision 42 reaches the screen and these five token swaps
land on the right values. The banner wordmark was read on the same frame and did
not match: its ramp was sampled differently on the two sides, which is Decision 47. In a 256-colour terminal, read under a named theme, the border diverges
because the two sides downconvert hex to an index by different rules, and the
wordmark diverges from its second coloured column onward — indices 212, 218, 182
against 68, 104, 103 — which is the same Decision 47 difference in source ramp
showing through the conversion, not a second downconvert rule. Colour was read on
these row families and no others, after the cursor cell of Decision 32, and it is
a narrower dimension than the geometry the rest of this sweep rests on. The
downconvert divergence belongs to the two libraries rather than to this port and
is recorded under Follow-ups.

## Decision 44 — a settled subagent is one summary line, and no roster card

A foreground subagent that finished drew its result body in full, where ink draws
one line: a glyph, the agent's name, and the description joined with its tool
count, its own sub-agent count, its duration and its output tokens, plus the
termination reason when it did not complete. The port drew the body as well as the
card, so a settled agent occupied a screen ink had already given back.

The summary is derived in the event adapter, from the same segments ink's own
helper uses, and only for a run that reached one of the three settled states — an
in-flight agent draws no summary at all. Counting its sub-agents keys on the same
name set ink's tool message uses, which was moved to a shared module so the two
sides cannot drift. The line carries three colour runs on screen, as ink's does:
the glyph in the tone colour, the name in the primary text colour and bold, the
rest dim and truncated by the shared result-length rule.

The roster card went with it. The end-of-task event narrowed to an identifier, and
both model layers now splice the card out when it arrives, so the settled row is
the summary and nothing else. The card's completion flag and its statistics string
were only ever read to build the row the summary now builds, and the local token
formatter beside them had a shared equivalent, so all three were deleted rather
than left unreferenced.

## Decision 45 — the thought body is markdown, and its label carries the elapsed time

An expanded thought printed its text as one dim run. ink renders the same text
through the markdown component with the secondary text colour, which paints the
plain text _and_ the headings that colour while leaving inline code and links
their own. A heading inside a thought therefore read as body text here and as a
heading there, and a link lost its colour entirely.

The body is now markdown, in a box indented by the same two columns the status
glyph occupies, so the body gets ink's own width rather than running under the
gutter. That width was measured rather than derived: an unbroken run inside the
box breaks at ninety-four columns, which is what ink's body is given at the same
terminal width. What the box does not decide is where the markdown breaks a line
of ordinary prose, and there the two sides differ; that difference is recorded
under Follow-ups. Because the renderer's own inline-text token wins over an
element's foreground, a dimmed body needs its own token map: one is built beside
the syntax style on every theme application, rewriting only the inline-text token
and the heading ones to the dim colour and leaving the code and link tokens
alone. A theme that omits the inline token keeps it omitted, so the no-colour
theme still leaves that text uncoloured as ink does. The dim colour it rewrites
to is read after the palette is assigned, not before.

Two smaller items on the same row. Its collapsed hint was missing the words that
say the row can be clicked, which ink prints; the clickable flag it consulted was
hardcoded off at the one call site, so it is gone rather than carried. And a
thought still streaming had no duration, so its pending label printed without the
elapsed time ink derives on every render; the label now derives it from the start
stamp when no duration has been stamped yet.

## Decision 46 — three dialogs rebuilt on the shared chrome, and two frames corrected

The approval-mode, effort and output-style dialogs each carried their own local
frame: their own border style, their own padding, their own title colour, their own
footer-hint placement, and their own hand-written row text. Every one of those
diverged, and none of them diverged in a way a per-dialog fix would have kept
fixed. All three are rebuilt on the shared dialog frame, list and footer-hint
components the rest of the port already uses, with their rows built from the same
display-name and description helpers ink's own dialogs call — so the numbered rows
now read as ink's read, and a future change to the shared chrome reaches them.

The effort dialog also gained the step ink's has for scoping the setting, reachable
by Tab, with the workspace-priority warning ink prints when a workspace value
overrides the one being changed. Its note when the configured effort is not
available for the model now carries ink's two branches rather than one.

Two frames were corrected beside them. The shell dialog drew a square border, an
accent-coloured title and a close hint ink does not print, with a column of padding
either side that ink's box does not spend; it now draws a rounded border in the
default border colour, a bold primary-coloured title, no close hint, and ink's own
wording for a resumed session. The authentication wizard's frame spent one more
column of padding than ink's, printed a close hint ink does not, and drew its
separator twenty-four columns short; all three are corrected, and its link row is
underlined and dim as ink paints it.

The machine leg was re-run at this head, widened first: seven scenarios were
added for the thought card, the settled subagent, the authentication wizard, the
two stale-cursor bursts, the wrapping list and a named theme, so the matrix now
holds thirty-four scenarios and sixty-eight runs, none of them erroring. Of the
ninety-seven checkpoints, twenty-six have identical non-blank content rows and
sixty-nine diverge, carrying 365 rows only ink draws and 357 only this port draws
once the two sampled checkpoints — the spinner's phrase rotation and the
mid-stream indicator, which hold elapsed time and a phrase chosen per tick — are
counted apart. The identical count therefore reads twenty-six where the previous
head's read nineteen.

Against the previous head, 143 of the 152 plain captures common to both runs are
byte-identical with the version the banner prints and the branch the footer
prints normalised away. The nine that are not divide into the same four transient
families the previous run named: three on the ink leg of the `@`-completion
scenario, which in this run printed the extension-refresh notice the archived run
had not, and six across the mid-stream indicator, `/stats` and the held-phrase
row, on both legs. None of the nine is a capture this round's changes touch.

Most of the sixty-nine divergences are the vertical anchoring Decision 34
exempts, the long-token wrap recorded under Follow-ups, or the elapsed time a
settled card prints. The seven new scenarios read as intended: the subagent's
summary row matches on both legs down to its separators, and the wrapping list's
three checkpoints differ only in where the block sits, with the cursor on the
same row of the list in every frame — one down keystroke from the last row lands
on the first in both legs, which is the discrimination the scenario was written
for. The thought card's two checkpoints do not match, and the part that is not
the long-token wrap is the markdown break-point difference recorded under
Follow-ups.

## Decision 47 — the wordmark gradient is sampled per line, off the theme's semantic ramp

The banner's wordmark carried a gradient on both legs and the two did not agree.
Reading the styled capture cell by cell across the six lines of the mark — 221
coloured cells — showed two independent causes, neither of which is visible in the
other's absence.

The first is which colours are used. The port hard-coded the ramp the base light
and dark colour sets declare. ink reads it off the active theme's semantic tokens,
from the same candidates in the same order: the theme's own gradient when it
declares a usable one, otherwise the secondary, link and accent text colours,
otherwise no gradient at all — in which case ink paints the mark uncoloured rather
than throwing. Eleven of the fifteen built-in themes take the constructor's
derivation and so do carry their own ramp. The four that pass a shared semantic set
— the two Qwen themes and the two ANSI themes — inherit the base ramp instead, and
the gradient they declare never reaches the banner. The port now derives the ramp
from the ink theme through those same candidates, resolves each stop the way it
resolves the palette, and treats fewer than two survivors as no ramp.

The second is how the ramp is sampled. ink's gradient component wraps the
renderer's per-node text transform, which runs once per laid-out line, so each line
of the mark builds a ramp of its own over a step count of its own width. The steps
between two stops are not a plain interpolation: the library behind it seeds each
segment with a rounded share of the step count, rebalances until the segments sum
to it, and then steps each segment from its own start colour. The port shared one
ramp across all six lines and lerped on a plain fraction of the widest one. Both
choices are wrong, and differently: sharing the ramp puts the middle stop at the
same column on every line, where ink puts it one column earlier on the 36-column
first line than on the 37-column ones, and the plain fraction leaves the shorter
line one step short of the last stop. Sampling per line with the library's own
substep arithmetic reproduces all 221 cells of the ink capture exactly; the
previous formula reproduces 26 of them.

The arithmetic is reimplemented rather than imported — some twenty-five lines —
because the library that defines it reaches this package only as a transitive
dependency of the component ink uses, and depending on it directly would mean
declaring it. It is pinned by tests against the hexes read off the capture, at both
line widths, and those tests were shown to fail against the previous formula.

## Decision 48 — two settings ink reads had no reader here

A sweep for settings that change what ink draws found two that this renderer
accepted from the same merged configuration and then never looked at: the clock
stamp above an assistant row, and the switch that collapses a tool call to its
header. Both were confirmed by reading every reference to each key in the package:
the only readers were ink's own history display. A setting with no reader is worse
than a missing feature, because the configuration UI offers it and appears to
honour it.

The stamp needed a time on the shared item type, and two sources for it. A live
turn has no recorded time to read, so the block is stamped when it opens, with the
fold's own clock, and later deltas appended to the same streaming block leave that
stamp alone — one message, one stamp. A resumed session rebuilds the transcript
from the recording instead, where each assistant record carries its own time; that
record holds several text parts, so only the first text run of it is stamped and a
leading reasoning block does not consume the stamp. Shipping the live half alone
was the divergence the follow-up entry warned about: a resumed session would have
shown no stamps at all. The label itself is ink's, character for character — a
24-hour, zero-padded clock in brackets off the English locale, which is what keeps
`23:00:00` from rendering as a 12-hour clock on a host whose locale differs.

The collapse is ink's rule with ink's four exceptions. A card collapses only when
the setting is off and the card was not clicked open, and the app-wide full-detail
toggle is not holding it open, and the call is not still waiting for an answer.
That last exception is the one that matters: the card is the only surface carrying
the payload being approved, so a collapsed card would ask the user to approve
something they cannot read. Ink chooses between two hints by whether the card is
clickable, and the mouse is on here except under the screen reader, so it takes
the clickable branch and names the click alone — the same call the thinking
card's hint already makes.

Both halves are pinned by tests that were shown to fail against the previous
behaviour: dropping the setting gate, dropping the pending exception, stamping
every text run instead of the first, reading a 12-hour clock, and naming both
affordances in the hint where only one applies — each was shown to break
assertions, and only those.

## Decision 49 — `@` completion asks every source ink asks, behind ink's tabs

This renderer's `@` completion asked the file index and nothing else. ink also
completes prior sessions of the current project, MCP servers and their resources,
and installed extensions, and — once more than one category is present — draws a
tab bar to move between them.

The search itself is reused rather than reimplemented. ink's completion hook takes
a pattern and two callbacks and owns everything else: the crawler's lifecycle, the
short delay before it admits a search is slow, the cancellation of a search a newer
keystroke superseded, and a merge order it documents as an invariant, with sessions
appended last on every path. Reimplementing that would have meant duplicating the
invariant in a second place, and the hook has nothing renderer-specific in it. What
was not reused is ink's navigation state: it keeps its own highlighted index and
its own visible window, and this composer already has both, built to survive a
batch of keystrokes handled inside one render. So only the category rules were
ported — the fixed tab order, the tab set a result list implies, the filter, the
wrapping step, and the fallback to the first tab when a newer result set no longer
contains the one on screen. That last one is derived during the render rather than
corrected after it, which is one render pass cheaper and visibly identical.

Reusing the hook exposed a hazard the local search never had. Leaving `@` — the
buffer cleared, a slash typed instead — makes the shared hook dispatch a reset, and
that reset's publication lands after the render in which the same keystroke already
published the slash results, wiping them. Both forwarded callbacks are therefore
gated on the mode this composer is actually in, which is updated synchronously as
the keystroke is handled. The gate also closes, for `@`, a hazard ink still has: a
search resolving after the buffer was cleared can no longer repopulate a dropdown
over an empty composer and steal the next Enter. The guard on the shell-mode
keystroke stays, because slash argument completion is still driven locally and can
still race it.

Two details of the drawing follow ink rather than this renderer's slash list. The
tab bar owns the bare left and right arrows only while it is up, with every
modifier pinned off so word movement and any terminal binding still reach the
buffer. And in mention mode a label column is shared only by the rows that carry a
description — a bare path keeps the full width — where in slash mode every row
shares one. The tab labels are exported from ink's own list component instead of
being copied, so the two renderers cannot drift on a translation.

## Decision 50 — the card header is one wrapping block, and both states share one shape

Frame-verifying the collapse Decision 48 wired turned up two defects in the tool
card's header, one of them a regression that only the frames could show.

The first is the collapsed card's own tree shape. Collapsed and expanded returned
different structures, and this renderer's React binding reconciles children by
position and type and never clears a prop a re-render drops — the hazard Decision
11 named, and a site its survey judged unaffected, because the collapsed branch
sets a width the expanded branch never sets, which is exactly the removal case.
So the box holding the two-column status glyph was reconciled onto
the box the expanded header row uses, kept the width it had been given, and the
expanded card drew the glyph and the first letter of the tool name with everything
else clipped away. Both states now return one shape: the same header row, with the
name and hint as separate runs while collapsed and as one wrapping block while
open, and the body simply absent when collapsed. A test pins the part that jsdom can
see — that the header row is the same element instance before and after the toggle,
and that the glyph's box is the only descendant ever carrying a width — which is what
fails if the two shapes come apart again. The width residue itself is a renderer
behaviour the unit runtime cannot reproduce; it was read off the terminal, and
confirmed absent the same way after the fix, including across a resize.

The second is the expanded header's own layout. It was several text nodes side by
side: the name, the description, the arrow that marks a waiting call. Flex siblings
cannot reproduce what ink draws, because ink treats the name and the description as
one wrapping block whose width is the header's own inner width — the card's width
minus the two columns the status glyph occupies. Three consequences followed, all of
them visible in a frame: the description's leading space was lost, so the name and
the command ran together; wrapped rows were indented by eight columns where ink
indents by four, because a sibling starts after the name rather than under it; and
the arrow sat where the row ended rather than after the block's last character. The
header is now a single text node carrying inline styled runs — the name bolded, the
description and the arrow dim, the arrow in the primary colour as ink paints it — so
the wrapping is the renderer's own and the geometry matches. The block's width is
the same value the truncation helper already computed the row cap from, which is why
the cap and the drawing now agree.

Two residuals remain and are recorded under their own entries rather than here: the
single cell between the name and the description is uncoloured in ink and dim in
this port, which is the uncoloured-text divergence, and a token longer than the
block still breaks earlier here than in ink, which is the long-token wrap.

The stamped assistant row got the same remedy, because its two shapes differ the
same way and the setting that chooses between them is dialog-settable and needs no
restart — so a row already on screen switches shape mid-session. Its branches now
carry keys, and a test pins the part that matters: after the flip the unstamped row
is gone rather than reshaped in place, which is the assertion that fails when the
keys are dropped.

The machine leg was re-run at this head, widened by five scenarios first: the stamp
with the collapsed card, the `@` categories, the away recap, the editor dialog, and
the session picker's Space preview. The matrix then held forty-three scenarios and
eighty-six runs — thirty-eight at 100×40, the three transcript arms at 100×30, the
narrow boot at 60×24 and the chip row at 58×40 — and not one run errored. Nine ended
on an idle timeout instead of a settled frame, and all nine are legs that have always
timed out: the auth wizard's model list on ink, whose spinner never goes idle, and the
two multi-question arms.

Of the one hundred thirty-one checkpoints, thirty-three have identical non-blank
content rows. One family dominates the other ninety-eight: the context-file notice
names a path long enough to be a single unbreakable token, the two legs break it at
different columns, and nearly every frame that shows the notice shows it differently.
Dropping the notice and the path fragments it wraps into from both legs leaves
seventy-three identical and fifty-eight divergent, two of them the sampled checkpoints
— the spinner's phrase rotation and the mid-stream indicator. Counting those two
apart, the rest carry 258 rows only ink draws and 288 only this port draws. The
seventy-three/fifty-eight split those counts were taken over is the one Coverage
boundary withdraws: it does not reproduce from these frames, and the row counts
fall with it. The tally above and the census
below count from it, and stand as that pass's own readings rather than as live
tallies — the same narrative past every per-pass re-run paragraph above is written
in.

Those fifty-six fall in eleven families by primary cause, four of them new to that
pass. Seven are non-deterministic and no fix can close them: the two single-frame
spinner phrases, the three stamp frames where the clock moved on its own, and the
elapsed milliseconds on the two sub-agent frames.
Nineteen are Decision 26 — this port still shows the banner ink has scrolled off, so
identical content sits at different rows. Ten carry a defect no earlier pass had
shown: the notice row keeps glyphs from the banner row it displaced, because the
renderer never repaints a cell whose new content is a space. Four are a dialog that
does not stretch — ink sizes its approval-mode box to the rest of the viewport and
fills it with blank rows, this port sizes it to its content, and every row inside the
box is word for word the same. Four are the card header's long argument wrap, four are
the trailing scrollbar glyph, two are a scroll offset, two are a row that appears in a
different order, two are a truncation the two legs disagree about, one is the expanded
thinking body's indent, and one is the gated-server dialog's paragraph continuation.

The vertical comparison is no longer reported, because Decision 26 made it
meaningless: this port pins the composer to the bottom of the viewport where ink pins
it to the top, so 128 of the 129 reconstructed frame pairs differ in position alone.
Content rows are the comparison that survives that decision.

## Decision 51 — the editor dialog reports a failed save where the user can see it, and its two lists are the shared numbered window

`/editor` persists a preference through the shared settings object, and that write can throw — a read-only file, a scope the process cannot reach. ink catches the failure and prints it inside the dialog, so the user reads why nothing changed and the dialog stays open to try another scope. This renderer swallowed it: the catch closed the dialog on the error path exactly as on the success path, so a failed save was indistinguishable from a saved one and the preference quietly did not move. The write now records an error string instead of closing, the string renders in red above the frame, and the dialog stays mounted. A test drives a throwing setter and asserts both halves — the message on screen and the frame still open — which is what fails when the catch goes back to closing.

The two lists inside the dialog were hand-drawn rows, which cost them the index column and the scroll window every other list here has. Both now run through the shared select hook and widget, so the editor step and the Apply-To step number their rows, window them instead of growing past the frame, and step over the disabled row rather than landing on it. The widget is the same one the confirmation dialogs use, so the numbering, the highlight and the wheel match the rest of the port instead of a one-off; the editor list also re-seats its cursor on the chosen scope's stored preference when the user comes back from Apply-To, which is how ink keys its own.

The dialog drew a title row of its own above the two columns, and its bottom hint wrapped to a second line where ink truncates it inside the left column. The title row is gone — the two column headers are the top rows now, as ink's are — and the hint is clipped to the column's own budget, 45% of the content width less the two columns of padding, which is the truncate box ink puts it in. Tests pin each half: no chrome title row of the dialog's own, and the hint clipped to the left column with a single ellipsis rather than wrapped.

## Decision 52 — `/resume` and `/delete` share ink's session picker, and delete commits a checked set

`/resume` and `/delete` each drew their own session rows, and neither matched the picker ink mounts for both. The rows are now one component, built on the same pieces ink's SessionPicker uses rather than beside them: the shared filter and page size, the relative-time and message-count formatters, the truncation helper, and the search-input hook with its printable-character test. A row carries the two-column cursor marker — an up or down arrow at the window's edges — the title clipped to its own budget, and a meta line of relative time, message count, branch and disabled hint in ink's order. The visible window is derived from the terminal height the same way ink derives it, so the list scrolls rather than running off the frame.

Delete also lacked ink's bulk path. It now mounts the picker with multi-select on and reuses ink's own delete command for both the single and the batch case, so the guard against deleting the live session, the mutex and every outcome message are shared rather than re-worded. Enter commits the checked set ordered by the full list and filtered to the enabled rows, so a search that narrows the view never silently drops a check made before typing; the live session is disabled in place rather than filtered out, matching ink. Resume keeps the single-select picker, with the command's pre-filtered list when `/resume <title>` matched more than one session. The cursor and the checked set both sit behind ref mirrors, so a burst of Space and arrow keys inside one read commits the set the user actually ticked rather than the one the last render drew.

The structure and the batch path are pinned by tests over the rendered rows — the two-line shape, the unknown-count case, the checkbox commit, the disabled live session, the checks hidden while multi-select is off, the window's edge markers and pagination — each shown to fail against the previous hand-drawn rows. The picker's own height is fixed rather than content-sized, which Decision 67 establishes is what ink does too: the box asks for `height − 1` and the popup region's fixed height presses it down.

## Decision 53 — the auth wizard's model step focuses by colour and windows to eight rows, inside ink's square frame

The onboarding wizard's model step drew a `›` cursor glyph beside the focused row, listed every recommended model at once, and had no search field. ink's model step does none of those: it conveys focus by colour alone, windows the list to eight rows, and puts a search field one Tab away that filters the recommendations as the user types. The step now matches — the glyph is gone, and the focused row is green where a checked-but-unfocused row takes the accent colour and a plain row the body colour; the list is a slice of the filtered models capped at ink's shared eight-row constant and scrolls as the focus moves; and the search field uses ink's own option-label and search-text helpers, so the rows read identically and cannot drift on a translation. Those constants and helpers are imported from ink's provider-setup module rather than copied.

The dialog's frame was rounded like every other dialog here, but ink frames its auth dialog with a single border, so the wizard now asks the shared shell for square corners and leaves the rest of the port rounded. It also lacked ink's branch for a provider that ships no recommended models: where the list would be empty, ink drops the recommendations and the search entirely and asks for comma-separated model IDs in a free-text field, with the provider's own defaults as the example. That branch is now drawn, and a separate empty-search result — models exist but none match the query — says so in ink's words rather than showing a blank list.

Tests pin the parts jsdom can see: the no-recommendations branch for a provider without models, the model-IDs error surfacing on an empty submit, the search field filtering the recommended list one Tab away, and the custom-ID field keeping its own caret. The burst cases the step already had — a held Space applying every tick to the same checkbox, and an Enter submitting the tick made in the same read — still pass against the colour-only focus, which is what fails if the glyph comes back or the window stops scrolling.

## Decision 54 — a descriptive list stacks its description under its label and marks the pick in green

Three dialogs draw a list whose rows carry a label with a description beneath it — the auth wizard's radio steps and the arena's stop and select dialogs. All three indented the description two columns past its own label, because the description sat in a sibling that started after the marker rather than under the label, and all three marked the picked row in the body colour where ink uses green. Each row is now a two-column box: a fixed two-column marker holding the `›` or a space, beside a single growing column that stacks the label and the description, so the description lines up under the label instead of past it. The selected row's marker and label take the success green ink uses, and an unselected row stays body-coloured with a dim description.

The change is read off the rendered rows in the three dialogs' own tests, which assert the description's column against the label's and the selected row's colour. The row spacing is untouched — this is the indent and the colour, not the rhythm between rows.

## Decision 55 — the away recap fires because the entry mounts the hook ink's container does

ink fires a recap when the user returns to a session left idle past a threshold: its container mounts a hook that watches the focus and idle edges and, on return, appends a summary row and records it. This renderer never mounted that hook, so the away recap never fired — the setting existed, the hook existed, and nothing between them ran. The hook now mounts in the entry, which is where the live transcript and the streaming-to-idle edge already are, so its gate reads the rows it needs without a second copy of them. Focus comes from a new hook of this renderer's own: @opentui/core already parses the terminal's focus and blur events, but nothing switched focus reporting on, so this hook owns the `?1004` mode for the OpenTUI leg, starts focused, and re-asserts focus on any keypress — ink's own tmux workaround, since a session that does not forward focus events would otherwise stay blurred forever. Only one leg is ever mounted, so the two never both write the mode.

The recap the hook returns lands as its own transcript item, which stops a streaming assistant block before it appends the summary, so it cannot splice into a turn still in progress. The hook records that recap on its own — the result phase of a `/recap` command, never the invocation — mirroring the manual command, so the auto-fired summary reaches the session log the same way. Whether a resumed session redraws it is the result-phase replay gap already under Follow-ups, which covers every slash-command result row rather than this one alone.

Tests cover the focus hook's edges — the mode written on mount and cleared on unmount, the focus and blur events, the keypress re-assertion, the detach, and a stdout that throws — and the recap item's projection into the transcript. The hook's own firing is ink's shared code and is tested there; what this decision adds is the mount, the focus source and the item, each pinned here.

## Decision 56 — the footer's model segment carries the reasoning effort

ink's status line renders a model-with-reasoning preset item, so its model segment carries the reasoning effort beside the name — or `reasoning off` when the model has none. This renderer's footer printed the bare model id and dropped the effort. The segment now goes through the same shared formatter ink's preset uses, which strips a leading provider tag, appends the effort when there is one, and says `reasoning off` when reasoning is explicitly disabled. The effort comes from the same display helper the rest of the port reads, so the footer and any other surface that names the model agree.

A test pins the segment against the preset's output — a model with reasoning off reads as its name followed by `reasoning off` — which is what fails when the footer goes back to the bare id. The divergence was first read off a reconstructed frame, where the two legs' model segments differed by exactly the effort suffix.

## Decision 57 — the pointer follows `ui.mouseTracking`, and so do the two expand hints

ink reads `ui.mouseTracking` in two places: it decides whether the renderer captures the pointer at all, and it decides which of two expand hints a collapsed card shows — `click to expand` while the mouse is live, `ctrl+o to expand` when it is not. This renderer read neither. It created its renderer with the pointer always on, and both expand hints — the collapsed tool card's and the thinking card's — hard-coded the clickable branch, so they advertised a click even under `ui.mouseTracking: false`, a setting with no read point here at all. Both now read it: the renderer is created without pointer capture when the setting is off, which hands right-click menus and OSC 8 link clicks back to the terminal as ink's does, and a live mouse flag is threaded into the transcript so each hint takes the branch that matches.

The hint follows ink's own choice rather than a new rule — clickable while the pointer is live, key-only when it is not — which is the same call the thinking card's hint already made. The flag defaults to live, so the default setting changes nothing on screen; turning it off drops the click affordance from both hints and from the pointer at once. Decision 48 took the clickable branch on the assumption that the mouse is on here except under the screen reader; this decision makes the setting a second gate on that branch, and Decision 58 supplies the screen-reader leg.

Both directions were confirmed on a real terminal: a dedicated scenario with the setting off shows no click affordance in either leg — the collapsed card and the thinking card both read `ctrl+o to expand` — while the same bundle with the default setting still offers the click. Unit tests pin the wiring beside it: the transcript receives the flag as false when the setting is off, and each hint's text follows it.

## Decision 58 — a screen-reader session stays on ink

Screen-reader mode needs plain-text, append-only output on the main screen with no mouse, so a screen reader reads each line once as it lands. This renderer has no path for that: it draws in place on the alternate screen with differential redraws and a live pointer, which a screen reader cannot parse. Serving OpenTUI under the flag would hand such a user in-place redraws that are worse than useless. So the renderer-selection gate now treats screen-reader mode as a second ink-only capability, beside the runtime probe it already had: when the flag is on the gate keeps ink, and in strict mode it throws rather than falling back silently.

The check sits before the runtime probe and outranks it, so a screen-reader session on a runtime that cannot initialise the native FFI still reports the screen-reader reason rather than the FFI one — the capability, not the platform, is why ink is serving. The entry passes the configured screen-reader flag into the gate, so this is a live switch rather than a dead parameter. The plain-text and screen-reader policy modules this renderer carries stay unwired: they are imported only by their own tests, and threading them into a render path is follow-up work, not this change. This decision is the gate that keeps such sessions on ink until they are.

Tests pin both the fallback and its reason, and a mutation that moves the screen-reader check after the runtime probe fails the case asserting the screen-reader reason wins on an unsupported runtime. On a real machine, strict mode throws naming screen-reader rather than the FFI; on a supported bun runtime a screen-reader session stays on ink while the identical run without the flag serves OpenTUI.

## Decision 59 — Space previews a session, in a tree of its own rather than inside the list's frame

The picker Decision 52 built could only act on the row under the cursor. ink's picker has a second mode: Space loads the highlighted session and replaces the list with a preview, so the user can read a transcript before committing to resuming or deleting it. That mode was absent here, which left `/resume` a blind choice among titles and made the picker's own `Space to preview` hint advertise nothing.

The preview is returned as its own tree rather than as a swapped body inside the list's frame, because ink's has no border at all and its transcript spans the full inner width — a narrower body inside the framed shell would not have matched either the geometry or the reading width. Both trees carry a key, and that is load-bearing rather than decorative: this renderer never clears a prop a re-render drops, which is the failure Decision 11 records, so returning the framed list's box with the border style simply omitted left the border drawn on screen. Keying the two shapes apart forces an unmount instead of a reuse.

The transcript comes from replaying the resumed session's events with no config passed in, so a tool group degrades to its name alone. That is not a shortcut — ink's preview passes a null config to the same builder and gets the same degradation, so the two agree on what a preview is willing to show. The meta line counts messages from the list entry when it carries a count and otherwise over the unique user and assistant uuids in the loaded conversation, which is ink's own fallback, and orders its segments count first — the reverse of the row's time-first order, again as ink does.

While the preview is up it owns the whole keyboard: the picker's handler returns before it reads anything else, so a typed letter cannot start a search and an arrow cannot move a cursor that is no longer visible. Esc and ctrl+c come back to the list with the cursor, the checks and the query untouched; Enter resumes the previewed session. A load that resolves after the user has left is discarded rather than drawn over whatever they moved to. The mode is mounted for `/resume` only. `/delete` runs the picker in multi-select, where Space is the checkbox toggle, and the preview is off whenever multi-select is on, so the two never compete for the same key.

Two of ink's guards were not ported, on purpose. Its picker throws when a caller asks for multi-select and preview together; this one resolves the same request by preferring multi-select. Neither production caller asks for both, and a precedence rule costs nothing observable where a throw would turn a wiring mistake into a crash. Its preview is also gated on a session service being present while that mode has already switched off the picker's own keys, so a missing service leaves ink's picker with no way out of a mode it cannot draw; here Esc returns to the list regardless.

ink's own preview carries a defect that was not ported. Its loading branch is an ordinary box and its ready branch is a static block, and the height difference between them makes ink erase content it has already written to the static region and scroll the screen by several rows: the frame this sweep captured on the ink leg was blank, while the raw byte stream beside it carried the whole transcript. The port keeps one shape for both states, so neither the erase nor the scroll can happen. The ink leg's static output was still read as the reference for the intended layout, and the ported body wraps at the same columns and breaks at the same words.

Nine cases pin the mode over the rendered rows: the swap and its Enter, the Esc that preserves the cursor and the query, the preview's exclusive claim on the keyboard with ctrl+c backing out rather than cancelling, both error wordings, the uuid-deduplicated count, Space staying with the checkboxes under multi-select, nothing at all drawn for a flow that did not opt in, and a late load dropped. Two scenarios cover it on a real terminal — one asserting the preview's frame, its borderless geometry and the byte-identical list after Esc, the other asserting that Enter actually restores the session into the main transcript rather than only closing the dialog. Not verified on a real machine: the two error branches, which need a corrupt session file to reach, and scrolling inside a preview longer than the viewport.

## Decision 60 — the row glyph's gap is a column, not a character

The user row and the assistant row each printed their status glyph and the space after it inside one text node, beside a growing sibling that carries the body. When the body is long enough to wrap, the sibling takes the full width and the trailing space is squeezed out, so an answer read `◆︎Answer` with no gap at all. Nothing in the frame matrix had shown it before, because every seeded body was short enough to leave the space room; the preview Decision 59 added was the first to put a deliberately wrapping answer in a transcript.

The gap is now a fixed-width box holding only the glyph, sized by the same constant the tool card's status column uses, so it cannot be traded away by a sibling that needs the room. This is the same failure the warning row had, and the same fix; the shape is worth having in one place rather than rediscovered per row.

A test pins it on both rows — the glyph sits in a two-column box of its own and carries no surrounding whitespace — and fails when either row goes back to an inline space. The frame that exposed the defect now shows the gap and wraps at the columns ink wraps at. One row of the same family was left alone deliberately: the subagent summary line also prints its glyph and space inline, but its three siblings are all plain text and none of them grows, so the squeeze cannot reach it. Changing it would be a guess at a defect no frame has shown.

## Decision 61 — the harness routes a side query by its own marker, not by the absence of the main agent's

The comparison harness answers every request from one fake endpoint, and that endpoint
serves more than the conversation the scenario scripted. A turn can be followed by a
session recap, a follow-up suggestion, a title, a next-speaker check, a memory recall,
a compression pass, and — when the workspace has managed memory on — an extraction
subagent that reads and writes files. Only the main turn and the subagents it spawns
should consume the scenario's response table; a side query that takes a table entry
silently shifts every later reply by one, and the frame that comes out looks like a
rendering defect rather than a harness defect.

The first test was the main agent's system-prompt prefix, and a request that did not
carry it was treated as a side query. That is the wrong shape of test, because the
prefix is not one string: each subagent carries the prompt its own definition gives it,
so a built-in general-purpose agent and a user's `.md` agent differ, and enumerating
them is not a thing a harness can keep true. The subagent frame lost its reply.

The replacement — streaming plus a tool declaration means an agent conversation — was
worse, because it looks like a rule about the wire and is not. The managed memory
extraction subagent streams and declares tools; it is a subagent in every sense except
that it belongs to the memory feature rather than to the turn. It took the table entry
the scenario had written for the second reply, and the recap scenario timed out waiting
for a row that had already been spent. The follow-up suggestion defeats the rule from
the other side: it reuses the main agent's prompt verbatim and is identifiable only by
the last user message.

So the test runs the other way. Each side query is recognised by a marker it owns —
the recap's own instruction, the suggestion's mode header, the compression directive,
the extraction subagent's system prompt — and a request that is not streaming is a
JSON side query. Everything else is an agent conversation and takes the table. The
three answers a side query gets are the recap's text, an empty string where an empty
string means "no suggestion" and "nothing to compress", and the canned empty-recall
JSON. Re-routing on a positive marker rather than on the absence of one is what makes
the harness survive a new side query: an unrecognised one lands in the agent bucket
and shifts a reply, which the frame shows, instead of being silently answered from a
table it was never meant to read.

The re-run confirms it on both the behaviour and the routing. The subagent scenario
went from erroring after two minutes to settling in twelve seconds, and the recap
scenario from timing out on its second reply to settling in seventeen. Every request
the full matrix made was then classified: eighty main turns and two subagent turns
took the table, and twenty-six JSON side queries, two recaps and fifty-six suggestion
calls did not. No table entry went to anything but an agent conversation.

## Decision 62 — the palette carries a revision, because the banner's memo cannot see a repaint

Decision 42 made the theme live and Decision 47 took the wordmark's ramp off it, and between them they left a hole no boot frame could show: the banner is memoised, and nothing a theme selection changes appears in its dependency list. The palette is one object mutated in place, so its identity survives `/theme`; the settings object the theme manager writes into is mutated as well, so its identity survives too; and the config is untouched. A banner that was already mounted therefore kept painting the ramp and the border colour it had been built with, and only a resize or a restart brought the new theme in. Every frame the matrix captured boots with the theme already applied, which is why this survived the sweep.

The palette now carries a revision counter, bumped by both mutators, and the banner's memo depends on it. A module-scope counter is not a dependency the hooks lint accepts — it warns that mutating an outer value re-renders nothing — so the line carries a suppression with the reason beside it. The suppression is honest rather than a way past the rule: the re-render comes from the theme-selection handler's own state write, and the counter is what tells the memo that the values it closed over were repainted underneath it.

A test repaints a mounted banner — the same config and settings objects are held across a theme change, and the wordmark's first cell is asserted before and after. Dropping the counter from the dependency list fails it with the old ramp still on screen, which is the mutation that shows the case discriminates. Not verified on a real machine: the light/dark mutator has no production caller (Follow-ups), so only the named-theme path is exercised, and no frame was captured of a theme picked mid-session.

## Decision 63 — the ref mirror reaches two handlers Decision 41 missed

Decision 41 recorded the stale-read class as closed for cursors. It was not. Two handlers sit outside the shared select hook it converted, and both were read off the source rather than off a frame.

The rewind restore-option list keeps its cursor in a reducer, which the shared hook does not reach. Its Enter read the reducer's answer, and a burst cannot have delivered that answer yet: an arrow auto-repeat followed by Enter restored the option highlighted before the arrows moved. The clamp the reducer applies is now a function both sides call, and the handler advances its own mirror before it dispatches, because inside a burst a dispatch does not render and a mirror re-synced during render would still hold the pre-burst index. The render-time write beside it is what keeps the mirror honest across the resets the reducer performs on cancel and on a failed restore.

The permissions dialog's two free-text fields — the rule and the workspace directory — were listed under Follow-ups as string state still read from the closure, and they are the one member of that list whose trigger is a single gesture rather than two keys of different meaning: a pasted path followed by Enter arrives in one read, so the field submitted the empty buffer it held before the paste and the dialog stayed put. Both now sit behind the mirror the cursors use, which lives in a module of its own rather than inside any one dialog, and their backspace and their append write through the mirror as well, so a burst that edits and then submits is coherent end to end. What remains open is the state that gates a branch rather than feeding a submit — a view name, a step, a search query — and stays recorded under Follow-ups.

Three cases pin the rewind handler: a burst that lands on the third option, a burst that clamps into `Never mind` and then re-syncs the mirror for the next one, and keys dropped while the diff still loads. Three pin the permissions fields, one of them editing inside the burst. All six were run against the pre-fix code and fail there — the rewind burst reports the first option instead of the third, and the permissions fields submit nothing at all. Neither defect was reproduced on a real terminal: the burst needs a paste or a held arrow inside one read, which the harness cannot type.

## Decision 64 — the mirror reaches two more reads, and one of them is not a number

Decision 63 closed the two handlers outside the shared select hook. The class had two more members, again read off the source rather than off a frame.

The auth wizard's model step holds which of three targets has focus — the custom-ID field, the search field, the list — in plain state, and its arrows, its Space and its paste handler all read that state off the closure. A held arrow followed by Space therefore typed a space into the field the arrows had already left, instead of toggling the row they had reached. The composer's `@` category tab stepped from the tab the previous render showed, so three arrows inside one read moved one tab rather than three.

The cursor mirror only carries numbers, and a category is a string union, so the mirror was generalised beside it: one half for a numeric cursor, one half for any other value, both writing state and ref together. The wizard's focus and the composer's tab now sit on those two halves, and eight call sites take the mirror from that one module rather than growing a local shape each — the shared select hook, the session picker, the permissions dialog, the composer, the auth wizard, and the MCP, settings and arena dialogs.

The tab is the instructive one, because it already used a functional update and still read stale. Inside a burst a functional update chains correctly — the third arrow does see the second arrow's write — while the value the handler closed over never moves, so an expression mixing the two still starts from the pre-burst tab. The fix is to read the mirror and do the arithmetic on it explicitly, which is what both handlers now do; the wizard's arrows in particular stopped deriving their next index from the render's copy.

Three cases pin this: a three-key burst that lands the Space on the row the arrows of the same read reached, a two-key burst that toggles the row an arrow moved to, and three arrows of one read that carry the tab to Extensions. All three fail on the pre-fix code — the two wizard cases invert which radio glyph is filled, and the tab case finds no extension row and no file row either, because every arrow stepped from `all`. Neither defect was reproduced on a real terminal, for the reason Decision 63 gives. The wizard's review rows still read the closure, and stay recorded under Follow-ups.

## Decision 65 — the approval dialog remembers the row its arrows landed on

ink keeps its own highlighted-mode state and seeds the list index from it, so coming back from the scope step restores the row the arrows last highlighted rather than the mode the config happens to hold. Here the list was seeded from the config every time the scope step closed, which put the cursor back on the current mode and quietly threw away the walk the arrows had made — a user who moved down two rows, checked the scope, and pressed Enter wrote the mode they had started on.

The dialog now keeps the highlighted mode the way ink does, takes it from the list's highlight callback, and seeds the list from it. The scope keeps its own key: the scope is what the trip changes, and the highlight is what survives it.

One case walks the mode list down a row, takes the scope step to Workspace and comes back, then asserts the cursor is on the row the arrows reached. Seeding from the config instead of from the highlight fails it. The case looked green under that mutation at first, and the reason is worth keeping: Enter on the scope step without moving the scope cursor writes the scope it already had, so the key the list re-syncs on never changes, the list is never re-seeded, and the cursor sits where the arrows left it under either version. Moving the scope cursor before Enter is what makes the case discriminate. A re-sync keyed on a value has to see that value actually change, and a case that exercises it has to change it.

## Decision 66 — the popup slot is ink's fixed, clipped region, and only ink's stretching dialogs fill it

ink does not overlay a popup on the composer: it swaps the composer out for a region of exactly `rows − staticExtraHeight − MAIN_CONTENT_HEIGHT_RESERVATION` rows, top-aligned and clipped, and every dialog is laid out inside that. The two constants are ink's — the first is the `3` its container passes for the rows the popup cannot use, the second the `2` its layout reserves for the main content — so the budget a forty-row terminal gives is thirty-five rows. The height and the clip are ink's default state, not its only one: both are gated on its `constrainHeight`, its show-more-lines key lifts them, and its dialog manager then hands the dialogs no height at all. This port has no lift — the region stays fixed in every state — and the difference is recorded under Follow-ups.

Here the slot was content-height. Two things followed, and they looked unrelated. A dialog ink stretches to fill the region stayed short and sat low, because the transcript kept the free rows above the slot and a content-height box lands after them; the approval-mode dialog drew thirteen rows where ink draws thirty-five, with its footer hint just under the list rather than at the bottom of the viewport. And a picker taller than the region pushed the composer off the screen instead of being clipped by it.

The shell now computes the budget once, from the terminal height it already owns, and gives the slot that height with `overflow="hidden"` in a column. The same number goes to the dialogs as their available height, which is what ink's dialog manager hands them, so a list that sized its window to the full terminal no longer pushes its footer hint out of the clipped region. The shell's own prop for that height is gone: the shell reads the terminal size, so a caller-supplied height could only ever disagree with it, and the one call site that passed it was passing the raw height.

Only three of ink's dialogs stretch to the height they are given, and only the one that sits in this slot is reachable here, so only it fills. The shared frame grew a flag for it, wired to `flexGrow`, and the approval-mode dialog sets it. The flag is on the frame, so both of that dialog's branches draw their border across the whole region; what differs is the content inside. The mode branch alone wraps its content in a second growing box, which pushes the footer hint down to row thirty-eight, while the scope branch leaves its content at its own height, so its hint stays on row thirteen with the rows below it blank. Both placements match ink's row for row on the frames. The effort and output-style dialogs do not set the flag, because ink does not stretch them either. The flag is written as a ternary rather than a conditional prop for the reason Decision 11 gives: this renderer's setters ignore the `null` its reconciler passes for a removed prop, so a prop that appears and disappears leaves its old value on the node.

Two scenarios carry the evidence. A new one opens the approval-mode dialog and tabs to its scope step, because that dialog is the only one in the slot that ink stretches, so it tests both halves — the region's fixed height and the box filling it. On a hundred-column, forty-row terminal both legs draw the border from row six to row forty, the five modes on rows ten to fourteen and the hint on row thirty-eight; the one row that still differs in each of the two frames is the composer's, and it differs in the cursor artifact both legs' frames carry. The frame after Esc matches exactly. Two existing scenarios open the same dialog and give the before-and-after: the box occupied rows twenty-eight to forty, and now occupies rows six to forty, with the frames' differing rows down from twenty-seven to three. The editor dialog, which ink leaves content-height, moved from rows twenty-three to forty up to rows six to twenty-three and now matches ink too, with its unused rows blank below it.

## Decision 67 — a box that asks for a size has to ask to shrink as well

ink's `Box` always defaults `flexShrink` to 1. This renderer defaults it to 1 only when neither width nor height was set explicitly, and to 0 otherwise — so on a sized box, deleting a `flexShrink={0}` changes nothing at all. The first attempt at the picker fix did exactly that, and the frames came back byte-identical to the pre-fix run; reading both libraries' defaults is what found the divergence.

ink's session picker asks for `height − 1` and lets the fixed-height region press it down. This port asks for the same size, which under this renderer's rule also meant refusing the press, so a thirty-nine-row box started above a thirty-five-row region and squeezed the transcript into one garbled row. Both of its branches now ask for the shrink explicitly.

The list branch also loses a top margin ink's picker does not have, and the preview branch loses the one ink's preview tree does not have — ink returns that tree straight into the region, with no margin, no size and no clipping of its own, so its title starts on the region's first row. Two structural cases pin the pair: one asserts the list box asks for a thirty-nine-row height, the shrink and the clipping, the other asserts the same of the preview and that no margin survives on it. Dropping the shrink fails the first; putting either the margin or the shrink back fails the second, on its own clause each time.

On the real terminal the picker scenario's eight list frames came down from eight differing rows each — twelve on the two that carry the multi-select footer — to three and six. What is left is the banner's row-count difference, the cursor artifact both legs' frames carry, and, on the two footer frames, ink's own footer wrapping: ink loses the spaces between its three segments and breaks two of them internally, which is recorded as an ink-side defect rather than matched. The two frames taken after the picker closed match ink exactly, before and after. The preview frame could not be compared at all: ink's capture there is three non-blank rows with the picker gone, and it is still three rows after a longer settle, which is the benign divergence already recorded — so this branch rests on the source reading and the structural case, not on a frame.

## Decision 68 — the completion row's tail is truncated in proportion, because this renderer has no truncate wrap

ink sets `wrap="truncate-end"` on a completion row's argument hint and its source badge, inside the columns the label column leaves after the label. This renderer's text has three wrap modes — none, char and word — and none of them truncates, so an over-long hint wrapped onto a second row and doubled the row's height. The truncation moves into the row's own arithmetic.

The tail is split the way ink's own layout splits it, which is not the proportion one would write down first. Yoga measures each sibling against the column, so each shrinks from a basis already capped at the column's width rather than from its full text width — a 61-column hint inside a 39-column column shrinks from 39 — and the overflow divides between those two bases. Both resulting widths stay fractional, and ink's renderer floors the badge's start column, which lands the badge over the column where the hint drew its own ellipsis: with a badge present the hint survives as ceil(width − 1) plain columns and no ellipsis, and with no badge there is nothing to cover it, so the ellipsis is the hint's last column. The badge keeps ceil of its own share, ellipsis included. Handing the tail to the hint first and the badge whatever is left looks simpler and is wrong — the badge vanishes outright on exactly the rows that carry one, which are the `@` completions. Shrinking from the uncapped text width is wrong in the other direction: it hands the hint a larger share and eats two columns off the badge.

What ink does here was measured rather than inferred. Its own `SuggestionsDisplay`, rendered through ink-testing-library, gave the truncated row for 23 hint, badge and column combinations, and the arithmetic above reproduces all 23. Two of those combinations are pinned as jsdom cases, one with a hint alone and one with a hint and a badge together, and both were run against the pre-fix code, where the row wraps instead.

The row is on a real terminal too, because a shipped command does overflow the column. `/output-style` carries a 57-column hint, and the half-width cap sizes the column at 49 on a hundred-column terminal, so the completion scenario's dropdown has had this row in it all along: the basis caps at 49, the 12-column overflow leaves the hint a share of 37, and 37 columns of ` [Concise|Proactive|Explanatory|Lear…` is what both renderers draw. Before the fix this port wrapped it instead — `[Concise|Proactive|Explanatory|Learn` with `ing|<custom>|default]` on the row underneath — which pushed every row below it down one and left the checkpoint differing from ink on seven of its twenty content rows. After it, all twenty match byte for byte.

## Decision 69 — the wire-API step is the mirror call site Decision 64 missed

Decision 64 generalised the cursor mirror and moved the wizard's focus onto it. The step that picks between the Chat Completions and Responses wire APIs keeps a cursor of its own and was not among the call sites — it reached this tree from main after that pass — so its Enter still read the cursor off the render that armed the handler. An arrow and an Enter inside one stdin read saved the wire API the arrow had not reached.

It now takes the numeric half of the same mirror, and its Enter reads the ref. One case walks the wizard to that step, sends the arrow and the Enter inside a single handler invocation, and asserts the saved plan carries the Responses wire API; against the pre-fix code it saves Chat Completions.

## Decision 70 — the row budget pays for the rows a notice actually paints, and the Tab step sheds what ink's clip would have hidden

Decision 66 gave the approval-mode dialog ink's region height and ink's derivation for what fits inside it. Three things that derivation assumed were still wrong on this side, and a fourth step never got the derivation at all.

The row width. ink gives the mode labels, the title run and the footer hint `wrap="truncate"`, and its row constants count one physical row for each. This port rendered all three with the renderer's default word wrap and no width clip, so on a narrow terminal each took more rows than its constant budgets and the list slid out of the frame. Decision 68 already established that this renderer has no truncate wrap, so the clipping moves into the arithmetic the same way: a label gets the content width minus its row's two-column indicator and, when the list is numbered, the `N.` column and its space, the column sized from the list's length so a tenth row costs its label one more column; the title run `> Title ` is clipped to the content width and the dim subtitle then gets whatever that run left, which is how ink's single truncated Text composes the two; the footer hint gets the content width. The warning is not clipped, because ink wraps it.

The row count of a wrapped notice. ink budgets its workspace warning at a flat three rows. At a hundred columns the text — ninety-one columns of it inside a ninety-two-column content width — fits one wrapped row, so the flat count over-pays by one; at forty columns it needs three rows, so the flat count under-pays by one and the list paints over the last of them. The count is now derived: one margin row plus the rows the text occupies once word-wrapped at the content width, with a word wider than the row broken across rows. ink's flat three stays as the floor, because paying fewer rows than ink would put a mode row on screen that ink does not show, and the derivation only ever adds to it.

The trust-gate refusal. This port draws a refusal below the same list when the folder is untrusted or a write throws; ink has no counterpart in this dialog, so the budget carried no term for it, and the errorless budget has no slack at exactly the heights where the gate fires. The refusal takes the same derivation. Its term stays out of the `MIN_HEIGHT_*` thresholds, which are ink's.

The Tab step. It shares the frame and the region with the mode step but had no budget of its own, so it kept the spacer row the mode step had just shed and an unwindowed list. **This is a deliberate divergence.** ink's `ScopeSelector` keeps both and gets away with it because ink's frame carries `overflow="hidden"` and absorbs the overrun; at region heights four to six the same rows here overpaint each other, and Enter commits a scope the user could not read. The step now runs the same derivation and sheds the spacer and windows its list, where ink keeps them. The rows ink loses to its clip are rows nobody could read either way, but the divergence is recorded rather than matched, because matching it would mean giving this frame a clip it does not have. The footer hint reads the budget of the step on screen rather than the mode step's, so the two steps can disagree about it — at a region of eleven rows with the warning up, the mode step hides it and the scope step shows it — and a test walks that split.

Six cases pin the arithmetic, and each was run against the mutation that undoes it: dropping the label clip, the subtitle clip or the hint clip fails exactly the case that measures that run; replacing the warning's derivation with ink's flat three fails only the narrow-terminal case; charging the refusal nothing fails the trust-gate case; dropping either half of the Tab step's pass-through fails the Tab case; and taking the floor away fails the case that pins it. Two tables then walk the budget across six region heights without the warning and four with it, asserting the spacer, the footer hint, the arrows and the number of rendered rows at each, which is what pins both the spacer and the warning footer-hint thresholds and the guard that keeps the hint on screen when dropping it would only buy room for arrows. No new frames this round: the harness reads strings and declared layout props, and what changed is row arithmetic at widths the matrix's hundred-column arm does not reach.

## Decision 71 — the help overlay budgets from the region, and the frames beside it open flush and let the region clip

The popup slot is a fixed height that already accounts for the banner, the status
bar and the composer, so the ten rows the help overlay reserved for that same
chrome were reserved twice: the overlay left five blank rows inside the slot at
every terminal height, and windowed its command list at sixteen rows on a
forty-row terminal where ink shows a fixed eighteen. It now reads the region
budget the mount is already handed and subtracts only its own chrome, so the list
reaches ink's eighteen and the slot keeps no unused rows. The cap stays — the
window never exceeds the eighteen rows ink hard-codes, so past a thirty-seven-row
terminal the region outgrows the window and the rows below it stay blank, three of
them on a forty-row terminal — and at a region of fourteen rows or below the
overlay still cannot fit, which Follow-ups records.

The same pass also reaches the four sibling frames beside it — the memory,
statusline, stats and skills frames and the arena's — which each opened one row
below the region's top, so their bottom borders were measured painting past it.
They now open flush with it, and they stay unshrinkable: the renderer defaults an
unsized box to shrinkable, and a shrunk frame squeezes its text rows to zero
height and paints them over each other — measured on /stats and /statusline at
80×24 and on /skills at 100×20 — so each root box refuses the shrink explicitly
and lets the region's clip cut whatever does not fit, the way ink's stats dialog
clips. A structural test pins each frame's flush opening and its refusal to
shrink. The sized bodies inside the frames are not covered by this change;
Follow-ups records them.

## Coverage boundary

What was verified, and how far the verification reaches:

- **Geometry, row content, row order, row count and glyph identity**, on a
  reconstructed screen, for forty-four scenarios — thirty-nine at 100×40, the
  three transcript arms at 100×30, the narrow boot at 60×24 and the chip row at
  58×40 — one hundred thirty-three checkpoints in all, of which thirty-five match
  on their non-blank rows as captured. The comparison tool reports two more,
  because it also picks up the sampled sidecars two scenarios write beside their
  frames; those are timing dumps rather than screens and are counted apart. Of the
  ninety-eight that do not match, fifty-six carry the context-file notice among
  their differing rows: that row holds an absolute path under the harness's scratch
  directory, so it wraps at different points on the two legs and its continuation
  rows differ with it. Both legs from one bundle and one set of boot arguments.
- **Colour was read on three row families, in two terminal modes, and is unread
  elsewhere.** The reconstruction is text; colour comes from the styled capture
  beside it, which the harness writes for every checkpoint but the one taken
  after quit. Three families were read — Decision 32's cursor cell, and the
  banner wordmark and the banner panel's border. The two banner families were
  first read on different frames in different modes: the default-theme boot in
  truecolor, where only the wordmark diverged, and a named-theme boot in
  256-colour, where the border diverged too — that one is the two libraries'
  downconvert rules, recorded under Follow-ups, and the wordmark's is Decision 47. Both were then re-read in truecolor, on the default-theme boot frame and
  on a Dracula boot frame. Across the six wordmark rows of each, every one of
  the 221 cells ink paints with the ramp matches this port cell for cell, and
  the border emits the same source hex on both legs. The 25 cells per frame that
  still differ are all blank — ink emits no colour for them and this port leaves
  them at the renderer's own default, which is opaque white. That is the
  uncoloured-text divergence under Follow-ups, not a ramp difference, and it
  predates Decision 47. Every other row's colour is unread, and several rows are
  known to have differed only in which theme token they used before Decision 43.
- **The scrollbar costs the transcript no column.** Measured at a hundred
  columns with two answer rows of 95 and 96 characters: this renderer fills 99
  columns before it breaks a row where ink fills 98, so the one-column gap sits
  in the same direction as the wrap divergence already on the list rather than
  being a column the region takes away — and the row-length distribution over
  the whole corpus is identical on both sides of this change.
- **The composer's one-row gap is source-grounded, and frame-grounded only where
  the two frames line up.** On the overflow arm of Decision 26 the blank row
  above the composer is confirmed row for row against ink, because there the
  content fills the window on both legs. Elsewhere it is not separable in a frame
  comparison from where the reconstruction puts the block.
- **The quit warning's queued segment, and Decision 30's queue rows, are
  unit-tested only.** No scenario queues a message and then arms the warning.
  Nor does any scenario produce a durable queue at all: ink's badge survives only
  as a single transient of its own submit path in the raw stream, and never
  reaches a captured frame in either leg. A queue that outlives the turn needs
  the deferral ink puts behind Ctrl+Q; this renderer does not bind that key, and
  no scenario presses it on either leg — so the texts, like the badge, exist
  only inside one turn.
- **Decision 31's recorded row is verified on disk, not on screen.** The
  scenario that opens `/model` and escapes it was run on both legs and the two
  session logs compared record by record. No scenario resumed a session, so the
  replay of that row back onto the screen — through the shared loader this
  renderer's session switch calls — rests on source reading alone.
- **The non-shrinkable row prefix and the per-item top margin are verified by
  re-capture only.** The unit-test runtime stubs the renderer's graphics
  surface, so it cannot exercise layout; a test there could only echo the prop
  back.
- **Vertical spacing was outside the frame evidence until the last run.** The
  comparison reduces each frame to a sequence of non-blank rows, which made the
  gap between two items invisible to it, and every earlier capture in this
  sweep was compared that way. The margin above is therefore the first spacing
  claim in this document backed by frames, and it is backed by a separate
  measurement of the transcript region alone — total blank-row counts are not
  usable while the reconstruction puts ink's block at rows of its own choosing.
- **The blank rows around ink's banner are deliberately not reproduced.** Two
  facts were read directly. ink's captured stream begins with a carriage return
  and a newline immediately before the banner's first row. And ink appends
  exactly one newline to every batch of permanent output it writes — its own
  comment says the newline is there so the next frame does not overwrite the
  batch's last row. Blank rows therefore land wherever a batch boundary falls,
  which depends on how items happen to be grouped across renders rather than on
  any layout rule. Which of the two produces which row was not traced, and
  matching either would mean hardcoding a write-batching artifact.
- **Two structural divergences were recorded here as deliberate and have since
  been closed.** The banner was persistent in this renderer while ink scrolls it
  out of the viewport, and a dialog did not reflow the conversation, so rows that
  ink pushes out when a tall dialog opens stayed visible underneath it here. Both
  were inherited from the restore work rather than introduced by it. Decision 26
  removed the overlay model they both came from, and its frames are the evidence
  for the two closures.
- **The startup update-check notice belongs to the runtime, and what this
  document said about it before was wrong.** The notice appeared on every
  OpenTUI leg's frames and on no ink leg's — a divergence that belongs to either
  the renderer or the runtime until a control arm says which. One ran: ink under
  the same runtime as the OpenTUI leg reproduces the notice, so it leaves the
  renderer's column. The same run falsifies the explanation recorded here
  originally, that ink loses the soft warning to a subscription race and shows a
  later hard update failure instead; no arm of any run shows a hard failure at
  all. Why the check's own outcome differs between the two runtimes is not
  something this sweep chased. The harness now suppresses the update check on
  both legs, so the notice contributes no rows to the frame comparison.
- **One cosmetic divergence is recorded, not fixed.** The two renderers break a
  long row at different columns. ink's default wrap is a word wrap that hard
  breaks whatever still overflows and trims nothing, so a row fills to the edge
  and its continuation starts at the item's own indent; this renderer's text
  nodes break on word boundaries, which inside a path include its slashes and
  hyphens, so a token too long for the rest of the row moves to the next one and
  leaves the row short. The context-file list shows one face of it and a tool
  card's header and arguments row another: at a hundred columns the same
  arguments collapse to the same number of hidden characters on both legs and
  still cost this renderer one more physical row. Matching the break points would
  mean reimplementing the wrap algorithm the renderer already provides. What it
  did get is a measurement: across a 123-point width sweep of three wrapped
  paragraphs, the pinned renderer now breaks where ink breaks on 105 points
  against 90 at `@opentui` 0.5.8 — fifteen break positions gained, none lost.
  The eighteen that remain are all one paragraph, at widths where ink fills the
  row a column further. No whole-row verdict moved, because the rows carrying
  this also carry the popup width and the missing row numbers recorded
  elsewhere, so this divergence narrowed rather than closed. A wrapped
  header also loses the space between the tool's display name and its
  description, which a scenario raising the same header with the arguments row
  switched off reproduces unchanged — the control arm that keeps this last part
  separate from the row added above.
- **One last resort is deliberately not reproduced.** The kept-model
  announcement reads the runtime snapshot's identifier and falls back to the
  configured one, which is what ink does. ink then falls back a third time, to
  a hardcoded default model identifier, when the configured one reads empty.
  That cannot happen here, so the third tier is left out rather than importing
  a constant to cover an impossible case.
- **A replayed extension notice cannot carry its reason.** The latch this
  renderer replays from exposes no accessor for it, so a reload that failed
  before this renderer mounted is announced with the plain change wording
  rather than the failed one. Both wordings send the user to the same command,
  and recovering the reason would mean adding a public accessor to the shared
  state for a distinction with no different action behind it.
- **The approval release is unit-covered only.** No scenario parks a
  confirmation and then rotates the mode. The wiring is pinned by a test with
  its negative control — the intermediate mode that must release nothing — and
  the selection rule it consumes was already covered on its own.
- **Most burst cases are unit evidence only; the cursor class is not.** The
  acceptance harness writes one character per pty write on purpose, so a
  keystroke normally lands in a stdin read of its own, and it never pastes into a
  dialog input. Two scenarios now break that rule deliberately for the
  stale-cursor class: each writes three arrow keys, or two arrows and an Enter,
  in a single pty write, so the keys land in one stdin read and the handler that
  reads a closed-over cursor answers from the wrong row. Both legs are pinned
  frame by frame, on two different dialogs, and the second of them is a wrap case
  as well. What still rests on the unit suites and their mutations is everything
  else: the paste interleavings Decisions 37 and 39 describe, the retry counter's
  step guard, the answer lock and the sanitising spans of Decision 40 — none of
  which a single-channel pty write can produce.
- **ink's own auth-wizard suite fails locally, and this change is not shown to be
  why.** That file guards nineteen tests behind a check its own comment explains —
  simulated TUI input is unreliable on slow runners — and skips them on CI and on
  win32, so CI never runs them. Outside CI, thirteen of that family fail here, each
  at the suite's own five-second wait, all thirteen among the guarded ones. Six runs
  at this head gave five copies of that same set and one run twelve of its names, so
  the count moves with the machine while no failure lands outside the guarded
  family. A one-variable control says this round's edit to the shared
  provider-setup hook is not what does it: the same thirteen names failed, in the
  same list, with `packages/cli/src/ui/auth/useProviderSetupFlow.ts` — the one
  file that edit touches, and the one this suite reaches — restored to its
  `origin/main` version for the run, the tree verified byte-identical after it.
  What was not observed is a clean upstream checkout in this environment: a separate
  worktree stops at the workspace build prerequisite before any test runs, so "these
  fail there too" is inferred from the arms above rather than measured.
- **The thought toggle's keystroke is not covered at all.** The entry's own test
  replaces the keyboard hook with a no-op, so only the consumer half is
  asserted: the flag reaching the row and opening it. Nor is it frame-covered,
  because no scenario makes the model emit a thought — neither the new label nor
  the binding appears in any capture.
- **Only the thought half of ink's full-detail switch is bound.** ink's flag
  also untruncates every tool group; the tool cards here keep their row cap
  regardless of it.
- **A live thought's body streams here.** ink hides it until the thought is
  expanded. Recorded rather than changed: with no scenario producing a live
  thought, a change would be unverifiable in either direction.
- **The two settings Decision 48 wired are frame-verified in one scenario, at one
  size.** Both halves were read on the dedicated scenario's frames at 100×40
  against ink's: the clock row above the assistant row, and the settled card
  collapsed to its header with the expand hint. Not checked in a frame: any other
  viewport size, a resumed session — where the stamp comes from the recording
  rather than from the fold's clock — and the collapsed card's click affordance,
  which no scenario exercises, so it rests on the unit test that pins the hint's
  wording and the handler it names.
- **Which tools actually emit a structured payload mid-execution was not
  traced.** The consolidation makes every payload available on every path, live
  chunks included, so a shell result that reports an ANSI grid while it runs now
  renders in colour; whether any tool does so before it completes is a question
  about the tools, not about this renderer, and was not answered here.
- **The gated-server approval is frame-verified in one direction only.** A
  scenario drops a project server list into the work directory; both legs draw
  the same dialog at the same inset and the same width, and declining it lands on
  the same composer and footer row in both. Approving was not exercised, because
  it un-gates the server and reconnects, which would spawn the declared command.
  The approve and approve-all branches are therefore not covered by frames, and
  neither is the list of servers that approve-all prints — the scenario declares
  one server, so the branch that renders that list is never taken. What the
  branches do is the shared hook's own behaviour, unchanged here.
- **The arguments row is frame-verified for a call that needs approval, at one
  width.** The scenario turning the setting on parks a shell call, so its frames
  carry the row while the call is pending — with the single arrow that marks it —
  once the call settles, and in the untruncated state the toggle key reaches.
  Every other scenario leaves the setting at its default, so the row is absent
  from the rest of the matrix by construction. Not checked in a frame: a call
  whose description already prints the payload its arguments would repeat, which
  is the case the shared helper deduplicates, and asserted in a unit test with a
  positive control instead; and any width but a hundred columns.
- **ink's per-group height reservation is not ported.** ink subtracts two rows
  for every tool that will print an arguments row from the budget each result in
  that group is given, because the row is drawn outside the result budget. This
  renderer distributes no such budget: every card is handed the same per-item
  ceiling, derived from the viewport height, so there is nothing for the arguments
  rows to be subtracted from and they only add rows here. The two differ where ink
  would have squeezed a long result, and closing that gap means introducing a
  distribution this architecture never had.
- **Decisions 51 through 58 rest on their unit suites and mutations, not on a
  re-run of the frame matrix over the eight.** The cosmetic divergences behind
  Decisions 51, 53 and 56 — the editor dialog's rows and hint, the auth frame's
  corners and its missing no-recommendations branch, the footer's model segment —
  were read off reconstructed frames during the sweep, and the two gates behind
  Decisions 57 and 58, `ui.mouseTracking` and screen-reader mode, were each
  confirmed on a real terminal in both directions, as their entries record. The
  rest are source-verified against ink. A screen-reader session never reaches the
  OpenTUI leg at all, since Decision 58 keeps it on ink, so that path has no
  frame the matrix could compare.
- **The machine leg was re-run at this head over the whole matrix.** All
  eighty-eight runs finished and none errored, and they wrote two hundred
  sixty-six captures. The nine idle timeouts land on the same three ink legs as
  the run before it, in the same counts: four on the caret-edit arm, three on the
  auth wizard's model list, whose spinner never goes idle, and two on the
  multi-question arm. Thirty-five of the one hundred thirty-three checkpoints have
  identical non-blank content rows, and fifty-six of the ninety-eight that do not
  match carry the context-file notice among their differing rows.
- **The split that dropped the context-file notice is withdrawn.** It reported
  seventy-three checkpoints identical once the notice and the path fragments it
  wraps into were removed from both legs, but it does not reproduce from the frames
  it was taken from: removing exactly those rows leaves the tally where it was,
  because no checkpoint in that run differs only in the notice — the smallest
  whole-matrix difference there is twelve rows. The figure is dropped rather than
  carried forward, and the tally above is the only split this document now claims.
- **The whole matrix was run twice on the pre-merge tree, once with the change
  and once without, and every movement this pass claims is on the OpenTUI leg.**
  Both arms
  are eighty-eight runs and two hundred sixty-six captures with no errors, and the
  same nine idle timeouts on the same three ink legs in the same counts. Between
  the arms, two hundred fifteen captures are byte-identical and four differ only in
  a spinner glyph or a duration. Of the forty-seven that differ substantively, six
  are ink legs, and each of those moves only on a spinner phrase, a session id, a
  wall time or a wall-clock stamp — nothing on an ink leg moved for any other
  reason, which is what makes the remaining forty-one attributable to this pass.
  Scored by the size of the line diff against the ink leg at the same checkpoint —
  the rows only ink drew plus the rows only this port drew — thirty-six of the one
  hundred thirty-three OpenTUI checkpoints improved, ninety-seven did not move, and
  none got worse.
- **The tally above moves by one, and the reason it moves by only one is the
  cursor artifact.** Thirty-four checkpoints were identical before the change and
  thirty-five after; the one that crossed is the completion row of Decision 68.
  The other thirty-five improvements are real but stop short of exact, because the
  harness writes the pty cursor into the reconstructed frame beyond the terminal's
  last column, and that artifact lands on different rows in the two arms: before
  the change it fell on rows that already differed, and after it falls on two rows
  that otherwise match ink exactly. Counting the artifact as a difference makes
  eleven checkpoints look two rows worse than they were; stripping the trailing
  block glyphs before the comparison is what turns those eleven into the zero
  regressions reported above, and each of the eleven then keeps one differing row
  instead of three — the banner's row count, which the fixed region also cropped
  closer to ink's.
- **Those two arms ran on the tree before it merged main; the after arm has been
  re-run on the tree after it.** The merge moved main into this branch, so its
  frames are not the ones the comparison above measured. Re-running the whole
  matrix on the merged tree yields the same eighty-eight legs, the same two
  hundred sixty-six captures, the same two empty ones, the same nine idle
  timeouts on the same three ink legs, and a verdict for every one of the one
  hundred thirty-five checkpoints that matches the earlier after arm exactly —
  except the timed spinner sample, which counts phrases and so moves between any
  two runs. The counts this section states therefore hold on the merged tree, not
  only on the one the two arms were cut from.
- **Decisions 62 through 65 have no frame behind them.** The palette revision,
  the two mirror reads and the approval dialog's remembered row were all read off
  the source against ink's, pinned by a unit case each and shown to discriminate
  by mutation. None of the four is reachable from a captured frame: the burst
  needs a paste or a held arrow inside one stdin read, which the harness cannot
  type, and the theme repaint needs a selection made mid-session. The footer's
  hint row is the same shape from the other side — it truncates segment by
  segment inside one line, which a case pins at forty-four columns, but the
  narrowest viewport the matrix runs is fifty-eight, so no frame shows a hint row
  that had to drop a segment.

## Follow-ups

- The scroll region answers the mouse wheel and no key — and stays a non-target for
  keys only because Decision 38 leaves it out of the focus chain, since a focused
  scroll region does take the keys nothing else was listening for. What scrolls ink's
  conversation is the terminal's own scrollback, and the alternate screen this
  renderer takes over has none, so the page keys that work there reach nothing
  here and a row above the fold comes back only by wheel. Binding those keys to
  the region's own offset is its own change.
- Every scroll region a dialog draws is still focusable, because that is the class
  default and only the transcript's was set aside. Whether a click inside a dialog's
  list can cost the open dialog a caret key the same way Decision 38 describes was
  not measured, and the code gives no reason to expect a gentler answer: the rows
  inside those five regions are hand-rolled and subscribe to no mouse event — only
  the shared select widget does — so a click there is unhandled, and the focus walk
  Decision 38 describes lands on the focusable region by the same route it took in
  the transcript. What one arm per dialog would settle is whether a focused dialog
  region then eats the dialog's own arrow and escape keys or only scrolls beside
  them. Worth that arm before this renderer's mouse handling is called done.
- The question dialog's option rows are hand-drawn, so a click no longer answers
  one and a hover no longer highlights it, while the outcome rows of the sibling
  confirmation types — still the shared select widget — do both. Giving a click a
  meaning on the chips, on the free-text row and on the submit and cancel rows is
  its own change, as Decision 21 says; until then the dialog answers keys alone.
- Two of the four `@` completion categories Decision 49 added are unit-tested
  only. The dedicated scenario's work directory holds files and prior sessions,
  so its frames draw those two tabs and their rows; it declares no MCP server and
  installs no extension, so neither of those tabs is ever drawn and neither label
  column is ever measured on screen.
- The shell-crawler diagnostics that print when the search binary is missing
  are now explained. The renderer library replaces the global console with a
  capture stream and folds console output into its own in-renderer console, so
  those warnings never reach the terminal; ink has no such interception and
  lets them land in the scrollback. The trigger is environmental — the search
  binary is only a shell alias on the test machine, so a spawned lookup fails.
  The diagnostics are not lost, but they are unreachable here because this
  renderer never binds the library's console toggle. Whether to expose that
  console is an open question.
- The help overlay's body budget comes from the popup region rather than the raw
  terminal height, so its command list windows at ink's fixed eighteen rows on a
  forty-row terminal instead of sixteen and, up to a thirty-seven-row terminal,
  leaves no unused rows in the slot — above it the eighteen-row cap leaves the
  extra region rows blank. At a region of fourteen rows or below the body still
  budgets fewer rows than the commands tab's own chrome needs, and the window's
  one-row floor then leaves the intro and the hint clipped under a live header
  and footer. ink has no counterpart to compare against: it never derives that
  window from the height.
- The two reserves that size the conversation around an expanded confirmation
  are hand-derived from a row inventory. The long-confirmation scenario shows
  the shipped value green and zero timing out, but a value four rows smaller
  passes there too, so what pins the numbers is the arithmetic in the unit
  tests — which asserts the constants' own sums rather than the screen. A change
  to the confirmation's geometry will therefore not fail on its own; re-deriving
  them belongs with that change.
- The loading indicator has no subagent token rollup and no tokens-per-second
  segment, both of which ink shows. Its elapsed counter also restarts after a
  parked call in the shell, for the reason Decision 28 records: the row is
  mounted twice in mutually exclusive branches, so the instance that accumulated
  the time is not the one that carries on. Carrying it across the swap means
  owning the accumulator above both mounts.
- The dark/light mode helpers have no production caller. Decision 42 wired the
  ink theme through, so the palette does follow the active theme now; these two
  helpers are a second path to the same destination that nothing chooses between,
  and the only code that reaches them is a test fixture resetting the palette.
  Either they gain a caller or they go.
- Two dialog list widgets remain where one would do; consolidating them touches
  numbering, colour and scroll arrows at once.
- A line-by-line comparison against ink's component and rendering source turned
  up gaps well past this change's scope. Dialogs that open read-only where ink's
  are actionable: trust, rewind, diff, subagent creation and listing, skills,
  hooks, the status line, memory, two of the stats tabs, and the extension
  manager's discover and source tabs. And the whole subagent and background-task
  surface — no live agent panel, no background-task dialog or footer pill, and no
  inline attribution of an approval a subagent asked for, so one arrives with
  nothing to say whose it is.
- Two of ink's authentication progress screens were reported as missing here on
  the grounds that a login could not be completed without them. That does not
  survive a reachability check, and they are not gaps. No provider in the
  registry declares the OAuth auth type, and the protocol picker offers four
  others, so the single write site for the pending auth type can never produce
  it; and the external-auth state those screens read is assigned null at both of
  its two write sites and never anything else. Both branches are unreachable in
  ink, so omitting them here is parity rather than absence — recorded so the
  omission is not re-reported.
- The footer has no right-hand segment. ink joins several indicators there with
  a pipe — sandbox, safe mode, debug mode, context percentage, and the goal and
  cron pills — and adds an MCP health pill, a worktree indicator, a workflow
  indicator and a skill-review warning. This renderer prints one left column.
- The status-line settings are ignored. ink renders up to two lines produced by
  a user-configured command, on its own refresh interval and with its own colour
  choice; this renderer hardcodes a directory, session, branch and model row.
- The composer advertises a queue key it does not bind. Decision 30 widened
  that: the ported hint row prints the key's name on screen, so the dead
  affordance is now visible rather than merely documented. Its exit key also arms
  the two-press window with a non-empty draft and eats a character doing it,
  where ink declines to arm at all while the buffer holds text.
- Most dialogs answer in a slot that does not persist. The arena select and
  stop dialogs, the editor dialog, the output-style dialog and the auth
  dialog's success report answer through the shell's notice slot, which the next
  submit clears; the effort dialog's pick says nothing at all. ink adds a
  transcript row for every one of those outcomes and records it, so a resumed
  session replays them and this one cannot. Closing them is Decision 31's shape
  twice over — the row has to be added as well as recorded, since a record with
  no row would replay a line the user never saw. `/statusline` is further
  behind: this renderer's statusline dialog only lists the presets and closes on
  Escape, so it has no save action to record — a missing feature rather than a
  missing record. ink's UI layer records at fifteen sites, thirteen of them
  outside the dispatcher's own invocation/result pair. Three of those thirteen
  need nothing here: the theme one carries only `/theme`'s `NO_COLOR` message,
  which this renderer already routes through the dispatcher's recording wrapper
  (a theme selection adds no row on either side), the arena command's recorder
  is shared code this renderer runs the same way, and the away-summary recorder
  now lives inside the hook this renderer mounts (Decision 55), so the recap it
  fires is recorded the same way ink's is and needs no site of its own here.
- An auxiliary model pick is a different kind of row. ink reports a fast, voice
  or vision selection as a success item — its own glyph and colour — while every
  model outcome here, primary or auxiliary, goes through one info row, so the
  pick reads plainer on screen and, since Decision 31 records the row that was
  shown, in the session log too. Reachable on this renderer: the dispatcher
  builds fast, voice and vision dialog requests. Fixing it means carrying a row
  type out of the selection helper instead of a message string.
- ink answers a typed free-text entry in its question dialog twice for one
  keystroke, because the dialog's key handler and the input widget it mounts
  both subscribe and the key layer has no focus stack to arbitrate between
  them. Each answer advances a tab, so on a multi-question dialog the question
  after the one being answered is skipped without ever being drawn, and the
  review tab reports it as unanswered. This was observed on a real run, not
  inferred. Decision 21 does not follow it, and fixing it in ink is out of
  scope for a sweep that measures itself against ink's behaviour as it stands;
  it is recorded here so the divergence between the two renderers is not
  re-reported as a porting gap.
- The stale-read class is closed for cursors and open for everything beside
  them. Decision 41 put the numeric cursors behind a ref mirror — the shared
  select hook and its exposed ref, the composer's completion rows, and each
  dialog's own tab, checked set and wizard menus — Decision 63 added the
  two handlers that claim had missed, the rewind restore-option cursor and the
  permissions dialog's two free-text fields, and Decision 64 added the auth
  wizard's model-step focus and the composer's `@` category tab, so no handler
  now answers from a row or a buffer the last render drew — the wizard's review
  rows excepted, which still read the closure and are recorded beside them. What
  still does is the same root cause
  over the state that gates a branch rather than feeding a submit: a dialog's
  view name, its step, its focused zone, its search query and its editor
  preference scope are all read from the render closure at the branches that
  gate on them. Read from the source across six dialogs, not reproduced on a
  machine. The trigger is narrower than the cursor class was: it needs two keys
  of different meaning — a Tab or an Escape and an Enter — inside one stdin
  read, and ink's isomorphic code reads its own render closure the same way, so
  single-key behaviour matches. Closing it means rewriting each dialog's branch
  structure around a mirror rather than adding one beside a value, which is why
  it is recorded and not done; if it is done, per dialog, each site needs a
  batched-press case of its own, since a mutation that fails one dialog's gate
  proves nothing about another's.
- Decision 37's latch stops a field, not a step. The wizard's list steps and its
  review row still run one branch per key. The review row applied the plan twice
  for a burst of two Enters — two writer calls, read off a scratch test at this
  head — and the protocol and endpoint rows have the same shape read from the
  source: each of their selects advances a step, so a second Enter in the same
  read skips the step between. ink's steps are the same shape, so closing this is
  not a divergence to land ahead of ink's, and it belongs with the pass over the
  dialog branch structure described above, which the same one-action-per-read
  latch would cover.
- The latch stops keys, not a paste. Every field it settles also subscribes to the
  renderer's paste event, and that subscription never consults the latch: a read
  carrying the Enter that moves the wizard and then a bracketed paste would let
  the pasted text write into the step the burst left. The other order — a paste
  and the Enter that submits it — is what a terminal actually sends and is pinned
  by a test; this one needs a second input channel to land inside the same read,
  and no leg of the harness pastes into a dialog. It joins the widget pass above,
  where the same guard belongs on every field.
- A settled card keeps the position it was created at, where ink commits it to
  permanent history after whatever notices arrived meanwhile, so a notice
  printed during a tool call lands after the card here and before it there.
  This item also recorded an arguments row missing from the card and a pending
  indicator drawn on every card rather than the one call awaiting approval;
  Decision 25 closed both, and the empty-card reading of a disabled-tool error
  went with the first.
- With two calls awaiting approval at once, the confirmation sits in a different
  place. ink puts it directly below the row of the call it belongs to, so the
  screen reads card, confirmation, card; here the conversation keeps both cards
  in their order and the confirmation follows them. The difference is that one
  row moving, on top of the three each side already loses to the wrap break at
  the same checkpoint. Decision 22 fixed what the inline confirmation draws;
  this is where it is mounted, which is a separate change.
- The question dialog's chip row clips two columns later here than in ink.
  Decision 21 charges it against the box this row is drawn in, and that box is
  two columns wider than ink's, so over a band of terminal widths the headers
  print whole here where ink has already reached for the ellipsis — measured at
  fifty-eight columns with three twelve-cell headers, on both legs. Matching
  ink's number would clip text this row has room for.
- A dialog field ports the one-line slice of ink's buffer, not all of it. Four
  key families ink's text input binds are not ported: word jumps
  (ctrl/alt+←/→, alt+b/f), delete-word-right (alt+d, ctrl/alt+Delete), kill-line
  (ctrl+k/ctrl+u) and undo/redo (ctrl+z). The first three need only operations
  this model already holds, so they are one change over the line editor and its
  tests rather than a per-dialog one; undo/redo also needs a history the model
  does not keep, so it adds a store before it adds a binding. Two further ink
  bindings are absent on purpose rather than missing: clear-input (ctrl+C), a key
  the app-wide exit handler already acts on wherever a dialog owns the screen, and
  open-external-editor (ctrl+X), which nothing in this renderer binds.
- A dialog field's row windows its lines and not its columns. ink's field shows
  the line under the caret and, along it, the columns around the caret, so a
  value wider than the row scrolls sideways. This row hides the lines off the
  caret's and still draws all of its own columns, so a value longer than the row
  wraps it — whether the characters arrived typed or in one paste.
- A resumed session shows fewer rows than its log holds. This renderer's
  transcript adapter replays a slash command's invocation phase and nothing
  else, so a result-phase row — the model dialog's kept-model line of Decision
  31 among them — is recorded and then never drawn again, where ink's resume
  puts each of them back. That is wider than one dialog: closing it changes what
  every slash command leaves behind a resume, and no scenario of the acceptance
  matrix resumes a session at all.
- What a refused keystroke leaves on screen diverges, as Decision 32 says. The
  context-window field keeps digits only and this renderer prints the accepted
  value, so a letter — or the Space that step binds — vanishes without a trace,
  while ink's buffer owns its display and goes on showing what its own flow threw
  away. The quieter of the two was chosen on purpose; matching ink means moving the
  row onto the buffer, which is ink's defect to fix.
- The two app-wide handlers disagree about claiming their key. The thought-toggle
  handler marks the keystroke consumed; the exit handler for ctrl+C and ctrl+D
  does not, so those keys also reach whatever else is mounted in the same read.
  On ctrl+D nothing else acts — the shared line reducer hands it back unhandled.
  On ctrl+C the shell's five branches are exclusive — MCP approval, tool
  confirmation, modal, dialog, composer — so only the one on screen joins the exit
  handler in that read. The composer clears a non-empty buffer and claims the key
  when it does; the settings dialog resets the row it is on and does not claim it,
  so there one ctrl+C both resets that row and arms the exit window, and the next
  one quits. A rewind overlay binds the same key but no file in the renderer
  imports it. Giving the exit handler the claim the thought-toggle handler makes
  is its own change.
- Six further pins were measured by review as not holding. This pass re-ran all
  six and closed them, each against a mutation of its own. Deleting the shell's
  mount of the waiting row now fails two of the phrase tests Decision 28 names,
  where the indicator's own suite still renders it directly and saw nothing.
  Moving the queue rows below the composer fails the placement test, which orders
  the two against each other instead of only containing them together. The
  args-row placement assertion no longer compares against a string its fixture
  never renders, and moving that row above the header fails it. The
  arguments-row wiring, and the queued-call id the shell hands down beside it,
  are read off the tree the entry point renders, so deleting either fails the
  case that mounts it. A paste arriving while the cursor is on an option row has
  a case of its own, and dropping the guard that refuses it fails that one. The
  two branches that carried no test at all — the model dialog's custom-ID caret
  and the line-join branch of delete-word-left — each have one now, failing when
  that caret is pinned to the value's start and when the join is taken out. One
  shape ran through all six: the assertion read what was rendered, so a change
  that rendered the same thing survived, and each closing was to assert the
  placement, the wiring or the state instead of the picture. A seventh item the
  same review raised was re-run and closed: the pending-card case had been
  retuned to a height where
  the viewport reserve and the description floor are the same five rows, so its
  probe passed with the floor deleted. It now pins both heights, and deleting the
  floor fails it.
- The question dialog's answer window is anchored at the head of the value, so
  past the window the caret cell is not drawn and keystrokes move nothing on
  screen while Enter still submits the whole value, and the truncation marker
  counts as a cell the caret can sit on. ink's field scrolls to the caret on the
  width axis, as Decision 32's rule has this port doing on the newline axis.
  Following the caret here means deriving the caret from the pre-truncation line
  and a window offset rather than from the truncated string, which is its own
  change with its own tests.
- The question dialog bounds what the user types and nothing else. The question
  text, each option label and each option description are model-authored and
  render with neither a width nor a row bound, so a long question or long
  descriptions grow the dialog past the terminal height and push the options
  still to be picked off the screen with no user input involved — the outcome
  Decision 39's bound exists to prevent, reachable from a payload it does not
  cover.
- Text this renderer draws with no colour of its own still carries an explicit
  foreground, where ink's carries none, and the reach is wider than blank cells.
  Read off styled captures of the same boot frame on both legs: the blank cells
  either side of the banner logo are emitted by ink with the foreground left
  unset, so the terminal's own default paints them, and by this renderer with an
  explicit white. That part is invisible as things stand — the cells are spaces
  and the background is unset on both sides — but it is not the same instruction,
  and it would show on any terminal whose default foreground is not white the
  moment a selection or an inverse run covers one of those cells. The visible
  part is a whole row class: the extension-refresh notice on that same frame is
  emitted by ink with no foreground on any of its cells and by this renderer in
  its dim token. ink's comes out unset because that theme takes its primary from
  the dark base tokens, whose foreground is the empty string, and an empty colour
  emits no instruction at all, so on a terminal whose default is lighter than the
  dim token that row reads darker here. Closing it means a way to say "no colour"
  to the renderer, which the element's foreground prop does not offer.
- One palette key carries two jobs, which is why the foreground above cannot
  simply be left unset. The mapping's `text` is both the colour this port paints
  its own plain text with and the anchor for the markdown syntax `default` token,
  and the theme booted here leaves ink's primary empty, so the mapping falls back
  to the theme's hljs foreground to keep both alive. Honouring ink's "no colour"
  for plain text means splitting the two roles first; until then this renderer
  names a foreground for unstyled markdown that ink leaves to the terminal.
- The no-colour theme is not honoured. ink reaches it by setting every colour in
  the set to the empty string; this renderer's mapping preserves those empty
  strings, and its theme application then filters them all out, so the palette
  keeps the built-in dark surface it was initialised with and paints a full
  colour scheme where ink paints none. The filter is right — an empty string
  means "unset", and assigning one would degrade to a colour the renderer
  guesses at — so what is missing is a branch that recognises the theme as a
  whole being empty and drops the surface with it.
- A hex colour is downconverted to a 256-colour palette index by different rules
  on the two sides. Measured, not inferred: the banner panel's border under a
  named theme, in a 256-colour capture, lands on palette index 103 under ink and
  61 here. The same border on the default-theme boot frame, in a truecolor
  capture, carries an identical source hex on both legs — so the two sides start
  from the same colour and part company in the conversion. ink's index is exactly
  what the round-each-channel-to-six-levels formula gives for that hex; this
  renderer's conversion happens inside the renderer library's native layer, which
  is not readable from the JavaScript bundle, so its rule was not established —
  only its output. Nothing in this port chooses the index, so there is no site to
  fix; a change would have to come from the library. Recorded because it is the
  one measured colour divergence that survives every fix in this round, and
  because it will be re-found by anyone who compares the two legs on a terminal
  that is not truecolor.
- The auto-theme module this renderer carries has no caller. Only its own test
  imports it; the theme reaches the port through the ink theme manager, which
  resolves the light/dark probe on its own side of the boundary. Either it gains
  a caller or it goes, and the same question covers the dark/light mode helpers
  recorded above.
- The two markdown implementations break a line in different places, and put a
  list item's bullet in different columns. Both were measured on one body
  rendered through each. The width is not the cause: an unbroken run inside the
  thought body's box breaks at ninety-four columns here, which is the width
  ink's own body is given. A body of four-character words then fills eighty-nine
  of those ninety-four columns here and ninety-four under ink, and a body of
  one-character words fills ninety-three here where ninety-four would fit — both
  consistent with this side counting the space after a line's last word against
  the line, though that rule was inferred from the measurements rather than read
  out of the renderer. ink's own four lines do not follow one rule that was
  established here: they hold nineteen words at the fourth column, eighteen at
  the fifth, nineteen at the fourth and four at the fifth. Separately, ink draws
  a list item's bullet at the fifth column of the same body where this side
  draws it at the fourth. Both divergences belong to the two markdown renderers
  rather than to this port and neither has a site here to fix. Recorded because
  Decision 45 moved the thought body onto markdown, so this is where they show,
  and because any other body this port renders as markdown carries them too.
- A single unbreakable token wraps at a different column on each side, and this is
  the one divergence that touches almost every frame the matrix captures. The
  context-file notice names a path with no space in it, so the whole path is one
  token. ink moves the token to a row of its own and then hard-breaks it at
  ninety-eight columns; this port fills the row the token started on and breaks
  at whatever column that leaves — ninety-five on the frame that was measured.
  Both are defensible and neither is a width constant that can be copied across,
  because the two sides disagree about whether a token too long for the remaining
  row is moved or broken in place. It is recorded rather than fixed for the same
  reason the markdown wrap above is: the rule lives in the layout, not in a
  number this port chooses.
- The renderer does not repaint a cell whose new content is a space. Measured on
  ten frames, and it does not heal: the session picker's nine checkpoints and the
  preview scenario's one all carry the extension-refresh notice with box-drawing
  glyphs standing in six of its spaces — the glyphs of the banner row that sat
  there before the picker pushed it off the top. The same notice renders clean on
  the frames where the row it lands on was blank first, and the picker's own box
  on the same frame is clean throughout, so this is not a failure to clear the
  screen; it is a differential write that skips blank cells on the assumption the
  cell underneath is already blank. That assumption holds only while the
  renderer's own buffer agrees with the terminal's, and a scroll that moves rows
  up breaks the agreement for the row that was displaced. The write happens in
  the renderer library's native layer, so there is no site here to fix; recorded
  because it is visible garbage on a real terminal, and because a workaround
  would have to force a full repaint whenever the viewport scrolls.
- ink's popup region is gated on its `constrainHeight`: the show-more-lines
  key lifts both the fixed height and the clip, and its dialog manager then
  hands the dialogs no budget at all. This port maps that key only inside the
  tool-confirmation bodies, so the region keeps one fixed height in every
  state. The clip that goes with that height is not the same guarantee: it
  reaches content that shrinks with the region, while a child that holds its
  own size paints past the region's bottom edge rather than being cut, and its
  border lands off the terminal's last row or over the row below when one
  exists. Either way a tail the region cannot show — an unwindowed list such as
  `/mcp` on a short terminal, footer hint included, or the settings dialog's
  eight-item list, which receives the budget and reads no height at all — has no
  reveal path.
  Recorded rather than matched: this renderer owns the whole viewport and
  cannot let content grow past it, so the fix is windowing those lists from the
  region budget, the way the theme and model dialogs already do.
- The MCP approval, shell gate and action confirmation still render outside
  the dialog region, sized to their content and unclipped, where ink draws its
  ShellConfirmationDialog and ConsentPrompt inside the same region, stretched
  and clipped — capping the command preview and printing "shell commands
  hidden - resize terminal to review". A custom command that requests more
  shell commands than the viewport holds still grows the confirmation box past
  the last row on a short terminal, hiding the outcome rows and the footer
  hint the user is being asked to act on. Recorded rather than fixed: moving
  the confirmations into the region is Decision 66's layout decision applied
  to a slot whose body reads the terminal width to estimate line wrapping.
- The chip row on a narrow terminal clips each chip's label to an ellipsis under
  ink and prints the labels whole here, which costs the gaps between them. It was
  not compared against ink's truncation site, so whether the budget is a shared
  constant or its own is not established. It is the same shape as the completion
  row's argument hint, which Decision 68 closed.
- The gated-server dialog's body paragraph indents its continuation row by one
  column. Both legs agree on the first row of the paragraph and on the eighty-eight
  columns of text the row carries; only the row after a break gains a leading space
  here. It is the same shape as the markdown divergences recorded above and may
  share their cause.
- ink loses the right-hand corner of the gated-server dialog's box. That dialog is
  indented one column further than ink's other dialogs, its top and bottom borders
  run to ninety-four dashes, and the closing corner is absent from the frame — the
  box does not close. The same border on the approval-mode and session-picker
  dialogs, at one column less indent, closes on both legs. This port draws a closed
  box one column narrower, so on this row the port is the one that is right, and
  the divergence is recorded rather than matched.
- ink is almost entirely absent at the session picker's preview checkpoint.
  Pressing the preview key unmounts the list, and the capture taken before the
  preview body is drawn holds three rows — the banner's last row, the notice and
  the command — with no list, no preview and no composer. Decision 67 added a
  second capture after a longer settle for this frame, and three seconds later it
  still held those three rows, so within what this harness can reach it is not one
  frame of transition: the picker does not come back. The next checkpoint is the
  list again, and this port draws the full preview body at both. The consequence
  is that the preview branch has no frame-level reference to compare against, so
  Decision 67's judgement on it rests on source reading and structural tests
  alone. Recorded so the empty frame is not re-reported as a porting gap, and not
  taken for a usable control either.
- The session picker's window is derived from the raw terminal height — seven
  reserved rows, three rows per item — while its box is sized by the fixed
  region, so on a short terminal the window's last rows, and the down-scroll
  marker on them, are clipped and the cursor can reach a session that was never
  drawn. ink's picker derives the identical window from the same raw rows inside
  an equally fixed and clipped region, so this is parity with an ink-side
  limitation, recorded the way Decision 67 records ink's footer wrapping rather
  than fixed on one leg.
- The stats dialog carries its own copy of the ref mirror rather than calling the
  shared hook, and rebuilds its writer on every render. Both are cosmetic: the copy
  performs the same double write, and nothing memoises on the writer's identity. It
  belongs with the consolidation of the two dialog list widgets rather than landing
  on its own.
- The dialog chrome declares a close handler it never reads. Every caller that
  needs to close does it from its own key handler, so the prop is a dead affordance
  in the type and not on screen. That chrome's test pins the rounded outline and
  the title's colour and weight, but not the square outline the auth dialog asks
  for, so a change to the one border style that differs would pass.
- Three branches have a shape no run reaches. The composer's unfocused border
  colour is exercised by a test alone, since the single production mount leaves the
  flag at its default. The footer's approval-mode colour dims a mode the enum does
  not declare where ink leaves the label uncoloured, and the enum is closed, so
  neither arm runs. The shared list walk types its rows as unknown and reads the
  disabled flag through a cast, because the row shapes differ per caller and a
  declared flag would trip weak-type detection on every caller that never sets it.
- The banner gradient counts code points where the library ink renders through
  counts UTF-16 units, so a logo row holding a surrogate pair would ramp one step
  differently. The bundled logo holds none — it is box-drawing characters, all
  inside the basic plane — but the banner also accepts a custom one, so an emoji in
  a user's logo would colour differently on the two sides.
- The clock label above an assistant row exists twice. This port calls the shared
  formatter Decision 48 added; ink's display component still formats the same
  24-hour bracketed time inline, with an identical locale call. Pointing ink at the
  shared one would edit the very file the frame evidence was captured against, so
  the second copy stays and the two are only kept equal by hand.
- Three sized bodies inside the dialog frames still hold their own height: the
  diff dialog's fourteen-row scroll region, the subagents dialog's twelve-row
  one, and the skills dialog's twelve-row one. The first two sit in the shared
  dialog chrome, which shrinks with the region, and a frame that shrinks around a
  body that does not overpaints its own bottom border — measured at a region of
  seventeen rows and below for the fourteen-row body and of fifteen rows and
  below for the twelve-row one, where the last body row lands on the border,
  while the two region heights above each boundary are absorbed silently into the
  frame's inner spacing. Windowing those two heights from the region budget is
  the fix — it closes the overpaint and the absorption band together — and the
  height has to be folded into the body's key the way the session picker folds
  its own, because the renderer clears the shrink on an explicitly sized node and
  never re-applies a prop whose value did not change. The skills body needs no
  such windowing: its frame keeps its natural height and the region clips it, the
  way ink clips /stats.
- Decision 68's shrink emulation still sits inline in the completion row's map
  body, so the twenty-three measured combinations cannot live in the repo as a
  test, and two of the four numbers the arithmetic reads — the non-shared column
  budget and the dropdown's side margins — can move with the suite green. Lifting
  it into an exported pure function beside the truncation helpers and table-driving
  the combinations against it is the fix.
- Nothing executable verifies that the renderer resolves the shrink the session
  picker's remount depends on: its three tests read declared props through the
  element mock. A real-reconciler case cannot run under the unit suite, where the
  native layer throws, so the vehicle is a bun script under the package's scripts
  directory, wired into the component-parity runner.
