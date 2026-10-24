# Verify-PR publishing coordinates from settings.json

[English](verify-pr-assets-config.md) | [简体中文](verify-pr-assets-config.zh-CN.md)

Status: implementing with this change.

## Problem

A maintainer's manual `/verify-pr <n> --publish` round publishes screenshots to
an assets branch and links them from the PR comment. The branch already
resolves from a flag, an environment variable, then `assets/pr<n>-validation`,
but the host repository still has to be confirmed in every round. A coordinate
that never changes between rounds should be configured once.

## Current state

- The skill resolves the branch and names the host only as "confirm the image
  host before publishing".
- `settings.json` has no channel for a project-level skill: `skills.*` holds
  enable/disable lists, and an unknown key is dropped with
  `Unknown setting '<key>' will be ignored in <path>`.
- `settings.env` can supply the variables the skill reads, but the environment
  loader merges it from every scope, workspace included (it excludes
  storage/loader keys only). A cloned repository could therefore set
  `QWEN_VERIFY_ASSETS_REPO` and redirect where a maintainer's verification
  evidence gets published.

## Proposal

- Add `verifyPr.assetsRepo` and `verifyPr.assetsBranch`, honored from User,
  System, and SystemDefaults scopes.
- List `verifyPr` as a workspace-restricted root, so the merge strips a
  workspace value and the warnings channel reports it ignored. The settings
  route does not offer these keys to workspace writes in the first place, so
  the strip is what protects the value rather than the route guard.
- Exclude `QWEN_VERIFY_ASSETS_REPO` and `QWEN_VERIFY_ASSETS_BRANCH` from the
  variables a project `.env` or `settings.env` may supply. Both are
  repository-controlled, and the environment loader applies them before the
  settings bridge, so without this exclusion a repository could still redirect
  the target by exporting the variable itself. The launch environment, a home
  `.env`, and `verifyPr.*` remain able to set them.
- At startup the CLI copies the settings into those variables when they are
  unset, so the skill keeps reading the variables it already documents and a
  one-off export still wins.
- The skill states the three-tier order — flag, variable (export, `.env`, or
  settings), default — and keeps publishing consent per invocation.

## Design decisions

1. **A dedicated namespace, not `settings.env`.** These values decide where
   evidence is published. The workspace scope must not be able to choose that,
   and only a namespaced key can carry the operator-scope restriction in one
   place.
2. **An environment bridge, not injection into the skill prompt.** Skill bodies
   substitute only `{{cliVersion}}` and `{{model}}`, and the project-skill path
   has no settings channel. Variables already are the tier the skill documents,
   so filling them is one function instead of a new plumbing path.
3. **Flags stay first.** A per-round override must beat a standing
   configuration, and an already-set variable must beat settings.json — which is
   what the resolver's "only when unset" rule gives.

## Constraints and risks

- A value written in a workspace settings file has no effect. That is the
  point, but it must be visible: the schema description and the skill both say
  it, so a maintainer does not debug a silently ignored key.
- `settings.env` entries for either variable are ignored at every scope,
  including User, with a line on stderr that names `verifyPr.*` and the launch
  environment. The merged map cannot tell a workspace entry from an operator
  one, so a scope-blind rule is the only auditable one; the dedicated setting
  is the user-scope channel, and `~/.qwen/.env` still works.
- The bridge runs from `loadSettings` where the environment is applied. Callers
  that skip environment loading are per-request config reads and do not need
  it.
- Coordinates are not consent: `--publish` still gates every comment, and the
  pre-post guard and read-back are unchanged.

## Validation plan

- Unit test for the resolver: unset, preset, empty export, blank value,
  trimming.
- A scripts assertion that the skill documents the settings tier.
- Manual: set both keys at user scope, start a session, confirm the variables
  are present and that `/verify-pr <n> --publish` publishes to that host with no
  `--assets-*` flag.

## Acceptance criteria

- With both keys set at user scope, a publish round needs no assets flag.
- The same keys in a workspace file change nothing.
- An exported variable overrides the configured value.
- An empty export does not block the configured value.

## Open questions

None at this scope. Extending the restriction to other skill coordinates would
be a separate change.
