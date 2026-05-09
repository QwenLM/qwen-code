import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { PanelHeader } from '@/components/app-shell/PanelHeader';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HeaderMenu } from '@/components/ui/HeaderMenu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Info_Badge } from '@/components/info';
import {
  SettingsSection,
  SettingsCard,
  SettingsSegmentedControl,
} from '@/components/settings';
import { useAppShellContext } from '@/context/AppShellContext';
import { routes } from '@/lib/navigate';
import type { DetailsPageMeta } from '@/lib/navigation-registry';
import type {
  PermissionRuleType,
  PermissionSettingsScope,
  QwenPermissionSettings,
} from '@craft-agent/shared/protocol';

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'permissions',
};

const RULE_TYPES: PermissionRuleType[] = ['allow', 'ask', 'deny'];
const SCOPES: PermissionSettingsScope[] = ['user', 'workspace'];
const QWEN_PERMISSIONS_DOC_URL =
  'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/#permissions';

function ruleTypeLabel(type: PermissionRuleType): string {
  switch (type) {
    case 'allow':
      return 'Allow';
    case 'ask':
      return 'Ask';
    case 'deny':
      return 'Deny';
    default:
      const _exhaustive: never = type;
      return _exhaustive;
  }
}

function scopeLabel(scope: PermissionSettingsScope): string {
  return scope === 'user' ? 'User settings' : 'Project settings';
}

function scopeDescription(scope: PermissionSettingsScope): string {
  return scope === 'user'
    ? 'Saved globally for your Qwen Code user.'
    : 'Saved in this workspace project settings.';
}

function ruleTypeDescription(type: PermissionRuleType): string {
  switch (type) {
    case 'allow':
      return "Qwen Code won't ask before using matching tools or commands.";
    case 'ask':
      return 'Qwen Code always asks before using matching tools or commands.';
    case 'deny':
      return 'Qwen Code blocks matching tools or commands.';
    default:
      const _exhaustive: never = type;
      return _exhaustive;
  }
}

function normalizeRules(rules: string[]): string[] {
  return Array.from(new Set(rules.map((rule) => rule.trim()).filter(Boolean)));
}

