# @qwen-code/sdk

A minimum experimental TypeScript SDK for programmatic access to Qwen Code.

Feel free to submit a feature request/issue/PR.

## Installation

```bash
npm install @qwen-code/sdk
```

## Requirements

- Node.js >= 20.0.0
- [Qwen Code](https://github.com/QwenLM/qwen-code) >= 0.4.0 (stable) installed and accessible in PATH

> **Note for nvm users**: If you use nvm to manage Node.js versions, the SDK may not be able to auto-detect the Qwen Code executable. You should explicitly set the `pathToQwenExecutable` option to the full path of the `qwen` binary.

## Quick Start

```typescript
import { query } from '@qwen-code/sdk';

// Single-turn query
const result = query({
  prompt: 'What files are in the current directory?',
  options: {
    cwd: '/path/to/project',
  },
});

// Iterate over messages
for await (const message of result) {
  if (message.type === 'assistant') {
    console.log('Assistant:', message.message.content);
  } else if (message.type === 'result') {
    console.log('Result:', message.result);
  }
}
```

## API Reference

### `query(config)`

Creates a new query session with the Qwen Code.

#### Parameters

- `prompt`: `string | AsyncIterable<SDKUserMessage>` - The prompt to send. Use a string for single-turn queries or an async iterable for multi-turn conversations.
- `options`: `QueryOptions` - Configuration options for the query session.

#### QueryOptions

| Option                   | Type                                           | Default          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                    | `string`                                       | `process.cwd()`  | The working directory for the query session. Determines the context in which file operations and commands are executed.                                                                                                                                                                                                                                                                                                                                                               |
| `model`                  | `string`                                       | -                | The AI model to use (e.g., `'qwen-max'`, `'qwen-plus'`, `'qwen-turbo'`). Takes precedence over `OPENAI_MODEL` and `QWEN_MODEL` environment variables.                                                                                                                                                                                                                                                                                                                                 |
| `pathToQwenExecutable`   | `string`                                       | Auto-detected    | Path to the Qwen Code executable. Supports multiple formats: `'qwen'` (native binary from PATH), `'/path/to/qwen'` (explicit path), `'/path/to/cli.js'` (Node.js bundle), `'node:/path/to/cli.js'` (force Node.js runtime), `'bun:/path/to/cli.js'` (force Bun runtime). If not provided, auto-detects from: `QWEN_CODE_CLI_PATH` env var, `~/.volta/bin/qwen`, `~/.npm-global/bin/qwen`, `/usr/local/bin/qwen`, `~/.local/bin/qwen`, `~/node_modules/.bin/qwen`, `~/.yarn/bin/qwen`. |
| `permissionMode`         | `'default' \| 'plan' \| 'auto-edit' \| 'yolo'` | `'default'`      | Permission mode controlling tool execution approval. See [Permission Modes](#permission-modes) for details.                                                                                                                                                                                                                                                                                                                                                                           |
| `canUseTool`             | `CanUseTool`                                   | -                | Custom permission handler for tool execution approval. Invoked when a tool requires confirmation. Must respond within 60 seconds or the request will be auto-denied. See [Custom Permission Handler](#custom-permission-handler).                                                                                                                                                                                                                                                     |
| `env`                    | `Record<string, string>`                       | -                | Environment variables to pass to the Qwen Code process. Merged with the current process environment.                                                                                                                                                                                                                                                                                                                                                                                  |
| `mcpServers`             | `Record<string, McpServerConfig>`              | -                | MCP (Model Context Protocol) servers to connect. Supports external servers (stdio/SSE/HTTP) and SDK-embedded servers. External servers are configured with transport options like `command`, `args`, `url`, `httpUrl`, etc. SDK servers use `{ type: 'sdk', name: string, instance: Server }`.                                                                                                                                                                                        |
| `abortController`        | `AbortController`                              | -                | Controller to cancel the query session. Call `abortController.abort()` to terminate the session and cleanup resources.                                                                                                                                                                                                                                                                                                                                                                |
| `debug`                  | `boolean`                                      | `false`          | Enable debug mode for verbose logging from the CLI process.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `maxSessionTurns`        | `number`                                       | `-1` (unlimited) | Maximum number of conversation turns before the session automatically terminates. A turn consists of a user message and an assistant response.                                                                                                                                                                                                                                                                                                                                        |
| `coreTools`              | `string[]`                                     | -                | Equivalent to `tool.core` in settings.json. If specified, only these tools will be available to the AI. Example: `['read_file', 'write_file', 'run_terminal_cmd']`.                                                                                                                                                                                                                                                                                                                   |
| `excludeTools`           | `string[]`                                     | -                | Equivalent to `tool.exclude` in settings.json. Excluded tools return a permission error immediately. Takes highest priority over all other permission settings. Supports pattern matching: tool name (`'write_file'`), tool class (`'ShellTool'`), or shell command prefix (`'ShellTool(rm )'`).                                                                                                                                                                                      |
| `allowedTools`           | `string[]`                                     | -                | Equivalent to `tool.allowed` in settings.json. Matching tools bypass `canUseTool` callback and execute automatically. Only applies when tool requires confirmation. Supports same pattern matching as `excludeTools`.                                                                                                                                                                                                                                                                 |
| `authType`               | `'openai' \| 'qwen-oauth'`                     | `'openai'`       | Authentication type for the AI service. Using `'qwen-oauth'` in SDK is not recommended as credentials are stored in `~/.qwen` and may need periodic refresh.                                                                                                                                                                                                                                                                                                                          |
| `agents`                 | `SubagentConfig[]`                             | -                | Configuration for subagents that can be invoked during the session. Subagents are specialized AI agents for specific tasks or domains.                                                                                                                                                                                                                                                                                                                                                |
| `includePartialMessages` | `boolean`                                      | `false`          | When `true`, the SDK emits incomplete messages as they are being generated, allowing real-time streaming of the AI's response.                                                                                                                                                                                                                                                                                                                                                        |

### Timeouts

The SDK enforces the following default timeouts:

| Timeout          | Default  | Description                                                                                                                  |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `canUseTool`     | 1 minute | Maximum time for `canUseTool` callback to respond. If exceeded, the tool request is auto-denied.                             |
| `mcpRequest`     | 1 minute | Maximum time for SDK MCP tool calls to complete.                                                                             |
| `controlRequest` | 1 minute | Maximum time for control operations like `initialize()`, `setModel()`, `setPermissionMode()`, and `interrupt()` to complete. |
| `streamClose`    | 1 minute | Maximum time to wait for initialization to complete before closing CLI stdin in multi-turn mode with SDK MCP servers.        |

You can customize these timeouts via the `timeout` option:

```typescript
const query = qwen.query('Your prompt', {
  timeout: {
    canUseTool: 60000, // 60 seconds for permission callback
    mcpRequest: 600000, // 10 minutes for MCP tool calls
    controlRequest: 60000, // 60 seconds for control requests
    streamClose: 15000, // 15 seconds for stream close wait
  },
});
```

### Message Types

The SDK provides type guards to identify different message types:

```typescript
import {
  isSDKUserMessage,
  isSDKAssistantMessage,
  isSDKSystemMessage,
  isSDKResultMessage,
  isSDKPartialAssistantMessage,
} from '@qwen-code/sdk';

for await (const message of result) {
  if (isSDKAssistantMessage(message)) {
    // Handle assistant message
  } else if (isSDKResultMessage(message)) {
    // Handle result message
  }
}
```

### Query Instance Methods

The `Query` instance returned by `query()` provides several methods:

```typescript
const q = query({ prompt: 'Hello', options: {} });

// Get session ID
const sessionId = q.getSessionId();

// Check if closed
const closed = q.isClosed();

// Interrupt the current operation
await q.interrupt();

// Change permission mode mid-session
await q.setPermissionMode('yolo');

// Change model mid-session
await q.setModel('qwen-max');

// Close the session
await q.close();
```

## Permission Modes

The SDK supports different permission modes for controlling tool execution:

- **`default`**: Write tools are denied unless approved via `canUseTool` callback or in `allowedTools`. Read-only tools execute without confirmation.
- **`plan`**: Blocks all write tools, instructing AI to present a plan first.
- **`auto-edit`**: Auto-approve edit tools (edit, write_file) while other tools require confirmation.
- **`yolo`**: All tools execute automatically without confirmation.

### Permission Priority Chain

1. `excludeTools` - Blocks tools completely
2. `permissionMode: 'plan'` - Blocks non-read-only tools
3. `permissionMode: 'yolo'` - Auto-approves all tools
4. `allowedTools` - Auto-approves matching tools
5. `canUseTool` callback - Custom approval logic
6. Default behavior - Auto-deny in SDK mode

## Examples

### Multi-turn Conversation

```typescript
import { query, type SDKUserMessage } from '@qwen-code/sdk';

async function* generateMessages(): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    session_id: 'my-session',
    message: { role: 'user', content: 'Create a hello.txt file' },
    parent_tool_use_id: null,
  };

  // Wait for some condition or user input
  yield {
    type: 'user',
    session_id: 'my-session',
    message: { role: 'user', content: 'Now read the file back' },
    parent_tool_use_id: null,
  };
}

const result = query({
  prompt: generateMessages(),
  options: {
    permissionMode: 'auto-edit',
  },
});

for await (const message of result) {
  console.log(message);
}
```

### Custom Permission Handler

```typescript
import { query, type CanUseTool } from '@qwen-code/sdk';

const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
  // Allow all read operations
  if (toolName.startsWith('read_')) {
    return { behavior: 'allow', updatedInput: input };
  }

  // Prompt user for write operations (in a real app)
  const userApproved = await promptUser(`Allow ${toolName}?`);

  if (userApproved) {
    return { behavior: 'allow', updatedInput: input };
  }

  return { behavior: 'deny', message: 'User denied the operation' };
};

const result = query({
  prompt: 'Create a new file',
  options: {
    canUseTool,
  },
});
```

### With External MCP Servers

```typescript
import { query } from '@qwen-code/sdk';

const result = query({
  prompt: 'Use the custom tool from my MCP server',
  options: {
    mcpServers: {
      'my-server': {
        command: 'node',
        args: ['path/to/mcp-server.js'],
        env: { PORT: '3000' },
      },
    },
  },
});
```

### With SDK-Embedded MCP Servers

The SDK provides `tool` and `createSdkMcpServer` to create MCP servers that run in the same process as your SDK application. This is useful when you want to expose custom tools to the AI without running a separate server process.

#### `tool(name, description, inputSchema, handler)`

Creates a tool definition with Zod schema type inference.

| Parameter     | Type                               | Description                                                              |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `name`        | `string`                           | Tool name (1-64 chars, starts with letter, alphanumeric and underscores) |
| `description` | `string`                           | Human-readable description of what the tool does                         |
| `inputSchema` | `ZodRawShape`                      | Zod schema object defining the tool's input parameters                   |
| `handler`     | `(args, extra) => Promise<Result>` | Async function that executes the tool and returns MCP content blocks     |

The handler must return a `CallToolResult` object with the following structure:

```typescript
{
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; uri: string; mimeType?: string; text?: string }
  >;
  isError?: boolean;
}
```

#### `createSdkMcpServer(options)`

Creates an SDK-embedded MCP server instance.

| Option    | Type                     | Default   | Description                          |
| --------- | ------------------------ | --------- | ------------------------------------ |
| `name`    | `string`                 | Required  | Unique name for the MCP server       |
| `version` | `string`                 | `'1.0.0'` | Server version                       |
| `tools`   | `SdkMcpToolDefinition[]` | -         | Array of tools created with `tool()` |

Returns a `McpSdkServerConfigWithInstance` object that can be passed directly to the `mcpServers` option.

#### Example

```typescript
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '@qwen-code/sdk';

// Define a tool with Zod schema
const calculatorTool = tool(
  'calculate_sum',
  'Add two numbers',
  { a: z.number(), b: z.number() },
  async (args) => ({
    content: [{ type: 'text', text: String(args.a + args.b) }],
  }),
);

// Create the MCP server
const server = createSdkMcpServer({
  name: 'calculator',
  tools: [calculatorTool],
});

// Use the server in a query
const result = query({
  prompt: 'What is 42 + 17?',
  options: {
    permissionMode: 'yolo',
    mcpServers: {
      calculator: server,
    },
  },
});

for await (const message of result) {
  console.log(message);
}
```

### Abort a Query

```typescript
import { query, isAbortError } from '@qwen-code/sdk';

const abortController = new AbortController();

const result = query({
  prompt: 'Long running task...',
  options: {
    abortController,
  },
});

// Abort after 5 seconds
setTimeout(() => abortController.abort(), 5000);

try {
  for await (const message of result) {
    console.log(message);
  }
} catch (error) {
  if (isAbortError(error)) {
    console.log('Query was aborted');
  } else {
    throw error;
  }
}
```

## Error Handling

The SDK provides an `AbortError` class for handling aborted queries:

```typescript
import { AbortError, isAbortError } from '@qwen-code/sdk';

try {
  // ... query operations
} catch (error) {
  if (isAbortError(error)) {
    // Handle abort
  } else {
    // Handle other errors
  }
}
```

## License

Apache-2.0 - see [LICENSE](./LICENSE) for details.
