# Channel Editor Progressive Disclosure

[English](2026-11-04-channel-editor-progressive-disclosure.md) | [简体中文](2026-11-04-channel-editor-progressive-disclosure.zh-CN.md)

Status: proposed (2026-11-04)

## Problem

The Web Shell channel editor (`ChannelEditorDialog.tsx`, shared by all seven
platforms) renders every descriptor field flat. For GitHub a fresh instance
shows roughly 16 controls, each with a description paragraph:

- Low-frequency fields (`baseUrl`, `pollInterval`, `reasonFilter`,
  `messageRoutes`, `defaultMessageRoute`, `multiSession`, `instructions`,
  `operators`) sit at the same level as required credentials.
- `reasonFilter` alone renders 15 always-expanded checkbox pills.

The dialog body scrolls well past the viewport, and the fields an operator
actually needs on first setup (name, workspace, authentication, group policy)
are buried in noise.

## Current state

- Sections are already key-set driven: `CONNECTION_FIELD_KEYS`,
  `ROUTING_FIELD_KEYS`, `SHARED_ACCESS_FIELD_KEYS`, `SHARED_SESSION_FIELD_KEYS`
  in `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`.
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
  `radix-ui`. No `collapsible.tsx` wrapper exists yet.

## Goals

- Shrink the default GitHub editor to the fields needed for first setup.
- Keep every configured value visible or one click away, and never hide a
  validation error.
- Change no save/validation semantics and no descriptor/protocol surface.

## Scope boundaries

- Web Shell only: `ChannelEditorDialog.tsx`, its CSS module, a new
  `ui/collapsible.tsx` primitive, `i18n.tsx`, collocated tests, and the
  visuals screenshot scenario.
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
  `baseUrl`, `pollInterval`, `reasonFilter`, `messageRoutes`,
  `defaultMessageRoute`, `multiSession`, `instructions`, `operators`.
  `wsUrl` is deliberately excluded: it is WeCom's primary endpoint, not a
  tuning knob.
- The three existing field partitions (credentials/connection/routing,
  session, access) each exclude advanced keys. Advanced fields render in one
  collapsible panel at the end of the form, after access control, in
  descriptor order. Sections that become empty (GitHub's Connection and
  Notifications-and-routing) disappear through the existing empty-section
  guard.
- The panel applies to every platform because the editor is shared; GitHub
  benefits most. WeCom keeps `wsUrl` in Connection; DingTalk keeps
  `outputMode` in Conversation management.
- Open/closed state:
  - On dialog open, the panel starts **open** when any advanced field is
    configured: booleans are `true`, records hold a non-empty route, other
    kinds hold a non-empty trimmed string. Otherwise it starts collapsed.
  - A collapsed panel shows a count badge of configured advanced fields so
    nothing is silently hidden.
  - Submitting with a validation error on any advanced key forces the panel
    open before the error list is shown.
- Radix `Collapsible` unmounts its content while closed. Draft values live in
  the dialog's state, so collapsing never discards an edit, and validation
  and serialization continue to cover every field.

### 3. Primitive and copy

- Add `packages/web-shell/client/components/ui/collapsible.tsx` in the house
  style (shadcn structure, `import { Collapsible as CollapsiblePrimitive }
from 'radix-ui'`, `data-slot` attributes). The current shadcn registry
  emits the same unified-package import; if the registry is unreachable the
  file is authored to that exact shape. No new dependency, no portal, so no
  portal-root integration is needed.
- New i18n keys in both locale maps:
  - `channels.editor.section.advanced` — "Advanced settings" / "高级设置"
  - `channels.editor.section.advanced.description` — one line explaining the
    panel holds rarely changed tuning.
  - `channels.editor.section.advanced.configuredCount` — parameterized count
    badge, e.g. "2 configured" / "已配置 2 项".
- Existing field labels and descriptions are untouched.

## Design decisions and rationale

| Decision                                                  | Rationale                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Key-set partition, not a descriptor flag                  | Matches the existing section mechanism; no protocol change, no CLI/core gate involvement.                                                                          |
| Defer the watch-events dependency to PR #16236            | That open PR already expresses the dependency with disabled controls and client-side validation; hiding the same fields here would be a competing, conflicting UX. |
| `defaultMessageRoute` stays visible when itself non-empty | A stored invalid value must remain repairable in the form.                                                                                                         |
| Auto-open on configured values and on errors              | Collapsing must never strand a value or an error out of sight.                                                                                                     |
| Advanced panel last, single panel                         | Least disruptive placement; one disclosure control instead of several.                                                                                             |
| Exclude `wsUrl`                                           | It is a required connection endpoint for WeCom, not advanced tuning.                                                                                               |

## Constraints and risks

- Existing tests pin section placement (`Connection`, `Notifications and
routing`); they are updated to the new placement (expand the panel first)
  while keeping the assertions meaningful. The bound-session label tests are
  untouched because watch-event visibility does not change here.
- Other platforms lose the routing section from the default view
  (`messageRoutes`, `defaultMessageRoute` move to advanced). This is intended
  and consistent; auto-open protects configured channels.
- The count badge treats an explicitly typed default (e.g. `pollInterval`
  `60000`) as configured. Acceptable: it differs from "unset", which is what
  the badge reports.

## Validation plan

- Unit tests (collocated, vitest + jsdom):
  - `defaultMessageRoute` hidden with no routes, shown when routes exist or
    when it holds its own value.
  - Advanced panel collapsed on a fresh GitHub draft; configured instance
    opens it with the right badge count; expanding reveals the fields.
  - A validation error on a collapsed advanced field forces the panel open on
    submit and names the field.
  - Save payload parity: collapsed advanced values still serialize unchanged.
  - zh-CN copy for the new keys; updated section-placement tests.
- `npm run build`, `npm run typecheck`, lint, and the focused web-shell test
  files from `packages/web-shell`.
- Visuals e2e harness: before/after screenshots (dark and light) of the GitHub
  editor with anchored assertions on the new collapsed panel, per the
  repository's visuals workflow.

## Acceptance criteria

- A fresh GitHub editor shows only Identity, Credentials (token, local gh,
  bound-sessions switch and watch events), Conversation isolation, Access
  control, and a collapsed Advanced settings panel.
- Configured advanced values open the panel on edit; validation errors inside
  it force it open on submit.
- Save/validation semantics are unchanged.
- All focused tests, typecheck, build, and lint pass.

## Open questions

None blocking. Badge semantics (count of non-empty advanced fields) are fixed
by this design.
