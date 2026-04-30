/**
 * BatchSessionMenu - Context menu content for batch operations on multi-selected sessions.
 *
 * Self-contained component that uses hooks to access selection state, session metadata,
 * and mutation callbacks. Renders polymorphic menu items via useMenuComponents() so it
 * works in both DropdownMenu and ContextMenu scenarios.
 *
 * Mirrors the actions from MultiSelectPanel (Status, Labels, Archive) with additions
 * for Flag and Delete that make sense in a context menu.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useCallback, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Archive, Flag, FlagOff, Trash2, Tag, Send } from 'lucide-react'
import { toast } from 'sonner'
import { useMenuComponents } from '@/components/ui/menu-context'
import { useSelectedIds } from '@/hooks/useSession'
import { useSessionSelection } from '@/hooks/useSession'
import { sessionMetaMapAtom, sendToWorkspaceAtom, type SessionMeta } from '@/atoms/sessions'
import { useAppShellContext } from '@/context/AppShellContext'
import { getStateColor, getStateIcon, type SessionStatusId } from '@/config/session-status-config'
import { extractLabelId } from '@craft-agent/shared/labels'
import { LabelMenuItems, StatusMenuItems } from './SessionMenuParts'

export interface BatchSessionMenuProps {
  /** Callback to open Send to Workspace dialog for the selected sessions */
  onSendToWorkspace?: () => void
}

