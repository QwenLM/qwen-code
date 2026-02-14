#!/usr/bin/env bash

# Configuration
ENABLE_LOG_ROTATION="true"
LOG_RETENTION_COUNT=5

# Setup paths
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_SCRIPT="${SCRIPT_DIR}/index.js"

# Setup log directory - prefer user-writable locations
# macOS: ~/Library/Logs/mcp-chrome-bridge
# Linux: $XDG_STATE_HOME/mcp-chrome-bridge/logs or ~/.local/state/mcp-chrome-bridge/logs
if [ "$(uname)" = "Darwin" ]; then
    LOG_DIR="${HOME}/Library/Logs/mcp-chrome-bridge"
else
    LOG_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/mcp-chrome-bridge/logs"
fi

# Fallback: if user directory is not writable, use package directory
if ! mkdir -p "${LOG_DIR}" 2>/dev/null; then
    LOG_DIR="${SCRIPT_DIR}/logs"
    mkdir -p "${LOG_DIR}" 2>/dev/null || true
fi

# Log rotation
if [ "${ENABLE_LOG_ROTATION}" = "true" ]; then
    # Clean up old logs (both legacy _macos_ and new _unix_ naming)
    ls -tp "${LOG_DIR}/native_host_wrapper_"* 2>/dev/null | tail -n +$((LOG_RETENTION_COUNT + 1)) | xargs -I {} rm -- {}
    ls -tp "${LOG_DIR}/native_host_stderr_"* 2>/dev/null | tail -n +$((LOG_RETENTION_COUNT + 1)) | xargs -I {} rm -- {}
fi

# Logging setup
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
WRAPPER_LOG="${LOG_DIR}/native_host_wrapper_unix_${TIMESTAMP}.log"
STDERR_LOG="${LOG_DIR}/native_host_stderr_unix_${TIMESTAMP}.log"

# Initial logging
{
    echo "--- Wrapper script called at $(date) ---"
    echo "SCRIPT_DIR: ${SCRIPT_DIR}"
    echo "LOG_DIR: ${LOG_DIR}"
    echo "NODE_SCRIPT: ${NODE_SCRIPT}"
    echo "Initial PATH: ${PATH}"
    echo "CHROME_MCP_NODE_PATH: ${CHROME_MCP_NODE_PATH:-<unset>}"
    echo "VOLTA_HOME: ${VOLTA_HOME:-<unset>}"
    echo "ASDF_DATA_DIR: ${ASDF_DATA_DIR:-<unset>}"
    echo "FNM_DIR: ${FNM_DIR:-<unset>}"
    echo "NVM_DIR: ${NVM_DIR:-<unset>}"
    echo "User: $(whoami)"
    echo "Current PWD: $(pwd)"
} > "${WRAPPER_LOG}"

# Node.js discovery
NODE_EXEC=""
NODE_EXEC_SOURCE=""
NODE_PATH_FILE="${SCRIPT_DIR}/node_path.txt"

echo "Searching for Node.js..." >> "${WRAPPER_LOG}"

# Priority 0: CHROME_MCP_NODE_PATH environment variable override
echo "[Priority 0] Checking CHROME_MCP_NODE_PATH override" >> "${WRAPPER_LOG}"
if [ -n "${CHROME_MCP_NODE_PATH:-}" ]; then
    CANDIDATE_NODE="${CHROME_MCP_NODE_PATH}"
    # Expand tilde
    if [[ "${CANDIDATE_NODE}" == "~/"* ]]; then
        CANDIDATE_NODE="${HOME}/${CANDIDATE_NODE#~/}"
    fi
    # If directory, append /node
    if [ -d "${CANDIDATE_NODE}" ]; then
        CANDIDATE_NODE="${CANDIDATE_NODE%/}/node"
    fi
    if [ -x "${CANDIDATE_NODE}" ]; then
        NODE_EXEC="${CANDIDATE_NODE}"
        NODE_EXEC_SOURCE="CHROME_MCP_NODE_PATH"
        echo "Found node via CHROME_MCP_NODE_PATH: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
    else
        echo "CHROME_MCP_NODE_PATH is set but not executable: ${CANDIDATE_NODE}" >> "${WRAPPER_LOG}"
    fi
fi

