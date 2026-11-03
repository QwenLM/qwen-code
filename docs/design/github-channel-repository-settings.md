# GitHub Channel Repository Settings in the Web Shell Editor

[English](github-channel-repository-settings.md) | [简体中文](github-channel-repository-settings.zh-CN.md)

Status: implemented in this change. Follows the merged editor usability work (#16096) and closes the
"per-repository settings remain editable only through `settings.json`" gap that
PR listed under Risk & Scope.

## Problem statement

Three settings decide how a GitHub Channel behaves, and none of them can be
changed from the Web Shell:

| Setting                                           | Scope          | What it controls                                           |
| :------------------------------------------------ | :------------- | :--------------------------------------------------------- |
| `groups["<owner/repo>"].senders` + `allowedUsers` | per repository | which GitHub accounts may start tasks in that repository   |
| `groups["<owner/repo>"].requireMention`           | per repository | whether an unmentioned comment is processed                |
| `pollInterval`                                    | channel        | how often the notifications API is polled, in milliseconds |

The editor today exposes only the channel-wide speaker default
(`groups["*"].senders` / `allowedUsers`) and the repository allowlist itself.
An operator who wants one repository restricted to two maintainers, or one
repository to answer without a mention, must hand-edit `settings.json` on the
daemon host and restart nothing — the value is simply invisible in the form.

The practical consequence is that the permissive default stays in place. The
channel-wide speaker default is `open`, so narrowing it means narrowing every
repository at once; the only way to narrow one repository is the file the form
does not show.

## Current state

- `packages/channels/github/src/index.ts` declares `token`, `useLocalGh`,
  `baseUrl`, `groupPolicy`, `reasonFilter`. It does not declare `pollInterval`,
  so the descriptor-driven form never renders it. The Email plugin already
  declares the same key as a `number` field with `exclusiveMinimum: 0` and
  `default: '60000'`, which is the precedent to follow.
- `GithubChannel extends PollingChannelBase`, whose `pollInterval` getter reads
  `config.pollInterval` and falls back to `60_000` when it is absent, not a
  finite number, or not positive.
- `GroupGate.check()` resolves `requireMention` as
  `groupConfigFor(chatId)?.requireMention ?? groups["*"]?.requireMention ?? true`,
  and returns `{allowed: false, reason: 'disabled'}` for a disabled policy before
  it reaches the mention gate. It contains no speaker logic at all.
- The speaker policy and members are resolved by `ChannelBase.groupSendersFor`
  and `groupAllowedUsersFor`: the per-group `senders` falling back to `"*"` and
  then to `open`, and the per-group `allowedUsers` falling back to `"*"` and then
  to `[]`. `senderGateFor` builds the gate from those two. Both classes' lookups
  go through the case-insensitive group matcher added by #16096.
- `channel-editor-state.ts` builds `groups` from the allowlist string, preserving
  each listed repository's stored settings verbatim, and writes the channel-wide
  speaker default into `groups["*"]`. Per-repository entries are carried through
  untouched; there is no draft state for them.
- The daemon already accepts exactly the edits this design needs.
  `channel-settings-store.ts` validates `groups.<id>.requireMention` as a
  boolean, `senders` as `open` or `allowlist`, and `allowedUsers` as a string
  array, and it validates descriptor-declared number fields against
  `exclusiveMinimum`. **The per-repository `groups` edits need no daemon, SDK or
  descriptor-schema change.** The poll-interval ceiling does extend the
  number-field descriptor with `maximum`, mirrored at five sites — see decision
  9 and the files table.

## Goals

1. Edit the speaker policy and allowlist of an individual allowlisted repository
   from the channel editor.
2. Edit `requireMention` for an individual allowlisted repository from the same
   place.
3. Edit the channel's poll interval from the same form.
4. Keep inheritance intact: a repository the operator has not customized must
   stay an empty override that inherits from `"*"` and then from the built-in
   default.

## Non-goals

- No change to any default value. The group-policy default divergence is tracked
  separately in #16144 and is deliberately out of scope here.
- No editing of `groups["*"].requireMention`, `dispatchMode`, or
  `groupHistoryLimit`. Those keys keep round-tripping untouched.
- No new descriptor field _kind_, and no per-repository UI for non-repository
  platforms. Chat platforms keep the current form. The number descriptor does
  gain a `maximum` bound (decision 9), which is a vocabulary extension mirrored
  into the SDK types, not a new kind.
- No repository picker backed by the GitHub API. Repositories are still typed as
  `owner/repo` in the allowlist field.

## Proposed solution

### Channel layer: declare the poll interval

Add one field to the GitHub plugin's management descriptor, mirroring Email:

```json
{
  "key": "pollInterval",
  "label": "Poll Interval (ms)",
  "kind": "number",
  "exclusiveMinimum": 0,
  "maximum": 86400000,
  "default": "60000"
}
```

The existing descriptor-driven path then renders, validates, and persists it
with no editor code. The editor's section map places it in **Connection**
alongside `baseUrl`, because it describes how the channel reaches GitHub rather
than who may use it.

The section map is keyed by field name, not by platform, so **Email's existing
`pollInterval` field moves from Credentials to Connection as well**. That is the
same setting meaning the same thing on a second polling platform, and it is
where the field belongs; scoping the map to GitHub would add a conditional just
to keep a misfiled field misfiled. No other platform declares the key.

A new channel's interval stays **empty**: the editor does not prefill number
fields from the descriptor default, so nothing is persisted until the operator
types a value and the runtime keeps owning its 60-second default. The declared
`default` documents the effective value on the wire, matching Email.

### Editor state: a tri-state override per repository

Add one draft field:

```ts
export interface ChannelGroupOverrideDraft {
  /** '' means inherit; otherwise the explicit boolean as a string. */
  requireMention: '' | 'true' | 'false';
  /** '' means inherit; otherwise the explicit policy. */
  senders: '' | 'open' | 'allowlist';
  allowedUsers: string;
}

// on ChannelEditorDraft
groupOverrides: Record<string, ChannelGroupOverrideDraft>;
```

Keys are canonical lower-case repository IDs, matching the keys `assignGroups`
already writes for repository-only channels.

- **Reading.** `createChannelEditorDraft` seeds one entry per stored repository
  key (excluding `"*"`), translating a stored `requireMention` boolean into
  `'true'` / `'false'` and an absent key into `''`. A stored `senders` becomes
  itself; absent becomes `''`. `allowedUsers` is joined with `, ` exactly like
  the channel-wide field. The reader is module-private and shared with the save
  path.
- **Writing.** `assignGroups` merges the draft override over the stored group
  object **field by field, comparing against that same reading of the stored
  object**. A field whose draft value still equals the stored reading keeps its
  stored key verbatim; only a changed field is written, and a changed field set
  back to `''` has its key deleted. Keys the editor does not model
  (`dispatchMode`, `groupHistoryLimit`, and anything unknown) are copied through
  untouched. A repository removed from the allowlist loses its entry, as today.
- **Why compare instead of overwrite.** Two stored shapes cannot be expressed by
  a tri-state control plus a text box: an empty allowlist (`allowedUsers: []`,
  meaning _nobody_) and a list with no policy beside it (`allowedUsers` without
  `senders`, meaning _inherit the policy, override the members_). A plain
  "write the parsed list, delete when empty" rule would turn both into something
  else on a save the operator meant as a no-op. Comparing against the initial
  reading makes an untouched field untouchable by construction, so the
  round-trip is exact without tracking dirty flags.
- **An explicit allowlist owns its list.** When the row's own policy is
  `allowlist`, an empty text box writes `[]` — nobody — rather than deleting the
  key and silently inheriting the channel-wide list. When the row inherits,
  clearing the text deletes the per-repository list so the channel-wide one
  applies again. The two cases are told apart by the merged group's `senders`.
- **Choosing the policy owns the list too, even if the text never moved.** This
  is the default state of a freshly added row, so it is the most likely path
  rather than an edge case: the operator picks "Allowlist only", leaves the box
  empty, and both readings of `allowedUsers` are `''`. A guard that only fires
  when the _text_ changed would skip the write, persist `{senders: 'allowlist'}`
  with no list, and the runtime's `??` would hand the channel-wide list straight
  back — the most restrictive action available would be a no-op that the UI
  reports as success. So the empty list is also written when the operator
  **changed the policy** to `allowlist` and the stored group has no list.
- **That rule is scoped to a changed policy, deliberately.** A stored
  `{senders: 'allowlist'}` with no `allowedUsers` is a legitimate hand-written
  shape meaning "allowlist policy, members inherited from `'*'`". Writing `[]`
  there would narrow a channel nobody edited — the same class of silent
  migration the compare-with-initial rule exists to prevent. Both directions
  are pinned by their own case and their own mutation.
- **Inheritance is the default.** A repository with no customization writes `{}`
  and keeps inheriting. The editor must never materialize `requireMention: true`
  or `senders: 'open'` into an untouched repository: doing so would freeze
  today's default into the configuration and silently stop a later change to
  `"*"` from reaching that repository.

### Editor UI: one row per allowlisted repository

Inside the existing Access control section, directly under the repository
allowlist field and only when the group policy is `allowlist`, render one block
per repository parsed from the allowlist string (same `toList` + lower-casing +
de-duplication the save path uses). Each block shows the repository ID as its
heading and three controls:

| Control          | Widget     | Values                                                                                                                  |
| :--------------- | :--------- | :---------------------------------------------------------------------------------------------------------------------- |
| Require mention  | select     | Inherit / Require a mention / Answer without a mention                                                                  |
| Who may speak    | select     | Inherit / Anyone / Allowlist only                                                                                       |
| Allowed speakers | text input | comma-separated GitHub logins, shown when the row's _effective_ policy is `allowlist` — its own, or the one it inherits |

The inherited value is named in the option label so the operator can see what
they are inheriting — for example `Inherit (require a mention)` when `"*"` or the
built-in default resolves to `true`. The resolution shown is the same
per-repository → `"*"` → built-in order the runtime uses. The speaker input is
gated on the effective policy rather than the row's own, because a repository
that inherits an allowlist still has a member list worth editing; its helper
text says that leaving it empty uses the channel-wide list.

The row's option labels and placeholder are repository-specific (`Anyone`,
`Allowlist only`, `alice, bob`). Reusing the shared group-speaker strings would
put `Any group member`, `Listed members only`, and `user-a, user-b` back into a
GitHub form — the exact chat/repository mismatch #16096 removed.

