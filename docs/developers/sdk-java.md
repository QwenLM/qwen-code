# Qwen Code Java SDK

The Qwen Code Java SDK is a minimum experimental SDK for programmatic access to Qwen Code functionality. It provides a Java interface to interact with the Qwen Code CLI, allowing developers to integrate Qwen Code capabilities into their Java applications.

## Requirements

- Java >= 1.8
- Maven >= 3.6.0 (for building from source)
- qwen-code >= 0.5.0

### Dependencies

- **Logging**: ch.qos.logback:logback-classic
- **Utilities**: org.apache.commons:commons-lang3
- **JSON Processing**: com.alibaba.fastjson2:fastjson2
- **Testing**: JUnit 5 (org.junit.jupiter:junit-jupiter)

## Installation

Add the following dependency to your Maven `pom.xml`:

```xml
<dependency>
    <groupId>com.alibaba</groupId>
    <artifactId>qwencode-sdk</artifactId>
    <version>{$version}</version>
</dependency>
```

Or if using Gradle, add to your `build.gradle`:

```gradle
implementation 'com.alibaba:qwencode-sdk:{$version}'
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

## Quick Start

The simplest way to use the SDK is through the `QwenCodeCli.simpleQuery()` method:

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
                public void onThinking(Session session, ThingkingAssistantContent thingkingAssistantContent) {
                    logger.info("Thinking content received: {}", thingkingAssistantContent.getThinking());
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

## Architecture

The SDK follows a layered architecture:

- **API Layer**: Provides the main entry points through `QwenCodeCli` class with simple static methods for basic usage
- **Session Layer**: Manages communication sessions with the Qwen Code CLI through the `Session` class
- **Transport Layer**: Handles the communication mechanism between the SDK and CLI process (currently using process transport via `ProcessTransport`)
- **Protocol Layer**: Defines data structures for communication based on the CLI protocol
- **Utils**: Common utilities for concurrent execution, timeout handling, and error management

## Key Features

### Permission Modes

The SDK supports different permission modes for controlling tool execution:

- **`default`**: Write tools are denied unless approved via `canUseTool` callback or in `allowedTools`. Read-only tools execute without confirmation.
- **`plan`**: Blocks all write tools, instructing AI to present a plan first.
- **`auto-edit`**: Auto-approve edit tools (edit, write_file) while other tools require confirmation.
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
- `onThinking`: Handles thinking content (receives Session and ThingkingAssistantContent)
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
- `skillsEnable`: Enables or disables skills functionality for the session
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

### Q: Do I need to install the Qwen CLI separately?

A: yes, requires Qwen CLI 0.5.5 or higher.

### Q: What Java versions are supported?

A: The SDK requires Java 1.8 or higher.

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