# Priority 1: Installation-time node path
echo "[Priority 1] Checking installation-time node path" >> "${WRAPPER_LOG}"
if [ -z "${NODE_EXEC}" ] && [ -f "${NODE_PATH_FILE}" ]; then
    EXPECTED_NODE=$(cat "${NODE_PATH_FILE}" 2>/dev/null | tr -d '\n\r')
    if [ -n "${EXPECTED_NODE}" ] && [ -x "${EXPECTED_NODE}" ]; then
        NODE_EXEC="${EXPECTED_NODE}"
        NODE_EXEC_SOURCE="node_path.txt"
        echo "Found installation-time node at ${NODE_EXEC}" >> "${WRAPPER_LOG}"
    else
        echo "node_path.txt exists but path invalid or not executable: ${EXPECTED_NODE}" >> "${WRAPPER_LOG}"
    fi
fi

# Priority 1.5: Fallback to relative path
if [ -z "${NODE_EXEC}" ]; then
    EXPECTED_NODE="${SCRIPT_DIR}/../../../bin/node"
    echo "[Priority 1.5] Checking relative path" >> "${WRAPPER_LOG}"
    if [ -x "${EXPECTED_NODE}" ]; then
        NODE_EXEC="${EXPECTED_NODE}"
        NODE_EXEC_SOURCE="relative"
        echo "Found node at relative path: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
    fi
fi

# Priority 2: Volta
if [ -z "${NODE_EXEC}" ]; then
    echo "[Priority 2] Checking Volta" >> "${WRAPPER_LOG}"
    VOLTA_HOME_CANDIDATE="${VOLTA_HOME:-$HOME/.volta}"
    VOLTA_NODE="${VOLTA_HOME_CANDIDATE}/bin/node"
    if [ -x "${VOLTA_NODE}" ]; then
        NODE_EXEC="${VOLTA_NODE}"
        NODE_EXEC_SOURCE="volta"
        echo "Found Volta node: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
    fi
fi

# Priority 3: asdf
if [ -z "${NODE_EXEC}" ]; then
    echo "[Priority 3] Checking asdf" >> "${WRAPPER_LOG}"
    ASDF_DIR="${ASDF_DATA_DIR:-$HOME/.asdf}"
    ASDF_NODEJS_DIR="${ASDF_DIR}/installs/nodejs"
    if [ -d "${ASDF_NODEJS_DIR}" ]; then
        # Find the latest version directory
        LATEST_ASDF_NODE_DIR=$(ls -1d "${ASDF_NODEJS_DIR}/"* 2>/dev/null | sort -V | tail -n 1)
        if [ -n "${LATEST_ASDF_NODE_DIR}" ] && [ -x "${LATEST_ASDF_NODE_DIR}/bin/node" ]; then
            NODE_EXEC="${LATEST_ASDF_NODE_DIR}/bin/node"
            NODE_EXEC_SOURCE="asdf"
            echo "Found asdf node: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
        fi
    fi
fi

# Priority 4: fnm
if [ -z "${NODE_EXEC}" ]; then
    echo "[Priority 4] Checking fnm" >> "${WRAPPER_LOG}"
    FNM_HOME_CANDIDATE="${FNM_DIR:-$HOME/.fnm}"
    FNM_NODE_VERSIONS_DIR="${FNM_HOME_CANDIDATE}/node-versions"
    if [ -d "${FNM_NODE_VERSIONS_DIR}" ]; then
        # Find the latest version directory
        LATEST_FNM_NODE_DIR=$(ls -1d "${FNM_NODE_VERSIONS_DIR}/"* 2>/dev/null | sort -V | tail -n 1)
        if [ -n "${LATEST_FNM_NODE_DIR}" ] && [ -x "${LATEST_FNM_NODE_DIR}/installation/bin/node" ]; then
            NODE_EXEC="${LATEST_FNM_NODE_DIR}/installation/bin/node"
            NODE_EXEC_SOURCE="fnm"
            echo "Found fnm node: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
        fi
    fi
fi

