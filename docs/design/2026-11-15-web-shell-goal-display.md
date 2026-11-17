# Web Shell Goal display: session navigation and status readability

[English](2026-11-15-web-shell-goal-display.md) | [简体中文](2026-11-15-web-shell-goal-display.zh-CN.md)

Status: implemented (2026-11-15), client-only enhancement on top of the
multi-workspace Goals page (#17230, #17291).

## Problem

The Goals page lists every loaded session's goal, but inspecting a goal means
finding the small session-name text link at the far right of the card footer.
The card itself gives no at-a-glance sense of lifecycle state (the status pill
is monochrome) or of how much of an armed budget is already spent (the figures
are plain text among several other meta items). The in-session `GoalStatusStrip`
has no way back to the Goals page, so a user who lands in a goal's session
cannot reach the aggregate view without the sidebar.

## Current state

- `GoalsDialog` renders one card per goal: status dot (activity), objective,
  edit/pause/resume/clear icon actions, `lastReason`, and a footer with the
  workspace pill, a monochrome status pill, activity, turns, tokens, elapsed
  time, and a session-name button that calls
  `onOpenSession(sessionId, workspaceCwd)`.
- `GoalStatusStrip` renders above the composer of the goal's own session with
  status text, objective, elapsed/turn/token figures, and the same four control
  actions. It has no navigation affordance.
- The cockpit header and workflow inspector already share an execution-status
  palette (`--status-running-*`, `--status-attention-*`, `--status-done-*`,
  `--status-idle-*` in `App.module.css`) so a status reads the same colour
  across surfaces. Goals do not use it.

## Goals

- Make the jump from a goal to its session a first-class, always-visible
  action on the card.
- Make lifecycle state readable at a glance, using the same colour language
  as the rest of the Web Shell.
- Show progress against each armed budget (turns, tokens, active time) as a
  compact bar, without adding noise for unbounded goals.
- Let the in-session strip open the Goals page when that page is available.

## Non-goals

- No daemon, SDK, or wire-format change. Everything is derived from the
  existing `DaemonGoal` / `GoalSnapshotV2` payloads.
- No goal markers in the sidebar session list: that would need a new
  always-on goals poll (`GET /goals` probes every live session) or a new
  session-summary field, both out of scope for a display enhancement.
- No change to goal control semantics, gating, or the create/edit forms.
- No new page or deep link; the strip reuses the existing `openGoals` action.

## Proposed changes

### GoalsDialog card

- A new first icon action in the card header (`MessageSquareText`,
  `data-testid="goal-open-session"`) calls
  `onOpenSession(item.sessionId, item.workspaceCwd)` — the same handler as the
  footer link, including the workspace tag. It is navigation, not a control,
  so it is never disabled by the per-session `busy` gate, and it wears the
  interactive blue (`--agent-blue-500`) so it reads apart from the grey
  edit/pause/clear control icons.
- The footer session entry is a labeled link, not a grey label
  (`data-testid="goal-session-link"`): message icon + session name + arrow
  icon, interactive blue, underline on hover/focus, and a focus ring. The
  first iteration kept the old grey text-only shape; in review it was
  indistinguishable from the surrounding meta and readers could not find the
  jump at all, so the link now carries every conventional link cue.
- The status pill carries `data-status` mapped by `goalStatusTone(status)`:
  `active → running`, `paused | blocked | usage_limited → attention`,
  `complete → done`. CSS reuses the shared execution-status palette. This
  matches `GoalStatusMessage`'s existing warning/success language. The
  `done` branch is defined for completeness but unreachable today: both
  goals listings filter `complete` out (pre-existing daemon policy) and the
  strip returns null for it, so no surface currently renders a completed
  goal. Listing completed goals would be a separate daemon-side change.
- When at least one budget is armed, a `budgets` section renders one row per
  budget between the reason and the footer: label, a `role="progressbar"`
  track (`data-testid="goal-budget-<kind>"`, `aria-valuenow` = clamped
  percent), a fill tinted with the lifecycle tone, and the figure text. The
  progressbar's accessible name is the visible label and figure themselves
  via `aria-labelledby` (per-session ids), not a second copy in `aria-label`.
  The row is the **single home** for an armed budget's figures: the matching
  footer cell (`goal-turns`, `goal-tokens`, `goal-elapsed`) is suppressed
  while its row renders, so a fact is never stated twice, and the figure
  reuses the same localised templates the footer used (`goal.turnsOfBudget`,
  `goal.tokensOfBudget`, and `getGoalActiveTimeLabel` for active time) so a
  catalogue change moves every surface. Turns use `turnCount / turnBudget`;
  tokens use `formatContextTokens` on `tokensUsed / tokenBudget` and are
  skipped when the daemon reports no usage figure; active time uses the same
  live `getGoalActiveTimeMs` the elapsed meta already ticks with, against
  `activeTimeBudgetMs`. Ratios clamp to `[0, 1]` so a spent budget reads as a
  full bar, and the clamped ratio rounds to the nearest percent
  (`Math.round`): a goal at 99.67% reads as a full bar while the figure keeps
  attesting the exact headroom — the bar is the at-a-glance readout, the
  figure the precise one. Unbounded goals render no section and keep the
  footer figures.
  The fill's width transition is gated behind
  `@media (prefers-reduced-motion: no-preference)`, matching the sibling
  progress fills, because the active-time ratio advances every second.

### GoalStatusStrip

- `goalStatusTone` lives here and is exported (the dialog already imports its
  display helpers from this module; the reverse import would be a cycle).
- The status text carries the same `data-status` tone.
- A new optional `onOpenGoals` prop renders a `Target` icon button
  (`data-testid="goal-open-goals"`, label `goals.viewAll`) as the first
  action. Absent prop → no button, so surfaces without the Goals page keep
  the current shape. The jump is navigation, not a control: it wears the
  same interactive blue as the card's jump affordances (`.goalsAction`,
  declared after the `.action:hover` rules so the blue survives hover) and
  is never disabled by `busy`. The `Target` glyph stays — it is the app-wide
  Goals icon the sidebar's Goals entry also uses; the review-round fix was
  the grey control class, not the icon.