Each row is a `role="group"` labelled by its own repository heading. Without
that, every row's controls would share the accessible names "Require a mention"
and "Who may speak", and a screen-reader user could not tell which repository
they were editing once more than one is listed.

Rows are derived from the allowlist on every render, so typing a repository adds
its row immediately and deleting it removes the row. Override state for a
removed repository is dropped on save by `assignGroups`; no separate cleanup
step is needed.

Use a native `<input type="checkbox">` if a boolean toggle is preferred over a
select; #16096 established that a Radix `Checkbox` inside this `<form>` and
`Dialog` triggers an infinite update loop. This design uses selects for both
tri-state controls, which avoids the question entirely and expresses "inherit"
as a first-class value.

### Copy

New i18n keys in both locales for the section heading, the three controls, their
options, and the inherited-value hints. No string may begin with `settings.` —
the transcript build-artifact guard rejects that prefix.

## Files affected

| File                                                                           | Change                                                 |
| :----------------------------------------------------------------------------- | :----------------------------------------------------- |
| `packages/channels/github/src/index.ts`                                        | declare `pollInterval` with both bounds                |
| `packages/channels/base/src/types.ts`                                          | `maximum` on the number descriptor                     |
| `packages/channels/base/src/PollingChannelBase.ts`                             | clamp the interval to the ceiling                      |
| `packages/sdk-typescript/src/daemon/types.ts`                                  | mirror `maximum` on the wire descriptor                |
| `packages/cli/src/commands/channel/channel-registry.ts`                        | validate `maximum` metadata                            |
| `packages/cli/src/serve/channel-settings-store.ts`                             | enforce `maximum`; tolerate an unchanged stored number |
| `docs/developers/qwen-serve-protocol.md`                                       | document `maximum` in the descriptor vocabulary        |
| `packages/web-shell/client/components/channels/channel-editor-state.ts`        | override draft type, read, merge-on-write              |
| `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`        | per-repository rows, `pollInterval` section mapping    |
| `packages/web-shell/client/components/channels/ChannelEditorDialog.module.css` | row layout                                             |
| `packages/web-shell/client/i18n.tsx`                                           | EN + ZH copy                                           |
| `packages/web-shell/client/components/channels/channel-editor-state.test.ts`   | state round-trip, inheritance, preservation, sweep     |
| `packages/web-shell/client/components/channels/ChannelEditorDialog.test.tsx`   | rendering and interaction                              |
| `packages/web-shell/client/e2e/visuals/screenshots.spec.ts`                    | capture the new rows                                   |
| `docs/users/features/channels/github.md`                                       | document that the editor now exposes these settings    |
| `docs/users/features/channels/gitlab.md`                                       | document the ceiling for the other polling channel     |
| `docs/users/features/channels/overview.md`                                     | point the group-settings section at the new rows       |
| `docs/design/channels/channel-code-hosting.md`                                 | state the clamp in the shared polling contract         |
| `packages/channels/github/src/GithubAdapter.test.ts`                           | ceiling, clamp and declared bounds                     |
| `packages/cli/src/commands/channel/channel-registry.test.ts`                   | `maximum` metadata validation                          |
| `packages/cli/src/commands/channel/channel-descriptor-sdk-mirror.test.ts`      | `maximum` in the mirrored key set                      |
| `packages/cli/src/serve/channel-settings-store.test.ts`                        | ceiling enforcement and the unchanged-value tolerance  |

