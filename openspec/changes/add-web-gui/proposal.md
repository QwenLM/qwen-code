# Change: Add Web GUI for Qwen Code CLI

## Why

Qwen Code currently only supports terminal-based interaction, which limits accessibility for users who prefer a visual interface. Adding a Web GUI will provide a browser-based alternative while maintaining feature parity with the CLI, enabling users to chat naturally, manage sessions, and watch code changes in real-time through a modern React-based interface.

## What Changes

- **ADDED** `/web` slash command to start a local HTTP server with WebSocket support
- **ADDED** New `packages/web-app` package containing:
  - Express/Fastify HTTP server for REST API
  - WebSocket handler for real-time message streaming
  - React frontend application reusing `@qwen-code/webui` components
- **ADDED** REST API endpoints for session management (`/api/sessions/*`)
- **ADDED** WebSocket protocol for real-time chat communication
- **ADDED** Sidebar component for session list management
- **ADDED** Main chat area with message display and input form
- **ADDED** Permission approval dialog for sensitive operations
- **ADDED** Settings panel for theme and model configuration

## Impact

- **Affected specs**: New `web-gui` capability
- **Affected code**:
  - `packages/cli/src/ui/commands/` - Add `/web` command
  - `packages/web-app/` - New package (to be created)
- **Dependencies**: Reuses `@qwen-code/webui`, `@qwen-code/qwen-code-core`
- **User impact**: New feature, no breaking changes to existing CLI workflow
