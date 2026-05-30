import * as React from "react"
import { useTranslation } from "react-i18next"
import { AnimatePresence } from "motion/react"
import { useSetAtom } from "jotai"
import { ChevronDown, ChevronRight, Cloud, ExternalLink, Flag, Folder, FolderPlus, MessageSquare, Pencil, Pin, PinOff, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { fullscreenOverlayOpenAtom } from "@/atoms/overlay"
import { prioritizeFlaggedSessions, sendToWorkspaceAtom, type SessionMeta } from "@/atoms/sessions"
import type { Workspace } from "../../../shared/types"
import type { ViewRoute } from "../../../shared/routes"
import { CrossfadeAvatar } from "@/components/ui/avatar"
import { FadingText } from "@/components/ui/fading-text"
import { WorkspaceCreationScreen } from "@/components/workspace"
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
  StyledContextMenuSeparator,
} from "@/components/ui/styled-context-menu"
import { ContextMenuProvider } from "@/components/ui/menu-context"
import { RenameDialog } from "@/components/ui/rename-dialog"
import { SessionMenu } from "./SessionMenu"
import { SquarePenRounded } from "../icons/SquarePenRounded"
import { useSessionActions } from "@/hooks/useSessionActions"
import { useWorkspaceIcons } from "@/hooks/useWorkspaceIcon"
import { formatSessionRelativeTime, getSessionTitle, hasUnreadMeta } from "@/utils/session"
import { getWorkspaceDisplayName, isConversationWorkspace, isProtectedWorkspace } from "@/utils/workspace"
import { Spinner, Tooltip, TooltipContent, TooltipTrigger } from "@craft-agent/ui"
import type { LabelConfig } from "@craft-agent/shared/labels"
import type { SessionStatus, SessionStatusId } from "@/config/session-status-config"
import { SortableList } from "@/components/ui/sortable-list"

interface WorkspaceProjectTreeProps {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  selectedSessionId?: string | null
  workspaceSessions: Map<string, SessionMeta[]>
  loadingWorkspaceSessionIds?: Set<string>
  workspaceUnreadMap?: Record<string, boolean>
  revealRequest?: WorkspaceSessionRevealRequest | null
  onSelectWorkspace: (workspaceId: string, openInNewWindow?: boolean, options?: { route?: ViewRoute; suppressSessionListLoading?: boolean }) => void | Promise<void>
  onSelectSession: (workspaceId: string, sessionId: string) => void | Promise<void>
  onNewSession: (workspaceId: string) => void | Promise<void>
  onWorkspaceCreated?: (workspace: Workspace) => void
  onWorkspaceChanged?: () => void
  sessionStatuses?: SessionStatus[]
  labels?: LabelConfig[]
  onDeleteSession: (sessionId: string, skipConfirmation?: boolean, displayTitle?: string) => Promise<boolean>
  onFlagSession?: (sessionId: string) => void
  onUnflagSession?: (sessionId: string) => void
  onArchiveSession?: (sessionId: string) => void
  onUnarchiveSession?: (sessionId: string) => void
  onMarkSessionUnread: (sessionId: string) => void
  onSessionStatusChange: (sessionId: string, state: SessionStatusId) => void
  onRenameSession: (sessionId: string, name: string) => void
  onSessionLabelsChange?: (sessionId: string, labels: string[]) => void
}

interface WorkspaceSessionRevealRequest {
  workspaceId: string
  sessionId: string
  nonce: number
}

interface ProjectSessionMenuConfig {
  sessionStatuses: SessionStatus[]
  labels: LabelConfig[]
  hasRemoteWorkspaces: boolean
  onDelete: (sessionId: string, displayTitle?: string) => Promise<boolean>
  onFlag?: (sessionId: string) => void
  onUnflag?: (sessionId: string) => void
  onArchive?: (sessionId: string) => void
  onUnarchive?: (sessionId: string) => void
  onMarkUnread: (sessionId: string) => void
  onSessionStatusChange: (sessionId: string, state: SessionStatusId) => void
  onRenameClick: (sessionId: string, currentName: string) => void
  onLabelsChange?: (sessionId: string, labels: string[]) => void
  onSendToWorkspace: (sessionIds: string[]) => void
}

