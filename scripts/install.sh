#!/bin/bash

set -e

# Define color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Define log functions
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

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check if it's a development machine environment
is_dev_machine() {
    # Check if development machine specific directories or files exist
    if [ -d "/apsara" ] || [ -d "/home/admin" ] || [ -f "/etc/redhat-release" ]; then
        return 0
    fi
    return 1
}

# Check if running in WSL
is_wsl() {
    if [ -f /proc/version ] && grep -qi microsoft /proc/version; then
        return 0
    fi
    if [ -n "$WSL_DISTRO_NAME" ] || [ -n "$WSL_INTEROP" ]; then
        return 0
    fi
    return 1
}

# Get Windows npm prefix (for Git Bash/Cygwin/MSYS)
get_windows_npm_prefix() {
    # Try to get npm prefix
    local npm_prefix=$(npm config get prefix 2>/dev/null || echo "")
    
    if [ -n "$npm_prefix" ]; then
        echo "$npm_prefix"
        return 0
    fi
    
    # Try common Windows npm locations
    if [ -n "$APPDATA" ]; then
        echo "$APPDATA/npm"
        return 0
    fi
    
    # Try Program Files
    if [ -d "/c/Program Files/nodejs" ]; then
        echo "/c/Program Files/nodejs"
        return 0
    fi
    
    # Fallback
    echo "$HOME/.npm-global"
}

# Get shell configuration file
get_shell_profile() {
    local current_shell=$(basename "$SHELL")
    case "$current_shell" in
        bash)
            echo "$HOME/.bashrc"
            ;;
        zsh)
            echo "$HOME/.zshrc"
            ;;
        fish)
            echo "$HOME/.config/fish/config.fish"
            ;;
        *)
            echo "$HOME/.profile"
            ;;
    esac
}

# Clean npm configuration conflicts
clean_npmrc_conflict() {
    local npmrc="$HOME/.npmrc"
    if [[ -f "$npmrc" ]]; then
        log_info "Cleaning npmrc conflicts..."
        grep -Ev '^(prefix|globalconfig) *= *' "$npmrc" > "${npmrc}.tmp" && mv -f "${npmrc}.tmp" "$npmrc" || true
    fi
}

# Install nvm
install_nvm() {
    local NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    local NVM_VERSION="${NVM_VERSION:-v0.40.3}"
    
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        log_info "nvm is already installed at $NVM_DIR"
        return 0
    fi
    
    log_info "Installing nvm ${NVM_VERSION}..."
    
    # Install nvm using official installer
    if curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh | bash; then
        log_success "nvm installed successfully"
        
        # Load nvm for current session
        export NVM_DIR="${NVM_DIR}"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        
        return 0
    else
        log_error "Failed to install nvm"
        return 1
    fi
}

# Install Node.js
install_nodejs_with_nvm() {
    local NODE_VERSION="${NODE_VERSION:-22}"
    local NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    
    # Ensure nvm is loaded
    export NVM_DIR="${NVM_DIR}"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    
    if ! command_exists nvm; then
        log_error "nvm not loaded properly"
        return 1
    fi
    
    # Check if xz needs to be installed
    if ! command_exists xz; then
        log_warning "xz not found, trying to install xz-utils..."
        if command_exists yum; then
            sudo yum install -y xz || log_warning "Failed to install xz, continuing anyway..."
        elif command_exists apt-get; then
            sudo apt-get update && sudo apt-get install -y xz-utils || log_warning "Failed to install xz, continuing anyway..."
        fi
    fi
    
    # Set Node.js mirror source (for domestic network)
    export NVM_NODEJS_ORG_MIRROR="https://npmmirror.com/mirrors/node"
    
    # Clear cache
    log_info "Clearing nvm cache..."
    nvm cache clear || true
    
    # Install Node.js
    log_info "Installing Node.js v${NODE_VERSION}..."
    if nvm install ${NODE_VERSION}; then
        nvm alias default ${NODE_VERSION}
        nvm use default
        log_success "Node.js v${NODE_VERSION} installed successfully"
        
        # Verify installation
        log_info "Node.js version: $(node -v)"
        log_info "npm version: $(npm -v)"
        
        # Clean npm configuration conflicts
        clean_npmrc_conflict
        
        # Configure npm mirror source
        npm config set registry https://registry.npmmirror.com
        log_info "npm registry set to npmmirror"
        
        return 0
    else
        log_error "Failed to install Node.js"
        return 1
    fi
}

