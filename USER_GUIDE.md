# Qwen Code Offline Setup Guide

This guide details how to set up and run Qwen Code in an offline, air-gapped environment.

## Prerequisites

1.  **Node.js**: Version 18+ installed.
2.  **Ollama**: Installed and running locally.
    - **Model**: Ensure `qwen2.5-coder:7b` is pulled (`ollama pull qwen2.5-coder:7b`).
    - **Server**: Must be listening on defaults (`http://localhost:11434`).
3.  **VS Code**: Installed (for IDE Companion features).

## 1. Build the CLI

The CLI is the core tool that runs in your terminal.

1.  Navigate to the `packages/cli` directory:
    ```cmd
    cd packages/cli
    ```
2.  Install dependencies:
    ```cmd
    npm install
    ```
3.  Build the project:
    ```cmd
    npm run build
    ```
4.  (Optional) Link globally for easy access:
    ```cmd
    npm link
    ```
    _Now you can run `qwen-code` from any terminal._

## 2. Build and Install the IDE Companion

The IDE Companion is a VS Code extension that allows the CLI to see your open files and open diff views.

1.  Navigate to the extension directory:
    ```cmd
    cd packages/vscode-ide-companion
    ```
2.  Install dependencies:
    ```cmd
    npm install
    ```
3.  Package the extension:

    ```cmd
    npm run package
    ```

    _This creates a file named something like `qwen-ollama-vscode-ide-companion-0.3.0.vsix`._

4.  **Install in VS Code**:
    - Open VS Code.
    - Press `Ctrl+Shift+P` (or `Cmd+Shift+P`).
    - Type "VSIX" and select **Extensions: Install from VSIX...**.
    - Select the `.vsix` file you just created.

## 3. Running the Application

1.  **Ensure Ollama is running**:
    ```cmd
    ollama serve
    ```
2.  **Start Qwen Code**:
    - If you linked it globally:
      ```cmd
      qwen-code
      ```
    - Or directly from the package:
      ```cmd
      npm start
      ```
3.  **Enable IDE Integration**:
    - Once the CLI starts, type:
      ```text
      /ide enable
      ```
    - Verify connection:
      ```text
      /ide status
      ```
    - _You should see "🟢 Connected"._

## Troubleshooting

- **"Ollama not reachable"**: Ensure `ollama serve` is running and `http://localhost:11434/v1` is accessible.
- **"IDE Companion not found"**: Ensure the extension is installed in VS Code and you have a workspace/folder open in VS Code. The extension only activates when a folder is open.
