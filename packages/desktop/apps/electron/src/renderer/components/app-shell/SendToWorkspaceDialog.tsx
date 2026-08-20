/**
 * SendToWorkspaceDialog — Transfer sessions to remote workspaces.
 *
 * Shows a workspace picker filtered to remote workspaces only (sending
 * between local workspaces on the same machine is pointless).
 * Disconnected remote workspaces are shown as disabled with a CloudOff icon.
 *
 * Uses invokeOnServer for cross-server transfer:
 * 1. Generate a mini-summary handoff payload from the current server
 * 2. Import that summarized payload on the target server via temporary connection
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import { useState, useCallback, useEffect, useRef } from 'react'
import { Cloud, CloudOff, Send } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CrossfadeAvatar } from '@/components/ui/avatar'
import { useWorkspaceIcons } from '@/hooks/useWorkspaceIcon'
import { cn } from '@/lib/utils'
import { getWorkspaceDisplayName, getWorkspaceInitial } from '@/utils/workspace'
import type { Workspace } from '../../../shared/types'

export interface SendToWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Session IDs to transfer */
  sessionIds: string[]
  /** All workspaces */
  workspaces: Workspace[]
  /** Current workspace ID (excluded from picker) */
  activeWorkspaceId: string | null
  /** Called after successful transfer with target workspace ID and new session IDs */
  onTransferComplete?: (targetWorkspaceId: string, newSessionIds: string[]) => void
}

export function SendToWorkspaceDialog({
  open,
  onOpenChange,
  sessionIds,
  workspaces,
  activeWorkspaceId,
  onTransferComplete,
}: SendToWorkspaceDialogProps) {
  const { t } = useTranslation()
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [isTransferring, setIsTransferring] = useState(false)
  // Normalized overall progress (0–1) across all sessions in the batch
  const [overallProgress, setOverallProgress] = useState(0)
  const workspaceIconMap = useWorkspaceIcons(workspaces)

  // Listen for chunk upload progress from main process and normalize across batch
  useEffect(() => {
    if (!isTransferring) {
      setOverallProgress(0)
      return
    }
    const cleanup = window.electronAPI.onTransferProgress((p) => {
      // Each session contributes 1/sessionCount to the total.
      // Within a session, chunkSent/chunkTotal fills that slice.
      const sessionSlice = 1 / p.sessionCount
      const withinSession = p.chunkTotal > 0 ? p.chunkSent / p.chunkTotal : 1
      setOverallProgress(p.sessionIndex * sessionSlice + withinSession * sessionSlice)
    })
    return cleanup
  }, [isTransferring])

  // Health check results for remote workspaces (checked on dialog open)
  const [remoteHealthMap, setRemoteHealthMap] = useState<Map<string, 'ok' | 'error' | 'checking'>>(new Map())
  const healthCheckAbort = useRef<AbortController | null>(null)

  // Only show remote workspaces (local-to-local is pointless)
  const remoteWorkspaces = workspaces.filter(w => w.id !== activeWorkspaceId && w.remoteServer)

  // Check connectivity for all remote workspaces when dialog opens
  useEffect(() => {
    if (!open) {
      healthCheckAbort.current?.abort()
      return
    }

    // Cancel any in-flight checks
    healthCheckAbort.current?.abort()
    const abort = new AbortController()
    healthCheckAbort.current = abort

    if (remoteWorkspaces.length === 0) return

    // Mark all as checking
    setRemoteHealthMap(() => {
      const next = new Map<string, 'ok' | 'error' | 'checking'>()
      for (const ws of remoteWorkspaces) next.set(ws.id, 'checking')
      return next
    })

    // Fire parallel checks
    for (const ws of remoteWorkspaces) {
      window.electronAPI.testRemoteConnection(ws.remoteServer!.url, ws.remoteServer!.token)
        .then(result => {
          if (abort.signal.aborted) return
          setRemoteHealthMap(prev => new Map(prev).set(ws.id, result.ok ? 'ok' : 'error'))
        })
        .catch(() => {
          if (abort.signal.aborted) return
          setRemoteHealthMap(prev => new Map(prev).set(ws.id, 'error'))
        })
    }

    return () => abort.abort()
  }, [open, remoteWorkspaces.map(w => w.id).join(',')])

  const handleTransfer = useCallback(async () => {
    if (!selectedWorkspaceId || sessionIds.length === 0) return

    const targetWorkspace = workspaces.find(w => w.id === selectedWorkspaceId)
    if (!targetWorkspace?.remoteServer) return

    setIsTransferring(true)
    const targetName = targetWorkspace.name
    const count = sessionIds.length

    const toastId = toast.loading(t('sendToWorkspace.sending', { count, target: targetName }))

    try {
      const newSessionIds: string[] = []

      for (let i = 0; i < sessionIds.length; i++) {
        const sessionId = sessionIds[i]
        // Main process handles export + summary + transport (chunked for large bundles)
        const result = await window.electronAPI.transferSessionToWorkspace(sessionId, selectedWorkspaceId, i, sessionIds.length)
        newSessionIds.push(result.sessionId)
      }

      toast.success(t('sendToWorkspace.sent', { count, target: targetName }), {
        id: toastId,
        action: onTransferComplete ? {
          label: t('sendToWorkspace.open'),
          onClick: () => onTransferComplete(selectedWorkspaceId, newSessionIds),
        } : undefined,
      })

      onOpenChange(false)
      setSelectedWorkspaceId(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('sendToWorkspace.failedToSend', { count }), {
        id: toastId,
        description: message,
      })
    } finally {
      setIsTransferring(false)
    }
  }, [selectedWorkspaceId, sessionIds, workspaces, onOpenChange, onTransferComplete])

  const count = sessionIds.length

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isTransferring) {
        onOpenChange(isOpen)
        if (!isOpen) setSelectedWorkspaceId(null)
      }
    }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            {t("sendToWorkspace.title")}
          </DialogTitle>
          <DialogDescription>
            {t("sendToWorkspace.description", { count })}
          </DialogDescription>
        </DialogHeader>

        {/* Workspace list — remote only */}
        <div className="flex flex-col gap-1 max-h-64 overflow-y-auto py-1">
          {remoteWorkspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground px-2 py-4 text-center">
              {t("sendToWorkspace.noRemoteWorkspaces")}
            </p>
          ) : (
            remoteWorkspaces.map(workspace => {
              const isSelected = selectedWorkspaceId === workspace.id
              const healthStatus = remoteHealthMap.get(workspace.id)
              const isDisconnected = healthStatus === 'error'
              const isChecking = healthStatus === 'checking'
              const displayName = getWorkspaceDisplayName(workspace, t)

              return (
                <button
                  key={workspace.id}
                  type="button"
                  disabled={isTransferring || isDisconnected}
                  onClick={() => setSelectedWorkspaceId(workspace.id)}
                  className={cn(
                    'flex items-center gap-2 w-full px-2 py-2 rounded-md text-left text-sm transition-colors',
                    'hover:bg-foreground/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isSelected && 'bg-foreground/10 ring-1 ring-foreground/15',
                    isDisconnected && 'opacity-50 cursor-not-allowed hover:bg-transparent',
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
                  {isDisconnected ? (
                    <CloudOff className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                  ) : (
                    <Cloud className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      isChecking ? 'text-muted-foreground/30 animate-pulse' : 'text-muted-foreground',
                    )} />
                  )}
                </button>
              )
            })
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isTransferring}
          >
            Cancel
          </Button>
          <TransferButton
            onClick={handleTransfer}
            disabled={!selectedWorkspaceId || isTransferring}
            isTransferring={isTransferring}
            progress={overallProgress}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Send button with purple LED border that traces around it during transfer */
