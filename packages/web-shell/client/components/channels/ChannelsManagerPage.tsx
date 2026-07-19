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
  RadioTowerIcon,
} from 'lucide-react';
import {
  DaemonHttpError,
  type DaemonChannelInstanceSnapshot,
  type DaemonChannelRuntimeState,
} from '@qwen-code/sdk/daemon';
import { useChannels, useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import { extractErrorDetail } from '../../utils/errorDetail';
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

interface ChannelsManagerPageProps {
  onClose: () => void;
  initialFocusRef?: Ref<HTMLHeadingElement>;
}

type EditorIntent = { mode: 'add' } | { mode: 'edit'; name: string };
type FocusTarget = 'primary' | 'restart' | 'startup';

const STATUS_LABELS: Record<DaemonChannelRuntimeState['state'], string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  connected: 'Connected',
  partial: 'Partially connected',
  error: 'Error',
};

function workspaceLabel(workspaceCwd: string | undefined): string {
  if (!workspaceCwd) return 'Current workspace';
  const parts = workspaceCwd.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? workspaceCwd;
}

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
  const workspace = useWorkspace();
  const {
    catalog,
    snapshot,
    loading,
    error,
    reload,
    remove,
    setStartup,
    start,
    stop,
    restart,
  } = useChannels({ autoLoad: true });
  const supportsManagement =
    workspace.capabilities?.features.includes('channel_management') === true;
  const hasBearerToken = Boolean(workspace.token);
  const canManage = supportsManagement && hasBearerToken;
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
  const [revisionBlockedNames, setRevisionBlockedNames] = useState<Set<string>>(
    new Set(),
  );
  const [deleteName, setDeleteName] = useState<string | null>(null);
  const [editorIntent, setEditorIntent] = useState<EditorIntent | null>(null);
  const returnFocusRef = useRef<{ name: string; target: FocusTarget } | null>(
    null,
  );
  const actionRefs = useRef(new Map<string, HTMLButtonElement>());
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const restorePageFocusAfterDeleteRef = useRef(false);

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
    if (deleteName || !restorePageFocusAfterDeleteRef.current) return;
    restorePageFocusAfterDeleteRef.current = false;
    queueMicrotask(() => {
      const addButton = addButtonRef.current;
      if (addButton && !addButton.disabled) addButton.focus();
      else closeButtonRef.current?.focus();
    });
  }, [deleteName]);

  const setRevisionBlocked = useCallback((name: string, blocked: boolean) => {
    setRevisionBlockedNames((current) => {
      const next = new Set(current);
      if (blocked) next.add(name);
      else next.delete(name);
      return next;
    });
  }, []);

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
          setRevisionBlocked(name, true);
          try {
            const refreshed = await reload();
            if (refreshed) {
              setRevisionBlocked(name, false);
            } else {
              setActionErrors((current) => ({
                ...current,
                [name]: `${actionMessage} Channel settings could not be refreshed.`,
              }));
            }
          } catch (reloadError) {
            setActionErrors((current) => ({
              ...current,
              [name]: `${actionMessage} Refresh failed: ${extractErrorDetail(reloadError)}`,
            }));
          }
        }
        return false;
      } finally {
        setBusyName(null);
        setBusyTarget(null);
      }
    },
    [busyName, canManage, reload, setRevisionBlocked],
  );

  const retryLoad = useCallback(async () => {
    const refreshed = await reload();
    if (refreshed) setRevisionBlockedNames(new Set());
  }, [reload]);

  const channelTypeLabel = useCallback(
    (channel: DaemonChannelInstanceSnapshot) => {
      const type =
        typeof channel.config.type === 'string'
          ? channel.config.type
          : 'Unknown type';
      return catalog.find((entry) => entry.type === type)?.displayName ?? type;
    },
    [catalog],
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
          aria-label={`Start ${channel.name}`}
          onClick={() =>
            void runAction(channel.name, 'primary', () => start(channel.name))
          }
        >
          {busyName === channel.name && busyTarget === 'primary' ? (
            <Spinner />
          ) : null}
          Start
        </Button>
      );
    }
    if (state === 'error') {
      return (
        <Button
          ref={(element) => setActionRef(channel.name, 'primary', element)}
          size="sm"
          disabled={disabled}
          aria-label={`Retry ${channel.name}`}
          onClick={() =>
            void runAction(channel.name, 'primary', () => restart(channel.name))
          }
        >
          {busyName === channel.name && busyTarget === 'primary' ? (
            <Spinner />
          ) : null}
          Retry
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
            aria-label={`Stop ${channel.name}`}
            onClick={() =>
              void runAction(channel.name, 'primary', () => stop(channel.name))
            }
          >
            {busyName === channel.name && busyTarget === 'primary' ? (
              <Spinner />
            ) : null}
            Stop
          </Button>
        ) : null}
        <Button
          ref={(element) => setActionRef(channel.name, 'restart', element)}
          size="sm"
          disabled={disabled}
          aria-label={`Restart ${channel.name}`}
          onClick={() =>
            void runAction(channel.name, 'restart', () => restart(channel.name))
          }
        >
          {busyName === channel.name && busyTarget === 'restart' ? (
            <Spinner />
          ) : null}
          Restart
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
            aria-label="Close channels"
          >
            <ArrowLeftIcon />
          </Button>
          <div className="min-w-0">
            <h1
              ref={initialFocusRef}
              tabIndex={-1}
              className="text-2xl font-semibold outline-none"
            >
              Channels
            </h1>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {workspaceLabel(workspace.workspaceCwd)} · {instances.length}{' '}
              configured
            </p>
          </div>
        </div>
        <Button
          ref={addButtonRef}
          className={styles.addButton}
          disabled={!canManage || busyName !== null}
          onClick={() => setEditorIntent({ mode: 'add' })}
        >
          <PlusIcon data-icon="inline-start" />
          Add channel
        </Button>
      </div>

      {!supportsManagement ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>Channel management is not supported</AlertTitle>
          <AlertDescription>
            Update Qwen Code to a version that supports channel management.
          </AlertDescription>
        </Alert>
      ) : null}

      {supportsManagement && !hasBearerToken ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>Channel management is read-only</AlertTitle>
          <AlertDescription>
            Restart Qwen Code with a bearer token to add or change channels.
          </AlertDescription>
        </Alert>
      ) : null}

      {editorIntent ? (
        <Alert>
          <AlertTitle>
            {editorIntent.mode === 'add'
              ? 'Add channel'
              : `Edit ${editorIntent.name}`}
          </AlertTitle>
          <AlertDescription>
            Channel setup opens here in the next step.
            <Button
              className="ml-2"
              variant="link"
              size="xs"
              onClick={() => setEditorIntent(null)}
            >
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {loading && instances.length === 0 ? (
        <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Loading channels
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Channels could not be loaded</AlertTitle>
          <AlertDescription>{extractErrorDetail(error)}</AlertDescription>
          <Button
            className="mt-2 w-fit"
            variant="outline"
            size="sm"
            aria-label="Retry loading channels"
            onClick={() => void retryLoad()}
          >
            Retry
          </Button>
        </Alert>
      ) : null}

      {!loading && !error && instances.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RadioTowerIcon />
            </EmptyMedia>
            <EmptyTitle>No channels configured</EmptyTitle>
            <EmptyDescription>
              Add a channel to connect Qwen Code to a messaging service.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {instances.length > 0 ? (
        <div className={styles.channelGrid}>
          {instances.map((channel) => {
            const state = channel.runtime.state;
            const disabled = !canManage || busyName !== null;
            const revisionBlocked = revisionBlockedNames.has(channel.name);
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
                      {STATUS_LABELS[state]}
                    </Badge>
                    {channel.startsWithServe ? (
                      <Badge variant="outline">Starts with serve</Badge>
                    ) : null}
                  </CardTitle>
                  <CardDescription>{channelTypeLabel(channel)}</CardDescription>
                  <CardAction>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={disabled || revisionBlocked}
                          aria-label={`More actions for ${channel.name}`}
                        >
                          <EllipsisVerticalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            onSelect={() =>
                              setEditorIntent({
                                mode: 'edit',
                                name: channel.name,
                              })
                            }
                          >
                            Edit {channel.name}
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setDeleteName(channel.name)}
                        >
                          Delete {channel.name}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {channel.runtime.lastError ? (
                    <Alert variant="destructive" className={styles.errorAlert}>
                      <AlertCircleIcon />
                      <AlertDescription>
                        {channel.runtime.lastError}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {actionErrors[channel.name] ? (
                    <Alert variant="destructive" className={styles.errorAlert}>
                      <AlertCircleIcon />
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
                          aria-label={`Start ${channel.name} with serve`}
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
                      Start with serve
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      {renderPrimaryActions(channel)}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
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
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete channel?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteName
                ? `${deleteName} will be removed from this workspace.`
                : 'This channel will be removed from this workspace.'}
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
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={
                !deleteName ||
                !canManage ||
                busyName !== null ||
                revisionBlockedNames.has(deleteName)
              }
              aria-label="Delete channel"
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
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
