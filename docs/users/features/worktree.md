# Worktrees

> Isolate experimental work in a temporary [git worktree](https://git-scm.com/docs/git-worktree) without leaving your current session. Useful when the model is about to make wide-ranging edits you want to keep separate from your main checkout, or when you want a subagent to work in a sandbox of its own.

## Quick Start

### Start the session inside a worktree (`--worktree` flag)

If you know up front that the entire session should run inside a worktree, pass `--worktree` at launch:

```bash
# Auto-generated slug (e.g. tender-jemison-037f0a)
qwen --worktree

# Explicit name
qwen --worktree my-feature

# `=` form (recommended when also passing a positional prompt — see tip below)
qwen --worktree=my-feature

# PR reference — fetches refs/pull/<N>/head from `origin`
qwen --worktree=#4174
qwen --worktree https://github.com/QwenLM/qwen-code/pull/4174

# Continue a previous --worktree session — re-attaches to the existing dir
qwen --resume <session-id> --worktree=my-feature
```

> **Tip — bare `--worktree` followed by a positional prompt is ambiguous.** Because `--worktree` takes an optional value, `qwen --worktree "say hi"` makes yargs consume `"say hi"` as the slug (and reject it because of the space). Use one of:
>
> - `qwen --worktree=my-feature "say hi"` (always works — explicit slug via `=`)
> - `qwen "say hi" --worktree` (positional first, flag at the end → auto slug)
> - `qwen --worktree --approval-mode yolo "say hi"` (any flag between them anchors the bare form)

> **Tip — `qwen --resume --worktree foo` (no session ID) shows an empty picker on first use.** The picker scopes to the chosen worktree's session storage; sessions started outside that worktree are not listed. To resume a session that was started inside `foo`, use `qwen --resume <id> --worktree foo` directly — the CLI re-attaches to the existing `foo/` directory rather than re-creating it.

`process.cwd()` and the model's workspace are switched to the worktree before the first turn runs. Exit with `Ctrl+C` twice and the [Exit Dialog](#exit-dialog-ctrlc--ctrld) prompts to keep or remove the worktree.

The `--worktree` flag cannot be combined with `--acp`/`--experimental-acp` — for ACP hosts (like Zed), pass the worktree path as the `cwd` of the `loadSession`/`newSession` request instead.

### Or ask mid-session

Alternatively, ask Qwen Code in plain language to create a worktree from inside an existing session:

```text
> start a worktree called experiment-a
Worktree experiment-a created on branch worktree-experiment-a
.qwen/worktrees/experiment-a
```

From this point on, the model routes every file edit and shell command through `.qwen/worktrees/experiment-a/`. Your original working directory is untouched.

When you are done:

```text
> exit the worktree and remove it
Removed worktree experiment-a (branch worktree-experiment-a)
```

If you want to come back later, ask to exit with the worktree kept on disk instead:

```text
> exit the worktree but keep it
Kept worktree experiment-a at .qwen/worktrees/experiment-a
```

## When Worktrees Are Used

Worktrees are activated in four independent paths:

| Trigger                                         | What happens                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| You launch with `--worktree`                    | The CLI creates the worktree before any model turn runs and chdirs the session into it. PR forms (`#N`, full URL) fetch first. |
| You explicitly ask for a worktree mid-session   | Model calls `enter_worktree`; subsequent file edits go inside it.                                                              |
| You explicitly ask to leave                     | Model calls `exit_worktree` with `keep` or `remove`.                                                                           |
| Model spawns a sub-agent with isolation enabled | A throwaway worktree (`agent-<hex>`) is created automatically and cleaned up if the agent has no diffs.                        |

The two mid-session tools (`enter_worktree` / `exit_worktree`) are deliberately gated behind explicit phrasing — saying "fix this bug" or "create a branch" will **not** trigger them. You must say something like "use a worktree", "start a worktree", or "in a worktree". The `--worktree` CLI flag has no such guard; it always creates one when present.

## What Gets Created

Every Qwen-managed worktree is placed under your project's `.qwen` directory:

```
<repoRoot>/.qwen/worktrees/<slug>/         # Working directory
                          ↳ branch worktree-<slug>   # Created off your current branch
```

- **Slug** — letters, digits, dot, underscore, hyphen; max 64 chars. If you don't specify a name, an `<adjective>-<noun>-<6hex>` slug is auto-generated (e.g. `tender-jemison-037f0a`). PR references produce `pr-<N>`.
- **Branch** — always `worktree-<slug>`, branched from whichever branch you have checked out when you ask for the worktree (not necessarily the main working tree's `HEAD`). For PR worktrees the branch is `worktree-pr-<N>` and is based on `FETCH_HEAD` (the PR's tip on the GitHub side) rather than your local branch.
- **Hooks** — the worktree's `core.hooksPath` is automatically pointed at the main repo's `.husky/` (preferred) or `.git/hooks/` so commits inside the worktree still trigger your existing pre-commit / commit-msg hooks.
- **Optional symlinks** — directories listed in `worktree.symlinkDirectories` (see [Settings](#settings)) are symlinked from the main repo into the new worktree so heavy dirs like `node_modules` can be reused without reinstalling.

The general-purpose worktree path is **not configurable** — it must live under `<repoRoot>/.qwen/worktrees/` so the CLI can find it on restart and on stale-cleanup sweeps. (The unrelated `agents.arena.worktreeBaseDir` setting controls only [Agent Arena](./arena.md) worktrees, which use a separate path tree under `~/.qwen/arena/`.)

## Footer and Status Line

When a worktree is active, the Footer shows a dim indicator on its own row:

```
⎇ worktree-experiment-a (experiment-a)
```

If you use a [custom status line script](./status-line.md), it also receives a `worktree` object in the JSON payload piped to stdin:

```json
{
  "worktree": {
    "name": "experiment-a",
    "path": "/path/to/repo/.qwen/worktrees/experiment-a",
    "branch": "worktree-experiment-a",
    "original_cwd": "/path/to/repo",
    "original_branch": "main"
  }
}
```

The payload field is present **only** when a worktree is active, so a `null`-check (`input.worktree?.name`) is enough.

If your custom status line already renders worktree info, you can hide the built-in Footer row to avoid duplication — see [Settings](#settings) below.

## Exit Dialog (Ctrl+C / Ctrl+D)

Pressing the quit shortcut twice while a worktree is active opens the **Worktree Exit Dialog** instead of closing the CLI:

```
⎇ Active worktree: "experiment-a" (worktree-experiment-a)

  • 2 new commit(s) on worktree-experiment-a
  • 3 uncommitted file(s)
  Removing the worktree will discard everything above.

What would you like to do?
  ○ Keep worktree (exit without deleting)
  ○ Remove worktree and branch (discards 2 commit(s), 3 file(s))
  ○ Cancel (stay in session)
```

The dialog inspects the worktree on open (`git status --porcelain` + `git rev-list <baseHEAD>..HEAD`) and surfaces both counts so you know exactly what you'd be discarding. `ESC` cancels.

If `git status` itself fails (e.g. corrupt index, worktree directory was removed under the CLI), the dialog shows a `⚠ Could not measure worktree state` warning and the counts may be unreliable — choose **Keep** or **Cancel** until you've diagnosed the underlying repo problem.

## `--resume` Restore

The active worktree binding is persisted to a sidecar file alongside your session transcript:

```
<chatsDir>/<sessionId>.worktree.json
```

When you launch the CLI with `--resume <sessionId>` (or pick the session from `/resume`), three things happen consistently across **interactive TUI**, **headless `-p`**, and **ACP/Zed** modes:

1. The sidecar is loaded and the worktree directory is verified to still exist on disk.
2. If alive, the model receives a one-shot reminder on its very next prompt:
   ```
   [Resumed] Active worktree: "<slug>" at <path> (branch: <branch>). Continue using this path for all file operations.
   ```
3. If the worktree directory was deleted between sessions, the stale sidecar is cleaned up automatically — no error, the resume just continues without worktree context.

Each mode chooses its own injection mechanism, but the user-visible behavior is identical:

| Mode              | Mechanism                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| Interactive (TUI) | `INFO` history item + system-reminder prefix on the next user prompt.                                  |
| Headless (`-p`)   | `<system-reminder>` prefix on the prompt + `worktree_restored` JSON system event in the output stream. |
| ACP (e.g. Zed)    | Pending notice attached to the next `prompt()` call.                                                   |

The model is **not** automatically `chdir`'d into the worktree — the reminder is what keeps it routing edits through the worktree path.

## Sub-Agent Isolation

The `agent` tool accepts an optional `isolation: "worktree"` parameter. When set, Qwen Code creates an ephemeral worktree at `<repoRoot>/.qwen/worktrees/agent-<7hex>/` before the sub-agent starts, and:

- **No changes** → the worktree is automatically removed when the agent finishes.
- **Has changes** → the worktree is preserved; its path and branch are appended to the agent's result, e.g.
  ```
  …agent output…
  [worktree preserved: /path/to/.qwen/worktrees/agent-3f2a1b9 (branch worktree-agent-3f2a1b9)]
  ```
  Review the diff and merge or delete it manually.

Two constraints:

- `isolation: "worktree"` requires a `subagent_type` — forked sub-agents (no `subagent_type`) reuse the parent's full conversation context, so isolating them would split intent from working tree.
- Background agents (`run_in_background: true`) work fine with isolation; the cleanup runs when the agent reports completion.

### Automatic Stale Cleanup

Ephemeral agent worktrees that survived a crash or `--no-cleanup` shutdown are reaped on every CLI startup, with conservative fail-closed rules:

| Guard                                  | Behavior                                       |
| -------------------------------------- | ---------------------------------------------- |
| Slug must match `agent-<7hex>` pattern | Named worktrees you created are never touched. |
| Directory `mtime` > 30 days            | Newer entries are skipped.                     |
| Any uncommitted tracked change         | Skip the entry (don't delete).                 |
| Any commit not reachable from a remote | Skip the entry (don't delete).                 |
| Any error reading git state            | Skip the entry (don't delete).                 |

Named user worktrees (`enter_worktree` slugs) are **never** auto-cleaned — you keep them around until you ask to remove them.

## Safety Guards on `exit_worktree action="remove"`

Three independent guards trigger before the directory and branch are deleted:

1. **Session ownership** — each worktree carries a sidecar marker with the session ID that created it. A different session trying to remove it is refused with a clear error pointing at `git worktree remove` for the manual escape hatch.
2. **Dirty working tree** — uncommitted tracked or untracked changes block removal. Pass `discard_changes: true` to override. (Bypass requires explicit user confirmation — `action: "remove"` is never auto-approved in AUTO_EDIT mode.)
3. **Unmerged commits** — commits on `worktree-<slug>` that no other local branch or remote ref points at block removal unconditionally; there is no "discard commits" flag because losing committed work is rarely what users mean. Merge, push, or rename the branch elsewhere first.

The same three guards apply to the `WorktreeExitDialog → Remove` button.

## Settings

Two settings shape the general-purpose worktree experience:

| Key                               | Type       | Default     | Effect                                                                                                                                                                                                                                                                     |
| --------------------------------- | ---------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui.hideBuiltinWorktreeIndicator` | boolean    | `false`     | Hides the built-in `⎇ worktree-… (…)` Footer row. The `worktree` field is still delivered to custom status line scripts. Set to `true` only if your status line already renders the worktree — otherwise you lose all UI affordance.                                       |
| `worktree.symlinkDirectories`     | `string[]` | `undefined` | Directories under the main repo to symlink into every general-purpose worktree on creation. Paths are relative to the repo root; absolute paths and any entry containing `..` are rejected. Missing sources and existing destinations are silently skipped (no overwrite). |

Example:

```jsonc
// ~/.qwen/settings.json or <repo>/.qwen/settings.json
{
  "worktree": {
    "symlinkDirectories": ["node_modules", ".turbo", "dist"],
  },
}
```

Applies to ALL worktree-creation paths: `--worktree` flag, `enter_worktree` tool, and `agent isolation: "worktree"`.

Settings unrelated to general worktrees but worth knowing about:

- `agents.arena.worktreeBaseDir` — controls **Agent Arena** worktree placement (default `~/.qwen/arena`). Does not affect general-purpose worktrees, which always live under `<repoRoot>/.qwen/worktrees/`.

There is no schema for `worktree.sparsePaths` yet — that's a roadmap item (see [Limitations](#limitations)).

## Tool Reference

### `enter_worktree`

```json
{ "name": "experiment-a" }
```

| Field  | Type   | Required | Notes                                                                                      |
| ------ | ------ | -------- | ------------------------------------------------------------------------------------------ |
| `name` | string | no       | Slug. Letters, digits, dot, underscore, hyphen; max 64 chars. Auto-generated when omitted. |

Refuses to run when:

- The CLI is not in a git repository.
- The current working directory is already inside `.qwen/worktrees/` (no nested worktrees).

### `exit_worktree`

```json
{ "name": "experiment-a", "action": "remove", "discard_changes": false }
```

| Field             | Type                   | Required                              | Notes                                                              |
| ----------------- | ---------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `name`            | string                 | yes                                   | Must match the slug used in `enter_worktree`.                      |
| `action`          | `"keep"` \| `"remove"` | yes                                   | `keep` preserves dir + branch; `remove` deletes both.              |
| `discard_changes` | boolean                | only when `action="remove"` and dirty | Overrides the dirty-tree guard. Has no effect for `action="keep"`. |

`action: "remove"` always prompts for confirmation, including under `AUTO_EDIT` approval mode — it is treated as a destructive shell operation, not an info-only tool.

### `agent` — `isolation` parameter

```json
{
  "subagent_type": "my-agent",
  "description": "…",
  "prompt": "…",
  "isolation": "worktree"
}
```

| Field       | Type         | Required | Notes                                                                                             |
| ----------- | ------------ | -------- | ------------------------------------------------------------------------------------------------- |
| `isolation` | `"worktree"` | no       | Runs the agent in a fresh `agent-<7hex>` worktree. Requires `subagent_type` to be set (no forks). |

See [Sub-Agents](./sub-agents.md) for the rest of the agent tool reference.

## CLI Reference

### `--worktree [name | #N | url]`

```bash
qwen --worktree                                               # auto-generate slug
qwen --worktree my-feature                                    # explicit slug
qwen --worktree=my-feature                                    # = form
qwen --worktree=#123                                          # PR reference
qwen --worktree https://github.com/owner/repo/pull/123        # PR URL
```

| Input                         | Result                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Bare flag (no value)          | Auto slug `<adjective>-<noun>-<6hex>`, branch `worktree-<slug>`, base = current branch.                               |
| Plain slug                    | Branch `worktree-<slug>`, base = current branch. Slug validation: letters/digits/dot/underscore/hyphen, max 64 chars. |
| `#N` or `<github-url>/pull/N` | Slug `pr-<N>`, branch `worktree-pr-<N>`, base = `FETCH_HEAD` after `git fetch origin pull/<N>/head` (30s timeout).    |

`--worktree` cannot be combined with `--acp` / `--experimental-acp`.

When `--worktree` is combined with `--resume <session-id>`, the worktree wins: the resumed session's saved worktree (if any) is overridden and a stderr line + first-prompt reminder report the override.

For interactive (TUI) and headless (`-p`) modes the worktree is automatically created and the session chdirs into it before the first turn.

PR-fetch failure modes (exit code != 0, no worktree created):

| Cause                         | Message excerpt                                            |
| ----------------------------- | ---------------------------------------------------------- |
| Missing `origin` remote       | `requires an "origin" remote that points at GitHub`        |
| PR doesn't exist on origin    | `Failed to fetch PR #<N>: the PR does not exist on origin` |
| 30s network timeout           | `Failed to fetch PR #<N>: timed out after 30s`             |
| PR number out of range / zero | `Invalid PR number`                                        |

## Limitations

The following items are intentionally not implemented in the current phase:

- **No sparse checkout.** Large monorepos check out the full tree. (`worktree.sparsePaths` is a roadmap item.)
- **No tmux integration.** The CLI does not spawn worktree sessions in new tmux windows.
- **Worktrees are separate "projects" for session storage.** Sessions started with `--worktree foo` are saved under that worktree's chats dir; to resume them later you must pass `--worktree foo` again. Sessions started without `--worktree` are saved under the main checkout and won't appear in the worktree's resume picker.
- **No cross-slug session override.** `qwen --resume <sid> --worktree second` where `<sid>` was created with `--worktree first` will fail to find the session — sessions and worktrees are tightly bound by `projectHash(cwd)`. To switch worktrees on an existing session you must exit, then re-launch with the new `--worktree` and a fresh prompt. A future architectural change (anchoring storage at the repo root instead of `cwd`) would lift this constraint.
- **Mid-session `enter_worktree` does NOT switch `process.cwd()` or `Config.targetDir`.** That tool uses the model-context-only convention (see [Sub-Agents](./sub-agents.md)). Only the startup `--worktree` flag actually switches the process working directory.
- **Relative paths in other arg fields are resolved BEFORE the worktree chdir.** Path-taking flags (`--mcp-config`, `--openai-logging-dir`, `--json-file`, `--input-file`, `--telemetry-outfile`, `--include-directories`) are normalized to absolute paths against the launch cwd when `--worktree` is set. Other path-shaped argv fields not in this list still resolve against the worktree cwd — use absolute paths to be safe.

Track the roadmap in `docs/design/worktree.md`.

## Troubleshooting

**The Footer shows no worktree indicator even though I just created one.**
Check that `ui.hideBuiltinWorktreeIndicator` is not set to `true`. Also confirm the slug is non-empty in the tool's success message.

**`--resume` does not restore my worktree.**
Check `<chatsDir>/<sessionId>.worktree.json` exists. The CLI deletes the sidecar automatically when the worktree directory is gone, so a missing sidecar plus a missing directory is the normal "no worktree to restore" state — not a bug. Run with `--debug` and grep for `restoreWorktreeContext` to see the reason.

**`exit_worktree` says "created by a different session".**
This is the session-ownership guard. Resume the original session and exit from there, or run the suggested `git worktree remove …` command manually.

**Stale `agent-<hex>` worktrees keep piling up.**
The 30-day cutoff is conservative; sweep manually with `git worktree list && git worktree remove <path>`, or wait — the next CLI startup after the 30-day mark will reap them as long as they are clean and pushed.
