import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Ref,
  type ReactNode,
} from 'react';
import {
  BotIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  PaletteIcon,
  RadioTowerIcon,
  ServerIcon,
  Settings2Icon,
  ShieldIcon,
  SlidersHorizontalIcon,
  WrenchIcon,
} from 'lucide-react';
import type {
  DaemonSettingDescriptor,
  DaemonSettingUpdateResult,
  DaemonWorkspaceSettingsStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import {
  WEB_SHELL_LANGUAGES,
  languageLabel,
  languageSettingToWebShellLanguage,
  useI18n,
  type WebShellLanguage,
} from '../../i18n';
import {
  WEB_SHELL_THEMES,
  WebShellThemeId,
  THEME_SETTING_KEY,
  LANGUAGE_SETTING_KEY,
  themeSettingToWebShellTheme,
  useTheme,
  webShellThemeToSettingValue,
  type WebShellTheme,
} from '../../themeContext';
import {
  ModelManagementSection,
  type ModelManagementProps,
} from './ModelManagementSection';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../ui/empty';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldTitle,
} from '../ui/field';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Separator } from '../ui/separator';
import { Spinner } from '../ui/spinner';
import { Switch } from '../ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

type ChatWidthMode = '1000' | 'wide';

interface SettingsMessageProps {
  settingsState: SettingsMessageSettingsState;
  onLanguageChange: (language: WebShellLanguage, scope: Scope) => void;
  onSubDialog: (settingKey: string, scope: Scope) => void;
  onThemeChange: (theme: WebShellTheme) => void;
  chatWidthMode: ChatWidthMode;
  onChatWidthModeChange: (mode: ChatWidthMode) => void;
  onOpenChannels: () => void;
  channelsTriggerRef?: Ref<HTMLButtonElement>;
  initialCategory?: string;
  /** Model list/add/delete/select, rendered inside the Model category. */
  modelManagement?: ModelManagementProps;
  embedded?: boolean;
}

export interface SettingsMessageSettingsState {
  status: DaemonWorkspaceSettingsStatus | undefined;
  settings: DaemonSettingDescriptor[];
  loading: boolean;
  error: Error | undefined;
  reload: () => Promise<DaemonWorkspaceSettingsStatus | undefined>;
  setValue: (
    scope: 'workspace' | 'user',
    key: string,
    value: unknown,
  ) => Promise<DaemonSettingUpdateResult>;
}

const SUB_DIALOG_KEYS = new Set([
  'fastModel',
  'visionModel',
  'voiceModel',
  'modelFallbacks',
]);
const HIDDEN_SETTING_KEYS = new Set([
  'ui.hideTips',
  'ui.enableUserFeedback',
  'ui.compactMode',
  'ui.compactInline',
  'mcpServers',
]);

type Scope = 'user' | 'workspace';

type Translator = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

function translateSettingText(
  t: Translator,
  key: string,
  fallback: string,
): string {
  const translated = t(key);
  return translated === key ? fallback : translated;
}

function formatSettingCategory(category: string, t: Translator): string {
  return translateSettingText(t, `settings.category.${category}`, category);
}

export function formatSettingLabel(
  setting: DaemonSettingDescriptor,
  t: Translator,
): string {
  return translateSettingText(
    t,
    `settings.label.${setting.key}`,
    setting.label,
  );
}

function formatSettingDescription(
  setting: DaemonSettingDescriptor,
  t: Translator,
): string | undefined {
  if (!setting.description) return undefined;
  return translateSettingText(
    t,
    `settings.description.${setting.key}`,
    setting.description,
  );
}

function formatSettingOption(
  setting: DaemonSettingDescriptor,
  value: unknown,
  label: string,
  t: Translator,
): string {
  return translateSettingText(
    t,
    `settings.option.${setting.key}.${String(value)}`,
    label,
  );
}

function formatValue(
  setting: DaemonSettingDescriptor,
  scope: Scope,
  t: Translator,
): string {
  const effective = resolveValue(setting, scope);
  if (effective === undefined || effective === null) return '';
  if (setting.key === THEME_SETTING_KEY) {
    const theme = themeSettingToWebShellTheme(effective, WebShellThemeId.Dark);
    return t(`theme.${theme}`);
  }
  if (setting.key === LANGUAGE_SETTING_KEY) {
    const language = languageSettingToWebShellLanguage(effective);
    return language ? languageLabel(language) : String(effective);
  }
  if (setting.type === 'boolean')
    return effective === true
      ? t('settings.value.on')
      : t('settings.value.off');
  if (setting.type === 'enum' && setting.options) {
    const opt = setting.options.find((o) => o.value === effective);
    return opt
      ? formatSettingOption(setting, opt.value, opt.label, t)
      : String(effective);
  }
  const s = String(effective);
  return s.length > 24 ? `${s.slice(0, 21)}…` : s;
}

