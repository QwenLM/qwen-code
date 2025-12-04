# Qwen Code Companion

The Qwen Code Companion extension seamlessly integrates [Qwen Code](https://github.com/QwenLM/qwen-code). This extension is compatible with both VS Code and VS Code forks.

# Features

- Open Editor File Context: Qwen Code gains awareness of the files you have open in your editor, providing it with a richer understanding of your project's structure and content.

- Selection Context: Qwen Code can easily access your cursor's position and selected text within the editor, giving it valuable context directly from your current work.

- Native Diffing: Seamlessly view, modify, and accept code changes suggested by Qwen Code directly within the editor.

- Launch Qwen Code: Quickly start a new Qwen Code session from the Command Palette (Cmd+Shift+P or Ctrl+Shift+P) by running the "Qwen Code: Run" command.

# Requirements

To use this extension, you'll need:

- VS Code version 1.101.0 or newer
- Qwen Code (installed separately) running within the VS Code integrated terminal

# Development and Debugging

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

# Terms of Service and Privacy Notice

By installing this extension, you agree to the [Terms of Service](https://github.com/QwenLM/qwen-code/blob/main/docs/tos-privacy.md).
