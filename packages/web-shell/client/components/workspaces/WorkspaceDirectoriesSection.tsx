/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderClosedIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import {
  useConnection,
  useWorkspace,
  useWorkspaceActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { AddWorkspaceDialog } from '../dialogs/AddWorkspaceDialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';

interface DirectoriesState {
  status: 'loading' | 'ready' | 'error';
  primaryDirectory?: string;
  directories: string[];
}

/**
 * Extra directories of the selected workspace, presented in the Settings
 * panel. Adds and removes go through the daemon's workspace-directory route,
 * which applies them to live sessions and persists the workspace setting.
 */
export function WorkspaceDirectoriesSection() {
  const { t } = useI18n();
  const connection = useConnection();
  const workspace = useWorkspace();
  const actions = useWorkspaceActions();
  const workspaceCwd = workspace.workspaceCwd;
  // Registration rewrites an `ssh://` URL to a local mirror directory, so the
  // cwd never carries that scheme; the workspace entry's SSH marker is the
  // signal the rest of the shell uses.
  const sshWorkspace =
    workspace.capabilities?.workspaces?.find(
      (entry) => entry.cwd === workspaceCwd,
    )?.ssh !== undefined;
  const supported =
    connection.capabilities?.features?.includes('workspace_directories') ===
      true &&
    workspaceCwd !== undefined &&
    !sshWorkspace;
  // The picker is an independent, host-probed capability: a headless daemon
  // still serves this section but answers the picker with 501, so Browse must
  // stay hidden there instead of failing on every click.
  const pickerSupported =
    connection.capabilities?.features?.includes('native_directory_picker') ===
    true;
  const [state, setState] = useState<DirectoriesState>({
    status: 'loading',
    directories: [],
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The mutation is a read-modify-write of the persisted list, so two
  // in-flight requests can lose one another: whichever write lands last wins
  // and the loser's change is silently gone. One gate covers both directions;
  // the ref makes it effective within the same tick, before state re-renders.
  const mutatingRef = useRef(false);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!supported || !workspaceCwd) return undefined;
    const request = ++requestRef.current;
    setState((previous) => ({ ...previous, status: 'loading' }));
    setNotice(null);
    void actions
      .listWorkspaceDirectories(workspaceCwd)
      .then((result) => {
        if (request !== requestRef.current) return;
        setState({
          status: 'ready',
          primaryDirectory: result.primaryDirectory,
          directories: result.directories,
        });
      })
      .catch((error: unknown) => {
        if (request !== requestRef.current) return;
        setState({ status: 'error', directories: [] });
        setNotice(error instanceof Error ? error.message : String(error));
      });
    return () => {
      requestRef.current += 1;
    };
  }, [actions, supported, workspaceCwd]);

  const addDirectory = useCallback(
    async (path: string) => {
      if (!workspaceCwd || mutatingRef.current) return;
      mutatingRef.current = true;
      setAdding(true);
      try {
        const result = await actions.addWorkspaceDirectory(workspaceCwd, path);
        setState({
          status: 'ready',
          primaryDirectory: result.primaryDirectory,
          directories: result.directories,
        });
        setNotice(
          result.warnings.length > 0 ? result.warnings.join(' ') : null,
        );
      } finally {
        mutatingRef.current = false;
        setAdding(false);
      }
    },
    [actions, workspaceCwd],
  );

  const removeDirectory = useCallback(
    async (path: string) => {
      if (!workspaceCwd || removing !== null || mutatingRef.current) return;
      mutatingRef.current = true;
      setRemoving(path);
      setNotice(null);
      try {
        const result = await actions.removeWorkspaceDirectory(
          workspaceCwd,
          path,
        );
        setState({
          status: 'ready',
          primaryDirectory: result.primaryDirectory,
          directories: result.directories,
        });
        setNotice(
          result.warnings.length > 0 ? result.warnings.join(' ') : null,
        );
      } catch (error) {
        setNotice(
          `${t('workspaceDirectories.removeFailed')}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        mutatingRef.current = false;
        setRemoving(null);
      }
    },
    [actions, removing, t, workspaceCwd],
  );

  if (!supported) return null;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">
        {t('workspaceDirectories.title')}
      </h3>
      <p className="text-xs text-muted-foreground">
        {t('workspaceDirectories.description')}
      </p>
      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {t('workspaceDirectories.warning')}
      </p>
      {state.status === 'loading' ? (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
          <Spinner />
          {t('workspaceDirectories.loading')}
        </div>
      ) : state.status === 'error' ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {t('workspaceDirectories.loadFailed')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {state.primaryDirectory && (
            <li className="flex items-center gap-2 px-3 py-2 text-sm">
              <FolderClosedIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span
                className="min-w-0 flex-1 truncate"
                title={state.primaryDirectory}
              >
                {state.primaryDirectory}
              </span>
              <Badge variant="secondary">
                {t('workspaceDirectories.primary')}
              </Badge>
            </li>
          )}
          {state.directories.map((directory) => (
            <li
              key={directory}
              className="flex items-center gap-2 px-3 py-2 text-sm"
            >
              <FolderClosedIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate" title={directory}>
                {directory}
              </span>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('workspaceDirectories.remove')}
                title={t('workspaceDirectories.remove')}
                disabled={removing !== null || adding}
                onClick={() => void removeDirectory(directory)}
              >
                {removing === directory ? <Spinner /> : <Trash2Icon />}
              </Button>
            </li>
          ))}
          {state.directories.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">
              {t('workspaceDirectories.empty')}
            </li>
          )}
        </ul>
      )}
      <div className="flex items-center justify-between gap-4">
        {notice ? (
          <p role="status" className="min-w-0 text-xs text-muted-foreground">
            {notice}
          </p>
        ) : (
          <span />
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={state.status === 'loading' || removing !== null || adding}
          onClick={() => setAddOpen(true)}
        >
          <PlusIcon />
          {t('workspaceDirectories.add')}
        </Button>
      </div>
      {addOpen && (
        <AddWorkspaceDialog
          title={t('workspaceDirectories.addTitle')}
          submitLabel={t('workspaceDirectories.addSubmit')}
          browseDirectories
          persistenceSupported={false}
          displayNameEnabled={false}
          initialPath={workspaceCwd}
          pathPlaceholder={workspaceCwd}
          pathHint={t('workspaceDirectories.pathHint')}
          onSuggest={actions.suggestWorkspacePaths}
          onPick={
            pickerSupported
              ? async () => {
                  const picked = await actions.pickWorkspaceDirectory();
                  return picked.selected ? picked.path : undefined;
                }
              : undefined
          }
          onAdd={addDirectory}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}
