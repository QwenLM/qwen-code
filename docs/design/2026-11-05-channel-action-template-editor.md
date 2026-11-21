# Channel Action Template Editor Usability

[English](2026-11-05-channel-action-template-editor.md) | [简体中文](2026-11-05-channel-action-template-editor.zh-CN.md)

Status: implemented and verified locally (2026-11-05); pending PR

## Problem

The Web Shell channel editor renders `record` config fields as one labeled
single-line input per descriptor option. For the GitHub channel's
`boundSessionActions` field the descriptor enumerates the full closed key
vocabulary: `default` + 4 watch events + 15 notification reasons = 20 keys,
each also spelled with the 3 binding-role prefixes (`review:`, `verify:`,
`fix:`) — **80 rows** in one dialog. Operators typically configure one or two
keys. Three usability gaps follow:

1. **Too much content.** All 80 rows render whether configured or not, inside
   a dialog body capped at `min(66vh, 650px)`.
2. **No explanation.** The field carries one dense paragraph (key syntax,
   role routing, seven template variables). Individual keys have no
   description, and a single-line `Input` cannot comfortably hold an
   instruction template of up to 2,000 code points (channel-base's
   `BOUND_ACTION_TEMPLATE_MAX_CODE_POINTS`).
3. **No fullscreen.** `ChannelEditorDialog` is fixed at `sm:max-w-xl`
   (~576px) with no expand affordance, while other surfaces (DialogShell,
   artifact panel) already offer fullscreen.

Two adjacent gaps surface while fixing the above: `boundSessionActions`
renders in the Credentials section instead of the bound-sessions panel next
to its `deliverToBoundSessions` prerequisite, and templates can be typed
while bound delivery is off only to be rejected by the daemon on save.

## Current state

- Descriptor: `packages/channels/github/src/index.ts` builds
  `BOUND_ACTION_KEY_OPTIONS` from `PR_WATCH_EVENTS`,
  `PR_NOTIFICATION_REASONS`, and `PR_BINDING_ROLES` so UI options cannot
  drift from the adapter's key validator.
- Renderer: the generic `record` branch in
  `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`
  maps every option to a `Label` + `Input` row. Clearing a row deletes the
  key from the draft because the renderer has no other delete affordance.
- Draft shape: `draft.values[field.key]` is a JSON string;
  `parseRouteRecord` in `channel-editor-state.ts` filters empty values on
  save, and `recordHasRoute` drives required-field validation.
- Option shape: `{ value: string; label: string }`, mirrored in
  `packages/channels/base/src/types.ts` and
  `packages/sdk-typescript/src/daemon/types.ts`; the cli
  `channel-descriptor-sdk-mirror.test.ts` type-level mirror test keeps the
  two identical. The wire-shape assertion pins field-level keys only.
- GitLab's `action_prompt_template` is the only other `record` field
  (9 options, required, descriptive labels).
- i18n: `packages/web-shell/client/i18n.tsx` holds `EN` / `ZH` dictionaries;
  record option labels already resolve through
  `channels.editor.field.<type>.<field>.option.<value>` with fallback to the
  descriptor label. `common.fullscreen` / `common.exitFullscreen` exist.

## Goals

- Show only configured templates; add keys on demand through a picker that
  explains each key.
- Edit templates in multi-line text areas.
- Give every key a short description, in English and Chinese.
- Let the channel editor dialog go fullscreen.
- Keep the draft/save contract, the validator vocabulary, and the GitLab
  record field working without behavior changes beyond the new UI shape.

## Scope boundaries

- No change to the adapter's key vocabulary, validation, routing, or
  template substitution.
- No change to the draft representation (JSON string) or the save
  serializer.
- Fullscreen is added to `ChannelEditorDialog` only, not to the shared
  `ui/dialog` primitive.
- No searchable combobox; a grouped native-feel Select is sufficient for
  80 keys.

## Proposed changes

### 1. Option metadata (channel-base + SDK mirror)

Extend the option object in both mirrored type definitions (base and enum
shapes, two places per package) with two optional fields:

- `description?: string` — one-line meaning of the key, shown in the picker
  and under configured rows.
- `group?: string` — picker group identifier; options sharing a group render
  under one labeled section.

Both are additive and optional; existing plugins compile unchanged. The
mirror type test fails if only one side is edited. The registry's
management-metadata validation does not strip option keys, and the catalog
route passes fields through, so no daemon route change is needed.

### 2. GitHub descriptor content

`BOUND_ACTION_KEY_OPTIONS` gains, per option:

- `description`: 20 base texts (default fallback, 4 watch transitions,
  15 notification reasons). Role-qualified keys reuse their base event's
  description; the role's meaning comes from the group header.
- `group`: `'any'` for the 20 unqualified keys, otherwise the role name.

The `default` option's label becomes the plain key; its current
"fallback for any unmatched event" wording moves into the description.
The field description is rewritten shorter: what the templates do, the
key shape, the bound-delivery prerequisite, role fan-out in one sentence,
the variable list, `%%` escaping, and the empty-means-default rule.

### 3. Generic record renderer (ChannelEditorDialog)

- **Rows on demand.** Render one row per key present in the draft record,
  including keys the descriptor does not enumerate (stored data stays
  visible, editable, and removable — never silently dropped). Each row:
  the key in code style, a description line, a delete icon button, and a
  `Textarea` for the value.
- **Add picker.** A `Select` under the rows lists only unconfigured
  options, grouped via `SelectGroup` / `SelectLabel` when `group` is set.
  Items show the option label plus its description. Choosing one inserts
  the key with an empty value and resets the picker.