## Design decisions and rationale

1. **Editor-only for per-repository settings, descriptor field for the poll
   interval.** A new descriptor field kind would touch the SDK, the daemon
   validation mirror, and every client that renders descriptors, for a shape
   only one platform family uses. The editor already special-cases
   repository-only channels and already writes `groups`, so the per-repository
   rows belong there. The poll interval is an ordinary channel-level scalar, so
   it takes the ordinary descriptor route.
2. **Tri-state, not boolean.** `GroupConfig` distinguishes absent from `false`.
   A two-state control could not express "inherit", and defaulting it to the
   resolved value would write that value into every repository on the first
   save — a silent, widening-or-narrowing migration depending on the channel.
3. **Rows derived from the allowlist, not stored separately.** One source of
   truth for membership means a repository cannot have settings without being
   admitted, and the alias-conflict and `owner/repo` validation from #16096 keep
   applying to the same string.
4. **Lower-case keys.** GitHub repository paths are case-insensitive and #16096
   made the runtime match them that way. Override keys use the same canonical
   form so a retyped case does not orphan a repository's settings.
5. **No new validation for an empty speaker allowlist.** Under an explicit
   `allowlist` an empty list means "nobody", which is a legitimate configuration
   and is already how the channel-wide field behaves. Under an inherited policy
   an empty text box means "no per-repository list", so the channel-wide one
   applies. Adding a rejection here would make the two controls disagree.
