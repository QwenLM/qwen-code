#!/usr/bin/env bash
# .fork/verify.sh — 验证 fork 定制改动是否仍存在于当前 HEAD。
#
# 工作原理：
#   1. 默认遍历 first-parent 落地 commit（PR 合入 main 的 commit），
#      把每个 commit 按 subject 分类为 fork / sync / release。
#   2. 仅对 fork 类 commit 取其相对 first-parent 的 diff，提取加入的"签名行"
#      （足够长的非空白行）。
#   3. 检查这些签名行是否仍能在当前 HEAD 工作树对应文件中找到。
#   4. 按匹配率分类输出 PASS / WARN / FAIL；release / sync / 没有签名行的跳过。
#
# 退出码：
#   0  无 FAIL（可能存在 WARN）
#   1  存在 FAIL（疑似 fork patch 丢失）
#   2  环境错误
#
# 可调环境变量：
#   UPSTREAM_REF     上游 ref，默认 upstream/main
#   HEAD_REF         本端 ref，默认 HEAD
#   PASS_THRESHOLD   PASS 最低匹配率 (0-100)，默认 80
#   WARN_THRESHOLD   WARN 最低匹配率 (0-100)，默认 50；低于此视为 FAIL
#   MIN_LINE_LENGTH  忽略短于此长度（trim 后字符数）的签名行，默认 12
#   VERBOSE          为 1 时打印 PASS/SKIP 明细
#   MODE             landing(默认) / all
#                    landing: 只看 first-parent 落地 commit（PR-level）
#                    all:     看所有非 merge 的 fork commit（更细粒度，噪音更大）
#   JSON_OUTPUT      设为文件路径时输出结构化 JSON（供 AI agent 程序化消费）

set -uo pipefail

UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"
HEAD_REF="${HEAD_REF:-HEAD}"
PASS_THRESHOLD="${PASS_THRESHOLD:-80}"
WARN_THRESHOLD="${WARN_THRESHOLD:-50}"
MIN_LINE_LENGTH="${MIN_LINE_LENGTH:-12}"
VERBOSE="${VERBOSE:-0}"
MODE="${MODE:-landing}"
JSON_OUTPUT="${JSON_OUTPUT:-}"

# subject 分类。返回 fork / sync / release。
# - sync: 同步上游、对齐上游的 commit
# - release: 版本号 bump、发版相关
# - fork: 真正的 fork 业务/修复改动（包括"恢复"丢失的 fork 代码）
#
# 规则收紧原则：宁可多检查（false positive），不漏检查（false negative）。
# 所有 pattern 使用前缀匹配，避免子串匹配误杀。
# "fix: align with upstream" 归为 sync 而非 fork，因为这类 commit 只是将代码对齐到上游，
# 不包含 fork 定制。其他未匹配的 fix/feat commit 归为 fork 并接受验证。
# 如需修改此处规则，必须同步更新 .aoneci/upstream-sync-merge.yml 中的 awk 版本。
classify_subject() {
  local subj="$1"
  case "$subj" in
    "Merge commit '"*) echo "sync"; return ;;
    "Merge branch sync/"*) echo "sync"; return ;;
    "chore: sync upstream"*) echo "sync"; return ;;
    "fix(sync): resolve-upstream"*|"chore(sync): resolve-upstream"*) echo "sync"; return ;;
    "fix: align with upstream"*) echo "sync"; return ;;
    "chore(release)"*) echo "release"; return ;;
    "chore: release"*) echo "release"; return ;;
    "chore: bump version"*) echo "release"; return ;;
    "chore: rebase"*) echo "release"; return ;;
    "build: bump version"*) echo "release"; return ;;
    "ci(release)"*) echo "release"; return ;;
    "ci: publish"*) echo "release"; return ;;
  esac
  echo "fork"
}

if ! git rev-parse --verify --quiet "${UPSTREAM_REF}^{commit}" >/dev/null; then
  echo "❌ upstream ref 不可用: $UPSTREAM_REF" >&2
  echo "   请先 fetch upstream，例如：" >&2
  echo "     git remote add upstream https://github.com/QwenLM/qwen-code.git" >&2
  echo "     git fetch upstream main" >&2
  exit 2
fi
if ! git rev-parse --verify --quiet "${HEAD_REF}^{commit}" >/dev/null; then
  echo "❌ HEAD ref 不可用: $HEAD_REF" >&2
  exit 2
fi
case "$MODE" in
  landing|all) ;;
  *) echo "❌ MODE 必须为 landing 或 all（当前: $MODE）" >&2; exit 2 ;;
esac

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TOTAL=0
WARN_LINES=()
FAIL_LINES=()
JSON_ENTRIES=""

if [ "$MODE" = "all" ]; then
  log_args=(--no-merges)
else
  log_args=(--first-parent)
fi