### App wiring

- The main composer's strip receives
  `onOpenGoals={projectFeaturesAvailable ? openGoals : undefined}`, the same
  gate the Goals page itself renders under.
- The split-view `ChatPane` renders the same strip and already receives an
  `onOpenGoals` prop (its `/goal status` command uses it). Its strip now
  forwards that same prop. `SplitView` itself only mounts under
  `projectFeaturesAvailable && mainView === 'split'`, so every mounted pane
  has a Goals surface and renders the affordance; the prop stays optional
  for any surface without the Goals page, where no button renders.

### i18n

- New keys in en / zh / ru: `goals.viewAll`, `goals.budget.turns`,
  `goals.budget.tokens`, `goals.budget.time`. Budget value texts reuse the
  existing `formatRuntime` / `formatContextTokens` formatters.

## Design decisions

- **Header icon instead of a clickable card.** A whole-card click target
  would nest five buttons and steal objective text selection; a constant
  header icon is discoverable without changing card semantics.
- **Navigation wears link cues, control grey stays for controls.** The first
  iteration rendered both jump affordances in the same achromatic grey as the
  meta text; reviewers could not find the jump in the screenshots. The footer
  entry now carries icon + name + arrow in the interactive blue with hover
  underline and a focus ring, and the header icon is tinted blue — colour and
  shape, not position alone, signal "this navigates". The rule extends to the
  strip's Goals-page jump: round 6 caught it still wearing the grey control
  class, and it now carries the same blue (`.goalsAction`).
- **The bar rounds, the figure stays exact.** `aria-valuenow` and the fill
  width round the clamped ratio to the nearest percent, so a goal at 99.67%
  reads as a full bar while its figure still shows the remaining headroom.
  The two readouts serve different purposes — glance vs. precision — and a
  floor would understate progress just as a ceiling would overstate it.
- **Row labels restate the unit on purpose.** The value templates are shared
  with the label-less footer and strip surfaces, where the unit word is the
  only carrier of the dimension. A unit-less row variant would fork the
  single wording source this PR deliberately unified, so the label/unit
  repetition in the row is the accepted cost; every locale's label and value
  template is pinned instead.
- **Shared palette, not new colours.** The tone mapping reuses
  `--status-*-fg/bg` so goals read identically to the cockpit and workflow
  surfaces in both themes; no new theme tokens are introduced.
- **Bars only for armed budgets.** Most goals are unbounded; rendering empty
  tracks for them would add noise and imply a ceiling that does not exist.
  A token budget without `tokensUsed` (older daemon) is skipped rather than
  drawn at zero, which would attest a spend the snapshot cannot prove.
- **One home per figure.** The first iteration printed an armed budget's
  figures in both the new row and the unchanged footer — the very meta noise
  this PR removes, duplicated, and built from two different templates. The
  row now owns the figure (localised template included) and the matching
  footer cell is suppressed; unbounded goals keep the footer unchanged.
- **`goalStatusTone` in the strip module.** Single source for both surfaces;
  the dialog already depends on the strip's helpers, so the dependency
  direction stays acyclic.

## Files affected

- `packages/web-shell/client/components/dialogs/GoalsDialog.tsx` / `.module.css`
- `packages/web-shell/client/components/GoalStatusStrip.tsx` / `.module.css`
- `packages/web-shell/client/App.tsx` (strip wiring only)
- `packages/web-shell/client/components/ChatPane.tsx` (split-view strip wiring)
- `packages/web-shell/client/i18n.tsx` (en / zh / ru keys)
- Tests: `GoalsDialog.test.tsx`, `GoalStatusStrip.test.tsx`,
  `ChatPane.test.tsx`, `SplitView.test.tsx`, `App.test.tsx`, `i18n.test.ts`,
  `web-shell.goals-multi-workspace.spec.ts`

## Constraints and risks

