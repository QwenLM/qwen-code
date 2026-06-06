import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import {
  useSettings,
  type DaemonSettingDescriptor,
} from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';

interface SettingsDialogProps {
  onClose: () => void;
  onSubDialog: (settingKey: string) => void;
}

const SUB_DIALOG_KEYS = new Set([
  'ui.theme',
  'fastModel',
  'tools.approvalMode',
]);

type Scope = 'user' | 'workspace';

type Translator = (key: string, vars?: Record<string, string | number>) => string;

function formatValue(
  setting: DaemonSettingDescriptor,
  scope: Scope,
  t: Translator,
): string {
  const val =
    scope === 'user' ? setting.values.user : setting.values.workspace;
  const effective = val !== undefined ? val : setting.values.effective;
  if (effective === undefined || effective === null) return '';
  if (setting.type === 'boolean')
    return effective === true ? t('settings.value.on') : t('settings.value.off');
  if (setting.type === 'enum' && setting.options) {
    const opt = setting.options.find((o) => o.value === effective);
    return opt?.label ?? String(effective);
  }
  const s = String(effective);
  return s.length > 24 ? s.slice(0, 21) + '...' : s;
}

function scopeHasValue(
  setting: DaemonSettingDescriptor,
  scope: Scope,
): boolean {
  const val =
    scope === 'user' ? setting.values.user : setting.values.workspace;
  return val !== undefined;
}

function otherScopeKey(
  setting: DaemonSettingDescriptor,
  scope: Scope,
): string | undefined {
  if (scope === 'workspace' && setting.values.user !== undefined)
    return 'settings.scope.user';
  if (scope === 'user' && setting.values.workspace !== undefined)
    return 'settings.scope.workspace';
  return undefined;
}

function resolveValue(
  setting: DaemonSettingDescriptor,
  scope: Scope,
): unknown {
  const scopeVal =
    scope === 'user' ? setting.values.user : setting.values.workspace;
  return scopeVal !== undefined ? scopeVal : setting.values.effective;
}

function nextBooleanValue(
  setting: DaemonSettingDescriptor,
  scope: Scope,
): boolean {
  return resolveValue(setting, scope) !== true;
}

function nextEnumValue(
  setting: DaemonSettingDescriptor,
  scope: Scope,
): unknown {
  if (!setting.options?.length) return resolveValue(setting, scope);
  const current = resolveValue(setting, scope);
  const currentIdx = setting.options.findIndex((o) => o.value === current);
  const nextIdx = (currentIdx + 1) % setting.options.length;
  return setting.options[nextIdx]!.value;
}

interface CategoryGroup {
  category: string;
  items: DaemonSettingDescriptor[];
}

function groupByCategory(
  settings: DaemonSettingDescriptor[],
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
    category,
    items,
  }));
}

interface FlatRow {
  type: 'header' | 'setting';
  category?: string;
  setting?: DaemonSettingDescriptor;
}

function flattenGroups(groups: CategoryGroup[]): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const g of groups) {
    rows.push({ type: 'header', category: g.category });
    for (const s of g.items) {
      rows.push({ type: 'setting', setting: s });
    }
  }
  return rows;
}

function nextSettingIdx(rows: FlatRow[], current: number, dir: 1 | -1): number {
  let i = current + dir;
  while (i >= 0 && i < rows.length) {
    if (rows[i]!.type === 'setting') return i;
    i += dir;
  }
  return current;
}

