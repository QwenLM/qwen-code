#!/bin/bash

# Qwen Code Installation Script
# This script installs Node.js (via NVM) and Qwen Code CLI
# Supports Linux and macOS
#
# Usage: install-qwen-with-source.sh --source [github|npm|internal|local-build]
#        install-qwen-with-source.sh -s [github|npm|internal|local-build]

# Re-execute with bash if running with sh or other shells
# This block must use POSIX-compliant syntax ([ not [[) since it runs before we know bash is available
if [ -z "${BASH_VERSION}" ] && [ -z "${__QWEN_INSTALL_REEXEC:-}" ]; then
    # Check if we're in a git hook environment
    case "${0}" in
        *.git/hooks/*) export __QWEN_IN_GIT_HOOK=1 ;;
    esac
    if [ -n "${GIT_DIR:-}" ]; then
        export __QWEN_IN_GIT_HOOK=1
    fi

    # Try to find bash
    if command -v bash >/dev/null 2>&1; then
        export __QWEN_INSTALL_REEXEC=1
        # Re-exec with bash, preserving all arguments
        exec bash -- "${0}" "$@"
    else
        echo "Error: This script requires bash. Please install bash first."
        exit 1
    fi
fi

# Enable strict mode (bash-specific options)
# pipefail requires bash 3+; check before setting
if [ -n "${BASH_VERSION:-}" ]; then
    # shellcheck disable=SC3040
    set -eo pipefail
else
    set -e
fi

# ============================================
# Color definitions
# ============================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================
# Log functions
# ============================================
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

# ============================================
# Utility functions
# ============================================
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

get_shell_profile() {
    local current_shell
    current_shell=$(basename "${SHELL}")
    case "${current_shell}" in
        bash)
            echo "${HOME}/.bashrc"
            ;;
        zsh)
            echo "${HOME}/.zshrc"
            ;;
        fish)
            # Fish uses its own syntax; bash/zsh export statements are not compatible.
            # Return empty string to signal callers to skip automatic profile writes.
            echo ""
            ;;
        *)
            echo "${HOME}/.profile"
            ;;
    esac
}

# ============================================
# Parse command line arguments
# ============================================
SOURCE="unknown"
while [[ $# -gt 0 ]]; do
    case $1 in
        -s|--source)
            if [[ -z "$2" ]] || [[ "$2" == -* ]]; then
                log_error "--source requires a value"
                exit 1
            fi
            SOURCE="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -s, --source SOURCE    Specify the installation source (e.g., github, npm, internal)"
            echo "  -h, --help             Show this help message"
            echo ""
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# ============================================
# Print header
# ============================================
echo "=========================================="
echo "   Qwen Code Installation Script"
echo "=========================================="
echo ""
log_info "System: $(uname -s) $(uname -r)" || true
log_info "Shell: $(basename "${SHELL}")"
echo ""

# ============================================
# Ensure download tool is available
# ============================================
ensure_download_tool() {
    if command_exists curl; then
        DOWNLOAD_CMD="curl"
        DOWNLOAD_ARGS="-fsSL"
        return 0
    fi

    if command_exists wget; then
        DOWNLOAD_CMD="wget"
        DOWNLOAD_ARGS="-qO -"
        return 0
    fi

    log_error "Neither curl nor wget found"
    log_info "Please install curl or wget manually:"
    echo "  - macOS: brew install curl"
    echo "  - Ubuntu/Debian: sudo apt-get install curl"
    echo "  - CentOS/RHEL: sudo yum install curl"
    exit 1
}

# ============================================
# Clean npm configuration conflicts
# ============================================
clean_npmrc_conflict() {
    local npmrc="${HOME}/.npmrc"
    if [[ -f "${npmrc}" ]]; then
        # Check if a user-configured prefix already exists
        local existing_prefix
        existing_prefix=$(grep -E '^prefix *= *' "${npmrc}" 2>/dev/null | head -1 | sed 's/^prefix *= *//' | sed 's/[[:space:]]*$//' || true)
        if [[ -n "${existing_prefix}" ]]; then
            # User has already configured a prefix — respect it, don't overwrite
            log_info "User-configured npm prefix found in .npmrc: ${existing_prefix}, skipping cleanup"
            return 0
        fi

        # Only clean globalconfig conflicts when prefix is not set
        if grep -Eq '^globalconfig *= *' "${npmrc}" 2>/dev/null; then
            log_info "Cleaning npmrc globalconfig conflicts..."
            # Backup original npmrc before modifying
            cp -f "${npmrc}" "${npmrc}.bak"
            log_info "Backed up original .npmrc to ${npmrc}.bak"
            grep -Ev '^globalconfig *= *' "${npmrc}.bak" > "${npmrc}.tmp" || true
            mv -f "${npmrc}.tmp" "${npmrc}" || true
            log_success "Removed conflicting globalconfig entries from .npmrc"
        fi
    fi
}

