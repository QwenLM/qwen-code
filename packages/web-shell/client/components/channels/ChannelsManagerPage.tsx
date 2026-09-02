/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState, type Ref } from 'react';
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  PencilIcon,
  RadioTowerIcon,
  RotateCwIcon,
  Trash2Icon,
} from 'lucide-react';
import type {
  DaemonChannelInstanceSnapshot,
  DaemonChannelRuntimeState,
  DaemonChannelTypeDescriptor,
  DaemonChannelUpsertRequest,
} from '@qwen-code/sdk/daemon';
import { useChannels, useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import {
  AlertDialog,
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
  CardFooter,
  CardHeader,
  CardTitle,
} from '../ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../ui/empty';
import { Spinner } from '../ui/spinner';
import { Switch } from '../ui/switch';
import { ChannelEditorDialog } from './ChannelEditorDialog';
import styles from './ChannelsManagerPage.module.css';
import {
  isChannelPlatformAvailable,
  isSupportedChannelType,
} from './channel-platform';

interface ChannelsManagerPageProps {
  onClose: () => void;
  initialFocusRef?: Ref<HTMLHeadingElement>;
}

type ChannelAction = 'start' | 'stop' | 'restart' | 'startup';

const STATUS_KEYS: Record<DaemonChannelRuntimeState['state'], string> = {
  stopped: 'channels.status.stopped',
  starting: 'channels.status.starting',
  connected: 'channels.status.connected',
  partial: 'channels.status.partial',
  error: 'channels.status.error',
};

const PLATFORM_MARKS: Record<string, string> = {
  dingtalk: 'D',
  wecom: 'W',
  feishu: 'F',
};

function badgeVariant(
  state: DaemonChannelRuntimeState['state'],
): 'secondary' | 'outline' | 'destructive' {
  if (state === 'error') return 'destructive';
  if (state === 'connected') return 'secondary';
  return 'outline';
}

export function ChannelsManagerPage({
  onClose,
  initialFocusRef,
}: ChannelsManagerPageProps) {
  const { t } = useI18n();
  const workspace = useWorkspace();
  const supportsManagement =
    workspace.capabilities?.features.includes('channel_management') === true;
  const {
    catalog,
    snapshot,
    channels,
    loading,
    error,
    reload,
    createOrUpdate,
    remove,
    setStartup,
    start,
    stop,
    restart,
    pairing,
  } = useChannels({
    autoLoad: supportsManagement,
    enabled: supportsManagement,
  });
  const canManage = supportsManagement && Boolean(workspace.token);
  const [busy, setBusy] = useState<{
    name: string;
    action: ChannelAction;
  } | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<{
    workspaceCwd?: string;
    descriptor: DaemonChannelTypeDescriptor;
    instance?: DaemonChannelInstanceSnapshot;
  }>();
  const [deleteTarget, setDeleteTarget] = useState<{
    workspaceCwd?: string;
    instance: DaemonChannelInstanceSnapshot;
  }>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setBusy(null);
    setActionErrors({});
    setEditor(undefined);
    setDeleteTarget(undefined);
    setDeleteError(undefined);
    setDeleting(false);
  }, [workspace.workspaceCwd]);

  const availablePlatforms = useMemo(
    () => catalog.filter(isChannelPlatformAvailable),
    [catalog],
  );
  const instances = useMemo(
    () =>
      Object.values(channels)
        .filter((channel) => isSupportedChannelType(channel.config.type))
        .sort((left, right) => left.name.localeCompare(right.name)),
    [channels],
  );
  const workspaceName =
    workspace.workspaceCwd
      ?.split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) ?? t('channels.workspace.current');

  const channelTypeLabel = useCallback(
    (channel: DaemonChannelInstanceSnapshot) => {
      const type = String(channel.config.type);
      return catalog.find((item) => item.type === type)?.displayName ?? type;
    },
    [catalog],
  );

  const descriptorFor = useCallback(
    (channel: DaemonChannelInstanceSnapshot) =>
      availablePlatforms.find(
        (descriptor) => descriptor.type === channel.config.type,
      ),
    [availablePlatforms],
  );

  const saveChannel = useCallback(
    (name: string, request: DaemonChannelUpsertRequest) =>
      createOrUpdate(name, request),
    [createOrUpdate],
  );

  const deleteChannel = useCallback(async () => {
    if (
      !deleteTarget ||
      deleteTarget.workspaceCwd !== workspace.workspaceCwd ||
      !snapshot ||
      deleting
    ) {
      return;
    }
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await remove(deleteTarget.instance.name, {
        expectedRevision: snapshot.revision,
      });
      setDeleteTarget(undefined);
    } catch (removeError) {
      setDeleteError(extractErrorDetail(removeError));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting, remove, snapshot, workspace.workspaceCwd]);

  const runAction = useCallback(
    async (
      channel: DaemonChannelInstanceSnapshot,
      action: ChannelAction,
      operation: () => Promise<unknown>,
    ) => {
      if (!canManage || busy) return;
      setBusy({ name: channel.name, action });
      setActionErrors((current) => {
        const next = { ...current };
        delete next[channel.name];
        return next;
      });
      try {
        await operation();
      } catch (actionError) {
        setActionErrors((current) => ({
          ...current,
          [channel.name]: extractErrorDetail(actionError),
        }));
      } finally {
        setBusy(null);
      }
    },
    [busy, canManage],
  );

  const renderPrimaryAction = (channel: DaemonChannelInstanceSnapshot) => {
    const disabled = !canManage || busy !== null;
    if (channel.runtime.state === 'stopped') {
      return (
        <Button
          size="sm"
          disabled={disabled}
          onClick={() =>
            void runAction(channel, 'start', () => start(channel.name))
          }
        >
          {busy?.name === channel.name && busy.action === 'start' ? (
            <Spinner />
          ) : null}
          {t('channels.action.start')}
        </Button>
      );
    }
    if (channel.runtime.state === 'error') {
      return (
        <Button
          size="sm"
          disabled={disabled}
          onClick={() =>
            void runAction(channel, 'restart', () => restart(channel.name))
          }
        >
          {busy?.name === channel.name && busy.action === 'restart' ? (
            <Spinner />
          ) : null}
          {t('channels.action.retry')}
        </Button>
      );
    }
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          void runAction(channel, 'stop', () => stop(channel.name))
        }
      >
        {busy?.name === channel.name && busy.action === 'stop' ? (
          <Spinner />
        ) : null}
        {t('channels.action.stop')}
      </Button>
    );
  };

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.titleGroup}>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t('channels.action.back')}
          >
            <ArrowLeftIcon />
          </Button>
          <div className={styles.titleCopy}>
            <h1 ref={initialFocusRef} tabIndex={-1} className={styles.title}>
              {t('channels.title')}
            </h1>
            <p className={styles.summary}>
              {t('channels.summary', {
                workspace: workspaceName,
                count: instances.length,
              })}
            </p>
          </div>
        </div>
      </header>

      {!supportsManagement ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>{t('channels.unsupported.title')}</AlertTitle>
          <AlertDescription>
            {t('channels.unsupported.description')}
          </AlertDescription>
        </Alert>
      ) : null}

      {supportsManagement && !workspace.token ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>{t('channels.readOnly.title')}</AlertTitle>
          <AlertDescription>
            {t('channels.readOnly.description')}
          </AlertDescription>
        </Alert>
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
            size="sm"
            variant="outline"
            onClick={() => void reload()}
          >
            {t('channels.action.retry')}
          </Button>
        </Alert>
      ) : null}

      <section className={styles.section} aria-labelledby="configured-channels">
        <div className={styles.sectionHeader}>
          <h2 id="configured-channels" className={styles.sectionTitle}>
            {t('channels.configured')}
          </h2>
          <Badge variant="outline">{instances.length}</Badge>
        </div>
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
              const descriptor = descriptorFor(channel);
              const runtimeError =
                actionErrors[channel.name] ?? channel.runtime.lastError;
              return (
                <Card
                  key={channel.name}
                  size="sm"
                  className={styles.channelCard}
                  data-runtime-state={channel.runtime.state}
                >
                  <CardHeader>
                    <div className="min-w-0">
                      <CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate">{channel.name}</span>
                        <Badge variant={badgeVariant(channel.runtime.state)}>
                          {t(STATUS_KEYS[channel.runtime.state])}
                        </Badge>
                      </CardTitle>
                      <CardDescription>
                        {channelTypeLabel(channel)}
                      </CardDescription>
                    </div>
                    <CardAction>{renderPrimaryAction(channel)}</CardAction>
                  </CardHeader>
                  {runtimeError ? (
                    <CardContent>
                      <Alert
                        variant="destructive"
                        className={styles.errorAlert}
                      >
                        <AlertCircleIcon />
                        <AlertTitle>{t('channels.runtimeError')}</AlertTitle>
                        <AlertDescription>{runtimeError}</AlertDescription>
                      </Alert>
                    </CardContent>
                  ) : null}
                  <CardFooter className={styles.channelActions}>
                    <label className={styles.startupControl}>
                      <Switch
                        size="sm"
                        checked={channel.startsWithServe}
                        disabled={!canManage || busy !== null || !snapshot}
                        aria-label={t('channels.action.startWithServeNamed', {
                          name: channel.name,
                        })}
                        onCheckedChange={(enabled) =>
                          void runAction(channel, 'startup', () =>
                            setStartup(channel.name, {
                              expectedRevision: snapshot?.revision ?? '',
                              enabled,
                            }),
                          )
                        }
                      />
                      {t('channels.startsWithServe')}
                    </label>
                    <div className={styles.lifecycleActions}>
                      {channel.runtime.state !== 'stopped' &&
                      channel.runtime.state !== 'error' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!canManage || busy !== null}
                          onClick={() =>
                            void runAction(channel, 'restart', () =>
                              restart(channel.name),
                            )
                          }
                        >
                          {busy?.name === channel.name &&
                          busy.action === 'restart' ? (
                            <Spinner />
                          ) : (
                            <RotateCwIcon />
                          )}
                          {t('channels.action.restart')}
                        </Button>
                      ) : null}
                      {descriptor ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!canManage || busy !== null || !snapshot}
                          aria-label={t('channels.action.editNamed', {
                            name: channel.name,
                          })}
                          onClick={() =>
                            setEditor({
                              workspaceCwd: workspace.workspaceCwd,
                              descriptor,
                              instance: channel,
                            })
                          }
                        >
                          <PencilIcon />
                          {t('channels.action.edit')}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={!canManage || busy !== null || !snapshot}
                        aria-label={t('channels.action.deleteNamed', {
                          name: channel.name,
                        })}
                        onClick={() => {
                          setDeleteError(undefined);
                          setDeleteTarget({
                            workspaceCwd: workspace.workspaceCwd,
                            instance: channel,
                          });
                        }}
                      >
                        <Trash2Icon />
                        {t('channels.action.delete')}
                      </Button>
                    </div>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        ) : null}
      </section>

      {availablePlatforms.length > 0 ? (
        <section className={styles.section} aria-labelledby="channel-platforms">
          <div>
            <h2 id="channel-platforms" className={styles.sectionTitle}>
              {t('channels.availablePlatforms')}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('channels.availablePlatforms.description')}
            </p>
          </div>
          <div className={styles.platformGrid}>
            {availablePlatforms.map((platform) => (
              <button
                key={platform.type}
                type="button"
                className={styles.platformCard}
                data-testid={`channel-platform-${platform.type}`}
                disabled={!canManage || !snapshot}
                aria-label={t('channels.platform.configureNamed', {
                  platform: platform.displayName,
                })}
                onClick={() =>
                  setEditor({
                    workspaceCwd: workspace.workspaceCwd,
                    descriptor: platform,
                  })
                }
              >
                <span className={styles.platformMark} aria-hidden="true">
                  {PLATFORM_MARKS[platform.type]}
                </span>
                <div className={styles.platformCopy}>
                  <p className={styles.platformName}>{platform.displayName}</p>
                  <p className={styles.platformHint}>
                    {t('channels.platform.configure')}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {editor && editor.workspaceCwd === workspace.workspaceCwd && snapshot ? (
        <ChannelEditorDialog
          open
          descriptor={editor.descriptor}
          instance={editor.instance}
          expectedRevision={snapshot.revision}
          existingNames={instances
            .filter((channel) => channel.name !== editor.instance?.name)
            .map((channel) => channel.name)}
          onOpenChange={(open) => {
            if (!open) setEditor(undefined);
          }}
          onSave={saveChannel}
          onReload={reload}
          listPairingRequests={pairing.list}
          approvePairingRequest={pairing.approve}
          listPairingApprovals={pairing.approvals}
          revokePairingApproval={pairing.revoke}
        />
      ) : null}

      <AlertDialog
        open={Boolean(
          deleteTarget && deleteTarget.workspaceCwd === workspace.workspaceCwd,
        )}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setDeleteTarget(undefined);
            setDeleteError(undefined);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('channels.delete.title', {
                name: deleteTarget?.instance.name ?? '',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('channels.delete.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>{t('channels.delete.error')}</AlertTitle>
              <AlertDescription>{deleteError}</AlertDescription>
              <Button
                className="mt-2 w-fit"
                size="sm"
                variant="outline"
                onClick={() => {
                  void reload().then(
                    () => {
                      setDeleteTarget(undefined);
                      setDeleteError(undefined);
                    },
                    (reloadError: unknown) => {
                      setDeleteError(extractErrorDetail(reloadError));
                    },
                  );
                }}
              >
                {t('channels.editor.reloadLatest')}
              </Button>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t('channels.editor.cancel')}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void deleteChannel()}
            >
              {deleting ? <Spinner /> : null}
              {t('channels.action.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
