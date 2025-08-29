# Enhancements to MCP Integration, File System Handling, and CLI Experience

This PR brings significant improvements to the Qwen Code CLI, focusing on enhancing the Model Context Protocol (MCP) integration, improving file system operations, refining shell execution capabilities, and boosting overall stability and user experience.

## Key Improvements

### 🔄 Enhanced MCP Integration
- Improved MCP server discovery and connection management through a new `McpClientManager`
- Better handling of MCP tool executions with enhanced error reporting
- Added support for MCP server restart functionality
- Improved OAuth authentication flow for MCP servers
- Enhanced MCP tool validation and registration process

### 📁 Improved File System Operations
- Introduced `FileSystemService` abstraction for better file I/O handling
- Enhanced file path validation and security checks
- Improved handling of special characters in file paths
- Better error reporting for file operations with specific error types (e.g., permission denied, no space left)

### ⚙️ Refined Shell Execution
- Enhanced shell command execution with better cross-platform support
- Improved handling of binary output detection
- Better argument escaping and command sanitization
- Added support for shell command interruption and proper cleanup

### 📊 Enhanced Telemetry and Logging
- Expanded telemetry events to track chat compression, content retries, and invalid chunks
- Improved logging for MCP operations and tool executions
- Better error tracking and reporting mechanisms
- Enhanced session metrics with code change tracking

### 🎨 UI/UX Improvements
- Updated key bindings for better usability (Ctrl+G for IDE context toggle)
- Improved settings dialog with better value display and persistence
- Enhanced footer information with trust status and sandbox details
- Better handling of queued messages during streaming responses

### 🔒 Security and Stability
- Strengthened path validation to prevent directory traversal
- Improved error handling throughout the codebase
- Enhanced sandbox environment detection and configuration
- Better management of environment variables and configuration loading

## Technical Highlights

### Core Architecture
- Refactored tool execution to use a new declarative tool pattern with proper validation
- Improved configuration loading with better environment variable handling
- Enhanced workspace context management with improved directory tracking

### Performance Optimizations
- Added chat compression capabilities to manage token usage
- Improved caching mechanisms for file operations
- Optimized history management and context tracking

### Developer Experience
- Better test coverage for key components
- Improved error messages and debugging information
- Enhanced documentation for configuration options

## Migration Notes
- Several deprecated APIs have been removed in favor of newer implementations
- Configuration schema has been updated with new options
- Environment variable handling has been standardized

This release represents a significant step forward in reliability, security, and functionality for the Qwen Code CLI.