6. **`inherit` is a sentinel, not the empty string.** Radix `Select.Item` rejects
   an empty `value`, so the controls map `''` to `'inherit'` at the widget
   boundary and back on change. The draft keeps `''`, which is what makes the
   comparison against the stored reading straightforward.
7. **Switching a row to "Anyone" keeps a speaker list that has names in it.**
   The list is inert under an open policy, and deleting it would destroy work the
   operator may want back when they return to an allowlist. An **empty** list is
   the exception: it is released, because leaving it behind would keep denying
   everyone while the row reads as inheriting. Only the field the operator
   actually changed is written, which is the same rule that makes an untouched
   save a no-op.
8. **The hint is derived from the save projection of an empty box, not the
   draft.** The sentence under the box describes what _leaving it empty_ does,
   so the row calls the same `projectRepositoryGroup` the save path calls with
   `{ ...override, allowedUsers: '' }` and asks whether the result owns an
   `allowedUsers` array. Projecting the current draft instead told a repository
   storing a list with no policy beside it "nobody", while clearing that box
   deletes the list and widens the repository back to the channel-wide members.
   Reading the hint off `override.senders` alone is wrong for the same reason,
   and no amount of care keeps two independent derivations in sync across later
   edits.
9. **The poll interval gets a real upper bound in the descriptor vocabulary.**
   `maximum` joins `exclusiveMinimum` on number fields, mirrored in the SDK, the
   registry's metadata validation, the store, and the editor. Node clamps a
   timeout above its 32-bit range to 1 ms, so an unbounded interval field lets
   the form persist a hot loop that burns the API quota. The ceiling is
   86 400 000 ms, the same one Email already enforces at runtime, and
   `PollingChannelBase` clamps to it — rather than falling back to 60 s — so a
   hand-written configuration cannot hot-loop either, and an interval between
   one day and Node's limit keeps most of its intent instead of being replaced.
   DWS overrides the getter with a constant and Email does not extend the base,
   so GitHub and GitLab are the only channels the clamp reaches.
