# GitHub Channel Repository Event Filter (Allowlist / Blocklist)

[English](github-repo-filter.md) | [简体中文](github-repo-filter.zh-CN.md)

Status: implemented in this change.

## Problem

The GitHub channel processes notifications from every repository the
authenticated account can see. The only repository-level control today is
`groupPolicy: "allowlist"` plus `groups` keys: an operator who wants "everything
except these noisy repositories" has no way to express it, and an operator who
wants a simple event filter must understand the access-policy machinery
(group gates, sender policies, per-repository overrides) to get one.

In the Web Shell editor the repository allowlist lives under "Group Policy →
Allowlist → Allowed repositories". There is no blocklist, and the access-policy
framing makes a plain "filter events by repository" task unintuitive.

## Current state

- Inbound events arrive through the notification poll loop in
  `packages/channels/github/src/GithubAdapter.ts` (`pollOnce`). Each
  notification's subject URL yields `chatId = owner/repo`; `reasonFilter`
  already skips notifications there, journals a capped `reason_filter` skip
  row per poll plus one collapsed count row, and lets the cursor advance.
- Repository access is gated later, per envelope, by `GroupGate`
  (`groupPolicy` + `groups`). The editor renders repository rows only for this
  access path.
- A second event source, PR state watch (`runPrStateWatch`), serves PRs that a
  user explicitly bound to a live session. It does not flow through the
  notification loop.
- The daemon store (`channel-settings-store.ts`) validates every config key
  against the plugin descriptor and runs the plugin's synchronous
  `validateConfig` for cross-field rules. The editor mirrors those rules in
  `channel-editor-state.ts`; `channel-editor-parity.test.ts` binds the two
  sides with the plugin's own descriptor.

## Goals

- Filter inbound GitHub events by repository with two explicit modes:
  allowlist (only listed repositories) and blocklist (all except listed).
- Make the filter a first-class, self-explanatory pair of fields in the Web
  Shell editor, with repository-format validation and URL-paste tolerance.
- Keep the runtime, the save-time validator, and the editor mirror in sync
  through one shared validation function and a parity table.

## Scope boundaries

- The filter applies to every incoming notification, including notifications
  about PRs bound to a live session. Only PR state watch events
  (`runPrStateWatch`) — explicit per-PR subscriptions created by the user in
  a session — bypass it. The field description states this.
- `groupPolicy` / `groups` keep their access-control meaning unchanged. The
  repository filter is an additional intake filter; when both are active the
  effective set is their intersection.
- No change to other channels, to `GroupGate`, or to the shared `GroupPolicy`
  type.

## Proposed solution

### Configuration (GitHub plugin)

Two new flat descriptor fields, placed after `reasonFilter`:

- `repoFilterMode`: enum `off | allowlist | blocklist`, default `off`.
- `repoFilter`: string-list of `owner/repo` entries.

```json
{
  "type": "github",
  "useLocalGh": true,
  "groupPolicy": "open",
  "repoFilterMode": "blocklist",
  "repoFilter": ["octo/noisy-repo", "octo/archive"]
}
```

Flat fields (not one object field) because the Web Shell editor cannot edit
`object`-kind fields.

### Runtime (`GithubAdapter.ts`)

- `validateRepoFilterConfig(config)` — exported pure function returning a
  string error or `undefined`. Rules:
  - `repoFilterMode` absent or `off`: the list is ignored entirely (a stale
    list never blocks a save or a connect while the filter is off).
  - `repoFilterMode` set to `allowlist`/`blocklist`: `repoFilter` must be a
    non-empty array of strings, each matching `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`
    after trim + lowercase. An active allowlist with an empty list would
    silently drop every event, so it is rejected instead.
  - Any other mode value is rejected.
- `normalizeRepoFilter(config, name)` calls the same validator and throws on
  error; `connect()` stores `{ mode, repos: Set<string> } | null` beside
  `reasonFilter`.
- In the poll loop, immediately after `extractFromSubjectUrl` and before
  `reasonFilter`: allowlist skips repositories not in the set, blocklist skips
  repositories in the set (case-insensitive). A skipped notification is
  logged to stderr, emitted as a `repoFilter.skip` debug payload, and
  journaled as `inbound / skipped / repo_filter` with the same per-poll cap
  (20 rows) and collapsed count row as `reason_filter`. The cursor advances
  past filtered notifications exactly as it does for reason-filtered ones.
- `index.ts` `validateConfig` calls `validateRepoFilterConfig`, so the daemon
  rejects an invalid combination at save time with the same message the
  runtime would throw.

### Editor (`web-shell`)

