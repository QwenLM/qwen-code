# Installation Guide for Qwen Code with Source Tracking

This guide describes how to install Node.js and Qwen Code with source information tracking.

## Overview

The installation scripts automate the process of installing Node.js (if not present or below version 20) and Qwen Code, while capturing and storing the installation source information for analytics and tracking purposes.

## Installation Scripts

We provide platform-specific installation scripts:

- **Linux/macOS**: `install-qwen-with-source.sh`
- **Windows**: `install-qwen-with-source.bat`

## Linux/macOS Installation

### Script: install-qwen-with-source.sh

#### Features:

- Checks for existing Node.js installation and version
- Installs Node.js 20+ if needed using NVM
- Installs Qwen Code globally with source information
- Stores the source information in `~/.qwen/source.json`

#### Usage:

```bash
# Install with a specific source
sh install-qwen-with-source.sh --source github

# Install with internal source
sh install-qwen-with-source.sh -s internal

# Show help
sh install-qwen-with-source.sh --help
```

#### Supported Source Values:

- `github` - Installed from GitHub repository
- `npm` - Installed from npm registry
- `internal` - Internal installation
- `local-build` - Local build installation

#### How it Works:

1. The script accepts a `--source` parameter to specify where Qwen Code is being installed from
2. It installs Node.js if needed
3. It installs Qwen Code globally
4. It creates `~/.qwen/source.json` with the specified source information

#### Important Notes:

⚠️ **After installation, you need to restart your terminal or run:**

```bash
source ~/.bashrc  # For bash users
# or
source ~/.zshrc   # For zsh users
```

This is required to load the newly installed Node.js and Qwen Code into your PATH.

#### Prerequisites:

- curl (for NVM installation and script download)
- bash-compatible shell

## Windows Installation

### Script: install-qwen-with-source.bat

#### Features:

- Checks for existing Node.js installation and version (requires version 18+)
- Automatically downloads and installs Node.js 24 LTS if not present or version is too low
- Installs Qwen Code globally with source information
- Stores the source information in `%USERPROFILE%\.qwen\source.json`

#### Prerequisites:

- **PowerShell (Administrator)**: The script must be run in PowerShell with Administrator privileges
- Internet connection for downloading Node.js and Qwen Code

#### Usage:

> ⚠️ **Important**: You must run PowerShell as Administrator to install Node.js and global npm packages.

**Step 1**: Open PowerShell as Administrator

- Right-click on PowerShell and select "Run as Administrator"
- Or press `Win + X` and select "Windows PowerShell (Admin)"

**Step 2**: Navigate to the script directory and run:

```powershell
# Install with a specific source using --source parameter
./install-qwen-with-source.bat --source github

# Install with short parameter
./install-qwen-with-source.bat -s internal

# Use default source (unknown)
./install-qwen-with-source.bat
```

#### Supported Source Values:

- `github` - Installed from GitHub repository
- `npm` - Installed from npm registry
- `internal` - Internal installation
- `local-build` - Local build installation

#### How it Works:

1. The script accepts a `--source` or `-s` parameter to specify where Qwen Code is being installed from
2. It checks if Node.js is already installed and if the version is 18 or higher
3. If Node.js is not installed or version is too low, it automatically downloads and installs Node.js 24 LTS
4. It installs Qwen Code globally using npm
5. It creates `%USERPROFILE%\.qwen\source.json` with the specified source information

#### Why Administrator Privileges are Required:

- Installing Node.js requires writing to `C:\Program Files\nodejs`
- Installing global npm packages requires elevated permissions
- Modifying system PATH environment variables requires Administrator access

## Installation Source Feature

### Overview

This feature implements the ability to capture and store the installation source of the Qwen Code package. The source information is used for analytics and tracking purposes.

### Storage Location

The installation source is stored in a separate file at:

- **Unix/Linux/macOS**: `~/.qwen/source.json`
- **Windows**: `%USERPROFILE%\.qwen\source.json` (equivalent to `C:\Users\{username}\.qwen\source.json`)

### File Format

The `source.json` file contains:

```json
{
  "source": "github"
}
```

### How the Source Information is Used

1. **Telemetry Tracking**: The source information is included in RUM (Real User Monitoring) telemetry logs
2. **Analytics**: Helps understand how users are discovering and installing Qwen Code
3. **Distribution Analysis**: Tracks which distribution channels are most popular

### Technical Implementation

- The source information is stored as a separate JSON file
- The `QwenLogger` class reads this file during telemetry initialization
- The source is included in the `app.channel` field of the RUM payload
- The implementation gracefully handles missing files, unknown values, and parsing errors

### Verification

After installation and restarting your terminal (or sourcing your shell configuration), you can verify the source information:

**Linux/macOS:**

```bash
cat ~/.qwen/source.json
```

**Windows:**

```cmd
type %USERPROFILE%\.qwen\source.json
```

## Manual Installation (Without Source Tracking)

If you prefer not to use the installation scripts or don't want source tracking:

### Prerequisites

```bash
# Node.js 20+
curl -qL https://www.npmjs.com/install.sh | sh
```

### NPM Installation

```bash
npm install -g @qwen-code/qwen-code@latest
```

### Homebrew (macOS, Linux)

```bash
brew install qwen-code
```

## Troubleshooting

### Script Execution Issues

**Linux/macOS:**

```bash
# Run with sh
sh install-qwen-with-source.sh --source github
```

**Windows (PowerShell as Administrator):**

```powershell
# Run the script with --source parameter
./install-qwen-with-source.bat --source github

# Or with short parameter
./install-qwen-with-source.bat -s github
```

### Node.js Installation Issues

**Linux/macOS:**

- Ensure NVM is installed: `curl -o- https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install_nvm.sh | bash`
- Restart your terminal or run: `source ~/.bashrc`

**Windows:**

- Install NVM for Windows from: https://github.com/coreybutler/nvm-windows/releases
- After installation, run the script again

### Permission Issues

You may need administrative privileges for global npm installation:

- **Linux/macOS**: Use `sudo` with npm
- **Windows**: Run PowerShell as Administrator (required for Node.js installation and global npm packages)

## Notes

- The scripts require internet access to download Node.js and Qwen Code
- Administrative privileges may be required for global npm installation
- The installation source is stored locally and used for tracking purposes only
- If the source file is missing or invalid, the application continues to work normally
