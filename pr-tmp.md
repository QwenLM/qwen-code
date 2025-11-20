# Hook System Implementation - PR

## Summary

This pull request introduces a comprehensive hook system to Qwen Code, enabling users to execute custom scripts at key points in the application lifecycle. The implementation includes:

- Complete hook system with HookManager, HookService, and configuration
- 17 different hook types covering app lifecycle, tool execution, etc.
- Claude Code hook compatibility with event mapping
- Tool name mapping for Claude to Qwen tools
- Tool input format mapping for Claude compatibility
- Claude-compatible hook execution with stdin/stdout communication
- Support for hooks to execute any application via shell command execution
- Comprehensive documentation in README and docs/
- Unit, integration, and error handling tests
- Support for both script file and inline hook definitions
- Security measures for external script execution
- New integration test suite for Claude-compatible hooks
- Configuration files for event, tool name, and tool input format mappings

## TLDR

This PR adds a powerful hook system that allows executing custom scripts at 17 different lifecycle events in Qwen Code. The system maintains full compatibility with Claude Code hooks while adding enhanced functionality for Qwen-specific workflows.

## Dive Deeper

The implementation adds several new components to support the hook system:

1. **HookManager** - Central registry that manages different hook types and executes them in priority order
2. **HookService** - Service layer that integrates hooks with the configuration system
3. **HookSettings** - Type definitions for hook configuration
4. **ClaudeHook compatibility** - Special handling for Claude Code hook events, tool names, and input formats
5. **ToolNameMapper** - Handles mapping between Claude Code and Qwen Code tool names
6. **ToolInputFormatMapper** - Maps Qwen tool input formats to Claude-compatible formats
7. **Configurable event mappings** - JSON-based configuration for mapping Claude events to Qwen hook types
8. **Integration test suite** - Comprehensive tests for Claude-compatible hooks with real script execution

The system supports two types of hooks:

- Qwen native hooks (scriptPath, inlineScript)
- Claude-compatible hooks (with event mapping via claudeHooks configuration)

Security measures are maintained with path validation ensuring hooks run within the project directory, and configuration validation prevents insecure execution.

## Reviewer Test Plan

1. Check out the branch and run `npm run build` to ensure the project builds correctly
2. Review the new hook system by examining the new files in `packages/core/src/hooks/`
3. Test hook execution by creating a simple hook configuration in `.qwen/settings.json`:
   ```json
   {
     "hooks": {
       "enabled": true,
       "hooks": [
         {
           "type": "session.start",
           "inlineScript": "console.log('Hook executed with payload:', payload);"
         }
       ]
     }
   }
   ```
4. Run the hook tests with `npx vitest run packages/core/src/hooks/` to ensure all tests pass
5. Verify the README documentation accurately describes the new functionality
6. Test Claude-compatible hooks by configuring claudeHooks in settings.json and running external scripts
7. Review the new documentation files in docs/features/ to understand the hook system capabilities

## Testing Matrix

|          | 🍏  | 🪟  | 🐧  |
| -------- | --- | --- | --- |
| npm run  | ✅  | ❓  | ✅  |
| npx      | ✅  | ❓  | ✅  |
| Docker   | ❓  | ❓  | ❓  |
| Podman   | ❓  | -   | -   |
| Seatbelt | ❓  | -   | -   |

Successfully tested on Linux (build and test execution). All tests pass including the comprehensive new hook-specific tests.

## Linked issues / bugs

Resolves the need for a comprehensive hook system to enable custom automation and integration in Qwen Code, including Claude Code compatibility requirements.
