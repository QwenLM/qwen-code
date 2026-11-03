# Web Shell workspace file changes

[English](web-shell-workspace-file-changes.md) | [简体中文](web-shell-workspace-file-changes.zh-CN.md)

## Problem and scope

The edited-files card collects successful `write_file` and `edit` calls without
checking their workspace or Git ignore status. Global memory, other projects and
ignored auxiliary scripts consequently inflate the file count and line totals.
Keep the complete transcript; filter only the derived file-change presentation.
Do not infer temporary intent from filenames, change artifact publication, or
replace per-turn edits with the current Git diff.

## Behavior

Only paths contained in the session working directory, including descendants,
appear in the file-change summary and its review. A managed session worktree is
the working directory when present; the base workspace remains the route owner.
Git-tracked paths and non-ignored untracked paths remain visible. Git-ignored
untracked paths are excluded. A non-Git directory uses containment alone.
`.qwenignore` does not determine visibility. Explicit artifact cards and full
tool details remain unchanged. If no visible edits remain, omit the file card.

## Implementation

### Query contract

`workspace_git_check_ignore` advertises
`POST /workspaces/:workspace/git/check-ignore`. The JSON body is
`{ "paths": ["src/app.ts", "helper.log"] }`; each path is relative to `cwd`,
or the workspace root when `cwd` is omitted.
At most 256 paths are accepted, each with 1–4096 characters; absolute paths,
NUL, backslashes and `.`/`..` segments are rejected with HTTP 400 and
`code: "invalid_paths"`. Success returns
`{ "v": 1, "ignoredPaths": ["helper.log"] }`. This lists confirmed ignored
paths; absence is not a negative verdict when bounded probing stops early.
`WorkspaceDaemonClient.workspaceGitIgnoredPaths(paths, cwd?, sessionId?)` uses
REST and forwards the optional execution directory and owning session for the
existing managed-worktree validation. Unknown, unavailable and untrusted
runtime errors retain their existing failure semantics.
Local Git execution failures return HTTP 503 with
`code: "git_ignore_unavailable"`.

Add a bounded, read-only batch Git-ignore query on the workspace-qualified Git
routes, with an SDK method and capability tag. Resolve the selected trusted
runtime and validate the session cwd using the existing Git route ownership
rules. Never fall back to the primary runtime. Ask Git directly with
`check-ignore`, without `--no-index`, so its index, nested rules, negations,
global excludes and linked worktrees retain Git semantics. Bound subprocess
runtime and output, sanitize its environment and disable executable Git config.
Runtime overlays use their snapshots (empty when absent); parent-process runtimes
without a snapshot inherit the daemon environment captured at boot.
Limit each request to 32 Git probes and a shared deadline (5 seconds locally,
30 seconds over SSH). Keep known verdicts when unsupported symlink/submodule
paths or the budget leave other paths unclassified; unclassified paths remain
visible. Cancel local probes when the request disconnects.

Use a shared Web Shell hook to filter the per-turn selector output in the main
chat, secondary chat pane and subagent detail. Normalize relative and absolute
paths, rejecting traversal and sibling-prefix paths. Query unique contained
paths in batches, without reading file contents or scanning the whole tree.
Apply the same visible subset to the count, line totals and review data. Ignore
stale asynchronous results after changes to the workspace, session or inputs.
Wait for the first classification before showing a file card. Preserve already
classified files during refresh; a new path waits for its own verdict. External
edits do not invalidate the workspace query. Re-query on connection recovery.
Restored reviews also await classification. Reuse a current session's in-memory
transcript when it contains the requested edits; page persisted history only
when they are missing. Reclassify open reviews after visibility or connection
changes, preserving their original unfiltered diff snapshots. Keep earlier
positive ignore verdicts if a later client batch fails; unclassified paths stay
visible. Restore containment from a standalone session's output directory; an
unknown root retains edits instead of
turning them into a missing-content error. Live sessions that do not expose a
working directory also retain their original per-turn changes. Resolve virtual
subagent worktrees through their real parent session, even without the Git-ignore
capability, and keep execution metadata independent of
session-details presentation. Unknown execution metadata must not use the base
checkout's ignore rules as if they were authoritative. Standalone sessions use
their own output directory for containment without issuing a workspace query.
While execution metadata is pending, show no file card. A failed metadata lookup
settles into containment-only fallback and retries after recovery. Windows path
normalization preserves the drive root even when `..` would cross it.
Legacy current-session review tabs can recover missing workspace identity from
the connected session and its advertised trusted owner; explicit stored identity
continues to be validated.

## Compatibility and risks

Older or unavailable daemons retain contained edits when ignore status cannot be
confirmed. Unknown ignore status is not proof that a file is ignored. Resolve
fresh verdicts when edit inputs change; this is not a filesystem watcher for
historical cards. SSH queries must execute against the remote runtime, never
against local paths. SSH retains its existing root-only inspection policy;
unsupported cwd overrides fall back to containment, without local execution.
Host-provided transcript data remains unchanged.
Path comparisons preserve case and do not resolve filesystem aliases; an
otherwise identical absolute path with different casing can be omitted. A
home-relative `~/...` path is not treated as workspace-relative.

## Validation and acceptance

- Real Git tests cover tracked files matching ignores, ignored and visible new
  files, nested rules, negations, global excludes and non-Git directories.
- Route tests cover selected runtime, session cwd validation, invalid inputs,
  untrusted/unknown/closed workspaces and generation closure during requests.
- Frontend tests cover containment, totals, all-hidden turns, async races and
  older-daemon fallback; history must not depend on current dirty Git files.
- Browser E2E checks the card and opened review with a simulated daemon, clearly
  distinguished from real Git verification; inspect a captured screenshot.
- Build, typecheck, bundle, focused tests, formatting and two clean diff audits.

## Open questions

None for this scope. Files in the workspace that Git does not ignore remain
visible, even when they are temporary scripts.
