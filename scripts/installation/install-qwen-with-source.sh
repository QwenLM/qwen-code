#!/bin/bash

# Script to install Node.js and Qwen Code with source information
# This script handles the installation process and sets the installation source
#
# Usage: install-qwen-with-source.sh --source [github|npm|internal|local-build]
#        install-qwen-with-source.sh -s [github|npm|internal|local-build]

# Disable pagers to prevent interactive prompts
export GIT_PAGER=cat
export PAGER=cat

# Enable pipefail to catch errors in pipelines
set -o pipefail

# Function to display usage
usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -s, --source SOURCE    Specify the installation source (e.g., github, npm, internal)"
    echo "  -h, --help             Show this help message"
    echo ""
    exit 1
}

# Parse command line arguments
SOURCE="unknown"
while [[ $# -gt 0 ]]; do
    case $1 in
        -s|--source)
            if [[ -z "$2" ]] || [[ "$2" == -* ]]; then
                echo "Error: --source requires a value"
                usage
            fi
            SOURCE="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            usage
            ;;
    esac
done

echo "==========================================="
echo "Qwen Code Installation Script with Source Tracking"
echo "==========================================="

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check and install Node.js
install_nodejs() {
    if command_exists node; then
        NODE_VERSION=$(node --version)
        # Extract major version number (remove 'v' prefix and get first number)
        NODE_MAJOR_VERSION=$(echo "${NODE_VERSION}" | sed 's/v//' | cut -d'.' -f1) || true

        # Check if NODE_MAJOR_VERSION is a valid number
        if ! [[ "${NODE_MAJOR_VERSION}" =~ ^[0-9]+$ ]]; then
            echo "⚠ Could not parse Node.js version: ${NODE_VERSION}"
            echo "Installing Node.js 20+..."
            install_nodejs_via_nvm
        elif [[ "${NODE_MAJOR_VERSION}" -ge 20 ]]; then
            echo "✓ Node.js is already installed: ${NODE_VERSION}"
            
            # Check npm after confirming Node.js exists
            if ! command_exists npm; then
                echo "⚠ npm not found, installing npm..."
                if install_npm_only; then
                    echo "✓ npm installation completed"
                else
                    echo "✗ Failed to install npm"
                    echo "Please install npm manually or reinstall Node.js from: https://nodejs.org/"
                    exit 1
                fi
            else
                if NPM_VERSION=$(npm --version 2>/dev/null) && [[ -n "${NPM_VERSION}" ]]; then
                    echo "✓ npm v${NPM_VERSION} is available"
                else
                    echo "⚠ npm exists but cannot execute, reinstalling..."
                    if install_npm_only; then
                        echo "✓ npm installation fixed"
                    else
                        echo "✗ Failed to fix npm"
                        exit 1
                    fi
                fi
            fi

            return 0
        else
            echo "⚠ Node.js ${NODE_VERSION} is installed, but Qwen Code requires Node.js 20+"
            echo "Installing Node.js 20+..."
            install_nodejs_via_nvm
        fi
    else
        echo "Installing Node.js 20+..."
        install_nodejs_via_nvm
    fi
}

# Function to check if NVM installation is complete
check_nvm_complete() {
    export NVM_DIR="${HOME}/.nvm"

    if [[ ! -d "${NVM_DIR}" ]]; then
        return 1
    fi

    if [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
        echo "⚠ Incomplete NVM: nvm.sh missing"
        return 1
    fi

    # shellcheck source=/dev/null
    if ! \. "${NVM_DIR}/nvm.sh" 2>/dev/null; then
        echo "⚠ Corrupted NVM: cannot load nvm.sh"
        return 1
    fi

    if ! command_exists nvm; then
        echo "⚠ Incomplete NVM: nvm command unavailable"
        return 1
    fi
    
    return 0
}

# Function to uninstall NVM
uninstall_nvm() {
    echo "Uninstalling NVM..."
    export NVM_DIR="${HOME}/.nvm"

    if [[ -d "${NVM_DIR}" ]]; then
        # Try to remove the directory, check for errors
        if ! rm -rf "${NVM_DIR}" 2>/dev/null; then
            echo "⚠ Failed to remove NVM directory (permission denied or files in use)"
            echo "  Attempting with elevated permissions..."
            # Try with sudo if available
            if command -v sudo >/dev/null 2>&1; then
                sudo rm -rf "${NVM_DIR}" 2>/dev/null || true
            fi
        fi

        # Verify removal
        if [[ -d "${NVM_DIR}" ]]; then
            echo "⚠ Warning: Could not fully remove NVM directory at ${NVM_DIR}"
            echo "  Some files may be in use by other processes."
            echo "  Continuing anyway, but installation may fail..."
        else
            echo "✓ Removed NVM directory"
        fi
    fi

    # Clean shell configs
    for config in "${HOME}/.bashrc" "${HOME}/.bash_profile" "${HOME}/.zshrc" "${HOME}/.profile"; do
        if [[ -f "${config}" ]]; then
            # shellcheck disable=SC2312
            cp "${config}" "${config}.bak.$(date +%s)" 2>/dev/null
            sed -i.tmp '/NVM_DIR/d; /nvm.sh/d; /bash_completion/d' "${config}" 2>/dev/null || \
            sed -i '' '/NVM_DIR/d; /nvm.sh/d; /bash_completion/d' "${config}" 2>/dev/null
            rm -f "${config}.tmp" 2>/dev/null || true
        fi
    done

    # Unset nvm function to avoid conflicts with reinstallation
    unset -f nvm 2>/dev/null || true

    echo "✓ Cleaned NVM configuration"
}

# Function to install npm only
install_npm_only() {
    echo "Installing npm separately..."

    if command_exists curl; then
        echo "Attempting to install npm using: curl -qL https://www.npmjs.com/install.sh | sh"
        if curl -qL https://www.npmjs.com/install.sh | sh; then
            NPM_VERSION_TMP=$(npm --version 2>/dev/null)
            if command_exists npm && [[ -n "${NPM_VERSION_TMP}" ]]; then
                echo "✓ npm v${NPM_VERSION_TMP} installed via direct install script"
                return 0
            fi
        fi
    else
        echo "curl command not found, proceeding with alternative methods"
    fi
    
    return 1
}

# Function to install Node.js via nvm
install_nodejs_via_nvm() {
    export NVM_DIR="${HOME}/.nvm"

    # Check NVM completeness
    if [[ -d "${NVM_DIR}" ]]; then
        if ! check_nvm_complete; then
            echo "Detected incomplete NVM installation"
            uninstall_nvm
            # If directory still exists after uninstall (partial removal), try to clean it
            if [[ -d "${NVM_DIR}" ]]; then
                echo "  Cleaning up residual NVM files..."
                # Remove everything except we can't delete (probably in use)
                find "${NVM_DIR}" -mindepth 1 -delete 2>/dev/null || true
                # If still can't remove the directory itself, warn but continue
                if [[ -d "${NVM_DIR}" ]]; then
                    echo "  Note: Some NVM files are locked by running processes."
                    echo "  Will attempt to install NVM over existing directory..."
                fi
            fi
        else
            echo "✓ NVM already installed"
        fi
    fi

    # Install NVM if needed (either no dir or partial/corrupted)
    if [[ ! -d "${NVM_DIR}" ]] || [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
        echo "Downloading NVM..."

        # Use mktemp for secure temporary file creation
        # Remove trailing slash from TMPDIR to avoid double slashes
        TEMP_DIR="${TMPDIR:-/tmp}"
        TEMP_DIR="${TEMP_DIR%/}"

        # Retry mktemp a few times if it fails
        TMP_INSTALL_SCRIPT=""
        for _ in 1 2 3; do
            TMP_INSTALL_SCRIPT=$(mktemp "${TEMP_DIR}/nvm_install.XXXXXXXXXX.sh" 2>/dev/null)
            if [[ -n "${TMP_INSTALL_SCRIPT}" ]] && [[ -f "${TMP_INSTALL_SCRIPT}" ]]; then
                break
            fi
            # Wait a bit before retry
            sleep 0.1
        done

        # Fallback if mktemp still fails
        if [[ -z "${TMP_INSTALL_SCRIPT}" ]]; then
            TMP_INSTALL_SCRIPT="${TEMP_DIR}/nvm_install_$$_$(date +%s%N).sh"
            touch "${TMP_INSTALL_SCRIPT}" 2>/dev/null || {
                echo "✗ Failed to create temporary file"
                exit 1
            }
        fi

        # Ensure cleanup on exit
        trap 'rm -f "${TMP_INSTALL_SCRIPT}"' EXIT

        if curl -f -s -S -o "${TMP_INSTALL_SCRIPT}" "https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install_nvm.sh"; then
            if bash "${TMP_INSTALL_SCRIPT}"; then
                rm -f "${TMP_INSTALL_SCRIPT}"
                trap - EXIT
                echo "✓ NVM installed"
            else
                echo "✗ NVM installation failed"
                rm -f "${TMP_INSTALL_SCRIPT}"
                trap - EXIT
                echo "Please install Node.js manually from: https://nodejs.org/"
                exit 1
            fi
        else
            echo "✗ Failed to download NVM"
            rm -f "${TMP_INSTALL_SCRIPT}"
            trap - EXIT
            echo "Please check your internet connection or install Node.js manually from https://nodejs.org/"
            exit 1
        fi
    fi

    # Load NVM
    if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
        # shellcheck source=/dev/null
        \. "${NVM_DIR}/nvm.sh"
    else
        echo "✗ NVM installation failed - nvm.sh not found"
        echo "Please install Node.js manually from https://nodejs.org/"
        exit 1
    fi

    # shellcheck source=/dev/null
    [[ -s "${NVM_DIR}/bash_completion" ]] && \. "${NVM_DIR}/bash_completion"

    # Verify NVM loaded
    if ! command_exists nvm; then
        echo "✗ Failed to load NVM"
        echo "Please manually load NVM or install Node.js from https://nodejs.org/"
        exit 1
    fi

    # Install Node.js 20
    echo "Installing Node.js 20..."
    if nvm install 20 >/dev/null 2>&1; then
        nvm use 20 >/dev/null 2>&1
        nvm alias default 20 >/dev/null 2>&1
    else
        echo "✗ Failed to install Node.js 20"
        exit 1
    fi
    
    # Verify Node.js
    if ! command_exists node; then
        echo "✗ Node.js installation verification failed"
        exit 1
    fi

    if ! NODE_VERSION=$(node --version 2>/dev/null) || [[ -z "${NODE_VERSION}" ]]; then
        echo "✗ Node.js cannot execute properly"
        exit 1
    fi

    echo "✓ Node.js ${NODE_VERSION} installed"

    # Check npm separately
    if ! command_exists npm; then
        echo "⚠ npm not found"

        if install_npm_only; then
            echo "✓ npm installation fixed"
        else
            echo "✗ Failed to install npm"
            echo "Please try:"
            echo "  1. Run this script again"
            echo "  2. Install Node.js from: https://nodejs.org/"
            exit 1
        fi
    else
        if NPM_VERSION=$(npm --version 2>/dev/null) && [[ -n "${NPM_VERSION}" ]]; then
            echo "✓ npm v${NPM_VERSION} installed"
        else
            echo "⚠ npm exists but cannot execute"

            if install_npm_only; then
                echo "✓ npm installation fixed"
            else
                echo "✗ Failed to fix npm"
                exit 1
            fi
        fi
    fi
}

# Function to check and install Qwen Code
install_qwen_code() {
    if command_exists qwen; then
        QWEN_VERSION=$(qwen --version 2>/dev/null || echo "unknown")
        echo "✓ Qwen Code is already installed: ${QWEN_VERSION}"
        echo "  Upgrading to the latest version..."
    fi

    # Check if running as root
    USER_ID=$(id -u) || true
    if [[ "${USER_ID}" -eq 0 ]]; then
        # Running as root, no need for sudo
        NPM_INSTALL_CMD="npm install -g @qwen-code/qwen-code@latest"
    else
        # Not root, use sudo
        NPM_INSTALL_CMD="sudo npm install -g @qwen-code/qwen-code@latest"
    fi

    # Install/Upgrade Qwen Code globally
    # Note: Don't suppress output to allow sudo password prompt to be visible
    if ${NPM_INSTALL_CMD}; then
        echo "✓ Qwen Code installed/upgraded successfully!"

        # Create/Update source.json only if source parameter was provided
        if [[ "${SOURCE}" != "unknown" ]]; then
            create_source_json
        else
            echo "  (Skipping source.json creation - no source specified)"
        fi

        # Verify installation
        if command_exists qwen; then
            QWEN_VERSION=$(qwen --version 2>/dev/null || echo "unknown")
            echo "✓ Qwen Code is available as 'qwen' command"
            echo "  Installed version: ${QWEN_VERSION}"
        else
            echo "⚠ Qwen Code installed but not in PATH"
            echo "  You may need to restart your terminal"
        fi
    else
        echo "✗ Failed to install Qwen Code"
        exit 1
    fi
}

# Function to create source.json
create_source_json() {
    QWEN_DIR="${HOME}/.qwen"

    # Create .qwen directory if it doesn't exist
    if [[ ! -d "${QWEN_DIR}" ]]; then
        mkdir -p "${QWEN_DIR}"
    fi

    # Escape special characters in SOURCE for JSON
    # Replace backslashes first, then quotes
    ESCAPED_SOURCE=$(printf '%s' "${SOURCE}" | sed 's/\\/\\\\/g; s/"/\\"/g')

    # Create source.json file
    cat > "${QWEN_DIR}/source.json" <<EOF
{
  "source": "${ESCAPED_SOURCE}"
}
EOF

    echo "✓ Installation source saved to ~/.qwen/source.json"
}

# Main execution
main() {
    # Step 1: Check and install Node.js
    install_nodejs
    echo ""

    # Step 2: Check and install Qwen Code
    install_qwen_code
    echo ""

    echo "==========================================="
    echo "✓ Installation completed!"
    echo "==========================================="
    echo ""
    
    # Check if qwen is immediately available
    if command_exists qwen; then
        echo "✓ Qwen Code is ready to use!"
        echo ""
        echo "You can now run: qwen"
    else
        echo "⚠ To start using Qwen Code, please run one of the following commands:"
        echo ""
        
        # Detect user's shell
        USER_SHELL=$(basename "${SHELL}")

        if [[ "${USER_SHELL}" = "zsh" ]] && [[ -f "${HOME}/.zshrc" ]]; then
            echo "  source ~/.zshrc"
        elif [[ "${USER_SHELL}" = "bash" ]]; then
            if [[ -f "${HOME}/.bash_profile" ]]; then
                echo "  source ~/.bash_profile"
            elif [[ -f "${HOME}/.bashrc" ]]; then
                echo "  source ~/.bashrc"
            fi
        else
            # Fallback: show all possible options
            [[ -f "${HOME}/.zshrc" ]] && echo "  source ~/.zshrc"
            [[ -f "${HOME}/.bashrc" ]] && echo "  source ~/.bashrc"
            [[ -f "${HOME}/.bash_profile" ]] && echo "  source ~/.bash_profile"
        fi
        
        echo ""
        echo "Or simply restart your terminal, then run: qwen"
    fi
}

# Run main function
main "$@"
main