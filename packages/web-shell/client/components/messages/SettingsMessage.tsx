import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  BotIcon,
  CableIcon,
  ArchiveIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  PaletteIcon,
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
} from '@qwen-code/web-shell/daemon-react-sdk';
import {
  WEB_SHELL_LANGUAGES,
  languageLabel,
  languageSettingToWebShellLanguage,
  useI18n,
  type WebShellLanguage,
} from '../../i18n';
import { useBrowserNotificationSettings } from '../../browser-turn-notifications';
import { LiveVoiceSettingsCard } from '../../live/LiveVoiceSettingsCard';
import type { UseLiveVoiceSetupResult } from '../../live/useLiveVoiceSetup';
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
import { LocalControlSettingsCard } from './LocalControlSettingsCard';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty';
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

import {
  isItemVisible,
  isSettingVisible,
  OUTPUT_LANGUAGE_SETTING_KEY,
  type WebShellSettingsOptions,
} from '../../settings';

type ChatWidthMode = '1000' | 'wide';

interface SettingsMessageProps {
  settingsState: SettingsMessageSettingsState;
  presentation?: WebShellSettingsOptions;
  onLanguageChange: (language: WebShellLanguage, scope: Scope) => void;
  /**
   * Applies a model output language through `/language output`. Resolves to
   * whether the value was applied, so a rejected commit can restore the saved
   * value instead of leaving an unsaved draft on screen.
   */
  onOutputLanguageChange: (language: string) => Promise<boolean> | boolean;
  onSubDialog: (settingKey: string, scope: Scope) => void;
  onThemeChange: (theme: WebShellTheme) => void;
  chatWidthMode: ChatWidthMode;
  onChatWidthModeChange: (mode: ChatWidthMode) => void;
  /** Model list/add/delete/select, rendered inside the Model category. */
  modelManagementSectionProps?: ModelManagementProps;
  /** Browser-local remote computer catalog and connection controls. */
  connections?: ReactNode;
  archivedSessions?: ReactNode;
  /**
   * Extra-directory management for the selected workspace. Rendered only on
   * the Workspace scope tab; omitted when the daemon cannot manage them.
   */
  workspaceDirectoriesSection?: ReactNode;
  embedded?: boolean;
  /** Category to select on open (deep link, e.g. 'Daemon'). */
  initialCategory?: string;
  /**
   * Whether the active session may write workspace settings. Standalone
   * sessions cannot: their `/language ui --project` is refused, so the UI
   * language row is offered only under the User tab, the one scope it can
   * persist.
   */
  workspaceSettingsWritable?: boolean;
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
  liveSetup?: UseLiveVoiceSetupResult;
}