export function BatchSessionMenu({ onSendToWorkspace }: BatchSessionMenuProps = {}) {
  const { t } = useTranslation()
  const { MenuItem, Separator, Sub, SubTrigger, SubContent } = useMenuComponents()

  const selectedIds = useSelectedIds()
  const setSendToWorkspace = useSetAtom(sendToWorkspaceAtom)
  const { clearMultiSelect } = useSessionSelection()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  const {
    onSessionStatusChange,
    onArchiveSession,
    onUnarchiveSession,
    onFlagSession,
    onUnflagSession,
    onSessionLabelsChange,
    onDeleteSession,
    workspaces,
    sessionStatuses = [],
    labels = [],
  } = useAppShellContext()

  const hasRemoteWorkspaces = workspaces?.some(w => w.remoteServer) ?? false

  // Hydrate selected session metadata
  const selectedMetas = useMemo(() => {
    const metas: SessionMeta[] = []
    selectedIds.forEach((id) => {
      const meta = sessionMetaMap.get(id)
      if (meta) metas.push(meta)
    })
    return metas
  }, [selectedIds, sessionMetaMap])

  // Compute shared status (if all selected have the same status)
  const activeStatusId = useMemo((): SessionStatusId | null => {
    if (selectedMetas.length === 0) return null
    const first = (selectedMetas[0].sessionStatus || 'todo') as SessionStatusId
    const allSame = selectedMetas.every(meta => (meta.sessionStatus || 'todo') === first)
    return allSame ? first : null
  }, [selectedMetas])

  // Compute intersection of applied labels (only labels ALL selected sessions have)
  const appliedLabelIds = useMemo(() => {
    if (selectedMetas.length === 0) return new Set<string>()
    const toLabelSet = (meta: SessionMeta) =>
      new Set((meta.labels || []).map(entry => extractLabelId(entry)))
    const [first, ...rest] = selectedMetas.map(toLabelSet)
    const intersection = new Set(first)
    for (const labelSet of rest) {
      for (const id of [...intersection]) {
        if (!labelSet.has(id)) intersection.delete(id)
      }
    }
    return intersection
  }, [selectedMetas])

  // Check flag state: all flagged, or some/none flagged
  const allFlagged = useMemo(
    () => selectedMetas.length > 0 && selectedMetas.every(m => m.isFlagged),
    [selectedMetas]
  )

  // Batch status change
  const handleBatchSetStatus = useCallback((status: SessionStatusId) => {
    selectedIds.forEach(sessionId => {
      onSessionStatusChange(sessionId, status)
    })
  }, [selectedIds, onSessionStatusChange])

  // Batch label toggle (all-or-nothing semantics, same as MainContentPanel)
  const handleBatchToggleLabel = useCallback((labelId: string) => {
    if (!onSessionLabelsChange) return
    const allHaveLabel = selectedMetas.every(meta =>
      (meta.labels || []).some(entry => extractLabelId(entry) === labelId)
    )
    selectedMetas.forEach(meta => {
      const currentLabels = meta.labels || []
      const hasLabel = currentLabels.some(entry => extractLabelId(entry) === labelId)
      const filtered = currentLabels.filter(entry => extractLabelId(entry) !== labelId)
      const nextLabels = allHaveLabel
        ? filtered
        : (hasLabel ? currentLabels : [...currentLabels, labelId])
      onSessionLabelsChange(meta.id, nextLabels)
    })
  }, [selectedMetas, onSessionLabelsChange])

  // Batch flag/unflag
  const handleBatchFlag = useCallback(() => {
    selectedIds.forEach(id => onFlagSession(id))
    toast(`${selectedIds.size} ${selectedIds.size === 1 ? 'session' : 'sessions'} flagged`)
  }, [selectedIds, onFlagSession])

  const handleBatchUnflag = useCallback(() => {
    selectedIds.forEach(id => onUnflagSession(id))
    toast(`${selectedIds.size} ${selectedIds.size === 1 ? 'session' : 'sessions'} unflagged`)
  }, [selectedIds, onUnflagSession])

  // Batch archive
  const handleBatchArchive = useCallback(() => {
    selectedIds.forEach(id => onArchiveSession(id))
    clearMultiSelect()
    toast(`${selectedIds.size} ${selectedIds.size === 1 ? 'session' : 'sessions'} archived`)
  }, [selectedIds, onArchiveSession, clearMultiSelect])

  // Batch send to workspace
  const handleSendToWorkspace = useCallback(() => {
    if (onSendToWorkspace) {
      onSendToWorkspace()
    } else {
      setSendToWorkspace([...selectedIds])
    }
  }, [onSendToWorkspace, selectedIds, setSendToWorkspace])

  // Batch delete
  const handleBatchDelete = useCallback(async () => {
    const count = selectedIds.size
    const ids = [...selectedIds]
    // Delete one-by-one (first shows confirmation, rest skip if first is confirmed)
    const firstDeleted = await onDeleteSession(ids[0])
    if (!firstDeleted) return // User cancelled
    for (let i = 1; i < ids.length; i++) {
      await onDeleteSession(ids[i], true) // skip confirmation for remaining
    }
    clearMultiSelect()
    toast(`${count} ${count === 1 ? 'session' : 'sessions'} deleted`)
  }, [selectedIds, onDeleteSession, clearMultiSelect])

  // Resolve current status icon for the submenu trigger
  const statusIcon = activeStatusId
    ? (() => {
        const icon = getStateIcon(activeStatusId, sessionStatuses)
        return React.isValidElement(icon)
          ? React.cloneElement(icon as React.ReactElement<{ bare?: boolean }>, { bare: true })
          : icon
      })()
    : null

  const count = selectedIds.size

  return (
    <>
      {/* Header showing selection count */}
      <div className="px-2 py-1.5 text-xs text-muted-foreground font-medium">
        {t('multiSelect.selected.session', { count })}
      </div>
      <Separator />

      {/* Status submenu */}
      <Sub>
        <SubTrigger className="pr-2">
          {statusIcon ? (
            <span style={{ color: getStateColor(activeStatusId!, sessionStatuses) ?? 'var(--foreground)' }}>
              {statusIcon}
            </span>
          ) : (
            <span className="h-3.5 w-3.5" />
          )}
          <span className="flex-1">{t("sessionMenu.status")}</span>
        </SubTrigger>
        <SubContent>
          <StatusMenuItems
            sessionStatuses={sessionStatuses}
            activeStateId={activeStatusId ?? undefined}
            onSelect={handleBatchSetStatus}
            menu={{ MenuItem }}
          />
        </SubContent>
      </Sub>

      {/* Labels submenu */}
      {labels.length > 0 && (
        <Sub>
          <SubTrigger className="pr-2">
            <Tag className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebar.labels")}</span>
          </SubTrigger>
          <SubContent>
            <LabelMenuItems
              labels={labels}
              appliedLabelIds={appliedLabelIds}
              onToggle={handleBatchToggleLabel}
              menu={{ MenuItem, Separator, Sub, SubTrigger, SubContent }}
            />
          </SubContent>
        </Sub>
      )}

      {/* Flag/Unflag */}
      {allFlagged ? (
        <MenuItem onClick={handleBatchUnflag}>
          <FlagOff className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.unflagAll")}</span>
        </MenuItem>
      ) : (
        <MenuItem onClick={handleBatchFlag}>
          <Flag className="h-3.5 w-3.5 text-info" />
          <span className="flex-1">{t("sessionMenu.flagAll")}</span>
        </MenuItem>
      )}

      {/* Archive */}
      <MenuItem onClick={handleBatchArchive}>
        <Archive className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.archive")}</span>
      </MenuItem>

      {/* Send to Workspace */}
      {hasRemoteWorkspaces && (
        <MenuItem onClick={handleSendToWorkspace}>
          <Send className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.sendToWorkspace")}</span>
        </MenuItem>
      )}

      <Separator />

      {/* Delete */}
      <MenuItem onClick={handleBatchDelete} variant="destructive">
        <Trash2 className="h-3.5 w-3.5" />
        <span className="flex-1">{t("common.delete")}</span>
      </MenuItem>
    </>
  )
}
