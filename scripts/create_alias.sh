#!/usr/bin/env bash
set -euo pipefail

# This script creates or removes an alias for the Qwen CLI

# Determine the project directory
PROJECT_DIR=$(cd "$(dirname "$0")/.." && pwd)

# Check for --remove option
if [[ "${1:-}" == "--remove" ]]; then
    MODE="remove"
else
    MODE="create"
fi

if [[ "$MODE" == "remove" ]]; then
    # Detect shell and set config file path
    if [[ "${SHELL}" == *"/bash" ]]; then
        CONFIG_FILE="${HOME}/.bashrc"
    elif [[ "${SHELL}" == *"/zsh" ]]; then
        CONFIG_FILE="${HOME}/.zshrc"
    else
        echo "Unsupported shell. Only bash and zsh are supported."
        exit 1
    fi

    # Remove both aliases without prompting
    ALIASES_TO_REMOVE=("qwen" "qwen-alt")
    
    for ALIAS_NAME in "${ALIASES_TO_REMOVE[@]}"; do
        if grep -q "alias ${ALIAS_NAME}=" "${CONFIG_FILE}"; then
            echo "Removing '${ALIAS_NAME}' alias from ${CONFIG_FILE}..."
            
            # Remove the alias line (handling potential quotes and whitespace variations)
            sed -i "/alias ${ALIAS_NAME}=/d" "${CONFIG_FILE}"
            
            echo "✓ Alias '${ALIAS_NAME}' has been removed from ${CONFIG_FILE}."
        else
            echo "→ No '${ALIAS_NAME}' alias found in ${CONFIG_FILE}."
        fi
    done
    
    echo "Please run 'source ${CONFIG_FILE}' or open a new terminal for changes to take effect."
else
    # Detect shell and set config file path
    if [[ "${SHELL}" == *"/bash" ]]; then
        CONFIG_FILE="${HOME}/.bashrc"
    elif [[ "${SHELL}" == *"/zsh" ]]; then
        CONFIG_FILE="${HOME}/.zshrc"
    else
        echo "Unsupported shell. Only bash and zsh are supported."
        exit 1
    fi

    # Create both aliases without prompting
    ALIASES_TO_CREATE=(
        "qwen=node \"${PROJECT_DIR}/scripts/start.js\""
        "qwen-alt=node \"${PROJECT_DIR}/scripts/claude-adapter.js\""
    )

    for ALIAS_DEF in "${ALIASES_TO_CREATE[@]}"; do
        ALIAS_NAME="${ALIAS_DEF%%=*}"  # Get alias name before =
        ALIAS_CMD="${ALIAS_DEF#*=}"   # Get command after =

        ALIAS_LINE="alias ${ALIAS_NAME}='${ALIAS_CMD}'"

        if grep -q "alias ${ALIAS_NAME}=" "${CONFIG_FILE}"; then
            echo "→ Alias '${ALIAS_NAME}' already exists in ${CONFIG_FILE}."
        else
            echo "Creating alias: ${ALIAS_NAME}"
            echo "${ALIAS_LINE}" >> "${CONFIG_FILE}"
            echo "✓ Alias '${ALIAS_NAME}' has been added to ${CONFIG_FILE}."
        fi
    done

    echo "Please run 'source ${CONFIG_FILE}' or open a new terminal for changes to take effect."
fi