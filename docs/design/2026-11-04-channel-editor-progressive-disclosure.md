# Channel Editor Progressive Disclosure

[English](2026-11-04-channel-editor-progressive-disclosure.md) | [简体中文](2026-11-04-channel-editor-progressive-disclosure.zh-CN.md)

Status: proposed (2026-11-04), revised after review round 1

## Problem

The Web Shell channel editor (`ChannelEditorDialog.tsx`, shared by all seven
platforms) renders every descriptor field flat. For GitHub a fresh instance
shows roughly 16 controls, each with a description paragraph:

- Low-frequency fields (`pollInterval`, `reasonFilter`, `messageRoutes`,
  `defaultMessageRoute`, `multiSession`, `instructions`) sit at the same level
  as required credentials.
- `reasonFilter` alone renders 15 always-expanded checkbox pills.

The dialog body scrolls well past the viewport, and the fields an operator
actually needs on first setup (name, workspace, authentication, endpoints,
group policy) are buried in noise.

## Current state

- Sections are already key-set driven: `CONNECTION_FIELD_KEYS`,
  `SHARED_ACCESS_FIELD_KEYS`, `SHARED_SESSION_FIELD_KEYS` in
  `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`.
- Save and validation iterate **all** descriptor fields regardless of what is
  rendered: `buildChannelUpsertRequest` and `validateChannelEditorDraft` in
  `channel-editor-state.ts` read `draft.values` for every field. Hiding a
  field therefore changes neither what is saved nor what is validated.
- Conditional visibility has established precedents in the same dialog:
  `allowedUsers` only under allowlist/pairing, `groupAllowedUsers` only under
  an allowlist senders policy, per-repository rows only under an allowlist
  group policy.
- One hard runtime dependency is relevant here: `defaultMessageRoute` must
  name a configured route (`packages/channels/base/src/ChannelBase.ts`,
  constructor throws
  `defaultMessageRoute must name a configured message route.`).
- The `prWatchEvents` / `deliverToBoundSessions` dependency is addressed
  separately by PR #16236, which keeps both fields visible and expresses the
  dependency with disabled controls, an inline hint, and client-side
  validation. This design deliberately leaves the visibility of those two
  fields untouched so the two changes stay complementary.
- The unified `radix-ui` package (already a web-shell dependency) exports a
  `Collapsible` primitive; every existing `ui/` primitive imports from
  `radix-ui`. No `collapsible.tsx` wrapper existed before this change.

## Goals

- Shrink the default GitHub editor to the fields needed for first setup.
- Keep every configured value visible or one click away, and never hide a
  validation error.
- Change no save/validation semantics and no descriptor/protocol surface.

## Scope boundaries

- Web Shell only: `ChannelEditorDialog.tsx`, its CSS module, the new
  `ui/collapsible.tsx` primitive, `channel-editor-state.ts` (one shared record
  predicate), `i18n.tsx`, collocated tests, and the visuals screenshot
  scenarios.
- No changes to `packages/cli`, `packages/core`, `packages/channels`, or the
  SDK types.
