/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * High-visibility UI strings that must not fall back to English in built-in
 * locales. These are intentionally explicit to avoid flagging identifiers such
 * as product names, file names, or enum literals that are expected to remain
 * unchanged across locales.
 */
export const MUST_TRANSLATE_KEYS = [
  'View or change the language setting',
  'Set UI language',
  'Usage: /language ui [{{options}}]',
  'Invalid language. Available: {{options}}',
  'To request additional UI language packs, please open an issue on GitHub.',
  'Open MCP management dialog',
  'Manage MCP servers',
  'Tools',
  'prompts',
  'tools',
  'Ask a quick side question without affecting the main conversation',
  'Manage Arena sessions',
  'Start an Arena session with multiple models competing on the same task',
  'Stop the current Arena session',
  'Show the current Arena session status',
  'Select a model result and merge its diff into the current workspace',
  'Switch to plan mode or exit plan mode',
  'Exited plan mode. Previous approval mode restored.',
  'Enabled plan mode. The agent will analyze and plan without executing tools.',
  'Already in plan mode. Use "/plan exit" to exit plan mode.',
  'Not in plan mode. Use "/plan" to enter plan mode first.',
  'Manage dynamic translation cache',
  'Re-translate currently loaded dynamic slash descriptions for the current UI language',
  'Clear cached translations for the current UI language',
  'Show context window usage breakdown. Use "/context detail" for per-item breakdown.',
  'Show per-item context usage breakdown.',
  'Manage extensions',
  'Manage installed extensions',
  'Install an extension from a git repo or local path',
  'Disable an extension',
  'Enable an extension',
  'Uninstall an extension',
  'Manage extension settings',
  'Lists installed extensions.',
  'Updates all extensions or a named extension to the latest version.',
  'Open extensions page in your browser',
  'Manage Extensions',
  'Extension Details',
  'View Extension',
  'Update Extension',
  'Disable Extension',
  'Enable Extension',
  'Uninstall Extension',
  'Select Scope',
  'User Scope',
  'Workspace Scope',
  'No extensions found.',
  'Toggle this help display',
  'Toggle shell mode',
  'Open command menu',
  'Add file context',
  'Accept suggestion / Autocomplete',
  'Reverse search history',
  'Press ? again to close',
  '? for shortcuts',
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}',
  'Approval mode set to "{{mode}}"',
  "Set up Qwen Code's status line UI",
] as const;
