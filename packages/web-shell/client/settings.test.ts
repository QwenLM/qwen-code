import { describe, expect, it, vi } from 'vitest';
import {
  isItemExcluded,
  isSettingExcluded,
  WEB_SHELL_SETTING_ITEM_IDS,
  type WebShellSettingItemId,
} from './settings';

describe('settings presentation aliases', () => {
  it('maps stable public aliases to configuration keys without accepting raw paths', () => {
    expect(
      isSettingExcluded('fastModel', { excludeItems: ['setting:fast-model'] }),
    ).toBe(true);
    expect(
      isSettingExcluded('general.language', {
        excludeItems: ['setting:language'],
      }),
    ).toBe(true);
    expect(
      isSettingExcluded('visionModel', {
        excludeItems: ['setting:fast-model'],
      }),
    ).toBe(false);
    expect(
      isSettingExcluded('fastModel', {
        excludeItems: ['setting:fastModel' as WebShellSettingItemId],
      }),
    ).toBe(false);
  });
  it('aliases the omni media delivery row', () => {
    expect(
      isSettingExcluded('omni.enabled', {
        excludeItems: ['setting:omni-media-delivery'],
      }),
    ).toBe(true);
    expect(WEB_SHELL_SETTING_ITEM_IDS).toContain('setting:omni-media-delivery');
  });
  it('aliases the named-workflows-only lock row', () => {
    expect(
      isSettingExcluded('tools.workflowNameOnly', {
        excludeItems: ['setting:workflow-name-only'],
      }),
    ).toBe(true);
    expect(WEB_SHELL_SETTING_ITEM_IDS).toContain('setting:workflow-name-only');
  });
  it('matches published builtin ids by direct membership', () => {
    expect(
      isItemExcluded('builtin:model-management', {
        excludeItems: ['builtin:model-management'],
      }),
    ).toBe(true);
    expect(
      isItemExcluded('builtin:chat-width', {
        excludeItems: ['builtin:model-management'],
      }),
    ).toBe(false);
    expect(isItemExcluded('builtin:local-control')).toBe(false);
  });
  it('ignores unknown runtime IDs and inherited property names', () => {
    for (const id of ['unknown', 'toString', '__proto__']) {
      expect(
        isSettingExcluded('fastModel', {
          excludeItems: [id as WebShellSettingItemId],
        }),
      ).toBe(false);
    }
    expect(isSettingExcluded('fastModel')).toBe(false);
    expect(isSettingExcluded('fastModel', { excludeItems: [] })).toBe(false);
  });
  it('ignores ids inherited from a polluted Object.prototype', () => {
    (Object.prototype as Record<string, unknown>).someHostProp = 'fastModel';
    try {
      expect(
        isSettingExcluded('fastModel', {
          excludeItems: ['someHostProp' as WebShellSettingItemId],
        }),
      ).toBe(false);
    } finally {
      delete (Object.prototype as Record<string, unknown>).someHostProp;
    }
  });
  it('allows only included ordinary settings and builtin blocks', () => {
    const options = {
      includeItems: ['setting:language', 'builtin:chat-width'],
    } as const;
    expect(isSettingExcluded('general.language', options)).toBe(false);
    expect(isSettingExcluded('fastModel', options)).toBe(true);
    expect(isItemExcluded('builtin:chat-width', options)).toBe(false);
    expect(isItemExcluded('builtin:model-management', options)).toBe(true);
  });
  it('distinguishes an empty allowlist from an absent one', () => {
    for (const options of [undefined, {}, { includeItems: undefined }]) {
      expect(isSettingExcluded('general.language', options)).toBe(false);
      expect(isItemExcluded('builtin:chat-width', options)).toBe(false);
    }
    expect(isSettingExcluded('general.language', { includeItems: [] })).toBe(
      true,
    );
    for (const id of WEB_SHELL_SETTING_ITEM_IDS) {
      expect(isItemExcluded(id, { includeItems: [] })).toBe(true);
    }
  });
  it('gives exclusions precedence over inclusions', () => {
    const options = {
      includeItems: [
        'setting:language',
        'builtin:chat-width',
        'setting:fast-model',
      ],
      excludeItems: ['setting:language', 'builtin:chat-width'],
    } as const;
    expect(isSettingExcluded('general.language', options)).toBe(true);
    expect(isItemExcluded('builtin:chat-width', options)).toBe(true);
    expect(isSettingExcluded('fastModel', options)).toBe(false);
  });
  it('hides unaliased schema keys only when an allowlist is configured', () => {
    for (const key of ['future.setting', 'toString', '__proto__']) {
      expect(isSettingExcluded(key)).toBe(false);
      expect(isSettingExcluded(key, { excludeItems: [] })).toBe(false);
      expect(
        isSettingExcluded(key, { includeItems: WEB_SHELL_SETTING_ITEM_IDS }),
      ).toBe(true);
      expect(isSettingExcluded(key, { includeItems: [] })).toBe(true);
    }
  });
  it('does not treat unknown IDs, schema paths, or inherited properties as inclusions', () => {
    (Object.prototype as Record<string, unknown>).someHostProp = 'fastModel';
    try {
      for (const id of [
        'unknown',
        'fastModel',
        'setting:fastModel',
        'toString',
        '__proto__',
        'someHostProp',
      ]) {
        const options = { includeItems: [id as WebShellSettingItemId] };
        expect(isSettingExcluded('fastModel', options)).toBe(true);
        expect(isSettingExcluded(id, options)).toBe(true);
        expect(isItemExcluded('builtin:chat-width', options)).toBe(true);
      }
    } finally {
      delete (Object.prototype as Record<string, unknown>).someHostProp;
    }
  });
  it('publishes unique IDs including each native frontend block', () => {
    expect(new Set(WEB_SHELL_SETTING_ITEM_IDS).size).toBe(
      WEB_SHELL_SETTING_ITEM_IDS.length,
    );
    for (const id of [
      'builtin:chat-width',
      'builtin:browser-notifications',
      'builtin:live-setup',
      'builtin:local-control',
      'builtin:connections',
      'builtin:model-management',
    ]) {
      expect(WEB_SHELL_SETTING_ITEM_IDS).toContain(id);
    }
  });
  // The diagnostic ships in the production bundle (the lib build folds
  // import.meta.env.DEV to false), so pin identical behavior in both modes.
  it.each([true, false])(
    'warns once per unrecognized item id and never for published ids (DEV=%s)',
    async (dev) => {
      // The warn-once dedup is module state and earlier tests legitimately pass
      // published ids through the same predicates, so probe a fresh instance.
      vi.resetModules();
      const fresh = await import('./settings');
      vi.stubEnv('DEV', dev);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const options = {
          includeItems: [
            'setting:langauge' as WebShellSettingItemId,
            'setting:theme',
          ],
        };
        fresh.isSettingExcluded('ui.theme', options);
        fresh.isItemExcluded('builtin:live-setup', options);
        const excludeOptions = {
          excludeItems: ['setting:fastModel' as WebShellSettingItemId],
        };
        fresh.isSettingExcluded('fastModel', excludeOptions);
        fresh.isItemExcluded('builtin:live-setup', excludeOptions);
        const warned = warn.mock.calls.map((call) => String(call[0]));
        expect(
          warned.filter((text) => text.includes('"setting:theme"')),
        ).toEqual([]);
        expect(
          warned.filter((text) => text.includes('"setting:langauge"')),
        ).toHaveLength(1);
        expect(
          warned.filter((text) => text.includes('"setting:fastModel"')),
        ).toHaveLength(1);
        warn.mockClear();
        fresh.isSettingExcluded('general.language', { includeItems: [] });
        fresh.isSettingExcluded('general.language', { excludeItems: [] });
        fresh.isItemExcluded('builtin:chat-width');
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );
  it('filters by every published setting alias in both directions', () => {
    // SETTING_KEYS is module-private, so this mirror pins the published
    // alias-to-key contract; the completeness assertion keeps it in sync.
    const aliasedKeys = {
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
    } satisfies Record<string, string>;
    const settingIds = WEB_SHELL_SETTING_ITEM_IDS.filter((id) =>
      id.startsWith('setting:'),
    );
    expect(Object.keys(aliasedKeys).sort()).toEqual([...settingIds].sort());
    for (const [id, key] of Object.entries(aliasedKeys)) {
      const itemId = id as WebShellSettingItemId;
      expect(isSettingExcluded(key, { excludeItems: [itemId] })).toBe(true);
      expect(isSettingExcluded(key, { includeItems: [itemId] })).toBe(false);
    }
  });
});