const PROJECT_SESSION_PREVIEW_LIMIT = 5

function WorkspaceHeader({
  workspace,
  displayName,
  isActive,
  iconUrl,
  isCollapsed,
  isConversation,
  isPinned,
  isProtected,
  newSessionLabel,
  openInNewWindowLabel,
  renameLabel,
  pinLabel,
  unpinLabel,
  removeLabel,
  onToggleCollapsed,
  onNewSession,
  onOpenInNewWindow,
  onRename,
  onTogglePinned,
  onRemove,
}: {
  workspace: Workspace
  displayName: string
  isActive: boolean
  iconUrl?: string
  isCollapsed: boolean
  isConversation: boolean
  isPinned: boolean
  isProtected: boolean
  newSessionLabel: string
  openInNewWindowLabel: string
  renameLabel: string
  pinLabel: string
  unpinLabel: string
  removeLabel: string
  onToggleCollapsed: () => void
  onNewSession: () => void
  onOpenInNewWindow: () => void
  onRename: () => void
  onTogglePinned: () => void
  onRemove: () => void
}) {
  const header = (
    <div className="group/project flex items-center gap-1 px-1 pt-3 pb-1">
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-expanded={!isCollapsed}
        className={cn(
          "min-w-0 flex flex-1 cursor-grab items-center gap-1.5 rounded-[6px] px-1 py-1 text-left transition-colors active:cursor-grabbing",
          "hover:bg-sidebar-hover data-[state=open]:bg-sidebar-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          isActive && "text-foreground",
          !isActive && "text-foreground/62",
          (isProtected || isConversation) && "cursor-default active:cursor-default",
        )}
      >
        {isCollapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        )}
        <CrossfadeAvatar
          src={iconUrl}
          alt={displayName}
          className={cn(
            "h-4 w-4",
            iconUrl && "rounded-[4px] ring-1 ring-border/40",
          )}
          fallbackClassName="text-muted-foreground text-[10px]"
          fallback={isConversation
            ? <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            : <Folder className="h-3.5 w-3.5 text-muted-foreground" />}
        />
        <FadingText className="min-w-0 flex-1 text-[13px] font-medium" fadeWidth={32}>
          {displayName}
        </FadingText>
        {isPinned && !isProtected && <Pin className="h-3 w-3 shrink-0 text-muted-foreground/70" />}
        {workspace.remoteServer && <Cloud className="h-3 w-3 shrink-0 text-muted-foreground/70" />}
      </button>
      <button
        type="button"
        data-no-dnd="true"
        onClick={(event) => {
          event.stopPropagation()
          onNewSession()
        }}
        title={newSessionLabel}
        aria-label={newSessionLabel}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 transition-all hover:bg-foreground/5 hover:text-foreground group-hover/project:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <SquarePenRounded className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        data-no-dnd="true"
        onClick={(event) => {
          event.stopPropagation()
          onOpenInNewWindow()
        }}
        title={openInNewWindowLabel}
        aria-label={openInNewWindowLabel}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 transition-all hover:bg-foreground/5 hover:text-foreground group-hover/project:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </button>
    </div>
  )

  return (
    <ContextMenu modal={true}>
      <ContextMenuTrigger asChild>
        {header}
      </ContextMenuTrigger>
      <StyledContextMenuContent minWidth="min-w-48">
        {!isProtected && (
          <>
            <StyledContextMenuItem onClick={onRename}>
              <Pencil className="h-3.5 w-3.5" />
              <span className="flex-1">{renameLabel}</span>
            </StyledContextMenuItem>
            <StyledContextMenuItem onClick={onTogglePinned}>
              {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              <span className="flex-1">{isPinned ? unpinLabel : pinLabel}</span>
            </StyledContextMenuItem>
            <StyledContextMenuSeparator />
          </>
        )}
        <StyledContextMenuItem onClick={onOpenInNewWindow}>
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="flex-1">{openInNewWindowLabel}</span>
        </StyledContextMenuItem>
        {!isProtected && (
          <>
            <StyledContextMenuSeparator />
            <StyledContextMenuItem onClick={onRemove} variant="destructive">
              <Trash2 className="h-3.5 w-3.5" />
              <span className="flex-1">{removeLabel}</span>
            </StyledContextMenuItem>
          </>
        )}
      </StyledContextMenuContent>
    </ContextMenu>
  )
}