export default function PermissionsSettingsPage() {
  const { t } = useTranslation();
  const { activeSessionId } = useAppShellContext();
  const [isLoading, setIsLoading] = useState(true);
  const [settings, setSettings] = useState<QwenPermissionSettings | null>(null);
  const [activeRuleType, setActiveRuleType] =
    useState<PermissionRuleType>('allow');
  const [drafts, setDrafts] = useState<Record<PermissionSettingsScope, string>>(
    {
      user: '',
      workspace: '',
    },
  );
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tr = useCallback(
    (key: string, fallback: string) => t(key, { defaultValue: fallback }),
    [t],
  );

  const loadSettings = useCallback(async () => {
    if (!activeSessionId || !window.electronAPI) {
      setSettings(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.sessionCommand(activeSessionId, {
        type: 'getQwenPermissionSettings',
      });
      setSettings(result as QwenPermissionSettings);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
      setSettings(null);
    } finally {
      setIsLoading(false);
    }
  }, [activeSessionId]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const ruleTypeOptions = useMemo(
    () =>
      RULE_TYPES.map((type) => ({
        value: type,
        label: ruleTypeLabel(type),
      })),
    [],
  );

  const saveRules = useCallback(
    async (
      scope: PermissionSettingsScope,
      ruleType: PermissionRuleType,
      rules: string[],
    ) => {
      if (!activeSessionId || !window.electronAPI) return;
      const key = `${scope}:${ruleType}`;
      setSavingKey(key);
      setError(null);
      try {
        const result = await window.electronAPI.sessionCommand(
          activeSessionId,
          {
            type: 'setQwenPermissionRules',
            scope,
            ruleType,
            rules: normalizeRules(rules),
          },
        );
        setSettings(result as QwenPermissionSettings);
      } catch (saveError) {
        setError(
          saveError instanceof Error ? saveError.message : String(saveError),
        );
      } finally {
        setSavingKey(null);
      }
    },
    [activeSessionId],
  );

  const addRule = useCallback(
    async (scope: PermissionSettingsScope) => {
      if (!settings) return;
      const draft = drafts[scope].trim();
      if (!draft) return;
      const nextRules = normalizeRules([
        ...settings[scope].rules[activeRuleType],
        draft,
      ]);
      setDrafts((current) => ({ ...current, [scope]: '' }));
      await saveRules(scope, activeRuleType, nextRules);
    },
    [activeRuleType, drafts, saveRules, settings],
  );

  const removeRule = useCallback(
    async (scope: PermissionSettingsScope, rule: string) => {
      if (!settings) return;
      const nextRules = settings[scope].rules[activeRuleType].filter(
        (item) => item !== rule,
      );
      await saveRules(scope, activeRuleType, nextRules);
    },
    [activeRuleType, saveRules, settings],
  );

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t('settings.permissions.title')}
        actions={
          <HeaderMenu
            route={routes.view.settings('permissions')}
            helpFeature="permissions"
          />
        }
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              <SettingsSection
                title={tr(
                  'settings.permissions.aboutPermissions',
                  'About Permissions',
                )}
              >
                <SettingsCard className="px-4 py-3.5">
                  <div className="text-sm text-muted-foreground leading-relaxed space-y-2">
                    <p>
                      {tr(
                        'settings.permissions.cliAlignedIntro',
                        'Manage Qwen Code permission policy for tool and command requests. Requests are evaluated in priority order: Deny, Ask, then Allow.',
                      )}
                    </p>
                    <p>
                      {tr(
                        'settings.permissions.cliAlignedFormat',
                        'Rules may target an entire tool or a specific operation. Changes are persisted to Qwen settings through ACP and apply to subsequent tool requests.',
                      )}
                    </p>
                    <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2.5 text-xs text-muted-foreground">
                      <div className="font-medium text-foreground/80">
                        {tr(
                          'settings.permissions.quickGuideTitle',
                          'How to write a rule',
                        )}
                      </div>
                      <div className="mt-1.5 space-y-1">
                        <p>
                          {tr(
                            'settings.permissions.quickGuideTools',
                            'Enter a tool name to cover all uses of that tool, for example WebFetch or Edit.',
                          )}
                        </p>
                        <p>
                          {tr(
                            'settings.permissions.quickGuideCommands',
                            'Use ToolName(specifier) to restrict the rule to a specific operation, for example Bash(git status) or Bash(npm run build).',
                          )}
                        </p>
                        <p>
                          {tr(
                            'settings.permissions.quickGuideScopes',
                            'User rules apply across workspaces. Project rules apply only to this workspace and are merged with the user policy.',
                          )}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        window.electronAPI?.openUrl(QWEN_PERMISSIONS_DOC_URL)
                      }
                      className="text-foreground/70 hover:text-foreground underline underline-offset-2"
                    >
                      {t('common.learnMore')}
                    </button>
                  </div>
                </SettingsCard>
              </SettingsSection>

              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : !activeSessionId ? (
                <EmptyState
                  title={tr(
                    'settings.permissions.noSessionTitle',
                    'Open a Qwen session to edit permissions',
                  )}
                  description={tr(
                    'settings.permissions.noSessionDesc',
                    'Permission settings are read and written through Qwen ACP, so this page needs an active session in the workspace.',
                  )}
                />
              ) : error && !settings ? (
                <EmptyState
                  title="Permission settings unavailable"
                  description={error}
                />
              ) : settings ? (
                <>
                  <SettingsSection
                    title={tr(
                      'settings.permissions.ruleEditor',
                      'Permission Rules',
                    )}
                    description={ruleTypeDescription(activeRuleType)}
                  >
                    <div className="mb-3">
                      <SettingsSegmentedControl
                        value={activeRuleType}
                        onValueChange={setActiveRuleType}
                        options={ruleTypeOptions}
                      />
                    </div>
                    <div className="space-y-3">
                      {SCOPES.map((scope) => (
                        <RuleScopeCard
                          key={scope}
                          scope={scope}
                          ruleType={activeRuleType}
                          rules={settings[scope].rules[activeRuleType]}
                          path={settings[scope].path}
                          draft={drafts[scope]}
                          isSaving={savingKey === `${scope}:${activeRuleType}`}
                          onDraftChange={(value) =>
                            setDrafts((current) => ({
                              ...current,
                              [scope]: value,
                            }))
                          }
                          onAdd={() => void addRule(scope)}
                          onRemove={(rule) => void removeRule(scope, rule)}
                        />
                      ))}
                    </div>
                    {error ? (
                      <div className="mt-3 flex items-start gap-2 text-xs text-destructive">
                        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>{error}</span>
                      </div>
                    ) : null}
                  </SettingsSection>

                  <SettingsSection
                    title={tr(
                      'settings.permissions.effectiveRules',
                      'Effective Rules',
                    )}
                    description={tr(
                      'settings.permissions.effectiveRulesDesc',
                      'Merged User and Project rules currently visible to Qwen Code.',
                    )}
                  >
                    <SettingsCard className="px-4 py-3.5">
                      <div className="grid gap-3 sm:grid-cols-3">
                        {RULE_TYPES.map((type) => (
                          <div key={type} className="min-w-0">
                            <div className="flex items-center gap-2 text-sm font-medium">
                              <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                              <span>{ruleTypeLabel(type)}</span>
                              <Info_Badge color="muted">
                                {settings.merged[type].length}
                              </Info_Badge>
                            </div>
                            <div className="mt-2 space-y-1">
                              {settings.merged[type].slice(0, 4).map((rule) => (
                                <div
                                  key={rule}
                                  className="truncate font-mono text-xs text-muted-foreground"
                                  title={rule}
                                >
                                  {rule}
                                </div>
                              ))}
                              {settings.merged[type].length === 0 ? (
                                <div className="text-xs text-muted-foreground/70">
                                  {tr(
                                    'settings.permissions.noRules',
                                    'No rules',
                                  )}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </SettingsCard>
                  </SettingsSection>
                </>
              ) : null}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <SettingsCard className="px-4 py-8">
      <div className="text-center">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </div>
    </SettingsCard>
  );
}

function RuleScopeCard({
  scope,
  ruleType,
  rules,
  path,
  draft,
  isSaving,
  onDraftChange,
  onAdd,
  onRemove,
}: {
  scope: PermissionSettingsScope;
  ruleType: PermissionRuleType;
  rules: string[];
  path: string;
  draft: string;
  isSaving: boolean;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (rule: string) => void;
}) {
  const { t } = useTranslation();
  const tr = useCallback(
    (key: string, fallback: string) => t(key, { defaultValue: fallback }),
    [t],
  );
  const placeholder =
    ruleType === 'allow' ? 'Bash(git status)' : 'Bash(rm -rf *)';

  return (
    <SettingsCard className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{scopeLabel(scope)}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {scopeDescription(scope)}
          </div>
          <div className="text-[11px] text-muted-foreground/70 mt-1 truncate font-mono">
            {path}
          </div>
        </div>
        {isSaving ? (
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0 mt-1" />
        ) : null}
      </div>

      <div className="mt-3 flex gap-2">
        <Input
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onAdd();
          }}
          placeholder={placeholder}
          className="h-8 font-mono text-xs"
        />
        <Button
          type="button"
          size="sm"
          onClick={onAdd}
          disabled={!draft.trim() || isSaving}
          className="h-8 px-2.5"
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>
      <div className="mt-1.5 text-[11px] text-muted-foreground">
        {tr(
          'settings.permissions.inputHint',
          'Examples: WebFetch, Edit, Bash(git status), Bash(npm run build). Place a rule under Ask to require confirmation, or under Deny to block matching requests.',
        )}
      </div>

      <div className="mt-3 divide-y divide-border/60">
        {rules.length > 0 ? (
          rules.map((rule) => (
            <div key={rule} className="flex items-center gap-2 py-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted/60 px-2 py-1 font-mono text-xs">
                {rule}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRemove(rule)}
                disabled={isSaving}
                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))
        ) : (
          <div className="py-3 text-xs text-muted-foreground">
            No {ruleTypeLabel(ruleType).toLowerCase()} rules in this scope.
          </div>
        )}
      </div>
    </SettingsCard>
  );
}
