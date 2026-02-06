# ACP Client SDK (Agent Client Protocol Java SDK For Client)

The ACP Client SDK is a Java Software Development Kit for communicating with AI agents that support the Agent Client Protocol (ACP). It provides a standardized way to interact with AI agents that support the Agent Client Protocol, enabling features like session management, file system operations, terminal commands, and tool calls.

## Project Overview

The ACP SDK implements the Agent Client Protocol, allowing client applications to communicate with AI agents. The SDK provides the following core features:

- Session management (create, load, manage conversations)
- File system operations (read/write text files)
- Terminal command execution
- Tool call handling and permission management
- Support for rich content types (text, images, audio, resources)
- Integration with Model Context Protocol (MCP) servers

## Requirements

- Java 8 or higher
- Maven 3.6.0 or higher

## Features

- **Standardized Protocol**: Implements ACP protocol to ensure interoperability with various ACP-compatible agents
- **Flexible Transport Layer**: Supports multiple transport mechanisms (stdio, HTTP, etc.)
- **Session Management**: Complete session lifecycle management
- **Permission Control**: Fine-grained permission management to protect sensitive operations
- **Content Block Handling**: Support for multiple data types in content blocks
- **MCP Integration**: Integration with external MCP servers for extended tooling capabilities

## Installation

### Maven

Add the following dependency to your `pom.xml` file:

```xml
<dependency>
    <groupId>com.alibaba</groupId>
    <artifactId>acp-sdk</artifactId>
    <version>0.0.1-alpha</version>
</dependency>
```

### Gradle

Add the following to your `build.gradle` file:

```gradle
implementation 'com.alibaba:acp-sdk:0.0.1-alpha'
```

## Quick Start

The following is a simple example showing how to use the ACP SDK to create a client and establish a session:

```java
@Test
public void testSession() throws AgentInitializeException, SessionNewException, IOException {
    // Create an ACP client with a process transport
    AcpClient acpClient = new AcpClient(
            new ProcessTransport(new ProcessTransportOptions().setCommandArgs(new String[] {"qwen", "--acp", "--experimental-skills", "-y"})));

    try {
        // Send a prompt to the agent
        acpClient.sendPrompt(Collections.singletonList(new TextContent("你是谁")),
                new AgentEventConsumer().setContentEventConsumer(new ContentEventSimpleConsumer() {
                    @Override
                    public void onAgentMessageChunkSessionUpdate(AgentMessageChunkSessionUpdate sessionUpdate) {
                        logger.info(sessionUpdate.toString());
                    }

                    @Override
                    public void onAvailableCommandsUpdateSessionUpdate(AvailableCommandsUpdateSessionUpdate sessionUpdate) {
                        logger.info(sessionUpdate.toString());
                    }

                    @Override
                    public void onCurrentModeUpdateSessionUpdate(CurrentModeUpdateSessionUpdate sessionUpdate) {
                        logger.info(sessionUpdate.toString());
                    }

                    @Override
                    public void onPlanSessionUpdate(PlanSessionUpdate sessionUpdate) {
                        logger.info(sessionUpdate.toString());
                    }

                    @Override
                    public void onToolCallUpdateSessionUpdate(ToolCallUpdateSessionUpdate sessionUpdate) {
                        logger.info(sessionUpdate.toString());
                    }

                    @Override
                    public void onToolCallSessionUpdate(ToolCallSessionUpdate sessionUpdate) {
                        logger.info(sessionUpdate.toString());
                    }
                }));
    } finally {
        // Close the client when done
        acpClient.close();
    }
}
```

## Architecture Components

### Core Components

1. **AcpClient**: Main client class that manages connections to ACP-compatible agents
2. **Session**: Represents a conversation session with an agent
3. **Transport**: Handles the underlying communication protocol (JSON-RPC over stdio, HTTP, etc.)
4. **Protocol Definitions**: Generated from JSON schema, defining all ACP message types

### Protocol Structure

The SDK implements the Agent Client Protocol based on a comprehensive JSON schema that defines:

- Request/Response types for agent-client communication
- Notification mechanisms for real-time updates
- Error handling and capability negotiation
- Content blocks for various data types
- Tool call definitions and execution flows

## Use Cases

- AI agent integration in enterprise applications
- Automated scripting and task execution
- File system operation automation
- Terminal command execution and result processing
- Integration with external services and tools

## Development

### Build

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

### Testing

The project includes comprehensive unit tests covering:

- Protocol message generation from JSON schema
- Session management functionality
- Permission handling workflows
- Content type processing

## Dependencies

Key dependencies include:

- SLF4J API for logging
- Apache Commons Lang3 and IO for utility functions
- FastJSON2 for JSON serialization/deserialization
- JUnit 5 for testing
- Logback Classic for testing logging

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please submit issues and pull requests.

## Support

If you encounter any problems, please submit an issue report through GitHub Issues.