10. **A newly declared bound forgives an unchanged stored number, and only its
    range.** The editor re-sends stored values verbatim, so declaring
    `pollInterval` would otherwise block every unrelated edit to a channel
    storing `0` — a value `PollingChannelBase` deliberately tolerates by falling
    back to 60 s. Both the editor and the store skip the range check when the
    value is a finite number deep-equal to what is stored. The tolerance is
    deliberately **not** generalized to all kinds: an existing contract test
    pins that an unchanged stored scalar of the wrong type is still re-validated
    and rejected, and that is the right rule — a type error should be fixed, a
    tolerated range should not strand the operator.
11. **Settings that outlive the policy are named, not deleted.** Per-repository
    senders and `requireMention` are resolved without consulting `groupPolicy`,
    so under `open` and `pairing` they stay enforced after the rows disappear.
    Under `disabled` the group gate drops every envelope before either lookup,
    so the entries are retained but inert — the alert says which of the two
    cases applies rather than claiming they all still apply. Deleting them would
    destroy hand-written configuration; instead the editor lists the
    repositories that still carry settings and says how to edit them. Row edits
    made before the switch are projected in that branch too, so the save cannot
    report success while restoring the stored value.
    That branch runs for every repository-only channel, not only one whose
    stored policy was `allowlist`: the rows are reachable from any policy, so
    gating on storage dropped the edits of an operator who switched to
    Allowlist, narrowed a repository and switched back before saving. It also
    unions the typed allowlist with the stored keys, because a repository
    added during that visit exists only in the draft. Conflicting aliases are
    the exception — one lower-cased draft cannot speak for two spellings that
    disagree, so both are left exactly as stored and the Allowlist path's
    conflict error stays the way to resolve them.

## Constraints

- The daemon's stored-value guard rejects an invalid nested type, so the editor
  must write a real boolean for `requireMention` and a real string array for
  `allowedUsers` — not strings.
- Existing tests pin that untouched per-repository keys survive a save
  (`dispatchMode`, `groupHistoryLimit`, `requireMention`). The merge must be
  additive over the stored object, never a replacement.
- The repository allowlist may be empty or contain an invalid entry while the
  operator is typing. Rows render only for entries that parse as `owner/repo`;
  the existing validation error still blocks the save.
- `pollInterval` must stay optional. An empty input deletes the key so the
  runtime keeps its own 60-second default rather than persisting a number the
  operator never chose.

## Risks

- **Widening access by accident.** Choosing "Anyone" for a repository that
  inherited an allowlist widens it. The option label names the inherited value
  so the change is visible before saving, and the row shows the effective
  policy, not just the draft.
- **Freezing defaults.** Materializing inherited values would be a silent
  migration. The tri-state model and a test that asserts an untouched repository
  still saves as `{}` guard against it.
- **Losing hand-written settings.** The merge preserves unknown keys; the
  existing preservation tests are the guard, and a new case covers a repository
  that has both an unknown key and an edited known key.
