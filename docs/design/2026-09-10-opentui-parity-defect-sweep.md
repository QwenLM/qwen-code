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
rather than at the same wall-clock moment. Twenty-two scenarios cover boot, a
narrow terminal, typing and completion, `@` completion, mid-stream indicators,
a tool run under auto-approval, a tool confirmation, the slash dialogs, the
approval-mode cycle, the auto-mode boot notice, an error path, a resize, clear
and exit, a long hold that cycles the loading phrases, a to-do card, the
question dialog on its own, the same dialog across three questions with a
multi-select and a typed answer, the release of a parked confirmation when the
approval mode changes, the approval of a gated server at startup, a tool call
whose arguments are long enough to be capped, a control arm that repeats that
call with the arguments row switched off, and an answer long enough to overflow
the terminal.

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
than reimplemented, fed the width a confirmation actually gets — the terminal
minus the four columns the transcript item spends, minus the two the
confirmation spends inside it — and then reduced by every cell the row spends
outside the header text: the padding, the active-tab marker, the submit chip,
one gap per chip, two columns of prefix per header, and two more for each
answered mark. It is recomputed on every render, because answering changes the
marks.

One divergence is deliberate. ink answers a typed free-text entry twice for one
keystroke — the dialog's own key handler and the input widget it mounts both
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

Eight checkpoints were compared. Every dialog row matches ink line for line and
indent for indent, including the mark appearing on a chip as soon as its
free-text box is checked and before anything is committed, the comma-and-space
join of a multi-select answer with the typed entry counted into it, and the
review tab's own hint, which drops the cancel clause exactly where ink drops
it. The residuals are the three recorded elsewhere — where a long path wraps,
which phase the loading spinner happens to be in, and the update notice this
renderer words differently — plus vertical anchoring.

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
renders nothing, and the captured frames agree on both halves.

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

## Coverage boundary

What was verified, and how far the verification reaches:

- **Geometry, row content, row order, row count and glyph identity**, on a
  reconstructed screen, for twenty-two scenarios at 100×40 and, for the narrow
  and resize scenarios, at 60×24. Both legs from one bundle and one set of
  boot arguments.
- **Colour was not verified.** The reconstruction is text. Several rows are
  known to differ only in which theme token they use, and a styled capture
  exists that could settle it but was not read.
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
- **The quit warning's queued segment is unit-tested only.** No scenario
  queues a message and then arms the warning. Nor does any scenario produce a
  durable queue at all: ink's badge survives only as a single transient of its
  own submit path in the raw stream, and never reaches a captured frame in
  either leg.
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
  usable while the two renderers anchor differently.
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
- **One divergence is intentional.** The update check reports a skipped check
  with its reason here, while ink reports a failed automatic update. Both
  renderers share the emission path; ink's subscriber is registered after the
  background task emits, so ink loses the soft warning and shows the later
  hard failure instead. Removing a legitimate warning to match a subscription
  race is not what aligning to ink means, so the warning stays.
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

- The scroll region answers the mouse wheel and no key. What scrolls ink's
  conversation is the terminal's own scrollback, and the alternate screen this
  renderer takes over has none, so the page keys that work there reach nothing
  here and a row above the fold comes back only by wheel. Binding those keys to
  the region's own offset is its own change.
- The `@` completion here asks only the file index. ink also completes
  sessions, MCP resources and extensions, and draws a category bar to switch
  between them. That is a feature gap rather than a parity defect and belongs
  in its own change.
- The mid-turn queue is counted here but never shown. Its length reaches the
  footer badge and the composer's up key at the top edge pops it back for
  editing, but ink also lists the queued texts above the composer — three at a
  time, each collapsed to one line, with an overflow row and a hint shown for
  the first few times the queue fills. Porting that needs a non-destructive
  snapshot of the queue, which today can only be read by draining it.
- The shell-crawler diagnostics that print when the search binary is missing
  are now explained. The renderer library replaces the global console with a
  capture stream and folds console output into its own in-renderer console, so
  those warnings never reach the terminal; ink has no such interception and
  lets them land in the scrollback. The trigger is environmental — the search
  binary is only a shell alias on the test machine, so a spawned lookup fails.
  The diagnostics are not lost, but they are unreachable here because this
  renderer never binds the library's console toggle. Whether to expose that
  console is an open question.
- The shell card keeps the whole output where ink shortens it. Both renderers
  write the same raw string to the model's history, but ink compacts the copy
  it puts on screen once that copy passes a retention limit. No scenario here
  produces output that long, so the gap is reasoned rather than observed, and
  closing it also raises whether the intermediate streaming snapshots should
  exist at all — ink discards shell progress instead of showing it.
- The help dialog's reserved-row constant does not describe the rows actually
  observed on screen, and the window height this renderer shows below a 42-row
  terminal is bounded rather than matched.
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
- The composer advertises a queue key it does not bind. Its exit key also arms
  the two-press window with a non-empty draft and eats a character doing it,
  where ink declines to arm at all while the buffer holds text.
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
- A settled card keeps the position it was created at, where ink commits it to
  permanent history after whatever notices arrived meanwhile, so a notice
  printed during a tool call lands after the card here and before it there.
  This item also recorded an arguments row missing from the card and a pending
  indicator drawn on every card rather than the one call awaiting approval;
  Decision 25 closed both, and the empty-card reading of a disabled-tool error
  went with the first.