# Check Node.js version
check_node_version() {
    if ! command_exists node; then
        return 1
    fi
    
    local current_version=$(node -v | sed 's/v//')
    local major_version=$(echo $current_version | cut -d. -f1)
    
    if [ "$major_version" -ge 20 ]; then
        log_success "Node.js v$current_version is already installed (>= 20)"
        return 0
    else
        log_warning "Node.js v$current_version is installed but version < 20"
        return 1
    fi
}

# Install Node.js
install_nodejs() {
    local platform=$(uname -s)
    
    # Check if running in WSL (treat as Linux)
    if is_wsl; then
        log_info "WSL environment detected, treating as Linux..."
        platform="Linux"
    fi
    
    case "$platform" in
        Linux|Darwin)
            log_info "Installing Node.js on $platform..."
            
            # Install nvm
            if ! install_nvm; then
                log_error "Failed to install nvm"
                return 1
            fi
            
            # Load nvm
            export NVM_DIR="${HOME}/.nvm"
            [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
            
            # Install Node.js
            if ! install_nodejs_with_nvm; then
                log_error "Failed to install Node.js"
                return 1
            fi
            
            ;;
        MINGW*|CYGWIN*|MSYS*)
            log_warning "Windows platform detected (Git Bash/Cygwin/MSYS)"
            log_info "For Windows, we recommend:"
            log_info "  1. Install Node.js from https://nodejs.org/en/download/ (recommended)"
            log_info "  2. Or use WSL (Windows Subsystem for Linux)"
            log_info ""
            
            # Check if Node.js is already installed
            if command_exists node; then
                local node_version=$(node -v)
                log_info "Node.js $node_version is already installed"
                if check_node_version; then
                    log_success "Node.js version is compatible (>= 20)"
                    return 0
                else
                    log_warning "Node.js version is too old. Please upgrade from https://nodejs.org/en/download/"
                    return 1
                fi
            else
                log_error "Node.js is not installed. Please install it from https://nodejs.org/en/download/"
                log_info "After installing Node.js, you can run this script again to install Qwen Code."
                exit 1
            fi
            ;;
        *)
            log_error "Unsupported platform: $platform"
            exit 1
            ;;
    esac
}

# Check and update Node.js
check_and_install_nodejs() {
    if check_node_version; then
        log_info "Using existing Node.js installation"
        clean_npmrc_conflict
    else
        log_warning "Installing or upgrading Node.js..."
        install_nodejs
    fi
}