# ============================================
# Install NVM
# ============================================
install_nvm() {
    local NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
    local NVM_VERSION="${NVM_VERSION:-v0.40.3}"

    if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
        log_info "NVM is already installed at ${NVM_DIR}"
        return 0
    fi

    log_info "Installing NVM ${NVM_VERSION}..."

    # Download and install NVM from Aliyun OSS
    # Use temporary file instead of pipe to avoid potential subshell issues
    local NVM_INSTALL_TEMP
    NVM_INSTALL_TEMP=$(mktemp)
    if "${DOWNLOAD_CMD}" "${DOWNLOAD_ARGS}" "https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install_nvm.sh" > "${NVM_INSTALL_TEMP}"; then
        # Run the script in current shell environment
        # shellcheck source=/dev/null
        . "${NVM_INSTALL_TEMP}"
        rm -f "${NVM_INSTALL_TEMP}"
        log_success "NVM installed successfully"
    else
        rm -f "${NVM_INSTALL_TEMP}"
        log_error "Failed to install NVM"
        log_info "Please install NVM manually: https://github.com/nvm-sh/nvm#install--update-script"
        exit 1
    fi

    # Configure shell profile
    local PROFILE_FILE
    PROFILE_FILE=$(get_shell_profile)

    # Fish shell returns empty string from get_shell_profile because export/source
    # syntax is incompatible with fish. Skip automatic profile writes for fish users.
    if [[ -z "${PROFILE_FILE}" ]]; then
        log_warning "Fish shell detected: automatic shell profile configuration is not supported."
        log_info "Please add NVM configuration manually. See: https://github.com/nvm-sh/nvm#fish"
    # Check if profile file is writable
    elif [[ -f "${PROFILE_FILE}" ]] && [[ ! -w "${PROFILE_FILE}" ]]; then
        log_warning "Cannot write to ${PROFILE_FILE} (permission denied)"
        log_info "Skipping shell profile configuration"
        log_info "You may need to manually add NVM configuration to your shell profile"
    elif ! grep -q 'NVM_DIR' "${PROFILE_FILE}" 2>/dev/null; then
        # shellcheck disable=SC2016
        # The following echo statements intentionally use single quotes to write literal strings
        {
            echo ""
            echo "# NVM configuration (added by Qwen Code installer)"
            echo "export NVM_DIR=\"\$HOME/.nvm\""
            echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"'
            echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"'
        } >> "${PROFILE_FILE}" 2>/dev/null || {
            log_warning "Failed to write to ${PROFILE_FILE}"
            log_info "Skipping shell profile configuration"
            return 0
        }
        log_info "Added NVM config to ${PROFILE_FILE}"
    fi

    # Load NVM for current session
    export NVM_DIR="${NVM_DIR}"
    # shellcheck source=/dev/null
    [[ -s "${NVM_DIR}/nvm.sh" ]] && \. "${NVM_DIR}/nvm.sh"

    log_success "NVM configured successfully"
    return 0
}

