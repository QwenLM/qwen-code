#!/usr/bin/env bash
# Stop this job's own leftover daemons before its run-unique HOME is removed.
#
# The isolated-HOME lanes end with `rm -rf` on a directory the suite just used.
# A daemon the suite started can outlive the vitest run and keep writing into
# that home, and `rm -rf` then loses the race: it unlinks a directory's entries,
# the daemon recreates one, and rmdir fails with ENOTEMPTY. Measured on job
# 130495062334 (2026-11-11): `Test Files 29 passed (29)` / `Tests 223 passed
# (223)` at 11:43:29, then 34 seconds later
#   rm: cannot remove '.../qwen-no-ak-home-43011096774-1': Directory not empty
#   ##[error]Process completed with exit code 1.
# Every test passed and the job was red anyway, on a required check.
#
# Usage: reap-isolated-home.sh HOME_PATH
#
# It also performs the removal, so the lane's cleanup step stays one line and
# the workflow does not grow: reap, then `rm -rf`. Callers keep the step's
# `always()` and the constructed run-unique path; the ordering lives here.
#
# Selection is by the RUN-UNIQUE home path (it carries the run id and attempt),
# never by process name: this pool runs many jobs per host, and a name-based
# `pkill node` would kill the neighbours. A process is this job's when its
# command line, its working directory, or one of its home-bearing environment
# variables names that exact path. The environment arm is the one that matters
# — a detached daemon's command line is typically just `node .../cli.js serve`,
# and it is HOME/QWEN_HOME that tie it to this run.
#
# The cleanup step's own shell has HOME set to this path AND receives it as an
# argument, so it matches its own selection; so does every helper this script
# spawns. They are excluded by walking this script's ancestor chain (which
# covers the shell and the runner worker above it) and by a MARKER this script
# is invoked with, which its own helpers inherit at exec. The marker is what
# covers the helpers: excluding by parent would also exclude every detached
# daemon, because those are reparented to pid 1 and pid 1 is on the chain.
#
# The chain is read from the REAL /proc, never from the scan root: those are
# different questions, and a chain that cannot be established means the script
# cannot tell which pid is its own parent — so it reaps NOTHING rather than risk
# signalling it. A leaked home is recoverable; a killed runner worker is not.
#
# REAP_DRY_RUN=1 prints the selection and signals nothing. That is how the
# selection is tested off Linux, and it is the only safe way to test it at all:
# a fabricated process list carries pids that are real on the test machine.
#
# Nothing here may fail the job. A home that cannot be reaped is reported and
# the removal is attempted anyway, which is exactly today's behaviour.
set -u

HOME_PATH="${1:-}"
PROC_ROOT="${REAP_PROC_ROOT:-/proc}"
TERM_WAIT_TRIES="${REAP_TERM_WAIT_TRIES:-20}"
DRY_RUN="${REAP_DRY_RUN:-}"
# Unique per invocation, not the pid: a daemon whose pid was reused from an
# earlier reaper run would otherwise carry a matching marker and be skipped.
SELF_MARKER="${REAP_SELF_MARKER:-$$-$(date +%s%N 2>/dev/null)-${RANDOM}${RANDOM}}"
# Exported, not just set: `carries_marker` reads the marker out of
# `/proc/<pid>/environ`, so only a variable in the child's ENVIRONMENT can
# exclude the helpers this script spawns (`cat`, `tr`, `grep`, and the daemons a
# lane leaves behind). Unexported, the marker was invisible to that scan in
# production — the workflows never pass `REAP_SELF_MARKER` — and self-exclusion
# rested only on the helper's short lifetime relative to the glob expanding
# before the loop. Exporting makes the protection independent of that timing.
export REAP_SELF_MARKER="$SELF_MARKER"

# The removal happens even when the reap is skipped or declines: the reap is an
# improvement on the removal, never a precondition for it.
#
# A failed removal is reported, not returned: this runs as the cleanup step's
# last command, so its status would become the step's status and redden a job
# whose tests all passed — the very failure this script exists to remove. The
# caller keeps `|| true` for the same reason on its own fallback path.
remove_home() {
  if [ -n "$DRY_RUN" ]; then
    echo "reap-isolated-home: dry run; removing nothing"
    return 0
  fi
  if ! rm -rf -- "$HOME_PATH"; then
    echo "::warning::reap-isolated-home: could not remove ${HOME_PATH}"
  fi
}

