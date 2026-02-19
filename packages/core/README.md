# Qwen Code Core Package (`@qwen-code/core`)

This package serves as the brain of the Qwen Code extension. It contains the business logic, LLM interactions, and platform-agnostic code shared across different IDE integrations (VS Code, Zed, etc.) and the CLI.

## 🗺️ Directory Structure & "Menu"

Use this guide to navigate the codebase quickly.

### 🧠 Core Engine (`src/core/`)
**The heart of the application.**
- **`client.ts` / `baseLlmClient.ts`**: Handles communication with LLM providers (Google Gemini, Anthropic, OpenAI).
- **`geminiChat.ts`**: Manages chat sessions, history, and context windowing.
- **`coreToolScheduler.ts`**: Orchestrates how tools are selected and executed by the LLM.

### ⚙️ Configuration & Models (`src/config/`, `src/models/`)
**Settings and Data Types.**
- **`config/config.ts`**: Main configuration loader.
- **`models/`**: Definitions for AI models (Qwen 2.5, etc.) and their capabilities.
- **`extension/settings.ts`**: Manages user settings and preferences.

### 🔌 IDE Abstraction (`src/ide/`)
**Platform-agnostic interfaces.**
- **`ide-client.ts`**: Interface for the core to talk to the editor (e.g., "show diff", "open file").
- **`detect-ide.ts`**: Logic to identify if we are running in VS Code, Zed, or CLI.

### 🛠️ Language Server (`src/lsp/`)
**Code Intelligence.**
- **`LspServerManager.ts`**: Manages the lifecycle of language servers.
- **`NativeLspService.ts`**: Integrates with the editor's native LSP capabilities.

### 🔗 MCP (Model Context Protocol) (`src/mcp/`)
**External Context.**
- Implements the Model Context Protocol to connect to external data sources and tools.

### 🧩 Extension Logic (`src/extension/`)
**Lifecycle & State.**
- **`extensionManager.ts`**: Handles extension activation, deactivation, and updates.
- **`github.ts`**: GitHub API integration.

### 🧰 Tools & Capabilities
- **`src/tools/`**: Atomic tools the LLM can use (e.g., `fs_read_file`, `web_search`).
- **`src/skills/`**: Higher-level capabilities composed of multiple tools.
- **`src/subagents/`**: Autonomous agents for complex, multi-step tasks.

### 📝 Prompts (`src/prompts/`)
**System Instructions.**
- Contains the system prompts and templates sent to the LLM to define its persona and rules.

### 📊 Telemetry & Logging (`src/telemetry/`, `src/core/logger.ts`)
- **`telemetry/`**: Analytics and usage tracking.
- **`core/logger.ts`**: Internal logging utilities.

### 🧪 Testing (`src/test-utils/`)
- Shared utilities for writing tests across the codebase.
