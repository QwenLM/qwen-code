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
rather than at the same wall-clock moment. Twenty-six scenarios cover boot, a
narrow terminal, typing and completion, `@` completion, mid-stream indicators,
a tool run under auto-approval, a tool confirmation, the slash dialogs, the
approval-mode cycle, the auto-mode boot notice, an error path, a resize, clear
and exit, a long hold that cycles the loading phrases, a to-do card, the
question dialog on its own, the same dialog across three questions with a
multi-select and a typed answer, that dialog's free-text row corrected in the
middle of a typed value, the release of a parked confirmation when the
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
were surveyed rather than changed. No renderer-level test was added: the
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

Two residuals are recorded rather than chased. ink's box has no right border —
its own margin pushes a full-width box one column past what its parent can print
and the right edge is clipped, which is an overflow artifact rather than a
choice, and every popup here draws a closed box. And one wrapped continuation
line in the body carries an extra leading space here, which is the break-rule
difference already recorded for the context-file list; matching it would mean
reimplementing the wrap the renderer already provides.

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
aborts, the pop for editing, and the transcript reset that backs `/clear`,
resume and branch. That last one is why the rows shed with a cleared screen
instead of outliving it.

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
component rows
fail their own and no other; the mirror sites do not map one to one, because a
list never given its first entry, or never emptied, is still being asserted
turns later: draining without mirroring fails one assertion, pushing without it
fails four, popping for editing two.

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

Both paths now cancel a pending swap first: the arrow because the keystroke is the
user's own answer to "which question am I on", the second answer because it
supersedes the swap the first one scheduled. This is one of the places where the
port deliberately does not match ink; the same 150 ms pause, the same clamping at
the last tab, and the same tick-before-swap are kept. ink's behaviour is recorded
as a defect of its own rather than reproduced, and the double-fire the acceptance
matrix had already watched on ink's leg is the same defect seen from outside.

Both paths are pinned in the confirmation dialog's suite, each by a mutation of
its own: a right arrow that lands during a pending pause keeps the question it
moved to, and removing that cancel fails this test alone; two answers inside one
pause leave exactly the swap the second one scheduled, in a test that predates
this round, and removing the cancel in the answer path fails that one alone. On a
machine the pause and the arrow were already covered by the matrix scenarios that
answer several questions; the cancellation itself was not observed there, since it
needs two keystrokes inside 150 ms.

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
indexes the value the field's owner acknowledged, not the one the keys typed: when
a keystroke reaches a field whose owner refuses it — a letter into the
context-window field, which keeps digits only — the accepted value has no character
at that position to hold a caret, so the cap at the shared prefix between the two
texts leaves the caret exactly where it was. Before that, each refused key moved
the caret one code point right, and the first backspace after a burst of them ate a
real character. Where the two texts are equal the rule reduces to the plain clamp,
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

Two tests and three mutations. The cell that dropped its character when the field
lost focus fails the new row test in the authentication suite; the resync that
calls the plain clamp where the shared-prefix cap belongs, and that cap reduced to
a length clamp, fail the context-window field's edit test and the new unit test of
the rule itself. Each mutation fails exactly the tests that own the behaviour it
takes away. The machine leg is unchanged here — a caret in a field the wizard
renders is still not reachable by any scenario, so the row's rendering rests on the
unit suites.

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
one read still leaves `abcdef` in the endpoint field. It is a per-render flag rather than
a per-mount one: the renderer installs a fresh handler per commit and a read cannot span
a commit, so the flag spans exactly one read, and a field whose submit was rejected — or
whose auth failed a step later — is editable again on the next render.

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

## Coverage boundary

What was verified, and how far the verification reaches:

- **Geometry, row content, row order, row count and glyph identity**, on a
  reconstructed screen, for twenty-six scenarios at 100×40 and, for the narrow
  and resize scenarios, at 60×24 — seventy-seven checkpoints in all, of which
  twenty-two match byte for byte. Both legs from one bundle and one set of
  boot arguments.
- **Colour was not verified, apart from one row family.** The reconstruction is
  text. Several rows are known to differ only in which theme token they use.
  A styled capture backs all but three of the seventy-seven checkpoints and was
  read for one family only — Decision 32's cursor cell — leaving the rest
  unread.
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
  mean reimplementing the wrap algorithm the renderer already provides. A wrapped
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
- **Every burst case is unit evidence only.** The acceptance harness writes one
  character per pty write on purpose, so a keystroke lands in a stdin read of its
  own, and it never pastes into a dialog input. Neither leg of the matrix can
  therefore produce the multi-key reads Decisions 33, 34 and 37 are about; those
  rest on the two dialog suites they added tests to, and on the mutations each of
  those decisions names in its own coverage paragraph, with no screen evidence
  behind any of them.
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
- **`output.showTimestamps` still has no reader here.** ink prints a dim clock
  row above the assistant row when the setting is on. Wiring it needs a
  timestamp on the shared item type, stamped where the item is created, and a
  second source on the resume path, which rebuilds the transcript from the
  recording rather than from live items. A live-only half would itself be a
  divergence — a resumed session would show no timestamps at all — so it is
  deferred whole rather than shipped partial.
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
- The `@` completion here asks only the file index. ink also completes
  sessions, MCP resources and extensions, and draws a category bar to switch
  between them. That is a feature gap rather than a parity defect and belongs
  in its own change.
- The shell-crawler diagnostics that print when the search binary is missing
  are now explained. The renderer library replaces the global console with a
  capture stream and folds console output into its own in-renderer console, so
  those warnings never reach the terminal; ink has no such interception and
  lets them land in the scrollback. The trigger is environmental — the search
  binary is only a shell alias on the test machine, so a spawned lookup fails.
  The diagnostics are not lost, but they are unreachable here because this
  renderer never binds the library's console toggle. Whether to expose that
  console is an open question.
- The help dialog's reserved-row constant does not describe the rows actually
  observed on screen, and the window height this renderer shows below a 42-row
  terminal is bounded rather than matched.
- The two reserves that size the conversation around an expanded confirmation
  are hand-derived from a row inventory. The long-confirmation scenario shows
  the shipped value green and zero timing out, but a value four rows smaller
  passes there too, so what pins the numbers is the arithmetic in the unit
  tests — which asserts the constants' own sums rather than the screen. A change
  to the confirmation's geometry will therefore not fail on its own; re-deriving
  them belongs with that change.
- The loading indicator has no subagent token rollup and no tokens-per-second
  segment, both of which ink shows.
- The theme mode helpers have no production caller, so this renderer always
  paints its dark palette.
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
  is shared code this renderer runs the same way, and the away-summary site
  sits in a hook only ink's own container mounts.
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
- The stale-cursor class is open everywhere except the two handlers Decision 33
  touched. Read from the source: the shared select hook, the arena dialog's model
  list, the composer's completion rows, and the auth wizard's four list steps plus
  its main and sub menus all answer from the row the last render drew. The mirror
  shape is already set by the question flow and the line editor, so this is one
  change over those widgets and their tests, not a per-dialog one — and each site
  needs its own burst case, since a mutation that fails the question dialog proves
  nothing about a list it does not touch.
- Decision 37's latch stops a field, not a step. The wizard's list steps and its
  review row still run one branch per key. The review row applied the plan twice
  for a burst of two Enters — two writer calls, read off a scratch test at this
  head — and the protocol and endpoint rows have the same shape read from the
  source: each of their selects advances a step, so a second Enter in the same
  read skips the step between. ink's steps are the same shape, so closing this is
  not a divergence to land ahead of ink's, and it belongs with the widget pass
  above, which the same one-action-per-read latch would cover.
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
