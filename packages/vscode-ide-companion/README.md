# Qwen Code Companion

Seamlessly integrate [Qwen Code](https://github.com/QwenLM/qwen-code) into Visual Studio Code with native IDE features and an intuitive interface. This extension bundles everything you need to get started immediately.

## Demo

<video src="https://cloud.video.taobao.com/vod/IKKwfM-kqNI3OJjM_U8uMCSMAoeEcJhs6VNCQmZxUfk.mp4" controls width="800">
  Your browser does not support the video tag. You can open the video directly:
  https://cloud.video.taobao.com/vod/IKKwfM-kqNI3OJjM_U8uMCSMAoeEcJhs6VNCQmZxUfk.mp4
</video>

## Features

- **Native IDE experience**: Dedicated Qwen Code sidebar panel accessed via the Qwen icon
- **Native diffing**: Review, edit, and accept changes in VS Code's diff view
- **Auto-accept edits mode**: Automatically apply Qwen's changes as they're made
- **File management**: @-mention files or attach files and images using the system file picker
- **Conversation history & multiple sessions**: Access past conversations and run multiple sessions simultaneously
- **Open file & selection context**: Share active files, cursor position, and selections for more precise help

## Requirements

- Visual Studio Code 1.85.0 or newer

## Installation

1. Install from the VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=qwenlm.qwen-code-vscode-ide-companion

2. Two ways to use
   - Chat panel: Click the Qwen icon in the Activity Bar, or run `Qwen Code: Open` from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
   - Terminal session (classic): Run `Qwen Code: Run` to launch a session in the integrated terminal (bundled CLI).

## Development and Debugging

To debug and develop this extension locally:

1. **Clone the repository**

   ```bash
   git clone https://github.com/QwenLM/qwen-code.git
   cd qwen-code
   ```

2. **Install dependencies**

   ```bash
   npm install
   # or if using pnpm
   pnpm install
   ```

3. **Start debugging**

   ```bash
   code .  # Open the project root in VS Code
   ```
   - Open the `packages/vscode-ide-companion/src/extension.ts` file
   - Open Debug panel (`Ctrl+Shift+D` or `Cmd+Shift+D`)
   - Select **"Launch Companion VS Code Extension"** from the debug dropdown
   - Press `F5` to launch Extension Development Host

4. **Make changes and reload**
   - Edit the source code in the original VS Code window
   - To see your changes, reload the Extension Development Host window by:
     - Pressing `Ctrl+R` (Windows/Linux) or `Cmd+R` (macOS)
     - Or clicking the "Reload" button in the debug toolbar

5. **View logs and debug output**
   - Open the Debug Console in the original VS Code window to see extension logs
   - In the Extension Development Host window, open Developer Tools with `Help > Toggle Developer Tools` to see webview logs

## Build for Production

To build the extension for distribution:

```bash
npm run compile
# or
pnpm run compile
```

To package the extension as a VSIX file:

```bash
npx vsce package
# or
pnpm vsce package
```

## Terms of Service and Privacy Notice

By installing this extension, you agree to the [Terms of Service](https://github.com/QwenLM/qwen-code/blob/main/docs/tos-privacy.md).
