#!/bin/bash
# Mutation matrix: one row per guard the PR introduces. For each mutant we
# apply a single interface-preserving edit to the PR's own source, run the
# suite that should catch it, then restore. A mutant that leaves the suite
# green is a survivor (coverage gap or dead code), not a pass.
set -uo pipefail
TREE="$1"
OUT="$2"
cd "$TREE" || exit 1

ARCHIVE=packages/cli/src/serve/server/session-archive.ts
RTSTORE=packages/cli/src/serve/workspace-runtime-storage.ts
STORAGE=packages/core/src/config/storage.ts

restore() { git checkout -- "$ARCHIVE" "$RTSTORE" "$STORAGE"; }
trap restore EXIT

run_cli() { (cd packages/cli && npx vitest run --reporter=basic "$@" 2>&1); }
run_core() { (cd packages/core && npx vitest run --reporter=basic "$@" 2>&1); }

result_line() { # name suite_output exit
  local name="$1" out="$2" code="$3"
  local failed
  failed=$(printf '%s' "$out" | grep -Eo 'Tests +[0-9]+ failed' | head -1)
  if [ "$code" -eq 0 ]; then
    echo "SURVIVED|$name|suite stayed green|${failed:-no failures}"
  else
    echo "KILLED|$name|suite went red|${failed:-nonzero exit}"
  fi
}

: > "$OUT"

# ---- M1: daemon maintenance no longer acquires a writer lease -------------
restore
python3 - "$ARCHIVE" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old="""    lease = await service.acquireSessionWriterLease(sessionId, {
      processKind: 'daemon',
      reclaimPolicy: 'never',
    });"""
new="""    lease = {
      assertOwnedAndUnchanged: async () => {},
      release: async () => {},
    } as unknown as Awaited<
      ReturnType<typeof service.acquireSessionWriterLease>
    >;"""
assert old in s, 'M1 anchor missing'
open(p,'w').write(s.replace(old,new,1))
PY
OUT1=$(run_cli src/serve/server/session-archive.test.ts); C1=$?
result_line "M1 no writer lease acquired for daemon maintenance" "$OUT1" "$C1" >> "$OUT"
printf '%s\n' "$OUT1" | grep -E "Tests |FAIL|×" | head -12 >> "$OUT"
echo "---" >> "$OUT"

# ---- M2: workspace storage context is not pinned to the selected runtime --
restore
python3 - "$RTSTORE" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old="""  return Storage.runWithResolvedRuntimeBaseDir(
    runtime.sessionRuntimeBaseDir,
    fn,
  );"""
new="""  return fn();"""
assert old in s, 'M2 anchor missing'
open(p,'w').write(s.replace(old,new,1))
PY
OUT2=$(run_cli src/serve/multi-workspace-sessions.test.ts src/serve/workspace-qualified-rest.test.ts); C2=$?
result_line "M2 maintenance not run inside the selected runtime storage context" "$OUT2" "$C2" >> "$OUT"
printf '%s\n' "$OUT2" | grep -E "Tests |FAIL|×" | head -12 >> "$OUT"
echo "---" >> "$OUT"

# ---- M3: the runtime root context is no longer pinned against env reload --
restore
python3 - "$STORAGE" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old="""      { dir: path.resolve(dir), pinned: true },"""
new="""      { dir: path.resolve(dir), pinned: false },"""
assert old in s, 'M3 anchor missing'
open(p,'w').write(s.replace(old,new,1))
PY
OUT3=$(run_core src/config/storage.test.ts); C3=$?
result_line "M3 pinned runtime root downgraded to a reload-overridable one" "$OUT3" "$C3" >> "$OUT"
printf '%s\n' "$OUT3" | grep -E "Tests |FAIL|×" | head -12 >> "$OUT"
echo "---" >> "$OUT"

# ---- M4: shutdown seals maintenance but does NOT wait for it --------------
restore
python3 - "$ARCHIVE" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old="""    this.maintenanceSealed = true;
    if (this.activeMaintenance === 0) {
      return Promise.resolve();
    }"""
new="""    this.maintenanceSealed = true;
    return Promise.resolve();
    if (this.activeMaintenance === 0) {
      return Promise.resolve();
    }"""
assert old in s, 'M4 anchor missing'
open(p,'w').write(s.replace(old,new,1))
PY
OUT4=$(run_cli src/serve/server/session-archive.test.ts); C4=$?
result_line "M4 shutdown seals but does not wait for admitted maintenance" "$OUT4" "$C4" >> "$OUT"
printf '%s\n' "$OUT4" | grep -E "Tests |FAIL|×" | head -12 >> "$OUT"
echo "---" >> "$OUT"

# ---- M5: draining never refuses newly admitted maintenance ----------------
restore
python3 - "$ARCHIVE" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old="""    if (this.maintenanceSealed) {
      throw new DaemonDrainingError();
    }
    const uniqueSessionIds = [...new Set(sessionIds)];"""
new="""    const uniqueSessionIds = [...new Set(sessionIds)];"""
assert old in s, 'M5 anchor missing'
open(p,'w').write(s.replace(old,new,1))
PY
OUT5=$(run_cli src/serve/server/session-archive.test.ts src/serve/server.test.ts); C5=$?
result_line "M5 draining daemon still admits new maintenance" "$OUT5" "$C5" >> "$OUT"
printf '%s\n' "$OUT5" | grep -E "Tests |FAIL|×" | head -12 >> "$OUT"
echo "---" >> "$OUT"

restore
# ---- control: unmutated tree must be green -------------------------------
OUT0=$(run_cli src/serve/server/session-archive.test.ts); C0=$?
result_line "CONTROL unmutated source" "$OUT0" "$C0" >> "$OUT"
printf '%s\n' "$OUT0" | grep -E "Tests " | head -3 >> "$OUT"

cat "$OUT"
