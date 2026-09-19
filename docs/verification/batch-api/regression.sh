#!/usr/bin/env bash
# End-to-end regression for `qwen batch` and `--batch` against the fake
# DashScope server in this directory. No network, no API key, no cost.
#
#   bash docs/verification/batch-api/regression.sh
#
# It drives the real CLI (`npm run dev`) through five scenarios and asserts on
# exit codes, stdout, and the request log the fake server records. What it
# proves is process behaviour; the provider's own protocol still needs the
# 00/01/02 probes in this directory.
set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "${HERE}/../../.." && pwd)
SCR=${SCR:-}
if [[ -z "${SCR}" ]]; then
  # Fresh unguessable scratch root: a fixed /tmp path fails (or worse, half
  # passes vacuously) when another user owns it on a shared host.
  SCR=$(mktemp -d "${TMPDIR:-/tmp}/batch-regression.XXXXXX")
else
  rm -rf "${SCR}"
fi
FAKE="${HERE}/fake-dashscope.mjs"

mkdir -p "${SCR}/home" "${SCR}/home-oauth/.qwen" "${SCR}/work" "${SCR}/out" "${SCR}/cwd"
if [[ ! -d "${SCR}/work" ]]; then
  echo "scratch setup failed: ${SCR}" >&2
  exit 1
fi
printf '%s\n' \
  '{"messages":[{"role":"user","content":"Reply with OK."}],"enable_thinking":false}' \
  '{"custom_id":"second","body":{"messages":[{"role":"user","content":"again"}]}}' \
  > "${SCR}/work/in.jsonl"
echo '{"security":{"auth":{"selectedType":"qwen-oauth"}}}' \
  > "${SCR}/home-oauth/.qwen/settings.json"

PASS=0
FAIL=0

# Keep the servers' PIDs and kill exactly those: port-scraping with `ss` is
# absent on slim/macOS hosts and can reap a foreign process.
SERVER_PIDS=()

# Start one fake server: scenario, port.
start_server() {
  local scenario=$1 port=$2
  SCENARIO="${scenario}" PORT="${port}" LOG="${SCR}/${scenario}.log" \
    nohup node "${FAKE}" > "${SCR}/s-${scenario}.out" 2>&1 &
  SERVER_PIDS+=("$!")
  sleep 1
}

stop_servers() {
  local pid
  for pid in "${SERVER_PIDS[@]:-}"; do
    if [[ -n "${pid}" ]]; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
}
trap stop_servers EXIT HUP

check() { # name, expected, actual
  if [[ "$2" == "$3" ]]; then
    echo "PASS  $1"
    PASS=$((PASS + 1))
  else
    echo "FAIL  $1 (expected '$2', got '$3')"
    FAIL=$((FAIL + 1))
  fi
}

contains() { # name, needle, file
  if grep -qF "$2" "$3"; then
    echo "PASS  $1"
    PASS=$((PASS + 1))
  else
    echo "FAIL  $1 (missing '$2')"
    FAIL=$((FAIL + 1))
  fi
}

absent() { # name, needle, file
  if grep -qF "$2" "$3"; then
    echo "FAIL  $1 (unexpected '$2')"
    FAIL=$((FAIL + 1))
  else
    echo "PASS  $1"
    PASS=$((PASS + 1))
  fi
}

# coreutils timeout is not everywhere (stock macOS, slim containers); use
# gtimeout when that is what the host has, and run unbounded otherwise.
TIMEOUT=$(command -v timeout || command -v gtimeout || true)

# Run the CLI, capture streams, echo the exit code. Runs from an empty
# scratch cwd so a repo-local .qwen/settings.json or .env cannot leak into
# the run (the header's "no network, no key, no cost" promise depends on it).
run() {
  # dev.js spawns the CLI with its own process.cwd(), so invoking it from
  # the scratch cwd keeps the repo-local config out of the run (npm would
  # reset cwd to the package prefix).
  if [[ -n "${TIMEOUT}" ]]; then
    (cd "${SCR}/cwd" && "${TIMEOUT}" 400 node "${ROOT}/scripts/dev.js" "$@") \
      > "${SCR}/out/o.txt" 2> "${SCR}/out/e.txt"
  else
    (cd "${SCR}/cwd" && node "${ROOT}/scripts/dev.js" "$@") \
      > "${SCR}/out/o.txt" 2> "${SCR}/out/e.txt"
  fi
  echo $?
}

