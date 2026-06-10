import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  useSettings,
  type DaemonSettingDescriptor,
} from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
import styles from './SettingsMessage.module.css';

export const SETTINGS_ACTIVE_EVENT = 'web-shell:settings-panel-active';

interface SettingsMessageProps {
  onClose: () => void;
  onSubDialog: (settingKey: string) => void;
}

const SUB_DIALOG_KEYS = new Set(['ui.theme', 'fastModel']);

type Scope = 'user' | 'workspace';

type Translator = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

function formatValue(
  setting: DaemonSettingDescriptor,
  scope: Scope,
  t: Translator,
): string {
  const effective = resolveValue(setting, scope);
  if (effective === undefined || effective === null) return '';
  if (setting.type === 'boolean')
    return effective === true
      ? t('settings.value.on')
      : t('settings.value.off');
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
  const val = scope === 'user' ? setting.values.user : setting.values.workspace;
  return val !== undefined;
}

function resolveValue(setting: DaemonSettingDescriptor, scope: Scope): unknown {
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

/* Wraps around at both ends (matching the native CLI) while skipping
   category-header rows. */
function nextSettingIdx(rows: FlatRow[], current: number, dir: 1 | -1): number {
  const n = rows.length;
  if (n === 0) return current;
  let i = current;
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n;
    if (rows[i]!.type === 'setting') return i;
  }
  return current;
}

