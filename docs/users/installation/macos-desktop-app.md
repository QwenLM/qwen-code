---
title: macOS Desktop App
description: Install Qwen Code as a native macOS desktop application with Spotlight and Launchpad support.
---

# macOS Desktop App

You can install Qwen Code as a native macOS desktop application that opens Terminal and launches the Qwen CLI with a single click from Spotlight, Launchpad, or the Applications folder.

## Prerequisites

- macOS 12 or later
- Qwen Code CLI already installed (`brew install qwen-code` or via npm)

## Installation

### From Repository Clone

```bash
bash scripts/installation/install-qwen-macos-app.sh
```

### One-Click Install (No Clone Required)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/QwenLM/qwen-code/main/scripts/installation/install-qwen-macos-app.sh)"
```

### Manual Installation

1. **Create the AppleScript:**

```bash
cat > /tmp/QwenCode.applescript << 'EOF'
tell application "Terminal"
    activate
    do script "qwen"
end tell
EOF
```

2. **Compile to .app:**

```bash
osacompile -o "/Applications/Qwen Code.app" /tmp/QwenCode.applescript
```

If `/Applications` is not writable on your machine, install to your user Applications directory instead:

```bash
mkdir -p "$HOME/Applications"
osacompile -o "$HOME/Applications/Qwen Code.app" /tmp/QwenCode.applescript
```

3. **(Optional) Replace the icon:**

Download the official Qwen icon and convert it to ICNS format, then replace:

```bash
cp your-icon.icns "/Applications/Qwen Code.app/Contents/Resources/applet.icns"
```

## Usage

After installation, you can launch Qwen Code in three ways:

- **Spotlight:** Press `Cmd + Space`, type "Qwen Code", hit Enter
- **Launchpad:** Find the "Qwen Code" icon in Launchpad
- **Applications:** Open `/Applications/Qwen Code.app` directly

If `/Applications` is not writable, the installer falls back to `~/Applications` for new installs.
If `/Applications/Qwen Code.app` already exists but `/Applications` is not writable, the installer stops instead of creating a second app in `~/Applications`; remove or update the system app with administrator privileges first so Spotlight and Launchpad do not keep opening the stale app.

The app will:
1. Open the Terminal application
2. Automatically run the `qwen` command
3. Bring Terminal to the foreground

## Uninstall

To remove the desktop app:

```bash
rm -rf "/Applications/Qwen Code.app"
# or, if installed without admin write access:
rm -rf "$HOME/Applications/Qwen Code.app"
```

## Troubleshooting

### Icon not showing after installation

macOS caches application icons. If the icon does not appear immediately, wait a moment or restart Dock manually:

```bash
killall Dock
```

If you use the no-clone installer, the script downloads the icon from the Qwen Code repository at install time. If that download fails, installation still completes with the default AppleScript icon.

### Reinstall stops because an existing `/Applications` app is not writable

If `/Applications/Qwen Code.app` already exists and your user cannot write to `/Applications`, the installer stops instead of installing a second copy under `~/Applications`. This avoids Spotlight or Launchpad continuing to open the stale system app.

Remove or update the system app with administrator privileges, then rerun the installer:

```bash
sudo rm -rf "/Applications/Qwen Code.app"
bash scripts/installation/install-qwen-macos-app.sh
```

### "qwen: command not found" when opening the app

Make sure `qwen` is properly installed and in your PATH:

```bash
which qwen
```

If not found, install it first:

```bash
brew install qwen-code
```

### App opens but doesn't run qwen

The app runs the `qwen` command in your default Terminal. Make sure:
- Terminal.app is your default terminal emulator
- Your shell profile loads nvm/fnm if you installed qwen via npm

## Customization

You can modify the AppleScript to customize the behavior:

```applescript
tell application "Terminal"
    activate
    -- Run qwen with specific arguments
    do script "qwen --model qwen-plus"
end tell
```

Then recompile:

```bash
osacompile -o "/Applications/Qwen Code.app" /tmp/QwenCode.applescript
```
