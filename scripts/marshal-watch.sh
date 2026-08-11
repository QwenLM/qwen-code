#!/usr/bin/env bash
# Marshal 心跳 watchdog（operator-runbook §9.7）：周期性汇报所有活跃 Run，防"挂了毫无感知"。
# - 每 interval（默认 600s）轮询 .marshal/runs/*/state.json；
# - 终态/待审态直接标注；RUNNING 时以"进程存活"判定 active vs DEAD?（opencode 长 attempt 期间
#   很少发事件，不能用事件年龄判死，必须看进程）；
# - 输出 tee 到 /tmp/marshal-watch.log 并 osascript 通知。
# 用法: nohup scripts/marshal-watch.sh [interval_sec] &
cd "$(dirname "$0")/.." || exit 1
[ -d .marshal/runs ] || { echo "not a marshal repo" >&2; exit 1; }
INTERVAL="${1:-600}"; LOG="${MARSHAL_WATCH_LOG:-/tmp/marshal-watch.log}"
notify(){ osascript -e "display notification \"$1\" with title \"Marshal watch\"" 2>/dev/null; echo "# $(date '+%m-%d %H:%M') $1" >> ~/Desktop/marshal-progress.md; }
while true; do
  line="[$(date '+%m-%d %H:%M:%S')] "
  for d in .marshal/runs/*/; do
    rid=$(basename "$d"); [ -f "$d/state.json" ] || continue
    st=$(python3 -c "import json;print(json.load(open('$d/state.json'))['state'])" 2>/dev/null) || continue
    case "$st" in
      REVIEW_PENDING|RETRY_PENDING|ACCEPTED|REJECTED|BLOCKED) line+="$rid=$st ";;
      RUNNING)
        if pgrep -f "task run --run $rid" >/dev/null 2>&1 || pgrep -f "opencode.*$rid" >/dev/null 2>&1; then
          line+="$rid=RUNNING(active) "
        else
          line+="$rid=DEAD? "
        fi;;
      *) line+="$rid=$st ";;
    esac
  done
  echo "$line" | tee -a "$LOG"; notify "${line#*] }"
  sleep "$INTERVAL"
done
