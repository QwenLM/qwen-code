# Qwen Code Companion Plugin: Interface Specification

> Last Updated: September 15, 2025

This document defines the contract for building a companion plugin to enable Qwen Code's IDE mode. For VS Code, these features (native diffing, context awareness) are provided by the official extension ([marketplace](https://marketplace.visualstudio.com/items?itemName=qwenlm.qwen-code-vscode-ide-companion)). This specification is for contributors who wish to bring similar functionality to other editors like JetBrains IDEs, Sublime Text, etc.

## I. The Communication Interface

Qwen Code and the IDE plugin communicate through a local communication channel.

### 1. Transport Layer: MCP over HTTP

The plugin **MUST** run a local HTTP server that implements the **Model Context Protocol (MCP)**.

- **Protocol:** The server must be a valid MCP server. We recommend using an existing MCP SDK for your language of choice if available.
- **Endpoint:** The server should expose a single endpoint (e.g., `/mcp`) for all MCP communication.
- **Port:** The server **MUST** listen on a dynamically assigned port (i.e., listen on port `0`).

### 2. Discovery Mechanism: The Lock File

For Qwen Code to connect, it needs to discover what port your server is using. The plugin **MUST** facilitate this by creating a "lock file" and setting the port environment variable.

- **How the CLI Finds the File:** The CLI reads the port from `QWEN_CODE_IDE_SERVER_PORT`, then reads `~/.qwen/ide/<PORT>.lock`. (Legacy fallbacks exist for older extensions; see note below.)
- **File Location:** The file must be created in a specific directory: `~/.qwen/ide/`. Your plugin must create this directory if it doesn't exist.
- **File Naming Convention:** The filename is critical and **MUST** follow the pattern:
  `<PORT>.lock`
  - `<PORT>`: The port your MCP server is listening on.
- **File Content & Workspace Validation:** The file **MUST** contain a JSON object with the following structure:

  ```json
  {
    "port": 12345,
    "workspacePath": "/path/to/project1:/path/to/project2",
    "authToken": "a-very-secret-token",
    "ppid": 1234,
    "ideName": "VS Code"
  }
  ```
  - `port` (number, required): The port of the MCP server.
  - `workspacePath` (string, required): A list of all open workspace root paths, delimited by the OS-specific path separator (`:` for Linux/macOS, `;` for Windows). The CLI uses this path to ensure it's running in the same project folder that's open in the IDE. If the CLI's current working directory is not a sub-directory of `workspacePath`, the connection will be rejected. Your plugin **MUST** provide the correct, absolute path(s) to the root of the open workspace(s).
  - `authToken` (string, required): A secret token for securing the connection. The CLI will include this token in an `Authorization: Bearer <token>` header on all requests.
  - `ppid` (number, required): The parent process ID of the IDE process.
  - `ideName` (string, required): A user-friendly name for the IDE (e.g., `VS Code`, `JetBrains IDE`).

- **Authentication:** To secure the connection, the plugin **MUST** generate a unique, secret token and include it in the discovery file. The CLI will then include this token in the `Authorization` header for all requests to the MCP server (e.g., `Authorization: Bearer a-very-secret-token`). Your server **MUST** validate this token on every request and reject any that are unauthorized.
- **Environment Variables (Required):** Your plugin **MUST** set `QWEN_CODE_IDE_SERVER_PORT` in the integrated terminal so the CLI can locate the correct `<PORT>.lock` file.

**Legacy note:** For extensions older than v0.5.1, Qwen Code may fall back to reading JSON files in the system temp directory named `qwen-code-ide-server-<PID>.json` or `qwen-code-ide-server-<PORT>.json`. New integrations should not rely on these legacy files.

## II. The Context Interface

To enable context awareness, the plugin **MAY** provide the CLI with real-time information about the user's activity in the IDE.

### `ide/contextUpdate` Notification

