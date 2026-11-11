/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const enModels = {
  'models.local.requiredHint': '* Required',
  'models.local.nameHint': 'Leave blank to use the model ID.',
  'models.local.outputHelp':
    'Declared output capacity; generation settings can override the request token limit.',
  'models.local.visionHelp':
    'Off rejects image input in the CLI. Enable only if the model supports images.',
  'models.local.controlsHelp':
    'Declare supported controls; choose the active effort separately with /effort.',
  'models.local.configured': 'Configured',
  'models.local.contextCapacity': 'Context capacity',
  'models.local.thinkingControls': 'Thinking controls',
  'models.local.capabilitiesTitle': 'Model capabilities',
  'models.local.supportedModes': 'Supported modes',

  'models.local.budgetRequired': 'Budget required',
  'models.local.preferredMode': 'Preferred mode',
  'models.local.modesHelp':
    'Declare supported modes. A required budget belongs in generation settings.',

  'models.local.thinkingIncomplete':
    'Select a supported Anthropic thinking mode before saving.',
  'models.local.customProviders': 'Custom providers',
  'models.local.providerNavigate': '↑↓ navigate',
  'models.local.jumpCustom': 'c custom',
  'models.local.jumpPresets': 'p presets',
  'models.local.budgetValue': '{value} (default budget)',
  'models.local.budgetDescription':
    'This is a fallback budget, not a verified model limit. Edit model capabilities to declare the capacity.',
  'models.local.editHint': '{edit} edit',
  'models.local.editTitle': 'Edit custom model',
  'models.local.addTitle': 'Add custom model',
  'models.local.formKeys': '↑↓ navigate · Enter edit / continue · Esc back',
  'models.local.maxOutput': 'Max output',
  'models.local.defaultBudget': '128K (default budget)',
  'models.local.providerDefault': 'Provider default',
  'models.local.capabilities': 'Model capabilities...',
  'models.local.reviewAction': 'Review and save',
  'models.local.identityFixed':
    'Model ID: {model} (fixed; add a new entry to change it)',
  'models.local.keepKey':
    'Leave blank to keep the existing key or environment reference.',
  'models.local.contextHelp':
    'Enter the provider context capacity in tokens. Leave blank to use the 128K default budget.',
  'models.local.budgetHelp':
    'Capacity is not configured. The CLI will use a 128K budget; this does not verify the provider limit.',
  'models.local.positiveTokens': 'Enter a positive whole token count.',
  'models.local.vision': 'Image input',
  'models.local.yes': 'Supported',
  'models.local.no': 'Not declared',
  'models.local.done': 'Done',
  'models.local.effortLevels': 'Effort levels',
  'models.local.levelsHelp':
    'Enter toggles a level. Select only levels accepted by this model.',
  'models.local.confirmBudget': 'Save with 128K default budget',
  'models.local.thinkingUnknown':
    'Provider default · no adjustable effort levels configured',
  'models.local.savedNotApplied':
    'Saved to user settings, but not active in this session. Check your provider settings and reopen the CLI.',
  'models.local.switchBeforeDelete':
    'Switch to a model outside this configuration before deleting it.',
  'models.local.deleteShared':
    'This provider contains multiple models. Edit it in your settings to remove a model.',
  'models.local.deleteSource':
    'This configuration is not exclusively owned by user settings. Edit it in its source settings.',
  'models.local.cancel': 'Cancel',
  'models.local.delete': 'Delete configuration',
  'models.local.addHint': '{add} add',
  'models.local.deleteHint': '{delete} delete',
  'models.local.local': 'Local endpoints',
  'models.local.presets': 'Platform presets',
  'models.local.add': '[+] Add custom model...',
  'models.local.openai': 'Custom API URL - Chat Completions / Responses',
  'models.local.anthropic': 'Custom API URL - Anthropic Messages',
  'models.local.gemini': 'Custom API URL - Google Gemini',
  'models.local.loadingPresets': 'Loading platform providers...',
  'models.local.presetsUnavailable':
    'Platform providers unavailable. Local endpoints can still be configured.',
  'models.local.keyHint':
    'Stored in user settings. Supports environment variable references; leave empty for an endpoint without authentication.',
  'models.local.reviewTitle': 'Review custom model',
  'models.local.reviewName': 'Name',
  'models.local.reviewKeys': 'Enter save · Esc back',
  'models.local.saveHint': 'Connection has not been tested.',
  'models.local.save': 'Save model',
  'models.local.saving': 'Saving...',
  'models.local.saveFailed':
    'Could not save or apply the configuration. Check the fields and user settings before retrying.',
      'models.local.invalidUrl':
    'Enter an HTTP(S) Base URL without credentials, query, or fragment.',
  'models.local.modelRequired': 'Model ID is required.',
  'models.local.wizardKeys': 'Enter continue / Esc back',
  'models.title': 'Select Model',
  'models.loading': 'Loading models...',
  'models.noneAvailable':
    'No models available. Please check your connection and try again.',
  'models.noneInGroup': 'No models in this group.',
  'models.search': 'Search models...',
  'models.searchHint': 'Press / to search models',
  'models.tab.default': 'Default ({count})',
  'models.tab.new': 'New ({count})',
  'models.tab.custom': 'Custom ({count})',
  'models.tab.customReadOnly': 'Custom ({count}, read-only)',
  'models.defaultSuffix': ' (default)',
  'models.tag.reasoning': 'Reasoning',
  'models.tag.vision': 'Vision',
  'models.tag.new': 'New',
  'models.tag.free': 'Free',
  'models.remember': 'Remember model for future sessions:',
  'models.bool.true': 'true',
  'models.bool.false': 'false',
  'models.errorPrefix': 'Error: {detail}',
  'models.retry': 'Press r to retry or Esc to go back.',
  'models.apiRequired': 'Model management requires {brand} API.',
  'models.remoteRefreshUnavailable':
    'Remote model refresh is unavailable in this session',
  'models.refreshing': 'Refreshing models...',
  'models.refreshingAll': 'Refreshing models and account data...',
  'models.refreshFailedCached':
    'Refresh failed; showing cached models. Press r to retry. ({detail})',
  'models.refreshFailedPrevious':
    'Refresh failed; showing previous data. Press r to retry. ({detail})',
  'models.failedLoad': 'Failed to load data',
  'models.failedRefresh': 'Failed to refresh models',
  'models.serviceUnreachable': 'Could not reach the model service: {detail}',
  'models.refreshed': 'Models refreshed.',
  'models.refreshedAccountUpdating':
    'Models refreshed; account data is updating.',
  'models.refreshedAccountPartial':
    'Models refreshed; some account data could not be updated.',
  'models.refreshedLocalPartial':
    'Models refreshed; local model configuration could not be reloaded. Check settings.json.',
  'models.refreshedAll': 'Models and account data refreshed.',
  'models.overview.title': 'Overview:',
  'models.overview.current': '· Current Model     : ',
  'models.overview.security': '· Codebase Security : ',
  'models.security.normal': 'Normal',
  'models.security.restricted': 'Restricted',
  'models.security.badge': '[Security Restricted]',
  'models.security.message':
    'This repository has triggered a security policy. Please switch to an alternative model.',
  'models.security.checkFailed':
    'Repository security could not be verified. Check your network connection, then restart {brand} to retry.',
  'models.unavailable':
    'This model is currently unavailable and cannot be selected.',
  'models.customRemote':
    'Custom models are configured on the worker. Select to switch (add/edit is unavailable in remote mode).',
  'models.customProvider.deleteTitle': 'Delete custom model?',
  'models.options.title': 'Model Options',
  'models.options.model': 'Model: ',
  'models.options.context': 'Context Window',
  'models.options.contextDescription':
    'Maximum context length the model reads at once.',
  'models.options.effort': 'Thinking Effort',
  'models.options.effortToggleDescription':
    'Whether the model thinks before replying.',
  'models.options.ultracodeDescription':
    'Extra High + Workflow orchestration; this session only.',
  'models.options.effortDescription':
    'How much the model thinks before replying.',
  'models.options.default': 'Default',
  'models.options.defaultLower': 'default',
  'models.options.enabledDefault': 'Enabled (Default)',
  'models.options.enabled': 'Enabled',
  'models.options.disabled': 'Disabled',
  'models.options.disabledDefault': 'Disabled (Default)',
  'models.options.on': 'on',
  'models.options.off': 'off',
  'models.options.selected': 'Selected: ',
  'models.options.contextSummary': 'Context: {value}',
  'models.options.effortSummary': 'Thinking Effort: {value}',
  'models.inline.effortKey': '{keys} effort',
  'models.inline.contextKey': 'space context',
  'models.inline.contextKeyOnly': '{keys} context',
  'models.inline.effortKeySwitch': 'space effort',
  'models.inline.selectAndSave': 'Enter select & save',
  'models.inline.changedCount': '{count} changed',
  'models.options.thinkingTitle': 'Thinking Effort',
  'models.options.defaultEffortDescription':
    'Use the default thinking effort for this model',
  'models.effort.none.description': 'Disable thinking for this model',
  'models.effort.none.label': 'None',
  'models.effort.low.description':
    'Fastest reasoning with the smallest effort budget',
  'models.effort.low.label': 'Low',
  'models.effort.medium.description': 'Balanced reasoning effort',
  'models.effort.medium.label': 'Medium',
  'models.effort.high.description': 'Deeper reasoning for more complex work',
  'models.effort.high.label': 'High',
  'models.effort.xhigh.description': 'Extra deep reasoning for difficult tasks',
  'models.effort.xhigh.label': 'Extra High',
  'models.effort.max.description': 'Maximum available reasoning effort',
  'models.effort.max.label': 'Max',
  'models.options.chooseHint': '←→ choose',
  'models.options.applyHint': 'Enter apply settings',
  'models.options.selectHint': '↑↓ select',
  'models.options.tokens': '{count} tokens',
} as const;
