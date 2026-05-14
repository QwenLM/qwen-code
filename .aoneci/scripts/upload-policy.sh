#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# upload-policy.sh
#
# 根据分支名决定上传策略：
#   - main/release 分支：完整上传（metadata + latest 指针 + 根目录脚本）
#   - 其他分支：仅上传版本化产物，不影响公共入口
#
# 输出 key=value 到 stdout，调用方写入文件后供后续步骤读取。
#
# 用法:
#   bash upload-policy.sh <branch> > /workspace/.upload_policy.env
# ──────────────────────────────────────────────────────────
set -eu

branch="${1:-${BUILD_GIT_BRANCH:-${GIT_BRANCH:-}}}"

skip_metadata=""
skip_latest_pointer="1"
skip_root_scripts="1"

case "${branch}" in
  main|master|release|release/*)
    skip_latest_pointer=""
    skip_root_scripts=""
    ;;
  dev|dataworks)
    skip_latest_pointer=""
    skip_root_scripts=""
    ;;
esac

printf 'SKIP_METADATA=%s\n' "${skip_metadata}"
printf 'SKIP_LATEST_POINTER=%s\n' "${skip_latest_pointer}"
printf 'SKIP_ROOT_SCRIPTS=%s\n' "${skip_root_scripts}"
