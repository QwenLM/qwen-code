/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// English translations for Qwen Code CLI
// The key serves as both the translation key and the default English text

export default {
  // ============================================================================
  // Help / UI Components
  // ============================================================================
  'Basics:': 'Basics:',
  'Add context': 'Add context',
  'Use {{symbol}} to specify files for context (e.g., {{example}}) to target specific files or folders.':
    'Use {{symbol}} to specify files for context (e.g., {{example}}) to target specific files or folders.',
  '@': '@',
  '@src/myFile.ts': '@src/myFile.ts',
  'Shell mode': 'Shell mode',
  'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).':
    'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).',
  '!': '!',
  '!npm run start': '!npm run start',
  'start server': 'start server',
  'Commands:': 'Commands:',
  'shell command': 'shell command',
  'Model Context Protocol command (from external servers)':
    'Model Context Protocol command (from external servers)',
  'Keyboard Shortcuts:': 'Keyboard Shortcuts:',
  'Jump through words in the input': 'Jump through words in the input',
  'Close dialogs, cancel requests, or quit application':
    'Close dialogs, cancel requests, or quit application',
  'New line': 'New line',
  'New line (Alt+Enter works for certain linux distros)':
    'New line (Alt+Enter works for certain linux distros)',
  'Clear the screen': 'Clear the screen',
  'Open input in external editor': 'Open input in external editor',
  'Send message': 'Send message',
  'Initializing...': 'Initializing...',
  'Connecting to MCP servers... ({{connected}}/{{total}})':
    'Connecting to MCP servers... ({{connected}}/{{total}})',
  'Type your message or @path/to/file': 'Type your message or @path/to/file',
  "Press 'i' for INSERT mode and 'Esc' for NORMAL mode.":
    "Press 'i' for INSERT mode and 'Esc' for NORMAL mode.",
  'Cancel operation / Clear input (double press)':
    'Cancel operation / Clear input (double press)',
  'Cycle approval modes': 'Cycle approval modes',
  'Cycle through your prompt history': 'Cycle through your prompt history',
  'For a full list of shortcuts, see {{docPath}}':
    'For a full list of shortcuts, see {{docPath}}',
  'docs/keyboard-shortcuts.md': 'docs/keyboard-shortcuts.md',
  'for help on Qwen Code': 'for help on Qwen Code',
  'show version info': 'show version info',
  'submit a bug report': 'submit a bug report',

  // ============================================================================
  // Commands - General
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    'Analyzes the project and creates a tailored QWEN.md file.',
  'list available Qwen Code tools. Usage: /tools [desc]':
    'list available Qwen Code tools. Usage: /tools [desc]',
  'View or change the approval mode for tool usage':
    'View or change the approval mode for tool usage',
  'View or change the language setting': 'View or change the language setting',
  'change the theme': 'change the theme',
  'clear the screen and conversation history':
    'clear the screen and conversation history',
  'Compresses the context by replacing it with a summary.':
    'Compresses the context by replacing it with a summary.',
  'open full Qwen Code documentation in your browser':
    'open full Qwen Code documentation in your browser',
  'Configuration not available.': 'Configuration not available.',
  'change the auth method': 'change the auth method',
  'Show quit confirmation dialog': 'Show quit confirmation dialog',
  'Copy the last result or code snippet to clipboard':
    'Copy the last result or code snippet to clipboard',
  'Manage subagents for specialized task delegation.':
    'Manage subagents for specialized task delegation.',
  'Manage existing subagents (view, edit, delete).':
    'Manage existing subagents (view, edit, delete).',
  'Create a new subagent with guided setup.':
    'Create a new subagent with guided setup.',
  'View and edit Qwen Code settings': 'View and edit Qwen Code settings',
  'toggle vim mode on/off': 'toggle vim mode on/off',
  'check session stats. Usage: /stats [model|tools]':
    'check session stats. Usage: /stats [model|tools]',
  'Show model-specific usage statistics.':
    'Show model-specific usage statistics.',
  'Show tool-specific usage statistics.':
    'Show tool-specific usage statistics.',
  'exit the cli': 'exit the cli',
  'list configured MCP servers and tools, or authenticate with OAuth-enabled servers':
    'list configured MCP servers and tools, or authenticate with OAuth-enabled servers',
  'Manage workspace directories': 'Manage workspace directories',
  'Add directories to the workspace. Use comma to separate multiple paths':
    'Add directories to the workspace. Use comma to separate multiple paths',
  'Show all directories in the workspace':
    'Show all directories in the workspace',
  'set external editor preference': 'set external editor preference',
  'Manage extensions': 'Manage extensions',
  'List active extensions': 'List active extensions',
  'Update extensions. Usage: update <extension-names>|--all':
    'Update extensions. Usage: update <extension-names>|--all',
  'manage IDE integration': 'manage IDE integration',
  'check status of IDE integration': 'check status of IDE integration',
  'install required IDE companion for {{ideName}}':
    'install required IDE companion for {{ideName}}',
  'enable IDE integration': 'enable IDE integration',
  'disable IDE integration': 'disable IDE integration',
  'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.':
    'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.',
  'Set up GitHub Actions': 'Set up GitHub Actions',
  'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf)':
    'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf)',

  // ============================================================================
  // Commands - Language
  // ============================================================================
  'Invalid language. Available: en-US, zh-CN':
    'Invalid language. Available: en-US, zh-CN',
  'Language subcommands do not accept additional arguments.':
    'Language subcommands do not accept additional arguments.',
  'Current UI language: {{lang}}': 'Current UI language: {{lang}}',
  'Current LLM output language: {{lang}}':
    'Current LLM output language: {{lang}}',
  'LLM output language not set': 'LLM output language not set',
  'Set UI language': 'Set UI language',
  'Set LLM output language': 'Set LLM output language',
  'Usage: /language ui [zh-CN|en-US]': 'Usage: /language ui [zh-CN|en-US]',
  'Usage: /language output <language>': 'Usage: /language output <language>',
  'Example: /language output 中文': 'Example: /language output 中文',
  'Example: /language output English': 'Example: /language output English',
  'Example: /language output 日本語': 'Example: /language output 日本語',
  'UI language changed to {{lang}}': 'UI language changed to {{lang}}',
  'LLM output language rule file generated at {{path}}':
    'LLM output language rule file generated at {{path}}',
  'Failed to generate LLM output language rule file: {{error}}':
    'Failed to generate LLM output language rule file: {{error}}',
  'Invalid command. Available subcommands:':
    'Invalid command. Available subcommands:',
  'Available subcommands:': 'Available subcommands:',
  'To request additional UI language packs, please open an issue on GitHub.':
    'To request additional UI language packs, please open an issue on GitHub.',
  'Available options:': 'Available options:',
  '  - zh-CN: Simplified Chinese': '  - zh-CN: Simplified Chinese',
  '  - en-US: English': '  - en-US: English',
  'Set UI language to Simplified Chinese (zh-CN)':
    'Set UI language to Simplified Chinese (zh-CN)',
  'Set UI language to English (en-US)': 'Set UI language to English (en-US)',

  // ============================================================================
  // Commands - Approval Mode
  // ============================================================================
  'Current approval mode: {{mode}}': 'Current approval mode: {{mode}}',
  'Available approval modes:': 'Available approval modes:',
  'Approval mode changed to: {{mode}}': 'Approval mode changed to: {{mode}}',
  'Approval mode changed to: {{mode}} (saved to {{scope}} settings{{location}})':
    'Approval mode changed to: {{mode}} (saved to {{scope}} settings{{location}})',
  'Usage: /approval-mode <mode> [--session|--user|--project]':
    'Usage: /approval-mode <mode> [--session|--user|--project]',
  'Invalid approval mode: {{mode}}': 'Invalid approval mode: {{mode}}',
  'Multiple scope flags provided': 'Multiple scope flags provided',
  'Invalid arguments provided': 'Invalid arguments provided',
  'Missing approval mode': 'Missing approval mode',
  'Scope subcommands do not accept additional arguments.':
    'Scope subcommands do not accept additional arguments.',
  'Plan mode - Analyze only, do not modify files or execute commands':
    'Plan mode - Analyze only, do not modify files or execute commands',
  'Default mode - Require approval for file edits or shell commands':
    'Default mode - Require approval for file edits or shell commands',
  'Auto-edit mode - Automatically approve file edits':
    'Auto-edit mode - Automatically approve file edits',
  'YOLO mode - Automatically approve all tools':
    'YOLO mode - Automatically approve all tools',
  '{{mode}} mode': '{{mode}} mode',
  'Settings service is not available; unable to persist the approval mode.':
    'Settings service is not available; unable to persist the approval mode.',
  'Failed to save approval mode: {{error}}':
    'Failed to save approval mode: {{error}}',
  'Failed to change approval mode: {{error}}':
    'Failed to change approval mode: {{error}}',
  'Apply to current session only (temporary)':
    'Apply to current session only (temporary)',
  'Persist for this project/workspace': 'Persist for this project/workspace',
  'Persist for this user on this machine':
    'Persist for this user on this machine',

  // ============================================================================
  // Commands - Memory
  // ============================================================================
  'Commands for interacting with memory.':
    'Commands for interacting with memory.',
  'Show the current memory contents.': 'Show the current memory contents.',
  'Show project-level memory contents.': 'Show project-level memory contents.',
  'Show global memory contents.': 'Show global memory contents.',
  'Add content to project-level memory.':
    'Add content to project-level memory.',
  'Add content to global memory.': 'Add content to global memory.',
  'Refresh the memory from the source.': 'Refresh the memory from the source.',
  'Usage: /memory add --project <text to remember>':
    'Usage: /memory add --project <text to remember>',
  'Usage: /memory add --global <text to remember>':
    'Usage: /memory add --global <text to remember>',
  'Attempting to save to project memory: "{{text}}"':
    'Attempting to save to project memory: "{{text}}"',
  'Attempting to save to global memory: "{{text}}"':
    'Attempting to save to global memory: "{{text}}"',
  'Current memory content from {{count}} file(s):':
    'Current memory content from {{count}} file(s):',
  'Memory is currently empty.': 'Memory is currently empty.',
  'Project memory file not found or is currently empty.':
    'Project memory file not found or is currently empty.',
  'Global memory file not found or is currently empty.':
    'Global memory file not found or is currently empty.',
  'Global memory is currently empty.': 'Global memory is currently empty.',
  'Global memory content:\n\n---\n{{content}}\n---':
    'Global memory content:\n\n---\n{{content}}\n---',
  'Project memory content from {{path}}:\n\n---\n{{content}}\n---':
    'Project memory content from {{path}}:\n\n---\n{{content}}\n---',
  'Project memory is currently empty.': 'Project memory is currently empty.',
  'Refreshing memory from source files...':
    'Refreshing memory from source files...',
  'Add content to the memory. Use --global for global memory or --project for project memory.':
    'Add content to the memory. Use --global for global memory or --project for project memory.',
  'Usage: /memory add [--global|--project] <text to remember>':
    'Usage: /memory add [--global|--project] <text to remember>',
  'Attempting to save to memory {{scope}}: "{{fact}}"':
    'Attempting to save to memory {{scope}}: "{{fact}}"',

  // ============================================================================
  // Commands - MCP
  // ============================================================================
  'Authenticate with an OAuth-enabled MCP server':
    'Authenticate with an OAuth-enabled MCP server',
  'List configured MCP servers and tools':
    'List configured MCP servers and tools',
  'Restarts MCP servers.': 'Restarts MCP servers.',
  'Config not loaded.': 'Config not loaded.',
  'Could not retrieve tool registry.': 'Could not retrieve tool registry.',
  'No MCP servers configured with OAuth authentication.':
    'No MCP servers configured with OAuth authentication.',
  'MCP servers with OAuth authentication:':
    'MCP servers with OAuth authentication:',
  'Use /mcp auth <server-name> to authenticate.':
    'Use /mcp auth <server-name> to authenticate.',
  "MCP server '{{name}}' not found.": "MCP server '{{name}}' not found.",
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "Successfully authenticated and refreshed tools for '{{name}}'.",
  "Failed to authenticate with MCP server '{{name}}': {{error}}":
    "Failed to authenticate with MCP server '{{name}}': {{error}}",
  "Re-discovering tools from '{{name}}'...":
    "Re-discovering tools from '{{name}}'...",

  // ============================================================================
  // Commands - Chat
  // ============================================================================
  'Manage conversation history.': 'Manage conversation history.',
  'List saved conversation checkpoints': 'List saved conversation checkpoints',
  'No saved conversation checkpoints found.':
    'No saved conversation checkpoints found.',
  'List of saved conversations:': 'List of saved conversations:',
  'Note: Newest last, oldest first': 'Note: Newest last, oldest first',
  'Save the current conversation as a checkpoint. Usage: /chat save <tag>':
    'Save the current conversation as a checkpoint. Usage: /chat save <tag>',
  'Missing tag. Usage: /chat save <tag>':
    'Missing tag. Usage: /chat save <tag>',
  'Delete a conversation checkpoint. Usage: /chat delete <tag>':
    'Delete a conversation checkpoint. Usage: /chat delete <tag>',
  'Missing tag. Usage: /chat delete <tag>':
    'Missing tag. Usage: /chat delete <tag>',
  "Conversation checkpoint '{{tag}}' has been deleted.":
    "Conversation checkpoint '{{tag}}' has been deleted.",
  "Error: No checkpoint found with tag '{{tag}}'.":
    "Error: No checkpoint found with tag '{{tag}}'.",
  'Resume a conversation from a checkpoint. Usage: /chat resume <tag>':
    'Resume a conversation from a checkpoint. Usage: /chat resume <tag>',
  'Missing tag. Usage: /chat resume <tag>':
    'Missing tag. Usage: /chat resume <tag>',
  'No saved checkpoint found with tag: {{tag}}.':
    'No saved checkpoint found with tag: {{tag}}.',
  'A checkpoint with the tag {{tag}} already exists. Do you want to overwrite it?':
    'A checkpoint with the tag {{tag}} already exists. Do you want to overwrite it?',
  'No chat client available to save conversation.':
    'No chat client available to save conversation.',
  'Conversation checkpoint saved with tag: {{tag}}.':
    'Conversation checkpoint saved with tag: {{tag}}.',
  'No conversation found to save.': 'No conversation found to save.',
  'No chat client available to share conversation.':
    'No chat client available to share conversation.',
  'Invalid file format. Only .md and .json are supported.':
    'Invalid file format. Only .md and .json are supported.',
  'Error sharing conversation: {{error}}':
    'Error sharing conversation: {{error}}',
  'Conversation shared to {{filePath}}': 'Conversation shared to {{filePath}}',
  'No conversation found to share.': 'No conversation found to share.',
  'Share the current conversation to a markdown or json file. Usage: /chat share <file>':
    'Share the current conversation to a markdown or json file. Usage: /chat share <file>',

  // ============================================================================
  // Commands - Summary
  // ============================================================================
  'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md':
    'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md',
  'No chat client available to generate summary.':
    'No chat client available to generate summary.',
  'Already generating summary, wait for previous request to complete':
    'Already generating summary, wait for previous request to complete',
  'No conversation found to summarize.': 'No conversation found to summarize.',
  'Failed to generate project context summary: {{error}}':
    'Failed to generate project context summary: {{error}}',

  // ============================================================================
  // Commands - Model
  // ============================================================================
  'Switch the model for this session': 'Switch the model for this session',
  'Content generator configuration not available.':
    'Content generator configuration not available.',
  'Authentication type not available.': 'Authentication type not available.',
  'No models available for the current authentication type ({{authType}}).':
    'No models available for the current authentication type ({{authType}}).',

  // ============================================================================
  // Commands - Clear
  // ============================================================================
  'Clearing terminal and resetting chat.':
    'Clearing terminal and resetting chat.',
  'Clearing terminal.': 'Clearing terminal.',

  // ============================================================================
  // Commands - Compress
  // ============================================================================
  'Already compressing, wait for previous request to complete':
    'Already compressing, wait for previous request to complete',
  'Failed to compress chat history.': 'Failed to compress chat history.',
  'Failed to compress chat history: {{error}}':
    'Failed to compress chat history: {{error}}',

  // ============================================================================
  // Commands - Docs
  // ============================================================================
  'Please open the following URL in your browser to view the documentation:\n{{url}}':
    'Please open the following URL in your browser to view the documentation:\n{{url}}',
  'Opening documentation in your browser: {{url}}':
    'Opening documentation in your browser: {{url}}',

  // ============================================================================
  // Dialogs - Tool Confirmation
  // ============================================================================
  'Do you want to proceed?': 'Do you want to proceed?',
  'Yes, allow once': 'Yes, allow once',
  'Allow always': 'Allow always',
  No: 'No',
  'No (esc)': 'No (esc)',
  'Yes, allow always for this session': 'Yes, allow always for this session',
  'Modify in progress:': 'Modify in progress:',
  'Save and close external editor to continue':
    'Save and close external editor to continue',
  'Apply this change?': 'Apply this change?',
  'Yes, allow always': 'Yes, allow always',
  'Modify with external editor': 'Modify with external editor',
  'No, suggest changes (esc)': 'No, suggest changes (esc)',
  "Allow execution of: '{{command}}'?": "Allow execution of: '{{command}}'?",
  'Yes, allow always ...': 'Yes, allow always ...',
  'Yes, and auto-accept edits': 'Yes, and auto-accept edits',
  'Yes, and manually approve edits': 'Yes, and manually approve edits',
  'No, keep planning (esc)': 'No, keep planning (esc)',
  'URLs to fetch:': 'URLs to fetch:',
  'MCP Server: {{server}}': 'MCP Server: {{server}}',
  'Tool: {{tool}}': 'Tool: {{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?',
  'Yes, always allow tool "{{tool}}" from server "{{server}}"':
    'Yes, always allow tool "{{tool}}" from server "{{server}}"',
  'Yes, always allow all tools from server "{{server}}"':
    'Yes, always allow all tools from server "{{server}}"',

  // ============================================================================
  // Dialogs - Shell Confirmation
  // ============================================================================
  'Shell Command Execution': 'Shell Command Execution',
  'A custom command wants to run the following shell commands:':
    'A custom command wants to run the following shell commands:',

  // ============================================================================
  // Dialogs - Quit Confirmation
  // ============================================================================
  'What would you like to do before exiting?':
    'What would you like to do before exiting?',
  'Quit immediately (/quit)': 'Quit immediately (/quit)',
  'Generate summary and quit (/summary)':
    'Generate summary and quit (/summary)',
  'Save conversation and quit (/chat save)':
    'Save conversation and quit (/chat save)',
  'Cancel (stay in application)': 'Cancel (stay in application)',

  // ============================================================================
  // Dialogs - Pro Quota
  // ============================================================================
  'Pro quota limit reached for {{model}}.':
    'Pro quota limit reached for {{model}}.',
  'Change auth (executes the /auth command)':
    'Change auth (executes the /auth command)',
  'Continue with {{model}}': 'Continue with {{model}}',

  // ============================================================================
  // Dialogs - Welcome Back
  // ============================================================================
  'Current Plan:': 'Current Plan:',
  'Progress: {{done}}/{{total}} tasks completed':
    'Progress: {{done}}/{{total}} tasks completed',
  ', {{inProgress}} in progress': ', {{inProgress}} in progress',
  'Pending Tasks:': 'Pending Tasks:',
  'What would you like to do?': 'What would you like to do?',
  'Choose how to proceed with your session:':
    'Choose how to proceed with your session:',
  'Start new chat session': 'Start new chat session',
  'Continue previous conversation': 'Continue previous conversation',
  '👋 Welcome back! (Last updated: {{timeAgo}})':
    '👋 Welcome back! (Last updated: {{timeAgo}})',
  '🎯 Overall Goal:': '🎯 Overall Goal:',

  // ============================================================================
  // Dialogs - Auth
  // ============================================================================
  'Get started': 'Get started',
  'How would you like to authenticate for this project?':
    'How would you like to authenticate for this project?',
  'OpenAI API key is required to use OpenAI authentication.':
    'OpenAI API key is required to use OpenAI authentication.',
  'You must select an auth method to proceed. Press Ctrl+C again to exit.':
    'You must select an auth method to proceed. Press Ctrl+C again to exit.',
  '(Use Enter to Set Auth)': '(Use Enter to Set Auth)',
  'Terms of Services and Privacy Notice for Qwen Code':
    'Terms of Services and Privacy Notice for Qwen Code',
  'Qwen OAuth': 'Qwen OAuth',
  OpenAI: 'OpenAI',
  'Failed to login. Message: {{message}}':
    'Failed to login. Message: {{message}}',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.',
  'Qwen OAuth authentication timed out. Please try again.':
    'Qwen OAuth authentication timed out. Please try again.',
  'Qwen OAuth authentication cancelled.':
    'Qwen OAuth authentication cancelled.',
  'Qwen OAuth Authentication': 'Qwen OAuth Authentication',
  'Please visit this URL to authorize:': 'Please visit this URL to authorize:',
  'Or scan the QR code below:': 'Or scan the QR code below:',
  'Waiting for authorization': 'Waiting for authorization',
  'Time remaining:': 'Time remaining:',
  '(Press ESC or CTRL+C to cancel)': '(Press ESC or CTRL+C to cancel)',
  'Qwen OAuth Authentication Timeout': 'Qwen OAuth Authentication Timeout',
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.',
  'Press any key to return to authentication type selection.':
    'Press any key to return to authentication type selection.',
  'Waiting for Qwen OAuth authentication...':
    'Waiting for Qwen OAuth authentication...',

  // ============================================================================
  // Dialogs - Model
  // ============================================================================
  'Select Model': 'Select Model',
  '(Press Esc to close)': '(Press Esc to close)',
  'The latest Qwen Coder model from Alibaba Cloud ModelStudio (version: qwen3-coder-plus-2025-09-23)':
    'The latest Qwen Coder model from Alibaba Cloud ModelStudio (version: qwen3-coder-plus-2025-09-23)',
  'The latest Qwen Vision model from Alibaba Cloud ModelStudio (version: qwen3-vl-plus-2025-09-23)':
    'The latest Qwen Vision model from Alibaba Cloud ModelStudio (version: qwen3-vl-plus-2025-09-23)',

  // ============================================================================
  // Dialogs - Permissions
  // ============================================================================
  'Manage folder trust settings': 'Manage folder trust settings',

  // ============================================================================
  // Status Bar
  // ============================================================================
  'Using:': 'Using:',
  '{{count}} open file': '{{count}} open file',
  '{{count}} open files': '{{count}} open files',
  '(ctrl+g to view)': '(ctrl+g to view)',
  '{{count}} {{name}} file': '{{count}} {{name}} file',
  '{{count}} {{name}} files': '{{count}} {{name}} files',
  '{{count}} MCP server': '{{count}} MCP server',
  '{{count}} MCP servers': '{{count}} MCP servers',
  '{{count}} Blocked': '{{count}} Blocked',
  '(ctrl+t to view)': '(ctrl+t to view)',
  '(ctrl+t to toggle)': '(ctrl+t to toggle)',
  'Press Ctrl+C again to exit.': 'Press Ctrl+C again to exit.',
  'Press Ctrl+D again to exit.': 'Press Ctrl+D again to exit.',
  'Press Esc again to clear.': 'Press Esc again to clear.',

  // ============================================================================
  // MCP Status
  // ============================================================================
  'No MCP servers configured.': 'No MCP servers configured.',
  'Please view MCP documentation in your browser:':
    'Please view MCP documentation in your browser:',
  'or use the cli /docs command': 'or use the cli /docs command',
  '⏳ MCP servers are starting up ({{count}} initializing)...':
    '⏳ MCP servers are starting up ({{count}} initializing)...',
  'Note: First startup may take longer. Tool availability will update automatically.':
    'Note: First startup may take longer. Tool availability will update automatically.',
  'Configured MCP servers:': 'Configured MCP servers:',
  Ready: 'Ready',
  'Starting... (first startup may take longer)':
    'Starting... (first startup may take longer)',
  Disconnected: 'Disconnected',
  '{{count}} tool': '{{count}} tool',
  '{{count}} tools': '{{count}} tools',
  '{{count}} prompt': '{{count}} prompt',
  '{{count}} prompts': '{{count}} prompts',
  '(from {{extensionName}})': '(from {{extensionName}})',
  OAuth: 'OAuth',
  'OAuth expired': 'OAuth expired',
  'OAuth not authenticated': 'OAuth not authenticated',
  'tools and prompts will appear when ready':
    'tools and prompts will appear when ready',
  '{{count}} tools cached': '{{count}} tools cached',
  'Tools:': 'Tools:',
  'Parameters:': 'Parameters:',
  'Prompts:': 'Prompts:',
  Blocked: 'Blocked',
  '💡 Tips:': '💡 Tips:',
  Use: 'Use',
  'to show server and tool descriptions':
    'to show server and tool descriptions',
  'to show tool parameter schemas': 'to show tool parameter schemas',
  'to hide descriptions': 'to hide descriptions',
  'to authenticate with OAuth-enabled servers':
    'to authenticate with OAuth-enabled servers',
  Press: 'Press',
  'to toggle tool descriptions on/off': 'to toggle tool descriptions on/off',
  "Starting OAuth authentication for MCP server '{{name}}'...":
    "Starting OAuth authentication for MCP server '{{name}}'...",
  'Restarting MCP servers...': 'Restarting MCP servers...',

  // ============================================================================
  // Startup Tips
  // ============================================================================
  'Tips for getting started:': 'Tips for getting started:',
  '1. Ask questions, edit files, or run commands.':
    '1. Ask questions, edit files, or run commands.',
  '2. Be specific for the best results.':
    '2. Be specific for the best results.',
  'files to customize your interactions with Qwen Code.':
    'files to customize your interactions with Qwen Code.',
  'for more information.': 'for more information.',

  // ============================================================================
  // Exit Screen / Stats
  // ============================================================================
  'Agent powering down. Goodbye!': 'Agent powering down. Goodbye!',
  'Interaction Summary': 'Interaction Summary',
  'Session ID:': 'Session ID:',
  'Tool Calls:': 'Tool Calls:',
  'Success Rate:': 'Success Rate:',
  'User Agreement:': 'User Agreement:',
  reviewed: 'reviewed',
  'Code Changes:': 'Code Changes:',
  Performance: 'Performance',
  'Wall Time:': 'Wall Time:',
  'Agent Active:': 'Agent Active:',
  'API Time:': 'API Time:',
  'Tool Time:': 'Tool Time:',
  'Session Stats': 'Session Stats',
  'Model Usage': 'Model Usage',
  Reqs: 'Reqs',
  'Input Tokens': 'Input Tokens',
  'Output Tokens': 'Output Tokens',
  'Savings Highlight:': 'Savings Highlight:',
  'of input tokens were served from the cache, reducing costs.':
    'of input tokens were served from the cache, reducing costs.',
  'Tip: For a full token breakdown, run `/stats model`.':
    'Tip: For a full token breakdown, run `/stats model`.',
};
