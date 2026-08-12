#!/usr/bin/env bash
set -uo pipefail

# Re-sanitizes the git config surfaces a PAT-bearing git step is about to
# read, AFTER branch/agent code has run on the host. The inlined job-start
# sanitize steps are pre-checkout hygiene; between them and the push, the
# verification gates run branch test code on the host and the sandboxed
# agent has the workspace mounted — either can plant exec keys in the
# repo's LOCAL .git/config (the highest-precedence file, which the push
# reads) or rewrite the runner user's REAL global config: the gates' env
# redirect is inherited-env enforcement, not a filesystem boundary — a
# direct file write, `env -u GIT_CONFIG_GLOBAL git config --global`, or
# `git config --file "$HOME/.gitconfig"` all bypass it (probe-verified in
# the #8961 review).
#
# Invoked as `bash "${RUNNER_TEMP}/resanitize-git-config.sh"` from the
# copy the staging step took off the TRUSTED base checkout — never from
# the working tree, which holds the branch under test at call time.
#
# The allowlist and denylist are copies of the inlined pre-checkout
# sanitize steps in qwen-autofix.yml (which cannot call this script: it
# does not exist on disk before their checkout). The workflow contract
# tests pin every copy byte-identical — edit them together.

if [ -e .git ]; then
  # Worktree-scoped config first, then the local allowlist sweep — same
  # ordering rationale as the inlined step (config.worktree can carry
  # core.hooksPath and is invisible to `git config --local`).
  rm -f "$(git rev-parse --git-path config.worktree 2>/dev/null || echo /nonexistent)" 2>/dev/null || true
  git config --local --unset-all extensions.worktreeConfig 2>/dev/null || true
  git config --local --name-only --list 2>/dev/null \
    | { grep -ivE '^(core\.(repositoryformatversion|bare|filemode|symlinks|ignorecase|precomposeunicode|logallrefupdates|worktree|hidedotfiles|protecthfs|protectntfs)|remote\.[^.]+\.(url|fetch|pushurl)|branch\.|extensions\.|gc\.|pack\.|fetch\.|index\.|safe\.|submodule\.[^.]+\.(url|active|branch))' || true; } \
    | while IFS= read -r key; do git config --local --unset-all "$key" 2>/dev/null || true; done
fi
{ git config --global --name-only --list 2>/dev/null || true; } \
  | { grep -iE '^(core\.(hookspath|fsmonitor|pager|editor|sshcommand|askpass|alternaterefscommand|gitproxy)$|diff\.external$|diff\..+\.(command|textconv)$|merge\..+\.driver$|filter\.|alias\.|pager\.|difftool\.|mergetool\.|interactive\.difffilter$|sequence\.editor$|gpg\.(.+\.)?program$|init\.templatedir$|remote\..+\.(uploadpack|receivepack)$|submodule\..+\.update$|include\.|includeif\.|protocol\.ext\.allow$)' || true; } \
  | while IFS= read -r key; do git config --global --unset-all "$key" 2>/dev/null || true; done