const SUB_DIALOG_KEYS = new Set([
  'advisorModel',
  'imageModel',
  'fastModel',
  'visionModel',
  'voiceModel',
  'modelFallbacks',
]);
const HIDDEN_SETTING_KEYS = new Set([
  'ui.allowedApprovalModes',
  'ui.hideTips',
  'ui.enableUserFeedback',
  // Compact behavior is fixed on in the web shell; the daemon schema still
  // carries the retired setting, so keep it hidden from the panel.
  'ui.compactMode',
  // Custom phrases are honored from configuration files; the settings editor
  // does not yet support editing or validating array-typed values.
  'ui.customWittyPhrases',
  'mcpServers',
  'model.reasoningEffort',
]);
const LIVE_SETTING_KEYS = new Set([
  'experimental.liveVoice.enabled',
  'experimental.liveVoice.shortcut',
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
  if (setting.key === 'advisorModel' && effective === '')
    return t('model.useMain');
  if (setting.key === 'imageModel' && effective === '')
    return t('model.disabled');
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
  const s = String(effective).replaceAll('\0', ' · ');
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
  | { type: 'local'; localKey: 'chatWidth' | 'browserNotifications' }
  | { type: 'local-control' }
  | { type: 'live' }
  | { type: 'connections' }
  | { type: 'archived-sessions' }
  | { type: 'workspace-directories' }
  | { type: 'model-management' };

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
  const Icon =
    normalized === 'archived'
      ? ArchiveIcon
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
                : normalized.includes('connection')
                  ? CableIcon
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

// A commit may be rejected (busy session, failed command). The saved value
// does not change in that case, so the draft has to be restored explicitly.
function applyCommitResult(result: unknown, restore: () => void): void {
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    void (result as Promise<unknown>).then(
      (applied) => {
        if (applied === false) restore();
      },
      () => restore(),
    );
    return;
  }
  if (result === false) restore();
}

function OutputLanguageCombobox({
  name,
  label,
  value,
  options,
  disabled,
  placeholder,
  onCommit,
}: {
  name: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string | number; label: string }>;
  disabled: boolean;
  placeholder: string;
  onCommit: (value: string) => unknown;
}) {
  const { t } = useI18n();
  const currentValue = value;
  const [draft, setDraft] = useState(currentValue);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Enter takes the highlighted row only after the user moved through the
  // list; otherwise it keeps the exact typed text.
  const [navigated, setNavigated] = useState(false);
  const [pending, setPending] = useState(false);
  const lastCommittedRef = useRef<string | null>(null);
  const listId = `${name}-options`;

  useEffect(() => {
    setDraft(currentValue);
    setNavigated(false);
    setActiveIndex(0);
    lastCommittedRef.current = null;
  }, [currentValue]);

  const items = useMemo(() => {
    const all = [
      { value: '', label: placeholder },
      ...options.map((option) => ({
        value: String(option.value),
        label: option.label,
      })),
    ];
    const query = draft.trim().toLowerCase();
    // Opening on the saved value shows every suggestion; only an edited draft
    // narrows the list.
    if (!query || query === currentValue.trim().toLowerCase()) return all;
    const matches = all.filter(
      (item) =>
        item.value.toLowerCase().includes(query) ||
        item.label.toLowerCase().includes(query),
    );
    if (matches.length > 0) return matches;
    // The setting accepts any language name, so an unmatched draft stays
    // selectable as free-form input.
    return [
      {
        value: draft.trim(),
        label: t('settings.option.general.outputLanguage.useCustom', {
          value: draft.trim(),
        }),
      },
    ];
  }, [currentValue, draft, options, placeholder, t]);

  const commit = (next: string) => {
    if (pending) return;
    const trimmed = next.trim();
    setOpen(false);
    setNavigated(false);
    setActiveIndex(0);
    if (
      trimmed === currentValue.trim() ||
      trimmed === lastCommittedRef.current
    ) {
      setDraft(currentValue);
      return;
    }
    lastCommittedRef.current = trimmed;
    // Show the value being saved so a later blur cannot resubmit the query.
    setDraft(trimmed);
    setPending(true);
    const settle = (applied: unknown) => {
      setPending(false);
      if (applied === false) {
        lastCommittedRef.current = null;
        setDraft(currentValue);
      }
    };
    const result = onCommit(trimmed);
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      void (result as Promise<unknown>).then(settle, () => settle(false));
    } else {
      settle(result);
    }
  };

  // Enter keeps the exact typed text (or the saved value) unless the user
  // explicitly moved through the list; only an exact or unique-prefix match
  // resolves to a suggestion.
  const commitDraft = () => {
    const trimmed = draft.trim();
    if (trimmed === currentValue.trim()) {
      setDraft(currentValue);
      setOpen(false);
      return;
    }
    const lower = trimmed.toLowerCase();
    const all = [
      { value: '', label: placeholder },
      ...options.map((option) => ({
        value: String(option.value),
        label: option.label,
      })),
    ];
    const exact = all.find(
      (item) =>
        item.value.toLowerCase() === lower ||
        item.label.toLowerCase() === lower,
    );
    if (exact) {
      commit(exact.value);
      return;
    }
    const prefixMatches = trimmed
      ? all.filter(
          (item) =>
            item.value.toLowerCase().startsWith(lower) ||
            item.label.toLowerCase().startsWith(lower),
        )
      : [];
    commit(prefixMatches.length === 1 ? prefixMatches[0].value : trimmed);
  };

  return (
    <div className="relative">
      <Input
        role="combobox"
        name={name}
        autoComplete="off"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && items[activeIndex] ? `${listId}-${activeIndex}` : undefined
        }
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        className="w-[min(200px,50vw)] max-md:w-full"
        onChange={(event) => {
          setDraft(event.target.value);
          setActiveIndex(0);
          setNavigated(false);
          setOpen(true);
        }}
        onFocus={() => {
          // A new interaction starts un-navigated, so Enter keeps the saved
          // value instead of reusing the previous round's highlight.
          setNavigated(false);
          setActiveIndex(0);
          setOpen(true);
        }}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setNavigated(true);
            setActiveIndex((index) => Math.min(index + 1, items.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setNavigated(true);
            setActiveIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const picked = open && navigated ? items[activeIndex] : undefined;
            if (picked) commit(picked.value);
            else commitDraft();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            setNavigated(false);
            setDraft(currentValue);
          }
        }}
      />
      {open && !disabled && (
        <div
          role="listbox"
          id={listId}
          className="absolute left-0 top-full z-20 mt-1 max-h-64 w-[min(240px,80vw)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          // Keep focus in the input so clicking an option does not commit the
          // typed draft first.
          onMouseDown={(event) => event.preventDefault()}
        >
          {items.map((item, index) => (
            <div
              key={item.value || 'auto'}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-sm ${
                index === activeIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/60'
              }`}
              onMouseEnter={() => {
                setActiveIndex(index);
                setNavigated(true);
              }}
              onClick={() => commit(item.value)}
            >
              <span className="truncate">{item.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
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
  placeholder,
  className = 'w-[min(80px,50vw)] max-md:w-full',
}: {
  name: string;
  label: string;
  type: 'number' | 'text';
  value: unknown;
  disabled: boolean;
  onCommit: (value: unknown) => unknown;
  onInvalid: () => void;
  placeholder?: string;
  className?: string;
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
      if (parsed !== value) {
        applyCommitResult(onCommit(parsed), () => setDraft(currentValue));
      }
      return;
    }
    if (draft !== currentValue) {
      applyCommitResult(onCommit(draft), () => setDraft(currentValue));
    }
  };

  return (
    <Input
      type={type}
      name={name}
      autoComplete="off"
      aria-label={label}
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      className={className}
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
  | { type: 'local'; localKey: 'chatWidth' | 'browserNotifications' };

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
  presentation,
  onLanguageChange,
  onOutputLanguageChange,
  onSubDialog,
  onThemeChange,
  chatWidthMode,
  onChatWidthModeChange,
  modelManagementSectionProps,
  connections,
  archivedSessions,
  workspaceDirectoriesSection,
  embedded = false,
  initialCategory,
  workspaceSettingsWritable = true,
}: SettingsMessageProps) {
  const { language: selectedLanguage, t } = useI18n();
  const selectedTheme = useTheme();
  const notifications = useBrowserNotificationSettings();
  const refreshNotificationPermission = notifications?.refreshPermission;
  useEffect(() => {
    refreshNotificationPermission?.();
  }, [refreshNotificationPermission]);
  const { status, settings, loading, error, reload, setValue, liveSetup } =
    settingsState;
  // A standalone session has no workspace to write, so opening the panel on
  // the Workspace tab would only offer rows whose session-routed writes are
  // refused (the UI language row). Start on the User tab there instead.
  const [scope, setScope] = useState<Scope>(
    workspaceSettingsWritable ? 'workspace' : 'user',
  );
  const [activeCategory, setActiveCategory] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [restartPending, setRestartPending] = useState(false);

  const hasNotifications = notifications !== undefined;
  const showInitialLoading = loading && !status;
  const categories = useMemo(() => {
    const visibleSettings = settings.filter(
      (setting) =>
        !HIDDEN_SETTING_KEYS.has(setting.key) &&
        !LIVE_SETTING_KEYS.has(setting.key),
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
    if (hasNotifications) {
      const group = groups.find((item) => item.items.includes(localItem));
      group?.items.push({ type: 'local', localKey: 'browserNotifications' });
    }
    if (liveSetup?.supported) {
      const experimental = groups.find((group) => group.id === 'Experimental');
      if (experimental) {
        experimental.items.unshift({ type: 'live' });
      } else {
        groups.push({
          id: 'Experimental',
          label: formatSettingCategory('Experimental', t),
          items: [{ type: 'live' }],
        });
      }
    }
    const daemon = groups.find((group) => group.id === 'Daemon');
    if (daemon) {
      daemon.items.unshift({ type: 'local-control' });
    } else {
      groups.push({
        id: 'Daemon',
        label: formatSettingCategory('Daemon', t),
        items: [{ type: 'local-control' }],
      });
    }
    if (modelManagementSectionProps && !showInitialLoading) {
      const model = groups.find((group) => group.id === 'Model');
      if (model) model.items.push({ type: 'model-management' });
      else
        groups.push({
          id: 'Model',
          label: formatSettingCategory('Model', t),
          items: [{ type: 'model-management' }],
        });
    }
    if (connections) {
      groups.push({
        id: 'Connections',
        label: formatSettingCategory('Connections', t),
        items: [{ type: 'connections' }],
      });
    }
    if (archivedSessions) {
      groups.push({
        id: 'Archived',
        label: formatSettingCategory('Archived', t),
        items: [{ type: 'archived-sessions' }],
      });
    }
    // Extra directories are a workspace-scope concept; the User tab has no
    // equivalent list to show.
    if (workspaceDirectoriesSection && scope === 'workspace') {
      groups.push({
        id: 'Workspace',
        label: t('workspaceDirectories.title'),
        items: [{ type: 'workspace-directories' }],
      });
    }
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          if (item.type === 'setting') {
            return isSettingVisible(item.setting.key, presentation);
          }
          const id =
            item.type === 'local'
              ? item.localKey === 'chatWidth'
                ? 'builtin:chat-width'
                : 'builtin:browser-notifications'
              : item.type === 'live'
                ? 'builtin:live-setup'
                : item.type === 'local-control'
                  ? 'builtin:local-control'
                  : item.type === 'connections'
                    ? 'builtin:connections'
                    : item.type === 'archived-sessions'
                      ? 'builtin:archived-sessions'
                      : item.type === 'workspace-directories'
                        ? 'builtin:workspace-directories'
                        : 'builtin:model-management';
          return isItemVisible(id, presentation);
        }),
      }))
      .filter((group) => group.items.length > 0);
  }, [
    liveSetup,
    settings,
    t,
    hasNotifications,
    modelManagementSectionProps,
    connections,
    archivedSessions,
    workspaceDirectoriesSection,
    scope,
    presentation,
    showInitialLoading,
  ]);

  useEffect(() => {
    if (categories.length === 0) return;
    if (!categories.some((category) => category.id === activeCategory)) {
      // A deep link (initialCategory) only matters while no valid category
      // is selected, so it wins on mount but never overrides a later manual
      // switch. Keeping this in one effect avoids two effects racing to set
      // the initial category under StrictMode double-invocation.
      const preferred =
        initialCategory &&
        categories.some((category) => category.id === initialCategory)
          ? initialCategory
          : categories[0]!.id;
      setActiveCategory(preferred);
    }
  }, [activeCategory, categories, initialCategory]);

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
    (key: string, value: unknown, onSaved?: () => void) => {
      if (!restartPending) setMessage(null);
      setBusyKey(key);
      setValue(scope, key, value)
        .then(async (result) => {
          onSaved?.();
          try {
            await reload();
          } catch {
            // reload failure is non-fatal — the value was already saved
          }
          // Loading phrases take effect immediately in the web shell via reactive
          // settings subscription, so suppress the restart banner for this key.
          if (
            result?.requiresRestart &&
            key !== LANGUAGE_SETTING_KEY &&
            key !== 'ui.accessibility.enableLoadingPhrases'
          ) {
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

  const activeRows =
    activeGroup?.items.filter(
      (item) =>
        item.type !== 'model-management' &&
        item.type !== 'connections' &&
        item.type !== 'archived-sessions' &&
        item.type !== 'workspace-directories',
    ) ?? [];
  const showModelManagement = activeGroup?.items.some(
    (item) => item.type === 'model-management',
  );
  const showArchivedSessions = activeGroup?.id === 'Archived';
  const showConnections = activeGroup?.items.some(
    (item) => item.type === 'connections',
  );
  const showWorkspaceDirectories = activeGroup?.items.some(
    (item) => item.type === 'workspace-directories',
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
          handleSetValue(
            THEME_SETTING_KEY,
            webShellThemeToSettingValue(theme),
            scope === 'user' ? () => onThemeChange(theme) : undefined,
          );
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

    if (setting.key === OUTPUT_LANGUAGE_SETTING_KEY) {
      // Model output language is a user-level preference applied by the
      // language command (which rewrites output-language.md and refreshes
      // running sessions); an empty value means follow the user's input. The
      // combobox offers the supported names but still accepts any language.
      const effective = String(value ?? '').trim();
      return (
        <OutputLanguageCombobox
          name={setting.key}
          label={formatSettingLabel(setting, t)}
          value={effective.toLowerCase() === 'auto' ? '' : effective}
          options={setting.options ?? []}
          placeholder={t('settings.placeholder.general.outputLanguage')}
          disabled={disabled}
          onCommit={(next) => onOutputLanguageChange(String(next ?? '').trim())}
        />
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
        type={
          setting.type === 'number' || setting.type === 'integer'
            ? 'number'
            : 'text'
        }
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
        {restartPending &&
          (activeGroup?.id === 'Connections' || showArchivedSessions) && (
            <div className="border-b border-border px-3 py-2">
              <Badge variant="secondary">{t('settings.requiresRestart')}</Badge>
            </div>
          )}
        {activeGroup?.id !== 'Connections' && !showArchivedSessions && (
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
        )}

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
                {category.id !== 'Archived' && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {Math.max(
                      1,
                      category.items.filter(
                        (item) => item.type !== 'model-management',
                      ).length,
                    )}
                  </span>
                )}
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
                </EmptyHeader>
              </Empty>
            )}
            {activeGroup && (
              <div className="mx-auto w-full max-w-5xl">
                {activeRows.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <CategoryIcon category={activeGroup.id} />
                        {activeGroup.label}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="-mb-(--card-spacing) p-0">
                      <FieldGroup className="gap-0">
                        {activeRows.map((item, index) => {
                          const separator = index > 0 && (
                            <Separator className="mx-5 w-auto max-md:mx-4" />
                          );
                          if (
                            item.type === 'local' &&
                            item.localKey === 'browserNotifications' &&
                            notifications
                          ) {
                            const unavailable =
                              notifications.permission === 'unavailable';
                            const status = unavailable
                              ? 'unavailable'
                              : notifications.pending
                                ? 'requesting'
                                : notifications.permission === 'denied'
                                  ? 'denied'
                                  : notifications.error
                                    ? 'error'
                                    : notifications.enabled
                                      ? notifications.permission === 'granted'
                                        ? 'enabled'
                                        : 'waiting'
                                      : 'disabled';
                            return (
                              <div key={item.localKey}>
                                {separator}
                                <SettingsRow
                                  title={t('browserNotifications.label')}
                                  description={[
                                    t('browserNotifications.description'),
                                    t(`browserNotifications.${status}`),
                                    ...(!notifications.persistent
                                      ? [t('browserNotifications.temporary')]
                                      : []),
                                  ].join(' ')}
                                  control={
                                    <div className="flex items-center gap-2">
                                      {notifications.enabled &&
                                        notifications.permission ===
                                          'default' && (
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={notifications.pending}
                                            onClick={() =>
                                              void notifications.setEnabled(
                                                true,
                                              )
                                            }
                                          >
                                            {t('browserNotifications.allow')}
                                          </Button>
                                        )}
                                      <Switch
                                        aria-label={t(
                                          'browserNotifications.label',
                                        )}
                                        checked={notifications.enabled}
                                        disabled={
                                          notifications.pending ||
                                          (unavailable &&
                                            !notifications.enabled)
                                        }
                                        onCheckedChange={(enabled) =>
                                          void notifications.setEnabled(enabled)
                                        }
                                      />
                                    </div>
                                  }
                                />
                              </div>
                            );
                          }
                          if (item.type === 'local') {
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
                          if (item.type === 'live') {
                            return liveSetup ? (
                              <div key="live-voice-setup">
                                {separator}
                                <LiveVoiceSettingsCard setup={liveSetup} />
                              </div>
                            ) : null;
                          }
                          if (item.type === 'local-control') {
                            return (
                              <div key="local-control">
                                {separator}
                                <LocalControlSettingsCard />
                              </div>
                            );
                          }

                          if (
                            item.setting.key === LANGUAGE_SETTING_KEY &&
                            scope === 'workspace' &&
                            !workspaceSettingsWritable
                          ) {
                            // `/language ui --project` is refused in a
                            // standalone session, so a workspace row here
                            // could only fail after the user picked a value.
                            return null;
                          }

                          if (
                            item.setting.key === OUTPUT_LANGUAGE_SETTING_KEY &&
                            scope === 'workspace'
                          ) {
                            // The language command persists this at user
                            // scope only; showing it under the workspace tab
                            // would imply a workspace override that the write
                            // path cannot honor.
                            return null;
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
                )}
                {showModelManagement && modelManagementSectionProps && (
                  <div className={activeRows.length > 0 ? 'mt-4' : undefined}>
                    <ModelManagementSection {...modelManagementSectionProps} />
                  </div>
                )}
                {showConnections && connections}
                {showArchivedSessions && (
                  <div>
                    <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
                      <ArchiveIcon size={18} aria-hidden="true" />
                      {activeGroup.label}
                    </h2>
                    {archivedSessions}
                  </div>
                )}
                {showWorkspaceDirectories && workspaceDirectoriesSection}
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
