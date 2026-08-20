/**
 * SendResourceToWorkspaceDialog — Copy a source, skill, or automation to another workspace.
 *
 * Uses the resources:export → resources:import RPC pipeline.
 * Supports both local and remote target workspaces:
 * - Local: both RPC calls go to the same server
 * - Remote: export runs locally, import runs via invokeOnServer on the target
 *
 * Adapted from SendToWorkspaceDialog (session transfer).
 */

import { useTranslation } from 'react-i18next';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Cloud, CloudOff, Monitor, Send } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CrossfadeAvatar } from '@/components/ui/avatar';
import { useWorkspaceIcons } from '@/hooks/useWorkspaceIcon';
import { cn } from '@/lib/utils';
import {
  getWorkspaceDisplayName,
  getWorkspaceInitial,
} from '@/utils/workspace';
import type {
  Workspace,
  ExportResourcesOptions,
  ResourceImportMode,
  ResourceImportResult,
} from '../../../shared/types';

export type SendResourceType = 'source' | 'skill' | 'automation';

export interface SendResourceToWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What kind of resource to send */
  resourceType: SendResourceType;
  /** Slug(s) or ID(s) of resources to send */
  resourceIds: string[];
  /** Display label for the dialog description (e.g., "Slack source") */
  resourceLabel: string;
  /** All workspaces */
  workspaces: Workspace[];
  /** Current workspace ID (excluded from picker) */
  activeWorkspaceId: string | null;
  /** Called after successful transfer */
  onTransferComplete?: () => void;
}

const RESOURCE_TYPE_LABELS: Record<
  SendResourceType,
  { singular: string; plural: string }
> = {
  source: { singular: 'source', plural: 'sources' },
  skill: { singular: 'skill', plural: 'skills' },
  automation: { singular: 'automation', plural: 'automations' },
};