- `channel-editor-state.ts`:
  - `normalizeRepositoryFilterInput(value, baseUrl)` — splits on commas,
    trims, lowercases, shortens GitHub web URLs
    (`https://github.com/owner/repo`, with optional `.git`, trailing slash,
    query, fragment, or `/pull/123`-style suffix) to `owner/repo`,
    deduplicates, joins with `, `. Two gates decide whether a URL is
    shortened at all. Structurally, only URLs whose host is the channel's
    own GitHub host qualify: `github.com` plus the host derived from
    `baseUrl` for GitHub Enterprise (an `api.` prefix is stripped); any
    other host — `api.github.com`, `gist.github.com`, `gitlab.com`, an
    arbitrary site — passes through unchanged for validation to reject,
    which closes the "first two segments of any host" class. On a qualified
    host, a URL whose first path segment is a reserved GitHub area (`orgs`,
    `apps`, `settings`, `trending`, ...) still passes through unchanged so
    validation rejects it instead of silently filtering a nonexistent
    repository. That area list is best-effort by construction — a denylist
    of GitHub's top-level paths cannot be complete, and a future area can
    reintroduce the hazard until it is added. A snapshot assertion pins the
    whole exported set (removing any member fails it), an enumerated test
    keeps every listed root rejected, and explicit regression pins cover the
    reported shapes including a capitalized root. Other non-URL entries
    pass through unchanged so validation can name them.
  - Validation (github only): when `repoFilterMode` is active, an empty list
    is `repoFilterRequired`; entries that still fail the repository regex
    after normalization are `invalidRepoId`. When the mode is `off`, the list
    is not validated, matching the runtime's ignore-while-off rule and the
    conditional-field visibility below.
  - `buildChannelUpsertRequest` normalizes the github `repoFilter` value with
    the same function before sending.
  - `initialFieldValue` seeds `repoFilterMode` with `off` for existing
    instances whose config lacks the key (the generic existing-instance path
    would otherwise leave the select empty).
- `ChannelEditorDialog.tsx`: the list field is rendered only while the mode
  is active (progressive disclosure). Visibility and validation are gated on
  the same predicate, so a hidden field can never strand a save. The draft
  keeps the list text while the mode is `off`, so re-enabling restores it.
- i18n (en + zh): field labels ("Repository Filter" / "Filtered repositories"),
  mode option labels (Off / Allowlist — only listed repositories / Blocklist —
  all except listed), descriptions (including the URL-paste note and the
  bound-PR-watch boundary), placeholder `owner/repo, owner/repo`, and the two
  validation messages.

### Parity

`channel-editor-parity.test.ts` gains a repo-filter table: the same configs
feed the editor mirror and `plugin.management.validateConfig`, using the
plugin's own descriptor (active mode + empty list, malformed entry, valid
allowlist/blocklist, off + stale list).

## Design decisions and rationale

- **Separate intake filter, not a new `groupPolicy` value.** `GroupPolicy` is
  shared by every channel and enforced by `GroupGate`; adding `blocklist`
  there would change access-control semantics across all platforms. An
  adapter-level filter is GitHub-only, sits where `reasonFilter` already sits,
  and composes with any group policy.
- **Explicit `off` mode instead of "empty list means off".** An empty
  allowlist must not silently mean "block everything" or "filter disabled";
  the mode makes the intent explicit and lets the runtime reject the
  ambiguous combination.
- **Ignore the list while off.** Operators can park a list, switch the filter
  off, and save unrelated edits without the parked list blocking the save —
  the same tolerance the store already grants unchanged numeric values.
- **Normalize URLs in the editor, keep the runtime strict.** Pasting a
  repository or PR URL is the natural gesture; the editor shortens it on
  save. `settings.json` hand-edits keep one canonical spelling and get a
  clear error otherwise.
- **Notifications filtered, watch events not.** Every notification is
  filtered, including notifications about bound PRs — they arrive through the
  same intake. Bound-PR watch is an explicit user subscription with its own
  durable state machine; filtering it is a separate decision and stays out
  of this change.

## Files affected

- `packages/channels/github/src/GithubAdapter.ts`, `index.ts`,
  `GithubAdapter.test.ts`
- `packages/web-shell/client/components/channels/channel-editor-state.ts`,
  `ChannelEditorDialog.tsx`, their tests, `channel-editor-parity.test.ts`
- `packages/web-shell/client/i18n.tsx`
- `packages/web-shell/client/e2e/visuals/screenshots.spec.ts` (repository
  filter editor captures)
- `docs/users/features/channels/github.md`
- `docs/design/github-repo-filter.md`, `docs/design/github-repo-filter.zh-CN.md`

## Validation plan

- Unit: adapter normalize/validate rules; poll-loop skip behavior for both
  modes (case-insensitive match, journal cap and collapsed row, cursor
  advances); editor normalization/validation/save payload; parity table.
- E2E (`.qwen/e2e-tests/github-repo-filter.md`): save both modes through the
  daemon API against a local GitHub-compatible stub, observe skipped vs
  processed notifications and the `repo_filter` journal rows; editor
  rendering checks.

## Acceptance criteria

- `repoFilterMode: allowlist` processes only listed repositories; `blocklist`
  processes all except listed; `off`/absent processes everything.
- An active mode with an empty or malformed list is rejected at save time
  (daemon and editor) and at connect time (runtime), with matching messages.
- Filtered notifications are journaled as `repo_filter` skips and do not hold
  the cursor.
- The editor shows the repository list only while a mode is active, accepts
  pasted GitHub URLs, and round-trips stored values unchanged when untouched.
- Existing channels without the new keys behave exactly as before.

## Open questions

None.
