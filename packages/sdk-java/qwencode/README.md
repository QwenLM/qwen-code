# Qwen Code Java SDK

The Qwen Code Java SDK provides a recommended daemon transport for `qwen serve` and retains the experimental legacy stdio API for compatibility. Both APIs ship in the same `com.alibaba:qwencode-sdk` artifact.

## Requirements

- Java >= 11 for `0.1.0-alpha`
- Maven >= 3.9.2 when building or publishing this SDK from source
- A compatible `qwen serve` for the daemon API, or qwen-code >= 0.5.0 for the legacy stdio API

### Dependencies

- **Logging API**: org.slf4j:slf4j-api (choose an SLF4J provider in your application)
- **Utilities**: org.apache.commons:commons-lang3
- **JSON Processing**: Fastjson2 for encoding and Jackson Core for strict decoding
- **Testing**: JUnit 5 (org.junit.jupiter:junit-jupiter)

## Installation

Add the following dependency to your Maven `pom.xml`:

```xml
<dependency>
    <groupId>com.alibaba</groupId>
    <artifactId>qwencode-sdk</artifactId>
    <version>0.1.0-alpha</version>
</dependency>
```

Or if using Gradle, add to your `build.gradle`:

```gradle
implementation 'com.alibaba:qwencode-sdk:0.1.0-alpha'
```

## Building and Running

### Build Commands

```bash
# Compile the project
mvn compile

# Run tests
mvn test

# Package the JAR
mvn package

# Install to local repository
mvn install
```

### Real daemon E2E from source

Run the real-daemon Java integration tests from the repository root after building both the workspaces and the root CLI bundle:

```bash
npm run build
npm run bundle
npx tsx scripts/run-java-daemon-sdk-e2e.ts
```

`npm run build` alone does not refresh `dist/cli.js`; the E2E harness launches that bundle and fails with an explicit prerequisite error when it is missing.

## Recommended daemon API

Start `qwen serve`, then create an independent thread-scoped session. `promptText` returns only after a matching `turn_complete`; incomplete streams fail with `PromptOutcomeIndeterminateException` rather than returning partial text as success.

