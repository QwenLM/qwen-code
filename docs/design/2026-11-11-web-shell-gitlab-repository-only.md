# Web Shell repository-only support for GitLab

[English](2026-11-11-web-shell-gitlab-repository-only.md) | [简体中文](2026-11-11-web-shell-gitlab-repository-only.zh-CN.md)

Status: proposed. Generalizes the Web Shell channel editor's repository-only
model — today built around GitHub's `owner/repo` shape — so GitLab is admitted
without rendering inert direct-message controls and without rejecting nested
project paths.

## Problem statement

GitLab is a group-only channel: `GitlabAdapter.buildEnvelope`
(`packages/channels/gitlab/src/GitlabAdapter.ts:434`) hardcodes `isGroup: true`
for every envelope, exactly like GitHub. Yet `REPOSITORY_ONLY_CHANNEL_TYPES` in
`packages/web-shell/client/components/channels/channel-platform.ts` contains only
`github`, so the Web Shell editor renders the injected direct-message controls
(`privatePolicy`, `allowedUsers`) for GitLab even though the adapter never reads
them. This is the mirror of the defect #16746 fixed for Email (a private-only
channel rendering inert group controls), and it was recorded as a follow-up in
that change's design doc.

Admitting GitLab to the set is necessary but **not sufficient**: the
repository-only machinery is built around GitHub's repository shape, and a naive
one-line admission introduces a regression.

## Current state

### The runtime accepts nested group keys; the editor does not

The daemon store (`packages/cli/src/serve/channel-settings-store.ts`,
`assertSharedField` `groups` branch) constrains group keys only against prototype
pollution (`__proto__`, `constructor`, `prototype`); any other string key is
storable. `GroupGate.groupConfigFor`
(`packages/channels/base/src/GroupGate.ts:43-50`) matches an inbound `chatId`
against group keys by exact string equality, then by a per-adapter
`normalizeGroupId` — with no constraint on the number of path segments. A nested
key such as `group/subgroup/project` therefore works at runtime.

The single-slash restriction lives entirely in the editor:
`REPOSITORY_FULL_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/`
(`channel-editor-state.ts:91`), used by the allowlist validation
(`validateChannelEditorDraft`, `:646`) and by `repositoryAllowlistIds` (`:100`),
which drives the per-repository override rows. With GitLab in the set, a valid
nested project path is rejected as `invalidRepoId`. This was measured: a draft
allowlisting `mygroup/subgroup/project` validates `{}` before admission and
`{"allowedGroupIds":"invalidRepoId"}` after a naive admission.

### GitLab chat IDs are nested and lower-case

`GitlabAdapter.ts:254` sets `chatId = todo.project.path_with_namespace`. GitLab's
`path_with_namespace` is the full namespace path — `group/subgroup/project` when
the project sits in a subgroup — and GitLab enforces lower-case path segments.
The adapter never lower-cases `chatId` and declares no `normalizeGroupId`
override, so GitLab's runtime allowlist matching is case-sensitive exact match.

### GitHub normalizes case; the editor's alias model already matches both

GitHub overrides `normalizeGroupId` to lower-case
(`packages/channels/github/src/GithubAdapter.ts:1806-1808`), so its runtime
treats `Owner/Repo` and `owner/repo` as one repository. The editor's
repository-only alias model (lower-cased keys, `conflictingRepositoryAliases`,
`assignGroups` with `normalizeKeys`) mirrors that. For GitLab, real paths are
already lower-case, so the same lower-casing model is consistent — and it
normalizes an operator's mixed-case input to the lower-case path the runtime
matches. No channel-aware normalization is needed.

### GitHub-only fields stay inert for GitLab

The GitHub URL shortening (`normalizeRepositoryFilterInput`,
`GITHUB_REPOSITORY_URL_RE`, `GITHUB_RESERVED_URL_PATHS`) is applied only to
`repoFilter` (`channel-editor-state.ts:1037-1052`), gated on
`isRepoFilterActive(config['repoFilterMode'])`. The `repoFilter` validation block
is gated on `descriptor.type === 'github'` (`:591`). GitLab declares neither
`repoFilter`/`repoFilterMode` nor `useLocalGh`, so these GitHub-specific paths
never trigger for it. `githubEventWebUrl` is already type-gated to `github`.

### The repository UX copy is GitHub-worded

The allowlist field renders `channels.editor.field.github.allowedRepos`
(label/description/placeholder) for any repository-only channel
(`ChannelEditorDialog.tsx:1838-1862`). Its description says "repository full
names, for example owner/repo" and its placeholder is `owner/repo` — wrong for
GitLab's nested project paths. The remaining repository strings
(`repositorySettings`, `requireMention`, senders/speakers) use generic
"repository" wording that is acceptable for a GitLab project.

## Goals

1. GitLab is admitted as repository-only: the editor hides the inert
   direct-message controls and keeps the group axis editable.
2. The allowlist accepts nested GitLab project paths (`group/subgroup/project`)
   and still rejects malformed entries.
3. GitHub's strict `owner/repo` validation is unchanged.
4. The allowlist field shows project-path wording for GitLab, not `owner/repo`.
5. Saving a GitLab channel drops the injected private-access residue, as for
   GitHub.

## Scope boundaries

In scope: the repository-only predicate, the channel-aware repository-ID shape,
the allowlist copy, and their tests.

Out of scope, with reasons:

- **`repoFilter`, URL shortening, `useLocalGh`.** GitHub-only fields GitLab does
  not declare; their paths never trigger for GitLab. Generalizing them would be
  speculative.