function scopeHasValue(
  setting: DaemonSettingDescriptor,
  scope: Scope,
): boolean {
  const val = scope === 'user' ? setting.values.user : setting.values.workspace;
  return val !== undefined;
}

/* Mirrors the native CLI's getScopeMessageForSetting(): "(Modified in X)"
   when only the other scope has a value, "(Also modified in X)" when both
   do. Returns the i18n key; undefined when the other scope is untouched. */
function scopeHintKey(
  setting: DaemonSettingDescriptor,
  scope: Scope,
): 'settings.modifiedIn' | 'settings.alsoModifiedIn' | undefined {
  const otherHasValue =
    scope === 'workspace'
      ? setting.values.user !== undefined
      : setting.values.workspace !== undefined;
  if (!otherHasValue) return undefined;
  return scopeHasValue(setting, scope)
    ? 'settings.alsoModifiedIn'
    : 'settings.modifiedIn';
}

function resolveValue(setting: DaemonSettingDescriptor, scope: Scope): unknown {
  const scopeVal =
    scope === 'user' ? setting.values.user : setting.values.workspace;
  return scopeVal !== undefined ? scopeVal : setting.values.effective;
}

interface CategoryGroup {
  category: string;
  items: DaemonSettingDescriptor[];
}

type SettingsPageItem =
  | { type: 'setting'; setting: DaemonSettingDescriptor }
  | { type: 'local'; localKey: 'chatWidth' | 'channels' };

interface SettingsPageCategory {
  id: string;
  label: string;
  items: SettingsPageItem[];
}

function groupByCategory(settings: DaemonSettingDescriptor[]): CategoryGroup[] {
  const map = new Map<string, DaemonSettingDescriptor[]>();
  for (const s of settings) {
    let group = map.get(s.category);
    if (!group) {
      group = [];
      map.set(s.category, group);
    }
    group.push(s);
  }
  return Array.from(map.entries()).map(([category, items]) => ({
    category,
    items,
  }));
}

function CategoryIcon({ category }: { category: string }) {
  const normalized = category.toLowerCase();
  const Icon = normalized.includes('channel')
    ? RadioTowerIcon
    : normalized.includes('ui')
      ? PaletteIcon
      : normalized.includes('tool')
        ? WrenchIcon
        : normalized.includes('context')
          ? DatabaseIcon
          : normalized.includes('privacy')
            ? ShieldIcon
            : normalized.includes('model')
              ? BotIcon
              : normalized.includes('daemon')
                ? ServerIcon
                : normalized.includes('advanced')
                  ? SlidersHorizontalIcon
                  : normalized.includes('experimental')
                    ? FlaskConicalIcon
                    : Settings2Icon;
  return <Icon data-icon="inline-start" aria-hidden="true" />;
}

function SettingsRow({
  title,
  description,
  metadata,
  control,
}: {
  title: string;
  description?: string;
  metadata?: ReactNode;
  control: ReactNode;
}) {
  return (
    <Field
      orientation="responsive"
      className="min-h-20 gap-6 px-5 py-4 max-md:px-4"
    >
      <FieldContent className="min-w-0">
        <FieldTitle>
          {title}
          {metadata}
        </FieldTitle>
        {description && (
          <FieldDescription className="max-w-3xl">
            {description}
          </FieldDescription>
        )}
      </FieldContent>
      <div className="flex min-w-0 justify-end max-md:justify-start">
        {control}
      </div>
    </Field>
  );
}

