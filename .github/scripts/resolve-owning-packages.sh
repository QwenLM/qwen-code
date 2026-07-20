#!/usr/bin/env bash
# Owning-workspace resolver, shared by the qwen-autofix verify steps
# (.github/workflows/qwen-autofix.yml) so the two gates cannot drift apart.
#
# Reads changed file paths on stdin (one per line, e.g. the output of
# `git diff --name-only`) and emits, sorted and unique on stdout, the OWNING
# npm workspace of each: the workspace whose location is the LONGEST matching
# path prefix of the file.
#
# The workspace set is the authoritative `npm query .workspace` list, NOT "any
# ancestor directory that has a package.json". Fixture/example packages such as
# packages/cli/src/commands/extensions/examples/starter carry their own
# package.json but are NOT workspaces — a nearest-package.json walk resolves a
# change there to the fixture (whose test script is not Vitest), silently
# SKIPPING packages/cli's own tests. Longest-workspace-prefix instead resolves
# it to packages/cli. Nested workspaces (packages/channels/base) match exactly;
# non-workspace paths (packages/sdk-python, a top-level packages/README.md, and
# the intentionally-excluded packages/desktop) match nothing and are dropped.
#
# `npm query` reads node_modules, which the calling gate has installed. Staged
# to RUNNER_TEMP from the trusted base checkout (never the PR branch) alongside
# check-settings-schema.sh, and invoked with the repository as the working
# directory so both `npm query` and the prefix match resolve against the tree.
set -euo pipefail

workspaces="$(npm query .workspace --json \
  | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{process.stdout.write(JSON.parse(s).map((w)=>w.location).join("\n"))})')"

while IFS= read -r f || [[ -n "${f}" ]]; do
  [[ -n "${f}" ]] || continue
  best=''
  while IFS= read -r w; do
    [[ -n "${w}" ]] || continue
    if [[ "${f}" == "${w}"/* && "${#w}" -gt "${#best}" ]]; then
      best="${w}"
    fi
  done <<< "${workspaces}"
  # `if`, not `[[ ]] && printf`: an unmatched file (best empty) must leave the
  # loop body's exit status 0, or under `set -o pipefail` a no-match on the LAST
  # line makes `while … | sort` fail and (with `set -e`) aborts the script.
  if [[ -n "${best}" ]]; then printf '%s\n' "${best}"; fi
done | sort -u
