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

# Global variable for download command
DOWNLOAD_CMD="curl -f -s -S -L"
WGET_CMD="wget -q -O -"

# Function to ensure curl or wget is available
ensure_curl_or_wget() {
    if command_exists curl; then
        DOWNLOAD_CMD="curl -f -s -S -L"
        WGET_CMD="wget -q -O -"
        return 0
    fi

    if command_exists wget; then
        echo "curl not found, using wget for downloads."
        DOWNLOAD_CMD="wget -q -O -"
        WGET_CMD="wget -q -O -"
        return 0
    fi

    echo "Neither curl nor wget found. Attempting to install..."

    # Check if we're root or have sudo
    if [[ "$(id -u)" -eq 0 ]]; then
        # Running as root, no sudo needed
        SUDO_CMD=""
    elif command_exists sudo && sudo -n true 2>/dev/null; then
        # Have sudo without password
        SUDO_CMD="sudo"
    else
        echo "Error: Cannot install curl - sudo is not available and not running as root."
        echo "Please install curl or wget manually and run this script again."
        exit 1
    fi

    # Try to install curl based on OS
    if command_exists apt-get; then
        echo "Installing curl via apt-get..."
        ${SUDO_CMD} apt-get update && ${SUDO_CMD} apt-get install -y curl
    elif command_exists dnf; then
        echo "Installing curl via dnf..."
        ${SUDO_CMD} dnf install -y curl
    elif command_exists pacman; then
        echo "Installing curl via pacman..."
        ${SUDO_CMD} pacman -Syu --noconfirm curl
    elif command_exists zypper; then
        echo "Installing curl via zypper..."
        ${SUDO_CMD} zypper install -y curl
    elif command_exists yum; then
        echo "Installing curl via yum..."
        ${SUDO_CMD} yum install -y curl
    elif command_exists brew; then
        echo "Installing curl via Homebrew..."
        ${SUDO_CMD} brew install curl
    elif command_exists /opt/homebrew/bin/brew; then
        echo "Installing curl via Homebrew (ARM)..."
        ${SUDO_CMD} /opt/homebrew/bin/brew install curl
    else
        echo "Error: Cannot install curl - no supported package manager found."
        echo "Please install curl or wget manually and run this script again."
        exit 1
    fi

    # Verify installation
    if command_exists curl; then
        echo "✓ curl installed successfully"
        return 0
    else
        echo "✗ Failed to install curl"
        exit 1
    fi
}

# Function to check if sudo is available
check_sudo_available() {
    if command_exists sudo; then
        # Check if sudo actually works (non-root user may have sudo but not configured)
        if sudo -n true 2>/dev/null; then
            return 0
        else
            echo "Warning: sudo is installed but requires password."
            return 1
        fi
    fi

    # No sudo found - check if we're running as root
    if [[ "$(id -u)" -eq 0 ]]; then
        return 0
    fi

    echo "Error: sudo is not available and you are not running as root."
    echo ""
    echo "This script requires either:"
    echo "  1. sudo access (run with a user in sudoers group)"
    echo "  2. root access (run as root)"
    echo ""
    echo "Please run this script with proper permissions or install packages manually."
    return 1
}

