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
  confirmation type, at any terminal height.
- A body is sized from one budget, computed once, and that same number is the
  ceiling of the outer cap.
- Any truncation shows a contiguous prefix and says how much is hidden.
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
and the outer cap call, so a compact confirmation cannot receive a larger
ceiling from one path than another.

### Truncation is contiguous and counted

Content that is cut must be pinned first. Ink rows with `flexShrink: 0` keep
their natural height, so the cap cuts the tail instead of compressing a
scatter of rows. `MaxSizedBox` already does exactly this for its own rows and
renders the `... last N lines hidden ...` footer; anything routed through it
inherits both properties.

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

- When the budget can hold every destination plus the minimum usable prose
  block, all destinations render and the prose gets the remainder.
- Otherwise the destination block is capped: one row for the `URLs to fetch:`
  header, one for the hidden-count footer, and the remaining rows are filled
  greedily with whole URLs so no destination is shown half-cut. The header is
  dropped before a destination is, in the order header, then blank separator,
  then nothing: a header above an empty list answers nothing, while a host is
  the thing being authorized. The footer survives to the last row because the
  count is the only signal that the list is longer than what is on screen. The
  prose keeps
  one row for its own hidden-count footer so its loss is still announced, and
  its block is skipped when the remainder is too small to hold a line it would
  have clipped anyway — `MINIMUM_MAX_HEIGHT` (2) for the plain-text prompt,
  because its `MaxSizedBox` spends a row on that footer, and 1 for the pinned
  inline-Markdown box, which can render a single row. Prose that already fits
  is never skipped for a floor reason: it renders no footer, so the floor does
  not apply to it. When not even the footer row is left, the destinations keep
  it and the prose goes unannounced: a prose footer would push the destination
  footer past the cap, and Ink would cut off the one that matters instead.

The trade-off is deliberate: at a body budget of roughly five rows or fewer,
the destinations outrank the explanation, and the prose may be gone. The
user still sees which hosts are being authorized and can reveal the rest.

### Reading the whole body

The reveal already exists and is generic: `ctrl-s`
(`Command.SHOW_MORE_LINES`) clears `constrainHeight`, which makes every height
budget in this component `undefined`, and `MainContent.tsx` drops its own
pending-region clamp once streaming has settled to a static confirmation, so
the full body renders into the terminal scrollback and stays interactive
(#6809). Key dispatch is a broadcast that ignores return values, so the
shortcut reaches the global handler even while the confirmation owns the
keyboard.

What was missing is discoverability: the `Press ctrl-s to show more lines`
hint only appears when something has registered an overflow, and the bodies
that this component truncates registered nothing. Now every truncation this
component performs itself registers an overflow id for as long as it is on
screen, which turns the hint on at the moment it is useful. Each truncating
body also says what it hid, so the affordance is discoverable even in the frame
where the content disappears.

The exception is a plan body that survives the budget and is cut inside
`MarkdownDisplay`: that component draws its own in-place cue and registers no
overflow id, so the shortcut hint is not lit by it. The plan branch keeps its
own always-rendered `o open full plan in editor` row for that case, and
registers an overflow when the budget is so small that the plan body is dropped
outright.

## Constraints

- `MaxSizedBox` requires a defined `maxWidth` whenever `maxHeight` is set,
  charges one row for its footer, floors its budget at `MINIMUM_MAX_HEIGHT`
  (2) — a budget of 1 still renders one content row plus that footer, so the
  box takes one row more than it was asked for — and reports an error for a row
  child it cannot walk.
- A truncation must never be announced by a marker alone at a one-row budget:
  the marker is a row, so the capped content and the marker have to be costed
  together.
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
- Registering overflow from a confirmation adds ids to the shared overflow
  state that the shell's own clamp also feeds. Both are id-scoped, so they
  coexist; the hint is the only consumer.

## Validation plan

- Unit tests collocated with the component, one per defect, each red before
  the change:
  - exec confirmation with an unavailable classifier at a 12-row terminal: the
    command text and the `No` option are both on screen, and no blank block
    replaces the command;
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
  - a plan body with room: the plan rows and the `o open full plan in editor`
    row occupy separate rows, and at a two-row budget the dropped plan is
    announced, which is also what lights the reveal shortcut;
  - a long MCP identity at a one-row budget: the identity box keeps its own
    height cap instead of letting its rows share one line;
  - a plain-text prompt squeezed out by its own footer: the dropped prose is
    announced; and at a budget where the last row is contested, the destination
    footer keeps it and the prose footer is omitted rather than clipping the
    destination footer;
  - a plain-text prompt that fits a one-row budget: it renders, because the
    `MINIMUM_MAX_HEIGHT` floor exists only to pay for a footer that a fitting
    body never needs;
  - a compact confirmation at a height where a clamp is observable (40 rows,
    not 8, because 8 cannot distinguish clamped from unclamped): the body stays
    within the compact cap;
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

- No confirmation can push its question line or options below the fold.
- For each confirmation type, the body ceiling equals the single budget that
  type branch computed, plus the measured auto-mode banner height.
- Every clipped body shows a contiguous prefix and states how much is hidden;
  a clipped destination list can never read as complete. A plan cut inside
  `MarkdownDisplay` is the one exception to the announcement: it carries that
  component's own cue instead of a counted footer from this component.
- A body clipped by this component makes the `ctrl-s` hint available for as long
  as it is on screen, and the id is released when the confirmation leaves.
- A reviewer can reproduce each of the four defects on the parent commit and
  see them fixed on this commit.
