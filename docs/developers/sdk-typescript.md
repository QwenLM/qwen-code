# Typescript SDK

## @qwen-code/sdk

A minimum experimental TypeScript SDK for programmatic access to Qwen Code.

Feel free to submit a feature request/issue/PR.

## Installation

```bash
npm install @qwen-code/sdk
```

## Requirements

- Node.js >= 22.0.0
- [Qwen Code](https://github.com/QwenLM/qwen-code) >= 0.4.0 (stable). The SDK uses its bundled CLI by default; set `pathToQwenExecutable` only when you need to run a custom `qwen` binary or CLI bundle.

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

| Option                   | Type                                                                 | Default          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                    | `string`                                                             | `process.cwd()`  | The working directory for the query session. Determines the context in which file operations and commands are executed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `model`                  | `string`                                                             | -                | The AI model to use (e.g., `'qwen-max'`, `'qwen-plus'`, `'qwen-turbo'`). Takes precedence over `OPENAI_MODEL` and `QWEN_MODEL` environment variables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pathToQwenExecutable`   | `string`                                                             | Bundled CLI      | Path to the Qwen Code executable. Supports multiple formats: `'qwen'` (native binary from PATH), `'/path/to/qwen'` (explicit path), `'/path/to/cli.js'` (Node.js bundle), `'node:/path/to/cli.js'` (force Node.js runtime), `'bun:/path/to/cli.js'` (force Bun runtime). If not provided, the SDK uses the bundled CLI included with the package.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `permissionMode`         | `'default' \| 'plan' \| 'auto-edit' \| 'auto' \| 'yolo'`             | `'default'`      | Permission mode controlling tool execution approval. See [Permission Modes](#permission-modes) for details.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `canUseTool`             | `CanUseTool`                                                         | -                | Custom permission handler for tool execution approval. Invoked when a tool requires confirmation. Must respond within 60 seconds or the request will be auto-denied. See [Custom Permission Handler](#custom-permission-handler).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `env`                    | `Record<string, string>`                                             | -                | Environment variables to pass to the Qwen Code process. Merged with the current process environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `systemPrompt`           | `string \| QuerySystemPromptPreset`                                  | -                | System prompt configuration for the main session. Use a string to fully override the built-in Qwen Code system prompt, or a preset object to keep the built-in prompt and append extra instructions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `mcpServers`             | `Record<string, McpServerConfig>`                                    | -                | MCP (Model Context Protocol) servers to connect. Supports external servers (stdio/SSE/HTTP) and SDK-embedded servers. External servers are configured with transport options like `command`, `args`, `url`, `httpUrl`, etc. SDK servers use `{ type: 'sdk', name: string, instance: Server }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `abortController`        | `AbortController`                                                    | -                | Controller to cancel the query session. Call `abortController.abort()` to terminate the session and cleanup resources.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `debug`                  | `boolean`                                                            | `false`          | Enable debug mode for verbose logging from the CLI process.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `maxSessionTurns`        | `number`                                                             | `-1` (unlimited) | Maximum number of conversation turns before the session automatically terminates. Must be an integer. A turn consists of a user message and an assistant response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `coreTools`              | `string[]`                                                           | -                | Uses the legacy `coreTools` / CLI `--core-tools` allowlist semantics. If specified, only matching core tools are registered for the session. This is the only allowlist-style option that restricts built-in tool registration; a whole-tool `permissions.deny` / `excludeTools` rule (and `tools.disabled` in settings.json) also removes a tool from the registry. `permissions.allow` in settings.json is pure auto-approval and never removes, demotes, or hides a tool (#10075). To keep a tool's schema out of the initial model request, use `tools.eager` in settings.json (requires restart, #9827) — `tool_search`, `tool_call`, `structured_output`, plan-mode lifecycle tools, `task_stop`, `mcp__*` and `computer_use__*` tools are exempt from that allowlist and keep their normal loading; tools demoted this way stay registered and reachable through `tool_search` + `tool_call` while both bridge tools are registered — when either is unregistered (`tools.toolSearch.enabled: false` denies both; a `tool_search` or `tool_call` deny rule, or a `tools.disabled` entry removes one) the demoted tools that remain hidden are out of reach for that session and a warning is logged — except tools also listed in `tools.visible`, which are declared upfront, and resumed sessions, which re-declare demoted tools referenced by direct calls in the transcript; to remove a tool entirely, use a whole-tool `excludeTools` / `permissions.deny` rule — a rule with a specifier (such as `'Bash(rm *)'`) only denies matching invocations at runtime. MCP tools are exempt from deny-based removal: hide them with the per-server `excludeTools` / `tools.disabled` filters instead (deny still blocks their calls at runtime). Example: `['read_file', 'edit', 'run_shell_command']`. |
| `excludeTools`           | `string[]`                                                           | -                | Equivalent to `permissions.deny` in settings.json. Excluded tools return a permission error immediately. Takes highest priority over all other permission settings. Supports tool name aliases and pattern matching: tool name (`'write_file'`), shell command prefix (`'Bash(rm *)'`), or path patterns (`'Read(.env)'`, `'Edit(/src/**)'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `allowedTools`           | `string[]`                                                           | -                | Equivalent to `permissions.allow` in settings.json for auto-approval. Matching tools bypass `canUseTool` callback and execute automatically. Only applies when tool requires confirmation. Like `permissions.allow`, this is pure auto-approval and never affects which tools are registered or which schemas are sent (#10075). Supports same pattern matching as `excludeTools`. Example: `['Bash(git status)', 'Bash(npm test)']`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `authType`               | `'openai' \| 'anthropic' \| 'qwen-oauth' \| 'gemini' \| 'vertex-ai'` | -                | Authentication type for the AI service. When provided, the SDK forwards it to the CLI as `--auth-type`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `agents`                 | `SubagentConfig[]`                                                   | -                | Configuration for subagents that can be invoked during the session. Subagents are specialized AI agents for specific tasks or domains.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `includePartialMessages` | `boolean`                                                            | `false`          | When `true`, the SDK emits incomplete messages as they are being generated, allowing real-time streaming of the AI's response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `resume`                 | `string`                                                             | -                | Resume a previous session by providing its session ID. Equivalent to CLI's `--resume` flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `sessionId`              | `string`                                                             | -                | Specify a session ID for the new session. Ensures SDK and CLI use the same ID without resuming history. Equivalent to CLI's `--session-id` flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

> [!note]
> For `coreTools`, aliases like `Read`, `Edit`, and `Bash` also work, but invocation specifiers such as `Bash(git *)` are stripped. `coreTools` restricts tool registration, not invocation patterns.

### Timeouts

The SDK enforces the following default timeouts:

| Timeout          | Default  | Description                                                                                                                                       |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canUseTool`     | 1 minute | Maximum time for `canUseTool` callback to respond. If exceeded, the tool request is auto-denied.                                                  |
| `mcpRequest`     | 1 minute | Maximum time for SDK MCP tool calls to complete.                                                                                                  |
| `controlRequest` | 1 minute | Maximum time for control operations like `initialize()`, `setModel()`, `setPermissionMode()`, `getContextUsage()`, and `interrupt()` to complete. |
| `streamClose`    | 1 minute | Maximum time to wait for initialization to complete before closing CLI stdin in multi-turn mode with SDK MCP servers.                             |

You can customize these timeouts via the `timeout` option:

```typescript
import { query } from '@qwen-code/sdk';

const q = query({
  prompt: 'Your prompt',
  options: {
    timeout: {
      canUseTool: 60000, // 60 seconds for permission callback
      mcpRequest: 600000, // 10 minutes for MCP tool calls
      controlRequest: 60000, // 60 seconds for control requests
      streamClose: 15000, // 15 seconds for stream close wait
    },
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

// Get context window usage breakdown (token counts per category)
const usage = await q.getContextUsage();
// Pass true to hint that per-item details should be displayed
const detail = await q.getContextUsage(true);

// Close the session
await q.close();
```

`interrupt()` cancels only the active turn. For a multi-turn query created with
an async iterable prompt, the query and its input stream remain open, so later
messages from the iterable are processed normally. Use `close()` or abort the
configured `AbortController` when you want to end the entire session.

## Daemon caller-supplied session IDs

`DaemonClient.createOrAttachSession` accepts an optional `sessionId` for callers that must persist an identity before session creation:

```typescript
import { DaemonClient } from '@qwen-code/sdk';

const daemon = new DaemonClient({ baseUrl: 'http://127.0.0.1:4170' });
const session = await daemon.createOrAttachSession({
  workspaceCwd: '/path/to/project',
  sessionId: '550E8400-E29B-41D4-A716-446655440000',
});

console.log(session.sessionId); // 550e8400-e29b-41d4-a716-446655440000
```

The SDK requires the daemon's `session_id_override` capability before sending the mutation. REST mode serializes `sessionId` directly; an active ACP adapter maps it to `session/new._meta["qwen-code/sessionId"]`. The SDK verifies the success response and throws `DaemonSessionIdProtocolError` if the daemon returns a different ID.

This option always creates a new thread session and is not an idempotent attach. If the create outcome is ambiguous, use the known ID with load or resume. Omitting the option preserves the existing create-or-attach behavior.

## Permission Modes

The SDK supports different permission modes for controlling tool execution:

- **`default`**: Write tools are denied unless approved via `canUseTool` callback or in `allowedTools`. Read-only tools execute without confirmation.
- **`plan`**: Blocks all write tools, instructing AI to present a plan first.
- **`auto-edit`**: Auto-approve edit tools (`edit`, `write_file`, `notebook_edit`) while other tools require confirmation.
- **`auto`**: Uses the built-in classifier to auto-approve safe tool calls and block risky ones, with manual-approval fallback after repeated policy blocks or classifier outages.
- **`yolo`**: All tools execute automatically without confirmation.

### Permission Priority Chain

Decision priority (highest first): `deny` > `ask` > `allow` > _(default/interactive mode)_

The first matching rule wins.

1. `excludeTools` / `permissions.deny` - Blocks tools completely (returns permission error)
2. `permissions.ask` - Always requires user confirmation
3. `permissionMode: 'plan'` - Blocks all non-read-only tools
4. `permissionMode: 'yolo'` - Auto-approves all tools
5. `allowedTools` / `permissions.allow` - Auto-approves matching tools
6. `permissionMode: 'auto'` - Classifier-mediated approval for remaining tools
7. `canUseTool` callback - Custom approval logic (if provided, not called for allowed tools)
8. Default behavior - Auto-deny in SDK mode (write tools require explicit approval)

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

### Override the System Prompt

```typescript
import { query } from '@qwen-code/sdk';

const result = query({
  prompt: 'Say hello in one sentence.',
  options: {
    systemPrompt: 'You are a terse assistant. Answer in exactly one sentence.',
  },
});
```

### Append to the Built-in System Prompt

```typescript
import { query } from '@qwen-code/sdk';

const result = query({
  prompt: 'Review the current directory.',
  options: {
    systemPrompt: {
      type: 'preset',
      preset: 'qwen_code',
      append: 'Be terse and focus on concrete findings.',
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