# Function to fix npm global directory permissions
fix_npm_permissions() {
    echo "Fixing npm global directory permissions..."

    # Get the actual npm global directory
    NPM_GLOBAL_DIR=$(npm config get prefix 2>/dev/null)
    if [[ -z "${NPM_GLOBAL_DIR}" ]] || [[ "${NPM_GLOBAL_DIR}" == *"error"* ]]; then
        # Fallback to default if npm config fails
        NPM_GLOBAL_DIR="${HOME}/.npm-global"
        echo "Warning: Could not determine npm prefix, using fallback: ${NPM_GLOBAL_DIR}"
    fi

    # SAFETY CHECK: Never modify system directories
    # This prevents catastrophic failures like breaking sudo setuid binaries
    case "${NPM_GLOBAL_DIR}" in
        /|/usr|/usr/local|/bin|/sbin|/lib|/lib64|/opt|/snap|/var|/etc)
            echo "Warning: npm prefix is a system directory (${NPM_GLOBAL_DIR})."
            echo "Skipping permission fix to avoid breaking system binaries."
            echo ""
            echo "This is likely a system-wide npm installation."
            echo "Consider using a user-owned npm prefix instead:"
            echo "  npm config set prefix ~/.npm-global"
            echo ""
            echo "Alternatively, you can manually fix permissions for your user directory:"
            echo "  mkdir -p ~/.npm-global"
            echo "  npm config set prefix ~/.npm-global"
            return 0
            ;;
    esac

    # 1. Change ownership of the entire npm global directory to current user
    #    Using only user ownership without specifying a group for cross-platform compatibility
    sudo chown -R "$(whoami)" "${NPM_GLOBAL_DIR}" 2>/dev/null || true

    # 2. Fix directory permissions (ensure user has full read/write/execute permissions)
    chmod -R u+rwX "${NPM_GLOBAL_DIR}" 2>/dev/null || true

    # 3. Specifically fix parent directory permissions (to prevent mkdir failures)
    chmod u+rwx "${NPM_GLOBAL_DIR}" "${NPM_GLOBAL_DIR}/lib" "${NPM_GLOBAL_DIR}/lib/node_modules" 2>/dev/null || true
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

            # Check if npm global directory has permission issues
            if ! npm config get prefix >/dev/null 2>&1; then
                fix_npm_permissions
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

    if command_exists curl || command_exists wget; then
        echo "Attempting to install npm using: npmjs.com/install.sh"
        if ${DOWNLOAD_CMD} https://www.npmjs.com/install.sh | sh; then
            NPM_VERSION_TMP=$(npm --version 2>/dev/null)
            if command_exists npm && [[ -n "${NPM_VERSION_TMP}" ]]; then
                echo "✓ npm v${NPM_VERSION_TMP} installed via direct install script"
                return 0
            fi
        fi
    else
        echo "No download tool (curl/wget) available"
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

        if ${DOWNLOAD_CMD} "https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install_nvm.sh" > "${TMP_INSTALL_SCRIPT}"; then
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

    # Check if .npmrc contains incompatible settings for nvm
    if [[ -f "${HOME}/.npmrc" ]]; then
        if grep -q "prefix\|globalconfig" "${HOME}/.npmrc"; then
            echo "⚠ Found incompatible settings in ~/.npmrc for NVM"
            echo "  Creating temporary backup and removing incompatible settings..."
            
            # Backup .npmrc file
            cp "${HOME}/.npmrc" "${HOME}/.npmrc.backup.before.qwen.install"
            
            # Create temporary .npmrc without incompatible settings
            grep -v -E '^(prefix|globalconfig)' "${HOME}/.npmrc" > "${HOME}/.npmrc.temp.for.qwen.install"
            
            # Use the temporary .npmrc
            mv "${HOME}/.npmrc" "${HOME}/.npmrc.original"
            mv "${HOME}/.npmrc.temp.for.qwen.install" "${HOME}/.npmrc"
            
            # Remember to restore later
            RESTORE_NPMRC=true
        fi
    fi

    echo "  Attempting to install Qwen Code with current user permissions..."
    if npm install -g @qwen-code/qwen-code@latest 2>/dev/null; then
        echo "✓ Qwen Code installed/upgraded successfully!"
    else
        # Installation failed, likely due to permissions
        echo "  Installation failed with user permissions, attempting to fix permissions..."

        # Fix npm global directory permissions
        fix_npm_permissions

        # Try again after fixing permissions
        if npm install -g @qwen-code/qwen-code@latest 2>/dev/null; then
            echo "✓ Qwen Code installed/upgraded successfully after permission fix!"
        else
            # Both attempts failed
            echo "✗ Failed to install Qwen Code even after permission fix"
            echo "  Please check your system permissions or contact support"
            # Restore .npmrc if we backed it up
            if [[ "${RESTORE_NPMRC}" = true ]]; then
                mv "${HOME}/.npmrc" "${HOME}/.npmrc.temp.after.failed.install"
                mv "${HOME}/.npmrc.original" "${HOME}/.npmrc"
                echo "  Restored original ~/.npmrc file"
            fi
            exit 1
        fi
    fi

    # Restore original .npmrc file if we modified it
    if [[ "${RESTORE_NPMRC}" = true ]]; then
        mv "${HOME}/.npmrc" "${HOME}/.npmrc.temp.after.successful.install"
        mv "${HOME}/.npmrc.original" "${HOME}/.npmrc"
        echo "  Restored original ~/.npmrc file"
    fi

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
    # Initialize variables
    RESTORE_NPMRC=false

    # Validate HOME variable
    if [[ -z "${HOME}" ]]; then
        echo "Warning: HOME environment variable is not set."
        if [[ "$(id -u)" -eq 0 ]]; then
            export HOME="/root"
            echo "Using HOME=/root for root user."
        else
            export HOME=$(eval echo ~$(whoami))
            echo "Using HOME=${HOME}."
        fi
    fi

    # Validate HOME directory exists
    if [[ ! -d "${HOME}" ]]; then
        echo "Error: HOME directory (${HOME}) does not exist."
        exit 1
    fi

    # Check sudo availability first (basic permission check)
    check_sudo_available

    # Ensure curl/wget is available (needed to download NVM)
    ensure_curl_or_wget

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