- **A GitLab `normalizeGroupId` runtime override.** GitLab paths are lower-case
  and the editor already lower-cases input, so admission works without changing
  adapter runtime behavior. This change stays in the Web Shell editor.
- **`githubEventNumber` on the events page.** `ChannelEventsPage.tsx:334` parses
  GitHub thread formats for any channel; whether GitLab threads match is a
  separate concern, not part of the editor generalization.
- **Channel-aware alias normalization.** The shared lower-case model is correct
  for both platforms (GitLab paths are lower-case); making it channel-aware would
  add complexity with no observable benefit.

## Proposed change

### Channel-aware repository-ID shape

`packages/web-shell/client/components/channels/channel-editor-state.ts`: replace
the single use of `REPOSITORY_FULL_NAME_RE` that gates repository-only behavior
with a channel-aware shape. GitHub keeps exactly two segments (`owner/repo`);
GitLab accepts two or more (`group[/subgroup…]/project`), each segment matching
`[A-Za-z0-9_.-]+`. The `repoFilter` validation (`:619`) keeps the strict GitHub
regex because that block is GitHub-only.

`repositoryAllowlistIds` gains a channel-type parameter so the per-repository
rows use the same shape; the type is threaded from `buildChannelUpsertRequest`
through `removeGroupAllowlistMembership` and from the dialog.

### Predicate

`channel-platform.ts`: `REPOSITORY_ONLY_CHANNEL_TYPES` becomes
`new Set(['github', 'gitlab'])`, with the comment naming both adapters'
`isGroup: true` envelopes.

### Allowlist copy

`ChannelEditorDialog.tsx`: the allowlist field selects
`channels.editor.field.gitlab.allowedRepos` (label/description/placeholder) when
`descriptor.type === 'gitlab'`, else the existing `github` keys.

`i18n.tsx`: add `channels.editor.field.gitlab.allowedRepos`,
`.description`, `.placeholder` in both locales — "Allowed projects",
"Comma-separated project paths, for example group/subgroup/project.",
`group/project`.

### Tests

- Predicate: GitLab is repository-only; direct-capable platforms are not.
- Dialog: GitLab hides the direct-message controls; the allowlist shows
  project-path copy.
- Editor state: a nested GitLab path validates and saves; a malformed entry is
  rejected; GitHub still rejects a multi-segment id; the private-access residue
  is dropped on save.
- Each new pin is measured red without the generalization.

## Key design decisions

| Decision                                                   | Rationale                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel-aware segment count, not a universal relaxed regex | A universal 2+-segment regex would let GitHub accept multi-slash ids that can never match a repository, losing typo detection. GitHub keeps its strict shape. |
| Keep the shared lower-case alias model                     | GitLab paths are lower-case, so the model is consistent and normalizes operator input; channel-aware normalization adds complexity with no benefit.           |
| Only the allowlist copy becomes channel-aware              | The remaining repository strings use generic "repository" wording acceptable for a GitLab project; duplicating them would be speculative.                     |
| Leave `repoFilter`/URL shortening/`useLocalGh` GitHub-only | GitLab declares none of these fields; their paths never trigger for it.                                                                                       |

## Constraints

- The editor is shared by every admitted platform. The shape change must not
  alter GitHub, DingTalk, DWS, WeCom, WeCom Callback, Feishu, or Email behavior.
- The daemon store accepts arbitrary group keys; the editor's shape validation is
  a usability guard, not a security boundary — the runtime allowlist is
  fail-closed.
- Both locale tables must be updated in the same change and rendered by tests.

## Risks

| Risk                                  | Mitigation                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Relaxed shape leaks to GitHub         | The shape is keyed on channel type; a test pins GitHub rejecting a multi-segment id.               |
| GitLab copy regresses to `owner/repo` | A dialog test pins the project-path placeholder/description for GitLab.                            |
| Nested path rejected at save          | An editor-state test validates and saves `group/subgroup/project`; measured red before the change. |
| Alias model mishandles GitLab case    | GitLab paths are lower-case; documented as a known nuance, no observable defect.                   |

## Validation plan

1. Targeted vitest suites in `packages/web-shell`:
   `channel-platform.test.ts`, `channel-editor-state.test.ts`,
   `ChannelEditorDialog.test.tsx`, `channel-editor-parity.test.ts`,
   `ChannelsManagerPage.test.tsx`.
2. Repository gates: `npm run build`, `npm run typecheck`, ESLint and Prettier on
   the changed files.
3. Mutation witnesses: removing GitLab from the set, or reverting the
   channel-aware shape, turns the new pins red.

## Acceptance criteria

1. GitLab appears as repository-only; the editor renders no `privatePolicy` or
   `allowedUsers` control for it, and the group axis stays editable.
2. A GitLab allowlist entry `group/subgroup/project` validates and saves; the
   per-repository row renders for it.
3. A malformed GitLab entry (e.g. a single segment) is rejected.
4. GitHub still rejects a multi-segment id such as `owner/repo/extra`.
5. The GitLab allowlist field shows project-path copy in both locales, not
   `owner/repo`.
6. Saving a GitLab channel writes no `privatePolicy`/`allowedUsers`.
7. The seven other admitted platforms behave unchanged.

## Open questions

- Whether GitLab should eventually gain a `normalizeGroupId` override for
  case-insensitive matching parity with GitHub is a runtime decision outside this
  editor change; real GitLab paths are lower-case, so it is not required here.
