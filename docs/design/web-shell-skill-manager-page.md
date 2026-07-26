# Web Shell Skill Management

## Goal

Add an in-place Skill management page that preserves invocation behavior and
lets trusted users install, enable, disable, and delete Skills without an
active chat session.

## Behavior

- `/skills`, `/skills detail`, and `/skills details` open the page.
- The sidebar Plugins page exposes Skills as its third tab.
- The first level lists skills with search and scope filters.
- Skill cards omit scope badges; scope remains available through the filters
  and on the details page.
- Layout, responsive card grid, badges, breadcrumbs, and empty states match the
  MCP management page.
- Selecting a skill opens its details in the same page.
- Returning from details preserves the active scope filter and search query.
- The details page exposes the daemon's per-skill enable/disable action. Skills
  that are not user-invocable cannot be toggled; extension skills can be
  toggled unless their parent extension is inactive.
- “Reference skill” returns to chat and places `/<skill-name>` in the composer
  without submitting it.
- The list header exposes an Upload action for GitHub, daemon-local folder, and
  ZIP sources.
- The detail actions menu exposes Delete for project and global Skills with a
  destructive confirmation step. Bundled and extension Skills remain
  read-only.
- Successful mutations refresh the list; errors remain visible in context.

## Protocol

The daemon advertises `workspace_skill_manage` and exposes workspace-bound and
workspace-qualified variants of:

- `POST /workspace/skills/install`
- `DELETE /workspace/skills/:name`

Install accepts `scope: "workspace" | "global"` and one source:

- `github`: an HTTPS GitHub URL pointing to `SKILL.md`.
- `folder`: an absolute folder path on the daemon host.
- `zip`: one bounded base64 ZIP archive.

Delete accepts the same scope. The requested scope must match the discovered
Skill level before deletion.

## Filesystem and validation

- Workspace Skills are confined to `<workspace>/.qwen/skills/<slug>`.
- Global Skills are confined to `<QWEN_HOME>/skills/<slug>`.
- Deletion also accepts discovered project/user Skills in compatible
  `.agents/skills` provider directories.
- Slugs allow only letters, digits, `.`, `_`, and `-`, excluding `.` and `..`.
- Every package must contain a root `SKILL.md`; a single enclosing folder is
  stripped from folder and ZIP uploads.
- File count, individual size, aggregate size, path depth, and path length are
  bounded below the daemon JSON parser limit.
- Absolute paths, traversal, duplicate normalized paths, symbolic links, and
  special ZIP entries are rejected.
- `SKILL.md` frontmatter `name` must match the requested slug.
- Installation stages into a sibling directory and safely replaces the
  destination with rollback only after validation succeeds.
- Deletion validates the discovered canonical `SKILL.md` and dedicated parent
  directory before recursively removing it.

After a mutation, cached workspace Skill status is invalidated and active ACP
sessions refresh their SkillManager and slash-command snapshots.

## Scope

This change adds the standalone Skill page and reuses it in Plugins. It does not
migrate the Tools and Agents management pages.

## Testing

- Unit-test filtering and selection retention.
- Verify the slash-command route opens the Skill panel and that starting a new
  task rebuilds Skill commands from the latest workspace status.
- Route and service tests cover both scopes, each install source, replacement,
  traversal and ZIP-bomb limits, source mismatch, protected sources, and
  refresh.
- SDK and WebUI tests cover request serialization and action exposure.
- Run Web Shell typecheck, build, and focused tests to verify the management UI
  integration.
