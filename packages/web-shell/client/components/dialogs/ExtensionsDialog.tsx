import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useConnection,
  useWorkspaceActions,
  useWorkspaceEventSignals,
} from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonExtensionEntry,
  DaemonExtensionUpdateState,
} from '@qwen-code/sdk/daemon';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
import { dp } from './dialogStyles';

interface ExtensionsDialogProps {
  onClose: () => void;
}

type View = 'list' | 'actions' | 'details' | 'scope' | 'uninstall';
type Scope = 'user' | 'workspace';
type Mutation = 'enable' | 'disable';

interface ExtensionAction {
  label: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

const UPDATE_AVAILABLE: DaemonExtensionUpdateState = 'update available';

function statusLabel(
  extension: DaemonExtensionEntry,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return extension.isActive
    ? t('extensions.manage.status.enabled')
    : t('extensions.manage.status.disabled');
}

function updateLabel(
  state: DaemonExtensionUpdateState | undefined,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (state) {
    case 'update available':
      return t('extensions.manage.updateAvailable');
    case 'up to date':
      return t('extensions.manage.upToDate');
    case 'not updatable':
      return t('extensions.manage.notUpdatable');
    case 'checking for updates':
      return t('extensions.manage.checkingUpdates');
    case 'error':
      return t('extensions.manage.updateError');
    default:
      return t('extensions.manage.unknownUpdate');
  }
}

function joinList(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join(', ') : '-';
}

export function ExtensionsDialog({ onClose }: ExtensionsDialogProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const actions = useWorkspaceActions();
  const signals = useWorkspaceEventSignals();
  const [view, setView] = useState<View>('list');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [actionIdx, setActionIdx] = useState(0);
  const [scopeIdx, setScopeIdx] = useState(0);
  const [scopeMutation, setScopeMutation] = useState<Mutation>('disable');
  const [extensions, setExtensions] = useState<DaemonExtensionEntry[]>([]);
  const [updateStates, setUpdateStates] = useState<
    Record<string, DaemonExtensionUpdateState>
  >({});
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = extensions[selectedIdx];

  const load = useCallback(() => {
    setLoading(true);
    return actions
      .loadExtensionsStatus()
      .then((status) => {
        setExtensions(status.extensions ?? []);
        setMessage(status.errors?.[0]?.error ?? null);
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoading(false));
  }, [actions]);

  const checkUpdates = useCallback(() => {
    const clientId = connection.clientId;
    if (!clientId) {
      setMessage(t('extensions.install.waitForSession'));
      return Promise.resolve();
    }
    setChecking(true);
    return actions
      .checkExtensionUpdates(clientId)
      .then((result) => setUpdateStates(result.states))
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setChecking(false));
  }, [actions, connection.clientId, t]);

  const refreshSessions = useCallback(() => {
    const clientId = connection.clientId;
    if (!clientId) {
      setMessage(t('extensions.install.waitForSession'));
      return;
    }
    setChecking(true);
    actions
      .refreshExtensions(clientId)
      .then(async (result) => {
        setMessage(
          t('extensions.manage.refreshed', {
            refreshed: result.refreshed,
            failed: result.failed,
          }),
        );
        await load();
        await checkUpdates();
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setChecking(false));
  }, [actions, checkUpdates, connection.clientId, load, t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (extensions.length > 0) checkUpdates();
  }, [checkUpdates, extensions.length]);

  useEffect(() => {
    if ((signals?.extensionsVersion ?? 0) > 0) {
      setUpdateStates({});
      load();
    }
  }, [load, signals?.extensionsVersion]);

  useEffect(() => {
    if (selectedIdx >= extensions.length && extensions.length > 0) {
      setSelectedIdx(extensions.length - 1);
    }
  }, [extensions.length, selectedIdx]);

  useEffect(() => {
    const activeIndex =
      view === 'actions'
        ? actionIdx
        : view === 'scope'
          ? scopeIdx
          : selectedIdx;
    const el = listRef.current?.children[activeIndex] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [actionIdx, scopeIdx, selectedIdx, view]);

  const runMutation = useCallback(
    (run: (clientId: string) => Promise<unknown>, name: string) => {
      const clientId = connection.clientId;
      if (!clientId) {
        setMessage(t('extensions.install.waitForSession'));
        return;
      }
      setBusyName(name);
      setMessage(null);
      run(clientId)
        .then(() => setMessage(t('extensions.manage.queued', { name })))
        .catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setBusyName(null));
    },
    [connection.clientId, t],
  );

  const actionsForSelected: ExtensionAction[] = useMemo(() => {
    if (!selected) return [];
    const state = updateStates[selected.name] ?? selected.updateState;
    const items: ExtensionAction[] = [
      {
        label: t('extensions.manage.viewDetails'),
        run: () => setView('details'),
      },
    ];
    items.push({
      label: t('extensions.manage.update'),
      hint: updateLabel(state, t),
      disabled: state !== UPDATE_AVAILABLE || busyName === selected.name,
      run: () =>
        runMutation(
          (clientId) => actions.updateExtension(selected.name, clientId),
          selected.name,
        ),
    });
    items.push({
      label: selected.isActive
        ? t('extensions.manage.disable')
        : t('extensions.manage.enable'),
      disabled: busyName === selected.name,
      run: () => {
        setScopeMutation(selected.isActive ? 'disable' : 'enable');
        setScopeIdx(0);
        setView('scope');
      },
    });
    items.push({
      label: t('extensions.manage.uninstallAction'),
      disabled: busyName === selected.name,
      run: () => setView('uninstall'),
    });
    return items;
  }, [actions, busyName, runMutation, selected, t, updateStates]);

  useEffect(() => {
    if (actionIdx >= actionsForSelected.length && actionsForSelected.length > 0)
      setActionIdx(actionsForSelected.length - 1);
  }, [actionIdx, actionsForSelected.length]);

  const selectScope = useCallback(
    (scope: Scope) => {
      if (!selected) return;
      runMutation(
        (clientId) =>
          scopeMutation === 'enable'
            ? actions.enableExtension(selected.name, { scope }, clientId)
            : actions.disableExtension(selected.name, { scope }, clientId),
        selected.name,
      );
      setView('actions');
    },
    [actions, runMutation, scopeMutation, selected],
  );

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (view === 'list') onClose();
        else if (view === 'actions') setView('list');
        else if (view === 'details') setView('actions');
        else if (view === 'scope') setView('actions');
        else if (view === 'uninstall') setView('actions');
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        if (view === 'list')
          setSelectedIdx((i) =>
            Math.min(i + 1, Math.max(extensions.length - 1, 0)),
          );
        else if (view === 'actions')
          setActionIdx((i) =>
            Math.min(i + 1, Math.max(actionsForSelected.length - 1, 0)),
          );
        else if (view === 'scope') setScopeIdx((i) => Math.min(i + 1, 1));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        if (view === 'list') setSelectedIdx((i) => Math.max(i - 1, 0));
        else if (view === 'actions') setActionIdx((i) => Math.max(i - 1, 0));
        else if (view === 'scope') setScopeIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (view === 'list' && selected) {
          setView('actions');
          setActionIdx(0);
        } else if (view === 'actions') {
          const action = actionsForSelected[actionIdx];
          if (action && !action.disabled) action.run();
        } else if (view === 'scope') {
          selectScope(scopeIdx === 0 ? 'user' : 'workspace');
        } else if (view === 'uninstall' && selected) {
          runMutation(
            (clientId) => actions.uninstallExtension(selected.name, clientId),
            selected.name,
          );
          setView('list');
        }
        return;
      }
      if (e.key === 'r') {
        e.preventDefault();
        if (view === 'list') {
          refreshSessions();
        }
      }
    },
    [
      actionIdx,
      actions,
      actionsForSelected,
      checkUpdates,
      extensions.length,
      load,
      onClose,
      refreshSessions,
      runMutation,
      scopeIdx,
      selectScope,
      selected,
      view,
    ],
  );

  const title =
    view === 'list'
      ? t('extensions.manage.title')
      : view === 'details'
        ? t('extensions.manage.detailsTitle')
        : (selected?.name ?? t('extensions.manage.title'));
  const footer =
    view === 'list'
      ? t('extensions.manage.footer.list')
      : view === 'details'
        ? t('extensions.manage.footer.back')
        : view === 'uninstall'
          ? t('extensions.manage.footer.confirm')
          : t('extensions.manage.footer.select');

  return (
    <div className={dp('resume-picker')}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>{title}</span>
        {view === 'list' && (
          <span className={dp('resume-picker-count')}>
            {t('extensions.manage.count', { count: extensions.length })}
          </span>
        )}
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
          {message ||
            (loading
              ? t('extensions.manage.loading')
              : checking
                ? t('extensions.manage.checkingUpdates')
                : t('common.enterSelect'))}
        </span>
      </div>

      <div className={dp('resume-picker-sep')} />

      {view === 'list' && (
        <div className={dp('resume-picker-list')} ref={listRef}>
          {!loading && extensions.length === 0 && (
            <div className={dp('resume-picker-empty')}>
              {t('extensions.manage.empty')}
            </div>
          )}
          {extensions.map((extension, i) => {
            const state = updateStates[extension.name] ?? extension.updateState;
            return (
              <div
                key={extension.id || extension.name}
                className={dp(
                  'resume-picker-item',
                  i === selectedIdx ? 'selected' : undefined,
                )}
                onClick={() => {
                  setSelectedIdx(i);
                  setView('actions');
                  setActionIdx(0);
                }}
                onMouseEnter={() => setSelectedIdx(i)}
              >
                <div className={dp('resume-picker-item-row')}>
                  <span className={dp('resume-picker-item-prefix')}>
                    {i === selectedIdx ? '›' : ' '}
                  </span>
                  <span className={dp('resume-picker-item-title')}>
                    {extension.name}
                  </span>
                  <span className={dp('resume-picker-item-badge')}>
                    v{extension.version}
                  </span>
                  <span className={dp('resume-picker-item-badge')}>
                    {statusLabel(extension, t)}
                  </span>
                </div>
                <div className={dp('resume-picker-item-meta')}>
                  {updateLabel(state, t)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view === 'actions' && selected && (
        <div className={dp('resume-picker-list')} ref={listRef}>
          <div className={dp('dialog-detail')}>
            <div>
              {t('extensions.manage.version')} {selected.version}
            </div>
            <div>
              {t('extensions.manage.status')} {statusLabel(selected, t)}
            </div>
            <div>
              {t('extensions.manage.source')} {selected.source ?? '-'}
            </div>
          </div>
          {actionsForSelected.map((action, i) => (
            <div
              key={action.label}
              className={dp(
                'resume-picker-item',
                i === actionIdx ? 'selected' : undefined,
                action.disabled ? 'disabled' : undefined,
              )}
              onClick={() => {
                if (!action.disabled) action.run();
              }}
              onMouseEnter={() => setActionIdx(i)}
            >
              <span className={dp('resume-picker-item-prefix')}>
                {i === actionIdx ? '›' : ' '}
              </span>
              <span className={dp('resume-picker-item-title')}>
                {action.label}
              </span>
              {action.hint && (
                <span className={dp('resume-picker-item-badge')}>
                  {action.hint}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {view === 'details' && selected && (
        <ExtensionDetails extension={selected} />
      )}

      {view === 'scope' && selected && (
        <div className={dp('resume-picker-list')} ref={listRef}>
          {(['user', 'workspace'] as const).map((scope, i) => (
            <div
              key={scope}
              className={dp(
                'resume-picker-item',
                i === scopeIdx ? 'selected' : undefined,
              )}
              onClick={() => selectScope(scope)}
              onMouseEnter={() => setScopeIdx(i)}
            >
              <span className={dp('resume-picker-item-prefix')}>
                {i === scopeIdx ? '›' : ' '}
              </span>
              <span className={dp('resume-picker-item-title')}>
                {scope === 'user'
                  ? t('settings.scope.user')
                  : t('settings.scope.workspace')}
              </span>
            </div>
          ))}
        </div>
      )}

      {view === 'uninstall' && selected && (
        <div className={dp('dialog-detail')}>
          <div>
            {t('extensions.manage.uninstallConfirm', { name: selected.name })}
          </div>
          <button
            className={dp('dialog-danger-button')}
            disabled={busyName === selected.name}
            onClick={() => {
              runMutation(
                (clientId) =>
                  actions.uninstallExtension(selected.name, clientId),
                selected.name,
              );
              setView('list');
            }}
          >
            {t('extensions.manage.uninstallAction')}
          </button>
        </div>
      )}

      <div className={dp('resume-picker-sep')} />
      <div className={dp('resume-picker-footer')}>{footer}</div>
    </div>
  );
}

function ExtensionDetails({ extension }: { extension: DaemonExtensionEntry }) {
  const { t } = useI18n();
  const details = extension.details;
  return (
    <div className={dp('resume-picker-list')}>
      <div className={dp('resume-picker-detail-panel')}>
        <Detail label={t('extensions.manage.name')} value={extension.name} />
        <Detail
          label={t('extensions.manage.version')}
          value={extension.version}
        />
        <Detail
          label={t('extensions.manage.status')}
          value={statusLabel(extension, t)}
        />
        <Detail label={t('extensions.manage.path')} value={extension.path} />
        <Detail
          label={t('extensions.manage.source')}
          value={extension.source ?? '-'}
        />
        <Detail
          label={t('extensions.manage.commands')}
          value={joinList(details?.commands)}
        />
        <Detail
          label={t('extensions.manage.skills')}
          value={joinList(details?.skills)}
        />
        <Detail
          label={t('extensions.manage.agents')}
          value={joinList(details?.agents)}
        />
        <Detail
          label={t('extensions.manage.mcpServers')}
          value={joinList(details?.mcpServers)}
        />
        <Detail
          label={t('extensions.manage.contextFiles')}
          value={joinList(details?.contextFiles)}
        />
        <Detail
          label={t('extensions.manage.settings')}
          value={joinList(details?.settings)}
        />
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className={dp('resume-picker-detail-row')}>
      <span className={dp('resume-picker-detail-label')}>{label}</span>
      <span className={dp('resume-picker-detail-value')}>{value}</span>
    </div>
  );
}
