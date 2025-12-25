# Qwen Code Architecture Overview

This document provides a high-level overview of Qwen Code's architecture.

## Core Components

Qwen Code is primarily composed of two main packages, along with a suite of tools that can be used by the system in the course of handling command-line input:

### 1. CLI Package (`packages/cli`)

**Purpose:** This contains the user-facing portion of Qwen Code, such as handling the initial user input, presenting the final output, and managing the overall user experience.

**Key Functions:**

- **Input Processing:** Handles user input through various methods including direct text entry, slash commands (e.g., `/help`, `/clear`, `/model`), at commands (`@file` for including file content), and exclamation mark commands (`!command` for shell execution).
- **History Management:** Maintains conversation history and enables features like session resumption.
- **Display Rendering:** Formats and presents responses to the user in the terminal with syntax highlighting and proper formatting.
- **Theme and UI Customization:** Supports customizable themes and UI elements for a personalized experience.
- **Configuration Settings:** Manages various configuration options through JSON settings files, environment variables, and command-line arguments.

### 2. Core Package (`packages/core`)

**Purpose:** This acts as the backend for Qwen Code. It receives requests sent from `packages/cli`, orchestrates interactions with the configured model API, and manages the execution of available tools.

**Key Functions:**

- **API Client:** Communicates with the Qwen model API to send prompts and receive responses.
- **Prompt Construction:** Builds appropriate prompts for the model, incorporating conversation history and available tool definitions.
- **Tool Registration and Execution:** Manages the registration of available tools and executes them based on model requests.
- **State Management:** Maintains conversation and session state information.
- **Server-side Configuration:** Handles server-side configuration and settings.

### 3. Tools (`packages/core/src/tools/`)

**Purpose:** These are individual modules that extend the capabilities of the Qwen model, allowing it to interact with the local environment (e.g., file system, shell commands, web fetching).

**Interaction:** `packages/core` invokes these tools based on requests from the Qwen model.

**Common Tools Include:**

- **File Operations:** Reading, writing, and editing files
- **Shell Commands:** Executing system commands with user approval for potentially dangerous operations
- **Search Tools:** Finding files and searching content within the project
- **Web Tools:** Fetching content from the web
- **MCP Integration:** Connecting to Model Context Protocol servers for extended capabilities

## Interaction Flow

A typical interaction with Qwen Code follows this flow:

1.  **User Input:** The user types a prompt or command into the terminal, which is managed by `packages/cli`.
2.  **Request to Core:** `packages/cli` sends the user's input to `packages/core`.
3.  **Request Processing:** The core package:
    - Constructs an appropriate prompt for the configured model API, possibly including conversation history and available tool definitions.
    - Sends the prompt to the model API.
4.  **Model API Response:** The model API processes the prompt and returns a response. This response might be a direct answer or a request to use one of the available tools.
5.  **Tool Execution (if applicable):**
    - When the model API requests a tool, the core package prepares to execute it.
    - If the requested tool can modify the file system or execute shell commands, the user is first given details of the tool and its arguments, and the user must approve the execution.
    - Read-only operations, such as reading files, might not require explicit user confirmation to proceed.
    - Once confirmed, or if confirmation is not required, the core package executes the relevant action within the relevant tool, and the result is sent back to the model API by the core package.
    - The model API processes the tool result and generates a final response.
6.  **Response to CLI:** The core package sends the final response back to the CLI package.
7.  **Display to User:** The CLI package formats and displays the response to the user in the terminal.

## Configuration Options

Qwen Code offers multiple ways to configure its behavior:

### Configuration Layers (in order of precedence)

1. Command-line arguments
2. Environment variables
3. Project settings file (`.qwen/settings.json`)
4. User settings file (`~/.qwen/settings.json`)
5. System settings files
6. Default values

### Key Configuration Categories

- **General Settings:** vim mode, preferred editor, auto-update preferences
- **UI Settings:** Theme customization, banner visibility, footer display
- **Model Settings:** Model selection, session turn limits, compression settings
- **Context Settings:** Context file names, directory inclusion, file filtering
- **Tool Settings:** Approval modes, sandboxing, tool restrictions
- **Privacy Settings:** Usage statistics collection
- **Advanced Settings:** Debug options, custom bug reporting commands

## Key Design Principles

- **Modularity:** Separating the CLI (frontend) from the Core (backend) allows for independent development and potential future extensions (e.g., different frontends for the same backend).
- **Extensibility:** The tool system is designed to be extensible, allowing new capabilities to be added through custom tools or MCP server integration.
- **User Experience:** The CLI focuses on providing a rich and interactive terminal experience with features like syntax highlighting, customizable themes, and intuitive command structures.
- **Security:** Implements approval mechanisms for potentially dangerous operations and sandboxing options to protect the user's system.
- **Flexibility:** Supports multiple configuration methods and can adapt to different workflows and environments.
