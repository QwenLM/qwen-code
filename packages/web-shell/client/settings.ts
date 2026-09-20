/** Stable presentation aliases; schema paths are private implementation details. */
const SETTING_KEYS = {
  'setting:auto-update': 'general.enableAutoUpdate',
  'setting:session-recap': 'general.showSessionRecap',
  'setting:session-recap-away-threshold':
    'general.sessionRecapAwayThresholdMinutes',
  'setting:cleanup-period': 'general.cleanupPeriodDays',
  'setting:git-commit-co-author': 'general.gitCoAuthor.commit',
  'setting:git-pr-co-author': 'general.gitCoAuthor.pr',
  'setting:language': 'general.language',
  'setting:prevent-system-sleep': 'general.preventSystemSleep',
  'setting:review-attribution': 'review.attribution',
  'setting:review-sandbox': 'review.sandbox',
  'setting:review-effort': 'review.effort',
  'setting:review-comment': 'review.comment',
  'setting:review-severity-floor': 'review.severityFloor',
  'setting:review-reverse-audit-rounds': 'review.reverseAuditRounds',
  'setting:review-approach-rounds': 'review.approachRounds',
  'setting:timestamps': 'output.showTimestamps',
  'setting:theme': 'ui.theme',
  'setting:workflow-keyword-trigger': 'ui.disableWorkflowKeywordTrigger',
  'setting:status-in-title': 'ui.showStatusInTitle',
  'setting:response-speed': 'ui.showResponseTokensPerSecond',
  'setting:followup-suggestions': 'ui.enableFollowupSuggestions',
  'setting:tool-call-details': 'ui.showToolCallDetails',
  'setting:shell-output-limit': 'ui.shellOutputMaxLines',
  'setting:usage-statistics': 'privacy.usageStatisticsEnabled',
  'setting:fast-model': 'fastModel',
  'setting:advisor-model': 'advisorModel',
  'setting:vision-model': 'visionModel',
  'setting:model-fallbacks': 'modelFallbacks',
  'setting:respect-git-ignore': 'context.fileFiltering.respectGitIgnore',
  'setting:respect-qwen-ignore': 'context.fileFiltering.respectQwenIgnore',
  'setting:fuzzy-file-search': 'context.fileFiltering.enableFuzzySearch',
  'setting:code-mode-only': 'tools.codeModeOnly',
  'setting:web-search': 'tools.webSearch.enabled',
  'setting:web-search-model': 'tools.webSearch.model',
  'setting:web-extractor': 'tools.webSearch.webExtractor',
  'setting:web-search-timeout': 'tools.webSearch.timeoutMs',
  'setting:web-search-limit': 'tools.webSearch.maxPerSession',
  'setting:tool-search': 'tools.toolSearch.enabled',
  'setting:tool-search-threshold': 'tools.toolSearch.threshold',
  'setting:list-directory': 'tools.listDirectory.enabled',
  'setting:todo-write': 'tools.todoWrite.enabled',
  'setting:interactive-shell': 'tools.shell.enableInteractiveShell',
  'setting:workflows': 'tools.workflowsEnabled',
  'setting:workflow-size': 'tools.workflowSizeGuideline',
  'setting:workflow-name-only': 'tools.workflowNameOnly',
  'setting:permission-strategy': 'policy.permissionStrategy',
  'setting:model-proposed-goals': 'goals.modelProposed',
  'setting:arena-artifacts': 'agents.arena.preserveArtifacts',
  'setting:session-workflow': 'experimental.sessionWorkflow',
  'setting:scheduled-tasks': 'experimental.cron',
  'setting:session-writer-lease': 'experimental.sessionWriterLease',
  'setting:agent-team': 'experimental.agentTeam',
  'setting:omni-media-delivery': 'omni.enabled',
  'setting:artifacts': 'experimental.artifact',
  'setting:tool-use-summaries': 'experimental.emitToolUseSummaries',
  'setting:voice-model': 'voiceModel',
  'setting:image-model': 'imageModel',
} as const;

const BUILTIN_IDS = [
  'builtin:chat-width',
  'builtin:browser-notifications',
  'builtin:live-setup',
  'builtin:local-control',
  'builtin:connections',
  'builtin:model-management',
] as const;

export type WebShellSettingItemId =
  | keyof typeof SETTING_KEYS
  | (typeof BUILTIN_IDS)[number];

export const WEB_SHELL_SETTING_ITEM_IDS: readonly WebShellSettingItemId[] = [
  ...(Object.keys(SETTING_KEYS) as Array<keyof typeof SETTING_KEYS>),
  ...BUILTIN_IDS,
];

export interface WebShellSettingsOptions {
  /** Show only these eligible native items; an empty list hides all. Presentation only. */
  includeItems?: readonly WebShellSettingItemId[];
  /** Hide native items, taking precedence over includeItems. Other commands/APIs remain available. */
  excludeItems?: readonly WebShellSettingItemId[];
}

export function isItemVisible(
  id: WebShellSettingItemId,
  options?: WebShellSettingsOptions,
): boolean {
  return (
    (options?.includeItems?.includes(id) ?? true) &&
    !options?.excludeItems?.includes(id)
  );
}

export function isSettingVisible(
  key: string,
  options?: WebShellSettingsOptions,
): boolean {
  const id = (
    Object.keys(SETTING_KEYS) as Array<keyof typeof SETTING_KEYS>
  ).find((id) => SETTING_KEYS[id] === key);
  return id === undefined
    ? options?.includeItems === undefined
    : isItemVisible(id, options);
}
