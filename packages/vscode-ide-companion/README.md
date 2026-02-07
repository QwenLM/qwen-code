# Qwen Code Companion

[![Version](https://img.shields.io/visual-studio-marketplace/v/qwenlm.qwen-code-vscode-ide-companion)](https://marketplace.visualstudio.com/items?itemName=qwenlm.qwen-code-vscode-ide-companion)
[![VS Code Installs](https://img.shields.io/visual-studio-marketplace/i/qwenlm.qwen-code-vscode-ide-companion)](https://marketplace.visualstudio.com/items?itemName=qwenlm.qwen-code-vscode-ide-companion)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/qwenlm/qwen-code-vscode-ide-companion)](https://open-vsx.org/extension/qwenlm/qwen-code-vscode-ide-companion)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/qwenlm.qwen-code-vscode-ide-companion)](https://marketplace.visualstudio.com/items?itemName=qwenlm.qwen-code-vscode-ide-companion)

Seamlessly integrate [Qwen Code](https://github.com/QwenLM/qwen-code) into Visual Studio Code with native IDE features and an intuitive chat interface. This extension bundles everything you need — no additional installation required.

## Demo

<video src="https://cloud.video.taobao.com/vod/IKKwfM-kqNI3OJjM_U8uMCSMAoeEcJhs6VNCQmZxUfk.mp4" controls width="800">
  Your browser does not support the video tag. You can open the video directly:
  https://cloud.video.taobao.com/vod/IKKwfM-kqNI3OJjM_U8uMCSMAoeEcJhs6VNCQmZxUfk.mp4
</video>

## Features

- **Native IDE experience**: Dedicated Qwen Code Chat panel accessed via the Qwen icon in the editor title bar
- **Native diffing**: Review, edit, and accept changes in VS Code's diff view
- **Auto-accept edits mode**: Automatically apply Qwen's changes as they're made
- **File management**: @-mention files or attach files and images using the system file picker
- **Conversation history & multiple sessions**: Access past conversations and run multiple sessions simultaneously
- **Open file & selection context**: Share active files, cursor position, and selections for more precise help

## Requirements

- Visual Studio Code 1.85.0 or newer (also works with Cursor, Windsurf, and other VS Code-based editors)

## Quick Start

1. **Install** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=qwenlm.qwen-code-vscode-ide-companion) or [Open VSX Registry](https://open-vsx.org/extension/qwenlm/qwen-code-vscode-ide-companion)

2. **Open the Chat panel** using one of these methods:
   - Click the **Qwen icon** in the top-right corner of the editor
   - Run `Qwen Code: Open` from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)

3. **Start chatting** — Ask Qwen to help with coding tasks, explain code, fix bugs, or write new features

## Commands

| Command                          | Description                                            |
| -------------------------------- | ------------------------------------------------------ |
| `Qwen Code: Open`                | Open the Qwen Code Chat panel                          |
| `Qwen Code: Run`                 | Launch a classic terminal session with the bundled CLI |
| `Qwen Code: Accept Current Diff` | Accept the currently displayed diff                    |
| `Qwen Code: Close Diff Editor`   | Close/reject the current diff                          |

## Feedback & Issues

- 🐛 [Report bugs](https://github.com/QwenLM/qwen-code/issues/new?template=bug_report.yml&labels=bug,vscode-ide-companion)
- 💡 [Request features](https://github.com/QwenLM/qwen-code/issues/new?template=feature_request.yml&labels=enhancement,vscode-ide-companion)
- 📖 [Documentation](https://qwenlm.github.io/qwen-code-docs/)
- 📋 [Changelog](https://github.com/QwenLM/qwen-code/releases)

## Contributing

We welcome contributions! See our [Contributing Guide](https://github.com/QwenLM/qwen-code/blob/main/CONTRIBUTING.md) for details on:

- Setting up the development environment
- Building and debugging the extension locally
- Submitting pull requests

## Terms of Service and Privacy Notice

By installing this extension, you agree to the [Terms of Service](https://github.com/QwenLM/qwen-code/blob/main/docs/tos-privacy.md).

## License

[Apache-2.0](https://github.com/QwenLM/qwen-code/blob/main/LICENSE)