count() { # pattern, file — occurrences, 0 when the file is absent
  grep -c "$1" "$2" 2>/dev/null || true
}

start_server happy 8899
start_server tools 8900
start_server failed 8901
start_server stuck 8902
start_server unpollable 8903

# R1 asserts "exactly one batch", which only means anything with the relaunch
# enabled. An outer qwen shell exports QWEN_CODE_NO_RELAUNCH to its children,
# and with the relaunch off the unfixed code also creates exactly one batch.
unset QWEN_CODE_NO_RELAUNCH
# Inherited provider credentials must never be consulted here (ci.yml blanks
# them for the no-AK gate for the same reason).
unset DASHSCOPE_API_KEY DASHSCOPE_BASE_URL
export HOME="${SCR}/home"
export OPENAI_API_KEY=sk-fake
export OPENAI_MODEL=qwen-plus

echo "--- R1 submit (default env, relaunch enabled)"
export OPENAI_BASE_URL=http://127.0.0.1:8899/v1
rc=$(run batch submit "${SCR}/work/in.jsonl")
check "R1 exit code 0" 0 "${rc}"
check "R1 exactly one batch created" 1 "$(count batch_created "${SCR}/happy.log" || true)"
check "R1 one id on stdout" 1 "$(wc -l < "${SCR}/out/o.txt" | tr -d '[:space:]')"
contains "R1 id looks like a batch id" "batch_fake_" "${SCR}/out/o.txt"
absent "R1 no fall-through to main flow" "No input provided via stdin" "${SCR}/out/e.txt"
ID=$(head -1 "${SCR}/out/o.txt" || true)

echo "--- R2 status / fetch / cancel"
rc=$(run batch status "${ID}")
check "R2 status exit 0" 0 "${rc}"
contains "R2 status line" "completed" "${SCR}/out/o.txt"
rc=$(run batch fetch "${ID}" --out "${SCR}/out" --delete)
check "R2 fetch exit 0" 0 "${rc}"
if [[ -f "${SCR}/out/${ID}.output.jsonl" ]]; then
  echo "PASS  R2 output file written"
  PASS=$((PASS + 1))
else
  echo "FAIL  R2 output file written"
  FAIL=$((FAIL + 1))
fi
check "R2 remote files deleted (input+output)" 2 "$(count file_deleted "${SCR}/happy.log" || true)"
# Cancelling the now-completed job must fail, like the real provider.
rc=$(run batch cancel "${ID}")
check "R2 cancel of a settled batch is refused" 1 "${rc}"
contains "R2 refusal carries the provider reason" "already completed" "${SCR}/out/e.txt"
# A cancel against a running job succeeds (stuck never settles on its own).
export OPENAI_BASE_URL=http://127.0.0.1:8902/v1
rc=$(run batch submit "${SCR}/work/in.jsonl")
RID=$(head -1 "${SCR}/out/o.txt" || true)
rc=$(run batch cancel "${RID}")
check "R2 cancel a running batch exit 0" 0 "${rc}"
contains "R2 cancelled status" "cancelled" "${SCR}/out/o.txt"
export OPENAI_BASE_URL=http://127.0.0.1:8899/v1

echo "--- R3 auth gate under qwen-oauth"
rc=$(HOME="${SCR}/home-oauth" run batch status "${ID}")
check "R3 exit 1" 1 "${rc}"
contains "R3 auth message" "needs an API key" "${SCR}/out/e.txt"
absent "R3 no fall-through" "No input provided via stdin" "${SCR}/out/e.txt"

echo "--- R4 --batch with -i"
rc=$(run --batch -i hello)
check "R4 rejected" 1 "${rc}"
contains "R4 message" "only available in non-interactive runs" "${SCR}/out/e.txt"

echo "--- R5 --batch end to end (tools)"
export OPENAI_BASE_URL=http://127.0.0.1:8900/v1
rc=$(run -p "list the files here and summarize" --batch --approval-mode yolo)
check "R5 exit 0" 0 "${rc}"
contains "R5 model output" "BATCH_OK" "${SCR}/out/o.txt"
check "R5 one batch per hop (2 hops)" 2 "$(count batch_created "${SCR}/tools.log" || true)"
check "R5 all files cleaned up" 4 "$(count file_deleted "${SCR}/tools.log" || true)"