function TransferButton({ onClick, disabled, isTransferring, progress }: {
  onClick: () => void
  disabled: boolean
  isTransferring: boolean
  progress: number
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const rectRef = useRef<SVGRectElement>(null)
  const [perim, setPerim] = useState(0)

  useEffect(() => {
    if (rectRef.current && isTransferring) {
      setPerim(rectRef.current.getTotalLength())
    }
  }, [isTransferring])

  return (
    <div ref={wrapperRef} className="relative">
      <Button onClick={onClick} disabled={disabled}>
        {isTransferring ? 'Sending...' : 'Send'}
      </Button>
      {isTransferring && (
        <svg
          className="absolute pointer-events-none"
          style={{ inset: '-3px', width: 'calc(100% + 6px)', height: 'calc(100% + 6px)', overflow: 'visible' }}
        >
          <rect
            ref={rectRef}
            x="1.5" y="1.5"
            width="calc(100% - 3px)" height="calc(100% - 3px)"
            rx="10" ry="10"
            fill="none"
            stroke="#8B5CF6"
            strokeWidth="2"
            strokeDasharray={perim > 0 ? `${progress * perim} ${perim}` : '0 999'}
            style={{
              transition: 'stroke-dasharray 0.2s ease-out',
              filter: 'drop-shadow(0 0 3px #8B5CF6) drop-shadow(0 0 6px rgba(139,92,246,0.3))',
            }}
          />
        </svg>
      )}
    </div>
  )
}
