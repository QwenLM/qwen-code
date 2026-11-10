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
`repoFilter`, gated on `isRepoFilterActive(config['repoFilterMode'])`. The
`repoFilter` validation block is gated on `descriptor.type === 'github'`. GitLab
declares neither `repoFilter`/`repoFilterMode` nor `useLocalGh`, so these
GitHub-specific paths never trigger for it. `githubEventWebUrl` is already
type-gated to `github`.

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
the dialog.

### Predicate

`channel-platform.ts`: `REPOSITORY_ONLY_CHANNEL_TYPES` becomes
`new Set(['github', 'gitlab'])`.

### GitLab repository copy

`ChannelEditorDialog.tsx` selects GitLab variants by `descriptor.type` for the
allowlist field (`channels.editor.field.gitlab.allowedRepos`), the allowlist
validation remedy (`channels.editor.validation.invalidProjectPath`), and the
per-project speakers description
(`channels.editor.field.gitlab.repositorySpeakers.description`/`.inherited`).
`i18n.tsx` adds those keys in both locales: "Allowed projects" / "允许的项目",
project-path description and `group/project` placeholder, "Enter each project as
a path, for example group/subgroup/project.", and "GitLab usernames…". The
generic speakers label and placeholder stay shared.

### Tests

- Predicate: GitLab is repository-only; direct-capable platforms are not.
- Adapter: a mixed-case project path resolves its sender allowlist through a
  lower-case `chatId` (measured red with an identity normalizer).
- Dialog: GitLab hides the direct-message controls; the allowlist shows
  project-path copy in both locales; a malformed entry shows the project-path
  remedy; the speakers description says "GitLab usernames".
- Editor state: a nested GitLab path validates and saves; a malformed entry is
  rejected; GitHub still rejects a multi-segment id; the private-access residue
  is dropped on save.

## Key design decisions

| Decision                                                   | Rationale                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a GitLab `normalizeGroupId` lower-case override        | GitLab routing is case-insensitive and `path_with_namespace` preserves case; case-insensitive matching is semantically correct and mirrors GitHub. It reconciles the editor's lower-case model with the runtime instead of forcing the editor to preserve case. |
| Channel-aware segment count, not a universal relaxed regex | A universal 2+-segment regex would let GitHub accept multi-slash ids that can never match a repository, losing typo detection. GitHub keeps its strict shape.                                                                                                   |
| Keep the shared lower-case alias model                     | With the adapter normalizing case, case variants are one project for both platforms, so the shared model is correct; channel-aware editor normalization would add complexity with no benefit.                                                                   |
| Only the platform-naming copy becomes channel-aware        | The remaining repository strings use generic "repository" wording acceptable for a GitLab project; duplicating them would be speculative.                                                                                                                       |
| Leave `repoFilter`/URL shortening/`useLocalGh` GitHub-only | GitLab declares none of these fields; their paths never trigger for it.                                                                                                                                                                                         |

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
   `channel-editor-parity`, `ChannelsManagerPage`) and
   `packages/channels/gitlab` (`GitlabAdapter`).
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
3. A mixed-case GitLab project path admits at runtime and survives a re-save.
4. A malformed GitLab entry (e.g. a single segment) is rejected with a
   project-path remedy.
5. GitHub still rejects a multi-segment id such as `owner/repo/extra`.
6. The GitLab allowlist field, validation remedy, and speakers description show
   GitLab project wording in both locales, not `owner/repo` / "GitHub logins".
7. Saving a GitLab channel writes no `privatePolicy`/`allowedUsers`.
8. The seven other admitted platforms behave unchanged.

## Open questions

- None outstanding. The events page's GitHub thread-number parsing for GitLab
  events remains a separate, pre-existing concern.
