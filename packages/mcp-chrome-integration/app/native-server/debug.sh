#!/bin/bash
# 获取脚本所在的绝对目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="/Users/hang/code/tencent/ai/chrome-mcp-server/app/native-server/dist/logs" # 或者你选择的、确定有写入权限的目录

# 获取当前时间戳用于日志文件名，避免覆盖
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
WRAPPER_LOG="${LOG_DIR}/native_host_wrapper_${TIMESTAMP}.log"

# Node.js 脚本的实际路径
NODE_SCRIPT="${SCRIPT_DIR}/index.js"

# 确保日志目录存在
mkdir -p "${LOG_DIR}"

# 记录 wrapper 脚本被调用的信息
echo "Wrapper script called at $(date)" > "${WRAPPER_LOG}"
echo "SCRIPT_DIR: ${SCRIPT_DIR}" >> "${WRAPPER_LOG}"
echo "LOG_DIR: ${LOG_DIR}" >> "${WRAPPER_LOG}"
echo "NODE_SCRIPT: ${NODE_SCRIPT}" >> "${WRAPPER_LOG}"
echo "Initial PATH: ${PATH}" >> "${WRAPPER_LOG}"

# 动态查找 Node.js 可执行文件
NODE_EXEC=""
# 1. 尝试用 which (它会使用当前环境的 PATH, 但 Chrome 的 PATH 可能不完整)
if command -v node &>/dev/null; then
    NODE_EXEC=$(command -v node)
    echo "Found node using 'command -v node': ${NODE_EXEC}" >> "${WRAPPER_LOG}"
fi

# 2. 如果 which 找不到，尝试一些 macOS 上常见的 Node.js 安装路径
if [ -z "${NODE_EXEC}" ]; then
    COMMON_NODE_PATHS=(
        "/usr/local/bin/node"            # Homebrew on Intel Macs / direct install
        "/opt/homebrew/bin/node"         # Homebrew on Apple Silicon
        "$HOME/.nvm/versions/node/$(ls -t $HOME/.nvm/versions/node | head -n 1)/bin/node" # NVM (latest installed)
        # 你可以根据需要添加更多你环境中可能存在的路径
    )
    for path_to_node in "${COMMON_NODE_PATHS[@]}"; do
        if [ -x "${path_to_node}" ]; then
            NODE_EXEC="${path_to_node}"
            echo "Found node at common path: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
            break
        fi
    done
fi

# 3. 如果还是找不到，记录错误并退出
if [ -z "${NODE_EXEC}" ]; then
    echo "ERROR: Node.js executable not found!" >> "${WRAPPER_LOG}"
    echo "Please ensure Node.js is installed and its path is accessible or configured in this script." >> "${WRAPPER_LOG}"
    # 对于 Native Host，它需要保持运行以接收消息，直接退出可能不是最佳
    # 但如果node都找不到，也无法执行目标脚本
    # 这里可以考虑输出一个符合 Native Messaging 协议的错误消息给扩展（如果可以的话）
    # 或者就让它失败，Chrome会报告 Native Host Exited.
    exit 1 # 必须退出，否则下面的 exec 会失败
fi

echo "Using Node executable: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
echo "Node version found by script: $(${NODE_EXEC} -v)" >> "${WRAPPER_LOG}"
echo "Executing: ${NODE_EXEC} ${NODE_SCRIPT}" >> "${WRAPPER_LOG}"
echo "PWD: $(pwd)" >> "${WRAPPER_LOG}" # PWD 记录一下，有时有用

exec "${NODE_EXEC}" "${NODE_SCRIPT}" 2>> "${LOG_DIR}/native_host_stderr_${TIMESTAMP}.log"