# ============================================
# Install Node.js via NVM
# ============================================
install_nodejs_with_nvm() {
    local NODE_VERSION="${NODE_VERSION:-20}"
    local NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"

    # Ensure NVM is loaded
    export NVM_DIR="${NVM_DIR}"
    # shellcheck source=/dev/null
    [[ -s "${NVM_DIR}/nvm.sh" ]] && \. "${NVM_DIR}/nvm.sh"

    if ! command_exists nvm; then
        log_error "NVM not loaded properly"
        return 1
    fi

    # Set Node.js mirror source for faster downloads in China
    export NVM_NODEJS_ORG_MIRROR="https://npmmirror.com/mirrors/node"

    # Install Node.js
    log_info "Installing Node.js v${NODE_VERSION}..."
    if nvm install "${NODE_VERSION}"; then
        nvm alias default "${NODE_VERSION}" || true
        nvm use default || true
        log_success "Node.js v${NODE_VERSION} installed successfully"

        # Verify installation
        log_info "Node.js version: $(node -v)" || true
        log_info "npm version: $(npm -v)" || true

        return 0
    else
        log_error "Failed to install Node.js"
        return 1
    fi
}

# ============================================
# Check Node.js version
# ============================================
check_node_version() {
    if ! command_exists node; then
        return 1
    fi

    local current_version
    current_version=$(node -v | sed 's/v//')
    local major_version
    major_version=$(echo "${current_version}" | cut -d. -f1 | sed 's/[^0-9]//g')

    # Handle cases where major_version is empty or non-numeric
    if [[ -z "${major_version}" ]]; then
        log_warning "Unable to determine Node.js version from: $(node -v)"
        return 1
    fi

    if [[ "${major_version}" -ge 20 ]]; then
        log_success "Node.js v${current_version} is already installed (>= 20)"
        return 0
    else
        log_warning "Node.js v${current_version} is installed but version < 20"
        return 1
    fi
}

# ============================================
# Install Node.js
# ============================================
install_nodejs() {
    local platform
    platform=$(uname -s)

    case "${platform}" in
        Linux|Darwin)
            log_info "Installing Node.js on ${platform}..."

            # Install NVM
            if ! install_nvm; then
                log_error "Failed to install NVM"
                return 1
            fi

            # Load NVM
            export NVM_DIR="${HOME}/.nvm"
            # shellcheck source=/dev/null
            [[ -s "${NVM_DIR}/nvm.sh" ]] && \. "${NVM_DIR}/nvm.sh"

            # Install Node.js
            if ! install_nodejs_with_nvm; then
                log_error "Failed to install Node.js"
                return 1
            fi
            ;;
        MINGW*|CYGWIN*|MSYS*)
            log_error "Windows platform detected. Please use Windows installer or WSL."
            log_info "Visit: https://nodejs.org/en/download/"
            exit 1
            ;;
        *)
            log_error "Unsupported platform: ${platform}"
            exit 1
            ;;
    esac
}

# ============================================
# Check and install Node.js
# ============================================
check_and_install_nodejs() {
    if check_node_version; then
        log_info "Using existing Node.js installation"
        clean_npmrc_conflict
    else
        log_warning "Installing or upgrading Node.js..."
        install_nodejs
    fi
}