while IFS= read -r commit; do
  TOTAL=$((TOTAL + 1))
  short=$(git rev-parse --short "$commit")
  subject=$(git log -1 --format='%s' "$commit")
  category=$(classify_subject "$subject")

  if [ "$category" != "fork" ]; then
    SKIP_COUNT=$((SKIP_COUNT + 1))
    [ "$VERBOSE" = "1" ] && printf 'SKIP[%s]  %s  %s\n' "$category" "$short" "$subject"
    continue
  fi

  # 检查 commit 是否有可读 parent（fork 第一个 commit 可能是 root）
  if ! git rev-parse --verify --quiet "${commit}^{commit}" >/dev/null; then
    SKIP_COUNT=$((SKIP_COUNT + 1))
    [ "$VERBOSE" = "1" ] && printf 'SKIP[noparent]  %s  %s\n' "$short" "$subject"
    continue
  fi

  diff_file="$WORK/diff"
  : >"$diff_file"
  # first-parent diff: 对 squash merge 或真 merge commit 均取合入 main 的净增内容。
  # --no-renames 避免重命名导致 diff 行被误识别为删除+新增。
  git diff --no-color --no-renames "${commit}^" "$commit" >"$diff_file" 2>/dev/null || true

  total=0
  matched=0
  current_file=""

  while IFS= read -r line; do
    case "$line" in
      "+++ /dev/null")
        current_file=""
        ;;
      "+++ b/"*)
        current_file="${line#+++ b/}"
        case "$current_file" in
          *package-lock.json|*pnpm-lock.yaml|*yarn.lock|*.lock|\
          *.snap|*.snap.txt|*/dist/*|*/build/*|.last-synced-upstream-tag)
            current_file=""
            ;;
        esac
        ;;
      "+++ "*)
        ;;
      "+"*)
        [ -z "$current_file" ] && continue
        content="${line#+}"
        content_trimmed="$(printf '%s' "$content" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        if [ "${#content_trimmed}" -lt "$MIN_LINE_LENGTH" ]; then
          continue
        fi
        total=$((total + 1))
        if [ -f "$current_file" ] && grep -qF -- "$content_trimmed" "$current_file" 2>/dev/null; then
          matched=$((matched + 1))
        fi
        ;;
    esac
  done <"$diff_file"

  if [ "$total" -eq 0 ]; then
    SKIP_COUNT=$((SKIP_COUNT + 1))
    [ "$VERBOSE" = "1" ] && printf 'SKIP[empty]  %s  %s\n' "$short" "$subject"
    continue
  fi

  rate=$((matched * 100 / total))
  verdict=""
  if [ "$rate" -ge "$PASS_THRESHOLD" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    verdict="pass"
    [ "$VERBOSE" = "1" ] && printf 'PASS  %s  %s  (%d/%d, %d%%)\n' "$short" "$subject" "$matched" "$total" "$rate"
  elif [ "$rate" -ge "$WARN_THRESHOLD" ]; then
    WARN_COUNT=$((WARN_COUNT + 1))
    verdict="warn"
    line_summary=$(printf 'WARN  %s  %s  (%d/%d, %d%%)' "$short" "$subject" "$matched" "$total" "$rate")
    WARN_LINES+=("$line_summary")
    printf '%s\n' "$line_summary"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    verdict="fail"
    line_summary=$(printf 'FAIL  %s  %s  (%d/%d, %d%%)' "$short" "$subject" "$matched" "$total" "$rate")
    FAIL_LINES+=("$line_summary")
    printf '%s\n' "$line_summary"
  fi

  if [ -n "$JSON_OUTPUT" ]; then
    escaped_subject=$(printf '%s' "$subject" | node -e "
      const s = require('fs').readFileSync('/dev/stdin','utf8');
      process.stdout.write(JSON.stringify(s).slice(1,-1));
    " 2>/dev/null || printf '%s' "$subject" | sed 's/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g; s/\\t/\\\\t/g; s/\\r/\\\\r/g')
    [ -n "$JSON_ENTRIES" ] && JSON_ENTRIES="$JSON_ENTRIES,"
    JSON_ENTRIES="$JSON_ENTRIES{\"commit\":\"$short\",\"subject\":\"$escaped_subject\",\"verdict\":\"$verdict\",\"matched\":$matched,\"total\":$total,\"rate\":$rate}"
  fi
done < <(git log "${log_args[@]}" --reverse --format='%H' "${UPSTREAM_REF}..${HEAD_REF}")

echo ""
echo "================== Fork Patch Verify ($MODE mode) =================="
printf 'Total: %d commits  |  PASS: %d  |  WARN: %d  |  FAIL: %d  |  SKIP: %d\n' \
  "$TOTAL" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"
echo "Thresholds: PASS≥${PASS_THRESHOLD}%  WARN≥${WARN_THRESHOLD}%  FAIL<${WARN_THRESHOLD}%"

if [ -n "$JSON_OUTPUT" ]; then
  cat <<ENDJSON > "$JSON_OUTPUT"
{"mode":"$MODE","pass":$PASS_COUNT,"warn":$WARN_COUNT,"fail":$FAIL_COUNT,"skip":$SKIP_COUNT,"total":$TOTAL,"gate_passed":$([ "$FAIL_COUNT" -eq 0 ] && echo "true" || echo "false"),"entries":[$JSON_ENTRIES]}
ENDJSON
  echo "📄 JSON 结果已写入: $JSON_OUTPUT"
fi

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo ""
  echo "❌ ${FAIL_COUNT} 个 fork patch 疑似丢失（匹配率 < ${WARN_THRESHOLD}%）："
  for entry in "${FAIL_LINES[@]}"; do
    echo "  - $entry"
  done
  exit 1
fi

if [ "$WARN_COUNT" -gt 0 ]; then
  echo ""
  echo "⚠️ ${WARN_COUNT} 个 fork patch 仅部分命中，建议人工 review"
fi

echo "✅ 无 FAIL"
exit 0
