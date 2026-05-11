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
  // Attachment hints
  '↑ to manage attachments': '↑ to manage attachments',
  '← → select, Delete to remove, ↓ to exit':
    '← → select, Delete to remove, ↓ to exit',
  'Attachments: ': 'Attachments: ',
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
  'to toggle compact mode': 'to toggle compact mode',
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
  Status: 'Status',

  // ============================================================================
  // System Information Fields
  // ============================================================================
  'Qwen Code': 'Qwen Code',
  Runtime: 'Runtime',
  OS: 'OS',
  Auth: 'Auth',
  Model: 'Model',
  'Fast Model': 'Fast Model',
  Sandbox: 'Sandbox',
  'Session ID': 'Session ID',
  'Base URL': 'Base URL',
  Proxy: 'Proxy',
  'Memory Usage': 'Memory Usage',
  'IDE Client': 'IDE Client',

  // ============================================================================
  // Commands - General
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    'Analyzes the project and creates a tailored QWEN.md file.',
  'List available Qwen Code tools. Usage: /tools [desc]':
    'List available Qwen Code tools. Usage: /tools [desc]',
  'List available skills.': 'List available skills.',
  'Available Qwen Code CLI tools:': 'Available Qwen Code CLI tools:',
  'No tools available': 'No tools available',
  'View or change the approval mode for tool usage':
    'View or change the approval mode for tool usage',
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}':
    'Invalid approval mode "{{arg}}". Valid modes: {{modes}}',
  'Approval mode set to "{{mode}}"': 'Approval mode set to "{{mode}}"',
  'View or change the language setting': 'View or change the language setting',
  'List background tasks (text dump — interactive dialog opens via the footer pill)':
    'List background tasks (text dump — interactive dialog opens via the footer pill)',
  'Delete a previous session': 'Delete a previous session',
  'Run installation and environment diagnostics':
    'Run installation and environment diagnostics',
  'Browse dynamic model catalogs and choose which models stay enabled locally':
    'Browse dynamic model catalogs and choose which models stay enabled locally',
  'Generate a one-line session recap now':
    'Generate a one-line session recap now',
  'Rename the current conversation. --auto lets the fast model pick a title.':
    'Rename the current conversation. --auto lets the fast model pick a title.',
  'Rewind conversation to a previous turn':
    'Rewind conversation to a previous turn',
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
  'Configure authentication information for login':
    'Configure authentication information for login',
  'Copy the last result or code snippet to clipboard':
    'Copy the last result or code snippet to clipboard',
  'Show working-tree change stats versus HEAD':
    'Show working-tree change stats versus HEAD',
  'Could not determine current working directory.':
    'Could not determine current working directory.',
  'Failed to compute git diff stats': 'Failed to compute git diff stats',
  'No diff available. Either this is not a git repository, HEAD is missing, or a merge/rebase/cherry-pick/revert is in progress.':
    'No diff available. Either this is not a git repository, HEAD is missing, or a merge/rebase/cherry-pick/revert is in progress.',
  'Clean working tree — no changes against HEAD.':
    'Clean working tree — no changes against HEAD.',
  '{{count}} file changed, +{{added}} / -{{removed}}':
    '{{count}} file changed, +{{added}} / -{{removed}}',
  '{{count}} files changed, +{{added}} / -{{removed}}':
    '{{count}} files changed, +{{added}} / -{{removed}}',
  '{{count}} file changed': '{{count}} file changed',
  '{{count}} files changed': '{{count}} files changed',
  '…and {{hidden}} more (showing first {{shown}})':
    '…and {{hidden}} more (showing first {{shown}})',
  '(binary)': '(binary)',
  '(binary, new)': '(binary, new)',
  '(new)': '(new)',
  '(new, partial)': '(new, partial)',
  '(deleted)': '(deleted)',
  '(binary, deleted)': '(binary, deleted)',

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
  'Enter to submit, Esc to go back': 'Enter to submit, Esc to go back',
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
  // Extensions - Management Dialog
  // ============================================================================
  'Manage Extensions': 'Manage Extensions',
  'Extension Details': 'Extension Details',
  'View Extension': 'View Extension',
  'Update Extension': 'Update Extension',
  'Disable Extension': 'Disable Extension',
  'Enable Extension': 'Enable Extension',
  'Uninstall Extension': 'Uninstall Extension',
  'Select Scope': 'Select Scope',
  'User Scope': 'User Scope',
  'Workspace Scope': 'Workspace Scope',
  'No extensions found.': 'No extensions found.',
  'Updating...': 'Updating...',
  Unknown: 'Unknown',
  Error: 'Error',
  'Stopped because': 'Stopped because',
  'Version:': 'Version:',
  'Status:': 'Status:',
  'Are you sure you want to uninstall extension "{{name}}"?':
    'Are you sure you want to uninstall extension "{{name}}"?',
  'This action cannot be undone.': 'This action cannot be undone.',
  'Extension "{{name}}" updated successfully.':
    'Extension "{{name}}" updated successfully.',
  // Extension dialog - missing keys
  'Name:': 'Name:',
  'MCP Servers:': 'MCP Servers:',
  'Settings:': 'Settings:',
  active: 'active',
  disabled: 'disabled',
  enabled: 'enabled',
  'View Details': 'View Details',
  'Update failed:': 'Update failed:',
  'Updating {{name}}...': 'Updating {{name}}...',
  'Update complete!': 'Update complete!',
  'User (global)': 'User (global)',
  'Workspace (project-specific)': 'Workspace (project-specific)',
  'Disable "{{name}}" - Select Scope': 'Disable "{{name}}" - Select Scope',
  'Enable "{{name}}" - Select Scope': 'Enable "{{name}}" - Select Scope',
  'No extension selected': 'No extension selected',
  '{{count}} extensions installed': '{{count}} extensions installed',
  "Use '/extensions install' to install your first extension.":
    "Use '/extensions install' to install your first extension.",
  // Update status values
  'up to date': 'up to date',
  'update available': 'update available',
  'checking...': 'checking...',
  'not updatable': 'not updatable',
  error: 'error',

  // ============================================================================
  // Commands - General (continued)
  // ============================================================================
  'View and edit Qwen Code settings': 'View and edit Qwen Code settings',
  Settings: 'Settings',
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.',
  // ============================================================================
  // Settings Labels
  // ============================================================================
  'Vim Mode': 'Vim Mode',
  'Attribution: commit': 'Attribution: commit',
  'Terminal Bell Notification': 'Terminal Bell Notification',
  'Enable Usage Statistics': 'Enable Usage Statistics',
  Theme: 'Theme',
  'Preferred Editor': 'Preferred Editor',
  'Auto-connect to IDE': 'Auto-connect to IDE',
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
  'Screen Reader Mode': 'Screen Reader Mode',
  'Max Session Turns': 'Max Session Turns',
  'Skip Next Speaker Check': 'Skip Next Speaker Check',
  'Skip Loop Detection': 'Skip Loop Detection',
  'Skip Startup Context': 'Skip Startup Context',
  'Enable OpenAI Logging': 'Enable OpenAI Logging',
  'OpenAI Logging Directory': 'OpenAI Logging Directory',
  Timeout: 'Timeout',
  'Max Retries': 'Max Retries',
  'Load Memory From Include Directories':
    'Load Memory From Include Directories',
  'Respect .gitignore': 'Respect .gitignore',
  'Respect .qwenignore': 'Respect .qwenignore',
  'Enable Recursive File Search': 'Enable Recursive File Search',
  'Interactive Shell (PTY)': 'Interactive Shell (PTY)',
  'Show Color': 'Show Color',
  'Auto Accept': 'Auto Accept',
  'Use Ripgrep': 'Use Ripgrep',
  'Use Builtin Ripgrep': 'Use Builtin Ripgrep',
  'Tool Output Truncation Threshold': 'Tool Output Truncation Threshold',
  'Tool Output Truncation Lines': 'Tool Output Truncation Lines',
  'Folder Trust': 'Folder Trust',
  'Tool Schema Compliance': 'Tool Schema Compliance',
  // Settings enum options
  'Auto (detect from system)': 'Auto (detect from system)',
  'Auto (detect terminal theme)': 'Auto (detect terminal theme)',
  Auto: 'Auto',
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
  'Manage installed extensions': 'Manage installed extensions',
  'Disable an extension': 'Disable an extension',
  'Enable an extension': 'Enable an extension',
  'Install an extension from a git repo or local path':
    'Install an extension from a git repo or local path',
  'Uninstall an extension': 'Uninstall an extension',
  'No extensions installed.': 'No extensions installed.',
  'Extension "{{name}}" not found.': 'Extension "{{name}}" not found.',
  'No extensions to update.': 'No extensions to update.',
  'Usage: /extensions install <source>': 'Usage: /extensions install <source>',
  'Installing extension from "{{source}}"...':
    'Installing extension from "{{source}}"...',
  'Extension "{{name}}" installed successfully.':
    'Extension "{{name}}" installed successfully.',
  'Failed to install extension from "{{source}}": {{error}}':
    'Failed to install extension from "{{source}}": {{error}}',
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
  'The name of the extension to update.':
    'The name of the extension to update.',
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
  'Manage extension settings': 'Manage extension settings',
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
  // ============================================================================
  // Commands - Hooks
  // ============================================================================
  'Manage Qwen Code hooks': 'Manage Qwen Code hooks',
  'List all configured hooks': 'List all configured hooks',
  // Hooks - Dialog
  Hooks: 'Hooks',
  'Loading hooks...': 'Loading hooks...',
  'Error loading hooks:': 'Error loading hooks:',
  'Press Escape to close': 'Press Escape to close',
  'Press Escape, Ctrl+C, or Ctrl+D to cancel':
    'Press Escape, Ctrl+C, or Ctrl+D to cancel',
  'Press Space, Enter, or Escape to dismiss':
    'Press Space, Enter, or Escape to dismiss',
  'No hook selected': 'No hook selected',
  // Hooks - List Step
  'No hook events found.': 'No hook events found.',
  '{{count}} hook configured': '{{count}} hook configured',
  '{{count}} hooks configured': '{{count}} hooks configured',
  'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.':
    'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.',
  'Enter to select · Esc to cancel': 'Enter to select · Esc to cancel',
  // Hooks - Detail Step
  'Exit codes:': 'Exit codes:',
  'Configured hooks:': 'Configured hooks:',
  'No hooks configured for this event.': 'No hooks configured for this event.',
  'To add hooks, edit settings.json directly or ask Qwen.':
    'To add hooks, edit settings.json directly or ask Qwen.',
  'Enter to select · Esc to go back': 'Enter to select · Esc to go back',
  // Hooks - Config Detail Step
  'Hook details': 'Hook details',
  'Event:': 'Event:',
  'Extension:': 'Extension:',
  'Desc:': 'Desc:',
  'No hook config selected': 'No hook config selected',
  'To modify or remove this hook, edit settings.json directly or ask Qwen to help.':
    'To modify or remove this hook, edit settings.json directly or ask Qwen to help.',
  // Hooks - Disabled Step
  'Hook Configuration - Disabled': 'Hook Configuration - Disabled',
  'All hooks are currently disabled. You have {{count}} that are not running.':
    'All hooks are currently disabled. You have {{count}} that are not running.',
  '{{count}} configured hook': '{{count}} configured hook',
  '{{count}} configured hooks': '{{count}} configured hooks',
  'When hooks are disabled:': 'When hooks are disabled:',
  'No hook commands will execute': 'No hook commands will execute',
  'StatusLine will not be displayed': 'StatusLine will not be displayed',
  'Tool operations will proceed without hook validation':
    'Tool operations will proceed without hook validation',
  'To re-enable hooks, remove "disableAllHooks" from settings.json or ask Qwen Code.':
    'To re-enable hooks, remove "disableAllHooks" from settings.json or ask Qwen Code.',
  // Hooks - Source
  Project: 'Project',
  User: 'User',
  Skill: 'Skill',
  System: 'System',
  Extension: 'Extension',
  'Local Settings': 'Local Settings',
  'User Settings': 'User Settings',
  'System Settings': 'System Settings',
  Extensions: 'Extensions',
  'Session (temporary)': 'Session (temporary)',
  // Hooks - Event Descriptions (short)
  'Before tool execution': 'Before tool execution',
  'After tool execution': 'After tool execution',
  'After tool execution fails': 'After tool execution fails',
  'When notifications are sent': 'When notifications are sent',
  'When the user submits a prompt': 'When the user submits a prompt',
  'When a new session is started': 'When a new session is started',
  'Right before Qwen Code concludes its response':
    'Right before Qwen Code concludes its response',
  'When a subagent (Agent tool call) is started':
    'When a subagent (Agent tool call) is started',
  'Right before a subagent concludes its response':
    'Right before a subagent concludes its response',
  'Before conversation compaction': 'Before conversation compaction',
  'When a session is ending': 'When a session is ending',
  'When a permission dialog is displayed':
    'When a permission dialog is displayed',
  // Hooks - Event Descriptions (detailed)
  'Input to command is JSON of tool call arguments.':
    'Input to command is JSON of tool call arguments.',
  'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).':
    'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).',
  'Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.':
    'Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.',
  'Input to command is JSON with notification message and type.':
    'Input to command is JSON with notification message and type.',
  'Input to command is JSON with original user prompt text.':
    'Input to command is JSON with original user prompt text.',
  'Input to command is JSON with session start source.':
    'Input to command is JSON with session start source.',
  'Input to command is JSON with session end reason.':
    'Input to command is JSON with session end reason.',
  'Input to command is JSON with agent_id and agent_type.':
    'Input to command is JSON with agent_id and agent_type.',
  'Input to command is JSON with agent_id, agent_type, and agent_transcript_path.':
    'Input to command is JSON with agent_id, agent_type, and agent_transcript_path.',
  'Input to command is JSON with compaction details.':
    'Input to command is JSON with compaction details.',
  'Input to command is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing decision to allow or deny.':
    'Input to command is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing decision to allow or deny.',
  // Hooks - Exit Code Descriptions
  'stdout/stderr not shown': 'stdout/stderr not shown',
  'show stderr to model and continue conversation':
    'show stderr to model and continue conversation',
  'show stderr to user only': 'show stderr to user only',
  'stdout shown in transcript mode (ctrl+o)':
    'stdout shown in transcript mode (ctrl+o)',
  'show stderr to model immediately': 'show stderr to model immediately',
  'show stderr to user only but continue with tool call':
    'show stderr to user only but continue with tool call',
  'block processing, erase original prompt, and show stderr to user only':
    'block processing, erase original prompt, and show stderr to user only',
  'stdout shown to Qwen': 'stdout shown to Qwen',
  'show stderr to user only (blocking errors ignored)':
    'show stderr to user only (blocking errors ignored)',
  'command completes successfully': 'command completes successfully',
  'stdout shown to subagent': 'stdout shown to subagent',
  'show stderr to subagent and continue having it run':
    'show stderr to subagent and continue having it run',
  'stdout appended as custom compact instructions':
    'stdout appended as custom compact instructions',
  'block compaction': 'block compaction',
  'show stderr to user only but continue with compaction':
    'show stderr to user only but continue with compaction',
  'use hook decision if provided': 'use hook decision if provided',
  // Hooks - Messages
  'Config not loaded.': 'Config not loaded.',
  'Hooks are not enabled. Enable hooks in settings to use this feature.':
    'Hooks are not enabled. Enable hooks in settings to use this feature.',
  // ============================================================================
  // Commands - Session Export
  // ============================================================================
  'Export current session message history to a file':
    'Export current session message history to a file',
  'Export session to HTML format': 'Export session to HTML format',
  'Export session to JSON format': 'Export session to JSON format',
  'Export session to JSONL format (one message per line)':
    'Export session to JSONL format (one message per line)',
  'Export session to markdown format': 'Export session to markdown format',

  // ============================================================================
  // Commands - Insights
  // ============================================================================
  'generate personalized programming insights from your chat history':
    'generate personalized programming insights from your chat history',

  // ============================================================================
  // Commands - Session History
  // ============================================================================
  'Resume a previous session': 'Resume a previous session',
  'Fork the current conversation into a new session':
    'Fork the current conversation into a new session',
  'Cannot branch while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.':
    'Cannot branch while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.',
  'No conversation to branch.': 'No conversation to branch.',
  'Restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested':
    'Restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested',
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
  'Set UI language': 'Set UI language',
  'Set LLM output language': 'Set LLM output language',
  'Usage: /language ui [{{options}}]': 'Usage: /language ui [{{options}}]',
  'Usage: /language output <language>': 'Usage: /language output <language>',
  'Manage dynamic translation cache': 'Manage dynamic translation cache',
  'Re-translate currently loaded dynamic slash descriptions for the current UI language':
    'Re-translate currently loaded dynamic slash descriptions for the current UI language',
  'Clear cached translations for the current UI language':
    'Clear cached translations for the current UI language',
  'Manage AI translation for dynamic slash command descriptions':
    'Manage AI translation for dynamic slash command descriptions',
  'Enable AI translation for dynamic slash command descriptions':
    'Enable AI translation for dynamic slash command descriptions',
  'Disable AI translation for dynamic slash command descriptions':
    'Disable AI translation for dynamic slash command descriptions',
  'Show AI translation status for dynamic slash command descriptions':
    'Show AI translation status for dynamic slash command descriptions',
  'AI translation for dynamic slash command descriptions is {{status}}.':
    'AI translation for dynamic slash command descriptions is {{status}}.',
  'AI translation for dynamic slash command descriptions is now enabled.':
    'AI translation for dynamic slash command descriptions is now enabled.',
  'AI translation for dynamic slash command descriptions is now disabled.':
    'AI translation for dynamic slash command descriptions is now disabled.',
  'Example: /language output 中文': 'Example: /language output 中文',
  'Example: /language output English': 'Example: /language output English',
  'Example: /language output 日本語': 'Example: /language output 日本語',
  'UI language changed to {{lang}}': 'UI language changed to {{lang}}',
  'LLM output language set to {{lang}}': 'LLM output language set to {{lang}}',
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
  '{{mode}} mode': '{{mode}} mode',
  'Analyze only, do not modify files or execute commands':
    'Analyze only, do not modify files or execute commands',
  'Require approval for file edits or shell commands':
    'Require approval for file edits or shell commands',
  'Automatically approve file edits': 'Automatically approve file edits',
  'Automatically approve all tools': 'Automatically approve all tools',
  'Workspace approval mode exists and takes priority. User-level change will have no effect.':
    'Workspace approval mode exists and takes priority. User-level change will have no effect.',
  'Apply To': 'Apply To',
  'Workspace Settings': 'Workspace Settings',
  'Open auto-memory folder': 'Open auto-memory folder',
  'Auto-memory: {{status}}': 'Auto-memory: {{status}}',
  'Auto-dream: {{status}} · {{lastDream}} · /dream to run':
    'Auto-dream: {{status}} · {{lastDream}} · /dream to run',
  never: 'never',
  on: 'on',
  off: 'off',
  'Remove matching entries from managed auto-memory.':
    'Remove matching entries from managed auto-memory.',
  'Usage: /forget <memory text to remove>':
    'Usage: /forget <memory text to remove>',
  'No managed auto-memory entries matched: {{query}}':
    'No managed auto-memory entries matched: {{query}}',
  'Consolidate managed auto-memory topic files.':
    'Consolidate managed auto-memory topic files.',
  'Open MCP management dialog': 'Open MCP management dialog',
  'Could not retrieve tool registry.': 'Could not retrieve tool registry.',
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "Successfully authenticated and refreshed tools for '{{name}}'.",
  "Re-discovering tools from '{{name}}'...":
    "Re-discovering tools from '{{name}}'...",
  "Discovered {{count}} tool(s) from '{{name}}'.":
    "Discovered {{count}} tool(s) from '{{name}}'.",
  'Authentication complete. Returning to server details...':
    'Authentication complete. Returning to server details...',
  'Authentication successful.': 'Authentication successful.',
  // ============================================================================
  // MCP Management Dialog
  // ============================================================================
  'Manage MCP servers': 'Manage MCP servers',
  'Server Detail': 'Server Detail',
  Tools: 'Tools',
  'Tool Detail': 'Tool Detail',
  'Loading...': 'Loading...',
  'Unknown step': 'Unknown step',
  'Esc to back': 'Esc to back',
  '↑↓ to navigate · Enter to select · Esc to close':
    '↑↓ to navigate · Enter to select · Esc to close',
  '↑↓ to navigate · Enter to select · Esc to back':
    '↑↓ to navigate · Enter to select · Esc to back',
  '↑↓ to navigate · Enter to confirm · Esc to back':
    '↑↓ to navigate · Enter to confirm · Esc to back',
  'User Settings (global)': 'User Settings (global)',
  'Workspace Settings (project-specific)':
    'Workspace Settings (project-specific)',
  'Disable server:': 'Disable server:',
  'Select where to add the server to the exclude list:':
    'Select where to add the server to the exclude list:',
  'Press Enter to confirm, Esc to cancel':
    'Press Enter to confirm, Esc to cancel',
  'View tools': 'View tools',
  Reconnect: 'Reconnect',
  Enable: 'Enable',
  Disable: 'Disable',
  Authenticate: 'Authenticate',
  'Re-authenticate': 'Re-authenticate',
  'Clear Authentication': 'Clear Authentication',
  'Server:': 'Server:',
  'Command:': 'Command:',
  'Working Directory:': 'Working Directory:',
  'No server selected': 'No server selected',
  prompts: 'prompts',
  'Error:': 'Error:',
  tool: 'tool',
  tools: 'tools',
  connected: 'connected',
  connecting: 'connecting',
  disconnected: 'disconnected',

  // MCP Server List
  'User MCPs': 'User MCPs',
  'Project MCPs': 'Project MCPs',
  'Extension MCPs': 'Extension MCPs',
  server: 'server',
  servers: 'servers',
  'Add MCP servers to your settings to get started.':
    'Add MCP servers to your settings to get started.',
  'Run qwen --debug to see error logs': 'Run qwen --debug to see error logs',

  // MCP OAuth Authentication
  'OAuth Authentication': 'OAuth Authentication',
  'Authenticating... Please complete the login in your browser.':
    'Authenticating... Please complete the login in your browser.',
  'Press c to copy the authorization URL to your clipboard.':
    'Press c to copy the authorization URL to your clipboard.',
  'Copy request sent to your terminal. If paste is empty, copy the URL above manually.':
    'Copy request sent to your terminal. If paste is empty, copy the URL above manually.',
  'Cannot write to terminal — copy the URL above manually.':
    'Cannot write to terminal — copy the URL above manually.',
  // MCP Tool List
  'No tools available for this server.': 'No tools available for this server.',
  destructive: 'destructive',
  'read-only': 'read-only',
  'open-world': 'open-world',
  idempotent: 'idempotent',
  'Tools for {{serverName}}': 'Tools for {{serverName}}',
  '{{current}}/{{total}}': '{{current}}/{{total}}',

  // MCP Tool Detail
  required: 'required',
  Parameters: 'Parameters',
  'No tool selected': 'No tool selected',
  Server: 'Server',

  // Invalid tool related translations
  '{{count}} invalid tools': '{{count}} invalid tools',
  invalid: 'invalid',
  'invalid: {{reason}}': 'invalid: {{reason}}',
  'missing name': 'missing name',
  'missing description': 'missing description',
  '(unnamed)': '(unnamed)',
  'Warning: This tool cannot be called by the LLM':
    'Warning: This tool cannot be called by the LLM',
  Reason: 'Reason',
  'Tools must have both name and description to be used by the LLM.':
    'Tools must have both name and description to be used by the LLM.',
  // ===========================================================
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
  'Processing summary...': 'Processing summary...',
  'Project summary generated and saved successfully!':
    'Project summary generated and saved successfully!',
  'Saved to: {{filePath}}': 'Saved to: {{filePath}}',
  'Failed to generate summary - no text content received from LLM response':
    'Failed to generate summary - no text content received from LLM response',

  // ============================================================================
  // Commands - Model
  // ============================================================================
  'Switch the model for this session (--fast for suggestion model, [model-id] to switch immediately).':
    'Switch the model for this session (--fast for suggestion model, [model-id] to switch immediately).',
  'Set a lighter model for prompt suggestions and speculative execution':
    'Set a lighter model for prompt suggestions and speculative execution',
  'Content generator configuration not available.':
    'Content generator configuration not available.',
  'Authentication type not available.': 'Authentication type not available.',
  'No models available for the current authentication type ({{authType}}).':
    'No models available for the current authentication type ({{authType}}).',
  // Needs translation
  ' (not in model registry)': ' (not in model registry)',

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
  Yes: 'Yes',
  No: 'No',
  'No (esc)': 'No (esc)',
  'Modify in progress:': 'Modify in progress:',
  'Save and close external editor to continue':
    'Save and close external editor to continue',
  'Apply this change?': 'Apply this change?',
  'Yes, allow always': 'Yes, allow always',
  'Modify with external editor': 'Modify with external editor',
  'No, suggest changes (esc)': 'No, suggest changes (esc)',
  "Allow execution of: '{{command}}'?": "Allow execution of: '{{command}}'?",
  'Always allow in this project': 'Always allow in this project',
  'Always allow {{action}} in this project':
    'Always allow {{action}} in this project',
  'Always allow for this user': 'Always allow for this user',
  'Always allow {{action}} for this user':
    'Always allow {{action}} for this user',
  'Yes, restore previous mode ({{mode}})':
    'Yes, restore previous mode ({{mode}})',
  'Yes, and auto-accept edits': 'Yes, and auto-accept edits',
  'Yes, and manually approve edits': 'Yes, and manually approve edits',
  'No, keep planning (esc)': 'No, keep planning (esc)',
  'URLs to fetch:': 'URLs to fetch:',
  'MCP Server: {{server}}': 'MCP Server: {{server}}',
  'Tool: {{tool}}': 'Tool: {{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?',
  // ============================================================================
  // Dialogs - Shell Confirmation
  // ============================================================================
  'Shell Command Execution': 'Shell Command Execution',
  'A custom command wants to run the following shell commands:':
    'A custom command wants to run the following shell commands:',
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
  'Select Authentication Method': 'Select Authentication Method',
  'You must select an auth method to proceed. Press Ctrl+C again to exit.':
    'You must select an auth method to proceed. Press Ctrl+C again to exit.',
  'Terms of Services and Privacy Notice':
    'Terms of Services and Privacy Notice',
  'Qwen OAuth': 'Qwen OAuth',
  'Discontinued — switch to Coding Plan or API Key':
    'Discontinued — switch to Coding Plan or API Key',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select Coding Plan or API Key instead.':
    'Qwen OAuth free tier was discontinued on 2026-04-15. Please select Coding Plan or API Key instead.',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.':
    'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.',
  '\n⚠ Qwen OAuth free tier was discontinued on 2026-04-15. Please select another option.\n':
    '\n⚠ Qwen OAuth free tier was discontinued on 2026-04-15. Please select another option.\n',
  'Paid \u00B7 Up to 6,000 requests/5 hrs \u00B7 All Alibaba Cloud Coding Plan Models':
    'Paid \u00B7 Up to 6,000 requests/5 hrs \u00B7 All Alibaba Cloud Coding Plan Models',
  'For teams \u00B7 Paid \u00B7 Up to 6,000 requests/5 hrs \u00B7 All Alibaba Cloud Coding Plan Models':
    'For teams \u00B7 Paid \u00B7 Up to 6,000 requests/5 hrs \u00B7 All Alibaba Cloud Coding Plan Models',
  'For individual developers \u00B7 Pay per model call \u00B7 5-hour/weekly quotas':
    'For individual developers \u00B7 Pay per model call \u00B7 5-hour/weekly quotas',
  Subscribe: 'Subscribe',
  'Paid subscription plans from Alibaba Cloud ModelStudio':
    'Paid subscription plans from Alibaba Cloud ModelStudio',
  'Select Subscription Plan': 'Select Subscription Plan',
  'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
  'Alibaba Cloud Token Plan': 'Alibaba Cloud Token Plan',
  'Pay-as-you-go tokens \u00B7 Configure ModelStudio standard API key':
    'Pay-as-you-go tokens \u00B7 Configure ModelStudio standard API key',
  'For individuals \u00B7 Pay-as-you-go tokens \u00B7 Dedicated Token Plan endpoint':
    'For individuals \u00B7 Pay-as-you-go tokens \u00B7 Dedicated Token Plan endpoint',
  'For teams/companies \u00B7 Credits deducted by token usage \u00B7 Dedicated API key and base URL':
    'For teams/companies \u00B7 Credits deducted by token usage \u00B7 Dedicated API key and base URL',
  'Token Plan documentation': 'Token Plan documentation',
  'Bring your own API key': 'Bring your own API key',
  'Browser-based authentication with third-party providers (e.g. OpenRouter, ModelScope)':
    'Browser-based authentication with third-party providers (e.g. OpenRouter, ModelScope)',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.',
  'Qwen OAuth Authentication': 'Qwen OAuth Authentication',
  'Please visit this URL to authorize:': 'Please visit this URL to authorize:',
  'Waiting for authorization': 'Waiting for authorization',
  'Time remaining:': 'Time remaining:',
  'Qwen OAuth Authentication Timeout': 'Qwen OAuth Authentication Timeout',
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.',
  'Press any key to return to authentication type selection.':
    'Press any key to return to authentication type selection.',
  'Waiting for Qwen OAuth authentication...':
    'Waiting for Qwen OAuth authentication...',
  'Authentication timed out. Please try again.':
    'Authentication timed out. Please try again.',
  'Waiting for auth... (Press ESC or CTRL+C to cancel)':
    'Waiting for auth... (Press ESC or CTRL+C to cancel)',
  'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.':
    'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.',
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
  // ============================================================================
  // Dialogs - Model
  // ============================================================================
  'Select Model': 'Select Model',
  'API Key': 'API Key',
  '(default)': '(default)',
  '(not set)': '(not set)',
  Modality: 'Modality',
  'Context Window': 'Context Window',
  text: 'text',
  'text-only': 'text-only',
  image: 'image',
  pdf: 'pdf',
  audio: 'audio',
  video: 'video',
  'not set': 'not set',
  none: 'none',
  unknown: 'unknown',
  // ============================================================================
  // Dialogs - Permissions
  // ============================================================================
  'Manage folder trust settings': 'Manage folder trust settings',
  'Manage permission rules': 'Manage permission rules',
  Allow: 'Allow',
  Ask: 'Ask',
  Deny: 'Deny',
  Workspace: 'Workspace',
  "Qwen Code won't ask before using allowed tools.":
    "Qwen Code won't ask before using allowed tools.",
  'Qwen Code will ask before using these tools.':
    'Qwen Code will ask before using these tools.',
  'Qwen Code is not allowed to use denied tools.':
    'Qwen Code is not allowed to use denied tools.',
  'Manage trusted directories for this workspace.':
    'Manage trusted directories for this workspace.',
  'Any use of the {{tool}} tool': 'Any use of the {{tool}} tool',
  "{{tool}} commands matching '{{pattern}}'":
    "{{tool}} commands matching '{{pattern}}'",
  'From user settings': 'From user settings',
  'From project settings': 'From project settings',
  'From session': 'From session',
  'Project settings': 'Project settings',
  'Checked in at .qwen/settings.json': 'Checked in at .qwen/settings.json',
  'User settings': 'User settings',
  'Saved in at ~/.qwen/settings.json': 'Saved in at ~/.qwen/settings.json',
  'Add a new rule…': 'Add a new rule…',
  'Add {{type}} permission rule': 'Add {{type}} permission rule',
  'Permission rules are a tool name, optionally followed by a specifier in parentheses.':
    'Permission rules are a tool name, optionally followed by a specifier in parentheses.',
  'e.g.,': 'e.g.,',
  or: 'or',
  'Enter permission rule…': 'Enter permission rule…',
  'Enter to submit · Esc to cancel': 'Enter to submit · Esc to cancel',
  'Where should this rule be saved?': 'Where should this rule be saved?',
  'Enter to confirm · Esc to cancel': 'Enter to confirm · Esc to cancel',
  'Delete {{type}} rule?': 'Delete {{type}} rule?',
  'Are you sure you want to delete this permission rule?':
    'Are you sure you want to delete this permission rule?',
  'Permissions:': 'Permissions:',
  '(←/→ or tab to cycle)': '(←/→ or tab to cycle)',
  'Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel':
    'Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel',
  'Search…': 'Search…',
  // Workspace directory management
  'Add directory…': 'Add directory…',
  'Add directory to workspace': 'Add directory to workspace',
  'Qwen Code can read files in the workspace, and make edits when auto-accept edits is on.':
    'Qwen Code can read files in the workspace, and make edits when auto-accept edits is on.',
  'Qwen Code will be able to read files in this directory and make edits when auto-accept edits is on.':
    'Qwen Code will be able to read files in this directory and make edits when auto-accept edits is on.',
  'Enter the path to the directory:': 'Enter the path to the directory:',
  'Enter directory path…': 'Enter directory path…',
  'Tab to complete · Enter to add · Esc to cancel':
    'Tab to complete · Enter to add · Esc to cancel',
  'Remove directory?': 'Remove directory?',
  'Are you sure you want to remove this directory from the workspace?':
    'Are you sure you want to remove this directory from the workspace?',
  '  (Original working directory)': '  (Original working directory)',
  '  (from settings)': '  (from settings)',
  'Directory does not exist.': 'Directory does not exist.',
  'Path is not a directory.': 'Path is not a directory.',
  'This directory is already in the workspace.':
    'This directory is already in the workspace.',
  'Already covered by existing directory: {{dir}}':
    'Already covered by existing directory: {{dir}}',

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
  'Press ↑ to edit queued messages': 'Press ↑ to edit queued messages',

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
  'Try /insight to generate personalized insights from your chat history.':
    'Try /insight to generate personalized insights from your chat history.',
  'Press Ctrl+O to toggle compact mode — hide tool output and thinking for a cleaner view.':
    'Press Ctrl+O to toggle compact mode — hide tool output and thinking for a cleaner view.',
  'Add a QWEN.md file to give Qwen Code persistent project context.':
    'Add a QWEN.md file to give Qwen Code persistent project context.',
  'Use /btw to ask a quick side question without disrupting the conversation.':
    'Use /btw to ask a quick side question without disrupting the conversation.',
  'Context is almost full! Run /compress now or start /new to continue.':
    'Context is almost full! Run /compress now or start /new to continue.',
  'Context is getting full. Use /compress to free up space.':
    'Context is getting full. Use /compress to free up space.',
  'Long conversation? /compress summarizes history to free context.':
    'Long conversation? /compress summarizes history to free context.',

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
  'Current tasks': 'Current tasks',
  'Background tasks': 'Background tasks',
  'No tasks currently running': 'No tasks currently running',
  'No entry to show.': 'No entry to show.',
  Running: 'Running',
  Paused: 'Paused',
  Completed: 'Completed',
  Failed: 'Failed',
  Stopped: 'Stopped',
  Shell: 'Shell',
  Monitor: 'Monitor',
  Command: 'Command',
  Dream: 'Dream',
  '[dream] memory consolidation': '[dream] memory consolidation',
  '[dream] memory consolidation (reviewing {{count}} session)':
    '[dream] memory consolidation (reviewing {{count}} session)',
  '[dream] memory consolidation (reviewing {{count}} sessions)':
    '[dream] memory consolidation (reviewing {{count}} sessions)',
  '{{count}} session': '{{count}} session',
  '{{count}} sessions': '{{count}} sessions',
  '{{count}} topic': '{{count}} topic',
  '{{count}} topics': '{{count}} topics',
  '{{count}} tokens': '{{count}} tokens',
  '{{count}} tool call': '{{count}} tool call',
  '{{count}} tool calls': '{{count}} tool calls',
  '{{count}} event': '{{count}} event',
  '{{count}} events': '{{count}} events',
  '{{count}} dropped': '{{count}} dropped',
  'pid {{pid}}': 'pid {{pid}}',
  'exit {{exitCode}}': 'exit {{exitCode}}',
  'Sessions reviewing': 'Sessions reviewing',
  Progress: 'Progress',
  'Resume blocked': 'Resume blocked',
  'Working dir': 'Working dir',
  'Output file': 'Output file',
  'Topics touched ({{count}})': 'Topics touched ({{count}})',
  '{{count}} more': '{{count}} more',
  'Lock release warning': 'Lock release warning',
  'Metadata write warning': 'Metadata write warning',
  "Subsequent dreams may be skipped as locked until the next session's staleness sweep cleans the file.":
    "Subsequent dreams may be skipped as locked until the next session's staleness sweep cleans the file.",
  "The scheduler gate did not see this dream's timestamp; the next dream cycle may re-fire sooner than usual.":
    "The scheduler gate did not see this dream's timestamp; the next dream cycle may re-fire sooner than usual.",
  '... and {{count}} more': '... and {{count}} more',
  'The TOML format is deprecated. Would you like to migrate them to Markdown format?':
    'The TOML format is deprecated. Would you like to migrate them to Markdown format?',
  '(Backups will be created and original files will be preserved)':
    '(Backups will be created and original files will be preserved)',

  // ============================================================================
  // Loading Phrases
  // ============================================================================
  'Waiting for user confirmation...': 'Waiting for user confirmation...',
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
  'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})':
    'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})',
  'Press Ctrl+Y to retry': 'Press Ctrl+Y to retry',
  'No failed request to retry.': 'No failed request to retry.',
  'to retry last request': 'to retry last request',

  // ============================================================================
  // Coding Plan Authentication
  // ============================================================================
  'API key cannot be empty.': 'API key cannot be empty.',
  'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.':
    'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.',
  'You can get your Coding Plan API key here':
    'You can get your Coding Plan API key here',
  'You can get your Token Plan API key here':
    'You can get your Token Plan API key here',
  'API key is stored in settings.env. You can migrate it to a .env file for better security.':
    'API key is stored in settings.env. You can migrate it to a .env file for better security.',
  'New model configurations are available for Alibaba Cloud Coding Plan. Update now?':
    'New model configurations are available for Alibaba Cloud Coding Plan. Update now?',
  'Coding Plan configuration updated successfully. New models are now available.':
    'Coding Plan configuration updated successfully. New models are now available.',
  'Coding Plan API key not found. Please re-authenticate with Coding Plan.':
    'Coding Plan API key not found. Please re-authenticate with Coding Plan.',
  'Failed to update Coding Plan configuration: {{message}}':
    'Failed to update Coding Plan configuration: {{message}}',

  // ============================================================================
  // Custom API Key Configuration
  // ============================================================================
  'You can configure your API key and models in settings.json':
    'You can configure your API key and models in settings.json',
  'Refer to the documentation for setup instructions':
    'Refer to the documentation for setup instructions',

  // ============================================================================
  // Auth Dialog - View Titles and Labels
  // ============================================================================
  'Coding Plan': 'Coding Plan',
  Custom: 'Custom',
  'Select Region for Coding Plan': 'Select Region for Coding Plan',
  'Choose based on where your account is registered':
    'Choose based on where your account is registered',
  'Enter Coding Plan API Key': 'Enter Coding Plan API Key',
  'Enter Token Plan API Key': 'Enter Token Plan API Key',

  // ============================================================================
  // Coding Plan International Updates
  // ============================================================================
  'New model configurations are available for {{region}}. Update now?':
    'New model configurations are available for {{region}}. Update now?',
  '{{region}} configuration updated successfully. Model switched to "{{model}}".':
    '{{region}} configuration updated successfully. Model switched to "{{model}}".',
  // ============================================================================
  // Context Usage Component
  // ============================================================================
  'Context Usage': 'Context Usage',
  '% used': '% used',
  '% context used': '% context used',
  'Context exceeds limit! Use /compress or /clear to reduce.':
    'Context exceeds limit! Use /compress or /clear to reduce.',
  'No API response yet. Send a message to see actual usage.':
    'No API response yet. Send a message to see actual usage.',
  'Estimated pre-conversation overhead': 'Estimated pre-conversation overhead',
  'Context window': 'Context window',
  tokens: 'tokens',
  Used: 'Used',
  Free: 'Free',
  'Autocompact buffer': 'Autocompact buffer',
  'Usage by category': 'Usage by category',
  'System prompt': 'System prompt',
  'Built-in tools': 'Built-in tools',
  'MCP tools': 'MCP tools',
  'Memory files': 'Memory files',
  Skills: 'Skills',
  Messages: 'Messages',
  'Run /context detail for per-item breakdown.':
    'Run /context detail for per-item breakdown.',
  'Show context window usage breakdown. Use "/context detail" for per-item breakdown.':
    'Show context window usage breakdown. Use "/context detail" for per-item breakdown.',
  'body loaded': 'body loaded',
  memory: 'memory',
  '{{region}} configuration updated successfully.':
    '{{region}} configuration updated successfully.',
  'Authenticated successfully with {{region}}. API key and model configs saved to settings.json.':
    'Authenticated successfully with {{region}}. API key and model configs saved to settings.json.',
  'Tip: Use /model to switch between available Coding Plan models.':
    'Tip: Use /model to switch between available Coding Plan models.',
  'Type something...': 'Type something...',
  Submit: 'Submit',
  'Submit answers': 'Submit answers',
  Cancel: 'Cancel',
  'Your answers:': 'Your answers:',
  '(not answered)': '(not answered)',
  'Ready to submit your answers?': 'Ready to submit your answers?',
  '↑/↓: Navigate | ←/→: Switch tabs | Enter: Select':
    '↑/↓: Navigate | ←/→: Switch tabs | Enter: Select',
  '↑/↓: Navigate | Enter: Select | Esc: Cancel':
    '↑/↓: Navigate | Enter: Select | Esc: Cancel',
  'Authenticate using Qwen OAuth': 'Authenticate using Qwen OAuth',
  'Authenticate using Alibaba Cloud Coding Plan':
    'Authenticate using Alibaba Cloud Coding Plan',
  'Region for Coding Plan (china/global)':
    'Region for Coding Plan (china/global)',
  'API key for Coding Plan': 'API key for Coding Plan',
  'Show current authentication status': 'Show current authentication status',
  'Authentication completed successfully.':
    'Authentication completed successfully.',
  'Starting Qwen OAuth authentication...':
    'Starting Qwen OAuth authentication...',
  'Successfully authenticated with Qwen OAuth.':
    'Successfully authenticated with Qwen OAuth.',
  'Failed to authenticate with Qwen OAuth: {{error}}':
    'Failed to authenticate with Qwen OAuth: {{error}}',
  'Processing Alibaba Cloud Coding Plan authentication...':
    'Processing Alibaba Cloud Coding Plan authentication...',
  'Successfully authenticated with Alibaba Cloud Coding Plan.':
    'Successfully authenticated with Alibaba Cloud Coding Plan.',
  'Failed to authenticate with Coding Plan: {{error}}':
    'Failed to authenticate with Coding Plan: {{error}}',
  '中国 (China)': '中国 (China)',
  '阿里云百炼 (aliyun.com)': '阿里云百炼 (aliyun.com)',
  Global: 'Global',
  'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
  'Select region for Coding Plan:': 'Select region for Coding Plan:',
  'Enter your Coding Plan API key: ': 'Enter your Coding Plan API key: ',
  'Select authentication method:': 'Select authentication method:',
  '\n=== Authentication Status ===\n': '\n=== Authentication Status ===\n',
  '⚠️  No authentication method configured.\n':
    '⚠️  No authentication method configured.\n',
  'Run one of the following commands to get started:\n':
    'Run one of the following commands to get started:\n',
  '  qwen auth qwen-oauth     - Authenticate with Qwen OAuth (discontinued)':
    '  qwen auth qwen-oauth     - Authenticate with Qwen OAuth (discontinued)',
  'Or simply run:': 'Or simply run:',
  '  qwen auth                - Interactive authentication setup\n':
    '  qwen auth                - Interactive authentication setup\n',
  '✓ Authentication Method: Qwen OAuth': '✓ Authentication Method: Qwen OAuth',
  '  Type: Free tier (discontinued 2026-04-15)':
    '  Type: Free tier (discontinued 2026-04-15)',
  '  Limit: No longer available': '  Limit: No longer available',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter, Fireworks AI, or another provider.':
    'Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter, Fireworks AI, or another provider.',
  '✓ Authentication Method: Alibaba Cloud Coding Plan':
    '✓ Authentication Method: Alibaba Cloud Coding Plan',
  '中国 (China) - 阿里云百炼': '中国 (China) - 阿里云百炼',
  'Global - Alibaba Cloud': 'Global - Alibaba Cloud',
  '  Region: {{region}}': '  Region: {{region}}',
  '  Current Model: {{model}}': '  Current Model: {{model}}',
  '  Config Version: {{version}}': '  Config Version: {{version}}',
  '  Status: API key configured\n': '  Status: API key configured\n',
  '⚠️  Authentication Method: Alibaba Cloud Coding Plan (Incomplete)':
    '⚠️  Authentication Method: Alibaba Cloud Coding Plan (Incomplete)',
  '  Issue: API key not found in environment or settings\n':
    '  Issue: API key not found in environment or settings\n',
  '  Run `qwen auth coding-plan` to re-configure.\n':
    '  Run `qwen auth coding-plan` to re-configure.\n',
  '✓ Authentication Method: {{type}}': '✓ Authentication Method: {{type}}',
  '  Status: Configured\n': '  Status: Configured\n',
  'Failed to check authentication status: {{error}}':
    'Failed to check authentication status: {{error}}',
  'Select an option:': 'Select an option:',
  'Raw mode not available. Please run in an interactive terminal.':
    'Raw mode not available. Please run in an interactive terminal.',
  '(Use ↑ ↓ arrows to navigate, Enter to select, Ctrl+C to exit)\n':
    '(Use ↑ ↓ arrows to navigate, Enter to select, Ctrl+C to exit)\n',
  'Hide tool output and thinking for a cleaner view (toggle with Ctrl+O).':
    'Hide tool output and thinking for a cleaner view (toggle with Ctrl+O).',
  'Press Ctrl+O to show full tool output':
    'Press Ctrl+O to show full tool output',
  'Switch to plan mode or exit plan mode':
    'Switch to plan mode or exit plan mode',
  'Exited plan mode. Previous approval mode restored.':
    'Exited plan mode. Previous approval mode restored.',
  'Enabled plan mode. The agent will analyze and plan without executing tools.':
    'Enabled plan mode. The agent will analyze and plan without executing tools.',
  'Already in plan mode. Use "/plan exit" to exit plan mode.':
    'Already in plan mode. Use "/plan exit" to exit plan mode.',
  'Not in plan mode. Use "/plan" to enter plan mode first.':
    'Not in plan mode. Use "/plan" to enter plan mode first.',
  "Set up Qwen Code's status line UI": "Set up Qwen Code's status line UI",

  // === Core: added from PR #3328 ===
  'Open the memory manager.': 'Open the memory manager.',
  'Save a durable memory to the memory system.':
    'Save a durable memory to the memory system.',
  'Ask a quick side question without affecting the main conversation':
    'Ask a quick side question without affecting the main conversation',
  'Manage Arena sessions': 'Manage Arena sessions',
  'Start an Arena session with multiple models competing on the same task':
    'Start an Arena session with multiple models competing on the same task',
  'Stop the current Arena session': 'Stop the current Arena session',
  'Show the current Arena session status':
    'Show the current Arena session status',
  'Select a model result and merge its diff into the current workspace':
    'Select a model result and merge its diff into the current workspace',
  'No running Arena session found.': 'No running Arena session found.',
  'No Arena session found. Start one with /arena start.':
    'No Arena session found. Start one with /arena start.',
  'Arena session is still running. Wait for it to complete or use /arena stop first.':
    'Arena session is still running. Wait for it to complete or use /arena stop first.',
  'No successful agent results to select from. All agents failed or were cancelled.':
    'No successful agent results to select from. All agents failed or were cancelled.',
  'Use /arena stop to end the session.': 'Use /arena stop to end the session.',
  'No idle agent found matching "{{name}}".':
    'No idle agent found matching "{{name}}".',
  'Failed to apply changes from {{label}}: {{error}}':
    'Failed to apply changes from {{label}}: {{error}}',
  'Applied changes from {{label}} to workspace. Arena session complete.':
    'Applied changes from {{label}} to workspace. Arena session complete.',
  'Discard all Arena results and clean up worktrees?':
    'Discard all Arena results and clean up worktrees?',
  'Arena results discarded. All worktrees cleaned up.':
    'Arena results discarded. All worktrees cleaned up.',
  'Arena is not supported in non-interactive mode. Use interactive mode to start an Arena session.':
    'Arena is not supported in non-interactive mode. Use interactive mode to start an Arena session.',
  'Arena is not supported in non-interactive mode. Use interactive mode to stop an Arena session.':
    'Arena is not supported in non-interactive mode. Use interactive mode to stop an Arena session.',
  'Arena is not supported in non-interactive mode.':
    'Arena is not supported in non-interactive mode.',
  'An Arena session exists. Use /arena stop or /arena select to end it before starting a new one.':
    'An Arena session exists. Use /arena stop or /arena select to end it before starting a new one.',
  'Usage: /arena start --models model1,model2 <task>':
    'Usage: /arena start --models model1,model2 <task>',
  'Models to compete (required, at least 2)':
    'Models to compete (required, at least 2)',
  'Format: authType:modelId or just modelId':
    'Format: authType:modelId or just modelId',
  'Arena requires at least 2 models. Use --models model1,model2 to specify.':
    'Arena requires at least 2 models. Use --models model1,model2 to specify.',
  'Arena started with {{count}} agents on task: "{{task}}"\nModels:\n{{modelList}}':
    'Arena started with {{count}} agents on task: "{{task}}"\nModels:\n{{modelList}}',
  'Arena panes are running in tmux. Attach with: `{{command}}`':
    'Arena panes are running in tmux. Attach with: `{{command}}`',
  '[{{label}}] failed: {{error}}': '[{{label}}] failed: {{error}}',
  'Loading suggestions...': 'Loading suggestions...',
  'Show per-item context usage breakdown.':
    'Show per-item context usage breakdown.',
};
