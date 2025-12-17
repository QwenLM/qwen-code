# IDE Integration

Qwen Code can integrate with your IDE to provide a more seamless and context-aware experience. This integration allows the CLI to understand your workspace better and enables powerful features like native in-editor diffing.

Currently, the only supported IDE is [Visual Studio Code](https://code.visualstudio.com/) and other editors that support VS Code extensions. To build support for other editors, see the [IDE Companion Extension Spec](/users/ide-integration/ide-companion-spec).

## Features

- **Workspace Context:** The CLI automatically gains awareness of your workspace to provide more relevant and accurate responses. This context includes:
  - The **10 most recently accessed files** in your workspace.
  - Your active cursor position.
  - Any text you have selected (up to a 16KB limit; longer selections will be truncated).

- **Native Diffing:** When Qwen suggests code modifications, you can view the changes directly within your IDE's native diff viewer. This allows you to review, edit, and accept or reject the suggested changes seamlessly.

- **VS Code Commands:** You can access Qwen Code features directly from the VS Code Command Palette (`Cmd+Shift+P` or `Ctrl+Shift+P`):
  - `Qwen Code: Run`: Starts a new Qwen Code session in the integrated terminal.
  - `Qwen Code: Accept Diff`: Accepts the changes in the active diff editor.
  - `Qwen Code: Close Diff Editor`: Rejects the changes and closes the active diff editor.
  - `Qwen Code: View Third-Party Notices`: Displays the third-party notices for the extension.

## Installation and Setup

There are three ways to set up the IDE integration:

### 1. Automatic Nudge (Recommended)

When you run Qwen Code inside a supported editor, it will automatically detect your environment and prompt you to connect. Answering "Yes" will automatically run the necessary setup, which includes installing the companion extension and enabling the connection.

### 2. Manual Installation from CLI

If you previously dismissed the prompt or want to install the extension manually, you can run the following command inside Qwen Code:

```
/ide install
```

This will find the correct extension for your IDE and install it.

### 3. Manual Installation from a Marketplace

You can also install the extension directly from a marketplace.

- **For Visual Studio Code:** Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=qwenlm.qwen-code-vscode-ide-companion).
- **For VS Code Forks:** To support forks of VS Code, the extension is also published on the [Open VSX Registry](https://open-vsx.org/extension/qwenlm/qwen-code-vscode-ide-companion). Follow your editor's instructions for installing extensions from this registry.

> NOTE:
> The "Qwen Code Companion" extension may appear towards the bottom of search results. If you don't see it immediately, try scrolling down or sorting by "Newly Published".
>
> After manually installing the extension, you must run `/ide enable` in the CLI to activate the integration.

## Usage

### Enabling and Disabling

You can control the IDE integration from within the CLI:

- To enable the connection to the IDE, run:
  ```
  /ide enable
  ```
- To disable the connection, run:
  ```
  /ide disable
  ```

When enabled, Qwen Code will automatically attempt to connect to the IDE companion extension.

### Checking the Status

To check the connection status and see the context the CLI has received from the IDE, run:

```
/ide status
```

If connected, this command will show the IDE it's connected to and a list of recently opened files it is aware of.

(Note: The file list is limited to 10 recently accessed files within your workspace and only includes local files on disk.)

### Working with Diffs

When you ask Qwen model to modify a file, it can open a diff view directly in your editor.

**To accept a diff**, you can perform any of the following actions:

- Click the **checkmark icon** in the diff editor's title bar.
- Save the file (e.g., with `Cmd+S` or `Ctrl+S`).
- Open the Command Palette and run **Qwen Code: Accept Diff**.
- Respond with `yes` in the CLI when prompted.

**To reject a diff**, you can:

- Click the **'x' icon** in the diff editor's title bar.
- Close the diff editor tab.
- Open the Command Palette and run **Qwen Code: Close Diff Editor**.
- Respond with `no` in the CLI when prompted.

You can also **modify the suggested changes** directly in the diff view before accepting them.

If you select ‘Yes, allow always’ in the CLI, changes will no longer show up in the IDE as they will be auto-accepted.

## Using with Sandboxing

If you are using Qwen Code within a sandbox, please be aware of the following:

- **On macOS:** The IDE integration requires network access to communicate with the IDE companion extension. You must use a Seatbelt profile that allows network access.
- **In a Docker Container:** If you run Qwen Code inside a Docker (or Podman) container, the IDE integration can still connect to the VS Code extension running on your host machine. The CLI is configured to automatically find the IDE server on `host.docker.internal`. No special configuration is usually required, but you may need to ensure your Docker networking setup allows connections from the container to the host.

## Troubleshooting

If you encounter issues with IDE integration, here are some common error messages and how to resolve them.

### Connection Errors

- **Message:** `🔴 Disconnected: Failed to connect to IDE companion extension for [IDE Name]. Please ensure the extension is running and try restarting your terminal. To install the extension, run /ide install.`
  - **Cause:** Qwen Code could not find the necessary environment variables (`QWEN_CODE_IDE_WORKSPACE_PATH` or `QWEN_CODE_IDE_SERVER_PORT`) to connect to the IDE. This usually means the IDE companion extension is not running or did not initialize correctly.
  - **Solution:**
    1.  Make sure you have installed the **Qwen Code Companion** extension in your IDE and that it is enabled.
    2.  Open a new terminal window in your IDE to ensure it picks up the correct environment.

- **Message:** `🔴 Disconnected: IDE connection error. The connection was lost unexpectedly. Please try reconnecting by running /ide enable`
  - **Cause:** The connection to the IDE companion was lost.
  - **Solution:** Run `/ide enable` to try and reconnect. If the issue continues, open a new terminal window or restart your IDE.

### Configuration Errors

- **Message:** `🔴 Disconnected: Directory mismatch. Qwen Code is running in a different location than the open workspace in [IDE Name]. Please run the CLI from the same directory as your project's root folder.`
  - **Cause:** The CLI's current working directory is outside the folder or workspace you have open in your IDE.
  - **Solution:** `cd` into the same directory that is open in your IDE and restart the CLI.

- **Message:** `🔴 Disconnected: To use this feature, please open a workspace folder in [IDE Name] and try again.`
  - **Cause:** You have no workspace open in your IDE.
  - **Solution:** Open a workspace in your IDE and restart the CLI.

### General Errors

- **Message:** `IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: [List of IDEs]`
  - **Cause:** You are running Qwen Code in a terminal or environment that is not a supported IDE.
  - **Solution:** Run Qwen Code from the integrated terminal of a supported IDE, like VS Code.

- **Message:** `No installer is available for IDE. Please install the Qwen Code Companion extension manually from the marketplace.`
  - **Cause:** You ran `/ide install`, but the CLI does not have an automated installer for your specific IDE.
  - **Solution:** Open your IDE's extension marketplace, search for "Qwen Code Companion", and install it manually.
