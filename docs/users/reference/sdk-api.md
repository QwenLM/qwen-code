# SDK API Reference

Complete API reference for `@qwen-code/sdk`. For a guided introduction, see the [TypeScript SDK](../../developers/sdk-typescript.md) developer guide.

## Installation

```bash
npm install @qwen-code/sdk
```

Requires Node.js >= 20.0.0 and Qwen Code >= 0.4.0 installed in PATH.

## query()

Creates a new query session with the Qwen Code CLI.

```typescript
import { query } from '@qwen-code/sdk';

const conversation = query({
  prompt: 'What files are in the current directory?',
  options: { cwd: '/path/to/project' },
});

for await (const message of conversation) {
  // process messages
}
```

### Parameters

| Parameter | Type                                      | Description                                                  |
| --------- | ----------------------------------------- | ------------------------------------------------------------ |
| `prompt`  | `string \| AsyncIterable<SDKUserMessage>` | String for single-turn, async iterable for multi-turn        |
| `options` | `QueryOptions`                            | Session configuration (all fields optional, see table below) |

### Return value

Returns a `Query` instance that implements `AsyncIterable<SDKMessage>`. Iterate with `for await...of` to receive messages.

---

## QueryOptions

All fields are optional.

### Core options

| Option                   | Type                                     | Default          | Description                                                                                                    |
| ------------------------ | ---------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `cwd`                    | `string`                                 | `process.cwd()`  | Working directory for file operations and commands                                                             |
| `model`                  | `string`                                 | -                | Model ID (e.g., `'qwen-max'`, `'qwen-plus'`)                                                                   |
| `pathToQwenExecutable`   | `string`                                 | Auto-detected    | Path to Qwen Code binary. See [SDK guide](../../developers/sdk-typescript.md#queryoptions) for detection logic |
| `env`                    | `Record<string, string>`                 | -                | Environment variables merged into CLI process                                                                  |
| `systemPrompt`           | `string \| QuerySystemPromptPreset`      | -                | Override or extend the built-in system prompt                                                                  |
| `maxSessionTurns`        | `number`                                 | `-1` (unlimited) | Max conversation turns before auto-termination                                                                 |
| `debug`                  | `boolean`                                | `false`          | Enable verbose logging from CLI                                                                                |
| `logLevel`               | `'debug' \| 'info' \| 'warn' \| 'error'` | `'error'`        | SDK log verbosity                                                                                              |
| `stderr`                 | `(message: string) => void`              | -                | Handler for CLI stderr output                                                                                  |
| `abortController`        | `AbortController`                        | Auto-created     | Call `.abort()` to terminate the session                                                                       |
| `includePartialMessages` | `boolean`                                | `false`          | Emit streaming events as they arrive                                                                           |

### Permission options

| Option           | Type                                           | Default     | Description                                                                     |
| ---------------- | ---------------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `permissionMode` | `'default' \| 'plan' \| 'auto-edit' \| 'yolo'` | `'default'` | Tool execution approval strategy                                                |
| `canUseTool`     | `CanUseTool`                                   | -           | Custom permission callback (see below)                                          |
| `allowedTools`   | `string[]`                                     | -           | Tools auto-approved without confirmation                                        |
| `excludeTools`   | `string[]`                                     | -           | Tools blocked completely (highest priority)                                     |
| `coreTools`      | `string[]`                                     | -           | If set, only these tools are available                                          |
| `authType`       | `AuthType`                                     | `'openai'`  | Auth type: `'openai'`, `'anthropic'`, `'qwen-oauth'`, `'gemini'`, `'vertex-ai'` |

### Session options

| Option          | Type      | Default        | Description                                     |
| --------------- | --------- | -------------- | ----------------------------------------------- |
| `resume`        | `string`  | -              | Session ID to resume (loads prior conversation) |
| `sessionId`     | `string`  | Auto-generated | Explicit session ID for SDK-CLI alignment       |
| `chatRecording` | `boolean` | `true`         | Set to `false` to disable session persistence   |
| `sandbox`       | `boolean` | `false`        | Isolated execution with restricted file access  |

### Agent and tool options

| Option        | Type                              | Default | Description                                                                                     |
| ------------- | --------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `agents`      | `SubagentConfig[]`                | -       | Subagent configurations. See [Sub-Agents](../features/sub-agents.md#sdk-subagent-configuration) |
| `mcpServers`  | `Record<string, McpServerConfig>` | -       | MCP servers (external or SDK-embedded)                                                          |
| `extensions`  | `string[]`                        | -       | Extension names to enable                                                                       |
| `includeDirs` | `string[]`                        | -       | Additional workspace directories                                                                |

### Hook options

| Option          | Type                                                         | Default | Description                                                                   |
| --------------- | ------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------- |
| `hooks`         | `boolean`                                                    | `false` | Enable CLI hook system. Auto-enabled when `hookCallbacks` is set              |
| `hookCallbacks` | `Partial<Record<HookEvent, HookCallback \| HookCallback[]>>` | -       | SDK-side hook callbacks. See [Hooks](../features/hooks.md#sdk-hook-callbacks) |

### Web search options

| Option      | Type     | Default | Description                                                                 |
| ----------- | -------- | ------- | --------------------------------------------------------------------------- |
| `webSearch` | `object` | -       | `{ tavilyApiKey?, googleApiKey?, googleSearchEngineId?, defaultProvider? }` |

### Timeout options

All values in milliseconds. Pass via `timeout` object.

| Key              | Default | Description                                          |
| ---------------- | ------- | ---------------------------------------------------- |
| `canUseTool`     | `60000` | Max time for permission callback                     |
| `mcpRequest`     | `60000` | Max time for SDK MCP tool calls                      |
| `controlRequest` | `60000` | Max time for control operations (init, model change) |
| `streamClose`    | `60000` | Max wait before closing stdin in multi-turn mode     |

---

## Query instance

The object returned by `query()`.

### Methods

| Method                     | Return          | Description                        |
| -------------------------- | --------------- | ---------------------------------- |
| `getSessionId()`           | `string`        | The session ID for this query      |
| `isClosed()`               | `boolean`       | Whether the session has ended      |
| `interrupt()`              | `Promise<void>` | Interrupt the current operation    |
| `setPermissionMode(mode)`  | `Promise<void>` | Change permission mode mid-session |
| `setModel(model)`          | `Promise<void>` | Change model mid-session           |
| `close()`                  | `Promise<void>` | Terminate the session              |
| `[Symbol.asyncIterator]()` | `AsyncIterator` | Iterate over `SDKMessage` objects  |

---

## Message types

All messages extend a common shape with `type`, `uuid`, and `session_id`.

### SDKAssistantMessage

Emitted when the model produces a response.

```typescript
{
  type: 'assistant';
  uuid: string;
  session_id: string;
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    content: ContentBlock[];
    stop_reason?: string | null;
    usage: Usage;
  };
  parent_tool_use_id: string | null;
}
```

### SDKUserMessage

Echoed back when a user message is processed.

```typescript
{
  type: 'user';
  uuid?: string;
  session_id: string;
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: string | null;
}
```

### SDKSystemMessage

System events (session init, compaction, etc.).

```typescript
{
  type: 'system';
  subtype: string;
  uuid: string;
  session_id: string;
  data?: unknown;
  cwd?: string;
  tools?: string[];
  model?: string;
  permission_mode?: string;
  // ... additional optional fields
}
```

### SDKResultMessage

Terminal message when the session ends.

**Success variant:**

```typescript
{
  type: 'result';
  subtype: 'success';
  is_error: false;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  usage: ExtendedUsage;
  modelUsage?: Record<string, ModelUsage>;
  permission_denials: CLIPermissionDenial[];
}
```

**Error variant:**

```typescript
{
  type: 'result';
  subtype: 'error_max_turns' | 'error_during_execution';
  is_error: true;
  duration_ms: number;
  num_turns: number;
  error?: { type?: string; message: string };
  usage: ExtendedUsage;
  permission_denials: CLIPermissionDenial[];
}
```

### SDKPartialAssistantMessage

Streaming tokens (only when `includePartialMessages: true`).

```typescript
{
  type: 'stream_event';
  uuid: string;
  session_id: string;
  event: StreamEvent;
  parent_tool_use_id: string | null;
}
```

`StreamEvent` is one of: `MessageStartStreamEvent`, `ContentBlockStartEvent`, `ContentBlockDeltaEvent`, `ContentBlockStopEvent`, `MessageStopStreamEvent`.

### SDKTaskEvent

Task lifecycle event. Check with `isTaskEvent()`.

```typescript
{
  type: 'system';
  subtype: 'task_event';
  data: {
    action: 'created' | 'updated' | 'completed' | 'claimed' | 'stopped';
    task: { id: string; title: string; status: string; assignee?: string; parentId?: string };
  };
}
```

### SDKMemoryEvent

Memory lifecycle event. Check with `isMemoryEvent()`.

```typescript
{
  type: 'system';
  subtype: 'memory_event';
  data: {
    action: 'saved' | 'updated' | 'deleted';
    memory: {
      name: string;
      type: string;
      file: string;
    }
  }
}
```

---

## Content blocks

The `content` array in assistant messages contains these block types:

| Type              | Key fields                                     | Description     |
| ----------------- | ---------------------------------------------- | --------------- |
| `TextBlock`       | `text: string`                                 | Text content    |
| `ThinkingBlock`   | `thinking: string`                             | Model reasoning |
| `ToolUseBlock`    | `id: string`, `name: string`, `input`          | Tool invocation |
| `ToolResultBlock` | `tool_use_id: string`, `content?`, `is_error?` | Tool result     |

---

## Type guards

All type guards accept `unknown` and return a type predicate.

| Guard                               | Narrows to                   |
| ----------------------------------- | ---------------------------- |
| `isSDKUserMessage(msg)`             | `SDKUserMessage`             |
| `isSDKAssistantMessage(msg)`        | `SDKAssistantMessage`        |
| `isSDKSystemMessage(msg)`           | `SDKSystemMessage`           |
| `isSDKResultMessage(msg)`           | `SDKResultMessage`           |
| `isSDKPartialAssistantMessage(msg)` | `SDKPartialAssistantMessage` |
| `isTaskEvent(msg)`                  | `SDKTaskEvent`               |
| `isMemoryEvent(msg)`                | `SDKMemoryEvent`             |
| `isControlRequest(msg)`             | `CLIControlRequest`          |
| `isControlResponse(msg)`            | `CLIControlResponse`         |
| `isControlCancel(msg)`              | `ControlCancelRequest`       |
| `isTextBlock(block)`                | `TextBlock`                  |
| `isThinkingBlock(block)`            | `ThinkingBlock`              |
| `isToolUseBlock(block)`             | `ToolUseBlock`               |
| `isToolResultBlock(block)`          | `ToolResultBlock`            |
| `isSdkMcpServerConfig(config)`      | `SDKMcpServerConfig`         |

---

## Callback types

### CanUseTool

Custom permission handler invoked when a tool requires confirmation.

```typescript
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionSuggestion[] | null;
  },
) => Promise<PermissionResult>;
```

**Return:**

```typescript
// Allow
{ behavior: 'allow'; updatedInput: Record<string, unknown> }

// Deny
{ behavior: 'deny'; message: string; interrupt?: boolean }
```

### HookCallback

SDK-side hook callback invoked when a hook event fires.

```typescript
type HookCallback = (
  input: unknown,
  toolUseId: string | null,
) => Promise<HookCallbackResult> | HookCallbackResult;
```

**Return (`HookCallbackResult`):**

| Field             | Type      | Effect                                  |
| ----------------- | --------- | --------------------------------------- |
| `shouldSkip`      | `boolean` | Skip this tool call (`PreToolUse` only) |
| `shouldInterrupt` | `boolean` | Stop the agent immediately              |
| `suppressOutput`  | `boolean` | Hide tool output from conversation      |
| `message`         | `string`  | Feedback string sent to the agent       |

---

## SubagentConfig

Configuration for subagents passed via the `agents` option.

| Field                        | Required | Type        | Description                          |
| ---------------------------- | -------- | ----------- | ------------------------------------ |
| `name`                       | Yes      | `string`    | Unique identifier                    |
| `description`                | Yes      | `string`    | When to delegate to this agent       |
| `systemPrompt`               | Yes      | `string`    | System prompt for the subagent       |
| `level`                      | Yes      | `'session'` | Subagent scope                       |
| `tools`                      | No       | `string[]`  | Tool allowlist. Omit to inherit all. |
| `modelConfig.model`          | No       | `string`    | Model ID or alias                    |
| `modelConfig.temp`           | No       | `number`    | Temperature (0-2)                    |
| `runConfig.max_turns`        | No       | `number`    | Maximum agentic turns                |
| `runConfig.max_time_minutes` | No       | `number`    | Maximum execution time in minutes    |
| `color`                      | No       | `string`    | Display color                        |

---

## MCP server configuration

The `mcpServers` option accepts a record of server configs. Each value is either a `CLIMcpServerConfig` (external) or `SDKMcpServerConfig` (in-process).

### External servers (CLIMcpServerConfig)

| Field          | Type                     | Description                         |
| -------------- | ------------------------ | ----------------------------------- |
| `command`      | `string`                 | Stdio transport: executable command |
| `args`         | `string[]`               | Command arguments                   |
| `env`          | `Record<string, string>` | Environment variables for process   |
| `cwd`          | `string`                 | Working directory for process       |
| `url`          | `string`                 | SSE transport URL                   |
| `httpUrl`      | `string`                 | Streamable HTTP transport URL       |
| `headers`      | `Record<string, string>` | HTTP headers                        |
| `tcp`          | `string`                 | WebSocket transport address         |
| `timeout`      | `number`                 | Connection timeout (ms)             |
| `trust`        | `boolean`                | Trust this server (skip prompts)    |
| `includeTools` | `string[]`               | Only expose these tools             |
| `excludeTools` | `string[]`               | Hide these tools                    |
| `description`  | `string`                 | Human-readable server description   |

### SDK-embedded servers (SDKMcpServerConfig)

Created via `createSdkMcpServer()`. Runs in the SDK process with in-memory transport.

```typescript
import { tool, createSdkMcpServer } from '@qwen-code/sdk';

const myTool = tool('my_tool', 'Does something', { input: z.string() }, handler);
const server = createSdkMcpServer({ name: 'my-server', tools: [myTool] });

// Pass directly to mcpServers
mcpServers: { 'my-server': server }
```

---

## SDK MCP helpers

### tool()

Creates a tool definition with Zod schema type inference.

```typescript
function tool(
  name: string,
  description: string,
  inputSchema: ZodRawShape,
  handler: (
    args: Inferred,
    extra: RequestHandlerExtra,
  ) => Promise<CallToolResult>,
): SdkMcpToolDefinition;
```

### createSdkMcpServer()

Creates an SDK-embedded MCP server.

```typescript
function createSdkMcpServer(options: {
  name: string;
  version?: string; // default '1.0.0'
  tools: SdkMcpToolDefinition[];
}): McpSdkServerConfigWithInstance;
```

---

## Error handling

### AbortError

Thrown when a session is aborted via `AbortController`.

```typescript
import { isAbortError } from '@qwen-code/sdk';

try {
  for await (const message of conversation) {
    /* ... */
  }
} catch (error) {
  if (isAbortError(error)) {
    console.log('Session was aborted');
  }
}
```

---

## Exported types

All types are available as named imports from `@qwen-code/sdk`:

**Message types:** `SDKMessage`, `SDKUserMessage`, `SDKAssistantMessage`, `SDKSystemMessage`, `SDKResultMessage`, `SDKPartialAssistantMessage`, `SDKTaskEvent`, `SDKMemoryEvent`

**Content types:** `ContentBlock`, `TextBlock`, `ThinkingBlock`, `ToolUseBlock`, `ToolResultBlock`

**Config types:** `QueryOptions`, `QuerySystemPrompt`, `QuerySystemPromptPreset`, `SubagentConfig`, `SubagentLevel`, `ModelConfig`, `RunConfig`, `McpServerConfig`, `CLIMcpServerConfig`, `SDKMcpServerConfig`, `McpOAuthConfig`, `McpAuthProviderType`

**Permission types:** `PermissionMode`, `CanUseTool`, `PermissionResult`

**Hook types:** `HookEvent`, `HookCallback`, `HookCallbackResult`, `HookRegistration`

**Control protocol types:** `ControlMessage`, `CLIControlRequest`, `CLIControlResponse`, `ControlCancelRequest`

**Utility types:** `Usage`, `ExtendedUsage`, `ModelUsage`, `CLIPermissionDenial`, `StreamEvent`

**Functions:** `query`, `tool`, `createSdkMcpServer`, `isSdkMcpServerConfig`, `isAbortError`, `SdkLogger`

**Type guards:** `isSDKUserMessage`, `isSDKAssistantMessage`, `isSDKSystemMessage`, `isSDKResultMessage`, `isSDKPartialAssistantMessage`, `isTaskEvent`, `isMemoryEvent`, `isControlRequest`, `isControlResponse`, `isControlCancel`, `isTextBlock`, `isThinkingBlock`, `isToolUseBlock`, `isToolResultBlock`
