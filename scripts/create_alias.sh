#!/usr/bin/env bash
set -euo pipefail

# This script creates an alias for the Qwen CLI

# Determine the project directory
PROJECT_DIR=$(cd "$(dirname "$0")/.." && pwd)

echo "Which alias would you like to create?"
echo "1) qwen (standard Qwen CLI)"
echo "2) qwen-alt (Qwen CLI with Claude compatibility adapter)"
read -p "Enter your choice (1 or 2): " -n 1 -r
echo ""

if [[ "${REPLY}" == "1" ]]; then
    ALIAS_COMMAND="alias qwen='node \"${PROJECT_DIR}/scripts/start.js\"'"
    ALIAS_NAME="qwen"
    echo "Creating standard qwen alias..."
elif [[ "${REPLY}" == "2" ]]; then
    ALIAS_COMMAND="alias qwen-alt='node \"${PROJECT_DIR}/scripts/claude-adapter.js\"'"
    ALIAS_NAME="qwen-alt"
    echo "Creating qwen-alt alias with Claude compatibility adapter..."
else
    echo "Invalid choice. Exiting."
    exit 1
fi

# Detect shell and set config file path
if [[ "${SHELL}" == *"/bash" ]]; then
    CONFIG_FILE="${HOME}/.bashrc"
elif [[ "${SHELL}" == *"/zsh" ]]; then
    CONFIG_FILE="${HOME}/.zshrc"
else
    echo "Unsupported shell. Only bash and zsh are supported."
    exit 1
fi

echo "This script will add the following alias to your shell configuration file (${CONFIG_FILE}):"
echo "  ${ALIAS_COMMAND}"
echo ""

# Check if the alias already exists
if grep -q "alias ${ALIAS_NAME}=" "${CONFIG_FILE}"; then
    echo "A '${ALIAS_NAME}' alias already exists in ${CONFIG_FILE}. No changes were made."
    exit 0
fi

read -p "Do you want to proceed? (y/n) " -n 1 -r
echo ""
if [[ "${REPLY}" =~ ^[Yy]$ ]]; then
    echo "${ALIAS_COMMAND}" >> "${CONFIG_FILE}"
    echo ""
    echo "Alias added to ${CONFIG_FILE}."
    echo "Please run 'source ${CONFIG_FILE}' or open a new terminal to use the '${ALIAS_NAME}' command."
else
    echo "Aborted. No changes were made."
fi