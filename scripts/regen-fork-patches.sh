#!/usr/bin/env bash
# scripts/regen-fork-patches.sh — 重新生成 .fork/patches.md 中标注为 AUTO 的区段。
#
# 处理三个 marker 区段：
#   <!-- AUTO:SNAPSHOT BEGIN --> ... <!-- AUTO:SNAPSHOT END -->
#   <!-- AUTO:LANDING BEGIN -->  ... <!-- AUTO:LANDING END -->
#   <!-- AUTO:INVENTORY BEGIN --> ... <!-- AUTO:INVENTORY END -->
#
# 用法：
#   bash scripts/regen-fork-patches.sh           # 输出预览到 stdout
#   bash scripts/regen-fork-patches.sh --write   # 直接覆盖 .fork/patches.md
#   bash scripts/regen-fork-patches.sh --check   # 不写盘，diff 不为空则 exit 1
#
# 环境变量：
#   UPSTREAM_REF  默认 upstream/main
#   ORIGIN_REF    默认 origin/main
#   PATCH_BASE_REF 默认 git merge-base "$ORIGIN_REF" "$UPSTREAM_REF"
#   FILE          默认 .fork/patches.md

set -uo pipefail

FILE="${FILE:-.fork/patches.md}"
UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"
ORIGIN_REF="${ORIGIN_REF:-origin/main}"
PATCH_BASE_REF="${PATCH_BASE_REF:-}"
ACTION="${1:-stdout}"

if [ ! -f "$FILE" ]; then
  echo "❌ 未找到 $FILE" >&2
  exit 2
fi
if ! git rev-parse --verify --quiet "${UPSTREAM_REF}^{commit}" >/dev/null; then
  echo "❌ $UPSTREAM_REF 不可用，先 git fetch upstream main" >&2
  exit 2
fi
if ! git rev-parse --verify --quiet "${ORIGIN_REF}^{commit}" >/dev/null; then
  echo "❌ $ORIGIN_REF 不可用" >&2
  exit 2
fi
if [ -n "$PATCH_BASE_REF" ]; then
  if ! git rev-parse --verify --quiet "${PATCH_BASE_REF}^{commit}" >/dev/null; then
    echo "❌ PATCH_BASE_REF 不可用: $PATCH_BASE_REF" >&2
    exit 2
  fi
else
  PATCH_BASE_REF=$(git merge-base "$ORIGIN_REF" "$UPSTREAM_REF" 2>/dev/null || echo "")
fi
if [ -z "$PATCH_BASE_REF" ]; then
  echo "❌ 无法计算 $ORIGIN_REF 与 $UPSTREAM_REF 的 merge-base" >&2
  exit 2
fi

classify_subject() {
  case "$1" in
    "Merge commit '"*) echo "sync"; return ;;
    "Merge branch sync/"*) echo "sync"; return ;;
    *"sync upstream"*) echo "sync"; return ;;
    *"sync/resolve-upstream"*) echo "sync"; return ;;
    "fix: align "*) echo "sync-fix"; return ;;
    "chore(release)"*) echo "release"; return ;;
    "chore: release"*) echo "release"; return ;;
    "chore: bump"*) echo "release"; return ;;
    "chore: rebase"*) echo "release"; return ;;
    "build: bump"*) echo "release"; return ;;
    "ci(release)"*) echo "release"; return ;;
    "ci: publish"*) echo "release"; return ;;
  esac
  echo "fork"
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

SNAPSHOT="$WORK/snapshot"
LANDING="$WORK/landing"
INVENTORY="$WORK/inventory"

fork_head=$(git rev-parse "$ORIGIN_REF")
upstream_head=$(git rev-parse "$UPSTREAM_REF")
patch_base=$(git rev-parse "$PATCH_BASE_REF")
landing_count=$(git log --first-parent --format='%H' "${patch_base}..${ORIGIN_REF}" | wc -l | tr -d ' ')
patch_count=$(git log --no-merges --format='%H' "${patch_base}..${ORIGIN_REF}" | wc -l | tr -d ' ')
short_or_dash() { [ -n "$1" ] && git rev-parse --short=9 "$1" || echo "-"; }

cat <<EOF >"$SNAPSHOT"

