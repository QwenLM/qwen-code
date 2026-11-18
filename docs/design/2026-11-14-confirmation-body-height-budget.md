# Confirmation body height budget

[English](2026-11-14-confirmation-body-height-budget.md) | [简体中文](2026-11-14-confirmation-body-height-budget.zh-CN.md)

Status: implemented on branch `fix/confirmation-body-height-cap` (PR #17132).

## Problem

An inline tool confirmation stacks a body (diff, command, plan, prose prompt,
MCP label) above the question line and the approve / deny options. The pending
region is clipped at the bottom of the viewport, so when the body is taller
than the terminal the question line and every option fall below the fold: the
user sees body text and has no way to answer. This is the bug the PR fixes.

The first iteration of the fix wrapped the body in a capped,
`overflow="hidden"` box. Review showed that cap is correct in direction but
wrong in four ways, and that it introduces a new failure mode:

1. **The wrapper recomputes the budget at a different moment than the body
   branches do.** Options are spliced into the list and the auto-mode banner is
   folded into the body after the body branch has already sized itself, so the
   wrapper's re-evaluation charges the body for an option row twice and for a
   banner that is inside the very content it is clipping. With an approval
   classifier unavailable and a 12-row terminal, the exec command text
   disappeared entirely and left blank rows where it used to be.
2. **The compact cap is applied per body branch, never to the wrapper.** A
   confirmation hosted inside a compact subagent banner still receives the full
   terminal-sized budget, so the cap the compact path advertises does not hold.
3. **Clipping is silent and can be non-contiguous.** An Ink ancestor with
   `maxHeight` shrinks the wrapped rows that make up long content
   (`flexShrink` defaults to 1) instead of cutting the tail. A 30-URL block
   then shows a scattered sample of destinations with no hidden-lines marker,
   which is worse than a truncated prefix: it reads as the complete list.
4. **In the `info` type the prose prompt takes the whole budget.** The block
   listing the URLs that will be fetched is laid out after the prompt, so it is
   the first thing evicted — precisely the content that matters for the
   decision.

Together these make an approval that is not informed: a hook-referential prompt
that names no host can offer `Yes, allow once` while the authorized
destinations are invisible.

## Goals and scope

- The question line and the options are always on screen, for every
  confirmation type whose body this component sizes, at any terminal height
  that can hold the question and the options. Two arms sit outside that
  claim: `ask_user_question` returns its own dialog before any budget is
  taken, and the body grant floors at one row, so a height shorter than the
  chrome plus that row yields a frame taller than the grant.
- A body is sized from one budget, computed once, and the ceiling of the outer
  cap is that number plus the measured auto-mode banner.
- Any truncation shows a contiguous block — a prefix, or for a list whose last
  entry is the one that matters a suffix — and says how much is hidden.
- The destination list in a fetch-style confirmation outranks the prose that
  accompanies it, and a clipped destination list can never look complete.
- There is a discoverable way to read the whole body without answering.

Out of scope: changing confirmation options, the approval classifier, the
shell-level pending-region clamp in `MainContent.tsx`, and the
`o`-opens-full-plan-in-editor affordance, which already exists (#7001).

## Design

### One budget, taken once per body

`availableBodyContentHeight()` is the single source of truth for how many rows
a body may occupy. Each type branch resolves that number **before** the option
list is spliced and before the auto-mode banner is folded into the body, and
stores it. The outer cap then reuses it instead of calling
`availableBodyContentHeight()` again:

```tsx
maxHeight={
  bodyBudget === undefined ? undefined : bodyBudget + autoModeFallbackHeight
}
```

The auto-mode banner is content that the type branches never accounted for, so
the outer cap adds its measured height instead of subtracting it. Both numbers
come from one hoisted measurement of the banner, so the banner is counted
exactly once: reserved in the per-type budgets that subtract
`autoModeFallbackHeight`, added back by the outer cap.

### The compact cap belongs to the shared budget

`COMPACT_BODY_MAX_LINES` is applied through one helper that every type branch
calls as it takes its budget, so no branch can receive a larger ceiling than
another. The outer cap does not clamp again: its ceiling is
`bodyBudget + autoModeFallbackHeight`, and `bodyBudget` is already the clamped
number, so the wrapper only adds the banner the branches never accounted for.
An undefined grant is left alone — no height means full-detail mode, and
clamping it would hide rows no shortcut can bring back.

### Truncation is contiguous and counted

Content that is cut must be pinned first. Ink rows with `flexShrink: 0` keep
their natural height, so the cap cuts the tail instead of compressing a
scatter of rows. `MaxSizedBox` already does exactly this for its own rows and
renders the `... last N lines hidden ...` footer, and anything routed through
it inherits both — but only for a box told to cut at the bottom, because the
default hides the head and prints `... first N line(s) hidden ...`. Which end
a box keeps is a decision about the content rather than a house default; the
ordering section below says which boxes keep their tail and which keep their
head.

Rows that `MaxSizedBox` cannot host stay pinned Ink rows and render their own
counted footer:

- The per-URL rows of a fetch-style confirmation contain inline-Markdown links,
  which `MaxSizedBox` skips — it only accepts `<Box>` rows whose descendants
  are `<Text>`, so a memoized inline renderer would silently drop the URL text.
  Those rows stay `<Box flexShrink={0}>` and get a hand-rendered
  `... N more URLs hidden ...` row.
- A plain-text prompt keeps its `MaxSizedBox`, which already pins its rows and
  counts what it hides.

### Destinations are reserved before prose

Inside the `info` branch, the destination block is costed before the prose
prompt is sized:

- Every destination renders when it fits: the test is the destinations plus
  their own chrome against the budget, not the prose floor, so the block is
  capped only when they do not all fit. The roomiest chrome tier that fits is
  the one taken — a tighter tier that also fits would hide a destination
  behind a footer row the budget did not need. The prose then gets the
  remainder.
- Otherwise the destination block is capped: one row for the `URLs to fetch:`
  header, one for the hidden-count footer, and the remaining rows are filled
  greedily with whole URLs so no destination is shown half-cut. The header is
  dropped before a destination is, in the order header, then blank separator,
  then nothing: a header above an empty list answers nothing, while a host is
  the thing being authorized. The footer survives to the last row because the
  count is the only signal that the list is longer than what is on screen. The
  prose keeps one row for its own hidden-count footer so its loss is still
  announced, and its block is skipped when the remainder is too small to hold a
  line it would have clipped anyway: below `MINIMUM_MAX_HEIGHT` (2) there is no
  room for content plus the row a clip spends announcing itself, whichever
  renderer the prose uses. Prose that already fits is never skipped on that
  floor: it renders no footer, so the floor does not apply to it. A block
  dropped whole hands its rows to a `... prompt hidden ...` notice while at
  least one row is free; when not even that row is left, the destinations keep
  it and the prose has no row to announce itself with — a prose footer would
  push the destination footer past the cap, and Ink would cut off the one that
  matters instead. The dropped prose registers the reveal in that case anyway:
  a frame in which the prompt simply vanished, with neither a prose footer nor
  a count of hidden destinations, is exactly the frame where nothing else would
  light the shortcut.

The trade-off is deliberate: at a body budget of roughly five rows or fewer,
the destinations outrank the explanation, and the prose may be gone. The
user still sees which hosts are being authorized and can reveal the rest.

### Which side keeps a row when they cannot all fit

The orderings below were chosen deliberately and are what the code does:

- Inside the fetch-style body, destinations outrank the prose that only
  describes the request. Inside the warning list, the last warning outranks the
  earlier ones, because a mode warning describes the request while the warning
  naming the exact action is the one that changes it; a warnings box that has
  to cut therefore asks for the head cut and keeps its tail.
- Where a warnings box and the branch's own subject (the diff, the command)
  share one capped grant, the subject keeps the row: it is the thing being
  authorised. The box is charged at what it actually draws — its wrapped rows
  while all of them fit, otherwise one row each — and whatever the split takes
  from it is counted on the row that survived, as `+N warning(s) hidden` once
  the subject is down to its single row. A warnings box dropped with no row of
  its own registers the reveal, so the rows it lost can still be had back. The
  subject never loses its last row to the split either: with two rows it lays
  out through a box, with one row it renders the notice that counts what it
  dropped.
- An MCP identity row carries two labels and neither half is dispensable — the
  server says where the call goes, the tool says what it does — so at a
  one-row grant each label is cut inside itself and the row registers that a
  cut happened, rather than letting the joined line decide by overflowing.
- In a plan body the editor hint is the way out of a clipped plan, so it is
  charged a row only when the plan is clipped. At a grant that fits one of the
  two, the plan keeps the row, and the view's two-row floor does not by itself
  drop a plan that needs no more rows than the grant holds: dropping it would
  hide the thing being approved behind a cue the cap cuts away anyway.
- The destination block's chrome is what gets handed back under pressure —
  blank separator, then label — and the counted footer is the last thing
  standing, because the count is the only signal that the list continues.

### Reading the whole body

The reveal already exists and is shared rather than per-type: `ctrl-s`
(`Command.SHOW_MORE_LINES`) clears `constrainHeight`, which makes every height
budget in this component `undefined`, and `MainContent.tsx` drops its own
pending-region clamp once streaming has settled to a static confirmation, so
the full body renders into the terminal scrollback and stays interactive
(#6809). The shortcut reaches the global handler even while the confirmation
owns the keyboard.

What was missing is discoverability: the `Press ctrl-s to show more lines`
hint only appears when something has registered an overflow, and the bodies
that this component truncates registered nothing. Now every truncation this
component performs itself registers an overflow id for as long as it is on
screen, which turns the hint on at the moment it is useful. Each truncating
body also says what it hid, so the affordance is discoverable even in the frame
where the content disappears.

The shortcut is not unconditional, and the hint does not know that. The global
handler clears `constrainHeight`, which lifts every budget here, only while the
prompt buffer is empty; with a draft typed, the same key is the input's stash
binding — it moves the draft out and leaves the cap bound. Key dispatch is a
broadcast that ignores return values, so both handlers fire and the rows stay
hidden. Making the reveal win while a confirmation owns the keyboard would mean
out-prioritising an intentional feature, so this change documents the empty
buffer as a precondition of the reveal instead of claiming the shortcut is
generic; the hint itself is left as the shared one.

The exception is a plan body that survives the budget and is cut inside
`MarkdownDisplay`: that component draws its own in-place cue and registers no
overflow id, so the shortcut hint is not lit by it. The plan branch keeps its
own `o open full plan in editor` row for that case and charges it a row only
when the plan is actually clipped — a plan that fits the rows on offer has
nothing to escape from, and at a grant that fits one of the two the plan is the
one that keeps the row. The branch registers an overflow when the budget is so
small that the plan body is dropped outright, which happens only when the plan
needs more rows than the grant holds.

## Constraints

- `MaxSizedBox` requires a defined `maxWidth` whenever `maxHeight` is set,
  charges one row for its footer, floors its budget at `MINIMUM_MAX_HEIGHT`
  (2) — a budget of 1 still renders one content row plus that footer, so the
  box takes one row more than it was asked for — and reports an error for a row
  child it cannot walk.
- A truncation must never be announced by a marker alone at a one-row budget:
  the marker is a row, so the capped content and the marker have to be costed
  together.
- A `MaxSizedBox` cuts its tail only when told to: `overflowDirection` must be
  `"bottom"` for content whose head is the part that matters, while the warning
  boxes ask for the default head cut on purpose, because there the tail is what
  matters and the head cut prints `... first N line(s) hidden ...`.
- The outer cap is a layout guard, not a formatter. It cannot announce what it
  clipped, because it never measures layout — every body that can overflow must
  announce its own truncation, and the guard only bounds the damage.
- Registering an overflow id must be tied to the component's lifetime
  (register on mount while clipping, unregister on unmount) so the hint cannot
  outlive the clipped content.

## Risks and trade-offs

- Prose loss: a fetch-style confirmation with a tight budget can show zero
  prompt rows. Mitigated by the reveal path, and by the counted footer wherever
  a row is left for it.
- The reveal path relies on the host clearing `availableTerminalHeight`. A host
  that always passes a height keeps every cap binding and keeps the hint on; it
  just cannot reveal. Nothing in this change depends on the reveal for safety —
  the question and options are visible with or without it.
- The hint can light at a moment the reveal will not work, because a non-empty
  prompt buffer makes `ctrl-s` stash the draft instead. Deferred: letting the
  confirmation lift the cap itself while it owns the keyboard would
  out-prioritise that intentional stash binding, which is a wider change than
  this PR.
- Registering overflow from a confirmation adds ids to the shared overflow
  state that the shell's own clamp also feeds. Both are id-scoped, so they
  coexist; the hint is the only consumer.

## Validation plan

- Unit tests collocated with the component, one per defect, each red before
  the change:
  - exec confirmation with an unavailable classifier at a 12-row terminal: the
    command text and the `No` option are both on screen, and no blank block
    replaces the command;
  - exec warnings at a budget that cannot hold them all: the command reserves
    its row first and the warnings share out the rest — charged at their wrapped
    rows while those fit, one row each once they do not — so the box cuts at the
    head and the warning naming the exact action survives, instead of seven body
    rows being compressed under a five-row cap; a one-row warning ask pins the
    last warning on a row that counts the earlier ones as `+N warning(s) hidden`;
    a warnings box with no row of its own registers the reveal and hands its
    count to the row that survived; and a command shrunk to a single row
    announces itself the same way;
  - 30 destinations at small budgets down to two body rows: the
    `URLs to fetch:` header, a contiguous prefix of destinations and a counted
    hidden-URLs row are on screen, and a scattered sample is not; the header is
    gone at the two-row budget while one host and the count remain; one hidden
    destination is announced in the singular;
  - a long prose prompt plus destinations at a budget that fits only one of
    them: destinations survive;
  - an inline-Markdown prompt measured by its rendered rows, not its Markdown
    source: emphasis markers are stripped by the renderer, so the source is
    wider than the screen and a body that renders in one row must not be
    reported as having a hidden tail;
  - a link target the renderer keeps visible, counted at that visible width: a
    deceptive label renders as `label (target)`, longer than the label alone, so
    counting the label hands the row to a box Ink then clips without a word,
    while counting what is drawn drops the block whole and spends that row on
    the announcement;
  - a plan body with room: the plan rows and the `o open full plan in editor`
    row occupy separate rows; a plan that needs more rows than the grant holds
    is dropped at a two-row budget and announced, which is also what lights the
    reveal shortcut, and the hint keeps the row at a one-row grant; a plan that
    fits the single row the budget leaves is rendered as text, with neither the
    hint row nor an announcement, because nothing was cut;
  - a long MCP identity at a one-row budget: the two identity rows give way to
    one pinned row that holds both halves, each label cut inside itself, so the
    row still says where the call goes and what it does instead of the longer
    half pushing the other off screen, and it registers that a cut happened;
  - an edit body at an extreme budget: with two body rows and one warning the
    diff gives way to a `... diff hidden ...` announcement, and with one body
    row the warnings are dropped whole — the change itself keeps the row and the
    announcement's tail counts them as `+N warning(s) hidden`; a one-row warning
    ask keeps the last warning and counts the ones behind it the same way; all
    of these register an overflow, so a dropped diff lights the reveal hint the
    way a dropped plan does;
  - a plain-text prompt squeezed out by its own footer: the dropped prose is
    announced; and at a budget where the last row is contested, the destination
    footer keeps it and the prose footer is omitted rather than clipping the
    destination footer;
  - prose left with no row at all, not even one for a footer: the reveal is
    registered anyway, and the frame still shows a destination, the question and
    the answers;
  - the two-option blocked retry layout on a tight compact terminal: the four
    command rows are asserted as four distinct rendered rows in order, because a
    row compressed onto its neighbour still prints its text and a substring
    check would pass a squeezed frame;
  - a plain-text prompt that fits a one-row budget: it renders, because the
    `MINIMUM_MAX_HEIGHT` floor exists only to pay for a footer that a fitting
    body never needs;
  - a compact confirmation at a height where a clamp is observable (40 rows,
    not 8, because 8 cannot distinguish clamped from unclamped): the body stays
    within the compact cap; a command exactly as tall as the cap keeps every
    row at that height, and an undefined grant keeps them all, because the cap
    replaces the grant instead of charging the chrome twice;
  - every case additionally asserts a body row survives, not merely that the
    rendered height is under a bound — an upper bound is also satisfied by an
    empty body.
- End-to-end pass in a real terminal (tmux) against a local mock model: a
  fetch-style confirmation whose prose body is long enough to overflow a small
  terminal and whose destination is reachable, then the same confirmation with
  the approval classifier failing on purpose, which adds the auto-mode banner.
  Confirm the question and options stay visible, that the counted footers
  appear, and that `ctrl-s` reveals the full body without answering. The
  30-destination arm and the long MCP identity arm are unit-only: no built-in
  tool produces a multi-URL confirmation, and a long MCP identity needs a
  server whose tool names are unrealistically long.
- Build, typecheck and the component's own test file.

## Acceptance criteria

- No confirmation whose body this component sizes can push its question line
  or options below the fold, at any terminal height that can hold them.
- For each confirmation type, the body ceiling equals the single budget that
  type branch computed, plus the measured auto-mode banner height.
- Every clipped body shows a contiguous block — a prefix, or a suffix where the
  last entry is the one that matters — and states how much is hidden; a clipped
  destination list can never read as complete. A cut announced inside the
  renderer that makes it is the exception to a counted footer from this
  component: a plan cut inside `MarkdownDisplay` carries that component's own
  cue, and an identity label cut inside itself carries the ellipsis in the label.
- A body clipped by this component makes the `ctrl-s` hint available for as long
  as it is on screen, and the id is released when the confirmation leaves.
- A reviewer can reproduce each of the four defects on the parent commit and
  see them fixed on this commit.
