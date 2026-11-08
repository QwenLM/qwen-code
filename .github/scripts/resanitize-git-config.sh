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
  # Repo-scope redirect files first. `.git/commondir` (the file twin of
  # GIT_COMMON_DIR) repoints local config, refs AND objects — a plant makes
  # the very --local sweep below act on the ATTACKER's config, and lets the
  # PAT push deliver attacker content; `.git/shallow` (twin of
  # GIT_SHALLOW_FILE) narrows the object graph. A normal actions/checkout is
  # not a linked worktree, so neither file legitimately exists here —
  # removing them cannot break a real checkout, only defuse a plant. Then
  # config.worktree (can carry core.hooksPath, invisible to `git config
  # --local`), then the local allowlist sweep.
  GIT_DIR_PATH="$(git rev-parse --git-dir 2>/dev/null || echo .git)"
  rm -f "${GIT_DIR_PATH}/commondir" "${GIT_DIR_PATH}/shallow" 2>/dev/null || true
  rm -f "$(git rev-parse --git-path config.worktree 2>/dev/null || echo /nonexistent)" 2>/dev/null || true
  git config --local --unset-all extensions.worktreeConfig 2>/dev/null || true
  git config --local --name-only --list 2>/dev/null \
    | { grep -ivE '^(core\.(repositoryformatversion|bare|filemode|symlinks|ignorecase|precomposeunicode|logallrefupdates|worktree|hidedotfiles|protecthfs|protectntfs)|remote\..+\.(url|fetch|pushurl)|branch\.|extensions\.|gc\.|pack\.|fetch\.|index\.|safe\.|submodule\..+\.(url|active|branch))' || true; } \
    | while IFS= read -r key; do git config --local --unset-all "$key" 2>/dev/null || true; done
fi
# The GLOBAL scope spans TWO files — ~/.gitconfig and
# ${XDG_CONFIG_HOME:-~/.config}/git/config — but with both present,
# `git config --global` lists and unsets ONLY ~/.gitconfig (probed on
# git 2.43 and 2.55: the listing omits the XDG keys and --unset-all
# exits 5 with them live), so sweep each file explicitly by pointing
# GIT_CONFIG_GLOBAL at it — the env var replaces the whole global
# scope with exactly that file, for reads and writes alike.
for global_file in "${HOME}/.gitconfig" "${XDG_CONFIG_HOME:-${HOME}/.config}/git/config"; do
  { GIT_CONFIG_GLOBAL="${global_file}" git config --global --name-only --list 2>/dev/null || true; } \
    | { grep -iE '^(core\.(hookspath|fsmonitor|pager|editor|sshcommand|askpass|alternaterefscommand|gitproxy)$|diff\.external$|diff\..+\.(command|textconv)$|merge\..+\.driver$|filter\.|alias\.|pager\.|difftool\.|mergetool\.|interactive\.difffilter$|sequence\.editor$|gpg\.(.+\.)?program$|init\.templatedir$|remote\..+\.(uploadpack|receivepack)$|submodule\..+\.update$|url\..+\.(insteadof|pushinsteadof)$|http\.(.+\.)?(sslverify|sslcainfo)$|include\.|includeif\.|protocol\.(ext\.)?allow$)' || true; } \
    | while IFS= read -r key; do GIT_CONFIG_GLOBAL="${global_file}" git config --global --unset-all "$key" 2>/dev/null || true; done
done
