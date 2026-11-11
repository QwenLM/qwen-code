# Web Shell repository-only support for GitLab

[English](2026-11-11-web-shell-gitlab-repository-only.md) | [简体中文](2026-11-11-web-shell-gitlab-repository-only.zh-CN.md)

Status: implemented and verified locally; pending review. Generalizes the Web
Shell channel editor's repository-only model — today built around GitHub's
`owner/repo` shape — so GitLab is admitted without rendering inert
direct-message controls, without rejecting nested project paths, and without
breaking mixed-case project paths.

## Problem statement

GitLab is a group-only channel: `GitlabAdapter.buildEnvelope`
(`packages/channels/gitlab/src/GitlabAdapter.ts`) hardcodes `isGroup: true` for
every envelope, exactly like GitHub. Yet `REPOSITORY_ONLY_CHANNEL_TYPES` in
`packages/web-shell/client/components/channels/channel-platform.ts` contained
only `github`, so the Web Shell editor rendered the injected direct-message
controls (`privatePolicy`, `allowedUsers`) for GitLab even though the adapter
never reads them. This is the mirror of the defect #16746 fixed for Email (a
private-only channel rendering inert group controls), and it was recorded as a
follow-up in that change's design doc.

Admitting GitLab to the set is necessary but **not sufficient**, for two
independent reasons:

1. The repository-only allowlist machinery is built around GitHub's single-slash
   `owner/repo` shape and rejects valid nested GitLab project paths such as
   `group/subgroup/project`.
2. The editor's repository-only alias model lower-cases group keys, but the
   GitLab adapter matched group keys case-sensitively. GitLab project paths
   preserve case, so a naive admission silently breaks every mixed-case project.

## Current state

### The runtime accepts nested group keys; the editor did not

The daemon store (`packages/cli/src/serve/channel-settings-store.ts`,
`assertSharedField` `groups` branch) constrains group keys only against prototype
pollution (`__proto__`, `constructor`, `prototype`); any other string key is
storable. `GroupGate.groupConfigFor`
(`packages/channels/base/src/GroupGate.ts`) matches an inbound `chatId` against
group keys by exact string equality, then by a per-adapter `normalizeGroupId` —
with no constraint on the number of path segments. A nested key such as
`group/subgroup/project` therefore works at runtime.

The single-slash restriction lived entirely in the editor:
`REPOSITORY_FULL_NAME_RE` (`channel-editor-state.ts`), used by the allowlist
validation in `validateChannelEditorDraft` and by `repositoryAllowlistIds`, which
drives the per-repository override rows. With GitLab in the set, a valid nested
project path was rejected as `invalidRepoId`. This was measured: a draft
allowlisting `mygroup/subgroup/project` validated cleanly before admission and
returned `{"allowedGroupIds":"invalidRepoId"}` after a naive admission.

### GitLab chat IDs are nested and preserve case

`GitlabAdapter` sets `chatId = todo.project.path_with_namespace`. GitLab's
`path_with_namespace` is the full namespace path — `group/subgroup/project` when
the project sits in a subgroup — and it **preserves case**. GitLab's path grammar
allows upper-case letters, and mixed-case projects exist on gitlab.com (for
example `CalcProgrammer1/OpenRGB`, verified against the live API). GitLab web
routing is case-insensitive, so two spellings differing only in case refer to the
same project.

The adapter declared no `normalizeGroupId` override, so the base identity
normalizer applied and GitLab's runtime allowlist matching was case-sensitive
exact match — a latent inconsistency with GitLab's case-insensitive routing.

### The editor's lower-case model would mismatch mixed-case paths

The repository-only alias model lower-cases group keys (the draft seed,
`repositoryAllowlistIds`, `assignGroups` with `normalizeKeys`, and
`configuredGroupOverrides`). GitHub overrides `normalizeGroupId` to lower-case
(`packages/channels/github/src/GithubAdapter.ts`), so its runtime treats
`Owner/Repo` and `owner/repo` as one repository and the editor's lower-casing
matches. Applying that same editor model to a case-sensitive GitLab runtime
lower-cases the stored key while the inbound `chatId` keeps its case, so a
mixed-case project's allowlist entry never matches: admission fails closed, a
re-save rewrites a working mixed-case key to lower case, and a per-project sender
restriction silently falls back to the open default.