# Uninstall existing Qwen Code
uninstall_existing_qwen_code() {
    local platform=$(uname -s)
    
    # Check if running in WSL
    if is_wsl; then
        platform="Linux"
    fi
    
    # Check if package is installed (even if command doesn't exist)
    local npm_prefix=$(npm config get prefix 2>/dev/null || echo "")
    local node_modules_dir=""
    
    if [ -n "$npm_prefix" ]; then
        # Handle Windows paths
        case "$platform" in
            MINGW*|CYGWIN*|MSYS*)
                # Windows: npm prefix might be like C:\Users\... or /c/Users/...
                node_modules_dir="$npm_prefix/node_modules/@qwen-code/qwen-code"
                ;;
            *)
                # Unix-like: standard location
                node_modules_dir="$npm_prefix/lib/node_modules/@qwen-code/qwen-code"
                ;;
        esac
    else
        # Try common locations
        case "$platform" in
            MINGW*|CYGWIN*|MSYS*)
                # Windows locations
                local win_prefix=$(get_windows_npm_prefix)
                node_modules_dir="$win_prefix/node_modules/@qwen-code/qwen-code"
                ;;
            *)
                # Unix-like locations
                if [ -d "$HOME/.nvm" ]; then
                    # Find node version directory
                    local node_version=$(node -v 2>/dev/null | sed 's/v//' || echo "")
                    if [ -n "$node_version" ]; then
                        node_modules_dir="$HOME/.nvm/versions/node/v${node_version}/lib/node_modules/@qwen-code/qwen-code"
                    fi
                fi
                if [ -z "$node_modules_dir" ] || [ ! -d "$node_modules_dir" ]; then
                    node_modules_dir="/usr/local/lib/node_modules/@qwen-code/qwen-code"
                fi
                ;;
        esac
    fi
    
    if command_exists qwen || [ -d "$node_modules_dir" ]; then
        log_warning "Existing Qwen Code installation detected"
        
        # Try to get current version
        local current_version=$(qwen --version 2>/dev/null || echo "unknown")
        if [ "$current_version" != "unknown" ]; then
            log_info "Current version: $current_version"
        fi
        
        log_info "Uninstalling existing Qwen Code..."
        
        # Try npm uninstall first
        if npm uninstall -g @qwen-code/qwen-code 2>/dev/null; then
            log_success "Successfully uninstalled existing Qwen Code via npm"
        else
            log_warning "npm uninstall failed or returned non-zero, trying manual removal..."
        fi
        
        # Always try to manually remove the module directory and binaries
        case "$platform" in
            MINGW*|CYGWIN*|MSYS*)
                # Windows platform (Git Bash/Cygwin/MSYS)
                local win_npm_prefix=$(get_windows_npm_prefix)
                
                # Windows binary locations
                local common_paths=()
                
                # Try npm prefix locations
                if [ -n "$win_npm_prefix" ]; then
                    common_paths+=(
                        "$win_npm_prefix/qwen"
                        "$win_npm_prefix/qwen.cmd"
                        "$win_npm_prefix/qwen.ps1"
                    )
                fi
                
                # Try APPDATA if available
                if [ -n "$APPDATA" ]; then
                    common_paths+=(
                        "$APPDATA/npm/qwen"
                        "$APPDATA/npm/qwen.cmd"
                        "$APPDATA/npm/qwen.ps1"
                    )
                fi
                
                # Try Program Files
                if [ -d "/c/Program Files/nodejs" ]; then
                    common_paths+=(
                        "/c/Program Files/nodejs/qwen"
                        "/c/Program Files/nodejs/qwen.cmd"
                    )
                fi
                
                # Remove binaries
                for bin_path in "${common_paths[@]}"; do
                    if [ -f "$bin_path" ] || [ -L "$bin_path" ]; then
                        rm -f "$bin_path" 2>/dev/null && log_info "Removed $bin_path" || log_warning "Could not remove $bin_path"
                    fi
                done
                ;;
            *)
                # Unix-like platforms (Linux/macOS/WSL)
                local unix_npm_prefix=$(npm config get prefix 2>/dev/null || echo "$HOME/.npm-global")
                local bin_path="$unix_npm_prefix/bin/qwen"
                
                # Remove qwen binary if exists
                if [ -f "$bin_path" ] || [ -L "$bin_path" ]; then
                    rm -f "$bin_path" && log_info "Removed $bin_path"
                fi
                
                # Remove from common Unix locations
                local common_paths=(
                    "/usr/local/bin/qwen"
                    "$HOME/.npm-global/bin/qwen"
                    "$HOME/.local/bin/qwen"
                )
                
                for path in "${common_paths[@]}"; do
                    if [ -f "$path" ] || [ -L "$path" ]; then
                        rm -f "$path" && log_info "Removed $path"
                    fi
                done
                ;;
        esac
        
        for path in "${common_paths[@]}"; do
            if [ -f "$path" ]; then
                rm -f "$path" && log_info "Removed $path"
            fi
        done
        
        # Remove the npm module directory if it exists
        if [ -n "$node_modules_dir" ] && [ -d "$node_modules_dir" ]; then
            log_info "Removing module directory: $node_modules_dir"
            rm -rf "$node_modules_dir" 2>/dev/null && log_info "Removed module directory" || log_warning "Could not remove module directory (may require sudo)"
        fi
        
        # Also try to find and remove from nvm directories
        if [ -d "$HOME/.nvm" ]; then
            for nvm_node_dir in "$HOME/.nvm/versions/node"/*/lib/node_modules/@qwen-code/qwen-code; do
                if [ -d "$nvm_node_dir" ]; then
                    log_info "Removing nvm module directory: $nvm_node_dir"
                    rm -rf "$nvm_node_dir" 2>/dev/null && log_info "Removed nvm module directory" || log_warning "Could not remove nvm module directory"
                fi
            done
        fi
        
        # Verify uninstallation
        if command_exists qwen; then
            log_warning "Qwen Code command still exists after uninstall attempt. Attempting to locate and remove it..."
            
            # Find the qwen executable
            local qwen_path=$(which qwen 2>/dev/null)
            if [ -n "$qwen_path" ] && [ -f "$qwen_path" ]; then
                log_info "Found qwen executable at: $qwen_path"
                if rm -f "$qwen_path"; then
                    log_success "Successfully removed qwen executable: $qwen_path"
                else
                    log_error "Failed to remove qwen executable: $qwen_path (may require sudo)"
                fi
            else
                log_warning "Could not locate qwen executable path"
            fi
        fi
        
        # Final check
        if command_exists qwen; then
            log_warning "Qwen Code command still exists. You may need to reload your shell."
        else
            log_success "Successfully removed existing Qwen Code"
        fi
    fi
}

# Install Qwen Code
install_qwen_code() {
    # Uninstall existing installation first
    uninstall_existing_qwen_code
    
    # Additional cleanup: ensure module directory is completely removed
    local platform=$(uname -s)
    if is_wsl; then
        platform="Linux"
    fi
    
    local npm_prefix=$(npm config get prefix 2>/dev/null || echo "")
    local module_dir=""
    
    if [ -n "$npm_prefix" ]; then
        case "$platform" in
            MINGW*|CYGWIN*|MSYS*)
                module_dir="$npm_prefix/node_modules/@qwen-code/qwen-code"
                ;;
            *)
                module_dir="$npm_prefix/lib/node_modules/@qwen-code/qwen-code"
                ;;
        esac
    else
        # Try to find node version directory
        case "$platform" in
            MINGW*|CYGWIN*|MSYS*)
                local win_prefix=$(get_windows_npm_prefix)
                module_dir="$win_prefix/node_modules/@qwen-code/qwen-code"
                ;;
            *)
                if [ -d "$HOME/.nvm" ]; then
                    local node_version=$(node -v 2>/dev/null | sed 's/v//' || echo "")
                    if [ -n "$node_version" ]; then
                        module_dir="$HOME/.nvm/versions/node/v${node_version}/lib/node_modules/@qwen-code/qwen-code"
                    fi
                fi
                ;;
        esac
    fi
    
    # Force remove module directory if it still exists
    if [ -n "$module_dir" ] && [ -d "$module_dir" ]; then
        log_warning "Module directory still exists, forcing removal..."
        rm -rf "$module_dir" 2>/dev/null || {
            log_warning "Could not remove module directory. Trying with npm cache clean..."
            npm cache clean --force 2>/dev/null || true
        }
    fi
    
    # Small delay to ensure filesystem operations complete
    sleep 1
    
    log_info "Installing Qwen Code..."
    
    # Install Qwen Code with force flag to handle any conflicts
    if npm i -g @qwen-code/qwen-code@latest --force; then
        log_success "Qwen Code installed successfully!"
        
        # Verify installation
        if command_exists qwen; then
            log_info "Qwen Code version: $(qwen --version 2>/dev/null || echo 'version info not available')"
        else
            log_warning "Qwen Code installed but command not found. You may need to reload your shell or add npm global bin to PATH."
            log_info "Try running: export PATH=\"\$PATH:$(npm config get prefix)/bin\""
        fi
    else
        log_error "Failed to install Qwen Code!"
        log_info "You may need to manually remove the old installation:"
        if [ -n "$module_dir" ]; then
            log_info "  rm -rf $module_dir"
        fi
        exit 1
    fi
}

# Main function
main() {
    echo "=========================================="
    echo "   Qwen Code Installation Script"
    echo "   One-Click Installation for Everyone"
    echo "=========================================="
    echo ""
    
    # Check system
    local platform=$(uname -s)
    log_info "System: $platform $(uname -r)"
    log_info "Shell: $(basename "$SHELL")"
    
    if is_wsl; then
        log_info "WSL (Windows Subsystem for Linux) detected"
    fi
    
    if is_dev_machine; then
        log_info "Development machine environment detected"
    fi
    
    # Windows-specific guidance
    case "$platform" in
        MINGW*|CYGWIN*|MSYS*)
            log_info ""
            log_info "Note: You're running this script in Git Bash/Cygwin/MSYS"
            log_info "Make sure Node.js is installed and accessible from this environment"
            log_info ""
            ;;
    esac
    
    # Check and install Node.js
    check_and_install_nodejs
    
    # Ensure npm command is available
    if ! command_exists npm; then
        log_error "npm command not found after Node.js installation!"
        log_info "Please run: source $(get_shell_profile)"
        exit 1
    fi
    
    # Install Qwen Code
    install_qwen_code
    
    echo ""
    echo "=========================================="
    log_success "Installation completed successfully!"
    echo "=========================================="
    echo ""
    
    log_info "To start using Qwen Code, run:"
    local current_shell=$(basename "$SHELL")
    case "$current_shell" in
        bash)
            echo "  source ~/.bashrc"
            ;;
        zsh) 
            echo "  source ~/.zshrc"
            ;;
        fish)
            echo "  source ~/.config/fish/config.fish"
            ;;
        *)
            echo "  source ~/.profile  # or reload your shell"
            ;;
    esac
    echo "  qwen"
    echo ""
    
    # Try to run Qwen Code
    if command_exists qwen; then
        log_info "Qwen Code is ready to use!"
        log_info "Run 'qwen' to start, or visit https://github.com/QwenLM/qwen-code for more information."
    else
        log_info "Please reload your shell and run 'qwen' command."
    fi
}
 
# Error handling
trap 'log_error "An error occurred. Installation aborted."; exit 1' ERR
 
# Run main function
main