export function SettingsDialog({
  onClose,
  onSubDialog,
}: SettingsDialogProps) {
  const { t } = useI18n();
  const { status, settings, loading, error, reload, setValue } = useSettings({
    autoLoad: true,
  });
  const [scope, setScope] = useState<Scope>('workspace');
  const [selectedIdx, setSelectedIdx] = useState(1);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<{
    key: string;
    draft: string;
  } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => groupByCategory(settings), [settings]);
  const rows = useMemo(() => flattenGroups(groups), [groups]);

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
    if (selectedIdx >= rows.length && rows.length > 0) {
      setSelectedIdx(Math.max(rows.length - 1, 0));
    }
  }, [selectedIdx, rows.length]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  useEffect(() => {
    if (editMode) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [editMode]);

  const [restartPending, setRestartPending] = useState(false);

  const handleSetValue = useCallback(
    (key: string, value: unknown) => {
      setMessage(null);
      setBusyKey(key);
      setValue(scope, key, value)
        .then((result) => {
          if (result?.requiresRestart) {
            setRestartPending(true);
            setMessage(t('settings.requiresRestart'));
          }
        })
        .catch((err: unknown) => {
          setMessage(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusyKey(null));
    },
    [scope, setValue, t],
  );

  const handleAction = useCallback(
    (setting: DaemonSettingDescriptor) => {
      if (SUB_DIALOG_KEYS.has(setting.key)) {
        onSubDialog(setting.key);
        return;
      }
      if (setting.type === 'boolean') {
        handleSetValue(setting.key, nextBooleanValue(setting, scope));
        return;
      }
      if (setting.type === 'enum') {
        handleSetValue(setting.key, nextEnumValue(setting, scope));
        return;
      }
      if (setting.type === 'string' || setting.type === 'number') {
        setEditMode({
          key: setting.key,
          draft: String(resolveValue(setting, scope) ?? ''),
        });
      }
    },
    [handleSetValue, onSubDialog, scope],
  );

  const handleEditSubmit = useCallback(() => {
    if (!editMode) return;
    const row = rows.find(
      (r) => r.type === 'setting' && r.setting?.key === editMode.key,
    );
    const setting = row?.setting;
    if (!setting) return;
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
  }, [editMode, rows, handleSetValue, t]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (editMode) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setEditMode(null);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          handleEditSubmit();
          return;
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => nextSettingIdx(rows, i, 1));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((i) => nextSettingIdx(rows, i, -1));
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        setScope((s) => (s === 'workspace' ? 'user' : 'workspace'));
        return;
      }
      if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        reload();
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && !busyKey) {
        e.preventDefault();
        const row = rows[selectedIdx];
        if (row?.type === 'setting' && row.setting) {
          handleAction(row.setting);
        }
      }
    },
    [
      busyKey,
      editMode,
      handleAction,
      handleEditSubmit,
      onClose,
      reload,
      rows,
      selectedIdx,
    ],
  );

  const scopeLabel =
    scope === 'workspace'
      ? t('settings.scope.workspace')
      : t('settings.scope.user');

  return (
    <div className={dp('resume-picker')}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>
          {t('settings.title')}
        </span>
        <span className={dp('resume-picker-count')}>{scopeLabel}</span>
        <button
          className={dp('resume-picker-close')}
          onClick={onClose}
          title={t('common.close')}
        >
          ESC
        </button>
      </div>

      <div className={dp('resume-picker-search')}>
        <span className={dp('resume-picker-search-hint')}>
          {message || (loading ? t('settings.loading') : '')}
        </span>
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-list')} ref={listRef}>
        {!loading && rows.length === 0 && (
          <div className={dp('resume-picker-empty')}>
            {t('settings.empty')}
          </div>
        )}
        {rows.map((row, i) => {
          if (row.type === 'header') {
            return (
              <div
                key={`cat-${row.category}`}
                className={dp('resume-picker-item', 'disabled')}
              >
                <div className={dp('resume-picker-item-row')}>
                  <span className={dp('resume-picker-item-prefix')}>
                    {' '}
                  </span>
                  <span className={dp('resume-picker-item-title')}>
                    {row.category}
                  </span>
                </div>
              </div>
            );
          }

          const setting = row.setting!;
          const isSelected = i === selectedIdx;
          const isEditing = editMode?.key === setting.key;
          const isSubDialog = SUB_DIALOG_KEYS.has(setting.key);
          const hasScopeValue = scopeHasValue(setting, scope);
          const otherScope = otherScopeKey(setting, scope);

          return (
            <div
              key={setting.key}
              className={dp(
                'resume-picker-item',
                isSelected ? 'selected' : undefined,
              )}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => {
                setSelectedIdx(i);
                handleAction(setting);
              }}
            >
              <div className={dp('resume-picker-item-row')}>
                <span className={dp('resume-picker-item-prefix')}>
                  {isSelected ? '›' : ' '}
                </span>
                <span className={dp('resume-picker-item-title')}>
                  {setting.label}
                </span>
                <span className={dp('resume-picker-item-badge')}>
                  {busyKey === setting.key
                    ? '...'
                    : `${formatValue(setting, scope, t)}${hasScopeValue ? '*' : ''}${setting.requiresRestart ? ' ⟳' : ''}${isSubDialog ? ' ▸' : ''}`}
                </span>
              </div>
              {otherScope && (
                <div className={dp('resume-picker-item-meta')}>
                  {t('settings.modifiedIn', { scope: t(otherScope) })}
                </div>
              )}
              {isEditing && editMode && (
                <div style={{ padding: '4px 20px 4px 28px' }}>
                  <input
                    ref={inputRef}
                    type={setting.type === 'number' ? 'number' : 'text'}
                    value={editMode.draft}
                    onChange={(e) =>
                      setEditMode({ key: editMode.key, draft: e.target.value })
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleEditSubmit();
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditMode(null);
                      }
                    }}
                    style={{
                      width: '100%',
                      padding: '4px 8px',
                      fontSize: '12px',
                      fontFamily: 'inherit',
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border-primary)',
                      borderRadius: '4px',
                      outline: 'none',
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-footer')}>
        {editMode
          ? t('settings.footer.edit')
          : t('settings.footer')}
      </div>
    </div>
  );
}