- The added header button shares its accessible-name pattern with the footer
  link (`"<hint>: <session name>"`); both perform the same navigation, and no
  E2E selector queries that name, so the redundancy is safe.
- Budget bars re-render on the existing 1 s tick only while a goal is active;
  no new timer is introduced.
- Older daemons without `tokensUsed` simply show no token bar; no fallback
  figure is invented.

## Validation plan

- Unit: `GoalsDialog.test.tsx` (header action with and without a workspace
  tag — the tagged case uses a SECONDARY workspace goal so per-goal routing
  is observable, pill tone per lifecycle state, budget bars
  present/absent/clamped with `role="progressbar"` and explicit
  `aria-valuemin`/`aria-valuemax`, token-bar skip, fill tone in BOTH running
  and attention states, inline fill width including the zero-progress `0%`,
  the active-time bar AND its figure advancing under fake timers, a
  between-turns case proving the timer gates on goal status rather than
  session activity, nearest-percent rounding with the figure keeping its
  exact headroom, single-occurrence figure witness, a mixed-budget case
  pinning that only the armed budget's footer cell is suppressed, both jump
  affordances' accessible names, a completed-goal case pinning both jumps
  still navigate, a second-card case pinning per-item jump scoping, and a
  two-card case pinning per-session label-id uniqueness and card-scoped
  references). The accessible-name helper composes the `aria-labelledby`
  referenced text with spaces, the way the browser computes the name, and
  asserts `aria-label` is absent so a regression back to it reds every name
  pin. `GoalStatusStrip.test.tsx` (affordance wired/absent, the wired button
  carrying the `goalsAction` link-cue class, status tone, tone mapping).
  `ChatPane.test.tsx` pins the split-view forward both ways: wired renders
  the button and fires the handler once; unwired renders no button while the
  strip keeps its controls. `SplitView.test.tsx` pins the middle hop both
  ways (every pane receives `onOpenGoals` and fires it; unwired panes get
  none), and `i18n.test.ts` full-string-pins `goals.viewAll` and the three
  budget labels in en / zh / ru.
- `GoalsDialog.test.tsx` also pins that BOTH the header action and the footer
  link stay enabled while a control is in flight (navigation is not a
  control), `GoalStatusStrip.test.tsx` pins the same exemption for the strip's
  Goals jump under `busy`, and `App.test.tsx` pins the composer strip's
  `projectFeaturesAvailable` gate both ways (affordance present with project
  features, absent without) plus the App-to-SplitView hop end to end (the
  forwarded callback opens the real Goals page).
- Mutation witnesses (byte-level restore verified): removing the footer
  suppression, wiring the suppression to the wrong budget, deleting the
  `ChatPane` forward, dropping the header jump's workspace tag, hardcoding
  the fill width to `0%`, reverting the link to the meta grey, deleting the
  PILL's `[data-status='attention']` rule (the fill reads it), deleting the
  STRIP's `[data-status='attention']` rule (pinned by the paused-goal
  navigation case), deleting both running rules together (caught by the
  untinted anchor), gating the header jump on `busy`, and diverging
  `getGoalActiveTimeLabel` each turn their pin red. Round 6 adds: dropping
  the strip jump's `goalsAction` class (unit) and deleting the `.goalsAction`
  colour rule (E2E), flooring the percent instead of rounding it, rewriting
  the timer gate from goal status to session activity, gating the footer
  link or the strip jump on `busy`, deleting the SplitView or the App
  `onOpenGoals` forward, and wiring the header jump to a fixed row instead of
  its own card.
- `npm run typecheck`, ESLint, Prettier on the touched files.
- E2E: the existing `web-shell.goal.spec.ts` and
  `web-shell.goals-multi-workspace.spec.ts` suites must stay green (they pin
  the control actions and card structure the new button lives beside). The
  budget @smoke case renders TWO cards (primary + secondary) so the
  card-scoped reads face a real sibling, measures the fill's real pixel
  width against its track (15% ± 1px), and reads computed colours — fill vs
  track, link equal to the header action's blue (positive witness) and
  distinct from meta and the untinted `--foreground` anchor, fill equal to
  the pill's attention colour. The header-jump case pins the header action's
  painted colour against the grey control icons, the strip's goal identity,
  the load request's `cwd` (the goal's secondary workspace runtime), and the
  strip's Goals jump reading the same blue as the card header jump while
  differing from the strip's grey edit control and the untinted anchor. A
  dedicated paused-goal navigation case paints the strip in attention and
  pins its colour against the pill and the untinted anchor.

## Acceptance criteria

- Every goal card offers a constant header action that opens its session in
  the goal's own workspace.
- Status pills and strip status text use the shared lifecycle tones in both
  themes.
- Armed budgets render progress bars with correct clamped percentages and
  accessible labels; unbounded goals render none.
- The strip opens the Goals page where the page is available, and renders no
  affordance where it is not.
- No daemon/SDK change; existing goals E2E suites pass unchanged.

## Open questions

- None. Sidebar goal markers are explicitly deferred (see Non-goals).
