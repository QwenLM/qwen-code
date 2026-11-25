/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const enCommands = {
  'commands.builtin.release-notes.description':
    'Show release notes for recent CLI versions',
  'commands.title': 'Commands',
  'commands.empty': 'No commands available.',
  'commands.search': 'Search commands',
  'commands.noMatches': 'No commands match your search.',
  'commands.kind.builtIn': 'Built-in',
  'commands.kind.dynamic': 'Dynamic',
  'commands.kind.mcp': 'MCP',
  'commands.kind.agent': 'Agent',
  'commands.kind.skill': 'Skill',
  'commands.kind.plugin': 'Plugin',
  'commands.kind.workflow': 'Workflow',
  'commands.builtin.about.description': 'Show version info',
  'commands.builtin.agents.description': 'Manage agents',
  'commands.builtin.agents.reload.description':
    'Reload agents from disk and refresh tools & system prompt',
  'commands.builtin.btw.description':
    'Ask a quick side question without interrupting the main conversation',
  'commands.btw.title': 'Side Question (/btw)',
  'commands.btw.answering': 'Answering…',
  'commands.btw.retry.rateLimited': 'Rate limited',
  'commands.btw.retry.overloaded': 'API overloaded',
  'commands.btw.retry.authentication': 'Authentication failed',
  'commands.btw.retry.generic': 'API error',
  'commands.btw.retry.detail':
    ' · retrying in {seconds}s · attempt {attempt}/{maxRetries}',
  'commands.btw.earlier': '(+{count} earlier /btw)',
  'commands.btw.later': '(+{count} later /btw)',
  'commands.btw.noResponse': 'No response received',
  'commands.btw.cancelled': 'Cancelled',
  'commands.btw.error': 'Error: {message}',
  'commands.btw.hint.browse': '⇧←/→ browse',
  'commands.btw.hint.scroll': '↑↓ scroll',
  'commands.btw.hint.copy': 'c copy',
  'commands.btw.hint.copied': 'Copied to clipboard',
  'commands.btw.hint.copyFailed': 'Copy failed',
  'commands.btw.hint.clearHistory': 'x clear history',
  'commands.builtin.branch.description':
    'Create a new session branch from the current conversation',
  'commands.builtin.subtask.description':
    'Send a subagent off with your full context; its result comes back here',
  'commands.builtin.clear.description':
    'Clear the screen and start a new conversation',
  'commands.builtin.new.description': 'Start a new conversation',
  'commands.builtin.commands.description':
    'Reload and list all available slash commands',
  'commands.builtin.compact.description':
    'Compresses the context by replacing it with a summary',
  'commands.builtin.copy.description':
    'Copy the last assistant response to clipboard, or /copy N for the Nth-latest',
  'commands.builtin.editor.description': 'Set external editor preference',
  'commands.builtin.effort.description':
    'Set reasoning effort for the current model',
  'commands.builtin.export.description':
    'Export the current conversation to a file or clipboard',
  'commands.builtin.help.description':
    'Show application help and keyboard shortcuts',
  'commands.builtin.shortcuts.description':
    'Toggle the shortcuts panel above the input',
  'commands.builtin.hooks.description': 'Open hooks management panel',
  'commands.builtin.diff.description': 'Show uncommitted git changes',
  'commands.builtin.review.description':
    'Review code changes and find actionable issues',
  'commands.builtin.init.description':
    'Analyzes the project and creates a tailored context file',
  'commands.builtin.mcp.description':
    'Manage configured Model Context Protocol (MCP) servers',
  'commands.builtin.mcp.reload.description': 'Reloads MCP servers',
  'commands.builtin.memory.description': 'Commands for interacting with memory',
  'commands.builtin.memory.manage.description':
    'Open interactive TUI for managing auto-memory files',
  'commands.builtin.model.description': 'Set or manage model configuration',
  'commands.builtin.marketplace.add.description': 'Add a marketplace',
  'commands.builtin.marketplace.list.description': 'List marketplaces',
  'commands.builtin.marketplace.remove.description': 'Remove a marketplace',
  'commands.builtin.marketplace.update.description': 'Update marketplace(s)',
  'commands.builtin.plugins.description': 'Manage plugins',
  'commands.builtin.plugins.install.description': 'Install a plugin',
  'commands.builtin.plugins.uninstall.description': 'Uninstall a plugin',
  'commands.builtin.plugins.enable.description': 'Enable a plugin',
  'commands.builtin.plugins.disable.description': 'Disable a plugin',
  'commands.builtin.plugins.update.description': 'Update a plugin',
  'commands.builtin.plugins.validate.description': 'Validate a plugin',
  'commands.builtin.plugins.marketplace.description':
    'Manage plugin marketplaces',
  'commands.builtin.plugins.marketplace.add.description': 'Add a marketplace',
  'commands.builtin.plugins.marketplace.list.description': 'List marketplaces',
  'commands.builtin.plugins.marketplace.remove.description':
    'Remove a marketplace',
  'commands.builtin.plugins.marketplace.update.description':
    'Update marketplace(s)',
  'commands.builtin.plugins.reload.description':
    'Reload all plugins. Usage: /plugins reload',
  'commands.builtin.plan.description':
    'Toggle Plan Mode (enter when off, exit when on)',
  'commands.builtin.plan.copy.description':
    'Copy the currently approved plan to your clipboard',
  'commands.builtin.plan.open.description':
    'Open the current plan file in $EDITOR',
  'commands.builtin.goal.description':
    'Set or manage a persistent goal for the current session',
  'commands.builtin.goal.status.description': 'Show current goal status',
  'commands.builtin.goal.clear.description': 'Remove the current goal',
  'commands.builtin.goal.pause.description': 'Pause the current goal',
  'commands.builtin.goal.resume.description': 'Resume a paused goal',
  'commands.builtin.crontab.description':
    'Manage scheduled loops and cron jobs',
  'commands.builtin.permissions.description': 'Manage permissions',
  'commands.builtin.permissions.list.description':
    'Manage allow & deny tool permission rules',
  'commands.builtin.peers.description':
    'List peer sessions and review held cross-session messages',
  'commands.builtin.profile.description':
    'Inspect or control runtime profiling',
  'commands.builtin.quit.description': 'Exit the application',
  'commands.builtin.rewind.description': 'Open rewind selector',
  'commands.builtin.continue.description':
    'Continue the most recent session for the current project',
  'commands.builtin.rename.description': 'Rename the current conversation',
  'commands.builtin.resume.description':
    'Resume a session by identifier, or open the session browser',
  'commands.builtin.usage.description':
    'Show usage statistics for the current billing period',
  'commands.builtin.status.description': 'Show account and session status',
  'commands.builtin.add-dir.description':
    'Add a directory to the workspace context',
  'commands.builtin.add-dir.list.description':
    'List all directories currently in the workspace context',
  'commands.builtin.context.description':
    'Visualize current context window usage',
  'commands.builtin.context-window.description':
    'Set context window for the current model',
  'commands.builtin.theme.description': 'Change the theme',
  'commands.builtin.skills.description': 'Manage agent skills',
  'commands.builtin.skills.link.description':
    'Link an agent skill from a local path',
  'commands.builtin.skills.reload.description':
    'Reload the list of discovered skills',
  'commands.builtin.settings.description': 'View and edit application settings',
  'commands.builtin.statusline.description': 'Set up a custom status line',
  'commands.builtin.tasks.description': 'Show background tasks panel',
  'commands.builtin.workflows.description':
    'Browse workflow tasks in the session rail',
  'commands.builtin.vim.description': 'Toggle vim mode on/off for this session',
  'commands.builtin.terminal-setup.description':
    'Configure recommended terminal shortcuts',
} as const;
