# Session Workflow DAG — design plan

Status: proposal, not implemented. Written before code, reviewed against the
brief once, revised. The revision is recorded at the bottom rather than
silently folded in.

## Brief

An execution trace of a dependency-ordered plan, watched live while an agent
works through it. Reader: a developer. The three questions they arrive with,
in order: **what is running now**, **what is blocked on what**, **what needs
me**.

This is a product surface, not a greenfield page: it inherits the Web Shell
token system, light/dark, CSS modules, and a stylesheet-source test
convention. So the palette is not up for invention — the plan spends its
freedom on structure and on the *rule* governing existing tokens.

## What is wrong today

Read against the three questions, not as taste:

1. **Reading order is inverted.** The node leads with a status glyph, then the
   raw Todo id, then the status word; `nodeContent` — the only element that
   says what the step *is* — is third. At graph scale the reader scans
   `● step-3 Blocked` before "Compare findings". An id is an address, and it
   is the least useful thing at the largest scale.
2. **Status is stated three or four times per node**: the glyph, the status
   word, the border tint, and an "attention" badge when it applies. On a 240px
   node, most of the visible elements are about status.
3. **Dependencies are stated twice** — as a drawn edge, and again as
   "Depends on step-3, step-7" in raw ids.
4. **Every node looks equally important.** In a real trace at most one node is
   running and a few need attention; the rest are done or waiting. Same border
   weight, same fill, same radius on all of them — the graph does not answer
   "where do I look".
5. **Time is invisible.** This is an execution trace, and the layout encodes
   dependency order but never elapsed time.
6. **The port dots are always `--agent-blue-500`** — the selection colour —
   on every node that has edges. The accent is spent on something that never
   changes, so selection has to shout over it.

## Color

No new values; a rule for the existing tokens.

| role | token | used for |
| --- | --- | --- |
| ink | `--foreground` | step content — the only full-contrast text |
| quiet | `--muted-foreground` | counts, elapsed, ids |
| rule | `--border` | every node edge, every dependency line |
| live | `--status-running-fg` | running, and nothing else |
| done | `--status-done-fg` | completed, and nothing else |
| wait | `--status-attention-fg` | needs attention, and nothing else |
| pick | `--agent-blue-500` | selection and focus only, never decoration |

**The rule: a node carries at most one status colour, in exactly one place,
and only when the status is worth saying.** Waiting/blocked is the resting
state of most nodes in any real plan, so it carries none — the stylesheet
already makes this argument for `blocked`; this extends it consistently
instead of applying it to one status.

## Type

One family (the app's). Three sizes inside a node:

- **content** 13px / 500 — promoted to the first line
- **meta** 11px / 400 quiet — one line beneath
- **number** 11px tabular — the step's index

No status word on the node face in the default case; the left rule says it.
No mono on the node face — the id is an address, so it belongs where it is
copied (the detail panel), not on every card at graph scale.

## Layout

Two candidates, then the pick.

**A — content-first, status as a left rule**

```
┌──────────────────────────────┐
│▌ 3  Compare findings         │   ▌ 3px status rule, absent when waiting
│     2 agents      1m14s      │
└──────────────────────────────┘
```

**B — status as a filled number column**

```
┌───┬──────────────────────────┐
│ 3 │ Compare findings         │   number cell filled with the status tone
│   │ 2 agents      1m14s      │
└───┴──────────────────────────┘
```

**Pick: A, carrying B's step number.** The number has to appear on the node
because the inspector list and the new dependency chips both address steps by
number — three surfaces, one identity, or they disagree. But B spends ~24px
of a 240px lane on a cell whose only other job is a tone the rule already
carries.

Alignment is left throughout. The lanes are already a strong vertical rhythm;
centring anything fights it.

The node's border stays `rule` for every status. Removing the per-status
border tint is what stops the canvas reading as a wall of tinted boxes and
lets the one running node actually stand out.

## Where the boldness goes

One place: **the running node.** Usually exactly one node is running, and
"is this thing alive or hung" is the first question a developer asks of a live
trace. It gets the only saturated treatment on the canvas — a filled left rule
and a live elapsed count — and everything around it stays hairline and quiet.

Motion: none added. The elapsed count is data changing, not an animation; no
transition on it. The existing `prefers-reduced-motion` block stands.

## Principles

1. The step's content is the node; everything else is annotation.
2. One status, one place, and only when it is worth saying.
3. The edge is the dependency statement — do not restate it as text.
4. The step number is one identity across graph, list, and dependency chip.
5. Exactly one thing on the canvas is loud: what is running now.

## Explicitly not changing

Edge routing, the layering algorithm, the return-lane mechanics, and the
measure pass. They work, they are heavily tested, and touching them would turn
a node-face redesign into a second oversized PR. This proposal is the node
face plus the colour rule.

## Review against the brief

Worked through the generic-default calibration; two findings, one of which
changed the plan.

- Cream/serif/terracotta, or near-black with an acid accent: not applicable,
  the tokens are the product's.
- Hairline rules everywhere: I *am* moving toward hairlines, which is itself a
  default look. Kept, but for a subject-specific reason — the hairline
  replaces a per-status border tint, and the argument is the one the codebase
  already makes for `blocked`: most nodes in a healthy plan are resting, and
  tinting them all makes a healthy graph read as a wall of warnings. The 8px
  radius stays, so this is not a broadsheet.
- The SaaS-card kit — identical rounded cards, one border treatment, a status
  wash on each: this is what the node is today. Dropping the status border and
  two of the three status tokens moves away from it.
- **Numbered markers (01 / 02 / 03):** the calibration warns against these
  unless the content is genuinely a sequence. Here it is — a topologically
  ordered plan — and the number is already how the inspector addresses steps.
  Kept.
- **`·`-joined meta strings — caught, and the plan changed.** The first draft
  of the node meta line read `step-3 · 2 agents · 1m14s`. That is on the tell
  list, and it is the exact pattern just removed from the inspector. Revised
  to two facts with real spacing and no id on the node face, matching the
  `.metrics` flex row already built. This also buys back horizontal room in a
  240px lane, which is what makes the narrow-viewport case work honestly
  rather than by shrinking type.

## Caveat found while planning

The "Depends on …" text row cannot simply be deleted. There are three layout
states, not two:

- `hasDependencies === false` → flat layout, no `blockedBy` exists anywhere,
  so nothing to state. Safe.
- `drawsDependencyEdges === true` → edges are drawn, the text is redundant.
  Remove.
- `hasDependencies && !drawsDependencyEdges` → dependencies exist but exceed
  `MAX_RENDERED_PLAN_EDGES` (500), so **no edges are drawn**. Here the text is
  the only statement of the dependency and must stay.

So the row is kept and gated on `!drawsDependencyEdges`, rendered as the same
number-and-title chips the inspector uses rather than as raw ids.

## Open questions

1. Does the elapsed count on a running node belong on the node face, or only
   in the inspector? It is the strongest "alive" signal, but it is also the
   only per-node value that changes every second.
2. Should `attention` keep a badge, or fold into the left rule as the `wait`
   tone? Folding is consistent with the one-status rule, but attention is the
   one state the reader is being asked to act on.
3. Verification: this box cannot run a browser, so the visual pass would ship
   read from CSS. Worth a real render before merge.
