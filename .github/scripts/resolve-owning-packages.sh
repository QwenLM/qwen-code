#!/usr/bin/env bash
# Owning-workspace resolver, shared by the qwen-autofix verify steps
# (.github/workflows/qwen-autofix.yml) so the two gates cannot drift apart.
#
# Reads changed file paths on stdin (one per line, e.g. the output of
# `git diff --name-only`) and emits, sorted and unique on stdout, the OWNING
# npm workspace of each: the workspace whose location is the LONGEST matching
# path prefix of the file.
#
# The workspace set is expanded from the ON-DISK root package.json `workspaces`
# globs, NOT from `npm query`/node_modules: node_modules reflects the BASE
# checkout the gate installed, so a workspace the PR branch ADDS (a new channel
# adapter, a new sdk — the issue-fix job's whole purpose) would be invisible and
# its tests silently skipped. It is also NOT "any ancestor dir with a
# package.json": a fixture/example package inside a workspace's src tree (e.g.
# packages/cli/src/commands/extensions/examples/starter) has a package.json but
# is not a workspace, so resolving a change there to the fixture would skip
# packages/cli's own tests. Expanding the globs (shallow `dir/*` + literals,
# honouring `!` negations, keeping dirs that contain a package.json) matches
# what `npm run --workspace` accepts downstream and reflects the branch.
#
# Invoked with the repository as the working directory. Staged to RUNNER_TEMP
# from the trusted base checkout (never the PR branch) alongside
# check-settings-schema.sh.
set -euo pipefail

workspaces="$(node -e '
  const fs = require("fs");
  const path = require("path");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  let globs = pkg.workspaces || [];
  if (!Array.isArray(globs)) globs = globs.packages || [];
  const positive = [];
  const negative = [];
  for (const g of globs) (g[0] === "!" ? negative : positive).push(g.replace(/^!/, ""));
  const hasManifest = (d) => {
    try { return fs.statSync(path.join(d, "package.json")).isFile(); }
    catch { return false; }
  };
  const expand = (g) => {
    const star = g.indexOf("*");
    if (star === -1) return [g];
    const parent = g.slice(0, star).replace(/\/$/, "");
    let entries = [];
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); }
    catch { return []; }
    return entries.filter((e) => e.isDirectory()).map((e) => path.posix.join(parent, e.name));
  };
  const dirs = new Set();
  for (const g of positive) for (const d of expand(g)) if (hasManifest(d)) dirs.add(d);
  for (const g of negative) { for (const d of expand(g)) dirs.delete(d); dirs.delete(g); }
  process.stdout.write([...dirs].sort().join("\n"));
')"

if [[ -z "${workspaces}" ]]; then
  echo "resolve-owning-packages: no workspaces resolved from package.json" >&2
  exit 1
fi

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