For the lifecycle guarantees assumed by `0.1.0-alpha`, use the qwen-code build released from the same source revision as the SDK. The daemon must contain the idempotent per-client detach ledger from [#7386](https://github.com/QwenLM/qwen-code/pull/7386), the per-epoch terminal guarantee from [#7400](https://github.com/QwenLM/qwen-code/pull/7400), restart-safe event cursor epochs from [#7458](https://github.com/QwenLM/qwen-code/pull/7458), and this release's acknowledged admission cancellation plus FIFO cancel-drain fence. The #7400 commit alone is not sufficient: a same-wire daemon can acknowledge cancel before agent dispatch without stopping the admitted prompt, or let an unacknowledged session-scoped cancel reach a queued successor. The bundled ACP child uses one acknowledged admission-aware cancellation handshake; a custom standards-compliant ACP child without that extension receives one standard `session/cancel` notification. Feature negotiation cannot distinguish older same-wire daemon builds, so the SDK fails closed rather than reporting partial output as success.

The bundled cancellation handshake deliberately waits for the targeted prompt call to settle before the daemon dispatches its queued successor. It has no timeout that merely acknowledges cancellation: doing so could let a late session-scoped cancel reach the next prompt. If a provider, tool, or custom integration ignores its `AbortSignal` indefinitely, the cancel mutation can therefore remain outcome-unknown and that session must not be reused. Treat a formal prompt terminal received within the caller's observation boundary as authoritative; otherwise close or destroy the session after observation fails. Recovering a wedged shared ACP child without disturbing its sibling sessions requires stronger runtime isolation and is outside this alpha contract.

```java
import com.alibaba.qwen.code.daemon.DaemonClient;
import com.alibaba.qwen.code.daemon.DaemonSessionClient;
import com.alibaba.qwen.code.daemon.PromptTextResult;
import java.net.URI;

try (DaemonClient daemon = DaemonClient.builder()
        .baseUri(URI.create("http://127.0.0.1:4170"))
        .build();
     DaemonSessionClient session = daemon.createSession()) {
    PromptTextResult result = session.promptText("Explain this repository");
    System.out.println(result.getText());
}
```

If `qwen serve` requires authentication, add
`.bearerToken(System.getenv("QWEN_SERVER_TOKEN"))` to the `DaemonClient`
builder. The SDK sends the bearer on REST and SSE requests and never puts it in
the URL.

Use `startPrompt` with a `PromptObserver` when you need ordered text, thought, tool, usage, permission, and raw event callbacks. Its `acceptanceFuture()` and `completionFuture()` views separately expose daemon admission and the reliable turn terminal. `respondToPermission()` returns `false` when the request was already resolved or no longer pending. Cancelling the future views does not cancel the daemon prompt; use `cancelActivePrompt()` for the session-level daemon cancel operation and still wait for the matching terminal. A cooperative cancellation completes with `turn_complete` and `stopReason=cancelled`; `promptText()` returns its `PromptTextResult`, so callers that distinguish cancellation must inspect `result.getTerminal().getStopReason()`. If the agent or provider fails while cancelling, the daemon can instead publish `turn_error`, which makes `promptText()` throw `PromptTurnException`.

When cancellation, deadline, teardown, or agent settlement race, the daemon's exactly-once latch publishes the first formal terminal and suppresses later candidates. Always branch on the received terminal itself; the last control mutation sent by the client does not determine the terminal kind or error code.

The SSE transport sends `Accept-Encoding: identity` and `Last-Event-ID`, pairs the cursor with `X-Qwen-Event-Epoch` when the daemon supplies an epoch, validates framing and event IDs, deduplicates replay, and reconnects only the SSE GET. It learns an epoch from the validated prompt admission or SSE response headers and fails closed if the epoch changes during prompt observation. Older daemons that omit both surfaces remain compatible but retain their numeric-only stale-cursor detection. Prompt and other mutation requests are never retried automatically. HTTP 408 and 5xx responses to prompt admission, session creation, permission, cancel, heartbeat, detach, or delete are reported as outcome-unknown because they do not prove that the daemon rejected the mutation. Finite response bodies and SSE observation have independent deadlines.

Creation-time model selection is intentionally not exposed by the Java daemon SDK API in this alpha. The daemon reports a rejected `modelServiceId` only as an SSE event emitted before the create response, while this SDK opens its stream from the later prompt-admission watermark. Until the daemon returns a definitive create result or the SDK owns a separate session-event subscription from `Last-Event-ID: 0`, use the daemon's configured default model.

`PromptRequest.Builder.deadline(Duration)` requests a daemon-enforced prompt deadline and is accepted only when the daemon advertises `prompt_absolute_deadline`; otherwise the SDK fails before sending the prompt. The value must be between 1 and 2,147,483,647 milliseconds, matching the daemon's Node timer range. This is separate from `observationTimeout(Duration)`, which only bounds local SSE observation and never sends a cancel mutation.

Before creating a session, the SDK requires the daemon to advertise the REST transport and `session_scope_override`; this prevents an older daemon from silently ignoring the requested `thread` scope and attaching the client to a shared session. When `client_heartbeat` is advertised, an open session sends a fresh heartbeat every minute so the daemon does not reap an otherwise idle client. Set `heartbeatInterval(Duration.ZERO)` on the `DaemonClient` builder to disable this behavior, or choose a different positive interval. A heartbeat is never retried; the next scheduled heartbeat is a separate keepalive. Prompt observation is bounded to 32 concurrent prompts per client by default and can be adjusted with `maximumConcurrentPrompts`. Admission and terminal future callbacks run away from transport workers; callbacks that remain blocked consume bounded publication capacity. SSE stream cleanup is also bounded, and a close that remains blocked retains its cleanup reservation. Either condition can cause a later `startPrompt` to fail with `DaemonClientCapacityException` rather than dropping a timeout close or growing threads and queued work without limit.

An indeterminate completion is an outcome boundary, not a session-reuse boundary. After `PromptAdmissionUnknownException` or `PromptOutcomeIndeterminateException`, that `DaemonSessionClient` permanently rejects further prompts even if local stream cleanup later succeeds; close or destroy the session instead. An observation timeout is published without waiting forever for a blocked stream close, while cleanup continues asynchronously and retains bounded client capacity until it finishes.

## Legacy stdio API

The existing `com.alibaba.qwen.code.cli` API remains available:

```java
public static void runSimpleExample() {
    List<String> result = QwenCodeCli.simpleQuery("hello world");
    result.forEach(logger::info);
}
```

For more advanced usage with custom transport options:

```java
public static void runTransportOptionsExample() {
    TransportOptions options = new TransportOptions()
            .setModel("qwen3-coder-flash")
            .setPermissionMode(PermissionMode.AUTO_EDIT)
            .setCwd("./")
            .setEnv(new HashMap<String, String>() {{put("CUSTOM_VAR", "value");}})
            .setIncludePartialMessages(true)
            .setTurnTimeout(new Timeout(120L, TimeUnit.SECONDS))
            .setMessageTimeout(new Timeout(90L, TimeUnit.SECONDS))
            .setAllowedTools(Arrays.asList("read_file", "write_file", "list_directory"));

    List<String> result = QwenCodeCli.simpleQuery("who are you, what are your capabilities?", options);
    result.forEach(logger::info);
}
```

For streaming content handling with custom content consumers:

```java
public static void runStreamingExample() {
    QwenCodeCli.simpleQuery("who are you, what are your capabilities?",
            new TransportOptions().setMessageTimeout(new Timeout(10L, TimeUnit.SECONDS)), new AssistantContentSimpleConsumers() {

                @Override
                public void onText(Session session, TextAssistantContent textAssistantContent) {
                    logger.info("Text content received: {}", textAssistantContent.getText());
                }

                @Override
                public void onThinking(Session session, ThinkingAssistantContent thinkingAssistantContent) {
                    logger.info("Thinking content received: {}", thinkingAssistantContent.getThinking());
                }

                @Override
                public void onToolUse(Session session, ToolUseAssistantContent toolUseContent) {
                    logger.info("Tool use content received: {} with arguments: {}",
                            toolUseContent, toolUseContent.getInput());
                }

                @Override
                public void onToolResult(Session session, ToolResultAssistantContent toolResultContent) {
                    logger.info("Tool result content received: {}", toolResultContent.getContent());
                }

                @Override
                public void onOtherContent(Session session, AssistantContent<?> other) {
                    logger.info("Other content received: {}", other);
                }

                @Override
                public void onUsage(Session session, AssistantUsage assistantUsage) {
                    logger.info("Usage information received: Input tokens: {}, Output tokens: {}",
                            assistantUsage.getUsage().getInputTokens(), assistantUsage.getUsage().getOutputTokens());
                }
            }.setDefaultPermissionOperation(Operation.allow));
    logger.info("Streaming example completed.");
}
```

other examples see src/test/java/com/alibaba/qwen/code/cli/example

## Java 11 migration and alpha limits

`0.1.0-alpha` raises the minimum Java version for the whole artifact from 8 to 11. Java 8 applications must remain on `0.0.3-alpha`. Logback is no longer a runtime dependency; add the SLF4J provider your application uses.

This alpha deliberately fails closed when it cannot prove a prompt terminal. It detects a daemon event-epoch change during an observed prompt but does not automatically recover from it. It does not guarantee exactly-once execution across daemon restarts, automatic epoch recovery, snapshot/resync, persisted cursors, or true prompt-ID-targeted cancellation. `prompt_cancelled` and queue events are advisory; only matching `turn_complete` and `turn_error` are terminal.

If session creation has an ambiguous transport outcome, the daemon may retain a session whose ID never reached the caller. The SDK does not retry creation and cannot detach that unknown session; daemon-side lifecycle reaping is the recovery boundary.

## Architecture

The artifact contains two isolated implementations:

- **Daemon API**: `DaemonClient` and `DaemonSessionClient` use REST mutations plus resumable SSE and own bounded HTTP, prompt, maintenance, and timer resources.
- **Legacy stdio API**: `QwenCodeCli`, `Session`, and `ProcessTransport` manage a child CLI process using the existing CLI protocol DTOs and utilities.

The daemon implementation does not reuse the legacy process transport, session model, DTOs, or global executor.

## Legacy stdio features

### Permission Modes

The SDK supports different permission modes for controlling tool execution:

- **`default`**: Write tools are denied unless approved via `canUseTool` callback or in `allowedTools`. Read-only tools execute without confirmation.
- **`plan`**: Blocks all write tools, instructing AI to present a plan first.
- **`auto-edit`**: Auto-approve edit tools (`edit`, `write_file`, `notebook_edit`) while other tools require confirmation.
- **`yolo`**: All tools execute automatically without confirmation.

### Session Event Consumers and Assistant Content Consumers

The SDK provides two key interfaces for handling events and content from the CLI:

#### SessionEventConsumers Interface

The `SessionEventConsumers` interface provides callbacks for different types of messages during a session:

- `onSystemMessage`: Handles system messages from the CLI (receives Session and SDKSystemMessage)
- `onResultMessage`: Handles result messages from the CLI (receives Session and SDKResultMessage)
- `onAssistantMessage`: Handles assistant messages (AI responses) (receives Session and SDKAssistantMessage)
- `onPartialAssistantMessage`: Handles partial assistant messages during streaming (receives Session and SDKPartialAssistantMessage)
- `onUserMessage`: Handles user messages (receives Session and SDKUserMessage)
- `onOtherMessage`: Handles other types of messages (receives Session and String message)
- `onControlResponse`: Handles control responses (receives Session and CLIControlResponse)
- `onControlRequest`: Handles control requests (receives Session and CLIControlRequest, returns CLIControlResponse)
- `onPermissionRequest`: Handles permission requests (receives Session and CLIControlRequest<CLIControlPermissionRequest>, returns Behavior)

#### AssistantContentConsumers Interface

The `AssistantContentConsumers` interface handles different types of content within assistant messages:

- `onText`: Handles text content (receives Session and TextAssistantContent)
- `onThinking`: Handles thinking content (receives Session and ThinkingAssistantContent)
- `onToolUse`: Handles tool use content (receives Session and ToolUseAssistantContent)
- `onToolResult`: Handles tool result content (receives Session and ToolResultAssistantContent)
- `onOtherContent`: Handles other content types (receives Session and AssistantContent)
- `onUsage`: Handles usage information (receives Session and AssistantUsage)
- `onPermissionRequest`: Handles permission requests (receives Session and CLIControlPermissionRequest, returns Behavior)
- `onOtherControlRequest`: Handles other control requests (receives Session and ControlRequestPayload, returns ControlResponsePayload)

#### Relationship Between the Interfaces

**Important Note on Event Hierarchy:**

- `SessionEventConsumers` is the **high-level** event processor that handles different message types (system, assistant, user, etc.)
- `AssistantContentConsumers` is the **low-level** content processor that handles different types of content within assistant messages (text, tools, thinking, etc.)

**Processor Relationship:**

- `SessionEventConsumers` → `AssistantContentConsumers` (SessionEventConsumers uses AssistantContentConsumers to process content within assistant messages)

**Event Derivation Relationships:**

- `onAssistantMessage` → `onText`, `onThinking`, `onToolUse`, `onToolResult`, `onOtherContent`, `onUsage`
- `onPartialAssistantMessage` → `onText`, `onThinking`, `onToolUse`, `onToolResult`, `onOtherContent`
- `onControlRequest` → `onPermissionRequest`, `onOtherControlRequest`

**Event Timeout Relationships:**

Each event handler method has a corresponding timeout method that allows customizing the timeout behavior for that specific event:

- `onSystemMessage` ↔ `onSystemMessageTimeout`
- `onResultMessage` ↔ `onResultMessageTimeout`
- `onAssistantMessage` ↔ `onAssistantMessageTimeout`
- `onPartialAssistantMessage` ↔ `onPartialAssistantMessageTimeout`
- `onUserMessage` ↔ `onUserMessageTimeout`
- `onOtherMessage` ↔ `onOtherMessageTimeout`
- `onControlResponse` ↔ `onControlResponseTimeout`
- `onControlRequest` ↔ `onControlRequestTimeout`

For AssistantContentConsumers timeout methods:

- `onText` ↔ `onTextTimeout`
- `onThinking` ↔ `onThinkingTimeout`
- `onToolUse` ↔ `onToolUseTimeout`
- `onToolResult` ↔ `onToolResultTimeout`
- `onOtherContent` ↔ `onOtherContentTimeout`
- `onPermissionRequest` ↔ `onPermissionRequestTimeout`
- `onOtherControlRequest` ↔ `onOtherControlRequestTimeout`

**Default Timeout Values:**

- `SessionEventSimpleConsumers` default timeout: 180 seconds (Timeout.TIMEOUT_180_SECONDS)
- `AssistantContentSimpleConsumers` default timeout: 60 seconds (Timeout.TIMEOUT_60_SECONDS)

**Timeout Hierarchy Requirements:**

For proper operation, the following timeout relationships should be maintained:

- `onAssistantMessageTimeout` return value should be greater than `onTextTimeout`, `onThinkingTimeout`, `onToolUseTimeout`, `onToolResultTimeout`, and `onOtherContentTimeout` return values
- `onControlRequestTimeout` return value should be greater than `onPermissionRequestTimeout` and `onOtherControlRequestTimeout` return values

### Transport Options

The `TransportOptions` class allows configuration of how the SDK communicates with the Qwen Code CLI:

- `pathToQwenExecutable`: Path to the Qwen Code CLI executable
- `cwd`: Working directory for the CLI process
- `model`: AI model to use for the session
- `permissionMode`: Permission mode that controls tool execution
- `env`: Environment variables to pass to the CLI process
- `maxSessionTurns`: Limits the number of conversation turns in a session
- `coreTools`: List of core tools that should be available to the AI
- `excludeTools`: List of tools to exclude from being available to the AI
- `allowedTools`: List of tools that are pre-approved for use without additional confirmation
- `authType`: Authentication type to use for the session
- `includePartialMessages`: Enables receiving partial messages during streaming responses
- `turnTimeout`: Timeout for a complete turn of conversation
- `messageTimeout`: Timeout for individual messages within a turn
- `resumeSessionId`: ID of a previous session to resume
- `otherOptions`: Additional command-line options to pass to the CLI

### Session Control Features

- **Session creation**: Use `QwenCodeCli.newSession()` to create a new session with custom options
- **Session management**: The `Session` class provides methods to send prompts, handle responses, and manage session state
- **Session cleanup**: Always close sessions using `session.close()` to properly terminate the CLI process
- **Session resumption**: Use `setResumeSessionId()` in `TransportOptions` to resume a previous session
- **Session interruption**: Use `session.interrupt()` to interrupt a currently running prompt
- **Dynamic model switching**: Use `session.setModel()` to change the model during a session
- **Dynamic permission mode switching**: Use `session.setPermissionMode()` to change the permission mode during a session

### Thread Pool Configuration

The SDK uses a thread pool for managing concurrent operations with the following default configuration:

- **Core Pool Size**: 30 threads
- **Maximum Pool Size**: 100 threads
- **Keep-Alive Time**: 60 seconds
- **Queue Capacity**: 300 tasks (using LinkedBlockingQueue)
- **Thread Naming**: "qwen_code_cli-pool-{number}"
- **Daemon Threads**: false
- **Rejected Execution Handler**: CallerRunsPolicy

## Error Handling

The SDK provides specific exception types for different error scenarios:

- `SessionControlException`: Thrown when there's an issue with session control (creation, initialization, etc.)
- `SessionSendPromptException`: Thrown when there's an issue sending a prompt or receiving a response
- `SessionClosedException`: Thrown when attempting to use a closed session

## FAQ / Troubleshooting

### Q: What Java versions are supported?

A: `0.1.0-alpha` requires Java 11 or higher. Java 8 users must remain on `0.0.3-alpha`.

### Q: How do I handle long-running requests?

A: The SDK includes timeout utilities. You can configure timeouts using the `Timeout` class in `TransportOptions`.

### Q: Why are some tools not executing?

A: This is likely due to permission modes. Check your permission mode settings and consider using `allowedTools` to pre-approve certain tools.

### Q: How do I resume a previous session?

A: Use the `setResumeSessionId()` method in `TransportOptions` to resume a previous session.

### Q: Can I customize the environment for the CLI process?

A: Yes, use the `setEnv()` method in `TransportOptions` to pass environment variables to the CLI process.

## License

Apache-2.0 - see [LICENSE](./LICENSE) for details.
