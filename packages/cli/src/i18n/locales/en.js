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
  'YOLO mode': 'YOLO mode',
  'plan mode': 'plan mode',
  'auto-accept edits': 'auto-accept edits',
  'Accepting edits': 'Accepting edits',
  '(shift + tab to cycle)': '(shift + tab to cycle)',
  '(tab to cycle)': '(tab to cycle)',
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
  'Toggle this help display': 'Toggle this help display',
  'Toggle shell mode': 'Toggle shell mode',
  'Open command menu': 'Open command menu',
  'Add file context': 'Add file context',
  'Accept suggestion / Autocomplete': 'Accept suggestion / Autocomplete',
  'Reverse search history': 'Reverse search history',
  'Press ? again to close': 'Press ? again to close',
  // Keyboard shortcuts panel descriptions
  'for shell mode': 'for shell mode',
  'for commands': 'for commands',
  'for file paths': 'for file paths',
  'to clear input': 'to clear input',
  'to cycle approvals': 'to cycle approvals',
  'to quit': 'to quit',
  'for newline': 'for newline',
  'to clear screen': 'to clear screen',
  'to search history': 'to search history',
  'to paste images': 'to paste images',
  'for external editor': 'for external editor',
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
  '? for shortcuts': '? for shortcuts',
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
  'About Qwen Code': 'About Qwen Code',
  Status: 'Status',

  // ============================================================================
  // System Information Fields
  // ============================================================================
  'Qwen Code': 'Qwen Code',
  Runtime: 'Runtime',
  OS: 'OS',
  Auth: 'Auth',
  'CLI Version': 'CLI Version',
  'Git Commit': 'Git Commit',
  Model: 'Model',
  Sandbox: 'Sandbox',
  'OS Platform': 'OS Platform',
  'OS Arch': 'OS Arch',
  'OS Release': 'OS Release',
  'Node.js Version': 'Node.js Version',
  'NPM Version': 'NPM Version',
  'Session ID': 'Session ID',
  'Auth Method': 'Auth Method',
  'Base URL': 'Base URL',
  Proxy: 'Proxy',
  'Memory Usage': 'Memory Usage',
  'IDE Client': 'IDE Client',

  // ============================================================================
  // Commands - General
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    'Analyzes the project and creates a tailored QWEN.md file.',
  'list available Qwen Code tools. Usage: /tools [desc]':
    'list available Qwen Code tools. Usage: /tools [desc]',
  'Available Qwen Code CLI tools:': 'Available Qwen Code CLI tools:',
  'No tools available': 'No tools available',
  'View or change the approval mode for tool usage':
    'View or change the approval mode for tool usage',
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}':
    'Invalid approval mode "{{arg}}". Valid modes: {{modes}}',
  'Approval mode set to "{{mode}}"': 'Approval mode set to "{{mode}}"',
  'View or change the language setting': 'View or change the language setting',
  'change the theme': 'change the theme',
  'Select Theme': 'Select Theme',
  Preview: 'Preview',
  '(Use Enter to select, Tab to configure scope)':
    '(Use Enter to select, Tab to configure scope)',
  '(Use Enter to apply scope, Tab to go back)':
    '(Use Enter to apply scope, Tab to go back)',
  'Theme configuration unavailable due to NO_COLOR env variable.':
    'Theme configuration unavailable due to NO_COLOR env variable.',
  'Theme "{{themeName}}" not found.': 'Theme "{{themeName}}" not found.',
  'Theme "{{themeName}}" not found in selected scope.':
    'Theme "{{themeName}}" not found in selected scope.',
  'Clear conversation history and free up context':
    'Clear conversation history and free up context',
  'Compresses the context by replacing it with a summary.':
    'Compresses the context by replacing it with a summary.',
  'open full Qwen Code documentation in your browser':
    'open full Qwen Code documentation in your browser',
  'Configuration not available.': 'Configuration not available.',
  'change the auth method': 'change the auth method',
  'Configure authentication information for login':
    'Configure authentication information for login',
  'Copy the last result or code snippet to clipboard':
    'Copy the last result or code snippet to clipboard',

  // ============================================================================
  // Commands - Agents
  // ============================================================================
  'Manage subagents for specialized task delegation.':
    'Manage subagents for specialized task delegation.',
  'Manage existing subagents (view, edit, delete).':
    'Manage existing subagents (view, edit, delete).',
  'Create a new subagent with guided setup.':
    'Create a new subagent with guided setup.',

  // ============================================================================
  // Agents - Management Dialog
  // ============================================================================
  Agents: 'Agents',
  'Choose Action': 'Choose Action',
  'Edit {{name}}': 'Edit {{name}}',
  'Edit Tools: {{name}}': 'Edit Tools: {{name}}',
  'Edit Color: {{name}}': 'Edit Color: {{name}}',
  'Delete {{name}}': 'Delete {{name}}',
  'Unknown Step': 'Unknown Step',
  'Esc to close': 'Esc to close',
  'Enter to select, ↑↓ to navigate, Esc to close':
    'Enter to select, ↑↓ to navigate, Esc to close',
  'Esc to go back': 'Esc to go back',
  'Enter to confirm, Esc to cancel': 'Enter to confirm, Esc to cancel',
  'Enter to select, ↑↓ to navigate, Esc to go back':
    'Enter to select, ↑↓ to navigate, Esc to go back',
  'Invalid step: {{step}}': 'Invalid step: {{step}}',
  'No subagents found.': 'No subagents found.',
  "Use '/agents create' to create your first subagent.":
    "Use '/agents create' to create your first subagent.",
  '(built-in)': '(built-in)',
  '(overridden by project level agent)': '(overridden by project level agent)',
  'Project Level ({{path}})': 'Project Level ({{path}})',
  'User Level ({{path}})': 'User Level ({{path}})',
  'Built-in Agents': 'Built-in Agents',
  'Extension Agents': 'Extension Agents',
  'Using: {{count}} agents': 'Using: {{count}} agents',
  'View Agent': 'View Agent',
  'Edit Agent': 'Edit Agent',
  'Delete Agent': 'Delete Agent',
  Back: 'Back',
  'No agent selected': 'No agent selected',
  'File Path: ': 'File Path: ',
  'Tools: ': 'Tools: ',
  'Color: ': 'Color: ',
  'Description:': 'Description:',
  'System Prompt:': 'System Prompt:',
  'Open in editor': 'Open in editor',
  'Edit tools': 'Edit tools',
  'Edit color': 'Edit color',
  '❌ Error:': '❌ Error:',
  'Are you sure you want to delete agent "{{name}}"?':
    'Are you sure you want to delete agent "{{name}}"?',
  // ============================================================================
  // Agents - Creation Wizard
  // ============================================================================
  'Project Level (.qwen/agents/)': 'Project Level (.qwen/agents/)',
  'User Level (~/.qwen/agents/)': 'User Level (~/.qwen/agents/)',
  '✅ Subagent Created Successfully!': '✅ Subagent Created Successfully!',
  'Subagent "{{name}}" has been saved to {{level}} level.':
    'Subagent "{{name}}" has been saved to {{level}} level.',
  'Name: ': 'Name: ',
  'Location: ': 'Location: ',
  '❌ Error saving subagent:': '❌ Error saving subagent:',
  'Warnings:': 'Warnings:',
  'Name "{{name}}" already exists at {{level}} level - will overwrite existing subagent':
    'Name "{{name}}" already exists at {{level}} level - will overwrite existing subagent',
  'Name "{{name}}" exists at user level - project level will take precedence':
    'Name "{{name}}" exists at user level - project level will take precedence',
  'Name "{{name}}" exists at project level - existing subagent will take precedence':
    'Name "{{name}}" exists at project level - existing subagent will take precedence',
  'Description is over {{length}} characters':
    'Description is over {{length}} characters',
  'System prompt is over {{length}} characters':
    'System prompt is over {{length}} characters',
  // Agents - Creation Wizard Steps
  'Step {{n}}: Choose Location': 'Step {{n}}: Choose Location',
  'Step {{n}}: Choose Generation Method':
    'Step {{n}}: Choose Generation Method',
  'Generate with Qwen Code (Recommended)':
    'Generate with Qwen Code (Recommended)',
  'Manual Creation': 'Manual Creation',
  'Describe what this subagent should do and when it should be used. (Be comprehensive for best results)':
    'Describe what this subagent should do and when it should be used. (Be comprehensive for best results)',
  'e.g., Expert code reviewer that reviews code based on best practices...':
    'e.g., Expert code reviewer that reviews code based on best practices...',
  'Generating subagent configuration...':
    'Generating subagent configuration...',
  'Failed to generate subagent: {{error}}':
    'Failed to generate subagent: {{error}}',
  'Step {{n}}: Describe Your Subagent': 'Step {{n}}: Describe Your Subagent',
  'Step {{n}}: Enter Subagent Name': 'Step {{n}}: Enter Subagent Name',
  'Step {{n}}: Enter System Prompt': 'Step {{n}}: Enter System Prompt',
  'Step {{n}}: Enter Description': 'Step {{n}}: Enter Description',
  // Agents - Tool Selection
  'Step {{n}}: Select Tools': 'Step {{n}}: Select Tools',
  'All Tools (Default)': 'All Tools (Default)',
  'All Tools': 'All Tools',
  'Read-only Tools': 'Read-only Tools',
  'Read & Edit Tools': 'Read & Edit Tools',
  'Read & Edit & Execution Tools': 'Read & Edit & Execution Tools',
  'All tools selected, including MCP tools':
    'All tools selected, including MCP tools',
  'Selected tools:': 'Selected tools:',
  'Read-only tools:': 'Read-only tools:',
  'Edit tools:': 'Edit tools:',
  'Execution tools:': 'Execution tools:',
  'Step {{n}}: Choose Background Color': 'Step {{n}}: Choose Background Color',
  'Step {{n}}: Confirm and Save': 'Step {{n}}: Confirm and Save',
  // Agents - Navigation & Instructions
  'Esc to cancel': 'Esc to cancel',
  'Press Enter to save, e to save and edit, Esc to go back':
    'Press Enter to save, e to save and edit, Esc to go back',
  'Press Enter to continue, {{navigation}}Esc to {{action}}':
    'Press Enter to continue, {{navigation}}Esc to {{action}}',
  cancel: 'cancel',
  'go back': 'go back',
  '↑↓ to navigate, ': '↑↓ to navigate, ',
  'Enter a clear, unique name for this subagent.':
    'Enter a clear, unique name for this subagent.',
  'e.g., Code Reviewer': 'e.g., Code Reviewer',
  'Name cannot be empty.': 'Name cannot be empty.',
  "Write the system prompt that defines this subagent's behavior. Be comprehensive for best results.":
    "Write the system prompt that defines this subagent's behavior. Be comprehensive for best results.",
  'e.g., You are an expert code reviewer...':
    'e.g., You are an expert code reviewer...',
  'System prompt cannot be empty.': 'System prompt cannot be empty.',
  'Describe when and how this subagent should be used.':
    'Describe when and how this subagent should be used.',
  'e.g., Reviews code for best practices and potential bugs.':
    'e.g., Reviews code for best practices and potential bugs.',
  'Description cannot be empty.': 'Description cannot be empty.',
  'Failed to launch editor: {{error}}': 'Failed to launch editor: {{error}}',
  'Failed to save and edit subagent: {{error}}':
    'Failed to save and edit subagent: {{error}}',

  // ============================================================================
  // Commands - General (continued)
  // ============================================================================
  'View and edit Qwen Code settings': 'View and edit Qwen Code settings',
  Settings: 'Settings',
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.',
  'The command "/{{command}}" is not supported in non-interactive mode.':
    'The command "/{{command}}" is not supported in non-interactive mode.',
  // ============================================================================
  // Settings Labels
  // ============================================================================
  'Vim Mode': 'Vim Mode',
  'Disable Auto Update': 'Disable Auto Update',
  'Attribution: commit': 'Attribution: commit',
  'Terminal Bell Notification': 'Terminal Bell Notification',
  'Enable Usage Statistics': 'Enable Usage Statistics',
  Theme: 'Theme',
  'Preferred Editor': 'Preferred Editor',
  'Auto-connect to IDE': 'Auto-connect to IDE',
  'Enable Prompt Completion': 'Enable Prompt Completion',
  'Debug Keystroke Logging': 'Debug Keystroke Logging',
  'Language: UI': 'Language: UI',
  'Language: Model': 'Language: Model',
  'Output Format': 'Output Format',
  'Hide Window Title': 'Hide Window Title',
  'Show Status in Title': 'Show Status in Title',
  'Hide Tips': 'Hide Tips',
  'Show Line Numbers in Code': 'Show Line Numbers in Code',
  'Show Citations': 'Show Citations',
  'Custom Witty Phrases': 'Custom Witty Phrases',
  'Show Welcome Back Dialog': 'Show Welcome Back Dialog',
  'Enable User Feedback': 'Enable User Feedback',
  'How is Qwen doing this session? (optional)':
    'How is Qwen doing this session? (optional)',
  Bad: 'Bad',
  Fine: 'Fine',
  Good: 'Good',
  Dismiss: 'Dismiss',
  'Not Sure Yet': 'Not Sure Yet',
  'Any other key': 'Any other key',
  'Disable Loading Phrases': 'Disable Loading Phrases',
  'Screen Reader Mode': 'Screen Reader Mode',
  'IDE Mode': 'IDE Mode',
  'Max Session Turns': 'Max Session Turns',
  'Skip Next Speaker Check': 'Skip Next Speaker Check',
  'Skip Loop Detection': 'Skip Loop Detection',
  'Skip Startup Context': 'Skip Startup Context',
  'Enable OpenAI Logging': 'Enable OpenAI Logging',
  'OpenAI Logging Directory': 'OpenAI Logging Directory',
  Timeout: 'Timeout',
  'Max Retries': 'Max Retries',
  'Disable Cache Control': 'Disable Cache Control',
  'Memory Discovery Max Dirs': 'Memory Discovery Max Dirs',
  'Load Memory From Include Directories':
    'Load Memory From Include Directories',
  'Respect .gitignore': 'Respect .gitignore',
  'Respect .qwenignore': 'Respect .qwenignore',
  'Enable Recursive File Search': 'Enable Recursive File Search',
  'Disable Fuzzy Search': 'Disable Fuzzy Search',
  'Interactive Shell (PTY)': 'Interactive Shell (PTY)',
  'Show Color': 'Show Color',
  'Auto Accept': 'Auto Accept',
  'Use Ripgrep': 'Use Ripgrep',
  'Use Builtin Ripgrep': 'Use Builtin Ripgrep',
  'Enable Tool Output Truncation': 'Enable Tool Output Truncation',
  'Tool Output Truncation Threshold': 'Tool Output Truncation Threshold',
  'Tool Output Truncation Lines': 'Tool Output Truncation Lines',
  'Folder Trust': 'Folder Trust',
  'Vision Model Preview': 'Vision Model Preview',
  'Tool Schema Compliance': 'Tool Schema Compliance',
  // Settings enum options
  'Auto (detect from system)': 'Auto (detect from system)',
  Text: 'Text',
  JSON: 'JSON',
  Plan: 'Plan',
  Default: 'Default',
  'Auto Edit': 'Auto Edit',
  YOLO: 'YOLO',
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
  'Select Editor': 'Select Editor',
  'Editor Preference': 'Editor Preference',
  'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.':
    'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.',
  'Your preferred editor is:': 'Your preferred editor is:',
  'Manage extensions': 'Manage extensions',
  'List active extensions': 'List active extensions',
  'Update extensions. Usage: update <extension-names>|--all':
    'Update extensions. Usage: update <extension-names>|--all',
  'Disable an extension': 'Disable an extension',
  'Enable an extension': 'Enable an extension',
  'Install an extension from a git repo or local path':
    'Install an extension from a git repo or local path',
  'Uninstall an extension': 'Uninstall an extension',
  'No extensions installed.': 'No extensions installed.',
  'Usage: /extensions update <extension-names>|--all':
    'Usage: /extensions update <extension-names>|--all',
  'Extension "{{name}}" not found.': 'Extension "{{name}}" not found.',
  'No extensions to update.': 'No extensions to update.',
  'Usage: /extensions install <source>': 'Usage: /extensions install <source>',
  'Installing extension from "{{source}}"...':
    'Installing extension from "{{source}}"...',
  'Extension "{{name}}" installed successfully.':
    'Extension "{{name}}" installed successfully.',
  'Failed to install extension from "{{source}}": {{error}}':
    'Failed to install extension from "{{source}}": {{error}}',
  'Usage: /extensions uninstall <extension-name>':
    'Usage: /extensions uninstall <extension-name>',
  'Uninstalling extension "{{name}}"...':
    'Uninstalling extension "{{name}}"...',
  'Extension "{{name}}" uninstalled successfully.':
    'Extension "{{name}}" uninstalled successfully.',
  'Failed to uninstall extension "{{name}}": {{error}}':
    'Failed to uninstall extension "{{name}}": {{error}}',
  'Usage: /extensions {{command}} <extension> [--scope=<user|workspace>]':
    'Usage: /extensions {{command}} <extension> [--scope=<user|workspace>]',
  'Unsupported scope "{{scope}}", should be one of "user" or "workspace"':
    'Unsupported scope "{{scope}}", should be one of "user" or "workspace"',
  'Extension "{{name}}" disabled for scope "{{scope}}"':
    'Extension "{{name}}" disabled for scope "{{scope}}"',
  'Extension "{{name}}" enabled for scope "{{scope}}"':
    'Extension "{{name}}" enabled for scope "{{scope}}"',
  'Do you want to continue? [Y/n]: ': 'Do you want to continue? [Y/n]: ',
  'Do you want to continue?': 'Do you want to continue?',
  'Installing extension "{{name}}".': 'Installing extension "{{name}}".',
  '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**':
    '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**',
  'This extension will run the following MCP servers:':
    'This extension will run the following MCP servers:',
  local: 'local',
  remote: 'remote',
  'This extension will add the following commands: {{commands}}.':
    'This extension will add the following commands: {{commands}}.',
  'This extension will append info to your QWEN.md context using {{fileName}}':
    'This extension will append info to your QWEN.md context using {{fileName}}',
  'This extension will exclude the following core tools: {{tools}}':
    'This extension will exclude the following core tools: {{tools}}',
  'This extension will install the following skills:':
    'This extension will install the following skills:',
  'This extension will install the following subagents:':
    'This extension will install the following subagents:',
  'Installation cancelled for "{{name}}".':
    'Installation cancelled for "{{name}}".',
  'You are installing an extension from {{originSource}}. Some features may not work perfectly with Qwen Code.':
    'You are installing an extension from {{originSource}}. Some features may not work perfectly with Qwen Code.',
  '--ref and --auto-update are not applicable for marketplace extensions.':
    '--ref and --auto-update are not applicable for marketplace extensions.',
  'Extension "{{name}}" installed successfully and enabled.':
    'Extension "{{name}}" installed successfully and enabled.',
  'Installs an extension from a git repository URL, local path, or claude marketplace (marketplace-url:plugin-name).':
    'Installs an extension from a git repository URL, local path, or claude marketplace (marketplace-url:plugin-name).',
  'The github URL, local path, or marketplace source (marketplace-url:plugin-name) of the extension to install.':
    'The github URL, local path, or marketplace source (marketplace-url:plugin-name) of the extension to install.',
  'The git ref to install from.': 'The git ref to install from.',
  'Enable auto-update for this extension.':
    'Enable auto-update for this extension.',
  'Enable pre-release versions for this extension.':
    'Enable pre-release versions for this extension.',
  'Acknowledge the security risks of installing an extension and skip the confirmation prompt.':
    'Acknowledge the security risks of installing an extension and skip the confirmation prompt.',
  'The source argument must be provided.':
    'The source argument must be provided.',
  'Extension "{{name}}" successfully uninstalled.':
    'Extension "{{name}}" successfully uninstalled.',
  'Uninstalls an extension.': 'Uninstalls an extension.',
  'The name or source path of the extension to uninstall.':
    'The name or source path of the extension to uninstall.',
  'Please include the name of the extension to uninstall as a positional argument.':
    'Please include the name of the extension to uninstall as a positional argument.',
  'Enables an extension.': 'Enables an extension.',
  'The name of the extension to enable.':
    'The name of the extension to enable.',
  'The scope to enable the extenison in. If not set, will be enabled in all scopes.':
    'The scope to enable the extenison in. If not set, will be enabled in all scopes.',
  'Extension "{{name}}" successfully enabled for scope "{{scope}}".':
    'Extension "{{name}}" successfully enabled for scope "{{scope}}".',
  'Extension "{{name}}" successfully enabled in all scopes.':
    'Extension "{{name}}" successfully enabled in all scopes.',
  'Invalid scope: {{scope}}. Please use one of {{scopes}}.':
    'Invalid scope: {{scope}}. Please use one of {{scopes}}.',
  'Disables an extension.': 'Disables an extension.',
  'The name of the extension to disable.':
    'The name of the extension to disable.',
  'The scope to disable the extenison in.':
    'The scope to disable the extenison in.',
  'Extension "{{name}}" successfully disabled for scope "{{scope}}".':
    'Extension "{{name}}" successfully disabled for scope "{{scope}}".',
  'Extension "{{name}}" successfully updated: {{oldVersion}} → {{newVersion}}.':
    'Extension "{{name}}" successfully updated: {{oldVersion}} → {{newVersion}}.',
  'Unable to install extension "{{name}}" due to missing install metadata':
    'Unable to install extension "{{name}}" due to missing install metadata',
  'Extension "{{name}}" is already up to date.':
    'Extension "{{name}}" is already up to date.',
  'Updates all extensions or a named extension to the latest version.':
    'Updates all extensions or a named extension to the latest version.',
  'Update all extensions.': 'Update all extensions.',
  'Either an extension name or --all must be provided':
    'Either an extension name or --all must be provided',
  'Lists installed extensions.': 'Lists installed extensions.',
  'Path:': 'Path:',
  'Source:': 'Source:',
  'Type:': 'Type:',
  'Ref:': 'Ref:',
  'Release tag:': 'Release tag:',
  'Enabled (User):': 'Enabled (User):',
  'Enabled (Workspace):': 'Enabled (Workspace):',
  'Context files:': 'Context files:',
  'Skills:': 'Skills:',
  'Agents:': 'Agents:',
  'MCP servers:': 'MCP servers:',
  'Link extension failed to install.': 'Link extension failed to install.',
  'Extension "{{name}}" linked successfully and enabled.':
    'Extension "{{name}}" linked successfully and enabled.',
  'Links an extension from a local path. Updates made to the local path will always be reflected.':
    'Links an extension from a local path. Updates made to the local path will always be reflected.',
  'The name of the extension to link.': 'The name of the extension to link.',
  'Set a specific setting for an extension.':
    'Set a specific setting for an extension.',
  'Name of the extension to configure.': 'Name of the extension to configure.',
  'The setting to configure (name or env var).':
    'The setting to configure (name or env var).',
  'The scope to set the setting in.': 'The scope to set the setting in.',
  'List all settings for an extension.': 'List all settings for an extension.',
  'Name of the extension.': 'Name of the extension.',
  'Extension "{{name}}" has no settings to configure.':
    'Extension "{{name}}" has no settings to configure.',
  'Settings for "{{name}}":': 'Settings for "{{name}}":',
  '(workspace)': '(workspace)',
  '(user)': '(user)',
  '[not set]': '[not set]',
  '[value stored in keychain]': '[value stored in keychain]',
  'Value:': 'Value:',
  'Manage extension settings.': 'Manage extension settings.',
  'You need to specify a command (set or list).':
    'You need to specify a command (set or list).',
  // ============================================================================
  // Plugin Choice / Marketplace
  // ============================================================================
  'No plugins available in this marketplace.':
    'No plugins available in this marketplace.',
  'Select a plugin to install from marketplace "{{name}}":':
    'Select a plugin to install from marketplace "{{name}}":',
  'Plugin selection cancelled.': 'Plugin selection cancelled.',
  'Select a plugin from "{{name}}"': 'Select a plugin from "{{name}}"',
  'Use ↑↓ or j/k to navigate, Enter to select, Escape to cancel':
    'Use ↑↓ or j/k to navigate, Enter to select, Escape to cancel',
  '{{count}} more above': '{{count}} more above',
  '{{count}} more below': '{{count}} more below',
  'manage IDE integration': 'manage IDE integration',
  'check status of IDE integration': 'check status of IDE integration',
  'install required IDE companion for {{ideName}}':
    'install required IDE companion for {{ideName}}',
  'enable IDE integration': 'enable IDE integration',
  'disable IDE integration': 'disable IDE integration',
  'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.':
    'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.',
  'Set up GitHub Actions': 'Set up GitHub Actions',
  'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf, Trae)':
    'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf, Trae)',
  'Please restart your terminal for the changes to take effect.':
    'Please restart your terminal for the changes to take effect.',
  'Failed to configure terminal: {{error}}':
    'Failed to configure terminal: {{error}}',
  'Could not determine {{terminalName}} config path on Windows: APPDATA environment variable is not set.':
    'Could not determine {{terminalName}} config path on Windows: APPDATA environment variable is not set.',
  '{{terminalName}} keybindings.json exists but is not a valid JSON array. Please fix the file manually or delete it to allow automatic configuration.':
    '{{terminalName}} keybindings.json exists but is not a valid JSON array. Please fix the file manually or delete it to allow automatic configuration.',
  'File: {{file}}': 'File: {{file}}',
  'Failed to parse {{terminalName}} keybindings.json. The file contains invalid JSON. Please fix the file manually or delete it to allow automatic configuration.':
    'Failed to parse {{terminalName}} keybindings.json. The file contains invalid JSON. Please fix the file manually or delete it to allow automatic configuration.',
  'Error: {{error}}': 'Error: {{error}}',
  'Shift+Enter binding already exists': 'Shift+Enter binding already exists',
  'Ctrl+Enter binding already exists': 'Ctrl+Enter binding already exists',
  'Existing keybindings detected. Will not modify to avoid conflicts.':
    'Existing keybindings detected. Will not modify to avoid conflicts.',
  'Please check and modify manually if needed: {{file}}':
    'Please check and modify manually if needed: {{file}}',
  'Added Shift+Enter and Ctrl+Enter keybindings to {{terminalName}}.':
    'Added Shift+Enter and Ctrl+Enter keybindings to {{terminalName}}.',
  'Modified: {{file}}': 'Modified: {{file}}',
  '{{terminalName}} keybindings already configured.':
    '{{terminalName}} keybindings already configured.',
  'Failed to configure {{terminalName}}.':
    'Failed to configure {{terminalName}}.',
  'Your terminal is already configured for an optimal experience with multiline input (Shift+Enter and Ctrl+Enter).':
    'Your terminal is already configured for an optimal experience with multiline input (Shift+Enter and Ctrl+Enter).',
  'Could not detect terminal type. Supported terminals: VS Code, Cursor, Windsurf, and Trae.':
    'Could not detect terminal type. Supported terminals: VS Code, Cursor, Windsurf, and Trae.',
  'Terminal "{{terminal}}" is not supported yet.':
    'Terminal "{{terminal}}" is not supported yet.',

  // ============================================================================
  // Commands - Language
  // ============================================================================
  'Invalid language. Available: {{options}}':
    'Invalid language. Available: {{options}}',
  'Language subcommands do not accept additional arguments.':
    'Language subcommands do not accept additional arguments.',
  'Current UI language: {{lang}}': 'Current UI language: {{lang}}',
  'Current LLM output language: {{lang}}':
    'Current LLM output language: {{lang}}',
  'LLM output language not set': 'LLM output language not set',
  'Set UI language': 'Set UI language',
  'Set LLM output language': 'Set LLM output language',
  'Usage: /language ui [{{options}}]': 'Usage: /language ui [{{options}}]',
  'Usage: /language output <language>': 'Usage: /language output <language>',
  'Example: /language output 中文': 'Example: /language output 中文',
  'Example: /language output English': 'Example: /language output English',
  'Example: /language output 日本語': 'Example: /language output 日本語',
  'Example: /language output Português': 'Example: /language output Português',
  'UI language changed to {{lang}}': 'UI language changed to {{lang}}',
  'LLM output language set to {{lang}}': 'LLM output language set to {{lang}}',
  'LLM output language rule file generated at {{path}}':
    'LLM output language rule file generated at {{path}}',
  'Please restart the application for the changes to take effect.':
    'Please restart the application for the changes to take effect.',
  'Failed to generate LLM output language rule file: {{error}}':
    'Failed to generate LLM output language rule file: {{error}}',
  'Invalid command. Available subcommands:':
    'Invalid command. Available subcommands:',
  'Available subcommands:': 'Available subcommands:',
  'To request additional UI language packs, please open an issue on GitHub.':
    'To request additional UI language packs, please open an issue on GitHub.',
  'Available options:': 'Available options:',
  'Set UI language to {{name}}': 'Set UI language to {{name}}',

  // ============================================================================
  // Commands - Approval Mode
  // ============================================================================
  'Tool Approval Mode': 'Tool Approval Mode',
  'Current approval mode: {{mode}}': 'Current approval mode: {{mode}}',
  'Available approval modes:': 'Available approval modes:',
  'Approval mode changed to: {{mode}}': 'Approval mode changed to: {{mode}}',
  'Approval mode changed to: {{mode}} (saved to {{scope}} settings{{location}})':
    'Approval mode changed to: {{mode}} (saved to {{scope}} settings{{location}})',
  'Usage: /approval-mode <mode> [--session|--user|--project]':
    'Usage: /approval-mode <mode> [--session|--user|--project]',

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
  'Analyze only, do not modify files or execute commands':
    'Analyze only, do not modify files or execute commands',
  'Require approval for file edits or shell commands':
    'Require approval for file edits or shell commands',
  'Automatically approve file edits': 'Automatically approve file edits',
  'Automatically approve all tools': 'Automatically approve all tools',
  'Workspace approval mode exists and takes priority. User-level change will have no effect.':
    'Workspace approval mode exists and takes priority. User-level change will have no effect.',
  'Apply To': 'Apply To',
  'User Settings': 'User Settings',
  'Workspace Settings': 'Workspace Settings',

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
  'Saved project summary to {{filePathForDisplay}}.':
    'Saved project summary to {{filePathForDisplay}}.',
  'Saving project summary...': 'Saving project summary...',
  'Generating project summary...': 'Generating project summary...',
  'Failed to generate summary - no text content received from LLM response':
    'Failed to generate summary - no text content received from LLM response',

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
  'Starting a new session, resetting chat, and clearing terminal.':
    'Starting a new session, resetting chat, and clearing terminal.',
  'Starting a new session and clearing.':
    'Starting a new session and clearing.',

  // ============================================================================
  // Commands - Compress
  // ============================================================================
  'Already compressing, wait for previous request to complete':
    'Already compressing, wait for previous request to complete',
  'Failed to compress chat history.': 'Failed to compress chat history.',
  'Failed to compress chat history: {{error}}':
    'Failed to compress chat history: {{error}}',
  'Compressing chat history': 'Compressing chat history',
  'Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.':
    'Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.',
  'Compression was not beneficial for this history size.':
    'Compression was not beneficial for this history size.',
  'Chat history compression did not reduce size. This may indicate issues with the compression prompt.':
    'Chat history compression did not reduce size. This may indicate issues with the compression prompt.',
  'Could not compress chat history due to a token counting error.':
    'Could not compress chat history due to a token counting error.',
  'Chat history is already compressed.': 'Chat history is already compressed.',

  // ============================================================================
  // Commands - Directory
  // ============================================================================
  'Configuration is not available.': 'Configuration is not available.',
  'Please provide at least one path to add.':
    'Please provide at least one path to add.',
  'The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.':
    'The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.',
  "Error adding '{{path}}': {{error}}": "Error adding '{{path}}': {{error}}",
  'Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}':
    'Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}',
  'Error refreshing memory: {{error}}': 'Error refreshing memory: {{error}}',
  'Successfully added directories:\n- {{directories}}':
    'Successfully added directories:\n- {{directories}}',
  'Current workspace directories:\n{{directories}}':
    'Current workspace directories:\n{{directories}}',

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
  'Login with QwenChat account to use daily free quota.':
    'Login with QwenChat account to use daily free quota.',
  'API-KEY': 'API-KEY',
  'Use coding plan credentials or your own api-keys/providers.':
    'Use coding plan credentials or your own api-keys/providers.',
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
  'Note: Your existing API key in settings.json will not be cleared when using Qwen OAuth. You can switch back to OpenAI authentication later if needed.':
    'Note: Your existing API key in settings.json will not be cleared when using Qwen OAuth. You can switch back to OpenAI authentication later if needed.',
  'Authentication timed out. Please try again.':
    'Authentication timed out. Please try again.',
  'Waiting for auth... (Press ESC or CTRL+C to cancel)':
    'Waiting for auth... (Press ESC or CTRL+C to cancel)',
  'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.':
    'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.',
  '{{envKeyHint}} environment variable not found.':
    '{{envKeyHint}} environment variable not found.',
  '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.':
    '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.',
  '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.':
    '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.',
  'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.':
    'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.',
  'Anthropic provider missing required baseUrl in modelProviders[].baseUrl.':
    'Anthropic provider missing required baseUrl in modelProviders[].baseUrl.',
  'ANTHROPIC_BASE_URL environment variable not found.':
    'ANTHROPIC_BASE_URL environment variable not found.',
  'Invalid auth method selected.': 'Invalid auth method selected.',
  'Failed to authenticate. Message: {{message}}':
    'Failed to authenticate. Message: {{message}}',
  'Authenticated successfully with {{authType}} credentials.':
    'Authenticated successfully with {{authType}} credentials.',
  'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}':
    'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}',
  'OpenAI Configuration Required': 'OpenAI Configuration Required',
  'Please enter your OpenAI configuration. You can get an API key from':
    'Please enter your OpenAI configuration. You can get an API key from',
  'API Key:': 'API Key:',
  'Invalid credentials: {{errorMessage}}':
    'Invalid credentials: {{errorMessage}}',
  'Failed to validate credentials': 'Failed to validate credentials',
  'Press Enter to continue, Tab/↑↓ to navigate, Esc to cancel':
    'Press Enter to continue, Tab/↑↓ to navigate, Esc to cancel',

  // ============================================================================
  // Dialogs - Model
  // ============================================================================
  'Select Model': 'Select Model',
  '(Press Esc to close)': '(Press Esc to close)',
  'Current (effective) configuration': 'Current (effective) configuration',
  AuthType: 'AuthType',
  'API Key': 'API Key',
  unset: 'unset',
  '(default)': '(default)',
  '(set)': '(set)',
  '(not set)': '(not set)',
  "Failed to switch model to '{{modelId}}'.\n\n{{error}}":
    "Failed to switch model to '{{modelId}}'.\n\n{{error}}",
  'Qwen 3.5 Plus — efficient hybrid model with leading coding performance':
    'Qwen 3.5 Plus — efficient hybrid model with leading coding performance',
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
  'Tips:': 'Tips:',
  'Use /compress when the conversation gets long to summarize history and free up context.':
    'Use /compress when the conversation gets long to summarize history and free up context.',
  'Start a fresh idea with /clear or /new; the previous session stays available in history.':
    'Start a fresh idea with /clear or /new; the previous session stays available in history.',
  'Use /bug to submit issues to the maintainers when something goes off.':
    'Use /bug to submit issues to the maintainers when something goes off.',
  'Switch auth type quickly with /auth.':
    'Switch auth type quickly with /auth.',
  'You can run any shell commands from Qwen Code using ! (e.g. !ls).':
    'You can run any shell commands from Qwen Code using ! (e.g. !ls).',
  'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.':
    'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.',
  'You can resume a previous conversation by running qwen --continue or qwen --resume.':
    'You can resume a previous conversation by running qwen --continue or qwen --resume.',
  'You can switch permission mode quickly with Shift+Tab or /approval-mode.':
    'You can switch permission mode quickly with Shift+Tab or /approval-mode.',
  'You can switch permission mode quickly with Tab or /approval-mode.':
    'You can switch permission mode quickly with Tab or /approval-mode.',

  // ============================================================================
  // Exit Screen / Stats
  // ============================================================================
  'Agent powering down. Goodbye!': 'Agent powering down. Goodbye!',
  'To continue this session, run': 'To continue this session, run',
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
  'Model Stats For Nerds': 'Model Stats For Nerds',
  'Tool Stats For Nerds': 'Tool Stats For Nerds',
  Metric: 'Metric',
  API: 'API',
  Requests: 'Requests',
  Errors: 'Errors',
  'Avg Latency': 'Avg Latency',
  Tokens: 'Tokens',
  Total: 'Total',
  Prompt: 'Prompt',
  Cached: 'Cached',
  Thoughts: 'Thoughts',
  Tool: 'Tool',
  Output: 'Output',
  'No API calls have been made in this session.':
    'No API calls have been made in this session.',
  'Tool Name': 'Tool Name',
  Calls: 'Calls',
  'Success Rate': 'Success Rate',
  'Avg Duration': 'Avg Duration',
  'User Decision Summary': 'User Decision Summary',
  'Total Reviewed Suggestions:': 'Total Reviewed Suggestions:',
  ' » Accepted:': ' » Accepted:',
  ' » Rejected:': ' » Rejected:',
  ' » Modified:': ' » Modified:',
  ' Overall Agreement Rate:': ' Overall Agreement Rate:',
  'No tool calls have been made in this session.':
    'No tool calls have been made in this session.',
  'Session start time is unavailable, cannot calculate stats.':
    'Session start time is unavailable, cannot calculate stats.',

  // ============================================================================
  // Command Format Migration
  // ============================================================================
  'Command Format Migration': 'Command Format Migration',
  'Found {{count}} TOML command file:': 'Found {{count}} TOML command file:',
  'Found {{count}} TOML command files:': 'Found {{count}} TOML command files:',
  '... and {{count}} more': '... and {{count}} more',
  'The TOML format is deprecated. Would you like to migrate them to Markdown format?':
    'The TOML format is deprecated. Would you like to migrate them to Markdown format?',
  '(Backups will be created and original files will be preserved)':
    '(Backups will be created and original files will be preserved)',

  // ============================================================================
  // Loading Phrases
  // ============================================================================
  'Waiting for user confirmation...': 'Waiting for user confirmation...',
  '(esc to cancel, {{time}})': '(esc to cancel, {{time}})',

  // ============================================================================
  // Loading Phrases
  // ============================================================================
  WITTY_LOADING_PHRASES: [
    "I'm Feeling Lucky",
    'Shipping awesomeness... ',
    'Painting the serifs back on...',
    'Navigating the slime mold...',
    'Consulting the digital spirits...',
    'Reticulating splines...',
    'Warming up the AI hamsters...',
    'Asking the magic conch shell...',
    'Generating witty retort...',
    'Polishing the algorithms...',
    "Don't rush perfection (or my code)...",
    'Brewing fresh bytes...',
    'Counting electrons...',
    'Engaging cognitive processors...',
    'Checking for syntax errors in the universe...',
    'One moment, optimizing humor...',
    'Shuffling punchlines...',
    'Untangling neural nets...',
    'Compiling brilliance...',
    'Loading wit.exe...',
    'Summoning the cloud of wisdom...',
    'Preparing a witty response...',
    "Just a sec, I'm debugging reality...",
    'Confuzzling the options...',
    'Tuning the cosmic frequencies...',
    'Crafting a response worthy of your patience...',
    'Compiling the 1s and 0s...',
    'Resolving dependencies... and existential crises...',
    'Defragmenting memories... both RAM and personal...',
    'Rebooting the humor module...',
    'Caching the essentials (mostly cat memes)...',
    'Optimizing for ludicrous speed',
    "Swapping bits... don't tell the bytes...",
    'Garbage collecting... be right back...',
    'Assembling the interwebs...',
    'Converting coffee into code...',
    'Updating the syntax for reality...',
    'Rewiring the synapses...',
    'Looking for a misplaced semicolon...',
    "Greasin' the cogs of the machine...",
    'Pre-heating the servers...',
    'Calibrating the flux capacitor...',
    'Engaging the improbability drive...',
    'Channeling the Force...',
    'Aligning the stars for optimal response...',
    'So say we all...',
    'Loading the next great idea...',
    "Just a moment, I'm in the zone...",
    'Preparing to dazzle you with brilliance...',
    "Just a tick, I'm polishing my wit...",
    "Hold tight, I'm crafting a masterpiece...",
    "Just a jiffy, I'm debugging the universe...",
    "Just a moment, I'm aligning the pixels...",
    "Just a sec, I'm optimizing the humor...",
    "Just a moment, I'm tuning the algorithms...",
    'Warp speed engaged...',
    'Mining for more Dilithium crystals...',
    "Don't panic...",
    'Following the white rabbit...',
    'The truth is in here... somewhere...',
    'Blowing on the cartridge...',
    'Loading... Do a barrel roll!',
    'Waiting for the respawn...',
    'Finishing the Kessel Run in less than 12 parsecs...',
    "The cake is not a lie, it's just still loading...",
    'Fiddling with the character creation screen...',
    "Just a moment, I'm finding the right meme...",
    "Pressing 'A' to continue...",
    'Herding digital cats...',
    'Polishing the pixels...',
    'Finding a suitable loading screen pun...',
    'Distracting you with this witty phrase...',
    'Almost there... probably...',
    'Our hamsters are working as fast as they can...',
    'Giving Cloudy a pat on the head...',
    'Petting the cat...',
    'Rickrolling my boss...',
    'Never gonna give you up, never gonna let you down...',
    'Slapping the bass...',
    'Tasting the snozberries...',
    "I'm going the distance, I'm going for speed...",
    'Is this the real life? Is this just fantasy?...',
    "I've got a good feeling about this...",
    'Poking the bear...',
    'Doing research on the latest memes...',
    'Figuring out how to make this more witty...',
    'Hmmm... let me think...',
    'What do you call a fish with no eyes? A fsh...',
    'Why did the computer go to therapy? It had too many bytes...',
    "Why don't programmers like nature? It has too many bugs...",
    'Why do programmers prefer dark mode? Because light attracts bugs...',
    'Why did the developer go broke? Because they used up all their cache...',
    "What can you do with a broken pencil? Nothing, it's pointless...",
    'Applying percussive maintenance...',
    'Searching for the correct USB orientation...',
    'Ensuring the magic smoke stays inside the wires...',
    'Trying to exit Vim...',
    'Spinning up the hamster wheel...',
    "That's not a bug, it's an undocumented feature...",
    'Engage.',
    "I'll be back... with an answer.",
    'My other process is a TARDIS...',
    'Communing with the machine spirit...',
    'Letting the thoughts marinate...',
    'Just remembered where I put my keys...',
    'Pondering the orb...',
    "I've seen things you people wouldn't believe... like a user who reads loading messages.",
    'Initiating thoughtful gaze...',
    "What's a computer's favorite snack? Microchips.",
    "Why do Java developers wear glasses? Because they don't C#.",
    'Charging the laser... pew pew!',
    'Dividing by zero... just kidding!',
    'Looking for an adult superviso... I mean, processing.',
    'Making it go beep boop.',
    'Buffering... because even AIs need a moment.',
    'Entangling quantum particles for a faster response...',
    'Polishing the chrome... on the algorithms.',
    'Are you not entertained? (Working on it!)',
    'Summoning the code gremlins... to help, of course.',
    'Just waiting for the dial-up tone to finish...',
    'Recalibrating the humor-o-meter.',
    'My other loading screen is even funnier.',
    "Pretty sure there's a cat walking on the keyboard somewhere...",
    'Enhancing... Enhancing... Still loading.',
    "It's not a bug, it's a feature... of this loading screen.",
    'Have you tried turning it off and on again? (The loading screen, not me.)',
    'Constructing additional pylons...',
  ],

  // ============================================================================
  // Extension Settings Input
  // ============================================================================
  'Enter value...': 'Enter value...',
  'Enter sensitive value...': 'Enter sensitive value...',
  'Press Enter to submit, Escape to cancel':
    'Press Enter to submit, Escape to cancel',

  // ============================================================================
  // Command Migration Tool
  // ============================================================================
  'Markdown file already exists: {{filename}}':
    'Markdown file already exists: {{filename}}',
  'TOML Command Format Deprecation Notice':
    'TOML Command Format Deprecation Notice',
  'Found {{count}} command file(s) in TOML format:':
    'Found {{count}} command file(s) in TOML format:',
  'The TOML format for commands is being deprecated in favor of Markdown format.':
    'The TOML format for commands is being deprecated in favor of Markdown format.',
  'Markdown format is more readable and easier to edit.':
    'Markdown format is more readable and easier to edit.',
  'You can migrate these files automatically using:':
    'You can migrate these files automatically using:',
  'Or manually convert each file:': 'Or manually convert each file:',
  'TOML: prompt = "..." / description = "..."':
    'TOML: prompt = "..." / description = "..."',
  'Markdown: YAML frontmatter + content':
    'Markdown: YAML frontmatter + content',
  'The migration tool will:': 'The migration tool will:',
  'Convert TOML files to Markdown': 'Convert TOML files to Markdown',
  'Create backups of original files': 'Create backups of original files',
  'Preserve all command functionality': 'Preserve all command functionality',
  'TOML format will continue to work for now, but migration is recommended.':
    'TOML format will continue to work for now, but migration is recommended.',

  // ============================================================================
  // Extensions - Explore Command
  // ============================================================================
  'Open extensions page in your browser':
    'Open extensions page in your browser',
  'Unknown extensions source: {{source}}.':
    'Unknown extensions source: {{source}}.',
  'Would open extensions page in your browser: {{url}} (skipped in test environment)':
    'Would open extensions page in your browser: {{url}} (skipped in test environment)',
  'View available extensions at {{url}}':
    'View available extensions at {{url}}',
  'Opening extensions page in your browser: {{url}}':
    'Opening extensions page in your browser: {{url}}',
  'Failed to open browser. Check out the extensions gallery at {{url}}':
    'Failed to open browser. Check out the extensions gallery at {{url}}',

  // ============================================================================
  // Retry / Rate Limit
  // ============================================================================
  'Rate limit error: {{reason}}': 'Rate limit error: {{reason}}',
  'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})':
    'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})',

  // ============================================================================
  // Coding Plan Authentication
  // ============================================================================
  'Please enter your API key:': 'Please enter your API key:',
  'API key cannot be empty.': 'API key cannot be empty.',
  'You can get your exclusive Coding Plan API-KEY here:':
    'You can get your exclusive Coding Plan API-KEY here:',
  'API key is stored in settings.env. You can migrate it to a .env file for better security.':
    'API key is stored in settings.env. You can migrate it to a .env file for better security.',
  'New model configurations are available for Bailian Coding Plan. Update now?':
    'New model configurations are available for Bailian Coding Plan. Update now?',
  'Coding Plan configuration updated successfully. New models are now available.':
    'Coding Plan configuration updated successfully. New models are now available.',
  'Coding Plan API key not found. Please re-authenticate with Coding Plan.':
    'Coding Plan API key not found. Please re-authenticate with Coding Plan.',
  'Failed to update Coding Plan configuration: {{message}}':
    'Failed to update Coding Plan configuration: {{message}}',

  // ============================================================================
  // Custom API-KEY Configuration
  // ============================================================================
  'For advanced users who want to configure models manually.':
    'For advanced users who want to configure models manually.',
  'Please configure your models in settings.json:':
    'Please configure your models in settings.json:',
  'Set API key via environment variable (e.g., OPENAI_API_KEY)':
    'Set API key via environment variable (e.g., OPENAI_API_KEY)',
  "Add model configuration to modelProviders['openai'] (or other auth types)":
    "Add model configuration to modelProviders['openai'] (or other auth types)",
  'Each provider needs: id, envKey (required), plus optional baseUrl, generationConfig':
    'Each provider needs: id, envKey (required), plus optional baseUrl, generationConfig',
  'Use /model command to select your preferred model from the configured list':
    'Use /model command to select your preferred model from the configured list',
  'Supported auth types: openai, anthropic, gemini, vertex-ai, etc.':
    'Supported auth types: openai, anthropic, gemini, vertex-ai, etc.',
  'More instructions please check:': 'More instructions please check:',

  // ============================================================================
  // Auth Dialog - View Titles and Labels
  // ============================================================================
  'Coding Plan': 'Coding Plan',
  "Paste your api key of Bailian Coding Plan and you're all set!":
    "Paste your api key of Bailian Coding Plan and you're all set!",
  Custom: 'Custom',
  'More instructions about configuring `modelProviders` manually.':
    'More instructions about configuring `modelProviders` manually.',
  'Select API-KEY configuration mode:': 'Select API-KEY configuration mode:',
  '(Press Escape to go back)': '(Press Escape to go back)',
  '(Press Enter to submit, Escape to cancel)':
    '(Press Enter to submit, Escape to cancel)',
};
