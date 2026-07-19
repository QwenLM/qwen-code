/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  EllipsisVerticalIcon,
  PlusIcon,
  QrCodeIcon,
  RadioTowerIcon,
} from 'lucide-react';
import {
  DaemonHttpError,
  type DaemonChannelInstanceSnapshot,
  type DaemonChannelRuntimeState,
} from '@qwen-code/sdk/daemon';
import { useChannels, useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import { extractErrorDetail } from '../../utils/errorDetail';
import { useI18n } from '../../i18n';
import styles from './ChannelsManagerPage.module.css';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../ui/empty';
import { Spinner } from '../ui/spinner';
import { Switch } from '../ui/switch';
import {
  ChannelEditorDialog,
  type ChannelEditorQrHandoff,
} from './ChannelEditorDialog';
import { ChannelQrAuthDialog } from './ChannelQrAuthDialog';

interface ChannelsManagerPageProps {
  onClose: () => void;
  initialFocusRef?: Ref<HTMLHeadingElement>;
}

type EditorIntent = { mode: 'add' } | { mode: 'edit'; name: string };
type FocusTarget = 'primary' | 'restart' | 'startup';
interface QrDialogTarget {
  name: string;
  type: string;
  identity: object;
}

const STATUS_KEYS: Record<DaemonChannelRuntimeState['state'], string> = {
  stopped: 'channels.status.stopped',
  starting: 'channels.status.starting',
  connected: 'channels.status.connected',
  partial: 'channels.status.partial',
  error: 'channels.status.error',
};

function badgeVariant(
  state: DaemonChannelRuntimeState['state'],
): 'secondary' | 'outline' | 'destructive' {
  if (state === 'error') return 'destructive';
  if (state === 'connected') return 'secondary';
  return 'outline';
}

function isChannelSettingsConflict(error: unknown): boolean {
  if (!(error instanceof DaemonHttpError) || error.status !== 409) return false;
  const body = error.body as { code?: unknown } | undefined;
  return body?.code === 'channel_settings_conflict';
}

export function ChannelsManagerPage({
  onClose,
  initialFocusRef,
}: ChannelsManagerPageProps) {
  const { t } = useI18n();
  const workspace = useWorkspace();
  const {
    catalog,
    snapshot,
    loading,
    error,
    reload,
    createOrUpdate,
    remove,
    setStartup,
    start,
    stop,
    restart,
    auth,
  } = useChannels({ autoLoad: true });
  const supportsManagement =
    workspace.capabilities?.features.includes('channel_management') === true;
  const hasBearerToken = Boolean(workspace.token);
  const canManage = supportsManagement && hasBearerToken;
  const supportsChannelAuth =
    workspace.capabilities?.features.includes('channel_auth') === true;
  const canAuthenticate = supportsChannelAuth && hasBearerToken;
  const workspaceIdentity = useMemo(
    () => ({ client: workspace.client, workspaceCwd: workspace.workspaceCwd }),
    [workspace.client, workspace.workspaceCwd],
  );
  const hasManageableTypes = catalog.some((entry) => entry.manageable);
  const instances = useMemo(
    () =>
      Object.values(snapshot?.instances ?? {}).sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    [snapshot?.instances],
  );
  const [busyName, setBusyName] = useState<string | null>(null);
  const [busyTarget, setBusyTarget] = useState<FocusTarget | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [revisionBlocked, setRevisionBlocked] = useState(false);
  const [deleteName, setDeleteName] = useState<string | null>(null);
  const [editorIntent, setEditorIntent] = useState<EditorIntent | null>(null);
  const [qrHandoff, setQrHandoff] = useState<QrDialogTarget | null>(null);
  const returnFocusRef = useRef<{ name: string; target: FocusTarget } | null>(
    null,
  );
  const actionRefs = useRef(new Map<string, HTMLButtonElement>());
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const editorReturnFocusRef = useRef<HTMLElement | null>(null);
  const moreActionRefs = useRef(new Map<string, HTMLButtonElement>());
  const restorePageFocusAfterDeleteRef = useRef(false);
  const blockedSnapshotRef = useRef(snapshot);

  const setActionRef = useCallback(
    (name: string, target: FocusTarget, element: HTMLButtonElement | null) => {
      const key = `${name}:${target}`;
      if (element) actionRefs.current.set(key, element);
      else actionRefs.current.delete(key);
    },
    [],
  );

  useEffect(() => {
    if (busyName || !returnFocusRef.current) return;
    const { name, target } = returnFocusRef.current;
    actionRefs.current.get(`${name}:${target}`)?.focus();
    returnFocusRef.current = null;
  }, [busyName, snapshot]);

  useEffect(() => {
    if (
      revisionBlocked &&
      snapshot &&
      snapshot !== blockedSnapshotRef.current
    ) {
      setRevisionBlocked(false);
    }
  }, [revisionBlocked, snapshot]);

  useEffect(() => {
    if (qrHandoff && qrHandoff.identity !== workspaceIdentity) {
      setQrHandoff(null);
    }
  }, [qrHandoff, workspaceIdentity]);

  const runAction = useCallback(
    async (
      name: string,
      target: FocusTarget | null,
      operation: () => Promise<unknown>,
      revisioned = false,
    ) => {
      if (!canManage || busyName) return false;
      returnFocusRef.current = target ? { name, target } : null;
      setBusyName(name);
      setBusyTarget(target);
      setActionErrors((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      try {
        await operation();
        return true;
      } catch (actionError) {
        const actionMessage = extractErrorDetail(actionError);
        setActionErrors((current) => ({ ...current, [name]: actionMessage }));
        if (revisioned && isChannelSettingsConflict(actionError)) {
          blockedSnapshotRef.current = snapshot;
          setRevisionBlocked(true);
          try {
            const refreshed = await reload();
            if (refreshed) {
              setRevisionBlocked(false);
            } else {
              setActionErrors((current) => ({
                ...current,
                [name]: t('channels.error.refreshUnavailable', {
                  error: actionMessage,
                }),
              }));
            }
          } catch (reloadError) {
            setActionErrors((current) => ({
              ...current,
              [name]: t('channels.error.refreshFailed', {
                error: actionMessage,
                refreshError: extractErrorDetail(reloadError),
              }),
            }));
          }
        }
        return false;
      } finally {
        setBusyName(null);
        setBusyTarget(null);
      }
    },
    [busyName, canManage, reload, snapshot, t],
  );

  const retryLoad = useCallback(async () => {
    const refreshed = await reload();
    if (refreshed) setRevisionBlocked(false);
  }, [reload]);

  const channelTypeLabel = useCallback(
    (channel: DaemonChannelInstanceSnapshot) => {
      const type =
        typeof channel.config.type === 'string'
          ? channel.config.type
          : t('channels.type.unknown');
      return catalog.find((entry) => entry.type === type)?.displayName ?? type;
    },
    [catalog, t],
  );

  const renderPrimaryActions = (channel: DaemonChannelInstanceSnapshot) => {
    const disabled = !canManage || busyName !== null;
    const state = channel.runtime.state;
    if (state === 'stopped') {
      return (
        <Button
          ref={(element) => setActionRef(channel.name, 'primary', element)}
          size="sm"
          disabled={disabled}
          aria-label={t('channels.action.startNamed', { name: channel.name })}
          onClick={() =>
            void runAction(channel.name, 'primary', () => start(channel.name))
          }
        >
          {busyName === channel.name && busyTarget === 'primary' ? (
            <Spinner />
          ) : null}
          {t('channels.action.start')}
        </Button>
      );
    }
    if (state === 'error') {
      return (
        <Button
          ref={(element) => setActionRef(channel.name, 'primary', element)}
          size="sm"
          disabled={disabled}
          aria-label={t('channels.action.retryNamed', { name: channel.name })}
          onClick={() =>
            void runAction(channel.name, 'primary', () => restart(channel.name))
          }
        >
          {busyName === channel.name && busyTarget === 'primary' ? (
            <Spinner />
          ) : null}
          {t('channels.action.retry')}
        </Button>
      );
    }
    return (
      <>
        {state === 'starting' ||
        state === 'connected' ||
        state === 'partial' ? (
          <Button
            ref={(element) => setActionRef(channel.name, 'primary', element)}
            size="sm"
            variant="outline"
            disabled={disabled}
            aria-label={t('channels.action.stopNamed', { name: channel.name })}
            onClick={() =>
              void runAction(channel.name, 'primary', () => stop(channel.name))
            }
          >
            {busyName === channel.name && busyTarget === 'primary' ? (
              <Spinner />
            ) : null}
            {t('channels.action.stop')}
          </Button>
        ) : null}
        <Button
          ref={(element) => setActionRef(channel.name, 'restart', element)}
          size="sm"
          disabled={disabled}
          aria-label={t('channels.action.restartNamed', {
            name: channel.name,
          })}
          onClick={() =>
            void runAction(channel.name, 'restart', () => restart(channel.name))
          }
        >
          {busyName === channel.name && busyTarget === 'restart' ? (
            <Spinner />
          ) : null}
          {t('channels.action.restart')}
        </Button>
      </>
    );
  };

  return (
    <div className="flex w-full flex-col gap-6 pb-8">
      <div className={styles.pageHeader}>
        <div className="flex min-w-0 items-start gap-2">
          <Button
            ref={closeButtonRef}
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t('channels.action.back')}
          >
            <ArrowLeftIcon />
          </Button>
          <div className="min-w-0">
            <h1
              ref={initialFocusRef}
              tabIndex={-1}
              className="text-2xl font-semibold outline-none"
            >
              {t('channels.title')}
            </h1>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {t('channels.summary', {
                workspace: workspace.workspaceCwd
                  ? (workspace.workspaceCwd
                      .split(/[\\/]+/)
                      .filter(Boolean)
                      .at(-1) ?? workspace.workspaceCwd)
                  : t('channels.workspace.current'),
                count: instances.length,
              })}
            </p>
          </div>
        </div>
        <Button
          ref={addButtonRef}
          className={styles.addButton}
          disabled={
            !canManage ||
            !hasManageableTypes ||
            busyName !== null ||
            revisionBlocked
          }
          onClick={(event) => {
            editorReturnFocusRef.current = event.currentTarget;
            setQrHandoff(null);
            setEditorIntent({ mode: 'add' });
          }}
        >
          <PlusIcon data-icon="inline-start" />
          {t('channels.action.add')}
        </Button>
      </div>

      {!supportsManagement ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>{t('channels.unsupported.title')}</AlertTitle>
          <AlertDescription>
            {t('channels.unsupported.description')}
          </AlertDescription>
        </Alert>
      ) : null}

      {supportsManagement && !hasBearerToken ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>{t('channels.readOnly.title')}</AlertTitle>
          <AlertDescription>
            {t('channels.readOnly.description')}
          </AlertDescription>
        </Alert>
      ) : null}

      {revisionBlocked ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{t('channels.stale.title')}</AlertTitle>
          <AlertDescription>{t('channels.stale.description')}</AlertDescription>
        </Alert>
      ) : null}

      {qrHandoff ? (
        !canAuthenticate ? (
          <Alert>
            <QrCodeIcon />
            <AlertTitle>{t('channels.authUnavailable.title')}</AlertTitle>
            <AlertDescription>
              {supportsChannelAuth
                ? t('channels.authUnavailable.token')
                : t('channels.authUnavailable.capability')}
              <Button
                className="ml-2"
                variant="link"
                size="xs"
                onClick={() => setQrHandoff(null)}
              >
                {t('channels.action.dismiss')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null
      ) : null}

      {loading && instances.length === 0 ? (
        <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t('channels.loading')}
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{t('channels.loadError.title')}</AlertTitle>
          <AlertDescription>{extractErrorDetail(error)}</AlertDescription>
          <Button
            className="mt-2 w-fit"
            variant="outline"
            size="sm"
            aria-label={t('channels.loadError.retryLabel')}
            onClick={() => void retryLoad()}
          >
            {t('channels.action.retry')}
          </Button>
        </Alert>
      ) : null}

      {!loading && !error && instances.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RadioTowerIcon />
            </EmptyMedia>
            <EmptyTitle>{t('channels.empty.title')}</EmptyTitle>
            <EmptyDescription>
              {t('channels.empty.description')}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {instances.length > 0 ? (
        <div className={styles.channelGrid}>
          {instances.map((channel) => {
            const state = channel.runtime.state;
            const disabled = !canManage || busyName !== null;
            const configuredType =
              typeof channel.config.type === 'string'
                ? channel.config.type
                : '';
            const configManageable = catalog.some(
              (entry) =>
                entry.type === configuredType && entry.manageable === true,
            );
            const authDescriptor = catalog.find(
              (entry) => entry.type === configuredType,
            );
            const supportsQr = authDescriptor?.auth.includes('qr') === true;
            return (
              <Card
                key={channel.name}
                size="sm"
                className={styles.channelCard}
                data-runtime-state={state}
              >
                <CardHeader>
                  <CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate">{channel.name}</span>
                    <Badge variant={badgeVariant(state)}>
                      {t(STATUS_KEYS[state])}
                    </Badge>
                    {channel.startsWithServe ? (
                      <Badge variant="outline">
                        {t('channels.startsWithServe')}
                      </Badge>
                    ) : null}
                  </CardTitle>
                  <CardDescription>{channelTypeLabel(channel)}</CardDescription>
                  <CardAction>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          ref={(element) => {
                            if (element)
                              moreActionRefs.current.set(channel.name, element);
                            else moreActionRefs.current.delete(channel.name);
                          }}
                          variant="ghost"
                          size="icon-sm"
                          disabled={disabled || revisionBlocked}
                          aria-label={t('channels.action.moreNamed', {
                            name: channel.name,
                          })}
                        >
                          <EllipsisVerticalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            disabled={!configManageable}
                            onSelect={() => {
                              if (!configManageable) return;
                              editorReturnFocusRef.current =
                                moreActionRefs.current.get(channel.name) ??
                                addButtonRef.current;
                              setQrHandoff(null);
                              setEditorIntent({
                                mode: 'edit',
                                name: channel.name,
                              });
                            }}
                          >
                            {configManageable
                              ? t('channels.action.editNamed', {
                                  name: channel.name,
                                })
                              : t('channels.configurationReadOnly')}
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setDeleteName(channel.name)}
                        >
                          {t('channels.action.deleteNamed', {
                            name: channel.name,
                          })}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {channel.runtime.lastError ? (
                    <Alert variant="destructive" className={styles.errorAlert}>
                      <AlertCircleIcon />
                      <AlertTitle>{t('channels.runtimeError')}</AlertTitle>
                      <AlertDescription>
                        {channel.runtime.lastError}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {actionErrors[channel.name] ? (
                    <Alert variant="destructive" className={styles.errorAlert}>
                      <AlertCircleIcon />
                      <AlertTitle>{t('channels.actionError')}</AlertTitle>
                      <AlertDescription>
                        {actionErrors[channel.name]}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                    <label className="flex items-center gap-2 text-sm">
                      <span
                        className="contents"
                        ref={(element) =>
                          setActionRef(
                            channel.name,
                            'startup',
                            element?.querySelector('button') ?? null,
                          )
                        }
                      >
                        <Switch
                          size="sm"
                          checked={channel.startsWithServe}
                          disabled={disabled || revisionBlocked}
                          aria-label={t('channels.action.startWithServeNamed', {
                            name: channel.name,
                          })}
                          onCheckedChange={(enabled) =>
                            void runAction(
                              channel.name,
                              'startup',
                              () =>
                                setStartup(channel.name, {
                                  expectedRevision: snapshot?.revision ?? '',
                                  enabled,
                                }),
                              true,
                            )
                          }
                        />
                      </span>
                      {t('channels.action.startWithServe')}
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      {canAuthenticate && supportsQr ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyName !== null}
                          aria-label={t('channels.action.authenticateNamed', {
                            name: channel.name,
                          })}
                          onClick={() =>
                            setQrHandoff({
                              name: channel.name,
                              type: configuredType,
                              identity: workspaceIdentity,
                            })
                          }
                        >
                          <QrCodeIcon />
                          {t('channels.action.authenticate')}
                        </Button>
                      ) : null}
                      {renderPrimaryActions(channel)}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : null}

      {editorIntent && snapshot ? (
        <ChannelEditorDialog
          open
          catalog={catalog}
          expectedRevision={snapshot.revision}
          instance={
            editorIntent.mode === 'edit'
              ? snapshot.instances[editorIntent.name]
              : undefined
          }
          error={
            actionErrors[
              editorIntent.mode === 'edit' ? editorIntent.name : '__create__'
            ]
          }
          returnFocusRef={editorReturnFocusRef}
          onOpenChange={(open) => {
            if (!open) setEditorIntent(null);
          }}
          onQrHandoff={(handoff: ChannelEditorQrHandoff) =>
            setQrHandoff({
              name: handoff.name,
              type: handoff.type,
              identity: workspaceIdentity,
            })
          }
          onSubmit={(name, request) =>
            runAction(
              editorIntent.mode === 'edit' ? name : '__create__',
              null,
              () => createOrUpdate(name, request),
              true,
            )
          }
        />
      ) : null}

      {qrHandoff &&
      canAuthenticate &&
      qrHandoff.identity === workspaceIdentity ? (
        <ChannelQrAuthDialog
          open
          identity={qrHandoff.identity}
          name={qrHandoff.name}
          channelType={qrHandoff.type}
          channelDisplayName={
            catalog.find((entry) => entry.type === qrHandoff.type)
              ?.displayName ?? qrHandoff.type
          }
          actions={auth}
          onOpenChange={(open) => {
            if (!open) setQrHandoff(null);
          }}
        />
      ) : null}

      <AlertDialog
        open={deleteName !== null}
        onOpenChange={(open) => {
          if (!open && busyName === null) setDeleteName(null);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            if (restorePageFocusAfterDeleteRef.current) {
              event.preventDefault();
              const addButton = addButtonRef.current;
              if (addButton && !addButton.disabled) addButton.focus();
              else closeButtonRef.current?.focus();
              restorePageFocusAfterDeleteRef.current = false;
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t('channels.delete.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteName
                ? t('channels.delete.descriptionNamed', { name: deleteName })
                : t('channels.delete.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteName && actionErrors[deleteName] ? (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{actionErrors[deleteName]}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyName !== null}>
              {t('channels.action.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={
                !deleteName ||
                !canManage ||
                busyName !== null ||
                revisionBlocked
              }
              aria-label={t('channels.action.delete')}
              onClick={(event) => {
                if (!deleteName) return;
                event.preventDefault();
                const name = deleteName;
                void runAction(
                  name,
                  null,
                  () =>
                    remove(name, {
                      expectedRevision: snapshot?.revision ?? '',
                    }),
                  true,
                ).then((removed) => {
                  if (removed) {
                    restorePageFocusAfterDeleteRef.current = true;
                    setDeleteName(null);
                  }
                });
              }}
            >
              {busyName === deleteName ? <Spinner /> : null}
              {t('channels.action.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