# Priority 5: NVM
if [ -z "${NODE_EXEC}" ]; then
    echo "[Priority 5] Checking NVM" >> "${WRAPPER_LOG}"
    NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ -d "${NVM_DIR}" ]; then
        # Try default version first (check both symlink and file)
        NVM_DEFAULT_ALIAS="${NVM_DIR}/alias/default"
        if [ -e "${NVM_DEFAULT_ALIAS}" ]; then
            if [ -L "${NVM_DEFAULT_ALIAS}" ]; then
                NVM_DEFAULT_VERSION=$(readlink "${NVM_DEFAULT_ALIAS}")
            else
                NVM_DEFAULT_VERSION=$(cat "${NVM_DEFAULT_ALIAS}" 2>/dev/null | tr -d '\n\r')
            fi
            NVM_DEFAULT_NODE="${NVM_DIR}/versions/node/${NVM_DEFAULT_VERSION}/bin/node"
            if [ -x "${NVM_DEFAULT_NODE}" ]; then
                NODE_EXEC="${NVM_DEFAULT_NODE}"
                NODE_EXEC_SOURCE="nvm-default"
                echo "Found NVM default node: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
            fi
        fi

        # Fallback to latest version
        if [ -z "${NODE_EXEC}" ]; then
            LATEST_NVM_VERSION_PATH=$(ls -d "${NVM_DIR}"/versions/node/v* 2>/dev/null | sort -V | tail -n 1)
            if [ -n "${LATEST_NVM_VERSION_PATH}" ] && [ -x "${LATEST_NVM_VERSION_PATH}/bin/node" ]; then
                NODE_EXEC="${LATEST_NVM_VERSION_PATH}/bin/node"
                NODE_EXEC_SOURCE="nvm-latest"
                echo "Found NVM latest node: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
            fi
        fi
    fi
fi

# Priority 6: Common paths
if [ -z "${NODE_EXEC}" ]; then
    echo "[Priority 6] Checking common paths" >> "${WRAPPER_LOG}"
    COMMON_NODE_PATHS=(
        "/opt/homebrew/bin/node"
        "/usr/local/bin/node"
        "/usr/bin/node"
    )
    for path_to_node in "${COMMON_NODE_PATHS[@]}"; do
        if [ -x "${path_to_node}" ]; then
            NODE_EXEC="${path_to_node}"
            NODE_EXEC_SOURCE="common"
            echo "Found node at: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
            break
        fi
    done
fi

# Priority 7: command -v
if [ -z "${NODE_EXEC}" ]; then
    echo "[Priority 7] Trying 'command -v node'" >> "${WRAPPER_LOG}"
    if command -v node &>/dev/null; then
        NODE_EXEC=$(command -v node)
        NODE_EXEC_SOURCE="command -v"
        echo "Found node using 'command -v': ${NODE_EXEC}" >> "${WRAPPER_LOG}"
    fi
fi

# Priority 8: PATH search
if [ -z "${NODE_EXEC}" ]; then
    echo "[Priority 8] Searching PATH" >> "${WRAPPER_LOG}"
    OLD_IFS=$IFS
    IFS=:
    for path_in_env in $PATH; do
        if [ -x "${path_in_env}/node" ]; then
            NODE_EXEC="${path_in_env}/node"
            NODE_EXEC_SOURCE="PATH"
            echo "Found node in PATH: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
            break
        fi
    done
    IFS=$OLD_IFS
fi

# Execution
if [ -z "${NODE_EXEC}" ]; then
    {
        echo "ERROR: Node.js executable not found!"
        echo "Searched: CHROME_MCP_NODE_PATH, node_path.txt, relative path, Volta, asdf, fnm, NVM, common paths, command -v, PATH"
        echo "To fix: Set CHROME_MCP_NODE_PATH environment variable or run 'mcp-chrome-bridge doctor --fix'"
    } >> "${WRAPPER_LOG}"
    exit 1
fi

if [ ! -f "${NODE_SCRIPT}" ]; then
    echo "ERROR: Node.js script not found at ${NODE_SCRIPT}" >> "${WRAPPER_LOG}"
    exit 1
fi

{
    echo "Using Node executable: ${NODE_EXEC}"
    echo "Node discovery source: ${NODE_EXEC_SOURCE:-unknown}"
    echo "Node version: $(${NODE_EXEC} -v)"
    echo "Executing: ${NODE_EXEC} ${NODE_SCRIPT}"
} >> "${WRAPPER_LOG}"

# Add Node.js bin directory to PATH so child processes can find node and related tools
NODE_BIN_DIR="$(dirname "${NODE_EXEC}")"
# Use ${PATH:+:${PATH}} to avoid trailing colon when PATH is empty (security concern)
export PATH="${NODE_BIN_DIR}${PATH:+:${PATH}}"
echo "Added ${NODE_BIN_DIR} to PATH" >> "${WRAPPER_LOG}"

# Log Claude Code Router (CCR) related env vars for debugging
# These are set by `eval "$(ccr activate)"` or in shell profile
if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
    echo "ANTHROPIC_BASE_URL is set: ${ANTHROPIC_BASE_URL}" >> "${WRAPPER_LOG}"
fi
if [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
    echo "ANTHROPIC_AUTH_TOKEN is set (value hidden)" >> "${WRAPPER_LOG}"
fi

exec "${NODE_EXEC}" "${NODE_SCRIPT}" 2>> "${STDERR_LOG}"