export function SettingsMessage({
  onClose,
  onSubDialog,
}: SettingsMessageProps) {
  const { t } = useI18n();
  const { status, settings, loading, error, reload, setValue } = useSettings({
    autoLoad: true,
  });
  const [scope, setScope] = useState<Scope>('workspace');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<{
    key: string;
    draft: string;
  } | null>(null);
  const panelIdRef = useRef(`settings-${Math.random().toString(36).slice(2)}`);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedIdxRef = useRef(selectedIdx);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const rows = useMemo(
    () => flattenGroups(groupByCategory(settings)),
    [settings],
  );
  const [restartPending, setRestartPending] = useState(false);

  const selectedRow = rows[selectedIdx];
  const selectedDescription =
    selectedRow?.type === 'setting'
      ? selectedRow.setting?.description
      : undefined;

  // Marquee state for an overflowing description: distance to travel and a
  // duration that keeps the glide speed constant regardless of text length.
  const detailRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<{
    distance: number;
    duration: number;
  } | null>(null);

  useLayoutEffect(() => {
    const outer = detailRef.current;
    if (!outer) return undefined;
    const measure = () => {
      const distance = outer.scrollWidth - outer.clientWidth;
      const reduceMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      if (distance > 1 && !reduceMotion) {
        // ~80px/s glide; the keyframes hold at each end for 15% of the
        // timeline, so only 70% of it is travel time.
        setMarquee({ distance, duration: Math.max(3, distance / 80 / 0.7) });
      } else {
        setMarquee(null);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    return () => observer.disconnect();
  }, [selectedDescription]);

  const emitActive = useCallback((active: boolean) => {
    window.dispatchEvent(
      new CustomEvent(SETTINGS_ACTIVE_EVENT, {
        detail: { id: panelIdRef.current, active },
      }),
    );
  }, []);

  useEffect(() => {
    emitActive(true);
    return () => emitActive(false);
  }, [emitActive]);

  // Close when the user presses outside the panel. The panel is rendered
  // inline (no modal backdrop), so we listen on the document. The press that
  // opened the panel has already finished propagating by the time this effect
  // runs, so it cannot self-close. We cover touch as well so a tap outside
  // dismisses on touch devices, not only via Escape / a row click.
  useEffect(() => {
    const onPointerOutside = (event: Event) => {
      // Only the primary (left) mouse button dismisses. Middle-click on
      // Linux/X11 pastes, and right-click opens a context menu — neither should
      // close the panel out from under the user. (Touch events have no button.)
      if (event instanceof MouseEvent && event.button !== 0) return;
      // If another handler already consumed the press, leave the panel alone.
      if (event.defaultPrevented) return;
      const panel = panelRef.current;
      const target = event.target;
      if (panel && target instanceof Node && !panel.contains(target)) {
        onCloseRef.current();
      }
    };
    window.addEventListener('mousedown', onPointerOutside);
    window.addEventListener('touchstart', onPointerOutside);
    return () => {
      window.removeEventListener('mousedown', onPointerOutside);
      window.removeEventListener('touchstart', onPointerOutside);
    };
  }, []);

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
    if (rows.length === 0) return;
    if (selectedIdx >= rows.length) {
      setSelectedIdx(nextSettingIdx(rows, rows.length, -1));
    } else if (rows[selectedIdx]?.type !== 'setting') {
      setSelectedIdx(nextSettingIdx(rows, selectedIdx - 1, 1));
    }
  }, [selectedIdx, rows]);

  useEffect(() => {
    selectedIdxRef.current = selectedIdx;
  }, [selectedIdx]);

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

  const handleSetValue = useCallback(
    (key: string, value: unknown) => {
      if (!restartPending) setMessage(null);
      setBusyKey(key);
      setValue('workspace', key, value)
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
    [restartPending, setValue, t],
  );

  const handleAction = useCallback(
    (setting: DaemonSettingDescriptor) => {
      if (editMode && editMode.key === setting.key) return;
      setEditMode(null);
      if (scope !== 'workspace') {
        setMessage(t('settings.readOnly'));
        return;
      }
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
    [editMode, handleSetValue, onSubDialog, scope, t],
  );

  const handleEditSubmit = useCallback(() => {
    if (!editMode) return;
    const row = rows.find(
      (r) => r.type === 'setting' && r.setting?.key === editMode.key,
    );
    const setting = row?.setting;
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
  }, [editMode, rows, handleSetValue, t]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (editMode) {
        if (e.key === 'Escape') {
          claim();
          setEditMode(null);
          return;
        }
        if (e.key === 'Enter') {
          claim();
          handleEditSubmit();
          return;
        }
        return;
      }

      if (e.key === 'Escape') {
        claim();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        claim();
        setSelectedIdx((i) => nextSettingIdx(rows, i, 1));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        claim();
        setSelectedIdx((i) => nextSettingIdx(rows, i, -1));
        return;
      }
      if (e.key === 'Tab') {
        claim();
        setScope((s) => (s === 'workspace' ? 'user' : 'workspace'));
        return;
      }
      if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        claim();
        reload();
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && !busyKey) {
        claim();
        const row = rows[selectedIdxRef.current];
        if (row?.type === 'setting' && row.setting) {
          handleAction(row.setting);
        }
      }
    },
    [busyKey, editMode, handleAction, handleEditSubmit, onClose, reload, rows],
  );

  const scopeLabel =
    scope === 'workspace'
      ? t('settings.scope.workspace')
      : t('settings.scope.user');

  return (
    <div ref={panelRef} className={styles.panel} data-keyboard-scope>
      <div className={styles.header}>
        <span className={styles.title}>{t('settings.title')}</span>
        <span className={styles.secondary}>{scopeLabel}</span>
      </div>

      {(message || loading) && (
        <div className={styles.hint}>{message || t('settings.loading')}</div>
      )}

      <div
        className={styles.list}
        ref={listRef}
        role="listbox"
        aria-label={t('settings.title')}
      >
        {!loading && rows.length === 0 && (
          <div className={styles.empty}>{t('settings.empty')}</div>
        )}
        {rows.map((row, i) => {
          if (row.type === 'header') {
            return (
              <div
                key={`cat-${row.category}`}
                role="presentation"
                className={styles.category}
              >
                {row.category}
              </div>
            );
          }

          const setting = row.setting!;
          const isSelected = i === selectedIdx;
          const isEditing = editMode?.key === setting.key;
          const isSubDialog = SUB_DIALOG_KEYS.has(setting.key);
          const hasScopeValue = scopeHasValue(setting, scope);

          return (
            <div
              key={setting.key}
              role="option"
              aria-selected={isSelected}
              className={`${styles.item} ${isSelected ? styles.selected : ''}`}
              onClick={() => {
                if (busyKey) return;
                setSelectedIdx(i);
                handleAction(setting);
              }}
              // Hover feedback is pure CSS (.item:hover) and deliberately does
              // NOT move the selection: arrow keys own the pointer + accent
              // label, the mouse only adds a background highlight. This keeps
              // mouse and keyboard from fighting when the list scrolls under a
              // resting cursor.
            >
              <div className={styles.row}>
                <span className={styles.pointer}>{isSelected ? '›' : ' '}</span>
                <span className={styles.label}>{setting.label}</span>
                <span className={styles.value}>
                  {busyKey === setting.key
                    ? '...'
                    : `${formatValue(setting, scope, t)}${hasScopeValue ? '*' : ''}${setting.requiresRestart ? ' ⟳' : ''}${isSubDialog ? ' ▸' : ''}`}
                </span>
              </div>
              {isEditing && editMode && (
                <div className={styles.editWrap}>
                  <input
                    ref={inputRef}
                    className={styles.editInput}
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
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Always rendered (nbsp placeholder) and clamped to one line, so the
          panel height stays fixed while the cursor moves across settings
          with/without descriptions — mirrors the native CLI's single
          truncated description line. Descriptions that overflow glide
          horizontally (music-player marquee) so the full text is readable
          without adding lines. */}
      <div
        ref={detailRef}
        className={
          marquee ? styles.detail : `${styles.detail} ${styles.detailEllipsis}`
        }
        title={selectedDescription || undefined}
      >
        <span
          key={selectedIdx}
          className={
            marquee
              ? `${styles.detailText} ${styles.detailTextScrolling}`
              : styles.detailText
          }
          style={
            marquee
              ? ({
                  '--marquee-distance': `${marquee.distance}px`,
                  '--marquee-duration': `${marquee.duration}s`,
                } as CSSProperties)
              : undefined
          }
        >
          {selectedDescription || '\u00A0'}
        </span>
      </div>

      <div className={styles.footer}>
        {editMode ? t('settings.footer.edit') : t('settings.footer')}
      </div>
    </div>
  );
}