- Out of scope: the watch-events dependency UX (PR #16236), compact
  multi-select for `reasonFilter`, description copy slimming, tabs/wizard
  restructuring. These remain possible follow-ups.

## Proposed solution

### 1. Conditional default message route

- `defaultMessageRoute` renders only when `messageRoutes` holds at least one
  non-empty route **or** `defaultMessageRoute` itself is non-empty. The second
  disjunct keeps an invalid stored value visible and fixable instead of
  hiding the only control that could repair it. "Holds a route" uses the same
  shape `assignField` writes: a JSON record with at least one non-empty string
  value.

### 2. Advanced settings collapsible

- A new `ADVANCED_FIELD_KEYS` set, following the existing key-set pattern:
  `pollInterval`, `reasonFilter`, `messageRoutes`, `defaultMessageRoute`,
  `multiSession`, `instructions`.
- Deliberate exclusions:
  - `baseUrl` and `wsUrl` are primary endpoints: they decide where a token is
    sent (GitHub Enterprise / self-hosted GitLab, WeCom). A fresh draft must
    show them, so they stay in Connection. Neither is declared `required` by
    its descriptor; the exclusion is about being the platform's primary
    endpoint, not about the required flag.
  - `operators` is a permission grant ("who may approve tool use"), which
    belongs in Access control next to `privatePolicy` and `allowedUsers`, not
    behind a disclosure labelled as tuning. This is a deliberate product
    decision, not a consequence of the key set.
  - Only non-enum keys belong in the set: `initialFieldValue` pre-fills enums
    from their default, so an enum key would count every fresh draft as
    configured and auto-open the panel, quietly undoing the slim default
    view. A comment on the set records this trap.
- The existing field partitions (credentials/connection, session, access)
  each exclude advanced keys. Advanced fields render in one collapsible panel
  at the end of the form, after access control, in descriptor order. The
  former `routing` section became unreachable once every routing key moved to
  the panel, so its scaffolding (`ROUTING_FIELD_KEYS`, the section-map entry,
  the `fieldSectionKey` branch) is removed rather than left dead.
- The panel applies to every platform because the editor is shared; GitHub
  benefits most. DingTalk keeps `outputMode` in Conversation management.
- Open/closed state:
  - On dialog open, the panel starts **open** when any advanced field is
    configured: booleans are `true`, records hold a non-empty route, other
    kinds hold a non-empty trimmed string. Otherwise it starts collapsed.
  - A collapsed panel shows a count badge of configured advanced fields so
    nothing is silently hidden.
  - Submitting with a validation error on any advanced key forces the panel
    open **and scrolls the first erroring advanced field into view** inside
    the dialog body (the only scroll container), because opening the panel
    alone can leave the error below the fold.
- Radix `Collapsible` unmounts its content while closed. Draft values live in
  the dialog's state, so collapsing never discards an edit, and validation
  and serialization continue to cover every field.
- Accessibility: the panel title is a real `<h3>` wrapping the trigger button
  (WAI-ARIA accordion pattern). ARIA makes a button's descendants
  presentational, so a span-in-button title would be invisible to heading
  navigation; the label and badge stay inside the button so its accessible
  name is unchanged.

### 3. Shared record predicate

- `recordHasRoute` / `parseRouteRecord` in `channel-editor-state.ts` are the
  single source of the record rule ("a JSON record with at least one
  non-empty string value"). Validation (`isMissingField`), the save path
  (`assignField`), and the editor's visibility/auto-open predicates all read
  it, so the three cannot drift apart. The dialog keeps only a thin
  draft-value adapter (`draftHasRoute`).

### 4. Primitive and copy

- Add `packages/web-shell/client/components/ui/collapsible.tsx` in the house
  style (shadcn structure, `import { Collapsible as CollapsiblePrimitive }
from 'radix-ui'`, `data-slot` attributes, `React.forwardRef` on all three
  wrappers for the repository's React 18/19 ref contract, pinned by
  `react18-ref-compat.test.tsx`). No new dependency, no portal, so no
  portal-root integration is needed.
- New i18n keys in both locale maps:
  - `channels.editor.section.advanced` — "Advanced settings" / "高级设置"
  - `channels.editor.section.advanced.description` — one line explaining the
    panel holds rarely changed tuning.
  - `channels.editor.section.advanced.configuredCount` — parameterized count
    badge, e.g. "2 configured" / "已配置 2 项".
- Existing field labels and descriptions are untouched.

## Design decisions and rationale

| Decision                                                         | Rationale                                                                                                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key-set partition, not a descriptor flag                         | Matches the existing section mechanism; no protocol change, no CLI/core gate involvement.                                                                                  |
| Defer the watch-events dependency to PR #16236                   | That open PR already expresses the dependency with disabled controls and client-side validation; hiding the same fields here would be a competing, conflicting UX.         |
| `baseUrl` / `wsUrl` stay in Connection                           | They are primary endpoints that decide where a token is sent; burying them lets a fresh enterprise channel save without its endpoint and send the token to the public API. |
| `operators` stays in Access control                              | It grants permissions; discoverability of "who may approve tool use" outranks saving one row in the default view. Deliberate product decision.                             |
| `defaultMessageRoute` stays visible when itself non-empty        | A stored invalid value must remain repairable in the form.                                                                                                                 |
| Auto-open on configured values; force-open plus scroll on errors | Collapsing must never strand a value or an error out of sight; opening the panel alone can leave the error below the fold.                                                 |
| Heading wraps the trigger                                        | ARIA makes button descendants presentational; only a real heading outside the button is reachable by heading navigation.                                                   |
| One shared record predicate                                      | Validation, save, and visibility agreed by coincidence before; one exported rule keeps them agreeing.                                                                      |
| Advanced panel last, single panel                                | Least disruptive placement; one disclosure control instead of several.                                                                                                     |

## Constraints and risks

- Existing tests pin section placement; they are updated to the new placement
  (expand the panel first) while keeping the assertions meaningful. The
  bound-session label tests are untouched because watch-event visibility does
  not change here.
- Other platforms lose the routing section from the default view
  (`messageRoutes`, `defaultMessageRoute` move to advanced). This is intended
  and consistent; auto-open protects configured channels.
- The count badge treats an explicitly typed default (e.g. `pollInterval`
  `60000`) as configured. Acceptable: it differs from "unset", which is what
  the badge reports.
- The default view is slightly taller than the first revision because
  Connection (with `baseUrl`) stays visible; correctness for enterprise
  endpoints outranks the extra row.

## Validation plan

- Unit tests (collocated, vitest + jsdom):
  - `defaultMessageRoute` hidden with no routes, shown when routes exist or
    when it holds its own value.
  - Advanced panel collapsed on a fresh GitHub draft with `baseUrl` still in
    Connection; configured instances open it, with separate cases pinning the
    string, boolean, and record arms of the configured predicate; the badge
    count is asserted when collapsed.
  - The panel title is an `<h3>` wrapping the trigger button.
  - A validation error on a collapsed advanced field forces the panel open on
    submit and scrolls the erroring control into view (scrollIntoView stub
    witness).
  - Save payload parity: collapsed advanced values still serialize unchanged.
  - Primary endpoints (`baseUrl`, `wsUrl`) stay in Connection while tuning
    collapses; zh-CN copy for the new keys; updated section-placement tests.
  - Mutation witnesses: each new mechanism (endpoint placement, heading,
    boolean arm, record arm, scroll) has a mutation that turns exactly its
    test red.
- `npm run build`, `npm run typecheck`, lint, and the focused web-shell test
  files from `packages/web-shell`.
- Visuals e2e harness: before/after screenshots (dark and light) of the GitHub
  editor with anchored assertions on the collapsed panel and its heading; the
  repository-settings scenario anchors the configured-instance auto-open and
  the count badge in a real browser.

## Acceptance criteria

- A fresh GitHub editor shows Identity, Credentials, Connection (including
  `baseUrl`), Conversation isolation, Access control (including `operators`),
  and a collapsed Advanced settings panel whose title is a heading.
- Configured advanced values open the panel on edit; validation errors inside
  it force it open on submit and scroll the erroring field into view.
- Save/validation semantics are unchanged.
- All focused tests, typecheck, build, and lint pass.

## Open questions

None blocking. Badge semantics (count of non-empty advanced fields) are fixed
by this design.
