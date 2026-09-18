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
SCR=${SCR:-/tmp/batch-regression}
FAKE="${HERE}/fake-dashscope.mjs"

rm -rf "${SCR}"
mkdir -p "${SCR}/home" "${SCR}/home-oauth/.qwen" "${SCR}/work" "${SCR}/out"
printf '%s\n' \
  '{"messages":[{"role":"user","content":"Reply with OK."}],"enable_thinking":false}' \
  '{"custom_id":"second","body":{"messages":[{"role":"user","content":"again"}]}}' \
  > "${SCR}/work/in.jsonl"
echo '{"security":{"auth":{"selectedType":"qwen-oauth"}}}' \
  > "${SCR}/home-oauth/.qwen/settings.json"

PASS=0
FAIL=0

# Start one fake server: scenario, port.
start_server() {
  local scenario=$1 port=$2
  SCENARIO="${scenario}" PORT="${port}" LOG="${SCR}/${scenario}.log" \
    nohup node "${FAKE}" > "${SCR}/s-${scenario}.out" 2>&1 &
  sleep 1
}

stop_servers() {
  local port pid
  for port in 8899 8900 8901 8902 8903; do
    pid=$(ss -ltnp "sport = :${port}" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
    if [[ -n "${pid}" ]]; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
}
trap stop_servers EXIT

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

# Run the CLI, capture streams, echo the exit code.
run() {
  timeout 400 npm run dev --silent -- "$@" > "${SCR}/out/o.txt" 2> "${SCR}/out/e.txt"
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

cd "${ROOT}" || exit 1
# R1 asserts "exactly one batch", which only means anything with the relaunch
# enabled. An outer qwen shell exports QWEN_CODE_NO_RELAUNCH to its children,
# and with the relaunch off the unfixed code also creates exactly one batch.
unset QWEN_CODE_NO_RELAUNCH
export HOME="${SCR}/home"
export OPENAI_API_KEY=sk-fake
export OPENAI_MODEL=qwen-plus

echo "--- R1 submit (default env, relaunch enabled)"
export OPENAI_BASE_URL=http://127.0.0.1:8899/v1
rc=$(run batch submit "${SCR}/work/in.jsonl")
check "R1 exit code 0" 0 "${rc}"
check "R1 exactly one batch created" 1 "$(count batch_created "${SCR}/happy.log" || true)"
check "R1 one id on stdout" 1 "$(wc -l < "${SCR}/out/o.txt" || true)"
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
rc=$(run batch cancel "${ID}")
check "R2 cancel exit 0" 0 "${rc}"

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
check "R8 the subagent turn stayed realtime" 1 "$(count realtime_chat "${SCR}/happy.log" || true)"

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

timeout 400 npm run dev --silent -- -p "say hi" --batch \
  > "${SCR}/out/o7.txt" 2> "${SCR}/out/e7.txt" &
NPM_PID=$!
sleep 45
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
contains "R7 SIGINT cancels server-side" '"event":"batch_cancelled"' "${SCR}/stuck.log"

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
