# Qwen Code Packages Table of Contents

This document provides a comprehensive overview of the Qwen Code packages to help you navigate the codebase more efficiently.

## 📦 Packages Overview

### 🧠 `core` (`@qwen-code/qwen-code-core`)
**The brain of Qwen Code.** Contains the business logic, LLM interactions, and platform-agnostic code shared across different IDE integrations.

#### Key Components:
- **Core Engine** (`src/core/`): The heart of the application
  - `client.ts` / `baseLlmClient.ts`: Handles communication with LLM providers (Google Gemini, Anthropic, OpenAI)
  - `geminiChat.ts`: Manages chat sessions, history, and context windowing
  - `coreToolScheduler.ts`: Orchestrates how tools are selected and executed by the LLM

- **Configuration & Models** (`src/config/`, `src/models/`): Settings and Data Types
  - `config/config.ts`: Main configuration loader
  - `models/`: Definitions for AI models (Qwen 2.5, etc.) and their capabilities
  - `extension/settings.ts`: Manages user settings and preferences

- **IDE Abstraction** (`src/ide/`): Platform-agnostic interfaces
  - `ide-client.ts`: Interface for the core to talk to the editor (e.g., "show diff", "open file")
  - `detect-ide.ts`: Logic to identify if we are running in VS Code, Zed, or CLI

- **Language Server** (`src/lsp/`): Code Intelligence
  - `LspServerManager.ts`: Manages the lifecycle of language servers
  - `NativeLspService.ts`: Integrates with the editor's native LSP capabilities

- **MCP (Model Context Protocol)** (`src/mcp/`): External Context
  - Implements the Model Context Protocol to connect to external data sources and tools

- **Extension Logic** (`src/extension/`): Lifecycle & State
  - `extensionManager.ts`: Handles extension activation, deactivation, and updates
  - `github.ts`: GitHub API integration

- **Tools & Capabilities**:
  - `src/tools/`: Atomic tools the LLM can use (e.g., `fs_read_file`, `web_search`)
  - `src/skills/`: Higher-level capabilities composed of multiple tools
  - `src/subagents/`: Autonomous agents for complex, multi-step tasks

- **Prompts** (`src/prompts/`): System Instructions
  - Contains the system prompts and templates sent to the LLM to define its persona and rules

- **Telemetry & Logging** (`src/telemetry/`, `src/core/logger.ts`):
  - `telemetry/`: Analytics and usage tracking
  - `core/logger.ts`: Internal logging utilities

### 💻 `cli` (`@qwen-code/qwen-code`)
**Command-line interface.** Provides terminal access to Qwen Code functionality.

#### Key Components:
- **Main Entry Point**: `index.ts` - CLI application entry point
- **Commands**: Located in `src/commands/` - Different CLI operations (chat, run, etc.)
- **UI Components**: Terminal UI elements using Ink (React for terminals)
- **Configuration**: CLI-specific settings and initialization

### 🖥️ `vscode-ide-companion`
**VS Code extension.** Integrates Qwen Code into the Visual Studio Code editor.

#### Key Components:
- **Extension Entry Point**: `src/extension.ts` - VS Code activation logic
- **Webview UI**: `src/webview/` - Chat interface rendered in VS Code
- **Commands**: `src/commands/` - VS Code commands contributed to the editor
- **State Management**: Workspace and session management for VS Code
- **Integration Layer**: Bridges VS Code APIs with core Qwen Code functionality

### 🌐 `webui` (`@qwen-code/webui`)
**Shared UI components.** Provides reusable UI elements across different packages.

#### Key Components:
- **React Components**: Reusable UI elements (chat bubbles, input fields, etc.)
- **Styling**: Tailwind CSS configurations and styling utilities
- **Icons**: Shared icon components
- **Markdown Rendering**: Components for displaying formatted code and text

### 🧱 `test-utils` (`@qwen-code/qwen-code-test-utils`)
**Testing utilities.** Shared testing helpers across the codebase.

#### Key Components:
- **Mock Services**: Mock implementations for testing
- **Test Helpers**: Utilities to simplify test creation
- **Fixtures**: Predefined test data

### 🔌 `zed-extension`
**Zed editor extension.** Integrates Qwen Code into the Zed editor via Agent Client Protocol (ACP).

#### Key Components:
- **Extension Manifest**: `extension.toml` - Zed extension configuration
- **Agent Integration**: ACP protocol implementation for Zed
- **UI Components**: Zed-specific UI elements

### 📚 `sdk-typescript` (`@qwen-code/sdk`)
**TypeScript SDK.** Programmatic access to Qwen Code functionality for other TypeScript applications.

#### Key Components:
- **Client API**: Main interface for interacting with Qwen Code programmatically
- **Types**: Type definitions for Qwen Code operations
- **Utilities**: Helper functions for common SDK operations

### 🏗️ `sdk-java`
**Java SDK.** Programmatic access to Qwen Code functionality for Java applications.

#### Key Components:
- **Client Library**: Java classes for interacting with Qwen Code
- **API Bindings**: Java-specific bindings to Qwen Code functionality

## 🎯 Quick Navigation Guide

### For Understanding Core Logic:
Start with `packages/core/src/core/` - this contains the main business logic and LLM interactions.

### For Adding New Features:
- **New tools**: Add to `packages/core/src/tools/`
- **New skills**: Add to `packages/core/src/skills/`
- **New UI components**: Add to `packages/webui/src/components/`
- **New VS Code features**: Add to `packages/vscode-ide-companion/src/`

### For Platform-Specific Changes:
- **VS Code**: Modify `packages/vscode-ide-companion/`
- **CLI**: Modify `packages/cli/`
- **Zed**: Modify `packages/zed-extension/`

### For Testing:
- **Unit tests**: Look for `.test.ts` files alongside implementation files
- **Integration tests**: Check `packages/*/test/` directories
- **Test utilities**: Use `packages/test-utils/src/`

## 📖 Additional Resources

- **Core Package README**: `packages/core/README.md` - Detailed breakdown of core architecture
- **Development Setup**: Check the main repository README
- **Architecture Decisions**: Look for ADR (Architecture Decision Records) in the repository