if [ -z "$HOME_PATH" ]; then
  echo '::warning::reap-isolated-home: no home path given; nothing reaped'
  exit 0
fi

# Refuse anything that is not a constructed absolute directory path. Both the
# signals and the removal below escalate to whatever the step user may do, so a
# relative path, a bare '/' or an empty expansion must not reach either.
case "$HOME_PATH" in
  /*/?*) : ;;
  *)
    echo "::warning::reap-isolated-home: refusing non-absolute or root-like path: ${HOME_PATH}"
    exit 0
    ;;
esac

if [ ! -d "$PROC_ROOT" ]; then
  # No procfs (macOS, or a container without it): nothing to select from, so
  # degrade to the plain removal instead of guessing from `ps` output.
  echo "reap-isolated-home: no ${PROC_ROOT}; removing without a reap"
  remove_home
  exit 0
fi

if ! [[ "$TERM_WAIT_TRIES" =~ ^[0-9]{1,4}$ ]]; then
  echo '::warning::reap-isolated-home: REAP_TERM_WAIT_TRIES must be a non-negative integer; using 20'
  TERM_WAIT_TRIES=20
fi

# The fields after comm, by position: state is $1 and ppid is $2. comm is
# parenthesised and can itself contain spaces AND a ')', so strip through the
# LAST ')' rather than counting whitespace-delimited fields.
proc_fields() {
  local line
  line=$(cat "${PROC_ROOT}/$1/stat" 2>/dev/null) || return 1
  printf '%s' "${line##*) }"
}

# Same, from the real /proc regardless of the scan root: the ancestor chain is
# about this script's own process tree, which the scan root knows nothing about.
real_proc_fields() {
  local line
  line=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  printf '%s' "${line##*) }"
}

# Ancestors of this script, INCLUDING ITSELF, from the real /proc. See the
# header: an unestablished chain forbids signalling.
ancestors=" "
walk=$$
chain_ok=0
while [ -n "$walk" ] && [ "$walk" != 0 ]; do
  case "$ancestors" in *" $walk "*) break ;; esac
  fields=$(real_proc_fields "$walk") || break
  ancestors="${ancestors}${walk} "
  chain_ok=1
  walk=$(printf '%s' "$fields" | awk '{print $2}')
  case "$walk" in '' | *[!0-9]*) break ;; esac
done

# This script's own helpers (`cat`, `tr`, `grep`) receive the home path as an
# argument, so they match the selection below. They are excluded by the MARKER
# this script is invoked with, which they inherit at exec.
#
# Excluding them by PARENT does not work: pid 1 is on the ancestor chain, and a
# detached daemon is reparented to pid 1 — the very shape this reaper exists to
# stop. Measured on hz3: a parent-based exclusion matched every ppid=1 process
# and the reaper selected nothing at all. The ancestor chain still excludes the
# cleanup shell and the runner worker (and pid 1 itself), which is a different
# question from "is this my helper".
carries_marker() {
  [ -n "$SELF_MARKER" ] || return 1
  # `cat` is deliberate: `< file` makes the REDIRECTION fail noisily when the
  # process exits mid-scan, which is exactly what this loop must tolerate.
  # shellcheck disable=SC2002
  cat "${PROC_ROOT}/$1/environ" 2>/dev/null | tr '\0' '\n' |
    grep -qxF -- "REAP_SELF_MARKER=${SELF_MARKER}"
}

# The home-bearing variables the lanes publish. Only these keys are read, and
# only when their VALUE is the home or a path inside it, so a process that
# merely mentions the path in some other variable (PATH, a log prefix) is not
# this run's daemon.
HOME_KEYS='HOME USERPROFILE QWEN_HOME COREPACK_HOME NPM_CONFIG_CACHE XDG_CACHE_HOME'

# A process can exit between the directory listing and this read. The
# REDIRECTION itself then fails, and `2>/dev/null` on the command does not
# suppress that — bash reports it before the command runs (measured on hz3:
# `/proc/95/environ: No such process` lines in the job log). Reading through
# `cat` makes the failure an ordinary, quiet one.
proc_read() {
  # See carries_marker: `< file` would report a vanished process.
  # shellcheck disable=SC2002
  cat "${PROC_ROOT}/$1/$2" 2>/dev/null
}

references_home() {
  local pid="$1"
  local entry key value want

  # An argv entry counts only when it is the home itself or a path INSIDE it.
  # A substring match is not enough: `<home>-extra` belongs to a different run,
  # and on this pool that is a neighbour job (measured on hz3: a substring
  # match selected `<home>-extra/daemon.js`). A `--flag=<path>` entry is compared
  # by its value after the first '=', which is what the CLI actually receives.
  while IFS= read -r -d '' entry; do
    case "$entry" in
      "$HOME_PATH" | "$HOME_PATH"/*) return 0 ;;
      *=/*)
        value=${entry#*=}
        case "$value" in "$HOME_PATH" | "$HOME_PATH"/*) return 0 ;; esac
        ;;
    esac
  done < <(proc_read "$pid" cmdline)

  # A daemon started inside the home keeps its cwd there even after the
  # directory is unlinked, which readlink reports with a ' (deleted)' suffix.
  # That suffix is kernel-appended, not part of the path, so strip it before
  # comparing — and only it, so a neighbour whose home is `<this>-extra` stays
  # out of the set.
  entry=$(readlink "${PROC_ROOT}/${pid}/cwd" 2>/dev/null) || entry=''
  entry=${entry% (deleted)}
  case "$entry" in "$HOME_PATH" | "$HOME_PATH"/*) return 0 ;; esac

  while IFS= read -r -d '' entry; do
    key=${entry%%=*}
    value=${entry#*=}
    for want in $HOME_KEYS; do
      [ "$key" = "$want" ] || continue
      case "$value" in "$HOME_PATH" | "$HOME_PATH"/*) return 0 ;; esac
    done
  done < <(proc_read "$pid" environ)

  return 1
}

selected=''
for proc_dir in "${PROC_ROOT}"/[0-9]*; do
  pid=${proc_dir##*/}
  case "$pid" in '' | *[!0-9]*) continue ;; esac
  case "$ancestors" in *" $pid "*) continue ;; esac
  # Unreadable entries belong to another user; nothing unprivileged can signal
  # them either, so they are skipped rather than reported.
  [ -r "${proc_dir}/stat" ] || continue
  carries_marker "$pid" && continue
  if references_home "$pid"; then
    selected="${selected}${pid} "
    echo "REAP pid[${pid}] home[${HOME_PATH}] runner[${RUNNER_NAME:-local}] run[${GITHUB_RUN_ID:-local}/${GITHUB_RUN_ATTEMPT:-1}]"
  fi
