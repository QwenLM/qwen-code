/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const enSettings = {
  'settings.title': 'Settings',
  'settings.search': 'Search to filter',
  'settings.noMatches': 'No settings match your search.',
  'settings.restartRequired': 'Restart required. {shortcut}.',
  'settings.restartApplyResult':
    'Please restart the CLI to apply changes.',
  'settings.scope.user.label': 'User Settings',
  'settings.scope.project.label': 'Project Settings',
  'settings.scope.user.description':
    'Stored in {path}. Lower priority than Project settings.',
  'settings.scope.project.description':
    'Stored in {path}. Overrides User settings.',
  'settings.scope.modifiedIn': '(Modified in {scopes})',
  'settings.scope.alsoModifiedIn': '(Also modified in {scopes})',
  'settings.scope.overriddenByProject': '(Overridden by Project Settings)',
  'settings.scope.overriddenByProjectWithEffectiveValue':
    '(Overridden by Project Settings · Effective: {value})',
  'settings.scope.overridesUser': '(Overrides User Settings)',
  'settings.scope.overridesUserWithValue':
    '(Overrides User Settings: {value})',
  'settings.scope.user.short': 'User',
  'settings.scope.project.short': 'Project',
  'settings.language.label': 'Display Language',
  'settings.language.description':
    'Language used by the interactive interface.',
  'settings.language.option.auto': 'Auto',
  'settings.language.option.zhCN': 'Simplified Chinese',
  'settings.language.option.en': 'English',
  'settings.scope.savedTo': 'Settings are saved to {path}',
  'settings.autoMemoryEnabled.label': 'Project Auto Memory',
  'settings.autoMemoryEnabled.description':
    'Automatically save and load reusable information for the current project. When unset, the QCS rollout default applies.',
  'settings.autoMemoryUserScopeEnabled.label': 'User Auto Memory',
  'settings.autoMemoryUserScopeEnabled.description':
    'Automatically save and load reusable information shared across projects. When unset, the QCS rollout default applies.',
  'settings.promptSuggestionEnabled.label': 'Prompt Suggestions',
  'settings.promptSuggestionEnabled.description':
    'Show suggested next actions after a completed turn.',
  'settings.dream.enabled.label': 'Dream',
  'settings.dream.enabled.description':
    'Enable background auto-memory consolidation. When unset, the QCS rollout default applies.',
  'settings.codeMode.mode.label': 'Code Mode',
  'settings.codeMode.mode.description':
    'Requires service availability. Default inherits local or remote settings; Off disables CodeMode; On keeps direct tools; Only routes supported tools through scripts.',
  'settings.codeMode.mode.option.off': 'Off',
  'settings.codeMode.mode.option.on': 'On',
  'settings.codeMode.mode.option.only': 'Only',
  'settings.respondToBashCommands.label': 'Respond to Shell Commands',
  'settings.respondToBashCommands.description':
    'Whether the model responds after an input-box `!` shell command finishes. Set to false to add the command and output to context without starting a model turn.',
  'settings.general.vimMode.label': 'Vim Mode',
  'settings.general.vimMode.description': 'Enable Vim keybindings',
  'settings.general.defaultPermissionMode.label': 'Default Permission Mode',
  'settings.general.defaultPermissionMode.description':
    'The default permission mode for tool execution. Values and aliases are case-insensitive.',
  'settings.general.defaultPermissionMode.option.default': 'Default',
  'settings.general.defaultPermissionMode.option.acceptEdits': 'Accept Edits',
  'settings.general.defaultPermissionMode.option.auto': 'Auto',
  'settings.general.defaultPermissionMode.option.yolo': 'YOLO',
  'settings.general.defaultPermissionMode.option.dontAsk': "Don't Ask",
  'settings.general.enableAutoUpdate.label': 'Enable Auto Update',
  'settings.general.enableAutoUpdate.description': 'Enable automatic updates.',
  'settings.general.plan.enabled.label': 'Enable Plan Mode',
  'settings.general.plan.enabled.description':
    'Enable Plan Mode for read-only safety during planning. When disabled, /plan command and --permission-mode plan are both rejected.',
  'settings.ui.inlineThinkingMode.label': 'Inline Thinking',
  'settings.ui.inlineThinkingMode.description':
    'Display model thinking inline: off or full.',
  'settings.ui.inlineThinkingMode.option.off': 'Off',
  'settings.ui.inlineThinkingMode.option.full': 'Full',
  'settings.ui.maxTurns.label': 'Max Turns Per Run',
  'settings.ui.maxTurns.description':
    'Maximum model/tool-loop turns for one submitted prompt in the interactive TUI. Does not affect -p/--print mode.',
  'settings.ui.maxTurns.option.1000': '1,000',
  'settings.ui.maxTurns.option.2000': '2,000',
  'settings.ui.maxTurns.option.3000': '3,000',
  'settings.ui.maxTurns.option.unlimited': 'Unlimited',
  'settings.ui.escapePastedAtSymbols.label': 'Escape Pasted @ Symbols',
  'settings.ui.escapePastedAtSymbols.description':
    'When enabled, @ symbols in pasted text are escaped to prevent unintended @path expansion.',
  'settings.ui.showShortcutsHint.label': 'Show Shortcuts Hint',
  'settings.ui.showShortcutsHint.description':
    'Show the "? for shortcuts" hint above the input.',
  'settings.ui.copyFullResponse.label': 'Always Copy Full Response',
  'settings.ui.copyFullResponse.description':
    'Skip the /copy picker and always copy the full assistant response.',
  'settings.privacy.usageStatisticsEnabled.label': 'Privacy Settings',
  'settings.privacy.usageStatisticsEnabled.description':
    'Enable sharing usage data to help improve the product. When disabled, enters Privacy Mode.',
  'settings.context.loadMemoryFromIncludeDirectories.label':
    'Load Memory From Additional Directories',
  'settings.context.loadMemoryFromIncludeDirectories.description':
    'Load context files from trusted additional workspace directories at startup.',
  'settings.security.folderTrust.enabled.label': 'Folder Trust',
  'settings.security.folderTrust.enabled.description':
    'Setting to track whether Folder trust is enabled.',
  'settings.advanced.useProxyFromEnvironment.label':
    'Use Proxy Environment Variables',
  'settings.advanced.useProxyFromEnvironment.description':
    'Use HTTPS_PROXY, https_proxy, HTTP_PROXY, or http_proxy for standalone CLI network requests. SDK integrations require an explicit host proxy.',
  'settings.experimental.useOSC52Paste.label': 'Use OSC 52 Paste',
  'settings.experimental.useOSC52Paste.description':
    'Use OSC 52 for pasting in compatible remote terminal sessions.',
  'settings.experimental.useOSC52Copy.label': 'Use OSC 52 Copy',
  'settings.experimental.useOSC52Copy.description':
    'Use OSC 52 for copying in compatible remote terminal sessions.',
  'settings.skills.loadFromAgentsDirectory.label':
    'Load Skills from .agents/skills',
  'settings.skills.loadFromAgentsDirectory.description':
    'Load skills from the legacy .agents/skills compatibility directories. Restart the CLI after changing this setting.',
  'settings.agentsMdExcludes.label': 'Context File Excludes',
  'settings.agentsMdExcludes.description':
    'Glob patterns or absolute context-file paths to exclude from project and local memory loading.',
} as const;
