import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useConnection,
  useWorkspaceActions,
  useWorkspaceEventSignals,
} from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonExtensionEntry,
  DaemonExtensionUpdateState,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { trimDialogLabel } from '../../utils/dialogLabels';
import { dp } from './dialogStyles';

type Scope = 'user' | 'workspace';
type Mutation = 'enable' | 'disable';

const UPDATE_AVAILABLE: DaemonExtensionUpdateState = 'update available';

function extensionTitle(extension: DaemonExtensionEntry): string {
  return extension.displayName || extension.name;
}

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

const cleanLabel = trimDialogLabel;

export function ExtensionsDialog() {
  const { t } = useI18n();
  const connection = useConnection();
  const actions = useWorkspaceActions();
  const signals = useWorkspaceEventSignals();
  const [extensions, setExtensions] = useState<DaemonExtensionEntry[]>([]);
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const [confirmUninstallName, setConfirmUninstallName] = useState<
    string | null
  >(null);
  const [updateStates, setUpdateStates] = useState<
    Record<string, DaemonExtensionUpdateState>
  >({});
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    return actions
      .loadExtensionsStatus()
      .then((status) => {
        const nextExtensions = status.extensions ?? [];
        setExtensions(nextExtensions);
        setMessage(status.errors?.[0]?.error ?? null);
        setExpandedName((name) =>
          name && nextExtensions.some((extension) => extension.name === name)
            ? name
            : null,
        );
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

  const runMutation = useCallback(
    (name: string, run: (clientId: string) => Promise<unknown>) => {
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

  const summary = useMemo(() => {
    if (loading) return t('extensions.manage.loading');
    if (checking) return t('extensions.manage.checkingUpdates');
    return t('extensions.manage.count', { count: extensions.length });
  }, [checking, extensions.length, loading, t]);

  return (
    <div className={dp('resume-picker', 'resume-picker-in-shell')}>
      <div className={dp('resume-picker-search', 'extensions-toolbar')}>
        <span className={dp('resume-picker-search-hint')}>
          {message || summary}
        </span>
        <button
          type="button"
          className={dp('dialog-inline-button')}
          disabled={loading || checking}
          onClick={refreshSessions}
        >
          {t('common.refresh')}
        </button>
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-list')}>
        {!loading && extensions.length === 0 && (
          <div className={dp('resume-picker-empty')}>
            {t('extensions.manage.empty')}
          </div>
        )}
        {extensions.map((extension) => {
          const state = updateStates[extension.name] ?? extension.updateState;
          const expanded = expandedName === extension.name;
          const busy = busyName === extension.name;
          return (
            <div
              key={extension.id || extension.name}
              className={dp(
                'resume-picker-item',
                'resume-picker-session-item',
                'tools-picker-item',
                expanded ? 'selected' : undefined,
                expanded ? 'tools-picker-item-expanded' : undefined,
              )}
            >
              <button
                type="button"
                className={dp('extensions-row-button')}
                onClick={() => {
                  setExpandedName(expanded ? null : extension.name);
                  setConfirmUninstallName(null);
                }}
              >
                <span className={dp('tools-item-icon')} aria-hidden="true" />
                <span className={dp('resume-picker-item-title')}>
                  {extensionTitle(extension)}
                </span>
                <span className={dp('resume-picker-item-badge')}>
                  v{extension.version}
                </span>
                <span
                  className={dp(
                    'tools-status-badge',
                    extension.isActive
                      ? 'tools-status-badge-enabled'
                      : 'tools-status-badge-disabled',
                  )}
                >
                  {statusLabel(extension, t)}
                </span>
                <span
                  className={dp(
                    'tools-status-badge',
                    state === UPDATE_AVAILABLE
                      ? 'tools-status-badge-busy'
                      : undefined,
                  )}
                >
                  {updateLabel(state, t)}
                </span>
                <svg
                  className={dp(
                    'tools-item-chevron',
                    expanded ? 'tools-item-chevron-expanded' : undefined,
                  )}
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path
                    d="M6 4.5 9.5 8 6 11.5"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              {expanded && (
                <ExtensionDetail
                  extension={extension}
                  updateState={state}
                  busy={busy}
                  confirmingUninstall={confirmUninstallName === extension.name}
                  onUpdate={() =>
                    runMutation(extension.name, (clientId) =>
                      actions.updateExtension(extension.name, clientId),
                    )
                  }
                  onToggleScope={(mutation, scope) =>
                    runMutation(extension.name, (clientId) =>
                      mutation === 'enable'
                        ? actions.enableExtension(
                            extension.name,
                            { scope },
                            clientId,
                          )
                        : actions.disableExtension(
                            extension.name,
                            { scope },
                            clientId,
                          ),
                    )
                  }
                  onRequestUninstall={() =>
                    setConfirmUninstallName(extension.name)
                  }
                  onCancelUninstall={() => setConfirmUninstallName(null)}
                  onConfirmUninstall={() => {
                    runMutation(extension.name, (clientId) =>
                      actions.uninstallExtension(extension.name, clientId),
                    );
                    setConfirmUninstallName(null);
                    setExpandedName(null);
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExtensionDetail({
  extension,
  updateState,
  busy,
  confirmingUninstall,
  onUpdate,
  onToggleScope,
  onRequestUninstall,
  onCancelUninstall,
  onConfirmUninstall,
}: {
  extension: DaemonExtensionEntry;
  updateState: DaemonExtensionUpdateState | undefined;
  busy: boolean;
  confirmingUninstall: boolean;
  onUpdate: () => void;
  onToggleScope: (mutation: Mutation, scope: Scope) => void;
  onRequestUninstall: () => void;
  onCancelUninstall: () => void;
  onConfirmUninstall: () => void;
}) {
  const { t } = useI18n();
  const details = extension.details;
  const mutation: Mutation = extension.isActive ? 'disable' : 'enable';
  return (
    <div className={dp('extensions-detail')}>
      <div className={dp('extensions-detail-actions')}>
        <button
          type="button"
          className={dp('dialog-inline-button')}
          disabled={busy || updateState !== UPDATE_AVAILABLE}
          onClick={onUpdate}
        >
          {t('extensions.manage.update')}
        </button>
        <button
          type="button"
          className={dp('dialog-inline-button')}
          disabled={busy}
          onClick={() => onToggleScope(mutation, 'user')}
        >
          {mutation === 'enable'
            ? t('extensions.manage.enable')
            : t('extensions.manage.disable')}
          · {t('settings.scope.user')}
        </button>
        <button
          type="button"
          className={dp('dialog-inline-button')}
          disabled={busy}
          onClick={() => onToggleScope(mutation, 'workspace')}
        >
          {mutation === 'enable'
            ? t('extensions.manage.enable')
            : t('extensions.manage.disable')}
          · {t('settings.scope.workspace')}
        </button>
        <button
          type="button"
          className={dp('dialog-danger-button')}
          disabled={busy}
          onClick={onRequestUninstall}
        >
          {t('extensions.manage.uninstallAction')}
        </button>
      </div>

      {confirmingUninstall && (
        <div className={dp('extensions-confirm')}>
          <span>
            {t('extensions.manage.uninstallConfirm', { name: extension.name })}
          </span>
          <div className={dp('dialog-inline-actions')}>
            <button
              type="button"
              className={dp('dialog-danger-button')}
              disabled={busy}
              onClick={onConfirmUninstall}
            >
              {t('extensions.manage.uninstallAction')}
            </button>
            <button
              type="button"
              className={dp('dialog-inline-button')}
              onClick={onCancelUninstall}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className={dp('extensions-detail-grid')}>
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
    <div className={dp('extensions-detail-field')}>
      <span className={dp('extensions-detail-label')}>{cleanLabel(label)}</span>
      <span className={dp('extensions-detail-value')}>{value}</span>
    </div>
  );
}
