import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  webShellThemeToSettingValue,
  type WebShellTheme,
} from '../../themeContext';
import styles from './SettingsMessage.module.css';

type ChatWidthMode = '1000' | 'wide';

interface SettingsMessageProps {
  settingsState: SettingsMessageSettingsState;
  onLanguageChange: (language: WebShellLanguage) => void;
  onSubDialog: (settingKey: string) => void;
  onThemeChange: (theme: WebShellTheme) => void;
  chatWidthMode: ChatWidthMode;
  onChatWidthModeChange: (mode: ChatWidthMode) => void;
  embedded?: boolean;
}

export interface SettingsMessageSettingsState {
  status: DaemonWorkspaceSettingsStatus | undefined;
  settings: DaemonSettingDescriptor[];
  loading: boolean;
  error: Error | undefined;
  reload: () => Promise<DaemonWorkspaceSettingsStatus | undefined>;
  setValue: (
    scope: 'workspace',
    key: string,
    value: unknown,
  ) => Promise<DaemonSettingUpdateResult>;
}

const SUB_DIALOG_KEYS = new Set(['fastModel']);
const HIDDEN_SETTING_KEYS = new Set([
  'ui.hideTips',
  'ui.enableUserFeedback',
  'ui.compactMode',
  'ui.compactInline',
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
  return s.length > 24 ? s.slice(0, 21) + '...' : s;
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
  | { type: 'local'; localKey: 'chatWidth' };

interface SettingsPageCategory {
  id: string;
  label: string;
  items: SettingsPageItem[];
}

function groupByCategory(
  settings: DaemonSettingDescriptor[],
  t: Translator,
): CategoryGroup[] {
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
    category: formatSettingCategory(category, t),
    items,
  }));
}