echo "--- R8 only the main loop's turn goes to batch"
# The memory-extraction subagent runs on a derived config; if it inherited
# --batch, one `-p` run would submit (and wait on) a second 24h job.
export OPENAI_BASE_URL=http://127.0.0.1:8899/v1
rc=$(run -p "say hi" --batch)
check "R8 exit 0" 0 "${rc}"
check "R8 one batch job for one user turn" 1 \
  "$(($(count batch_created "${SCR}/happy.log" || true) - 1))"
REALTIME_COUNT=$(count realtime_chat "${SCR}/happy.log" || true)
if [[ "${REALTIME_COUNT}" -ge 1 ]]; then
  echo "PASS  R8 the side calls stayed realtime"
  PASS=$((PASS + 1))
else
  echo "FAIL  R8 the side calls stayed realtime (expected >= 1, got '${REALTIME_COUNT}')"
  FAIL=$((FAIL + 1))
fi

echo "--- R6 failed batch surfaces the provider reason"
export OPENAI_BASE_URL=http://127.0.0.1:8901/v1
rc=$(run -p "say hi" --batch)
check "R6 exit 1" 1 "${rc}"
contains "R6 reason from error file" "model unavailable in batch" "${SCR}/out/e.txt"
check "R6 no retry storm" 1 "$(count batch_created "${SCR}/failed.log" || true)"

echo "--- R7 fetch before settle + SIGINT cancels"
export OPENAI_BASE_URL=http://127.0.0.1:8902/v1
rc=$(run batch submit "${SCR}/work/in.jsonl" --window 7d)
check "R7 submit exit 0" 0 "${rc}"
SID=$(head -1 "${SCR}/out/o.txt" || true)
rc=$(run batch fetch "${SID}")
check "R7 fetch refused" 1 "${rc}"
contains "R7 refusal message" "results are only available once the batch settles" "${SCR}/out/e.txt"

if [[ -n "${TIMEOUT}" ]]; then
  (cd "${SCR}/cwd" && "${TIMEOUT}" 400 node "${ROOT}/scripts/dev.js" -p "say hi" --batch) \
    > "${SCR}/out/o7.txt" 2> "${SCR}/out/e7.txt" &
else
  (cd "${SCR}/cwd" && node "${ROOT}/scripts/dev.js" -p "say hi" --batch) \
    > "${SCR}/out/o7.txt" 2> "${SCR}/out/e7.txt" &
fi
NPM_PID=$!
# Wait for the observable "job submitted" event, not a fixed sleep: a cold
# `npm run dev` start has no upper bound, and SIGINT before the create lands
# fails the assertion on a clean tree. Count past the baseline: the R2 cancel
# above already created (and cancelled) a batch on this server.
CREATED_BEFORE=$(count batch_created "${SCR}/stuck.log" || true)
CANCEL_BEFORE=$(count batch_cancelled "${SCR}/stuck.log" || true)
for _ in $(seq 1 150); do
  if [[ "$(count batch_created "${SCR}/stuck.log" || true)" -gt "${CREATED_BEFORE}" ]]; then
    break
  fi
  if ! kill -0 "${NPM_PID}" 2>/dev/null; then break; fi
  sleep 1
done
descendants() {
  local child
  for child in $(pgrep -P "$1" || true); do
    echo "${child}"
    descendants "${child}"
  done
}
for p in "${NPM_PID}" $(descendants "${NPM_PID}" || true); do
  kill -INT "${p}" 2>/dev/null || true
done
sleep 10
check "R7 SIGINT cancels server-side" "$((CANCEL_BEFORE + 1))" \
  "$(count batch_cancelled "${SCR}/stuck.log" || true)"

echo "--- R9 a batch whose status cannot be polled is left recoverable"
# The outer retryWithBackoff retries transport errors, and a retry of
# runBatchCompletion uploads and creates a SECOND job while the first keeps
# running and billing. The give-up error must not be retryable, and the
# abandoned job's input file must survive for `qwen batch fetch`.
export OPENAI_BASE_URL=http://127.0.0.1:8903/v1
rc=$(run -p "say hi" --batch)
check "R9 exit 1" 1 "${rc}"
check "R9 exactly one job created, not a second one" 1 \
  "$(count batch_created "${SCR}/unpollable.log" || true)"
check "R9 the input file is kept" 0 "$(count file_deleted "${SCR}/unpollable.log" || true)"
contains "R9 tells the user how to recover" "qwen batch fetch" "${SCR}/out/e.txt"

echo
echo "=== ${PASS} passed, ${FAIL} failed ==="
[[ "${FAIL}" -eq 0 ]]
