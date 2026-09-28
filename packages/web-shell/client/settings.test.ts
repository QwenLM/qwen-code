import { describe, expect, it, vi } from 'vitest';
import {
  isItemVisible,
  isSettingVisible,
  WEB_SHELL_SETTING_ITEM_IDS,
  type WebShellSettingItemId,
} from './settings';

describe('settings presentation aliases', () => {
  it('maps stable public aliases to configuration keys without accepting raw paths', () => {
    expect(
      isSettingVisible('fastModel', { excludeItems: ['setting:fast-model'] }),
    ).toBe(false);
    expect(
      isSettingVisible('general.language', {
        excludeItems: ['setting:language'],
      }),
    ).toBe(false);
    expect(
      isSettingVisible('visionModel', {
        excludeItems: ['setting:fast-model'],
      }),
    ).toBe(true);
    expect(
      isSettingVisible('fastModel', {
        excludeItems: ['setting:fastModel' as WebShellSettingItemId],
      }),
    ).toBe(true);
  });
  it('aliases the omni media delivery row', () => {
    expect(
      isSettingVisible('omni.enabled', {
        excludeItems: ['setting:omni-media-delivery'],
      }),
    ).toBe(false);
    expect(WEB_SHELL_SETTING_ITEM_IDS).toContain('setting:omni-media-delivery');
  });
  it('aliases the named-workflows-only lock row', () => {
    expect(
      isSettingVisible('tools.workflowNameOnly', {
        excludeItems: ['setting:workflow-name-only'],
      }),
    ).toBe(false);
    expect(WEB_SHELL_SETTING_ITEM_IDS).toContain('setting:workflow-name-only');
  });
  it('matches published builtin ids by direct membership', () => {
    expect(
      isItemVisible('builtin:model-management', {
        excludeItems: ['builtin:model-management'],
      }),
    ).toBe(false);
    expect(
      isItemVisible('builtin:chat-width', {
        excludeItems: ['builtin:model-management'],
      }),
    ).toBe(true);
    expect(isItemVisible('builtin:local-control')).toBe(true);
  });
  it('ignores unknown runtime IDs and inherited property names', () => {
    for (const id of ['unknown', 'toString', '__proto__']) {
      expect(
        isSettingVisible('fastModel', {
          excludeItems: [id as WebShellSettingItemId],
        }),
      ).toBe(true);
    }
    expect(isSettingVisible('fastModel')).toBe(true);
    expect(isSettingVisible('fastModel', { excludeItems: [] })).toBe(true);
  });
  it('ignores ids inherited from a polluted Object.prototype', () => {
    (Object.prototype as Record<string, unknown>).someHostProp = 'fastModel';
    try {
      expect(
        isSettingVisible('fastModel', {
          excludeItems: ['someHostProp' as WebShellSettingItemId],
        }),
      ).toBe(true);
    } finally {
      delete (Object.prototype as Record<string, unknown>).someHostProp;
    }
  });
  it('allows only included ordinary settings and builtin blocks', () => {
    const options = {
      includeItems: ['setting:language', 'builtin:chat-width'],
    } as const;
    expect(isSettingVisible('general.language', options)).toBe(true);
    expect(isSettingVisible('fastModel', options)).toBe(false);
    expect(isItemVisible('builtin:chat-width', options)).toBe(true);
    expect(isItemVisible('builtin:model-management', options)).toBe(false);
  });
  it('distinguishes an empty allowlist from an absent one', () => {
    for (const options of [undefined, {}, { includeItems: undefined }]) {
      expect(isSettingVisible('general.language', options)).toBe(true);
      expect(isItemVisible('builtin:chat-width', options)).toBe(true);
    }
    expect(isSettingVisible('general.language', { includeItems: [] })).toBe(
      false,
    );
    for (const id of WEB_SHELL_SETTING_ITEM_IDS) {
      expect(isItemVisible(id, { includeItems: [] })).toBe(false);
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
    expect(isSettingVisible('general.language', options)).toBe(false);
    expect(isItemVisible('builtin:chat-width', options)).toBe(false);
    expect(isSettingVisible('fastModel', options)).toBe(true);
  });
  it('hides unaliased schema keys only when an allowlist is configured', () => {
    for (const key of ['future.setting', 'toString', '__proto__']) {
      expect(isSettingVisible(key)).toBe(true);
      expect(isSettingVisible(key, { excludeItems: [] })).toBe(true);
      expect(
        isSettingVisible(key, { includeItems: WEB_SHELL_SETTING_ITEM_IDS }),
      ).toBe(false);
      expect(isSettingVisible(key, { includeItems: [] })).toBe(false);
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
        expect(isSettingVisible('fastModel', options)).toBe(false);
        expect(isSettingVisible(id, options)).toBe(false);
        expect(isItemVisible('builtin:chat-width', options)).toBe(false);
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
        fresh.isSettingVisible('ui.theme', options);
        fresh.isItemVisible('builtin:live-setup', options);
        const excludeOptions = {
          excludeItems: ['setting:fastModel' as WebShellSettingItemId],
        };
        fresh.isSettingVisible('fastModel', excludeOptions);
        fresh.isItemVisible('builtin:live-setup', excludeOptions);
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
        fresh.isSettingVisible('general.language', { includeItems: [] });
        fresh.isSettingVisible('general.language', { excludeItems: [] });
        fresh.isItemVisible('builtin:chat-width');
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
      'setting:advisor-session-call-limit': 'advisorMaxUses',
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
      expect(isSettingVisible(key, { excludeItems: [itemId] })).toBe(false);
      expect(isSettingVisible(key, { includeItems: [itemId] })).toBe(true);
    }
  });
});