function SettingInput({
  name,
  label,
  type,
  value,
  disabled,
  onCommit,
  onInvalid,
}: {
  name: string;
  label: string;
  type: 'number' | 'text';
  value: unknown;
  disabled: boolean;
  onCommit: (value: unknown) => void;
  onInvalid: () => void;
}) {
  const currentValue = String(value ?? '');
  const [draft, setDraft] = useState(currentValue);

  useEffect(() => setDraft(currentValue), [currentValue]);

  const commit = () => {
    if (type === 'number') {
      const trimmed = draft.trim();
      const parsed = Number(trimmed);
      if (!trimmed || !Number.isFinite(parsed)) {
        setDraft(currentValue);
        onInvalid();
        return;
      }
      if (parsed !== value) onCommit(parsed);
      return;
    }
    if (draft !== currentValue) onCommit(draft);
  };

  return (
    <Input
      type={type}
      name={name}
      autoComplete="off"
      aria-label={label}
      value={draft}
      disabled={disabled}
      className="w-[min(80px,50vw)] max-md:w-full"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(currentValue);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export type FlatRow =
  | { type: 'header'; category: string }
  | { type: 'setting'; setting: DaemonSettingDescriptor }
  | { type: 'local'; localKey: 'chatWidth' | 'channels' };

/* Wraps around at both ends (matching the native CLI) while skipping
   category-header rows. Exported for tests. */
export function nextSettingIdx(
  rows: FlatRow[],
  current: number,
  dir: 1 | -1,
): number {
  const n = rows.length;
  if (n === 0) return current;
  let i = current;
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n;
    if (rows[i]!.type === 'setting' || rows[i]!.type === 'local') return i;
  }
  return current;
}

export function SettingsMessage({
  settingsState,
  onLanguageChange,
  onSubDialog,
  onThemeChange,
  chatWidthMode,
  onChatWidthModeChange,
  onOpenChannels,
  channelsTriggerRef,
  initialCategory,
  modelManagement,
  embedded = false,
}: SettingsMessageProps) {
  const { language: selectedLanguage, t } = useI18n();
  const selectedTheme = useTheme();
  const { status, settings, loading, error, reload, setValue } = settingsState;
  const [scope, setScope] = useState<Scope>('workspace');
  const [activeCategory, setActiveCategory] = useState(
    () => initialCategory ?? '',
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [restartPending, setRestartPending] = useState(false);

  const showInitialLoading = loading && !status;
  const categories = useMemo(() => {
    const visibleSettings = settings.filter(
      (setting) => !HIDDEN_SETTING_KEYS.has(setting.key),
    );
    const groups: SettingsPageCategory[] = groupByCategory(visibleSettings).map(
      (group) => ({
        id: group.category,
        label: formatSettingCategory(group.category, t),
        items: group.items.map((setting) => ({
          type: 'setting' as const,
          setting,
        })),
      }),
    );
    const localItem = {
      type: 'local' as const,
      localKey: 'chatWidth' as const,
    };
    const themeGroup = groups.find((group) =>
      group.items.some(
        (item) =>
          item.type === 'setting' && item.setting.key === THEME_SETTING_KEY,
      ),
    );
    if (themeGroup) {
      const themeIndex = themeGroup.items.findIndex(
        (item) =>
          item.type === 'setting' && item.setting.key === THEME_SETTING_KEY,
      );
      themeGroup.items.splice(themeIndex + 1, 0, localItem);
    } else {
      groups.push({
        id: 'UI',
        label: formatSettingCategory('UI', t),
        items: [localItem],
      });
    }
    groups.push({
      id: 'Channels',
      label: t('settings.category.Channels'),
      items: [{ type: 'local', localKey: 'channels' }],
    });
    return groups;
  }, [settings, t]);

  useEffect(() => {
    if (categories.length === 0) return;
    if (!categories.some((category) => category.id === activeCategory)) {
      setActiveCategory(categories[0]!.id);
    }
  }, [activeCategory, categories]);

  useEffect(() => {
    if (error) setMessage(error.message);
    else if (status?.warnings?.length)
      setMessage(
        status.warnings
          .map((w) =>
            t('settings.corrupted', {
              recovered: w.recovered ? 'true' : 'false',
            }),
          )
          .join('; '),
      );
    else if (settings.length > 0) setMessage(null);
  }, [error, settings, status, t]);

  const handleSetValue = useCallback(
    (key: string, value: unknown) => {
      if (!restartPending) setMessage(null);
      setBusyKey(key);
      setValue(scope, key, value)
        .then(async (result) => {
          try {
            await reload();
          } catch {
            // reload failure is non-fatal — the value was already saved
          }
          if (result?.requiresRestart && key !== LANGUAGE_SETTING_KEY) {
            setRestartPending(true);
          }
        })
        .catch((err: unknown) => {
          setMessage(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusyKey(null));
    },
    [reload, restartPending, scope, setValue],
  );

  const activeGroup =
    categories.find((category) => category.id === activeCategory) ??
    categories[0];

  // The model-management block is surfaced inside the "Model" category, detected
  // by the raw category of its dialog settings (fastModel etc.).
  const isModelCategory = activeGroup?.items.some(
    (item) => item.type === 'setting' && item.setting.category === 'Model',
  );

  const renderSelect = (
    value: string,
    onChange: (value: string) => void,
    options: Array<{ value: string; label: string }>,
    ariaLabel: string,
    disabled = false,
  ) => (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label={ariaLabel}
        className="w-[min(160px,50vw)] bg-background max-md:w-full"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );

  const renderSettingControl = (setting: DaemonSettingDescriptor) => {
    const value = resolveValue(setting, scope);
    const isBusy = busyKey === setting.key;
    // User-scope settings are editable (this PR enables user-scope writes); the
    // daemon rejects disallowed keys regardless of scope.
    const disabled = isBusy;

    // Theme is a daemon-backed setting, so update both the live shell and the
    // settings API. Language is applied through the language callback (which
    // forwards the selected scope to the /language command). Both controls
    // reflect the value for the SELECTED scope, falling back to the live value.
    if (setting.key === THEME_SETTING_KEY) {
      return renderSelect(
        themeSettingToWebShellTheme(value) ?? selectedTheme,
        (next) => {
          const theme = next as WebShellTheme;
          onThemeChange(theme);
          handleSetValue(THEME_SETTING_KEY, webShellThemeToSettingValue(theme));
        },
        WEB_SHELL_THEMES.map((theme) => ({
          value: theme,
          label: t(`theme.${theme}`),
        })),
        formatSettingLabel(setting, t),
        disabled,
      );
    }

    if (setting.key === LANGUAGE_SETTING_KEY) {
      return renderSelect(
        languageSettingToWebShellLanguage(value) ?? selectedLanguage,
        (next) => onLanguageChange(next as WebShellLanguage, scope),
        WEB_SHELL_LANGUAGES.map((language) => ({
          value: language,
          label: languageLabel(language),
        })),
        formatSettingLabel(setting, t),
        disabled,
      );
    }

    if (SUB_DIALOG_KEYS.has(setting.key)) {
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className="max-w-[260px] truncate"
          onClick={() => onSubDialog(setting.key, scope)}
        >
          {formatValue(setting, scope, t) || t('settings.action.select')}
        </Button>
      );
    }

    if (setting.type === 'boolean') {
      const checked = value === true;
      return (
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => handleSetValue(setting.key, next)}
          aria-label={formatSettingLabel(setting, t)}
        />
      );
    }

    if (setting.type === 'enum' && setting.options?.length) {
      const currentIndex = setting.options.findIndex(
        (option) => option.value === value,
      );
      return renderSelect(
        currentIndex >= 0 ? String(currentIndex) : '',
        (next) => {
          const option = setting.options?.[Number(next)];
          if (option) handleSetValue(setting.key, option.value);
        },
        setting.options.map((option, index) => ({
          value: String(index),
          label: formatSettingOption(setting, option.value, option.label, t),
        })),
        formatSettingLabel(setting, t),
        disabled,
      );
    }

    return (
      <SettingInput
        name={setting.key}
        label={formatSettingLabel(setting, t)}
        type={setting.type === 'number' ? 'number' : 'text'}
        value={value}
        disabled={disabled}
        onCommit={(next) => handleSetValue(setting.key, next)}
        onInvalid={() => setMessage(t('settings.invalidNumber'))}
      />
    );
  };

  return (
    <div
      className={
        embedded
          ? 'flex min-h-0 flex-1 flex-col text-sm text-foreground'
          : 'flex max-w-[min(var(--chat-regular-content-width,1000px),calc(100vw-64px))] flex-col overflow-hidden rounded-xl border border-border bg-background text-sm text-foreground'
      }
      data-keyboard-scope
    >
      {!embedded && (
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-balance">
              {t('settings.title')}
            </h2>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.scope.workspace')}
            </div>
          </div>
        </div>
      )}

      {(message || showInitialLoading) && (
        <Alert className="mx-4 mt-3 w-auto">
          {showInitialLoading && <Spinner />}
          <AlertDescription>
            {message || t('settings.loading')}
          </AlertDescription>
        </Alert>
      )}

      <Tabs
        value={scope}
        className="flex min-h-0 flex-1 flex-col gap-0"
        onValueChange={(next) => {
          setScope(next as Scope);
        }}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-3 py-2">
          <TabsList className="p-0">
            <TabsTrigger value="workspace">
              {t('settings.scope.workspace')}
            </TabsTrigger>
            <TabsTrigger value="user">{t('settings.scope.user')}</TabsTrigger>
          </TabsList>
          {restartPending && (
            <Badge variant="secondary">{t('settings.requiresRestart')}</Badge>
          )}
        </div>

        <TabsContent
          value={scope}
          forceMount
          className="grid min-h-0 flex-1 grid-cols-[190px_minmax(0,1fr)] outline-none max-md:grid-cols-1"
        >
          <nav
            className="flex min-h-0 flex-col gap-1 overflow-y-auto border-r border-border bg-muted/20 p-3 max-md:flex-row max-md:overflow-x-auto max-md:border-r-0 max-md:border-b"
            aria-label={t('settings.title')}
          >
            {categories.map((category) => (
              <Button
                key={category.id}
                type="button"
                variant={category.id === activeCategory ? 'secondary' : 'ghost'}
                size="sm"
                aria-current={
                  category.id === activeCategory ? 'page' : undefined
                }
                className="w-full justify-start gap-2 px-2.5 max-md:w-auto max-md:shrink-0"
                onClick={() => setActiveCategory(category.id)}
              >
                <CategoryIcon category={category.id} />
                <span className="min-w-0 flex-1 truncate text-left">
                  {category.label}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {category.items.length}
                </span>
              </Button>
            ))}
          </nav>

          <section className="min-h-0 min-w-0 overflow-y-auto bg-background p-5 max-md:p-3">
            {!loading && !activeGroup && (
              <Empty className="min-h-60">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Settings2Icon />
                  </EmptyMedia>
                  <EmptyTitle>{t('settings.empty')}</EmptyTitle>
                  <EmptyDescription>{t('settings.empty')}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {activeGroup && (
              <div className="mx-auto w-full max-w-5xl">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <CategoryIcon category={activeGroup.id} />
                      {activeGroup.label}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="-mb-(--card-spacing) p-0">
                    <FieldGroup className="gap-0">
                      {activeGroup.items.map((item, index) => {
                        const separator = index > 0 && (
                          <Separator className="mx-5 w-auto max-md:mx-4" />
                        );
                        if (item.type === 'local') {
                          if (item.localKey === 'channels') {
                            return (
                              <div key={item.localKey}>
                                {separator}
                                <SettingsRow
                                  title={t('settings.channels.title')}
                                  description={t(
                                    'settings.channels.description',
                                  )}
                                  control={
                                    <Button
                                      ref={channelsTriggerRef}
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={onOpenChannels}
                                    >
                                      {t('settings.channels.action')}
                                    </Button>
                                  }
                                />
                              </div>
                            );
                          }
                          return (
                            <div key={item.localKey}>
                              {separator}
                              <SettingsRow
                                title={t('settings.label.ui.chatWidth')}
                                description={t(
                                  'settings.description.ui.chatWidth',
                                )}
                                control={renderSelect(
                                  chatWidthMode,
                                  (next) =>
                                    onChatWidthModeChange(
                                      next as ChatWidthMode,
                                    ),
                                  [
                                    {
                                      value: '1000',
                                      label: t(
                                        'settings.option.ui.chatWidth.1000',
                                      ),
                                    },
                                    {
                                      value: 'wide',
                                      label: t(
                                        'settings.option.ui.chatWidth.wide',
                                      ),
                                    },
                                  ],
                                  t('settings.label.ui.chatWidth'),
                                  false,
                                )}
                              />
                            </div>
                          );
                        }

                        const setting = item.setting;
                        const description = formatSettingDescription(
                          setting,
                          t,
                        );
                        const hintKey = scopeHintKey(setting, scope);
                        const hasScopeValue = scopeHasValue(setting, scope);
                        const scopeHint = hintKey
                          ? t(hintKey, {
                              scope: t(
                                scope === 'workspace'
                                  ? 'settings.scope.user'
                                  : 'settings.scope.workspace',
                              ),
                            })
                          : undefined;
                        return (
                          <div key={setting.key}>
                            {separator}
                            <SettingsRow
                              title={formatSettingLabel(setting, t)}
                              description={
                                [description, scopeHint]
                                  .filter(Boolean)
                                  .join(' · ') || undefined
                              }
                              metadata={
                                hasScopeValue ? (
                                  <Badge variant="secondary">
                                    {scope === 'workspace'
                                      ? t('settings.scope.workspace')
                                      : t('settings.scope.user')}
                                  </Badge>
                                ) : undefined
                              }
                              control={
                                busyKey === setting.key ? (
                                  <Spinner />
                                ) : (
                                  renderSettingControl(setting)
                                )
                              }
                            />
                          </div>
                        );
                      })}
                    </FieldGroup>
                  </CardContent>
                </Card>
                {isModelCategory && modelManagement && (
                  <div className="mt-4">
                    <ModelManagementSection {...modelManagement} />
                  </div>
                )}
              </div>
            )}
          </section>
        </TabsContent>
      </Tabs>

      {!embedded && (
        <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          {t('settings.footer')}
        </div>
      )}
    </div>
  );
}