export type FlatRow =
  | { type: 'header'; category: string }
  | { type: 'setting'; setting: DaemonSettingDescriptor }
  | { type: 'local'; localKey: 'chatWidth' };

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
  embedded = false,
}: SettingsMessageProps) {
  const { t } = useI18n();
  const { status, settings, loading, error, reload, setValue } = settingsState;
  const [scope, setScope] = useState<Scope>('workspace');
  const [activeCategory, setActiveCategory] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<{
    key: string;
    draft: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [restartPending, setRestartPending] = useState(false);

  const showInitialLoading = loading && !status;
  const themeSetting = settings.find((s) => s.key === THEME_SETTING_KEY);
  const themeValue = themeSettingToWebShellTheme(
    themeSetting?.values.effective,
  );
  const languageSetting = settings.find((s) => s.key === LANGUAGE_SETTING_KEY);
  const languageValue = languageSettingToWebShellLanguage(
    languageSetting?.values.effective,
  );

  const categories = useMemo(() => {
    const visibleSettings = settings.filter(
      (setting) => !HIDDEN_SETTING_KEYS.has(setting.key),
    );
    const groups: SettingsPageCategory[] = groupByCategory(
      visibleSettings,
      t,
    ).map((group) => ({
      id: group.category,
      label: group.category,
      items: group.items.map((setting) => ({
        type: 'setting' as const,
        setting,
      })),
    }));
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
        id: t('settings.category.UI'),
        label: t('settings.category.UI'),
        items: [localItem],
      });
    }
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
    else if (settings.length > 0 && !restartPending) setMessage(null);
  }, [error, settings, status, t, restartPending]);

  useEffect(() => {
    if (editMode) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [editMode]);

  const handleSetValue = useCallback(
    (key: string, value: unknown) => {
      if (!restartPending) setMessage(null);
      setBusyKey(key);
      setValue('workspace', key, value)
        .then(async (result) => {
          try {
            await reload();
          } catch {
            // reload failure is non-fatal — the value was already saved
          }
          if (result?.requiresRestart && key !== LANGUAGE_SETTING_KEY) {
            setRestartPending(true);
            setMessage(t('settings.requiresRestart'));
          }
        })
        .catch((err: unknown) => {
          setMessage(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusyKey(null));
    },
    [reload, restartPending, setValue, t],
  );

  const handleEditSubmit = useCallback(() => {
    if (!editMode) return;
    const setting = settings.find(
      (candidate) => candidate.key === editMode.key,
    );
    if (!setting) {
      setEditMode(null);
      return;
    }
    let parsed: unknown = editMode.draft;
    if (setting.type === 'number') {
      const trimmed = editMode.draft.trim();
      if (trimmed === '' || !Number.isFinite(Number(trimmed))) {
        setMessage(t('settings.invalidNumber'));
        return;
      }
      parsed = Number(trimmed);
    }
    setEditMode(null);
    handleSetValue(setting.key, parsed);
  }, [editMode, settings, handleSetValue, t]);

  const activeGroup =
    categories.find((category) => category.id === activeCategory) ??
    categories[0];

  const renderSelect = (
    value: string,
    onChange: (value: string) => void,
    options: Array<{ value: string; label: string }>,
    disabled = false,
  ) => (
    <select
      className={styles.select}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );

  const renderSettingControl = (setting: DaemonSettingDescriptor) => {
    const value = resolveValue(setting, scope);
    const isBusy = busyKey === setting.key;
    const isEditing = editMode?.key === setting.key;
    const readOnly = scope !== 'workspace';

    if (readOnly) {
      return (
        <button
          type="button"
          className={styles.actionButton}
          disabled
          title={t('settings.readOnly')}
        >
          {formatValue(setting, scope, t) || t('settings.readOnly')}
        </button>
      );
    }

    if (setting.key === THEME_SETTING_KEY) {
      return renderSelect(
        themeValue ?? WebShellThemeId.Dark,
        (next) => {
          const theme = next as WebShellTheme;
          onThemeChange(theme);
          handleSetValue(THEME_SETTING_KEY, webShellThemeToSettingValue(theme));
        },
        WEB_SHELL_THEMES.map((theme) => ({
          value: theme,
          label: t(`theme.${theme}`),
        })),
        isBusy,
      );
    }

    if (setting.key === LANGUAGE_SETTING_KEY) {
      return renderSelect(
        languageValue ?? 'zh-CN',
        (next) => onLanguageChange(next as WebShellLanguage),
        WEB_SHELL_LANGUAGES.map((language) => ({
          value: language,
          label: languageLabel(language),
        })),
        isBusy,
      );
    }

    if (SUB_DIALOG_KEYS.has(setting.key)) {
      return (
        <button
          type="button"
          className={styles.actionButton}
          onClick={() => onSubDialog(setting.key)}
        >
          {formatValue(setting, scope, t) || t('settings.action.edit')}
        </button>
      );
    }

    if (setting.type === 'boolean') {
      const checked = value === true;
      return (
        <button
          type="button"
          className={`${styles.switch} ${checked ? styles.switchOn : ''}`}
          disabled={isBusy}
          onClick={() => handleSetValue(setting.key, !checked)}
          aria-pressed={checked}
        >
          <span className={styles.switchKnob} />
        </button>
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
        isBusy,
      );
    }

    if (isEditing) {
      return (
        <div className={styles.editor}>
          <input
            ref={inputRef}
            className={styles.editInput}
            type={setting.type === 'number' ? 'number' : 'text'}
            value={editMode.draft}
            onChange={(event) =>
              setEditMode({ key: editMode.key, draft: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleEditSubmit();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setEditMode(null);
              }
            }}
          />
          <button
            type="button"
            className={styles.actionButton}
            onClick={handleEditSubmit}
          >
            {t('settings.action.save')}
          </button>
        </div>
      );
    }

    return (
      <button
        type="button"
        className={styles.actionButton}
        disabled={isBusy}
        onClick={() =>
          setEditMode({
            key: setting.key,
            draft: String(value ?? ''),
          })
        }
      >
        {formatValue(setting, scope, t) || t('settings.action.edit')}
      </button>
    );
  };

  return (
    <div
      className={`${styles.panel} ${embedded ? styles.embeddedPanel : ''}`}
      data-keyboard-scope
    >
      {!embedded && (
        <div className={styles.header}>
          <span className={styles.title}>{t('settings.title')}</span>
          <span className={styles.secondary}>
            {t('settings.scope.workspace')}
          </span>
        </div>
      )}

      {(message || showInitialLoading) && (
        <div className={styles.hint}>{message || t('settings.loading')}</div>
      )}

      <div className={styles.scopeTabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'workspace'}
          className={`${styles.scopeTab} ${
            scope === 'workspace' ? styles.scopeTabActive : ''
          }`}
          onClick={() => setScope('workspace')}
        >
          {t('settings.scope.workspace')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'user'}
          className={`${styles.scopeTab} ${
            scope === 'user' ? styles.scopeTabActive : ''
          }`}
          onClick={() => {
            setEditMode(null);
            setScope('user');
          }}
        >
          {t('settings.scope.user')}
        </button>
      </div>

      <div className={styles.settingsPage}>
        <nav className={styles.sidebar} aria-label={t('settings.title')}>
          {categories.map((category) => (
            <button
              key={category.id}
              type="button"
              className={`${styles.categoryButton} ${
                category.id === activeCategory
                  ? styles.categoryButtonActive
                  : ''
              }`}
              onClick={() => setActiveCategory(category.id)}
            >
              <span>{category.label}</span>
              <span className={styles.categoryCount}>
                {category.items.length}
              </span>
            </button>
          ))}
        </nav>

        <section className={styles.content}>
          {!loading && !activeGroup && (
            <div className={styles.empty}>{t('settings.empty')}</div>
          )}
          {activeGroup?.items.map((item) => {
            if (item.type === 'local') {
              return (
                <div className={styles.card} key={item.localKey}>
                  <div className={styles.cardBody}>
                    <div className={styles.cardTitle}>
                      {t('settings.label.ui.chatWidth')}
                    </div>
                    <div className={styles.cardDescription}>
                      {t('settings.description.ui.chatWidth')}
                    </div>
                  </div>
                  <div className={styles.cardControl}>
                    {renderSelect(
                      chatWidthMode,
                      (next) => onChatWidthModeChange(next as ChatWidthMode),
                      [
                        {
                          value: '1000',
                          label: t('settings.option.ui.chatWidth.1000'),
                        },
                        {
                          value: 'wide',
                          label: t('settings.option.ui.chatWidth.wide'),
                        },
                      ],
                    )}
                  </div>
                </div>
              );
            }

            const setting = item.setting;
            const description = formatSettingDescription(setting, t);
            const hintKey = scopeHintKey(setting, scope);
            const hasScopeValue = scopeHasValue(setting, scope);
            return (
              <div className={styles.card} key={setting.key}>
                <div className={styles.cardBody}>
                  <div className={styles.cardTitle}>
                    {formatSettingLabel(setting, t)}
                    {hasScopeValue && (
                      <span className={styles.scopeBadge}>
                        {scope === 'workspace'
                          ? t('settings.scope.workspace')
                          : t('settings.scope.user')}
                      </span>
                    )}
                  </div>
                  {description && (
                    <div className={styles.cardDescription}>{description}</div>
                  )}
                  {hintKey && (
                    <div className={styles.scopeHint}>
                      {t(hintKey, {
                        scope: t(
                          scope === 'workspace'
                            ? 'settings.scope.user'
                            : 'settings.scope.workspace',
                        ),
                      })}
                    </div>
                  )}
                </div>
                <div className={styles.cardControl}>
                  {busyKey === setting.key ? (
                    <span className={styles.busy}>...</span>
                  ) : (
                    renderSettingControl(setting)
                  )}
                </div>
              </div>
            );
          })}
        </section>
      </div>

      {!embedded && (
        <div className={styles.footer}>
          {editMode ? t('settings.footer.edit') : t('settings.footer')}
        </div>
      )}
    </div>
  );
}
