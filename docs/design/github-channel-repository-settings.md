# GitHub Channel Repository Settings in the Web Shell Editor

[English](github-channel-repository-settings.md) | [简体中文](github-channel-repository-settings.zh-CN.md)

Status: proposed. Follows the merged editor usability work (#16096) and closes the
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
  and the speaker policy as the per-group `senders` falling back to `"*"` and
  then to `open`. Both lookups go through the case-insensitive group matcher
  added by #16096.
- `channel-editor-state.ts` builds `groups` from the allowlist string, preserving
  each listed repository's stored settings verbatim, and writes the channel-wide
  speaker default into `groups["*"]`. Per-repository entries are carried through
  untouched; there is no draft state for them.
- The daemon already accepts exactly the edits this design needs.
  `channel-settings-store.ts` validates `groups.<id>.requireMention` as a
  boolean, `senders` as `open` or `allowlist`, and `allowedUsers` as a string
  array, and it validates descriptor-declared number fields against
  `exclusiveMinimum`. **No daemon, SDK, or descriptor-schema change is required.**

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
- No new descriptor field kind, no SDK change, and no per-repository UI for
  non-repository platforms. Chat platforms keep the current form.
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
text says that leaving it empty keeps the channel-wide list.

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

| File                                                                           | Change                                              |
| :----------------------------------------------------------------------------- | :-------------------------------------------------- |
| `packages/channels/github/src/index.ts`                                        | declare `pollInterval`                              |
| `packages/web-shell/client/components/channels/channel-editor-state.ts`        | override draft type, read, merge-on-write           |
| `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`        | per-repository rows, `pollInterval` section mapping |
| `packages/web-shell/client/components/channels/ChannelEditorDialog.module.css` | row layout                                          |
| `packages/web-shell/client/i18n.tsx`                                           | EN + ZH copy                                        |
| `packages/web-shell/client/components/channels/channel-editor-state.test.ts`   | state round-trip, inheritance, preservation         |
| `packages/web-shell/client/components/channels/ChannelEditorDialog.test.tsx`   | rendering and interaction                           |
| `packages/web-shell/client/e2e/visuals/screenshots.spec.ts`                    | capture the new rows                                |
| `docs/users/features/channels/github.md`                                       | document that the editor now exposes these settings |

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
7. **Switching a row to "Anyone" keeps its stored speaker list.** The list is
   inert under an open policy, and deleting it would destroy work the operator
   may want back when they return to an allowlist. Only the field the operator
   actually changed is written, which is the same rule that makes an untouched
   save a no-op.

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
- Component: rows appear per allowlisted repository, typing a repository adds a
  row, the speaker input appears only for an explicit allowlist, the inherited
  hint reflects `"*"`, and the poll interval renders in Connection.
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
   editor, and an empty input leaves the key absent.
2. Each allowlisted repository shows a require-mention control and a speaker
   control whose default is "inherit".
3. Saving an untouched channel writes exactly the same `groups` object it read.
4. An explicit override writes a boolean `requireMention` and, for an allowlist,
   a string array `allowedUsers`; returning a control to "inherit" removes the
   key again.
5. Keys the editor does not model survive a save unchanged.
6. No chat platform's form changes. Email's poll interval moves to Connection
   alongside GitHub's, because the section map is keyed by field name.
7. Both locales render the new copy, and the build-artifact guard passes.

## Open questions

- Should the channel-wide `"*"` require-mention default also become editable?
  It is the value every repository inherits, and today it is only reachable
  through `settings.json`. Left out of this change to keep the diff about
  per-repository control; worth a follow-up decision.
- Should the poll interval be expressed in seconds in the UI? Milliseconds
  match the stored key and the Email plugin's existing label, so this design
  keeps milliseconds for consistency.
