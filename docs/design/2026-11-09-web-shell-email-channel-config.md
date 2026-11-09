# Web Shell Configuration Support for the Email Channel

[English](2026-11-09-web-shell-email-channel-config.md) | [简体中文](2026-11-09-web-shell-email-channel-config.zh-CN.md)

Status: implemented. Unit, DOM, plugin-parity and real-daemon verification pass
locally. The browser E2E group is written but blocked by a pre-existing
environment issue; see [Validation plan](#validation-plan).

## Problem statement

The Email channel is a fully shipped built-in channel. `packages/channels/email`
provides IMAP polling and SMTP replies, is registered in the CLI channel
registry, declares complete management metadata, and has user documentation
(`docs/users/features/channels/email.md`) plus a hosted adapter used by
`managed-agent-server`.

The Web Shell cannot configure it. `SUPPORTED_CHANNEL_TYPES` in
`packages/web-shell/client/components/channels/channel-platform.ts` is a
hard-coded allowlist of seven platforms (`dingtalk`, `dws`, `wecom`,
`wecom-callback`, `feishu`, `github`, `gitlab`) that does not include `email`.

That allowlist has two consumers in `ChannelsManagerPage.tsx`, so the gap has
two effects:

| Consumer                                                                                     | Effect on Email                                                                           |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `catalog.filter(isChannelPlatformAvailable)` — the "add channel" picker                      | Email cannot be selected                                                                  |
| `Object.values(channels).filter(isSupportedChannelType(...))` — the configured-instance list | An Email channel already present in `settings.json` is **omitted from the page entirely** |

The second effect is the more serious one: the channel is running, but the
management page shows no trace of it, which reads as "the configuration did not
take effect".

This is an omission rather than a deliberate exclusion. The commit that added
the channel (`612a5529599`, `feat(channels): add IMAP and SMTP email channel
(#12939)`) touches no file under `packages/web-shell`. Sibling platforms each
received an explicit front-end admission change, for example `41f0e3ca5d0`
(`feat(channels): add Web Shell management support for GitHub and GitLab
(#8310)`).

## Current state

### The daemon already advertises Email as manageable

`supportedChannelCatalog()` in
`packages/cli/src/commands/channel/channel-registry.ts` reports
`manageable: management !== undefined`. The Email plugin declares `management`
with seventeen fields and a `validateConfig` hook, so the daemon has been
advertising Email as a manageable type all along. The front-end allowlist is the
only gate.

### Shared access fields are injected unless the plugin declares them

`managementFieldsWithSharedControls()` appends `SHARED_ACCESS_FIELDS` filtered by
`!declared.has(field.key)`. For Email this produces:

| Field                                  | Declared by Email?                                                | Result                                                                   |
| -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `privatePolicy`                        | Yes — enum `disabled` / `allowlist` / `open`, default `allowlist` | The shared variant (default `pairing`) is **not** injected               |
| `groupPolicy`                          | No                                                                | Injected: enum, `required: true`, default `disabled`, includes `pairing` |
| `allowedUsers`, `operators`            | No                                                                | Injected — both are meaningful for Email                                 |
| `messageRoutes`, `defaultMessageRoute` | No                                                                | Injected — supported by Email (ChannelBase routing)                      |
| `sessionScope`                         | No                                                                | Injected with the plugin default `chat_thread`                           |
| `multiSession`, `instructions`         | No                                                                | Injected                                                                 |
| `outputMode`                           | `supportsOutputMode` unset                                        | Not injected                                                             |

Two consequences follow. First, the concern that a new Email channel would be
created with `privatePolicy: "pairing"` — a value the adapter does not support —
does not arise: the plugin's own enum wins, and the editor takes the
descriptor-declared policy path (`hasDescriptorPrivatePolicy`) instead of the
four-card radio group that offers `pairing`.

Second, Email receives a `groupPolicy` control it can never use.
`packages/channels/email/src/email-channel.ts` builds every envelope with
`isGroup: false`, so no group gate is ever consulted. The injected control is
inert, and selecting `pairing` on it would additionally surface a pairing panel
that can never receive a request.

### The mirror-image problem already has a precedent

GitHub is repository-only: every envelope is group traffic, so the injected
_private_ fields are meaningless. The codebase models this with
`REPOSITORY_ONLY_CHANNEL_TYPES` / `isRepositoryOnlyChannelType()` in
`channel-platform.ts` and `PRIVATE_ONLY_FIELD_KEYS` in `channel-editor-state.ts`.
The save path skips those fields, deletes them from the built config, and the
dialog filters them out of the access section.

Email is the exact opposite shape — private-only — and needs the symmetric
treatment for the injected _group_ fields.

### Omitting `groupPolicy` is legal

`WorkspaceChannelSettingsStore.upsert()` validates through
`assertManagedConfig(..., plugin.management.fields)` — the **raw plugin fields**,
not the catalog descriptor with shared injection. `assertRequiredFields`
therefore only enforces Email's own required keys. `groupPolicy` is instead
handled by `assertSharedField()` as an optional enum. A save that omits it is
accepted.

### Secrets and environment references are already preserved

For a `preserve` operation on a field marked `envResolvable`, the store restores
the on-disk `$VAR` reference rather than the resolved literal. The Email plugin
marks all seven required fields `envResolvable: true`, so preserving
`imapPassword` / `smtpPassword` keeps `$AGENT_IMAP_PASSWORD` intact. This needs a
regression test, not new code.

### Labels are the one real rendering gap

`fieldLabel()` in `ChannelEditorDialog.tsx` resolves
`FIELD_LABEL_KEYS[type]?.[key] ?? SHARED_FIELD_LABEL_KEYS[key]` and otherwise
falls back to the descriptor's `label`. The Email plugin builds its seven
required fields with `label: key`, so without an override the form would render
raw identifiers (`imapHost`, `smtpPassword`) as field labels. Every sibling
plugin declares human-readable English labels (`'Client ID'`,
`'Personal Access Token'`); Email is the only outlier.

## Goals

1. Email can be created and edited from the Web Shell channel manager.
2. An Email channel configured outside the Web Shell is listed by the manager.
3. The editor presents no control that the Email adapter cannot act on.
4. Saving preserves what the editor does not model, including `$VAR` references.
5. Field labels render as readable text in both English and Chinese.

## Scope boundaries

In scope: the Web Shell allowlist, the private-only handling symmetric to the
existing repository-only handling, Email field labels and their translations,
and the seven raw-key labels in the Email plugin descriptor.

Out of scope, with reasons:

- **Admitting `telegram`, `weixin`, `qqbot`.** The allowlist exists so each
  platform is admitted once its editor experience is verified. Admitting four
  platforms at once would multiply every risk below by four.
- **Provider OAuth (XOAUTH2), rich HTML output, pairing for Email.** Explicitly
  outside the adapter's current version; no front-end change can supply them.
- **`multiSession` gating.** The injected toggle has the same interaction with a
  `chat_thread` default on `github`, `gitlab`, and `dws`, which are already
  admitted. Any defect there is inherited and shared, not Email-specific.
- **Saving a required secret whose `$VAR` is unset in the daemon environment.**
  The editor drafts an empty replacement and the store rejects it. This is
  shared behavior for every channel with env-resolvable secrets.
- **Replacing the allowlist with `manageable` alone.** A larger product decision;
  recorded as a follow-up question below.

## Proposed changes

### Channel platform module

`packages/web-shell/client/components/channels/channel-platform.ts`:

- Add `email` to `SUPPORTED_CHANNEL_TYPES` and to the `isSupportedChannelType`
  return union.
- Add `PRIVATE_ONLY_CHANNEL_TYPES` and `isPrivateOnlyChannelType()`, shaped like
  the existing repository-only pair.
- Do **not** add a `PLATFORM_MARKS` entry. Both call sites already fall back to
  `displayName[0].toUpperCase()`, which yields `E`; an explicit entry would be a
  no-op line.

### Editor state

`packages/web-shell/client/components/channels/channel-editor-state.ts`:

- Add `GROUP_ONLY_FIELD_KEYS` containing `groupPolicy`, documented as the mirror
  of `PRIVATE_ONLY_FIELD_KEYS`.
- `createChannelEditorDraft()` and `buildChannelUpsertRequest()` skip group-only
  fields for a private-only channel. Skipping in **both** is required: omitting
  the key only from the draft would leave `assignField()` to read `undefined`
  and delete the stored value.
- Guard the `hasDescriptorGroupPolicy(descriptor)` block in the save path with
  `!privateOnly`, so `assignGroups()` and `assignGroupSenders()` never run for
  Email.

Stored `groupPolicy` and `groups` keys are **preserved, not deleted**. The
repository-only path deletes its injected fields because a stale private
allowlist would otherwise be presented as authoritative by the pairing panel.
Once the group controls are neither rendered nor read for Email, a stored group
key cannot surface that panel, so there is no comparable harm and no reason to
discard user data.

### Editor dialog

`packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`:

- Add an `email` entry to `FIELD_LABEL_KEYS`.
- In the access section, filter group-only fields out of the rendered access
  fields and resolve the effective group policy to `''` for a private-only
  channel, mirroring how `repositoryOnly` resolves the effective private policy
  to `''`. This suppresses the group policy selector, the allowed-group-IDs
  input, the group senders select, and any group-derived pairing panel.

### Translations

`packages/web-shell/client/i18n.tsx`: add `channels.editor.field.email.*` label
keys in both the English and Chinese tables for the seventeen Email-declared
fields that are not covered by `SHARED_FIELD_LABEL_KEYS`. Add a `.description`
entry only where it carries information the label does not, such as the
STARTTLS fallback on the two TLS switches and the exact-match rule on
`proactiveRecipients`. That is 17 label keys plus 3 description keys per
language, 40 entries in total.

### Email plugin descriptor

`packages/channels/email/src/index.ts`: replace `label: key` on the seven
required fields with readable English labels, matching every sibling plugin.
The descriptor is a public contract carried by `DaemonChannelTypeDescriptor`, so
the fallback should be readable for any client, not only the Web Shell.

### Dependencies

`packages/web-shell/package.json`: add `@qwen-code/channel-email` as a
devDependency, mirroring the existing `@qwen-code/channel-github` entry, so a
parity test can drive the real plugin descriptor. Update `pnpm-lock.yaml`.

### User documentation

`docs/users/features/channels/email.md`: record that the channel can be created
and edited in the Web Shell, and that the editor hides the group controls while
leaving any stored `groupPolicy` / `groups` untouched.

`docs/users/features/channels/overview.md`: the Group Chats section already
documents the repository-only case for `github` and `gitlab`; add the opposite
Email case beside it so the two exceptions are stated together.

## Key design decisions

| Decision                                                                | Rationale                                                                                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Model Email as private-only on the client, symmetric to repository-only | Follows an existing, tested pattern; no channel contract change and no cross-package escalation                                        |
| Do not add a `supportsGroups` plugin capability                         | A contract change across `channel-base`, the registry, and every adapter for one platform's UI concern is disproportionate             |
| Preserve stored group keys instead of deleting them                     | No admission effect, verified at the gate rather than assumed — see below. Discarding user configuration is not reversible from the UI |
| Fix the seven plugin labels as well as adding i18n overrides            | The descriptor is public; `label: key` is an outlier against every sibling and would degrade any non-Web-Shell client                  |
| Add a parity test driven by the real plugin                             | A hand-built descriptor fixture cannot detect drift between the plugin's field list and the editor's assumptions                       |

The preserve-not-delete decision was checked at the gate instead of argued from
the UI. `GroupGate.check()` returns `{ allowed: true }` for any envelope with
`isGroup` false **before** it reads the policy or the pairing store, and Email
builds every envelope that way, so no group setting can admit or reject anyone.
`SenderGate` reads the pairing store only under a `pairing` private policy, which
Email's enum cannot express.

One residual side effect is real and was measured, not dismissed: a preserved
`groupPolicy: "pairing"` still makes the channel construct a pairing store and
enables the daemon's pairing management routes. It is inert — the group gate
creates requests only for group envelopes and the private gate only under a
pairing policy, so neither can ever create one; approval always reports
not-found, the approval list is empty, and the editor renders no pairing panel.
The store is keyed by channel name and workspace, so there is no cross-channel
effect. Deleting the stored key would remove that inert residue, at the cost of
silently discarding configuration the operator may still want.

## Constraints

- The editor is shared by every admitted platform. Changes to the access section
  must not alter behavior for `dingtalk`, `dws`, `wecom`, `wecom-callback`,
  `feishu`, `github`, or `gitlab`.
- `groupPolicy` must remain optional for Email at the daemon boundary; the
  built config is validated against raw plugin fields.
- Both language tables must be updated in the same change, and each language
  must be rendered by a test.

## Risks

| Risk                                                                        | Mitigation                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| The private-only gate leaks into a sibling platform                         | Keep the predicate keyed on an explicit set containing only `email`; assert the existing platforms still render group controls |
| Skipping a field in the draft but not the save deletes stored configuration | Skip in both paths; add a test that a stored `groupPolicy` survives an unrelated save                                          |
| A translation key exists in only one language                               | Render the editor under both locales in tests                                                                                  |
| The parity fixture drifts from the plugin                                   | Import the plugin in the test rather than restating its fields                                                                 |

## Validation plan

1. Focused vitest suites in `packages/web-shell`:
   `channel-platform.test.ts`, `channel-editor-state.test.ts`,
   `ChannelEditorDialog.test.tsx`, `ChannelsManagerPage.test.tsx`,
   `channel-editor-parity.test.ts`.
2. Playwright `client/e2e/web-shell.channels.spec.ts` with a mock daemon that
   advertises an Email descriptor and stores an Email instance: the instance is
   listed and its editor opens without group controls.
3. A real-daemon round trip: `qwen serve` against a workspace whose
   `settings.json` declares an Email channel with `$VAR` passwords; confirm the
   catalog reports Email as manageable, the instance is returned, and an
   unrelated upsert preserves the references on disk.
4. Repository gates: `npm run build`, `npm run typecheck`, `npm run lint`,
   `npm run format`, plus the focused suites above.

### Verification results

| Group                                    | Result                         |
| ---------------------------------------- | ------------------------------ |
| 1 — vitest (whole `channels/` directory) | 451 passed                     |
| 1 — Email adapter package                | 82 passed                      |
| 1 — CLI catalog consumers                | 8 passed                       |
| 2 — Playwright browser E2E               | **Blocked**, see below         |
| 3 — real-daemon round trip               | 9/9 passed on the local bundle |
| 4 — build / typecheck / lint / prettier  | passed                         |

The web-shell count moved 385 → 449 → 451: 385 before the code review below, 449
after the review's added cases, and 451 once the branch incorporated `main`,
which brought two upstream `prCommentWatch` cases into the same parity file.
A full `packages/web-shell` run during review reported 15598 passed, and
`packages/cli` timed out on unrelated files whose failure set drifted between
runs — no verdict for that suite, not attributed to this change.

The full `npm run lint` gate reports 658 errors in this checkout, all of them in
`packages/sdk-java/qwencode/target/reports/apidocs/` — untracked local Javadoc
output that does not exist in CI. With that directory excluded the gate exits 0,
and no error-bearing file lies outside it.

The daemon probe was run against both the shipped `qwen` 0.27.0 and the local
bundle. Eight checks pass on both, confirming the daemon side was already
complete. The ninth — readable required-field labels on the wire — fails on the
shipped binary (`label: "imapHost"`) and passes on the local bundle
(`label: "IMAP Host"`), which is the witness for the descriptor change.

Reverting the four front-end production files to `HEAD` while keeping the new
tests turns 12 of them red, including the manager-listing case with
`expected … to contain 'Agent Mailbox'`. That confirms the new cases are
witnesses rather than tests that pass on the unfixed tree. One case was found
vacuous during this check and corrected: the English label test originally used
a fixture carrying the finished label text, so it passed with the entire i18n
layer removed. The fixture now carries raw keys and a placeholder description.

**Browser E2E blocker.** The Playwright group cannot run in this checkout:
`node_modules/playwright` and `node_modules/@playwright/test/node_modules/playwright`
are two separate copies of 1.61.1, so the runner and the spec load different
module instances and `test()` is rejected with "Playwright Test did not expect
test() to be called here". An untouched spec fails identically, and the lockfile
diff for this change is only the new devDependency link, so the condition
predates it. The case is committed and should run in CI, where the install is a
clean `--frozen-lockfile` pnpm tree.

### Code review outcome

A ten-agent review pass over the captured diff found one Critical that the
implementation and its tests had both missed, plus several coverage gaps. All
were verified against the code before acting.

**Critical at the original base — implicit TLS silently downgraded on save.**
`initialFieldValue()` seeded every absent boolean from `false`, ignoring
`field.default`. Email's `imapSecure` / `smtpSecure` declare `default: 'true'`,
and `assignField()` always writes an explicit boolean, so creating an Email
channel in the editor — or opening a CLI-configured one and saving an unrelated
edit — persisted both as `false`, moving the mailbox from implicit TLS on 993/465
to STARTTLS on 143/587. At the base this work started from (`7ad260bceb`), Email's
two switches were the only boolean fields in any channel plugin declaring a true
default, so no admitted platform could reach the defect.

**Resolved upstream while this work was in progress.** That base was 16 commits
behind main. Rebasing showed `e867340c68` (#16602) had already landed the
identical one-line fix — `field.default === 'true'` — for GitHub's new
`prCommentWatch`, which is the other true-default boolean on the current tree.
The production line is therefore upstream's and is no longer part of this diff;
the rebase conflict was resolved by taking upstream's comment verbatim, and the
parity file keeps both upstream's GitHub block and the Email block added here.

What this PR keeps is the Email-specific regression coverage. Two parity cases
drive the real Email plugin descriptor and pin the draft seed, the saved value,
and the unrelated-edit path; upstream's case covers `prCommentWatch` only, so
without these a future change could re-break Email's TLS defaults unnoticed.
Measured against the original base, reverting that one line turned both Email
cases red with `expected false to be true`.

**Other findings acted on:**

| Finding                                                                                                                                                                                                            | Action                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regenerated `NOTICES.txt` carried versions the committed lockfile does not resolve, which would fail CI's notices gate                                                                                             | Reverted; a later `npm run build` regenerated it identically to `HEAD`, confirming the reverted state is the generator's output                                                                                                                    |
| The plugin label fix had no committed test, and a fixture comment falsely claimed the parity suite pinned it                                                                                                       | Added producer-side assertions in `packages/cli/src/commands/channel/email-baseline.test.ts` (readable labels, injected `groupPolicy`, TLS defaults) and corrected the comment to name that file                                                   |
| Two parity assertions on `groupPolicy` were vacuous — the real plugin descriptor has no such field                                                                                                                 | Removed them; the injected shape is pinned by the `channel-editor-state` fixture and now also at the producer                                                                                                                                      |
| Only 6 of the 17 Email i18n keys were rendered by any test                                                                                                                                                         | Extended the dialog fixture to the full field table and added a both-locale sweep asserting no label leaks a raw `channels.editor.field.` key                                                                                                      |
| Email's endpoints and TLS switches rendered under "Credentials"                                                                                                                                                    | Added the six Email-only keys to `CONNECTION_FIELD_KEYS`, with a section-placement test                                                                                                                                                            |
| `!privateOnly &&` on `descriptorGroupPolicy` was a second, unpinnable carrier of the same rule                                                                                                                     | Removed. A later verification pass further corrected the accompanying comment: the draft skip is what normally keeps the policy empty; the ternary guards the stored-config fallback arm, not the whole rule                                       |
| The six Email numeric fields declared no `maximum` while the runtime enforces one, so over-range values passed inline validation and failed only at save with a banner                                             | Shared the maxima as named constants between the config parser and the descriptor (the `MAX_POLL_INTERVAL_MS` convention) and added a parity case pinning each bound and the inline `outOfRange` error; demonstrated red by deleting one `maximum` |
| The new browser case located required controls by exact label text, which never matches because the label carries an aria-hidden asterisk; the group zero-count guard had the same flaw in the dangerous direction | Switched to role + accessible name, and to substring name matchers covering the whole group axis; verified in real Chromium (old form 0 matches, new form 1, guards 0)                                                                             |

**Findings declined as out of scope (pre-existing, platform-independent):** the
config-preservation audit demonstrated two defects in code this diff does not
touch, each reproduced on an already-admitted platform (DingTalk control), so
admitting Email extends an existing bug rather than creating one: a blank-valued
`messageRoutes` entry is dropped by the editor (and strands a save when
`defaultMessageRoute` points at it), and `$ENV_VAR` references in registry-injected
shared fields (`instructions`, `defaultMessageRoute`) are baked to resolved
literals because the store's restore pass only covers plugin-declared
`envResolvable` fields. Both belong in their own change; the first also shares
`parseRouteRecord` with the "does this record have any route" check, so it is not
a one-line fix.

**Finding declined:** moving the traffic-shape fact into a plugin/ descriptor
capability instead of a client-side set. That is the alternative already rejected
under Key design decisions — a cross-package contract change for one platform's
UI concern. The same finding observed that `gitlab` is missing from
`REPOSITORY_ONLY_CHANNEL_TYPES` and so still renders direct-message controls;
that is pre-existing behavior in unchanged code, recorded here as a follow-up
rather than fixed in this diff.

## Acceptance criteria

1. Email appears in the Web Shell "add channel" picker.
2. An Email channel configured in `settings.json` appears in the channel list.
3. The Email editor renders no group policy, allowed-group-IDs, or group-senders
   control, and no pairing panel.
4. `privatePolicy` offers exactly `disabled`, `allowlist`, `open` and defaults to
   `allowlist` on a new channel.
5. Saving a new Email channel writes no `groupPolicy` and no `groups` key.
6. An unrelated save preserves stored `groupPolicy` / `groups` keys and `$VAR`
   password references.
7. Every Email field label renders as readable text under both `en` and `zh`;
   no raw camelCase identifier appears.
8. `proactiveRecipients` round-trips from a comma-separated input to a string
   array and back.
9. The seven admitted sibling platforms are unchanged.
10. A new Email channel seeds `imapSecure` / `smtpSecure` from the descriptor
    default and saves them as `true`; editing an unrelated field on a channel
    that omits them does not flip them to `false`.
11. Email's endpoints and TLS switches render under Connection, its credentials
    under Credentials.

## Open questions

- Should the allowlist eventually be replaced by `descriptor.manageable` alone,
  with per-platform verification handled by tests instead of a set? This change
  deliberately does not decide that.
- Should `multiSession` be hidden when the resolved session scope cannot support
  it? The behavior is shared with three already-admitted platforms and belongs
  in a separate change.
- `gitlab` is absent from `REPOSITORY_ONLY_CHANNEL_TYPES` even though its adapter
  only emits group envelopes, so the editor still offers it direct-message
  controls. Review surfaced this as the same class of defect this change fixes
  for Email; it is pre-existing and belongs in its own change.
