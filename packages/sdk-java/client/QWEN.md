# ACP SDK Project Context

## Project Overview

The `acp-sdk` is a Java SDK implementation for the Agent Client Protocol (ACP), which is a protocol for communication between AI agents and client applications. The SDK provides a standardized way to interact with AI agents that support the Agent Client Protocol, enabling features like session management, file system operations, terminal commands, and tool calls.

The project is structured as a Maven-based Java project with the following key characteristics:

- **Group ID**: com.alibaba
- **Artifact ID**: acp-sdk
- **Version**: 0.0.1-alpha
- **Description**: The agent client protocol Java SDK
- **Java Version**: 1.8+

## Architecture and Components

### Core Components

1. **AcpClient**: Main client class that manages connections to ACP-compatible agents
2. **Session**: Represents a conversation session with an agent
3. **Transport**: Handles the underlying communication protocol (JSON-RPC over stdio, HTTP, etc.)
4. **Protocol Definitions**: Generated from JSON schema, defining all ACP message types

### Key Features

- Session management (create, load, manage conversations)
- File system operations (read/write text files)
- Terminal command execution
- Tool call handling and permission management
- Support for rich content types (text, images, audio, resources)
- Integration with Model Context Protocol (MCP) servers

### Protocol Structure

The SDK implements the Agent Client Protocol based on a comprehensive JSON schema that defines:

- Request/Response types for agent-client communication
- Notification mechanisms for real-time updates
- Error handling and capability negotiation
- Content blocks for various data types
- Tool call definitions and execution flows

## Building and Running

### Prerequisites

- Java 8 or higher
- Maven 3.6.0 or higher

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

### Testing

The project includes comprehensive unit tests covering:

- Protocol message generation from JSON schema
- Session management functionality
- Permission handling workflows
- Content type processing

### Development Conventions

- Code follows standard Java conventions
- Uses SLF4J for logging
- Leverages Apache Commons Lang3 and IO utilities
- Uses FastJSON2 for JSON serialization/deserialization
- Follows JSON-RPC 2.0 specification for messaging

## Usage Examples

Based on the test files, typical usage involves:

1. Creating a Transport instance (e.g., ProcessTransport for running agent processes)
2. Initializing an AcpClient with appropriate capabilities
3. Creating or loading sessions
4. Sending prompts and handling responses through event consumers

The SDK supports advanced features like permission management for sensitive operations, file system access, and integration with external MCP servers for extended tooling capabilities.

## Dependencies

Key dependencies include:

- SLF4J API for logging
- Apache Commons Lang3 and IO for utility functions
- FastJSON2 for JSON processing
- JUnit 5 for testing
- Logback Classic for testing logging

## Project Status

This is an alpha version of the SDK, suggesting it's in early development stages. The project appears to be actively maintained by Alibaba's skyfire developer team and is designed to support AI agent integration in enterprise environments.
