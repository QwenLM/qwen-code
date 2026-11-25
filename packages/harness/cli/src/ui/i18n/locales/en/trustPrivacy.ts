/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const enTrustPrivacy = {
  'trust.title': 'Do you trust the files in this folder?',
  'trust.description':
    'Please confirm this is your own project or from a trusted source. Once trusted, {cli} can read, modify, and execute files here, and will load local configurations (commands, hooks, MCP servers, agents, skills, settings).',
  'trust.action.trust': 'Trust folder',
  'trust.action.exit': "Don't trust and exit",
  'trust.discoveryErrors': '❌ Discovery Errors:',
  'trust.securityWarnings': '⚠️ Security Warnings:',
  'trust.contains': 'This folder contains:',
  'trust.group.commands': 'Commands',
  'trust.group.mcp': 'MCP Servers',
  'trust.group.hooks': 'Hooks',
  'trust.group.skills': 'Skills',
  'trust.group.agents': 'Agents',
  'trust.group.settings': 'Setting overrides',
  'trust.exiting': 'The current folder is not trusted. Exiting.',
  'trust.hint.back': 'Esc back',
  'permission.autoClassifierUnavailable':
    'Automatic safety checks are temporarily unavailable. This action needs your approval.',
} as const;
