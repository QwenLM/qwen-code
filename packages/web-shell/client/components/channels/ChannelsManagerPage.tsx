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
  PencilIcon,
  PlusIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  RotateCwIcon,
  Trash2Icon,
} from 'lucide-react';
import type {
  DaemonChannelInstanceSnapshot,
  DaemonChannelRuntimeState,
  DaemonChannelTypeDescriptor,
  DaemonChannelUpsertRequest,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import {
  useChannels,
  useStatusReport,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Switch } from '../ui/switch';
import { workspaceLabel } from '../../utils/workspace';
import { ChannelEditorDialog } from './ChannelEditorDialog';
import styles from './ChannelsManagerPage.module.css';
import {
  isChannelPlatformAvailable,
  isSupportedChannelType,
  PLATFORM_MARKS,
} from './channel-platform';

interface ChannelsManagerPageProps {
  onClose: () => void;
  initialFocusRef?: Ref<HTMLHeadingElement>;
}

type ChannelAction = 'start' | 'stop' | 'restart' | 'startup';

function actionErrorKey(workspaceCwd: string | undefined, name: string) {
  return `${workspaceCwd ?? ''}\0${name}`;
}

const STATUS_KEYS: Record<DaemonChannelRuntimeState['state'], string> = {
  stopped: 'channels.status.stopped',
  starting: 'channels.status.starting',
  connected: 'channels.status.connected',
  partial: 'channels.status.partial',
  error: 'channels.status.error',
};

const STATUS_DESCRIPTION_KEYS: Record<
  DaemonChannelRuntimeState['state'],
  string
> = {
  stopped: 'channels.statusDescription.stopped',
  starting: 'channels.statusDescription.starting',
  connected: 'channels.statusDescription.connected',
  partial: 'channels.statusDescription.partial',
  error: 'channels.statusDescription.error',
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
  const bearerConfigured = Boolean(workspace.token);
  const { report: statusReport, loading: statusLoading } = useStatusReport({
    autoLoad: supportsManagement && !bearerConfigured,
    enabled: supportsManagement && !bearerConfigured,
  });
  const hasOperatorAuthority =
    bearerConfigured ||
    (statusReport?.security.loopbackBind === true &&
      statusReport.security.tokenConfigured === false &&
      statusReport.security.requireAuth === false);
  const registeredWorkspaces = useMemo<DaemonWorkspaceCapability[]>(() => {
    const listed = (workspace.capabilities?.workspaces ?? []).filter(
      (entry) => entry.kind !== 'live',
    );
    if (listed.length > 0) return listed;
    if (!workspace.workspaceCwd) return [];
    return [
      {
        id: 'primary',
        cwd: workspace.workspaceCwd,
        primary: true,
        trusted: true,
      },
    ];
  }, [workspace.capabilities?.workspaces, workspace.workspaceCwd]);
  const defaultWorkspace =
    registeredWorkspaces.find((entry) => entry.primary) ??
    registeredWorkspaces.find((entry) => entry.trusted) ??
    registeredWorkspaces[0];
  const [managementWorkspaceCwd, setManagementWorkspaceCwd] = useState<
    string | undefined
  >();
  const selectedManagementWorkspace =
    registeredWorkspaces.find(
      (entry) => entry.cwd === managementWorkspaceCwd,
    ) ?? defaultWorkspace;
  const [editor, setEditor] = useState<{
    workspaceCwd: string;
    descriptor: DaemonChannelTypeDescriptor;
    instance?: DaemonChannelInstanceSnapshot;
  }>();
  const editorRef = useRef(editor);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  const activeWorkspaceCwd =
    editor?.workspaceCwd ?? selectedManagementWorkspace?.cwd;
  const activeWorkspace = registeredWorkspaces.find(
    (entry) => entry.cwd === activeWorkspaceCwd,
  );
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
    workspaceCwd: activeWorkspaceCwd,
  });
  const canManage =
    supportsManagement &&
    hasOperatorAuthority &&
    Boolean(activeWorkspaceCwd) &&
    activeWorkspace?.trusted === true;
  const [busyByWorkspace, setBusyByWorkspace] = useState<
    Record<
      string,
      {
        workspaceCwd: string;
        name: string;
        action: ChannelAction;
      }
    >
  >({});
  const busy = activeWorkspaceCwd
    ? (busyByWorkspace[activeWorkspaceCwd] ?? null)
    : null;
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<{
    workspaceCwd?: string;
    instance: DaemonChannelInstanceSnapshot;
  }>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setDeleteTarget(undefined);
    setDeleteError(undefined);
    setDeleting(false);
  }, [activeWorkspaceCwd]);

  useEffect(() => {
    if (
      managementWorkspaceCwd &&
      !registeredWorkspaces.some(
        (entry) => entry.cwd === managementWorkspaceCwd,
      )
    ) {
      setManagementWorkspaceCwd(undefined);
    }
    if (
      editor &&
      !registeredWorkspaces.some((entry) => entry.cwd === editor.workspaceCwd)
    ) {
      setEditor(undefined);
    }
  }, [editor, managementWorkspaceCwd, registeredWorkspaces]);

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
  const workspaceName = activeWorkspace
    ? workspaceLabel(activeWorkspace)
    : t('channels.workspace.current');
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
    async (name: string, request: DaemonChannelUpsertRequest) => {
      const workspaceCwd = editor?.workspaceCwd;
      const result = await createOrUpdate(name, request);
      if (workspaceCwd && editorRef.current?.workspaceCwd === workspaceCwd) {
        setManagementWorkspaceCwd(workspaceCwd);
      }
      return result;
    },
    [createOrUpdate, editor?.workspaceCwd],
  );

  const deleteChannel = useCallback(async () => {
    if (
      !deleteTarget ||
      deleteTarget.workspaceCwd !== activeWorkspaceCwd ||
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
      setActionErrors((current) => {
        const next = { ...current };
        delete next[
          actionErrorKey(deleteTarget.workspaceCwd, deleteTarget.instance.name)
        ];
        return next;
      });
      setDeleteTarget(undefined);
    } catch (removeError) {
      setDeleteError(extractErrorDetail(removeError));
    } finally {
      setDeleting(false);
    }
  }, [activeWorkspaceCwd, deleteTarget, deleting, remove, snapshot]);

  const runAction = useCallback(
    async (
      channel: DaemonChannelInstanceSnapshot,
      action: ChannelAction,
      operation: () => Promise<unknown>,
    ) => {
      if (!canManage || busy || !activeWorkspaceCwd) return;
      const workspaceCwd = activeWorkspaceCwd;
      const errorKey = actionErrorKey(workspaceCwd, channel.name);
      setBusyByWorkspace((current) => ({
        ...current,
        [workspaceCwd]: { workspaceCwd, name: channel.name, action },
      }));
      setActionErrors((current) => {
        const next = { ...current };
        delete next[errorKey];
        return next;
      });
      try {
        await operation();
      } catch (actionError) {
        setActionErrors((current) => ({
          ...current,
          [errorKey]: extractErrorDetail(actionError),
        }));
      } finally {
        setBusyByWorkspace((current) => {
          const workspaceBusy = current[workspaceCwd];
          if (
            workspaceBusy?.name !== channel.name ||
            workspaceBusy.action !== action
          ) {
            return current;
          }
          const next = { ...current };
          delete next[workspaceCwd];
          return next;
        });
      }
    },
    [activeWorkspaceCwd, busy, canManage],
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
          {busy?.workspaceCwd === activeWorkspaceCwd &&
          busy.name === channel.name &&
          busy.action === 'start' ? (
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
          {busy?.workspaceCwd === activeWorkspaceCwd &&
          busy.name === channel.name &&
          busy.action === 'restart' ? (
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
        {busy?.workspaceCwd === activeWorkspaceCwd &&
        busy.name === channel.name &&
        busy.action === 'stop' ? (
          <Spinner />
        ) : null}
        {t('channels.action.stop')}
      </Button>
    );
  };

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <Button
          variant="ghost"
          size="icon"
          className={styles.backButton}
          onClick={onClose}
          aria-label={t('channels.action.back')}
        >
          <ArrowLeftIcon />
        </Button>
        <h1 ref={initialFocusRef} tabIndex={-1} className={styles.title}>
          {t('channels.title')}
        </h1>
      </header>

      <div className={styles.pageBody}>
        <p className={styles.intro}>{t('channels.description')}</p>

        <div className={styles.toolbar}>
          <p className={styles.count}>
            {t('channels.summary', {
              workspace: workspaceName,
              count: instances.length,
            })}
          </p>
          <div className={styles.toolbarActions}>
            {registeredWorkspaces.length > 0 ? (
              <div className={styles.workspacePicker}>
                <span className={styles.workspacePickerLabel}>
                  {t('channels.workspace.label')}
                </span>
                <Select
                  value={selectedManagementWorkspace?.cwd ?? ''}
                  disabled={
                    !supportsManagement ||
                    Boolean(editor) ||
                    loading ||
                    deleting
                  }
                  onValueChange={(cwd) => setManagementWorkspaceCwd(cwd)}
                >
                  <SelectTrigger
                    className={styles.workspacePickerTrigger}
                    aria-label={t('channels.workspace.label')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {registeredWorkspaces.map((entry) => (
                      <SelectItem
                        key={entry.id}
                        value={entry.cwd}
                        disabled={!entry.trusted}
                      >
                        {workspaceLabel(entry)}
                        {entry.primary
                          ? ` · ${t('channels.workspace.primary')}`
                          : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <Button
              variant="outline"
              className={styles.refreshButton}
              disabled={
                !supportsManagement ||
                loading ||
                Boolean(editor) ||
                busy !== null ||
                deleting
              }
              onClick={() => void reload()}
            >
              {loading ? <Spinner /> : <RefreshCwIcon />}
              {t('channels.action.refresh')}
            </Button>
          </div>
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

        {supportsManagement && !hasOperatorAuthority && !statusLoading ? (
          <Alert>
            <AlertCircleIcon />
            <AlertTitle>{t('channels.readOnly.title')}</AlertTitle>
            <AlertDescription>
              {t('channels.readOnly.description')}
            </AlertDescription>
          </Alert>
        ) : null}

        {loading && instances.length === 0 ? (
          <div
            className={styles.loadingState}
            role="status"
            aria-label={t('channels.loading')}
          >
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

        <section
          className={styles.section}
          aria-labelledby="configured-channels"
        >
          <div className={styles.sectionHeader}>
            <h2 id="configured-channels" className={styles.sectionTitle}>
              {t('channels.configured')}
            </h2>
            <p className={styles.sectionDescription}>
              {t('channels.configured.description')}
            </p>
          </div>
          {!loading && !error && instances.length === 0 ? (
            <Empty className={styles.emptyState}>
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
                  actionErrors[
                    actionErrorKey(activeWorkspaceCwd, channel.name)
                  ] ?? channel.runtime.lastError;
                const canRestart =
                  channel.runtime.state !== 'stopped' &&
                  channel.runtime.state !== 'error';
                return (
                  <Card
                    key={channel.name}
                    size="sm"
                    className={styles.channelCard}
                  >
                    <CardHeader className={styles.channelHeader}>
                      <div className={styles.channelIdentity}>
                        <span
                          className={styles.platformMark}
                          aria-hidden="true"
                        >
                          {PLATFORM_MARKS[String(channel.config.type)] ??
                            channelTypeLabel(channel)[0]?.toUpperCase() ??
                            '?'}
                        </span>
                        <div className={styles.channelIdentityCopy}>
                          <CardTitle className={styles.channelNameRow}>
                            <span className={styles.channelName}>
                              {channel.name}
                            </span>
                            <Badge
                              variant={badgeVariant(channel.runtime.state)}
                              className={styles.runtimeBadge}
                              data-runtime-state={channel.runtime.state}
                            >
                              {t(STATUS_KEYS[channel.runtime.state])}
                            </Badge>
                          </CardTitle>
                          <CardDescription className={styles.channelMeta}>
                            <span>{channelTypeLabel(channel)}</span>
                            <span aria-hidden="true">·</span>
                            <span>
                              {t(
                                STATUS_DESCRIPTION_KEYS[channel.runtime.state],
                              )}
                            </span>
                          </CardDescription>
                        </div>
                      </div>
                      <CardAction className={styles.cardActionGroup}>
                        {renderPrimaryAction(channel)}
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
                                workspaceCwd: activeWorkspaceCwd!,
                                descriptor,
                                instance: channel,
                              })
                            }
                          >
                            <PencilIcon />
                            {t('channels.action.edit')}
                          </Button>
                        ) : null}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              disabled={
                                !canManage || busy !== null || !snapshot
                              }
                              aria-label={t('channels.action.moreNamed', {
                                name: channel.name,
                              })}
                            >
                              {busy?.workspaceCwd === activeWorkspaceCwd &&
                              busy.name === channel.name &&
                              busy.action === 'restart' ? (
                                <Spinner />
                              ) : (
                                <EllipsisVerticalIcon />
                              )}
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-40">
                            <DropdownMenuGroup>
                              {canRestart ? (
                                <DropdownMenuItem
                                  onSelect={() =>
                                    void runAction(channel, 'restart', () =>
                                      restart(channel.name),
                                    )
                                  }
                                >
                                  <RotateCwIcon data-icon="inline-start" />
                                  {t('channels.action.restart')}
                                </DropdownMenuItem>
                              ) : null}
                              {canRestart ? <DropdownMenuSeparator /> : null}
                              <DropdownMenuItem
                                variant="destructive"
                                aria-label={t('channels.action.deleteNamed', {
                                  name: channel.name,
                                })}
                                onSelect={() => {
                                  setDeleteError(undefined);
                                  setDeleteTarget({
                                    workspaceCwd: activeWorkspaceCwd,
                                    instance: channel,
                                  });
                                }}
                              >
                                <Trash2Icon data-icon="inline-start" />
                                {t('channels.action.delete')}
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </CardAction>
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
                    <CardFooter className={styles.channelFooter}>
                      <label className={styles.startupControl}>
                        <span className={styles.startupCopy}>
                          <span className={styles.startupLabel}>
                            {t('channels.startsWithServe')}
                          </span>
                          <span className={styles.startupDescription}>
                            {t('channels.startsWithServe.description')}
                          </span>
                        </span>
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
                      </label>
                    </CardFooter>
                  </Card>
                );
              })}
            </div>
          ) : null}
        </section>

        {availablePlatforms.length > 0 ? (
          <section
            className={`${styles.section} ${styles.platformSection}`}
            aria-labelledby="channel-platforms"
          >
            <div className={styles.sectionHeader}>
              <h2 id="channel-platforms" className={styles.sectionTitle}>
                {t('channels.availablePlatforms')}
              </h2>
              <p className={styles.sectionDescription}>
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
                      workspaceCwd: activeWorkspaceCwd!,
                      descriptor: platform,
                    })
                  }
                >
                  <span className={styles.platformMark} aria-hidden="true">
                    {PLATFORM_MARKS[platform.type] ??
                      platform.displayName[0]?.toUpperCase() ??
                      '?'}
                  </span>
                  <span className={styles.platformCopy}>
                    <span className={styles.platformName}>
                      {platform.displayName}
                    </span>
                    <span className={styles.platformHint}>
                      {t('channels.platform.add')}
                    </span>
                  </span>
                  <span className={styles.platformAction} aria-hidden="true">
                    <PlusIcon />
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      {editor ? (
        <ChannelEditorDialog
          open
          descriptor={editor.descriptor}
          instance={editor.instance}
          expectedRevision={snapshot?.revision ?? ''}
          existingNames={instances
            .filter((channel) => channel.name !== editor.instance?.name)
            .map((channel) => channel.name)}
          workspaces={registeredWorkspaces}
          workspaceCwd={editor.workspaceCwd}
          workspaceLoading={loading}
          onWorkspaceChange={(workspaceCwd) =>
            setEditor((current) =>
              current ? { ...current, workspaceCwd } : current,
            )
          }
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
          deleteTarget && deleteTarget.workspaceCwd === activeWorkspaceCwd,
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