The plugin **MAY** send an `ide/contextUpdate` [notification](https://modelcontextprotocol.io/specification/2025-06-18/basic/index#notifications) to the CLI whenever the user's context changes.

- **Triggering Events:** This notification should be sent (with a recommended debounce of 50ms) when:
  - A file is opened, closed, or focused.
  - The user's cursor position or text selection changes in the active file.
- **Payload (`IdeContext`):** The notification parameters **MUST** be an `IdeContext` object:

  ```typescript
  interface IdeContext {
    workspaceState?: {
      openFiles?: File[];
      isTrusted?: boolean;
    };
  }

  interface File {
    // Absolute path to the file
    path: string;
    // Last focused Unix timestamp (for ordering)
    timestamp: number;
    // True if this is the currently focused file
    isActive?: boolean;
    cursor?: {
      // 1-based line number
      line: number;
      // 1-based character number
      character: number;
    };
    // The text currently selected by the user
    selectedText?: string;
  }
  ```

  **Note:** The `openFiles` list should only include files that exist on disk. Virtual files (e.g., unsaved files without a path, editor settings pages) **MUST** be excluded.

### How the CLI Uses This Context

After receiving the `IdeContext` object, the CLI performs several normalization and truncation steps before sending the information to the model.

- **File Ordering:** The CLI uses the `timestamp` field to determine the most recently used files. It sorts the `openFiles` list based on this value. Therefore, your plugin **MUST** provide an accurate Unix timestamp for when a file was last focused.
- **Active File:** The CLI considers only the most recent file (after sorting) to be the "active" file. It will ignore the `isActive` flag on all other files and clear their `cursor` and `selectedText` fields. Your plugin should focus on setting `isActive: true` and providing cursor/selection details only for the currently focused file.
- **Truncation:** To manage token limits, the CLI truncates both the file list (to 10 files) and the `selectedText` (to 16KB).

While the CLI handles the final truncation, it is highly recommended that your plugin also limits the amount of context it sends.

## III. The Diffing Interface

To enable interactive code modifications, the plugin **MAY** expose a diffing interface. This allows the CLI to request that the IDE open a diff view, showing proposed changes to a file. The user can then review, edit, and ultimately accept or reject these changes directly within the IDE.

### `openDiff` Tool

The plugin **MUST** register an `openDiff` tool on its MCP server.

- **Description:** This tool instructs the IDE to open a modifiable diff view for a specific file.
- **Request (`OpenDiffRequest`):** The tool is invoked via a `tools/call` request. The `arguments` field within the request's `params` **MUST** be an `OpenDiffRequest` object.

  ```typescript
  interface OpenDiffRequest {
    // The absolute path to the file to be diffed.
    filePath: string;
    // The proposed new content for the file.
    newContent: string;
  }
  ```

- **Response (`CallToolResult`):** The tool **MUST** immediately return a `CallToolResult` to acknowledge the request and report whether the diff view was successfully opened.
  - On Success: If the diff view was opened successfully, the response **MUST** contain empty content (i.e., `content: []`).
  - On Failure: If an error prevented the diff view from opening, the response **MUST** have `isError: true` and include a `TextContent` block in the `content` array describing the error.

  The actual outcome of the diff (acceptance or rejection) is communicated asynchronously via notifications.

### `closeDiff` Tool

The plugin **MUST** register a `closeDiff` tool on its MCP server.

- **Description:** This tool instructs the IDE to close an open diff view for a specific file.
- **Request (`CloseDiffRequest`):** The tool is invoked via a `tools/call` request. The `arguments` field within the request's `params` **MUST** be an `CloseDiffRequest` object.

  ```typescript
  interface CloseDiffRequest {
    // The absolute path to the file whose diff view should be closed.
    filePath: string;
  }
  ```

- **Response (`CallToolResult`):** The tool **MUST** return a `CallToolResult`.
  - On Success: If the diff view was closed successfully, the response **MUST** include a single **TextContent** block in the content array containing the file's final content before closing.
  - On Failure: If an error prevented the diff view from closing, the response **MUST** have `isError: true` and include a `TextContent` block in the `content` array describing the error.

### `ide/diffAccepted` Notification

When the user accepts the changes in a diff view (e.g., by clicking an "Apply" or "Save" button), the plugin **MUST** send an `ide/diffAccepted` notification to the CLI.

- **Payload:** The notification parameters **MUST** include the file path and the final content of the file. The content may differ from the original `newContent` if the user made manual edits in the diff view.

  ```typescript
  {
    // The absolute path to the file that was diffed.
    filePath: string;
    // The full content of the file after acceptance.
    content: string;
  }
  ```

### `ide/diffRejected` Notification

When the user rejects the changes (e.g., by closing the diff view without accepting), the plugin **MUST** send an `ide/diffRejected` notification to the CLI.

- **Payload:** The notification parameters **MUST** include the file path of the rejected diff.

  ```typescript
  {
    // The absolute path to the file that was diffed.
    filePath: string;
  }
  ```

## IV. The Lifecycle Interface

The plugin **MUST** manage its resources and the discovery file correctly based on the IDE's lifecycle.

- **On Activation (IDE startup/plugin enabled):**
  1.  Start the MCP server.
  2.  Create the discovery file.
- **On Deactivation (IDE shutdown/plugin disabled):**
  1.  Stop the MCP server.
  2.  Delete the discovery file.