- **Empty values while editing.** A freshly added or cleared row keeps its
  key in the draft with an empty value; the explicit delete button removes
  the key. The save serializer already filters empty values
  (`parseRouteRecord`), so no empty entry can reach the daemon. This
  replaces the old clear-to-delete rule, whose comment is updated.
- **Delivery gating.** For GitHub `boundSessionActions` with
  `deliverToBoundSessions` off, the add picker is disabled and a hint names
  the prerequisite — the same pattern `prWatchEvents` uses. Existing rows
  stay editable and removable so turning delivery off never strands keys.
- **Placement.** `boundSessionActions` joins `BOUND_SESSION_FIELD_KEYS` so
  it renders inside the bound-sessions panel beside its prerequisite.
- **Empty state.** With no rows, one muted line says no entries are
  configured yet. The copy is generic because the renderer is shared with
  non-template record fields (message routes); the GitHub and GitLab
  template fields override it with template wording through their field
  label key, as they do the add-picker placeholder.

Description resolution for a row/picker item: translated
`...optionDescription.<value>` key, else the descriptor
`option.description`, else the translated option label when it differs
from the key (this keeps GitLab's descriptive labels working unchanged).

### 4. Fullscreen (ChannelEditorDialog only)

A header toggle button (Expand/Shrink icons, `common.fullscreen` /
`common.exitFullscreen` labels, `aria-pressed`) switches the dialog between
its current size and `calc(100vw - 2rem)` × `calc(100vh - 2rem)`. In
fullscreen the content becomes a flex column, the body loses its
`min(66vh, 650px)` cap and fills the remaining height. The state resets
when the dialog opens, alongside the other per-open resets.

### 5. i18n

- Rewritten `boundSessionActions` description (EN + ZH).
- zh-CN `...boundSessionActions.optionDescription.<key>` entries for the
  20 base keys. The 60 role-qualified entries are generated in `i18n.tsx`
  from the base entries (identical text; the group header carries the
  role), so the dictionaries stay maintainable. English needs no entries:
  the renderer falls back to the descriptor's own option descriptions,
  keeping a single source of truth.
- Group headers `...boundSessionActions.group.<any|review|verify|fix>`
  (EN + ZH), each naming the role's job.
- Record editor chrome: generic add-picker placeholder and empty-state
  line (entry-worded, since the renderer is shared with non-template record
  fields), template-worded overrides for the GitHub and GitLab fields,
  delete button aria-label, delivery-gating hint (EN + ZH).

## Design decisions

1. **Additive option metadata instead of client-side key parsing.** The
   renderer stays channel-agnostic; GitHub's role/event structure is
   declared by the plugin that owns the vocabulary. The existing mirror
   type test guards the two type definitions.
2. **Reuse the JSON-string draft contract.** No `channel-editor-state`
   change; required validation, the save filter, and the advanced-panel
   configured predicate keep working untouched.
3. **Generate role-qualified translations from base texts.** 20 zh-CN base
   descriptions + 4 group headers per language instead of 80 duplicated
   strings; a vocabulary change touches one place per language. English
   reuses the descriptor text through the renderer's fallback chain.
4. **Fullscreen local to the channel editor.** Migrating the dialog to
   `DialogShell` would change focus/IME behavior and the header layout for
   no extra benefit; a local toggle matches the approved scope.
5. **Gate adding, not editing.** Mirrors `prWatchEvents`: the prerequisite
   is named at the field before save, and stored keys remain clearable.

## Files affected

- `packages/channels/base/src/types.ts` — option `description`/`group`.
- `packages/sdk-typescript/src/daemon/types.ts` — mirrored option fields.
- `packages/channels/github/src/index.ts` — option descriptions/groups,
  shorter field description.
- `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`
  and `.module.css` — record renderer, gating, placement, fullscreen.
- `packages/web-shell/client/i18n.tsx` — texts above.
- Tests: `ChannelEditorDialog.test.tsx` (record interactions rewritten,
  new cases), `web-shell.channels.spec.ts` (new E2E cases).

## Constraints and risks

- The SDK and channel-base type mirrors must land in the same change; the
  mirror test enforces this.
- Stored records may contain keys outside the descriptor vocabulary; the
  renderer must keep them visible and removable.
- Radix Select renders all 80 items; grouped sections keep it navigable.
  If item count grows further, a searchable picker is the follow-up, not
  this change.
- GitLab's required record field must still fail validation when no
  non-empty template exists (unchanged `recordHasRoute` rule).

## Validation plan

- Unit: focused vitest in `packages/web-shell` for the editor dialog
  (rows-on-demand, add/delete, empty-value filtering on save, unknown
  stored keys, gating hint, fullscreen toggle, zh-CN texts) and the cli
  descriptor mirror/wire-shape tests.
- E2E: Playwright `web-shell.channels.spec.ts` with the mock daemon —
  add/edit/delete a template through the picker and assert the upsert
  payload; toggle fullscreen. The case is tagged `@smoke` so the CI smoke
  job (`test:e2e:smoke`, `--grep @smoke`) actually runs it. Baseline run
  before implementation must fail (feature absent).
- `npm run build && npm run typecheck` from the repository root.

## Acceptance criteria

- A fresh GitHub channel draft shows zero template rows and one add
  picker; the picker lists all 80 keys in 4 labeled groups with
  descriptions.
- Configured keys render as multi-line rows with descriptions and delete
  buttons; saving filters empty values and preserves untouched keys.
- With bound delivery off, adding is disabled with a hint naming the
  switch; existing rows remain removable.
- The dialog toggles fullscreen and back; the body fills the enlarged
  dialog.
- zh-CN shows translated descriptions, group headers, and chrome.
- GitLab's record field keeps its required validation and descriptive
  labels under the new renderer.

## Open questions

None blocking. A searchable picker and per-template character counters
are possible follow-ups if operators ask for them.