function WorkspaceDragOverlay({
  workspace,
  displayName,
  isActive,
  iconUrl,
  isPinned,
}: {
  workspace: Workspace
  displayName: string
  isActive: boolean
  iconUrl?: string
  isPinned: boolean
}) {
  return (
    <div className="flex w-[260px] items-center gap-1 px-1 py-1">
      <div
        className={cn(
          "min-w-0 flex flex-1 items-center gap-1.5 rounded-[6px] px-1 py-1 text-left",
          isActive ? "text-foreground" : "text-foreground/78",
        )}
      >
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <CrossfadeAvatar
          src={iconUrl}
          alt={displayName}
          className={cn(
            "h-4 w-4",
            iconUrl && "rounded-[4px] ring-1 ring-border/40",
          )}
          fallbackClassName="text-muted-foreground text-[10px]"
          fallback={<Folder className="h-3.5 w-3.5 text-muted-foreground" />}
        />
        <FadingText className="min-w-0 flex-1 text-[13px] font-medium" fadeWidth={32}>
          {displayName}
        </FadingText>
        {isPinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground/70" />}
        {workspace.remoteServer && <Cloud className="h-3 w-3 shrink-0 text-muted-foreground/70" />}
      </div>
    </div>
  )
}

function ProjectSessionRow({
  workspaceId,
  session,
  isSelected,
  menuConfig,
  onSelect,
}: {
  workspaceId: string
  session: SessionMeta
  isSelected: boolean
  menuConfig: ProjectSessionMenuConfig
  onSelect: () => void
}) {
  const title = getSessionTitle(session)
  const renameTitle = session.name || title
  const row = (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group/session relative ml-7 mr-2 grid h-8 min-w-0 grid-cols-[minmax(0,1fr)_minmax(2.5rem,max-content)_0.375rem] items-center gap-2 rounded-[6px] px-2 text-left transition-colors",
        "hover:bg-sidebar-hover data-[state=open]:bg-sidebar-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        isSelected ? "bg-foreground/[0.055] text-foreground" : "text-foreground/78",
      )}
      data-session-id={session.id}
    >
      {session.isFlagged && (
        <span className="pointer-events-none absolute left-[-1.15rem] top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center">
          <Flag className="h-3 w-3 text-info" />
        </span>
      )}
      <span className="flex min-w-0 items-center gap-1.5">
        {session.isProcessing && <Spinner className="text-[10px] text-muted-foreground" />}
        <span className={cn(
          "truncate text-[13px] font-medium",
          hasUnreadMeta(session) && "text-foreground",
        )}>
          {title}
        </span>
      </span>
      <span className="justify-self-end whitespace-nowrap text-[11px] text-foreground/38 tabular-nums">
        {session.lastMessageAt && (
          formatSessionRelativeTime(session.lastMessageAt)
        )}
      </span>
      <span className="flex h-1.5 w-1.5 items-center justify-center justify-self-center">
        {hasUnreadMeta(session) && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </span>
    </button>
  )

  return (
    <ContextMenu modal={true}>
      <ContextMenuTrigger asChild>
        {row}
      </ContextMenuTrigger>
      <StyledContextMenuContent>
        <ContextMenuProvider>
          <SessionMenu
            item={session}
            hideMetadataActions
            sessionStatuses={menuConfig.sessionStatuses}
            labels={menuConfig.labels}
            onLabelsChange={menuConfig.onLabelsChange ? (labels) => menuConfig.onLabelsChange!(session.id, labels) : undefined}
            onRename={() => menuConfig.onRenameClick(session.id, renameTitle)}
            onFlag={() => menuConfig.onFlag?.(session.id)}
            onUnflag={() => menuConfig.onUnflag?.(session.id)}
            onArchive={() => menuConfig.onArchive?.(session.id)}
            onUnarchive={() => menuConfig.onUnarchive?.(session.id)}
            onMarkUnread={() => menuConfig.onMarkUnread(session.id)}
            onSessionStatusChange={(status) => menuConfig.onSessionStatusChange(session.id, status)}
            onOpenInNewWindow={() => window.electronAPI.openSessionInNewWindow(workspaceId, session.id)}
            onSendToWorkspace={() => menuConfig.onSendToWorkspace([session.id])}
            hasRemoteWorkspaces={menuConfig.hasRemoteWorkspaces}
            onDelete={() => void menuConfig.onDelete(session.id, title)}
          />
        </ContextMenuProvider>
      </StyledContextMenuContent>
    </ContextMenu>
  )
}