done

if [ -z "$selected" ]; then
  echo "reap-isolated-home: no process references ${HOME_PATH}"
  remove_home
  exit 0
fi

if [ -n "$DRY_RUN" ]; then
  echo "reap-isolated-home: dry run; signalling nothing"
  remove_home
  exit 0
fi

if [ "$chain_ok" = 0 ]; then
  echo "::warning::reap-isolated-home: cannot establish own process chain; nothing reaped"
  remove_home
  exit 0
fi

# TERM first so a daemon can flush and exit on its own; KILL only what is still
# alive afterwards. Both legs tolerate a process that exits between the scan
# and the signal.
#
# A zombie is NOT alive for this purpose: it holds no descriptor and no cwd, so
# it cannot recreate an entry, and `kill -0` still succeeds on it. Counting one
# would burn both wait windows and end in a false warning while the removal was
# already safe.
alive() {
  local pid live='' fields state
  for pid in $selected; do
    fields=$(proc_fields "$pid") || continue
    state=$(printf '%s' "$fields" | awk '{print $1}')
    [ "$state" = 'Z' ] && continue
    if kill -0 "$pid" 2>/dev/null; then
      live="${live}${pid} "
    fi
  done
  selected="$live"
  [ -n "$selected" ]
}

for pid in $selected; do kill -TERM "$pid" 2>/dev/null || true; done

tries=0
while alive && [ "$tries" -lt "$TERM_WAIT_TRIES" ]; do
  sleep 0.5
  tries=$((tries + 1))
done

if alive; then
  echo "reap-isolated-home: escalating to KILL for${selected}"
  for pid in $selected; do kill -KILL "$pid" 2>/dev/null || true; done
  tries=0
  while alive && [ "$tries" -lt "$TERM_WAIT_TRIES" ]; do
    sleep 0.5
    tries=$((tries + 1))
  done
fi

if alive; then
  echo "::warning::reap-isolated-home: still alive after KILL:${selected} removal may fail"
else
  echo 'reap-isolated-home: all references stopped'
fi

remove_home
exit 0