### GitHub-only fields stay inert for GitLab

The GitHub URL shortening (`normalizeRepositoryFilterInput`,
`GITHUB_REPOSITORY_URL_RE`, `GITHUB_RESERVED_URL_PATHS`) is applied only to
`repoFilter`. Both the `repoFilter` validation block and the save-path
canonicalization are gated on `descriptor.type === 'github'` — not on the wider
repository-only set. The save-path gate matters even though GitLab declares no
`repoFilter` field: the request config is seeded from the stored config, so a
GitLab channel may carry a preserved, unmanaged `repoFilterMode`/`repoFilter`
that the daemon tolerates only while byte-identical. Canonicalizing it on save
would make the daemon reject every subsequent save of that channel. GitLab also
declares no `useLocalGh`. `githubEventWebUrl` is already type-gated to `github`.

### Pre-existing entries must not block unrelated edits

Admitting GitLab to the repository-only set subjects its pre-existing allowlist
to a shape check it was never validated against, and re-cases its stored group
keys. Two tolerances keep an unrelated edit (for example a token rotation) from
being stranded on entries the operator never touched:

- The editor's shape check skips entries that are present in the stored groups
  (compared case-insensitively, since the draft lower-cases repository ids), the
  same convention the number-field branch already uses for stored values.
- The daemon store's unchanged-value tolerance follows a group entry across a
  case rewrite: when the exact key is absent it falls back to a case-insensitive
  match of the previous entry, mirroring `GroupGate.groupConfigFor`'s
  exact-then-normalized order, with the exact spelling always winning.

### The repository UX copy was GitHub-worded

