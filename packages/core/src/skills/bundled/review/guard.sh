#!/usr/bin/env bash
# /review session guard — best-effort speed bump.
#
# Registered as a PreToolUse hook in SKILL.md frontmatter. Refuses obvious
# `run_shell_command` invocations that would mutate the user's working tree —
# `gh pr checkout`, `git checkout <branch>`, `git switch`, `git pull`,
# `git reset --hard`. The /review skill MUST use the worktree created by
# `qwen review fetch-pr`; bypassing it contaminates the user's local state.
#
# Primary enforcement is on the CLI side: `qwen review fetch-pr` +
# `requireFetchReport` in pr-context / presubmit / deterministic --pr /
# load-rules --pr. Those gates are pure-Node string compares and cannot be
# bypassed by shell tricks. This script is only a second-line backstop that
# trips the common careless cases (LLM types `git checkout main`).
#
# Known bypass classes the regex deliberately does NOT plug — anyone trying
# to defeat the guard can drive the runtime command to `git checkout main`
# while the literal string seen here contains no `git checkout`:
#   - parameter expansion (other than `$IFS`):  ${cmd:-git} checkout main
#   - command substitution producing the verb:  $(echo git) checkout main
#   - backslash-newline line continuation that bash collapses pre-tokenise
#   - xargs argument-supply:  echo main | xargs git checkout
#   - PATH-prefixed binaries: /usr/bin/git checkout main
#   - global git options:    git -C /repo checkout main
# Rule 6 below explicitly closes the `git$IFS` / `gh${IFS}` neighborhood
# variants (the most common parameter-expansion bypass tried in practice).
# Plugging the rest would require parsing bash ourselves, which is the wrong
# tool. Trust the CLI gates as the deterministic control; treat this script
# as documentation-with-teeth for the everyday case.
#
# Hook input is a single JSON line on stdin shaped like:
#   {"tool_name": "run_shell_command", "tool_input": {"command": "..."}}
# Output is a single JSON line on stdout: {"decision": "allow" | "deny", ...}.

set -eu

INPUT=$(cat)

# Self-disable when no /review session is active. `unregisterSkillHooks` is a
# documented no-op (`packages/core/src/hooks/registerSkillHooks.ts`), so this
# hook outlives any single `/review` invocation for the rest of the
# interactive CLI session. Without this gate, a follow-up `git checkout main`
# in the same conversation — long after `/review N` finished — would still be
# denied with a recovery message pointing at a review session that no longer
# exists.
#
# TWO markers count as "/review session active":
#   1. `.qwen/tmp/qwen-review-active`         — written at skill activation
#      by `registerSkillHooks.ts`. Covers the pre-fetch-pr window where the
#      LLM might `git checkout FETCH_HEAD` before ever calling fetch-pr.
#   2. `.qwen/tmp/qwen-review-pr-*-fetch.json` — written by `fetch-pr` once
#      the worktree exists. Persists across the rest of the session until
#      `qwen review cleanup` removes both.
# Either marker keeps the guard active; both are removed by `cleanup`.
#
# Anchor the lookup at `$QWEN_PROJECT_DIR` (set by `hookRunner.ts:575` from
# `config.getWorkingDir()`) rather than the bash cwd: in a compliant review
# flow the LLM may `cd` into the worktree, and a cwd-relative `ls` would
# then look at `<worktree>/.qwen/tmp/...` (empty) and self-disable the
# guard right when it matters most. Fall back to `.` only for direct
# script invocation in tests where the env var isn't set.
PROJECT_DIR="${QWEN_PROJECT_DIR:-.}"
if [ ! -f "$PROJECT_DIR/.qwen/tmp/qwen-review-active" ] \
   && ! ls "$PROJECT_DIR"/.qwen/tmp/qwen-review-pr-*-fetch.json >/dev/null 2>&1; then
  printf '{"decision":"allow"}\n'
  exit 0
fi

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

