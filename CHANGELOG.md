# Changelog

## 0.0.14

- Added plan mode support for task planning
- Fixed unreliable editCorrector that injects extra escape characters
- Fixed task tool dynamic updates
- Added Qwen3-VL-Plus token limits (256K input, 32K output) and highres support
- Enhanced dashScope cache control

## 0.0.13

- Added YOLO mode support for automatic vision model switching with CLI arguments and environment variables.
- Fixed ripgrep lazy loading to resolve VS Code IDE companion startup issues.
- Fixed authentication hang when selecting Qwen OAuth.
- Added OpenAI and Qwen OAuth authentication support to Zed ACP integration.
- Fixed output token limit for Qwen models.
- Fixed Markdown list display issues on Windows.
- Enhanced vision model instructions and documentation.
- Improved authentication method compatibility across different IDE integrations.

## 0.0.12

- Added vision model support for Qwen-OAuth authentication.
- Synced upstream `gemini-cli` to v0.3.4 with numerous improvements and bug fixes.
- Enhanced subagent functionality with system reminders and improved user experience.
- Added tool call type coercion for better compatibility.
- Fixed arrow key navigation issues on Windows.
- Fixed missing tool call chunks for OpenAI logging.
- Fixed system prompt issues to avoid malformed tool calls.
- Fixed terminal flicker when subagent is executing.
- Fixed duplicate subagents configuration when running in home directory.
- Fixed Esc key unable to cancel subagent dialog.
- Added confirmation prompt for `/init` command when context file exists.
- Added `skipLoopDetection` configuration option.
- Fixed `is_background` parameter reset issues.
- Enhanced Windows compatibility with multi-line paste handling.
- Improved subagent documentation and branding consistency.
- Fixed various linting errors and improved code quality.
- Miscellaneous improvements and bug fixes.

## 0.0.11

- Added subagents feature with file-based configuration system for specialized AI assistants.
- Added Welcome Back Dialog with project summary and enhanced quit options.
- Fixed performance issues with SharedTokenManager causing 20-minute delays.
- Fixed tool calls UI issues and improved user experience.
- Fixed credential clearing when switching authentication types.
- Enhanced subagent capabilities to use tools requiring user confirmation.
- Improved ReadManyFiles tool with shared line limits across files.
- Re-implemented tokenLimits class for better compatibility with Qwen and other model types.
- Fixed chunk validation to avoid unnecessary retries.
- Resolved EditTool naming inconsistency causing agent confusion loops.
- Fixed unexpected re-authentication when auth-token is expired.
- Added Terminal Bench integration tests.
- Updated multilingual documentation links in README.
- Fixed various Windows compatibility issues.
- Miscellaneous improvements and bug fixes.

## 0.0.10

- Synced upstream `gemini-cli` to v0.2.1.
- Add todo write tool for task management and progress tracking.

## 0.0.9

- Synced upstream `gemini-cli` to v0.1.21.
- Fixed token synchronization among multiple Qwen sessions.
- Improved tool execution with early stop on invalid tool calls.
- Added explicit `is_background` parameter for shell tool.
- Enhanced memory management with sub-commands to switch between project and global memory operations.
- Renamed `GEMINI_DIR` to `QWEN_DIR` for better branding consistency.
- Added support for Qwen Markdown selection.
- Fixed parallel tool usage and improved tool reliability.
- Upgraded integration tests to use Vitest framework.
- Enhanced VS Code IDE integration with launch configurations.
- Added terminal setup command for Shift+Enter and Ctrl+Enter support.
- Fixed GitHub Workflows configuration issues.
- Improved settings directory and command descriptions.
- Fixed locale handling in yargs configuration.
- Added support for `trustedFolders.json` configuration file.
- Enhanced cross-platform compatibility for sandbox build scripts.
- Improved error handling and fixed ambiguous literals.
- Updated documentation links and added IDE integration documentation.
- Miscellaneous improvements and bug fixes.

## 0.0.8

- Synced upstream `gemini-cli` to v0.1.19.
- Updated documentation branding from **Gemini CLI** to **Qwen Code**.
- Added multilingual docs links in `README.md`.
- Added deterministic cache control for the DashScope provider.
- Added option to choose a project-level or global save location.
- Limited `grep` results to 25 items by default.
- `grep` now respects `.qwenignore`.
- Miscellaneous improvements and bug fixes.

## 0.0.7

- Synced upstream `gemini-cli` to v0.1.18.
- Fixed MCP tools.
- Fixed Web Fetch tool.
- Fixed Web Search tool by switching from Google/Gemini to the Tavily API.
- Made tool calls tolerant of invalid-JSON parameters occasionally returned by the LLM.
- Prevented concurrent query submissions in rare cases.
- Corrected Qwen logger exit-handler setup.
- Separated static QR code and dynamic spinner components.

## 0.0.6

- Added usage statistics logging for Qwen integration.
- Made `/init` respect the configured context filename and aligned docs with `QWEN.md`.
- Fixed `EPERM` error when running `qwen --sandbox` on macOS.
- Fixed terminal flicker while waiting for login.
- Fixed `glm-4.5` model request error.

## 0.0.5

- Added Qwen OAuth login and up to 2,000 free requests per day.
- Synced upstream `gemini-cli` to v0.1.17.
- Added the `systemPromptMappings` configuration option.
