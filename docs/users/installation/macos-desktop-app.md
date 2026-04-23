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

The app will:
1. Open the Terminal application
2. Automatically run the `qwen` command
3. Bring Terminal to the foreground

## Uninstall

To remove the desktop app:

```bash
rm -rf "/Applications/Qwen Code.app"
```

## Troubleshooting

### Icon not showing after installation

macOS caches application icons. To force a refresh:

1. Log out and log back in, OR
2. Run these commands:

```bash
rm ~/Library/Application\ Support/Dock/*.db 2>/dev/null
killall Dock
killall Finder
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