# ============================================
# Fix npm permissions (without using sudo)
# ============================================
fix_npm_permissions() {
    log_info "Checking npm permissions..."

    local NPM_GLOBAL_DIR
    NPM_GLOBAL_DIR=$(npm config get prefix 2>/dev/null) || true

    # Determine whether we need to fall back to ~/.npm-global:
    # 1. prefix is empty or contains an error string
    # 2. prefix is a system directory (would break sudo setuid binaries)
    # 3. prefix directory is not writable
    local use_user_dir=false

    if [[ -z "${NPM_GLOBAL_DIR}" ]] || [[ "${NPM_GLOBAL_DIR}" == *"error"* ]]; then
        log_info "npm prefix is unset or invalid, switching to user directory"
        use_user_dir=true
    else
        # SAFETY CHECK: Never use system directories
        case "${NPM_GLOBAL_DIR}" in
            /|/usr|/usr/local|/bin|/sbin|/lib|/lib64|/opt|/snap|/var|/etc)
                log_warning "npm prefix is a system directory (${NPM_GLOBAL_DIR}), switching to user directory to avoid breaking system binaries."
                use_user_dir=true
                ;;
            "${HOME}"/*)
                # User has configured a prefix under HOME — respect it
                log_info "User-configured npm prefix (${NPM_GLOBAL_DIR}) is under HOME, keeping it"
                ;;
        esac
    fi

    if [[ "${use_user_dir}" == false ]] && [[ ! -w "${NPM_GLOBAL_DIR}" ]]; then
        log_warning "npm global directory is not writable: ${NPM_GLOBAL_DIR}, switching to user directory."
        use_user_dir=true
    fi

    if [[ "${use_user_dir}" == true ]]; then
        NPM_GLOBAL_DIR="${HOME}/.npm-global"
        # Create the directory before setting prefix so npm config set succeeds
        mkdir -p "${NPM_GLOBAL_DIR}"
        npm config set prefix "${NPM_GLOBAL_DIR}"
        log_success "npm prefix set to: ${NPM_GLOBAL_DIR}"

        # Only add ~/.npm-global/bin to PATH when we actually use it
        local PROFILE_FILE
        PROFILE_FILE=$(get_shell_profile)
        if [[ -n "${PROFILE_FILE}" ]] && ! grep -q '.npm-global/bin' "${PROFILE_FILE}" 2>/dev/null; then
            {
                echo ""
                echo "# NPM global bin (added by Qwen Code installer)"
                echo "export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
            } >> "${PROFILE_FILE}" 2>/dev/null || log_warning "Failed to write PATH update to ${PROFILE_FILE}"
            log_info "Added npm global bin to PATH in ${PROFILE_FILE}"
        fi
    else
        log_info "npm global directory is writable: ${NPM_GLOBAL_DIR}"
    fi

    return 0
}

# ============================================
# Clean old qwen installations from known paths
# ============================================
clean_old_qwen_installations() {
    # Use the npm prefix where we're about to install as the target
    local target_prefix
    target_prefix=$(npm config get prefix 2>/dev/null) || true

    if [[ -z "${target_prefix}" ]]; then
        log_warning "Cannot determine npm prefix, skipping old installation cleanup"
        return 0
    fi

    local qwen_found=false

    # Check all known npm global prefixes for old qwen installations
    local known_prefixes=("${HOME}/.npm-global" "${HOME}/.nvm/versions" "/usr/local")
    for prefix in "${known_prefixes[@]}"; do
        # Skip the target prefix (that's where we're installing)
        [[ "${prefix}" == "${target_prefix}" ]] && continue

        # For nvm, the path includes the node version subdirectory
        if [[ "${prefix}" == *".nvm/versions" ]]; then
            for node_dir in "${prefix}"/v*/bin/qwen; do
                if [[ -f "${node_dir}" ]]; then
                    local node_prefix
                    node_prefix=$(dirname "$(dirname "${node_dir}")")
                    log_warning "Removing old qwen from nvm: ${node_dir}"
                    npm uninstall -g @qwen-code/qwen-code --prefix "${node_prefix}" 2>/dev/null || true
                    qwen_found=true
                fi
            done
        elif [[ -f "${prefix}/bin/qwen" ]]; then
            log_warning "Removing old qwen from ${prefix}/bin/qwen"
            npm uninstall -g @qwen-code/qwen-code --prefix "${prefix}" 2>/dev/null || true
            qwen_found=true
        fi
    done

    if [[ "${qwen_found}" == true ]]; then
        log_success "Old qwen installations cleaned"
    fi
}

install_qwen_code() {
    # Ensure NVM node is in PATH
    export NVM_DIR="${HOME}/.nvm"
    # shellcheck source=/dev/null
    [[ -s "${NVM_DIR}/nvm.sh" ]] && \. "${NVM_DIR}/nvm.sh" 2>/dev/null || true

    # Check current installation status (before any prefix changes)
    if command_exists qwen; then
        local QWEN_VERSION
        QWEN_VERSION=$(qwen --version 2>/dev/null || echo "unknown")
        log_success "Qwen Code is already installed: ${QWEN_VERSION}"
        log_info "Upgrading to the latest version..."
    fi

    # Clean npmrc conflicts
    clean_npmrc_conflict

    # Fix npm permissions if needed (may change prefix to ~/.npm-global)
    fix_npm_permissions

    # Set PATH with the correct npm global bin AFTER fixing permissions,
    # before cleaning old installations so target_prefix detection works
    local NPM_GLOBAL_BIN
    NPM_GLOBAL_BIN=$(npm config get prefix 2>/dev/null)/bin
    if [[ -n "${NPM_GLOBAL_BIN}" ]]; then
        export PATH="${NPM_GLOBAL_BIN}:${PATH}"
    fi

    # Clean old qwen installations from other npm prefixes
    clean_old_qwen_installations

    # Install Qwen Code
    log_info "Installing Qwen Code..."
    if npm install -g @qwen-code/qwen-code@latest --registry https://registry.npmmirror.com; then
        log_success "Qwen Code installed successfully!"

        # Verify installation using the correct PATH
        local qwen_path
        qwen_path=$(command -v qwen 2>/dev/null)
        if [[ -n "${qwen_path}" ]]; then
            local qwen_version
            qwen_version=$("${qwen_path}" --version 2>/dev/null) || qwen_version="unknown"
            log_info "Qwen Code version: ${qwen_version} (${qwen_path})"
        fi
    else
        log_error "Failed to install Qwen Code!"
        log_info "Please check your internet connection and try again"
        exit 1
    fi

    # Create source.json if source parameter was provided
    if [[ "${SOURCE}" != "unknown" ]]; then
        create_source_json
    fi
}

