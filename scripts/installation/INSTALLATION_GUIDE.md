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
./install-qwen-with-source.sh --source github

# Install with internal source
./install-qwen-with-source.sh -s internal

# Show help
./install-qwen-with-source.sh --help
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

#### Prerequisites:

- curl (for NVM installation and script download)
- bash-compatible shell

## Windows Installation

### Script: install-qwen-with-source.bat

#### Features:

- Checks for existing Node.js installation and version
- Installs Node.js 20+ if needed using NVM for Windows
- Installs Qwen Code globally with source information
- Stores the source information in `%USERPROFILE%\.qwen\source.json`

#### Usage:

```cmd
REM Install with a specific source using --source parameter
install-qwen-with-source.bat --source github

REM Install with short parameter
install-qwen-with-source.bat -s internal

REM Use default source (unknown)
install-qwen-with-source.bat
```

#### Supported Source Values:

- `github` - Installed from GitHub repository
- `npm` - Installed from npm registry
- `internal` - Internal installation
- `local-build` - Local build installation

#### How it Works:

1. The script accepts a `--source` or `-s` parameter to specify where Qwen Code is being installed from
2. It installs Node.js if needed
3. It installs Qwen Code globally
4. It creates `%USERPROFILE%\.qwen\source.json` with the specified source information

#### Prerequisites:

- Windows Command Prompt (cmd.exe)
- NVM for Windows (if Node.js is not installed)

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

After installation, you can verify the source information:

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
# Make script executable
chmod +x install-qwen-with-source.sh

# Run with bash explicitly
bash install-qwen-with-source.sh --source github
```

**Windows:**

```cmd
# Run the script with --source parameter
install-qwen-with-source.bat --source github

# Or with short parameter
install-qwen-with-source.bat -s github

# Or from PowerShell
.\install-qwen-with-source.bat --source github
```

### Node.js Installation Issues

**Linux/macOS:**

- Ensure NVM is installed: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash`
- Restart your terminal or run: `source ~/.bashrc`

**Windows:**

- Install NVM for Windows from: https://github.com/coreybutler/nvm-windows/releases
- After installation, run the script again

### Permission Issues

You may need administrative privileges for global npm installation:

- **Linux/macOS**: Use `sudo` with npm
- **Windows**: Run PowerShell as Administrator

## Notes

- The scripts require internet access to download Node.js and Qwen Code
- Administrative privileges may be required for global npm installation
- The installation source is stored locally and used for tracking purposes only
- If the source file is missing or invalid, the application continues to work normally
