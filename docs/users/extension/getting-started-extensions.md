# Getting Started with Qwen Code Extensions

This guide will walk you through creating your first Qwen Code extension. You'll learn how to set up a new extension, add a custom tool via an MCP server, create a custom command, and provide context to the model with a `QWEN.md` file.

## Prerequisites

Before you start, make sure you have the Qwen Code installed and a basic understanding of Node.js and TypeScript.

## Step 1: Create a New Extension

The easiest way to start is by using one of the built-in templates. We'll use the `mcp-server` example as our foundation.

Run the following command to create a new directory called `my-first-extension` with the template files:

```bash
qwen extensions new my-first-extension mcp-server
```

This will create a new directory with the following structure:

```
my-first-extension/
├── example.ts
├── qwen-extension.json
├── package.json
└── tsconfig.json
```

## Step 2: Understand the Extension Files

Let's look at the key files in your new extension.

### `qwen-extension.json`

This is the manifest file for your extension. It tells Qwen Code how to load and use your extension.

```json
{
  "name": "my-first-extension",
  "version": "1.0.0",
  "mcpServers": {
    "nodeServer": {
      "command": "node",
      "args": ["${extensionPath}${/}dist${/}example.js"],
      "cwd": "${extensionPath}"
    }
  }
}
```

- `name`: The unique name for your extension.
- `version`: The version of your extension.
- `mcpServers`: This section defines one or more Model Context Protocol (MCP) servers. MCP servers are how you can add new tools for the model to use.
  - `command`, `args`, `cwd`: These fields specify how to start your server. Notice the use of the `${extensionPath}` variable, which Qwen Code replaces with the absolute path to your extension's installation directory. This allows your extension to work regardless of where it's installed.

### `example.ts`

This file contains the source code for your MCP server. It's a simple Node.js server that uses the `@modelcontextprotocol/sdk`.

```typescript
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'prompt-server',
  version: '1.0.0',
});

// Registers a new tool named 'fetch_posts'
server.registerTool(
  'fetch_posts',
  {
    description: 'Fetches a list of posts from a public API.',
    inputSchema: z.object({}).shape,
  },
  async () => {
    const apiResponse = await fetch(
      'https://jsonplaceholder.typicode.com/posts',
    );
    const posts = await apiResponse.json();
    const response = { posts: posts.slice(0, 5) };
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response),
        },
      ],
    };
  },
);

// ... (prompt registration omitted for brevity)

const transport = new StdioServerTransport();
await server.connect(transport);
```

This server defines a single tool called `fetch_posts` that fetches data from a public API.

### `package.json` and `tsconfig.json`

These are standard configuration files for a TypeScript project. The `package.json` file defines dependencies and a `build` script, and `tsconfig.json` configures the TypeScript compiler.

## Step 3: Build and Link Your Extension

Before you can use the extension, you need to compile the TypeScript code and link the extension to your Qwen Code installation for local development.

1.  **Install dependencies:**

    ```bash
    cd my-first-extension
    npm install
    ```

2.  **Build the server:**

    ```bash
    npm run build
    ```

    This will compile `example.ts` into `dist/example.js`, which is the file referenced in your `qwen-extension.json`.

3.  **Link the extension:**

    The `link` command creates a symbolic link from the Qwen Code extensions directory to your development directory. This means any changes you make will be reflected immediately without needing to reinstall.

    ```bash
    qwen extensions link .
    ```

Now, restart your Qwen Code session. The new `fetch_posts` tool will be available. You can test it by asking: "fetch posts".

## Step 4: Add a Custom Command

Custom commands provide a way to create shortcuts for complex prompts. Let's add a command that searches for a pattern in your code.

1.  Create a `commands` directory and a subdirectory for your command group:

    ```bash
    mkdir -p commands/fs
    ```

