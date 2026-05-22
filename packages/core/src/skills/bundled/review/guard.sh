#!/usr/bin/env bash
# /review session guard.
#
# Registered as a PreToolUse hook in SKILL.md frontmatter. Refuses
# `run_shell_command` calls that would mutate the user's working tree —
# `gh pr checkout`, `git checkout <branch>`, `git switch`, `git pull`,
# `git reset --hard`. The /review skill MUST use the worktree created by
# `qwen review fetch-pr`; bypassing it contaminates the user's local state.
#
# This is a backstop. The primary enforcement is `qwen review fetch-pr` +
# downstream subcommands hard-failing on a missing fetch-report. The hook
# catches the case where the LLM ran a forbidden command before any
# `qwen review` subcommand had a chance to refuse.
#
# Hook input is a single JSON line on stdin shaped like:
#   {"tool_name": "run_shell_command", "tool_input": {"command": "..."}}
# Output is a single JSON line on stdout: {"decision": "allow" | "deny", ...}.

set -eu

INPUT=$(cat)

# Bail out cleanly if jq is missing; we don't want the guard itself to
# become a reason for /review to fail.
if ! command -v jq >/dev/null 2>&1; then
  printf '{"decision":"allow"}\n'
  exit 0
fi

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || true)
if [ "$TOOL" != "run_shell_command" ] && [ "$TOOL" != "Bash" ] && [ "$TOOL" != "Shell" ]; then
  printf '{"decision":"allow"}\n'
  exit 0
fi

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || true)
if [ -z "$CMD" ]; then
  printf '{"decision":"allow"}\n'
  exit 0
fi

# Forbidden patterns. Each pattern is anchored loosely (allow leading whitespace
# and `cd … && …` prefixes) but tight enough not to flag obvious read-only
# variants like `git pull-request` (not a real command, but example) or
# `git checkout -- <file>` for discarding edits.
#
# - `gh pr checkout` — switches the user's current branch to the PR head.
# - `git checkout BRANCH` — switches HEAD; `git checkout --` (file restore)
#   is allowed because it does not move HEAD.
# - `git switch BRANCH` — like `git checkout BRANCH`. `--detach` is also
#   blocked since it still moves HEAD.
# - `git reset --hard` — discards working-tree changes against another ref.
# - `git pull` — fetches and merges; mutates HEAD.

if printf '%s' "$CMD" | grep -Eq \
  '(^|[[:space:]]|&&[[:space:]]*|;[[:space:]]*)(gh[[:space:]]+pr[[:space:]]+checkout|git[[:space:]]+checkout[[:space:]]+[^-]|git[[:space:]]+switch[[:space:]]+[^-]|git[[:space:]]+reset[[:space:]]+--hard|git[[:space:]]+pull([[:space:]]|$))'; then
  REASON='Blocked during /review: this command would modify HEAD or the working tree. The review skill must use the isolated worktree created by `qwen review fetch-pr` and operate inside the returned `worktreePath`. Re-run `qwen review fetch-pr <pr> <owner>/<repo> --out .qwen/tmp/qwen-review-pr-<pr>-fetch.json` and `cd` into the worktreePath instead of switching the user'\''s branch.'
  # Build the JSON via jq to escape the reason properly.
  printf '%s' "$REASON" | jq -Rs '{decision:"deny", reason:., hookSpecificOutput:{permissionDecision:"deny", permissionDecisionReason:.}}'
  exit 0
fi

printf '{"decision":"allow"}\n'