# The SKILL.md matcher is `^run_shell_command$`; `sessionHooksManager`
# compiles it into a RegExp anchored on both ends, so `Bash` / `Shell`
# tool_names never reach this script. Keep the check tight rather than
# carrying dead aliases.
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || true)
if [ "$TOOL" != "run_shell_command" ]; then
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
  # Fail closed: if jq itself errors out (e.g. corrupt install, exotic
  # locale) the `set -eu` at the top would otherwise abort the function
  # before any JSON is printed, and the hook runner would default to
  # `allow` on missing output. Emit a static deny JSON as a fallback so
  # the guard's decision still reaches the caller even when jq is sick.
  if ! printf '%s' "$reason" | jq -Rs '{decision:"deny", reason:., hookSpecificOutput:{permissionDecision:"deny", permissionDecisionReason:.}}'; then
    printf '{"decision":"deny","reason":"Blocked during /review (static deny: jq failed)."}\n'
  fi
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

# 4. `git reset` in any form that moves HEAD or unstages everything. The
#    only safe forms that fall through are:
#      - bare `git reset` (no args)
#      - `git reset -- <pathspec>`  (the `-- ` after `reset ` doesn't
#        match `--[a-z]` or `[^-]` below)
#    Single-token forms that move HEAD or change index state are denied:
#      - `git reset HEAD~1`            (matched by `[^-]`)
#      - `git reset --hard <ref>`      (matched by `--[a-z]`)
#      - `git reset --soft/mixed/merge/keep <ref>` (same)
#      - `git reset HEAD`              (matched by `[^-]`; conservative —
#        semantically equivalent to bare `git reset` but explicit)
#    Mirrors rule 5's deny-the-dangerous-form approach rather than
#    allow-the-safe-form-only — the previous unanchored inner allow let
#    `git reset --hard HEAD && git reset -- file.ts` slide through because
#    the second `reset -- ` satisfied the exception for the first.
if matches "${P}git[[:space:]]+reset[[:space:]]+(--[a-z]|[^-])"; then
  deny
fi

# 5. `git checkout`. The only safe form is `git checkout -- <pathspec>`
#    (file-restore — does NOT move HEAD). Everything else moves HEAD:
#      - `git checkout BRANCH`             (matched by `[^-]`)
#      - `git checkout -`                  (matched by `-($|[^-])` — "previous branch")
#      - `git checkout -b/-B/-c/-C NEW`    (matched by `-($|[^-])`)
#      - `git checkout --detach <commit>`  (matched by `--[^[:space:]]`)
#      - `git checkout --orphan NEW`       (matched by `--[^[:space:]]`)
#    The allow form `git checkout -- file.ts` has a space after `--`, which
#    does not match any of the three alternations (`-($|[^-])` fails on
#    the first `-` because next char is `-`, and `--[^[:space:]]` fails
#    because next char after `--` is space). Bare `git checkout` (no args)
#    also falls through.
if matches "${P}git[[:space:]]+checkout[[:space:]]+([^-]|-($|[^-])|--[^[:space:]])"; then
  deny
fi

# 6. `$IFS` / `${IFS}` adjacent to `git` or `gh`. Bash expands `git$IFS` to
#    `git ` (space) at runtime, so `git$IFS checkout main` actually runs
#    `git checkout main` even though rules 1-5 see `git$IFS` as one word.
#    Anchor the deny to the same `git`/`gh` neighborhoods rules 1-5 use so
#    legitimate strings that mention `$IFS` literally — most importantly
#    commit messages and CHANGELOG entries authored from inside a /review
#    session ("fix: deny $IFS in guard.sh") — pass through untouched.
#    Other parameter expansions (`${cmd:-git}`, `$(echo git)`, etc.) remain
#    documented bypasses; the CLI gates (`requireFetchReportFor` in
#    pr-context / presubmit / deterministic --pr / load-rules --pr /
#    autofix-gate) are the deterministic primary control.
if matches "${P}(git|gh)\\\$\\{?IFS"; then
  deny
fi

printf '{"decision":"allow"}\n'
