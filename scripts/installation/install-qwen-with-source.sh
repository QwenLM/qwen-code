#!/bin/bash

# Script to install Node.js and Qwen Code with source information
# This script handles the installation process and sets the installation source

set -e  # Exit on any error

echo "==========================================="
echo "Qwen Code Installation Script with Source Tracking"
echo "==========================================="

# Function to display usage
usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -s, --source SOURCE    Specify the installation source (e.g., github, npm, internal)"
    echo "  -h, --help             Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 --source github"
    echo "  $0 -s internal"
    exit 1
}

# Parse command line arguments
SOURCE="unknown"
while [[ $# -gt 0 ]]; do
    case $1 in
        -s|--source)
            SOURCE="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo "Unknown option: $1"
            usage
            ;;
    esac
done

echo "INFO: Installation source: $SOURCE"

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to install Node.js
install_nodejs() {
    echo "INFO: Checking for Node.js installation..."

    if command_exists node; then
        NODE_VERSION=$(node --version)
        echo "INFO: Node.js is already installed: $NODE_VERSION"

        # Check if version is sufficient (>= 20.0.0)
        if [[ $(node -pe "require('semver').gte(require('semver').coerce('$NODE_VERSION'), '20.0.0')") == "true" ]]; then
            echo "INFO: Node.js version is sufficient."
        else
            echo "INFO: Node.js version is too low. Installing Node.js 20+..."
            install_nodejs_via_nvm
        fi
    else
        echo "INFO: Node.js not found. Installing Node.js 20+..."
        install_nodejs_via_nvm
    fi
}

# Function to install Node.js via nvm
install_nodejs_via_nvm() {
    echo "INFO: Installing Node Version Manager (NVM)..."

    # Install NVM if not already installed
    if [ ! -d "$HOME/.nvm" ]; then
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    else
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    fi

    # Install and use Node.js 20+
    nvm install 20
    nvm use 20
    echo "INFO: Node.js $(node --version) installed and activated via NVM."
}

# Function to install Qwen Code with source information
install_qwen_code() {
    echo "INFO: Installing Qwen Code with source: $SOURCE"

    # Install Qwen Code globally
    echo "INFO: Running: npm install -g @qwen-code/qwen-code"
    npm install -g @qwen-code/qwen-code

    echo "SUCCESS: Qwen Code installed successfully!"

    # After installation, create source.json in the .qwen directory
    echo "INFO: Creating source.json in ~/.qwen/"
    if [ ! -d "$HOME/.qwen" ]; then
        mkdir -p "$HOME/.qwen"
    fi

    # Create the source.json file with the installation source
    echo "{\"source\": \"$SOURCE\"}" > "$HOME/.qwen/source.json"
    echo "SUCCESS: Installation source saved to ~/.qwen/source.json"

    # Verify installation
    if command_exists qwen; then
        echo "SUCCESS: Qwen Code is available as 'qwen' command."
        qwen --version
    else
        echo "WARNING: Qwen Code may not be in PATH. Please check your npm global bin directory."
    fi
}

# Main execution
main() {
    echo "INFO: Starting installation process..."

    # Install Node.js
    install_nodejs

    # Install Qwen Code with source information
    install_qwen_code

    echo ""
    echo "==========================================="
    echo "SUCCESS: Installation completed!"
    echo "The source information is stored in ~/.qwen/source.json"
    echo ""
    echo "To verify the installation:"
    echo "  qwen --version"
    echo "  cat ~/.qwen/source.json"
    echo "==========================================="
}

# Run main function
main