2.  Create a file named `commands/fs/grep-code.md`:

    ```markdown
    ---
    description: Search for a pattern in code and summarize findings
    ---

    Please summarize the findings for the pattern `{{args}}`.

    Search Results:
    !{grep -r {{args}} .}
    ```

    This command, `/fs:grep-code`, will take an argument, run the `grep` shell command with it, and pipe the results into a prompt for summarization.

> **Note:** Commands use Markdown format with optional YAML frontmatter. TOML format is deprecated but still supported for backwards compatibility.

After saving the file, restart the Qwen Code. You can now run `/fs:grep-code "some pattern"` to use your new command.

## Step 5: Add Custom Skills and Subagents (Optional)

Extensions can also provide custom skills and subagents to extend Qwen Code's capabilities.

### Adding a Custom Skill

Skills are model-invoked capabilities that the AI can automatically use when relevant.

1.  Create a `skills` directory with a skill subdirectory:

    ```bash
    mkdir -p skills/code-analyzer
    ```

2.  Create a `skills/code-analyzer/SKILL.md` file:

    ```markdown
    ---
    name: code-analyzer
    description: Analyzes code structure and provides insights about complexity, dependencies, and potential improvements
    ---

    # Code Analyzer

    ## Instructions

    When analyzing code, focus on:

    - Code complexity and maintainability
    - Dependencies and coupling
    - Potential performance issues
    - Suggestions for improvements

    ## Examples

    - "Analyze the complexity of this function"
    - "What are the dependencies of this module?"
    ```

### Adding a Custom Subagent

Subagents are specialized AI assistants for specific tasks.

1.  Create an `agents` directory:

    ```bash
    mkdir -p agents
    ```

2.  Create an `agents/refactoring-expert.md` file:

    ```markdown
    ---
    name: refactoring-expert
    description: Specialized in code refactoring, improving code structure and maintainability
    tools:
      - read_file
      - write_file
      - read_many_files
    ---

    You are a refactoring specialist focused on improving code quality.

    Your expertise includes:

    - Identifying code smells and anti-patterns
    - Applying SOLID principles
    - Improving code readability and maintainability
    - Safe refactoring with minimal risk

    For each refactoring task:

    1. Analyze the current code structure
    2. Identify areas for improvement
    3. Propose refactoring steps
    4. Implement changes incrementally
    5. Verify functionality is preserved
    ```

After restarting Qwen Code, your custom skills will be available via `/skills` and subagents via `/agents manage`.

An extension skill is registered under its owner's name: the skill above becomes `my-first-extension:code-analyzer`, so you run it as `/my-first-extension:code-analyzer`. `skills.disabled` can block it under either that name or the plain `code-analyzer` you authored; `skills.enabled` opts it back in under the prefixed name only. See [Extension Skills](../features/skills.md#extension-skills).

## Step 6: Add a Custom `QWEN.md`

You can provide persistent context to the model by adding a `QWEN.md` file to your extension. This is useful for giving the model instructions on how to behave or information about your extension's tools. Note that you may not always need this for extensions built to expose commands and prompts.

1.  Create a file named `QWEN.md` in the root of your extension directory:

    ```markdown
    # My First Extension Instructions

    You are an expert developer assistant. When the user asks you to fetch posts, use the `fetch_posts` tool. Be concise in your responses.
    ```

2.  Update your `qwen-extension.json` to tell the CLI to load this file:

    ```json
    {
      "name": "my-first-extension",
      "version": "1.0.0",
      "contextFileName": "QWEN.md",
      "mcpServers": {
        "nodeServer": {
          "command": "node",
          "args": ["${extensionPath}${/}dist${/}example.js"],
          "cwd": "${extensionPath}"
        }
      }
    }
    ```

Restart the CLI again. The model will now have the context from your `QWEN.md` file in every session where the extension is active.

## Step 7: Releasing Your Extension

Once you are happy with your extension, you can share it with others. The two primary ways of releasing extensions are via a Git repository or through GitHub Releases. Using a public Git repository is the simplest method.

For detailed instructions on both methods, please refer to the [Extension Releasing Guide](extension-releasing.md).

## Conclusion

