# Auto-Skill Curator

## Problem

Qwen Code can extract reusable project skills from tool-heavy conversations,
but accepted auto-skills only accumulate. The existing review agent can create
or update `source: auto-skill` skills and is explicitly forbidden from deleting
them. Path gating and `skills.disabled` reduce prompt noise but do not maintain
the on-disk library.

## Scope

Add a small, deterministic lifecycle manager for project auto-skills:

- Track successful invocations of project skills whose directory starts with
  `auto-skill-` and whose frontmatter contains `source: auto-skill`.
- Mark a managed skill stale after 30 days without activity.
- Archive it after 90 days without activity by moving its whole directory out
  of `.qwen/skills/` into `.qwen/archived-skills/`.
- Run the deterministic pass at most once every 7 days during configuration
  initialization when Auto Skill is enabled.
- Expose `/curator`, `/curator status`, `/curator run [--dry-run]`, and
  `/curator restore <directory>` in interactive, non-interactive, and ACP
  command surfaces.

This first version does not use an LLM, consolidate overlapping skills, manage
personal/bundled/extension/learned/hand-authored skills, permanently delete
anything, or introduce additional settings.

## Ownership and persistence

The curator is resolved only from `Config.getProjectRoot()`. Its state lives at
`<project>/.qwen/skill-curator.json`, and archived packages live at
`<project>/.qwen/archived-skills/`. There is no fallback to the process's
primary workspace, home directory, or another active session. This keeps
daemon and multi-workspace sessions isolated.

State is keyed by the auto-skill directory name because that is the unit moved
to and from the archive. Each record stores the frontmatter skill name,
first-seen time, last successful use, use count, lifecycle state, and optional
archive time. Writes are serialized with a cross-process lock and committed
atomically.

Corrupt state is a hard, non-mutating failure. The curator must not infer that
missing usage means inactivity when its persisted evidence cannot be read.

## Eligibility and safety

A directory is curator-managed only when every condition holds:

1. It is a direct, non-symlink directory under the project skills root.
2. Its name starts with `auto-skill-`.
3. It contains a regular, non-symlink `SKILL.md`.
4. The opening YAML frontmatter contains exactly `source: auto-skill`.

This double marker prevents the curator from moving hand-authored, learned,
extension, bundled, personal, malformed, or symlinked content. Archive and
restore refuse destination collisions and never overwrite an existing skill.
If state persistence fails after moves, the pass attempts to move every package
back before surfacing the error.

## Activity and transitions

When Auto Skill is enabled, a successful Skill tool or direct skill
slash-command invocation updates the record best-effort. Failed, disabled, or
hook-blocked invocations do not count.

For a live skill, activity is the newest of:

- the persisted last successful invocation;
- the persisted first-seen time;
- the persisted restore time; and
- the skill manifest modification time.

Including modification time prevents a recently improved skill from being
archived merely because it has not yet been invoked again.

The first automatic observation seeds `lastRunAt` and all current eligible
skills with `firstSeenAt = now`, then waits a full 7-day interval. Explicit
`/curator run` bypasses the interval; `--dry-run` reports candidates without
moving directories or changing state.

## Integration points

- `Config.initialize`: performs the due deterministic pass before
  `SkillManager` scans the filesystem.
- `SkillTool`: records a successful managed-skill invocation.
- `SkillCommandLoader` and the interactive/non-interactive command processors:
  record successful direct slash-command invocations; ACP reuses the
  non-interactive processor.
- `SkillManager`: its existing refresh path is used after manual archive or
  restore so the model and slash-command surfaces immediately match disk.
- `BuiltinCommandLoader`: publishes the new `/curator` command.

No other consumer should write curator state or move managed skill packages.

## Verification

Unit tests cover eligibility, first-run seeding, stale/archive thresholds,
dry-run non-mutation, recent-use protection, recently-modified protection,
corrupt-state fail-closed behavior, collision handling, restoration, and the
command surface. Existing Skill tool tests verify that only successful loads
record usage. Build and typecheck cover the cross-package export and command
registration.
