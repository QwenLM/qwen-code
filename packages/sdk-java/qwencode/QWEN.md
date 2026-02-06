# Qwen Code Java SDK

## Project Overview

The Qwen Code Java SDK is a minimum experimental SDK for programmatic access to Qwen Code functionality. It provides a Java interface to interact with the Qwen Code CLI, allowing developers to integrate Qwen Code capabilities into their Java applications.

**Context Information:**

- Current Date: Monday 5 January 2026
- Operating System: darwin
- Working Directory: /Users/weigeng/repos/qwen-code/packages/sdk-java

## Project Details

- **Group ID**: com.alibaba
- **Artifact ID**: qwencode-sdk (as per pom.xml)
- **Version**: 0.0.1-SNAPSHOT
- **Packaging**: JAR
- **Java Version**: 1.8+ (source and target)
- **License**: Apache-2.0

## Architecture

The SDK follows a layered architecture:

- **API Layer**: Provides the main entry points through `QwenCodeCli` class with simple static methods for basic usage
- **Session Layer**: Manages communication sessions with the Qwen Code CLI through the `Session` class
- **Transport Layer**: Handles the communication mechanism between the SDK and CLI process (currently using process transport via `ProcessTransport`)
- **Protocol Layer**: Defines data structures for communication based on the CLI protocol
- **Utils**: Common utilities for concurrent execution, timeout handling, and error management

## Key Components

### Main Classes

- `QwenCodeCli`: Main entry point with static methods for simple queries
- `Session`: Manages communication sessions with the CLI
- `Transport`: Abstracts the communication mechanism (currently using process transport)
- `ProcessTransport`: Implementation that communicates via process execution
- `TransportOptions`: Configuration class for transport layer settings
- `SessionEventSimpleConsumers`: High-level event handler for processing responses
- `AssistantContentSimpleConsumers`: Handles different types of content within assistant messages

### Dependencies

- **Logging**: ch.qos.logback:logback-classic
- **Utilities**: org.apache.commons:commons-lang3
- **JSON Processing**: com.alibaba.fastjson2:fastjson2
- **Testing**: JUnit 5 (org.junit.jupiter:junit-jupiter)

## Building and Running

### Prerequisites

- Java 8 or higher
- Apache Maven 3.6.0 or higher

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

# Run checkstyle verification
mvn checkstyle:check

# Generate Javadoc
mvn javadoc:javadoc
```

### Testing

The project includes basic unit tests using JUnit 5. The main test class `QwenCodeCliTest` demonstrates how to use the SDK to make simple queries to the Qwen Code CLI.

### Code Quality

The project uses Checkstyle for code formatting and style enforcement. The configuration is defined in `checkstyle.xml` and includes rules for:

- Whitespace and indentation
- Naming conventions
- Import ordering
- Code structure
- Line endings (LF only)
- No trailing whitespace
- 8-space indentation for line wrapping

## Development Conventions

### Coding Standards

- Java 8 language features are supported
- Follow standard Java naming conventions
- Use UTF-8 encoding for source files
- Line endings should be LF (Unix-style)
- No trailing whitespace allowed
- Use 8-space indentation for line wrapping

### Testing Practices

- Write unit tests using JUnit 5
- Test classes should be in the `src/test/java` directory
- Follow the naming convention `*Test.java` for test classes
- Use appropriate assertions to validate functionality

### Documentation

- API documentation should follow Javadoc conventions
- Update README files when adding new features
- Include examples in documentation

## API Reference

### QwenCodeCli Class

The main class provides several primary methods:

- `simpleQuery(String prompt)`: Synchronous method that returns a list of responses
- `simpleQuery(String prompt, TransportOptions transportOptions)`: Synchronous method with custom transport options
- `simpleQuery(String prompt, TransportOptions transportOptions, AssistantContentConsumers assistantContentConsumers)`: Advanced method with custom content consumers
- `newSession()`: Creates a new session with default options
- `newSession(TransportOptions transportOptions)`: Creates a new session with custom options

### Permission Modes

The SDK supports different permission modes for controlling tool execution:

- **`default`**: Write tools are denied unless approved via `canUseTool` callback or in `allowedTools`. Read-only tools execute without confirmation.
- **`plan`**: Blocks all write tools, instructing AI to present a plan first.
- **`auto-edit`**: Auto-approve edit tools (edit, write_file) while other tools require confirmation.
- **`yolo`**: All tools execute automatically without confirmation.

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

#### Relationship Between the Interfaces

- `AssistantContentSimpleConsumers` is the default implementation of `AssistantContentConsumers`
- `SessionEventSimpleConsumers` is the concrete implementation that combines both interfaces and depends on an `AssistantContentConsumers` instance to handle content within assistant messages
- The timeout methods in `SessionEventConsumers` now include the message object as a parameter (e.g., `onSystemMessageTimeout(Session session, SDKSystemMessage systemMessage)`)

Event processing is subject to the timeout settings configured in `TransportOptions` and `SessionEventConsumers`. For detailed timeout configuration options, see the "Timeout" section above.

## Usage Examples

The SDK includes several example files in `src/test/java/com/alibaba/qwen/code/cli/example/` that demonstrate different aspects of the API:

### Basic Usage

- `QuickStartExample.java`: Demonstrates simple query usage, transport options configuration, and streaming content handling

### Session Control

- `SessionExample.java`: Shows session control features including permission mode changes, model switching, interruption, and event handling

### Configuration

- `ThreadPoolConfigurationExample.java`: Shows how to configure the thread pool used by the SDK

## Error Handling

The SDK provides specific exception types for different error scenarios:

- `SessionControlException`: Thrown when there's an issue with session control (creation, initialization, etc.)
- `SessionSendPromptException`: Thrown when there's an issue sending a prompt or receiving a response
- `SessionClosedException`: Thrown when attempting to use a closed session

## Project Structure

```
src/
├── example/
│   └── java/
│       └── com/
│           └── alibaba/
│               └── qwen/
│                   └── code/
│                       └── example/
├── main/
│   └── java/
│       └── com/
│           └── alibaba/
│               └── qwen/
│                   └── code/
│                       └── cli/
│                           ├── QwenCodeCli.java
│                           ├── protocol/
│                           ├── session/
│                           ├── transport/
│                           └── utils/
└── test/
    ├── java/
    │   └── com/
    │       └── alibaba/
    │           └── qwen/
    │               └── code/
    │                   └── cli/
    │                       ├── QwenCodeCliTest.java
    │                       ├── session/
    │                       │   └── SessionTest.java
    │                       └── transport/
    │                           ├── PermissionModeTest.java
    │                           └── process/
    │                               └── ProcessTransportTest.java
    └── temp/
```

## Configuration Files

- `pom.xml`: Maven build configuration and dependencies
- `checkstyle.xml`: Code style and formatting rules
- `.editorconfig`: Editor configuration settings

## FAQ / Troubleshooting

### Q: Do I need to install the Qwen CLI separately?

A: No, from v0.1.1, the CLI is bundled with the SDK, so no standalone CLI installation is needed.

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

### Q: What happens if the CLI process crashes?

A: The SDK will throw appropriate exceptions. Make sure to handle `SessionControlException` and implement retry logic if needed.

## Maintainers

- **Developer**: skyfire (gengwei.gw(at)alibaba-inc.com)
- **Organization**: Alibaba Group