- generated_at: $(date +%Y-%m-%d)
- fork_ref: \`$ORIGIN_REF\`
- fork_head: \`$(short_or_dash "$fork_head")\`
- upstream_ref: \`$UPSTREAM_REF\`
- upstream_head: \`$(short_or_dash "$upstream_head")\`
- patch_base: \`$(short_or_dash "$patch_base")\`
- diff_range: \`$(short_or_dash "$patch_base")..$ORIGIN_REF\`
- first_parent_landing_commits: $landing_count
- patch_bearing_commits: $patch_count

EOF

# 落地 commit 表：每个 commit 取 subject + body，提取 CR URL，清洗标题
# 注意：BSD awk 不支持 FS=NUL，所以用 bash per-commit 循环（~35 个 commit，开销可忽略）。
{
  printf '\n| Commit | Type | CR | Title |\n'
  printf '| --- | --- | --- | --- |\n'
  while IFS= read -r sha; do
    [ -z "$sha" ] && continue
    short=$(printf '%s' "$sha" | cut -c1-9)
    subj=$(git log -1 --format='%s' "$sha")
    body=$(git log -1 --format='%b' "$sha")
    combined="$subj
$body"
    # 提取第一条 codereview URL
    cr=$(printf '%s' "$combined" | grep -oE 'https?://[^[:space:]"<>]*codereview/[0-9]+' | head -1)
    cr="${cr:--}"
    # 清洗 subject：去掉拼接的 Link:/Title:/* 等前缀
    cleaned=$(printf '%s' "$subj" \
      | sed -E 's@[[:space:]]*Link:[[:space:]]*https?://[^[:space:]]+[[:space:]]*@ @g' \
      | sed -E 's@^Merge branch [^[:space:]]+ into [^[:space:]]+ Title:[[:space:]]*@@' \
      | sed -E 's@^Title:[[:space:]]*@@' \
      | sed -E 's@[[:space:]]*\*[[:space:]]*$@@' \
      | sed -E 's@^[[:space:]]+|[[:space:]]+$@@g' \
      | sed -E 's@\|@\\|@g')
    type=$(classify_subject "$cleaned")
    printf '| `%s` | %s | %s | %s |\n' "$short" "$type" "$cr" "$cleaned"
  done < <(git log --first-parent --reverse --format='%H' "${patch_base}..${ORIGIN_REF}")
} >"$LANDING"

# 全量 patch-bearing commit inventory（短 SHA + 单行 subject）
{
  echo
  echo '```text'
  git log --no-merges --reverse --format='%h %s' "${patch_base}..${ORIGIN_REF}"
  echo '```'
  echo
} >"$INVENTORY"

# 用 awk 按 marker 替换三个区段。markers 必须存在；缺失则报错并保留原文。
replace_block() {
  local marker_name="$1" content_path="$2" infile="$3"
  awk -v marker="$marker_name" -v cf="$content_path" '
    BEGIN { skip = 0 }
    {
      if ($0 ~ "<!-- AUTO:" marker " BEGIN -->") {
        print
        while ((getline line < cf) > 0) print line
        close(cf)
        skip = 1
        next
      }
      if (skip == 1 && $0 ~ "<!-- AUTO:" marker " END -->") {
        print
        skip = 0
        next
      }
      if (skip == 1) next
      print
    }
  ' "$infile"
}

OUT="$WORK/out"
cp "$FILE" "$OUT"
MISSING=()
for marker in SNAPSHOT LANDING INVENTORY; do
  if ! grep -q "<!-- AUTO:$marker BEGIN -->" "$OUT" || \
     ! grep -q "<!-- AUTO:$marker END -->" "$OUT"; then
    MISSING+=("$marker")
    continue
  fi
  case "$marker" in
    SNAPSHOT)  src="$SNAPSHOT" ;;
    LANDING)   src="$LANDING" ;;
    INVENTORY) src="$INVENTORY" ;;
  esac
  TMP_OUT="$WORK/out.tmp"
  replace_block "$marker" "$src" "$OUT" >"$TMP_OUT"
  mv "$TMP_OUT" "$OUT"
done

if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "⚠️ 以下 marker 区段不存在于 $FILE，对应内容未更新：${MISSING[*]}" >&2
  echo "   请在 $FILE 中加入 <!-- AUTO:<NAME> BEGIN/END --> 注释后再运行。" >&2
fi

case "$ACTION" in
  --write)
    cp "$OUT" "$FILE"
    echo "✅ $FILE 已更新（generated_at: $(date +%Y-%m-%d)）"
    ;;
  --check)
    if diff -q "$OUT" "$FILE" >/dev/null 2>&1; then
      echo "✅ $FILE 已是最新"
      exit 0
    fi
    echo "❌ $FILE 与 git 历史不一致；请运行 'bash scripts/regen-fork-patches.sh --write' 更新" >&2
    diff "$FILE" "$OUT" | head -60 >&2
    exit 1
    ;;
  stdout|*)
    cat "$OUT"
    ;;
esac