export function SendResourceToWorkspaceDialog({
  open,
  onOpenChange,
  resourceType,
  resourceIds,
  resourceLabel,
  workspaces,
  activeWorkspaceId,
  onTransferComplete,
}: SendResourceToWorkspaceDialogProps) {
  const { t } = useTranslation();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [isSending, setIsSending] = useState(false);
  const workspaceIconMap = useWorkspaceIcons(workspaces);

  // Health check results for remote workspaces
  const [remoteHealthMap, setRemoteHealthMap] = useState<
    Map<string, 'ok' | 'error' | 'checking'>
  >(new Map());
  const healthCheckAbort = useRef<AbortController | null>(null);

  // All workspaces except current (both local and remote)
  const targetWorkspaces = useMemo(
    () => workspaces.filter((w) => w.id !== activeWorkspaceId),
    [activeWorkspaceId, workspaces],
  );

  // Health-check remote workspaces when dialog opens
  useEffect(() => {
    if (!open) {
      healthCheckAbort.current?.abort();
      return;
    }

    healthCheckAbort.current?.abort();
    const abort = new AbortController();
    healthCheckAbort.current = abort;

    const remoteTargets = targetWorkspaces.filter((w) => w.remoteServer);
    if (remoteTargets.length === 0) return;

    // Mark all remote as checking
    setRemoteHealthMap(() => {
      const next = new Map<string, 'ok' | 'error' | 'checking'>();
      for (const ws of remoteTargets) next.set(ws.id, 'checking');
      return next;
    });

    // Fire parallel checks
    for (const ws of remoteTargets) {
      window.electronAPI
        .testRemoteConnection(ws.remoteServer!.url, ws.remoteServer!.token)
        .then((result) => {
          if (abort.signal.aborted) return;
          setRemoteHealthMap((prev) =>
            new Map(prev).set(ws.id, result.ok ? 'ok' : 'error'),
          );
        })
        .catch(() => {
          if (abort.signal.aborted) return;
          setRemoteHealthMap((prev) => new Map(prev).set(ws.id, 'error'));
        });
    }

    return () => abort.abort();
  }, [open, targetWorkspaces]);

  const handleSend = useCallback(async () => {
    if (!selectedWorkspaceId || !activeWorkspaceId || resourceIds.length === 0)
      return;

    const targetWorkspace = workspaces.find(
      (w) => w.id === selectedWorkspaceId,
    );
    if (!targetWorkspace) return;

    setIsSending(true);
    const targetName = targetWorkspace.name;
    const { singular, plural } = RESOURCE_TYPE_LABELS[resourceType];
    const count = resourceIds.length;
    const label = count === 1 ? singular : plural;
    const mode: ResourceImportMode = 'skip';

    const toastId = toast.loading(
      `Sending ${resourceLabel} to ${targetName}...`,
    );

    try {
      // 1. Export the selected resource(s) from current workspace
      const exportOptions: ExportResourcesOptions = {};
      if (resourceType === 'source') exportOptions.sources = resourceIds;
      else if (resourceType === 'skill') exportOptions.skills = resourceIds;
      else if (resourceType === 'automation')
        exportOptions.automations = resourceIds;

      const { bundle } = await window.electronAPI.exportResources(
        activeWorkspaceId,
        exportOptions,
      );

      // 2. Import into target workspace
      let importResult: ResourceImportResult;
      if (targetWorkspace.remoteServer) {
        // Remote target — use invokeOnServer
        const { url, token, remoteWorkspaceId } = targetWorkspace.remoteServer;
        importResult = (await window.electronAPI.invokeOnServer(
          url,
          token,
          'resources:import',
          remoteWorkspaceId,
          bundle,
          mode,
        )) as ResourceImportResult;
      } else {
        // Local target — direct RPC
        importResult = await window.electronAPI.importResources(
          selectedWorkspaceId,
          bundle,
          mode,
        );
      }

      // 3. Report result
      const bucketKey: keyof ResourceImportResult =
        resourceType === 'source'
          ? 'sources'
          : resourceType === 'skill'
            ? 'skills'
            : 'automations';
      const bucket = importResult[bucketKey];
      const imported = bucket?.imported?.length ?? 0;
      const skipped = bucket?.skipped?.length ?? 0;

      if (imported > 0 && skipped === 0) {
        toast.success(`Sent ${resourceLabel} to ${targetName}`, {
          id: toastId,
        });
      } else if (imported > 0 && skipped > 0) {
        toast.success(`Sent ${imported} ${label}, ${skipped} already existed`, {
          id: toastId,
        });
      } else if (skipped > 0) {
        toast.info(`${resourceLabel} already exists in ${targetName}`, {
          id: toastId,
        });
      } else {
        toast.warning(`Nothing was sent to ${targetName}`, { id: toastId });
      }

      onOpenChange(false);
      setSelectedWorkspaceId(null);
      onTransferComplete?.();
    } catch (error: unknown) {
      const errorCode =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      const errorMessage = error instanceof Error ? error.message : undefined;
      const isUnsupported =
        errorCode === 'CHANNEL_NOT_FOUND' ||
        (errorMessage ?? '').includes('No handler for');
      const message = isUnsupported
        ? `${targetName} is running an older version that doesn't support resource import. Update the remote server and try again.`
        : (errorMessage ?? 'Unknown error');
      toast.error(`Failed to send ${label}`, {
        id: toastId,
        description: message,
      });
    } finally {
      setIsSending(false);
    }
  }, [
    selectedWorkspaceId,
    activeWorkspaceId,
    resourceIds,
    resourceType,
    resourceLabel,
    workspaces,
    onOpenChange,
    onTransferComplete,
  ]);
  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isSending) {
          onOpenChange(isOpen);
          if (!isOpen) setSelectedWorkspaceId(null);
        }
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            Send to Workspace
          </DialogTitle>
          <DialogDescription>
            Send {resourceLabel} to another workspace.
          </DialogDescription>
        </DialogHeader>

        {/* Workspace list */}
        <div className="flex flex-col gap-1 max-h-64 overflow-y-auto py-1">
          {targetWorkspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground px-2 py-4 text-center">
              No other workspaces available.
            </p>
          ) : (
            targetWorkspaces.map((workspace) => {
              const isSelected = selectedWorkspaceId === workspace.id;
              const isRemote = !!workspace.remoteServer;
              const healthStatus = remoteHealthMap.get(workspace.id);
              const isDisconnected = isRemote && healthStatus === 'error';
              const isChecking = isRemote && healthStatus === 'checking';
              const displayName = getWorkspaceDisplayName(workspace, t);

              return (
                <button
                  key={workspace.id}
                  type="button"
                  disabled={isSending || isDisconnected}
                  onClick={() => setSelectedWorkspaceId(workspace.id)}
                  className={cn(
                    'flex items-center gap-2 w-full px-2 py-2 rounded-md text-left text-sm transition-colors',
                    'hover:bg-foreground/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isSelected && 'bg-foreground/10 ring-1 ring-foreground/15',
                    isDisconnected &&
                      'opacity-50 cursor-not-allowed hover:bg-transparent',
                  )}
                >
                  <CrossfadeAvatar
                    src={workspaceIconMap.get(workspace.id)}
                    alt={displayName}
                    className="h-5 w-5 rounded-full ring-1 ring-border/50 shrink-0"
                    fallbackClassName="bg-muted text-[10px] rounded-full"
                    fallback={getWorkspaceInitial(workspace, t)}
                  />
                  <span className="flex-1 truncate">{displayName}</span>
                  {isRemote ? (
                    isDisconnected ? (
                      <CloudOff className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                    ) : (
                      <Cloud
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          isChecking
                            ? 'text-muted-foreground/30 animate-pulse'
                            : 'text-muted-foreground',
                        )}
                      />
                    )
                  ) : (
                    <Monitor className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                  )}
                </button>
              );
            })
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={!selectedWorkspaceId || isSending}
          >
            {isSending ? 'Sending...' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