- **Scope creep into other platforms.** The rows are gated on the same
  `isRepositoryOnlyChannelType` helper #16096 introduced, so chat platforms are
  untouched by construction.

## Validation plan

- Unit: state round-trip (read → save is a no-op for an untouched channel),
  explicit override writes, inherit deletes the key, unknown keys preserved,
  removed repository drops its entry, case-retyped repository keeps its
  settings, empty allowlist, invalid repository entry.
- Invariant sweep: twelve stored shapes crossed with every single-field edit,
  driven through the real save path rather than the projection alone — an
  untouched row reproduces its stored object byte-for-byte, the empty-box hint
  agrees with what that save admits, and no edit widens the admitted set unless
  the row's own controls asked for it. A second sweep crosses the same shapes
  with the stored and final group policies, because the runtime never consults
  `groupPolicy` when resolving speakers: a row must write the same entry, and
  admit the same people, whichever policy the save lands on. It covers a
  repository that exists only in the draft as well as a stored one.
- Non-Allowlist saves: a row narrowed during a temporary switch survives on a
  channel stored Open, a repository added during that visit is written rather
  than dropped, conflicting aliases are left as stored while the Allowlist
  path still refuses them, an untouched channel round-trips byte-for-byte,
  and a chat platform gains no entries from the typed allowlist. Each asserts
  the admitted set, not only the saved shape.
- Component: rows appear per allowlisted repository, typing a repository adds a
  row, the speaker input appears when the row's **effective** policy is an
  allowlist — its own or the inherited one — and is hidden when it is `open`,
  the inherited hint reflects `"*"`, each row shows and edits only its own
  speakers, the hint's wording follows what an empty box will save rather than
  the draft policy, repositories whose settings outlive the policy are named,
  and the poll interval renders in Connection in both locales.
- Mutation: each behavioural claim above is pinned by introducing the
  corresponding mutation and confirming exactly the describing cases fail.
- Build guards: the three vite builds plus `client/build-artifact.test.ts`,
  because new copy enters the transcript bundle.
- Visual: the repository's own visuals harness, both themes, with an assertion
  that the per-repository rows exist before capture.
- Manual: against a real daemon, save a repository override and confirm the
  stored `settings.json` contains the boolean and array shapes the store
  validates.

## Acceptance criteria

1. A GitHub Channel's poll interval can be set, cleared, and validated from the
   editor between 1 and 86400000 ms; an empty input leaves the key absent, and a
   stored value outside the bounds does not block an unrelated edit.
2. Each allowlisted repository shows a require-mention control and a speaker
   control whose default is "inherit".
3. Saving an untouched channel writes exactly the same `groups` object it read.
4. An explicit override writes a boolean `requireMention` and, for an allowlist,
   a string array `allowedUsers`. Returning the **policy** to "inherit" removes
   the policy key; a speaker list the operator typed survives until the box is
   cleared too, and an empty list left behind by a policy the operator abandoned
   is released so inheritance really returns the channel-wide members.
5. Keys the editor does not model survive a save unchanged.
6. No chat platform's form changes. Email's poll interval moves to Connection
   alongside GitHub's, because the section map is keyed by field name.
7. Both locales render the new copy, and the build-artifact guard passes.
8. The speaker hint describes what an empty box will save, so a stored allowlist
   with no list reads as inheriting and a stored empty list reads as nobody.
9. Repositories whose settings outlive a switch away from the allowlist policy
   are named in the editor rather than becoming invisible while still enforced.
10. A repository narrowed during a temporary switch to Allowlist keeps that
    narrowing when the save lands on another policy, including on a channel
    that was never Allowlist and a repository added during the visit;
    conflicting aliases are left as stored instead of being rewritten from
    one draft.

## Open questions

- Should the channel-wide `"*"` require-mention default also become editable?
  It is the value every repository inherits, and today it is only reachable
  through `settings.json`. Left out of this change to keep the diff about
  per-repository control; worth a follow-up decision.
- Should the poll interval be expressed in seconds in the UI? Milliseconds
  match the stored key and the Email plugin's existing label, so this design
  keeps milliseconds for consistency.