export function WorkspaceProjectTree({
  workspaces,
  activeWorkspaceId,
  selectedSessionId,
  workspaceSessions,
  loadingWorkspaceSessionIds,
  revealRequest,
  onSelectWorkspace,
  onSelectSession,
  onNewSession,
  onWorkspaceCreated,
  onWorkspaceChanged,
  sessionStatuses = [],
  labels = [],
  onDeleteSession,
  onFlagSession,
  onUnflagSession,
  onArchiveSession,
  onUnarchiveSession,
  onMarkSessionUnread,
  onSessionStatusChange,
  onRenameSession,
  onSessionLabelsChange,
}: WorkspaceProjectTreeProps) {
  const { t } = useTranslation()
  const workspaceIconMap = useWorkspaceIcons(workspaces)
  const setFullscreenOverlayOpen = useSetAtom(fullscreenOverlayOpenAtom)
  const setSendToWorkspace = useSetAtom(sendToWorkspaceAtom)
  const [showCreationScreen, setShowCreationScreen] = React.useState(false)
  const [renameDialogOpen, setRenameDialogOpen] = React.useState(false)
  const [renameSessionId, setRenameSessionId] = React.useState<string | null>(null)
  const [renameName, setRenameName] = React.useState("")
  const [renameWorkspaceDialogOpen, setRenameWorkspaceDialogOpen] = React.useState(false)
  const [renameWorkspaceId, setRenameWorkspaceId] = React.useState<string | null>(null)
  const [renameWorkspaceName, setRenameWorkspaceName] = React.useState("")
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = React.useState<Set<string>>(() => new Set())
  const [expandedWorkspaceSessionIds, setExpandedWorkspaceSessionIds] = React.useState<Set<string>>(() => new Set())
  const [optimisticWorkspaceOrder, setOptimisticWorkspaceOrder] = React.useState<string[] | null>(null)
  const hasRemoteWorkspaces = React.useMemo(() => workspaces.some(workspace => workspace.remoteServer), [workspaces])
  const workspaceOrderKey = React.useMemo(() => workspaces.map(workspace => workspace.id).join("\0"), [workspaces])

  React.useEffect(() => {
    setOptimisticWorkspaceOrder(null)
  }, [workspaceOrderKey])

  const orderedWorkspaces = React.useMemo(() => {
    const workspaceMap = new Map(workspaces.map(workspace => [workspace.id, workspace]))
    const sourceWorkspaces = optimisticWorkspaceOrder
      ? [
          ...optimisticWorkspaceOrder
            .map(id => workspaceMap.get(id))
            .filter((workspace): workspace is Workspace => Boolean(workspace)),
          ...workspaces.filter(workspace => !optimisticWorkspaceOrder.includes(workspace.id)),
        ]
      : workspaces

    return sourceWorkspaces
      .map((workspace, index) => ({ workspace, index }))
      .sort((a, b) => Number(Boolean(b.workspace.pinned)) - Number(Boolean(a.workspace.pinned)) || a.index - b.index)
      .map(({ workspace }) => workspace)
  }, [optimisticWorkspaceOrder, workspaces])
  const pinnedWorkspaces = React.useMemo(
    () => orderedWorkspaces.filter(workspace => !isConversationWorkspace(workspace) && Boolean(workspace.pinned)),
    [orderedWorkspaces],
  )
  const unpinnedWorkspaces = React.useMemo(
    () => orderedWorkspaces.filter(workspace => !isConversationWorkspace(workspace) && !workspace.pinned),
    [orderedWorkspaces],
  )
  const conversationWorkspaces = React.useMemo(
    () => orderedWorkspaces.filter(isConversationWorkspace),
    [orderedWorkspaces],
  )
  const hasProjectWorkspaces = pinnedWorkspaces.length > 0 || unpinnedWorkspaces.length > 0
  const {
    handleFlagWithToast,
    handleUnflagWithToast,
    handleArchiveWithToast,
    handleUnarchiveWithToast,
    handleDeleteWithToast,
  } = useSessionActions({
    onFlag: onFlagSession,
    onUnflag: onUnflagSession,
    onArchive: onArchiveSession,
    onUnarchive: onUnarchiveSession,
    onDelete: onDeleteSession,
  })

  const handleNewWorkspace = React.useCallback(() => {
    setShowCreationScreen(true)
    setFullscreenOverlayOpen(true)
  }, [setFullscreenOverlayOpen])

  const handleCloseCreationScreen = React.useCallback(() => {
    setShowCreationScreen(false)
    setFullscreenOverlayOpen(false)
  }, [setFullscreenOverlayOpen])

  const handleWorkspaceCreated = React.useCallback((workspace: Workspace) => {
    setShowCreationScreen(false)
    setFullscreenOverlayOpen(false)
    toast.success(t("toast.createdWorkspace", { name: workspace.name }))
    onWorkspaceCreated?.(workspace)
    void onSelectWorkspace(workspace.id)
  }, [onSelectWorkspace, onWorkspaceCreated, setFullscreenOverlayOpen, t])

  const handleRenameClick = React.useCallback((sessionId: string, currentName: string) => {
    setRenameSessionId(sessionId)
    setRenameName(currentName)
    requestAnimationFrame(() => {
      setRenameDialogOpen(true)
    })
  }, [])

  const handleRenameDialogOpenChange = React.useCallback((open: boolean) => {
    setRenameDialogOpen(open)
    if (!open) {
      setRenameSessionId(null)
      setRenameName("")
    }
  }, [])

  const handleRenameSubmit = React.useCallback(() => {
    if (renameSessionId && renameName.trim()) {
      onRenameSession(renameSessionId, renameName.trim())
    }
    setRenameDialogOpen(false)
    setRenameSessionId(null)
    setRenameName("")
  }, [onRenameSession, renameName, renameSessionId])

  const handleWorkspaceRenameClick = React.useCallback((workspace: Workspace) => {
    if (isProtectedWorkspace(workspace)) return
    setRenameWorkspaceId(workspace.id)
    setRenameWorkspaceName(workspace.name)
    requestAnimationFrame(() => {
      setRenameWorkspaceDialogOpen(true)
    })
  }, [])

  const handleWorkspaceRenameDialogOpenChange = React.useCallback((open: boolean) => {
    setRenameWorkspaceDialogOpen(open)
    if (!open) {
      setRenameWorkspaceId(null)
      setRenameWorkspaceName("")
    }
  }, [])

  const handleWorkspaceRenameSubmit = React.useCallback(async () => {
    const nextName = renameWorkspaceName.trim()
    if (!renameWorkspaceId || !nextName) return

    try {
      await window.electronAPI.updateWorkspaceSetting(renameWorkspaceId, "name", nextName)
      onWorkspaceChanged?.()
    } catch (error) {
      const message = error instanceof Error ? error.message : t("toast.unknownError")
      toast.error(t("toast.failedToSaveSetting", { setting: t("common.rename") }), {
        description: message,
      })
    } finally {
      setRenameWorkspaceDialogOpen(false)
      setRenameWorkspaceId(null)
      setRenameWorkspaceName("")
    }
  }, [onWorkspaceChanged, renameWorkspaceId, renameWorkspaceName, t])

  const handleToggleWorkspacePinned = React.useCallback(async (workspace: Workspace) => {
    if (isProtectedWorkspace(workspace)) return
    const pinned = !workspace.pinned
    try {
      const saved = await window.electronAPI.setWorkspacePinned(workspace.id, pinned)
      if (!saved) {
        toast.error(t("toast.failedToSaveSetting", { setting: t(pinned ? "workspace.pinWorkspace" : "workspace.unpinWorkspace") }))
        return
      }
      toast.success(t(pinned ? "toast.pinnedWorkspace" : "toast.unpinnedWorkspace", { name: workspace.name }))
      onWorkspaceChanged?.()
    } catch (error) {
      const message = error instanceof Error ? error.message : t("toast.unknownError")
      toast.error(t("toast.failedToSaveSetting", { setting: t(pinned ? "workspace.pinWorkspace" : "workspace.unpinWorkspace") }), {
        description: message,
      })
    }
  }, [onWorkspaceChanged, t])

  const handleRemoveWorkspace = React.useCallback(async (workspace: Workspace) => {
    if (isProtectedWorkspace(workspace)) return
    if (workspaces.length <= 1) {
      toast.error(t("toast.cannotRemoveOnlyWorkspace"))
      return
    }

    try {
      const removed = await window.electronAPI.removeWorkspace(workspace.id)
      if (!removed) {
        toast.error(t("toast.failedToRemoveWorkspace"))
        return
      }

      toast.success(t("toast.removedWorkspace", { name: workspace.name }))

      if (workspace.id === activeWorkspaceId) {
        const remaining = await window.electronAPI.getWorkspaces()
        const nextWorkspace = remaining[0]
        if (nextWorkspace) {
          await Promise.resolve(onSelectWorkspace(nextWorkspace.id))
        }
      }

      onWorkspaceChanged?.()
    } catch (error) {
      const message = error instanceof Error ? error.message : t("toast.unknownError")
      toast.error(t("toast.failedToRemoveWorkspace"), {
        description: message,
      })
    }
  }, [activeWorkspaceId, onSelectWorkspace, onWorkspaceChanged, t, workspaces.length])

  const toggleWorkspaceCollapsed = React.useCallback((workspaceId: string) => {
    setCollapsedWorkspaceIds(prev => {
      const next = new Set(prev)
      if (next.has(workspaceId)) {
        next.delete(workspaceId)
      } else {
        next.add(workspaceId)
      }
      return next
    })
  }, [])

  const handleNewProjectSession = React.useCallback((workspaceId: string) => {
    setCollapsedWorkspaceIds(prev => {
      if (!prev.has(workspaceId)) return prev
      const next = new Set(prev)
      next.delete(workspaceId)
      return next
    })
    void onNewSession(workspaceId)
  }, [onNewSession])

  const toggleWorkspaceSessionsExpanded = React.useCallback((workspaceId: string) => {
    setExpandedWorkspaceSessionIds(prev => {
      const next = new Set(prev)
      if (next.has(workspaceId)) {
        next.delete(workspaceId)
      } else {
        next.add(workspaceId)
      }
      return next
    })
  }, [])

  React.useEffect(() => {
    if (!revealRequest) return

    setCollapsedWorkspaceIds(prev => {
      if (!prev.has(revealRequest.workspaceId)) return prev
      const next = new Set(prev)
      next.delete(revealRequest.workspaceId)
      return next
    })

    const sessions = [...(workspaceSessions.get(revealRequest.workspaceId) ?? [])]
      .filter(session => !session.hidden && !session.isArchived)
    const sessionIndex = sessions.findIndex(session => session.id === revealRequest.sessionId)
    if (sessionIndex >= PROJECT_SESSION_PREVIEW_LIMIT) {
      setExpandedWorkspaceSessionIds(prev => {
        if (prev.has(revealRequest.workspaceId)) return prev
        const next = new Set(prev)
        next.add(revealRequest.workspaceId)
        return next
      })
    }
  }, [revealRequest, workspaceSessions])

  const handleWorkspaceGroupReorder = React.useCallback((group: "pinned" | "unpinned", reorderedGroup: Workspace[]) => {
    const pinnedIds = pinnedWorkspaces.map(workspace => workspace.id)
    const unpinnedIds = unpinnedWorkspaces.map(workspace => workspace.id)
    const reorderedIds = reorderedGroup.map(workspace => workspace.id)
    const orderedIds = group === "pinned"
      ? [...reorderedIds, ...unpinnedIds]
      : [...pinnedIds, ...reorderedIds]

    setOptimisticWorkspaceOrder(orderedIds)

    window.electronAPI.reorderWorkspaces(orderedIds)
      .then((saved) => {
        if (!saved) {
          setOptimisticWorkspaceOrder(null)
          toast.error(t("toast.failedToSaveSetting", { setting: t("sidebar.projects", "Workspaces") }))
          return
        }
        onWorkspaceChanged?.()
      })
      .catch((error) => {
        setOptimisticWorkspaceOrder(null)
        const message = error instanceof Error ? error.message : t("toast.unknownError")
        toast.error(t("toast.failedToSaveSetting", { setting: t("sidebar.projects", "Workspaces") }), {
          description: message,
        })
      })
  }, [onWorkspaceChanged, pinnedWorkspaces, t, unpinnedWorkspaces])

  const menuConfig = React.useMemo<ProjectSessionMenuConfig>(() => ({
    sessionStatuses,
    labels,
    hasRemoteWorkspaces,
    onDelete: (sessionId, displayTitle) => handleDeleteWithToast(sessionId, false, displayTitle),
    onFlag: onFlagSession ? handleFlagWithToast : undefined,
    onUnflag: onUnflagSession ? handleUnflagWithToast : undefined,
    onArchive: onArchiveSession ? handleArchiveWithToast : undefined,
    onUnarchive: onUnarchiveSession ? handleUnarchiveWithToast : undefined,
    onMarkUnread: onMarkSessionUnread,
    onSessionStatusChange,
    onRenameClick: handleRenameClick,
    onLabelsChange: onSessionLabelsChange,
    onSendToWorkspace: setSendToWorkspace,
  }), [
    sessionStatuses,
    labels,
    hasRemoteWorkspaces,
    handleDeleteWithToast,
    onFlagSession,
    handleFlagWithToast,
    onUnflagSession,
    handleUnflagWithToast,
    onArchiveSession,
    handleArchiveWithToast,
    onUnarchiveSession,
    handleUnarchiveWithToast,
    onMarkSessionUnread,
    onSessionStatusChange,
    handleRenameClick,
    onSessionLabelsChange,
    setSendToWorkspace,
  ])

  const renderWorkspaceSection = (workspace: Workspace, isSorting: boolean) => {
    const displayName = getWorkspaceDisplayName(workspace, t)
    const protectedWorkspace = isProtectedWorkspace(workspace)
    const conversationWorkspace = isConversationWorkspace(workspace)
    const isCollapsed = collapsedWorkspaceIds.has(workspace.id)
    const isSessionListExpanded = expandedWorkspaceSessionIds.has(workspace.id)
    const sessions = prioritizeFlaggedSessions([...(workspaceSessions.get(workspace.id) ?? [])])
      .filter(session => !session.hidden && !session.isArchived)
    const isLoadingSessions = loadingWorkspaceSessionIds?.has(workspace.id) ?? false
    const visibleSessions = isSessionListExpanded ? sessions : sessions.slice(0, PROJECT_SESSION_PREVIEW_LIMIT)
    const canToggleSessionList = sessions.length > PROJECT_SESSION_PREVIEW_LIMIT
    const sessionListToggleLabel = isSessionListExpanded
      ? t("sidebar.collapseDisplay")
      : t("sidebar.expandDisplay")

    return (
      <section key={workspace.id} aria-label={displayName}>
        <WorkspaceHeader
          workspace={workspace}
          displayName={displayName}
          isActive={workspace.id === activeWorkspaceId}
          iconUrl={workspaceIconMap.get(workspace.id)}
          isCollapsed={isCollapsed || isSorting}
          isConversation={conversationWorkspace}
          isPinned={Boolean(workspace.pinned)}
          isProtected={protectedWorkspace}
          newSessionLabel={t("session.newSession")}
          openInNewWindowLabel={t("sidebarMenu.openInNewWindow")}
          renameLabel={t("common.rename")}
          pinLabel={t("workspace.pinWorkspace")}
          unpinLabel={t("workspace.unpinWorkspace")}
          removeLabel={t("workspace.removeWorkspace")}
          onToggleCollapsed={() => toggleWorkspaceCollapsed(workspace.id)}
          onNewSession={() => handleNewProjectSession(workspace.id)}
          onOpenInNewWindow={() => void onSelectWorkspace(workspace.id, true)}
          onRename={() => handleWorkspaceRenameClick(workspace)}
          onTogglePinned={() => void handleToggleWorkspacePinned(workspace)}
          onRemove={() => void handleRemoveWorkspace(workspace)}
        />
        {!isSorting && !isCollapsed && sessions.length > 0 ? (
          <div className="grid gap-0.5" data-no-dnd="true">
            {visibleSessions.map((session) => (
              <ProjectSessionRow
                key={session.id}
                workspaceId={workspace.id}
                session={session}
                isSelected={session.id === selectedSessionId}
                menuConfig={menuConfig}
                onSelect={() => void onSelectSession(workspace.id, session.id)}
              />
            ))}
            {canToggleSessionList && (
              <button
                type="button"
                onClick={() => toggleWorkspaceSessionsExpanded(workspace.id)}
                aria-expanded={isSessionListExpanded}
                aria-label={sessionListToggleLabel}
                title={sessionListToggleLabel}
                className="ml-7 mr-2 flex h-8 min-w-0 items-center rounded-[6px] px-2 text-left text-[12px] font-semibold text-muted-foreground/65 transition-colors hover:bg-sidebar-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="truncate">{sessionListToggleLabel}</span>
              </button>
            )}
          </div>
        ) : !isSorting && !isCollapsed && isLoadingSessions ? (
          <div
            className="ml-7 mr-3 flex h-8 items-center gap-2 rounded-[6px] px-2 text-[12px] font-medium text-muted-foreground/70"
            data-no-dnd="true"
          >
            <Spinner className="text-muted-foreground" />
            <span className="truncate">{t("common.loading")}</span>
          </div>
        ) : !isSorting && !isCollapsed ? (
          <div
            className="ml-7 mr-3 rounded-[6px] px-2 py-1.5 text-[12px] font-medium text-muted-foreground/65"
            data-no-dnd="true"
          >
            {t("session.noSessionsYet")}
          </div>
        ) : null}
      </section>
    )
  }

  const renderWorkspaceOverlay = (workspace: Workspace) => (
    <WorkspaceDragOverlay
      workspace={workspace}
      displayName={getWorkspaceDisplayName(workspace, t)}
      isActive={workspace.id === activeWorkspaceId}
      iconUrl={workspaceIconMap.get(workspace.id)}
      isPinned={Boolean(workspace.pinned)}
    />
  )

  const renderWorkspaceGroup = (items: Workspace[], group: "pinned" | "unpinned") => {
    if (items.length === 0) return null

    return (
      <SortableList
        items={items}
        onReorder={(reorderedItems) => handleWorkspaceGroupReorder(group, reorderedItems)}
        className="grid gap-0"
        renderItem={(workspace, _isDragging, isSorting) => renderWorkspaceSection(workspace, isSorting)}
        renderOverlay={renderWorkspaceOverlay}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AnimatePresence>
        {showCreationScreen && (
          <WorkspaceCreationScreen
            onWorkspaceCreated={handleWorkspaceCreated}
            onClose={handleCloseCreationScreen}
          />
        )}
      </AnimatePresence>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3 mask-fade-bottom">
        <div className="flex shrink-0 items-center justify-between px-3 pb-2 pt-1">
          <span className="text-[12px] font-semibold text-muted-foreground">
            {t("sidebar.projects", "Workspaces")}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleNewWorkspace}
                className="flex h-7 w-7 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={t("workspace.addWorkspace")}
              >
                <FolderPlus className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{t("workspace.addWorkspace")}</TooltipContent>
          </Tooltip>
        </div>
        {renderWorkspaceGroup(pinnedWorkspaces, "pinned")}
        {renderWorkspaceGroup(unpinnedWorkspaces, "unpinned")}

        {conversationWorkspaces.length > 0 && (
          <div className={cn(hasProjectWorkspaces && "pt-3")}>
            {conversationWorkspaces.map((workspace) => renderWorkspaceSection(workspace, false))}
          </div>
        )}
      </div>
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={handleRenameDialogOpenChange}
        title={t("session.renameSession")}
        value={renameName}
        onValueChange={setRenameName}
        onSubmit={handleRenameSubmit}
        placeholder={t("session.enterSessionName")}
      />
      <RenameDialog
        open={renameWorkspaceDialogOpen}
        onOpenChange={handleWorkspaceRenameDialogOpenChange}
        title={t("settings.workspace.renameWorkspace")}
        value={renameWorkspaceName}
        onValueChange={setRenameWorkspaceName}
        onSubmit={() => void handleWorkspaceRenameSubmit()}
        placeholder={t("settings.workspace.enterWorkspaceName")}
      />
    </div>
  )
}