Several repository-only strings name GitHub specifically: the allowlist field
(`channels.editor.field.github.allowedRepos`, "repository full names, for example
owner/repo"), the allowlist validation remedy
(`channels.editor.validation.invalidRepoId`, "Enter each repository as
owner/repo."), and the per-project speakers description
(`channels.editor.field.github.repositorySpeakers.description`/`.inherited`,
"GitHub logins…"). The remaining repository strings (`repositorySettings`,
`requireMention`, `repositorySenders`) use generic "repository" wording acceptable
for a GitLab project.

## Goals

1. GitLab is admitted as repository-only: the editor hides the inert
   direct-message controls and keeps the group axis editable.
2. The allowlist accepts nested GitLab project paths (`group/subgroup/project`)
   and still rejects malformed entries.
3. Mixed-case GitLab project paths admit correctly and survive a re-save.
4. GitHub's strict `owner/repo` validation is unchanged.
5. The allowlist field, its validation remedy, and the speakers description show
   GitLab project wording, not GitHub `owner/repo` / "GitHub logins".
6. Saving a GitLab channel drops the injected private-access residue, as for
   GitHub.

## Scope boundaries

In scope: the repository-only predicate, the channel-aware repository-ID shape, a
GitLab `normalizeGroupId` override, the GitLab repository copy, and their tests.

Out of scope, with reasons:

- **`repoFilter`, URL shortening, `useLocalGh`.** GitHub-only fields GitLab does
  not declare; their paths never trigger for GitLab. Generalizing them would be
  speculative.
- **`githubEventNumber` on the events page.** `ChannelEventsPage` parses GitHub
  thread formats for any channel; whether GitLab threads match is a separate
  concern, not part of the editor generalization.
- **Channel-aware alias normalization in the editor.** With the adapter
  normalizing case (below), the shared lower-case alias model is correct for both
  platforms; making the editor's alias model channel-aware would add complexity
  with no observable benefit.

## Proposed change

### GitLab group matching becomes case-insensitive

`packages/channels/gitlab/src/GitlabAdapter.ts`: `GitlabChannel` overrides
`normalizeGroupId` to lower-case, mirroring `GithubChannel`. GitLab routing is
case-insensitive and case-variant paths are the same project, so case-insensitive
group matching is the semantically correct behavior. `GroupGate.groupConfigFor`
normalizes both the inbound `chatId` and the stored keys, so an allowlist typed in
any case admits the project and resolves its sender policy. This makes the
editor's existing lower-case model consistent with the runtime and makes the
alias model's case-collapse correct (case variants are one project).

### Channel-aware repository-ID shape

`channel-editor-state.ts`: the two uses of `REPOSITORY_FULL_NAME_RE` that gate
repository-only behavior (the allowlist validation and `repositoryAllowlistIds`)
become channel-aware via `repositoryIdPattern(type)`. GitHub keeps exactly two
segments (`owner/repo`); GitLab accepts two or more
(`group[/subgroup…]/project`), each segment matching `[A-Za-z0-9_.-]+`. The
`repoFilter` validation keeps the strict GitHub regex because that block is
GitHub-only. `repositoryAllowlistIds` gains a channel-type parameter, threaded
from `buildChannelUpsertRequest` through `removeGroupAllowlistMembership` and from
the dialog. The allowlist shape check tolerates entries already present in the
stored groups (case-insensitively), so admitting GitLab does not strand an
unrelated edit on a pre-existing entry that predates the shape check.

### Predicate

`channel-platform.ts`: `REPOSITORY_ONLY_CHANNEL_TYPES` becomes
`new Set(['github', 'gitlab'])`.

### Guarding preserved keys and re-cased entries

`channel-editor-state.ts`: the save-path `repoFilter` canonicalization is gated
on `descriptor.type === 'github'` (matching the validator), so a preserved,
unmanaged `repoFilter` on a GitLab channel is never rewritten.
`packages/cli/src/serve/channel-settings-store.ts`: the `groups` unchanged-value
tolerance falls back to a case-insensitive match of the previous entry when the
exact key is absent, so re-casing a group key on save does not drop the tolerance
for an unchanged legacy nested value. The exact spelling always wins.

### GitLab repository copy

`ChannelEditorDialog.tsx` selects GitLab variants by `descriptor.type` for the
allowlist field (`channels.editor.field.gitlab.allowedRepos`), the allowlist
validation remedy (`channels.editor.validation.invalidProjectPath`), the
case-variant conflict remedy
(`channels.editor.validation.conflictingProjectAliases`), and the per-project
speakers description
(`channels.editor.field.gitlab.repositorySpeakers.description`/`.inherited`).
`i18n.tsx` adds those keys in both locales: "Allowed projects" / "允许的项目",
project-path description and `group/project` placeholder, "Enter each project as
a path, for example group/subgroup/project.", a project-path conflict remedy,
and "GitLab usernames…". The generic speakers label and placeholder stay shared.

### Tests

- Predicate: GitLab is repository-only; direct-capable platforms are not.
- Adapter: a mixed-case project path resolves its sender allowlist and its
  allowlist admission through a lower-case `chatId` (measured red with an
  identity normalizer).
- Dialog: GitLab hides the direct-message controls; the allowlist shows
  project-path copy in both locales; a malformed entry shows the project-path
  remedy; case-variant keys show the project-path conflict remedy; the speakers
  description and inherited copy say "GitLab usernames" in both locales.
- Editor state: a nested GitLab path validates and saves; a newly typed malformed
  entry is rejected while a stored pre-shape entry is tolerated; a stored
  mixed-case project keeps its sender policy across a re-save; a preserved
  `repoFilter` round-trips unchanged; GitHub still rejects a multi-segment id;
  the private-access residue is dropped on save.
- Daemon store: a re-cased group key keeps the unchanged-value tolerance for a
  legacy nested value, and a changed value is still refused.

## Key design decisions

| Decision                                                   | Rationale                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a GitLab `normalizeGroupId` lower-case override        | GitLab routing is case-insensitive and `path_with_namespace` preserves case; case-insensitive matching is semantically correct and mirrors GitHub. It reconciles the editor's lower-case model with the runtime instead of forcing the editor to preserve case. |
| Channel-aware segment count, not a universal relaxed regex | A universal 2+-segment regex would let GitHub accept multi-slash ids that can never match a repository, losing typo detection. GitHub keeps its strict shape.                                                                                                   |
| Keep the shared lower-case alias model                     | With the adapter normalizing case, case variants are one project for both platforms, so the shared model is correct; channel-aware editor normalization would add complexity with no benefit.                                                                   |
| Only the platform-naming copy becomes channel-aware        | The remaining repository strings use generic "repository" wording acceptable for a GitLab project; duplicating them would be speculative.                                                                                                                       |
| Leave `repoFilter`/URL shortening/`useLocalGh` GitHub-only | GitLab declares none of these fields. The save-path `repoFilter` canonicalization is explicitly GitHub-gated because the request config is seeded from storage, so a preserved unmanaged `repoFilter` must not be rewritten.                                    |
| Tolerate pre-existing entries across admission             | The shape check skips stored entries and the store's unchanged-value tolerance follows a re-cased key, so admitting GitLab does not strand an unrelated edit on entries the operator never touched.                                                             |

## Constraints

- The editor is shared by every admitted platform. The shape change must not
  alter GitHub, DingTalk, DWS, WeCom, WeCom Callback, Feishu, or Email behavior.
- The adapter override changes GitLab group matching from case-sensitive to
  case-insensitive. This is a bugfix aligned with GitLab routing: existing
  lower-case configs still match, and mixed-case configs now match too.
- The daemon store accepts arbitrary group keys; the editor's shape validation is
  a usability guard, not a security boundary — the runtime allowlist is
  fail-closed.
- Both locale tables must be updated in the same change and rendered by tests.

## Risks

| Risk                                       | Mitigation                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relaxed shape leaks to GitHub              | The shape is keyed on channel type; a test pins GitHub rejecting a multi-segment id.                                                                        |
| Mixed-case path still mismatches           | The adapter override normalizes both sides; an adapter test pins a mixed-case key resolving through a lower-case chatId, measured red without the override. |
| GitLab copy regresses to GitHub wording    | Dialog tests pin the project-path placeholder/description, the project-path remedy, and "GitLab usernames" speakers copy.                                   |
| Nested path rejected at save               | An editor-state test validates and saves `group/subgroup/project`; measured red before the shape change.                                                    |
| Adapter override changes existing behavior | Case-insensitive matching only widens admission to the same project's case variants; lower-case configs are unaffected.                                     |

## Validation plan

1. Targeted vitest suites: `packages/web-shell` channels directory
   (`channel-platform`, `channel-editor-state`, `ChannelEditorDialog`,
   `channel-editor-parity`, `ChannelsManagerPage`),
   `packages/channels/gitlab` (`GitlabAdapter`), and `packages/cli`
   (`channel-settings-store`).
2. Repository gates: `tsc --noEmit` (web-shell and gitlab), ESLint and Prettier on
   the changed files. The full web-shell `vite build` is blocked in this checkout
   by a pre-existing missing `browserify` dependency (declared in `package.json`
   but absent from local `node_modules`); the change-relevant `tsconfig.lib.json`
   compilation passes, and CI's clean install builds.
3. Mutation witnesses: removing GitLab from the set, reverting the channel-aware
   shape, reverting the copy selection, or reverting the adapter override each
   turn the corresponding pins red. Boundary guards (GitHub stays strict,
   direct-capable platforms stay out) are green on the base by design and kill
   over-broad mutations rather than serving as regression witnesses.

## Acceptance criteria

1. GitLab appears as repository-only; the editor renders no `privatePolicy` or
   `allowedUsers` control for it, and the group axis stays editable.
2. A GitLab allowlist entry `group/subgroup/project` validates and saves; the
   per-repository row renders for it.
3. A mixed-case GitLab project path admits at runtime and survives a re-save
   with its per-project sender policy intact.
4. A newly typed malformed GitLab entry (e.g. a single segment) is rejected with
   a project-path remedy, while a stored entry that predates the shape check does
   not block an unrelated edit.
5. GitHub still rejects a multi-segment id such as `owner/repo/extra`.
6. The GitLab allowlist field, validation remedy, conflict remedy, and speakers
   description/inherited copy show GitLab project wording in both locales, not
   `owner/repo` / "GitHub logins".
7. Saving a GitLab channel writes no `privatePolicy`/`allowedUsers`, and leaves a
   preserved unmanaged `repoFilter` byte-identical.
8. A re-cased group key keeps the daemon's unchanged-value tolerance for a legacy
   nested value; a changed value is still refused.
9. The seven other admitted platforms behave unchanged.

## Open questions

- None outstanding. The events page's GitHub thread-number parsing for GitLab
  events remains a separate, pre-existing concern.