# ============================================
# Create source.json
# ============================================
create_source_json() {
    local QWEN_DIR="${HOME}/.qwen"

    mkdir -p "${QWEN_DIR}"

    # Escape special characters in SOURCE for JSON
    local ESCAPED_SOURCE
    ESCAPED_SOURCE=$(printf '%s' "${SOURCE}" | sed 's/\\/\\\\/g; s/"/\\"/g')

    cat > "${QWEN_DIR}/source.json" <<EOF
{
  "source": "${ESCAPED_SOURCE}"
}
EOF

    log_success "Installation source saved to ~/.qwen/source.json"
}

# ============================================
# Main function
# ============================================
main() {
    # Validate HOME variable
    if [[ -z "${HOME}" ]]; then
        log_warning "HOME environment variable is not set"
        local MAIN_UID
        MAIN_UID=$(id -u) || true
        if [[ "${MAIN_UID}" -eq 0 ]]; then
            export HOME="/root"
        else
            local CURRENT_USER
            CURRENT_USER=$(whoami) || true
            local user_home
            user_home=$(eval echo "~${CURRENT_USER}") || true
            export HOME="${user_home}"
        fi
        log_info "Using HOME=${HOME}"
    fi

    # Ensure download tool is available
    ensure_download_tool

    # Check and install Node.js
    check_and_install_nodejs
    echo ""

    # Install Qwen Code
    install_qwen_code
    echo ""

    # ============================================
    # Final instructions
    # ============================================
    echo "=========================================="
    echo "✅ Installation completed!"
    echo "=========================================="
    echo ""

    # Ensure NVM and npm global bin are in PATH (use current prefix)
    export NVM_DIR="${HOME}/.nvm"
    # shellcheck source=/dev/null
    [[ -s "${NVM_DIR}/nvm.sh" ]] && \. "${NVM_DIR}/nvm.sh" 2>/dev/null || true
    local NPM_GLOBAL_BIN
    NPM_GLOBAL_BIN=$(npm config get prefix 2>/dev/null)/bin
    # Remove any stale nvm qwen paths from PATH before prepending the correct one
    local clean_path=""
    IFS=':' read -ra path_parts <<< "${PATH}"
    for p in "${path_parts[@]}"; do
        if [[ "${p}" != *".nvm/"*"/bin"* ]] || [[ ! -f "${p}/qwen" ]]; then
            clean_path="${clean_path:+${clean_path}:}${p}"
        fi
    done
    export PATH="${clean_path}"
    if [[ -n "${NPM_GLOBAL_BIN}" ]]; then
        export PATH="${NPM_GLOBAL_BIN}:${PATH}"
    fi

    # Check if qwen is immediately available
    if command_exists qwen; then
        log_success "Qwen Code is ready to use!"
        echo ""
        echo "You can now run: qwen"
        echo ""
        # Auto-start qwen
        log_info "Starting Qwen Code..."
        echo ""
        exec qwen
    else
        log_warning "Qwen Code command not found in current session"
        echo ""
        echo "To use Qwen Code immediately without restarting your terminal,"
        echo "run the following command in your current shell:"
        echo "  eval \$(${0} --print-env)"
        echo ""
        log_info "Or simply restart your terminal, then run: qwen"
    fi
}

# Run main function
main "$@"
