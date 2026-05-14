#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# upload-scripts.sh
#
# 将部署脚本上传到 OSS 固定路径，使 curl | bash 一键安装始终
# 拿到最新版本的脚本。
#
# 上传目标:
#   https://<bucket>.oss-cn-shanghai.aliyuncs.com/public-datasets/aone-release/<group>/<project>/deploy-qwen.sh
#   https://<bucket>.oss-cn-shanghai.aliyuncs.com/public-datasets/aone-release/<group>/<project>/upgrade-qwen.sh
#
# 此脚本与 upload-oss.sh 独立：upload-oss.sh 在构建流水线中
# 上传二进制产物 + 脚本；本脚本仅在脚本自身变更时同步脚本。
#
# 环境变量:
#   SOURCE_DIR              - 源码根目录
#   OSS_GROUP               - OSS 路径中的 group
#   OSS_PROJECT             - OSS 路径中的 project
#   OSS_ENDPOINT            - OSS endpoint URL（可选）
#   OSS_BUCKET              - OSS bucket 名（可选）
#   OSS_ACCESS_KEY_ID       - AK ID
#   OSS_ACCESS_KEY_SECRET   - AK Secret
# ──────────────────────────────────────────────────────────
set -eux

SOURCE_DIR="${SOURCE_DIR:?SOURCE_DIR is required}"
OSS_GROUP="${OSS_GROUP:?OSS_GROUP is required}"
OSS_PROJECT="${OSS_PROJECT:?OSS_PROJECT is required}"
OSS_ENDPOINT="${OSS_ENDPOINT:-https://oss-cn-shanghai.aliyuncs.com}"
OSS_BUCKET="${OSS_BUCKET:-dataworks-notebook-cn-shanghai}"
OSS_ACCESS_KEY_ID="${OSS_ACCESS_KEY_ID:?OSS_ACCESS_KEY_ID is required}"
OSS_ACCESS_KEY_SECRET="${OSS_ACCESS_KEY_SECRET:?OSS_ACCESS_KEY_SECRET is required}"

OSS_PROJECT_ROOT="public-datasets/aone-release/${OSS_GROUP}/${OSS_PROJECT}"
SCRIPTS_DIR="${SOURCE_DIR}/.aoneci/scripts"

# ── 安装 ossutil（如果不存在）──
if ! command -v ossutil64 &>/dev/null && ! command -v ossutil &>/dev/null; then
  curl -fsSL "https://gosspublic.alicdn.com/ossutil/1.7.18/ossutil-v1.7.18-linux-amd64.zip" -o /tmp/ossutil.zip
  unzip -o /tmp/ossutil.zip -d /tmp/ossutil
  chmod +x /tmp/ossutil/ossutil-v1.7.18-linux-amd64/ossutil64
  cp /tmp/ossutil/ossutil-v1.7.18-linux-amd64/ossutil64 /usr/local/bin/ossutil64
fi
OSSUTIL=$(command -v ossutil64 || command -v ossutil)

# ── 配置 ossutil ──
${OSSUTIL} config \
  -e "${OSS_ENDPOINT}" \
  -i "${OSS_ACCESS_KEY_ID}" \
  -k "${OSS_ACCESS_KEY_SECRET}"

# ── 上传 deploy-qwen.sh ──
DEPLOY_SCRIPT="${SCRIPTS_DIR}/deploy-qwen.sh"
if [ -f "${DEPLOY_SCRIPT}" ]; then
  ${OSSUTIL} cp -f "${DEPLOY_SCRIPT}" "oss://${OSS_BUCKET}/${OSS_PROJECT_ROOT}/deploy-qwen.sh"
  echo ">>> deploy-qwen.sh uploaded to project root"
else
  echo ">>> ERROR: ${DEPLOY_SCRIPT} not found" >&2
  exit 1
fi

# ── 上传 upgrade-qwen.sh ──
UPGRADE_SCRIPT="${SCRIPTS_DIR}/upgrade-qwen.sh"
if [ -f "${UPGRADE_SCRIPT}" ]; then
  ${OSSUTIL} cp -f "${UPGRADE_SCRIPT}" "oss://${OSS_BUCKET}/${OSS_PROJECT_ROOT}/upgrade-qwen.sh"
  echo ">>> upgrade-qwen.sh uploaded to project root"
else
  echo ">>> WARNING: ${UPGRADE_SCRIPT} not found, skipping"
fi

# ── 打印结果 ──
OSS_HOST="${OSS_BUCKET}.oss-cn-shanghai.aliyuncs.com"
echo ""
echo "============================================"
echo "  Qwen Code Scripts — Upload Complete"
echo "============================================"
echo ""
echo "Deploy script:"
echo "  https://${OSS_HOST}/${OSS_PROJECT_ROOT}/deploy-qwen.sh"
echo ""
echo "Upgrade script:"
echo "  https://${OSS_HOST}/${OSS_PROJECT_ROOT}/upgrade-qwen.sh"
echo ""
echo "One-click install:"
echo "  curl -fsSL https://${OSS_HOST}/${OSS_PROJECT_ROOT}/deploy-qwen.sh | bash -s -- --version <VERSION>"
echo "============================================"