You've successfully created a Qwen Code extension! You learned how to:

- Bootstrap a new extension from a template.
- Add custom tools with an MCP server.
- Create convenient custom commands.
- Add custom skills and subagents.
- Provide persistent context to the model.
- Link your extension for local development.

From here, you can explore more advanced features and build powerful new capabilities into the Qwen Code.

## Deployment-managed extensions

Pass a collection root with `--managed-extensions` to load prepared extensions directly,
including with a new `QWEN_HOME`. No install, link, or install metadata is needed:

```text
prepared-extensions/
└── example/
    ├── qwen-extension.json
    ├── QWEN.md
    ├── skills/
    ├── commands/
    └── hooks/
```

```dockerfile
COPY prepared-extensions/ /opt/example/extensions/
```

```bash
qwen serve --managed-extensions /opt/example/extensions/
qwen --managed-extensions ./prepared-extensions -e example
qwen --managed-extensions ./prepared-extensions extensions list
qwen --managed-extensions ./prepared-extensions extensions disable example
qwen --managed-extensions ./prepared-extensions extensions enable example
qwen mcp list --managed-extensions ./prepared-extensions
```

There is one optional root. Only direct children are discovered. Relative paths
resolve against startup cwd once; serve carries the resulting absolute directory
to all workspaces and new, resumed, or recreated Agent processes. Session requests
cannot override it. An empty directory is valid; a missing, unreadable, or non-directory
root fails with a configuration error. The managed root must be disjoint from
Qwen’s writable extension and extension-store directories, including symlink
and filesystem case aliases. Without this option, only the existing user extension source is discovered.
Continue supplying the option to management commands. Unchanged skill bodies remain deduplicated during refresh.

For managed extensions, User-scope CLI enable/disable changes the default across
all workspaces, including those outside your home directory. These explicit
actions and management API default-activation changes (including batches) clear
inherited legacy path rules only for managed packages. Exact workspace overrides keep their
existing precedence. User-installed extensions retain their
existing home-path activation behavior.

Managed extensions default to enabled and obey trust, safe mode, tool approval,
and the existing `-e/--extensions` name filter. Names use the existing validation
and case-insensitive comparison. Managed wins a conflict with a user extension,
with a warning; disabling it does not activate the shadowed user copy. Duplicate
managed names are an error. Activation preferences use the existing name-based
user state and survive manifest version changes and relocation of the root.

List output and management status expose the manifest version and managed source.
Daemon entries add `extensionSource: "managed"`; the existing `source` field keeps
its install-URL meaning for user packages. Settings, preferences, and caches stay
in writable user state. Qwen never writes managed installation metadata or copies
packages to `QWEN_HOME`. Update, uninstall, and replacement are refused by core
operations; update-all reports and skips managed entries while processing user
extensions. The deployment owner supplies new package versions. After the owner removes a managed package, an explicit same-name user installation can inherit its saved activation and resource preferences if no user package is already installed. A still-present managed package remains protected from replacement. An empty settings directory or one containing only the regular user `.env` file can be adopted without discarding saved values; values explicitly supplied during installation take precedence. Other existing files, symlinks and secret-selector metadata are retained and reported as conflicts instead of being overwritten.

Skills, hooks, MCP, context, and commands use the normal extension runtime.
`${CLAUDE_PLUGIN_ROOT}` and `${extensionPath}` resolve at load time to the actual
package directory; extension scripts should likewise locate their resources at
runtime and write output outside the package. Use the existing explicit extension
refresh after deployment changes. In serve, prefer `POST /workspaces/:workspace/extensions/refresh` for each selected workspace and wait for the returned operation to succeed; reconciliation updates live Agent sessions. The primary-workspace compatibility route, `POST /workspace/extensions/refresh`, returns synchronously and does not record the applied generation, so the background reconciler may refresh it again. No new watcher or MCP dynamic-tool notification mechanism is added.

See the [design](../../design/managed-extension-directory.md) for scope and
validation requirements.
