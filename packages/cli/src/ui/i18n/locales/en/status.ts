/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const enStatus = {
  'composer.placeholder.vimNormal': "  Press '{shortcut}' for NORMAL mode.",
  'composer.placeholder.vimInsert': "  Press '{shortcut}' for INSERT mode.",
  'composer.placeholder.shell': '  Type your shell command',
  'composer.placeholder.message': '  Type your message or @path/to/file',
  'composer.warning.contextLimit':
    'Context limit reached — compacting before sending. Use /compact or /clear if this keeps happening.',
  'status.hook.running.one': 'Running {event} hook…',
  'status.hook.running.many': 'Running {event} hooks… {settled}/{total}',
  'status.hook.elapsed': '{text} · Hook batch {seconds}s',
  'status.hook.message.one': '{message}…',
  'status.hook.message.many': '{message}… {settled}/{total}',
  'status.startup.preparing': 'Preparing project context…',
  'status.workflow.ignored':
    'Ultracode keyword ignored for this prompt · {shortcut} to undo',
  'status.workflow.requested':
    'Dynamic workflow requested for this turn · {shortcut} to ignore',
  'status.tip': 'Tip: {text}',
  'status.tip.btw':
    'Use /btw to ask a quick side question without interrupting the current work',
  'status.model.generating': 'Generating...',
  'status.model.thinking': 'Thinking...',
  'status.waitingForConfirmation': 'Waiting for user confirmation...',
  'status.loading.cancelAndTimer': '(esc to cancel, {duration})',
  'status.resume.session': 'Resuming session...',
  'status.resume.withMcp': '{resume} ({status})',
  'status.mcp.connecting':
    'Connecting to MCP servers... ({connected}/{total})',
  'status.mcp.waiting': '{progress} - Waiting for: {servers}{suffix}',
  'status.mcp.more': ', +{count} more',
  'status.retry.slow': "This is taking a bit longer, we're still on it.",
  'status.retry.attempt':
    'Trying to reach {model} (Attempt {attempt}/{maxAttempts})',
  'status.modelSuffix': '{model} Model',
  'status.effortDisabled': 'Disabled Effort',
  'status.contextPrefix': 'ctx',
  'status.shellMode': 'Shell mode enabled',
  'status.shellModeAria': 'Shell mode',
  'status.shellModeDisable': ' (esc to disable)',
  'status.rawMarkdownMode': 'raw markdown mode',
  'status.rawMarkdownToggle': ' ({shortcut} to toggle) ',
  'status.contextUsed': '{percentage}% used',
  'status.toast.exitAgain': '{shortcut} exit again to exit.',
  'status.toast.escapeRewind': '{shortcut} again to rewind.',
  'status.toast.escapeClear': '{shortcut} again to clear prompt.',
  'status.transcript.view': 'Press {shortcut} to view detailed transcript',
  'status.transcript.showing':
    'Showing detailed transcript · {shortcut} to return',
  'status.exitWarning': 'Press {shortcut} again to exit',
  'status.permission.mode.default': 'Default',
  'status.permission.mode.acceptEdits': 'Accept Edits',
  'status.permission.mode.auto': 'Auto Mode',
  'status.permission.mode.autoShort': 'Auto',
  'status.permission.mode.dontAsk': "Don't Ask",
  'status.permission.mode.yolo': 'YOLO',
  'status.permission.cycle': '{shortcut} to {mode}',
  'status.permission.untrusted': 'Trust the project folder to change modes',
  'status.permission.planOn': 'plan on',
  'status.permission.goalOn': 'goal on',
  'status.permission.goalPaused': 'goal paused',
  'status.summary.contextFile.one': '1 {name} file',
  'status.summary.contextFile.many': '{count} {name} files',
  'status.summary.contextFallback.one': '1 context file',
  'status.summary.contextFallback.many': '{count} context files',
  'status.summary.mcp.one': '1 MCP server',
  'status.summary.mcp.many': '{count} MCP servers',
  'status.summary.failed': '{count} Failed',
  'mcp.configuration.failed': 'Failed',
  'mcp.configuration.addressMismatch':
    'MCP server address does not match this environment.',
  'mcp.configuration.addressMismatchDetails':
    'MCP server address {address} does not belong to the current environment.',
  'status.summary.blocked': '{count} Blocked',
  'status.summary.blockedMcp.one': '1 Blocked MCP server',
  'status.summary.blockedMcp.many': '{count} Blocked MCP servers',
  'status.summary.skill.one': '1 skill',
  'status.summary.skill.many': '{count} skills',
  'status.summary.background.one': '1 Background task',
  'status.summary.background.many': '{count} Background tasks',
} as const;
