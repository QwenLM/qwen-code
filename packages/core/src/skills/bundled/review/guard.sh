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

# Bail out cleanly if jq is missing; we don't want the guard itself to be a
# reason for /review to fail. Surface a stderr warning so the silent
# fallback is observable in CI logs / `gh run view --log` rather than
# disabling the worktree protection invisibly. The CLI gates
# (pr-context, presubmit, ...) remain as the second line of defense.
if ! command -v jq >/dev/null 2>&1; then
  echo 'qwen-review guard.sh: jq not found; allowing all commands. Install jq to re-enable shell-level worktree protection.' >&2
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

deny() {
  local reason='Blocked during /review: this command would modify HEAD or the working tree. The review skill must use the isolated worktree created by `qwen review fetch-pr` and operate inside the returned `worktreePath`. Re-run `qwen review fetch-pr <pr> <owner>/<repo> --out .qwen/tmp/qwen-review-pr-<pr>-fetch.json` and `cd` into the worktreePath instead of switching the user'\''s branch.'
  printf '%s' "$reason" | jq -Rs '{decision:"deny", reason:., hookSpecificOutput:{permissionDecision:"deny", permissionDecisionReason:.}}'
  exit 0
}

# Command-boundary prefix. Anything that is NOT a "command-name character"
# (alnum / `_` / `.` / `/` / `-`) is treated as a boundary. This catches the
# obvious whitespace / `&&` / `;` cases plus the previously-bypassed
# `(`, `$(`, backtick, `|`, `||`, and `eval "..."` injection paths — none
# of those characters fall in the word-character class.
P='(^|[^A-Za-z0-9_./-])'

matches() {
  printf '%s' "$CMD" | grep -Eq "$1"
}

# 1. `gh pr checkout` — switches the user's local branch to the PR head.
if matches "${P}gh[[:space:]]+pr[[:space:]]+checkout([[:space:]]|\$)"; then
  deny
fi

# 2. `git switch` in any form. There is no read-only `git switch` invocation
#    we want to allow inside /review; deny the bare command and every flag
#    variant including `-c`, `-C`, `--detach`, and the implicit-detach
#    branch-name form.
if matches "${P}git[[:space:]]+switch([[:space:]]|\$)"; then
  deny
fi

# 3. `git pull` — fetches and merges into HEAD.
if matches "${P}git[[:space:]]+pull([[:space:]]|\$)"; then
  deny
fi

# 4. `git reset --hard` — discards working-tree state against another ref.
if matches "${P}git[[:space:]]+reset[[:space:]]+--hard"; then
  deny
fi

# 5. `git checkout`. The only safe form is `git checkout -- <pathspec>`
#    (file-restore — does NOT move HEAD). Everything else moves HEAD:
#      - `git checkout BRANCH`             (matched by `[^-]`)
#      - `git checkout -b/-B/-c/-C NEW`    (matched by `-[^-[:space:]]`)
#      - `git checkout --detach <commit>`  (matched by `--[^[:space:]]`)
#      - `git checkout --orphan NEW`       (matched by `--[^[:space:]]`)
#    The allow form `git checkout -- file.ts` has a space after `--`, which
#    does not match any of the three alternations and therefore falls
#    through to allow. Bare `git checkout` (no args) also falls through.
if matches "${P}git[[:space:]]+checkout[[:space:]]+([^-]|-[^-[:space:]]|--[^[:space:]])"; then
  deny
fi

printf '{"decision":"allow"}\n'
