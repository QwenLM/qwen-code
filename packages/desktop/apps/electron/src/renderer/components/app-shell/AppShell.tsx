import * as React from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { atom, useAtomValue, useStore } from 'jotai'
import { motion, AnimatePresence } from 'motion/react'
import {
  Archive,
  Settings,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  RotateCw,
  Flag,
  ListFilter,
  Tag,
  Check,
  X,
  Search,
  Plus,
  Trash2,
  Zap,
  Inbox,
  Calendar,
  Layers,
  ListTodo,
  Clock,
  Radio,
  Bot,
  Info,
  Store,
} from 'lucide-react'
// SessionStatusIcons no longer used - icons come from dynamic sessionStatuses
import { TopBar } from './TopBar'
import { AboutDialog } from '../AboutDialog'
import { BRAND } from '@craft-agent/shared/branding'
import { FEATURE_FLAGS } from '@craft-agent/shared/feature-flags'
import { SquarePenRounded } from '../icons/SquarePenRounded'
import { cn } from '@/lib/utils'
import { isMac } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from '@/components/ui/styled-dropdown'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
} from '@/components/ui/styled-context-menu'
import { ContextMenuProvider } from '@/components/ui/menu-context'
import { SidebarMenu } from './SidebarMenu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FadingText } from '@/components/ui/fading-text'
import {
  Collapsible,
  CollapsibleTrigger,
  AnimatedCollapsibleContent,
  springTransition as collapsibleSpring,
} from '@/components/ui/collapsible'
import { SessionList, type ChatGroupingMode } from './SessionList'
import { MainContentPanel } from './MainContentPanel'
import { PanelStackContainer } from './PanelStackContainer'
import { BrowserDockPanel } from './BrowserDockPanel'
import type { ChatDisplayHandle } from './ChatDisplay'
import { LeftSidebar } from './LeftSidebar'
import { WorkspaceProjectTree } from './WorkspaceProjectTree'
import { useSession } from '@/hooks/useSession'
import {
  ensureSessionMessagesLoadedAtom,
  sessionAtomFamily,
} from '@/atoms/sessions'
import {
  AppShellProvider,
  type AppShellContextType,
} from '@/context/AppShellContext'
import {
  EscapeInterruptProvider,
  useEscapeInterrupt,
} from '@/context/EscapeInterruptContext'
import { useTheme } from '@/context/ThemeContext'
import { getResizeGradientStyle } from '@/hooks/useResizeGradient'
import { useAction, useActionLabel } from '@/actions'
import { useFocusZone } from '@/hooks/keyboard'
import { useFocusContext } from '@/context/FocusContext'
import { getSessionTitle } from '@/utils/session'
import { useSetAtom } from 'jotai'
import type {
  Session,
  Workspace,
  FileAttachment,
  PermissionRequest,
  LoadedSource,
  LoadedSkill,
  PermissionMode,
  SourceFilter,
  AutomationFilter,
} from '../../../shared/types'
import { PERMISSION_MODE_ORDER } from '@craft-agent/shared/agent/mode-types'
import {
  areSessionMetaListsEquivalent,
  compareSessionsByActivityDesc,
  getWorkspaceSessionMetas,
  mergeStableSessionMetaList,
  sessionMetaMapAtom,
  sendToWorkspaceAtom,
  workspaceSessionMetaCacheAtom,
  workspaceSessionsAtom,
  type SessionMeta,
} from '@/atoms/sessions'
import { sourcesAtom } from '@/atoms/sources'
import { skillsAtom } from '@/atoms/skills'
import {
  panelStackAtom,
  panelCountAtom,
  focusedPanelIdAtom,
  focusedPanelRouteAtom,
  focusedSessionIdAtom,
  focusNextPanelAtom,
  focusPrevPanelAtom,
  parseSessionIdFromRoute,
} from '@/atoms/panel-stack'
import {
  type SessionStatusId,
  type SessionStatus,
  statusConfigsToSessionStatuses,
} from '@/config/session-status-config'
import { useStatuses } from '@/hooks/useStatuses'
import { useLabels } from '@/hooks/useLabels'
import { useViews } from '@/hooks/useViews'
import { defaultSessionOptions } from '@/hooks/useSessionOptions'
import { useContainerWidth } from '@/hooks/useContainerWidth'
import { LabelIcon, LabelValueTypeIcon } from '@/components/ui/label-icon'
import { filterSessionStatuses as filterLabelMenuStates } from '@/components/ui/label-menu'
import {
  createLabelMenuItems,
  filterItems as filterLabelMenuItems,
  type LabelMenuItem,
} from '@/components/ui/label-menu-utils'
import {
  getDescendantIds,
  getLabelDisplayName,
  flattenLabels,
  extractLabelId,
  findLabelById,
  sortLabelsForDisplay,
} from '@craft-agent/shared/labels'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { resolveEntityColor } from '@craft-agent/shared/colors'
import * as storage from '@/lib/local-storage'
import { toast } from 'sonner'
import { navigate, routes } from '@/lib/navigate'
import { loadProjectWorkspaceSessionSnapshot } from '@/lib/project-session-snapshots'
import { shouldLoadWorkspaceSkills } from '@/lib/skills-loading'
import {
  getQwenCapabilityCacheKey,
  getWorkspaceSkillsCacheKey,
  providerSkillsFromQwenCapabilities,
  qwenCapabilitiesFromSkills,
  type QwenCapabilitySnapshot,
} from '@/lib/qwen-capability-cache'
import {
  useNavigation,
  useNavigationState,
  isSessionsNavigation,
  isSourcesNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
  isSkillMarketplaceNavigation,
  isAutomationsNavigation,
  type NavigationState,
} from '@/contexts/NavigationContext'
import type { SettingsSubpage } from '../../../shared/types'
import { SourcesListPanel } from './SourcesListPanel'
import { SkillsListPanel } from './SkillsListPanel'
import { SkillMarketplacePanel } from './SkillMarketplacePanel'
import { AutomationsListPanel } from '../automations/AutomationsListPanel'
import {
  APP_EVENTS,
  AGENT_EVENTS,
  type AutomationFilterKind,
  AUTOMATION_TYPE_TO_FILTER_KIND,
} from '../automations/types'
import { useAutomations } from '@/hooks/useAutomations'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog'
import { PanelHeader } from './PanelHeader'
import { SendToWorkspaceDialog } from './SendToWorkspaceDialog'
import { MessagingDialogHost } from '@/components/messaging/MessagingDialogHost'
import {
  EditPopover,
  getEditConfig,
  type EditContextKey,
} from '@/components/ui/EditPopover'
import SettingsNavigator from '@/pages/settings/SettingsNavigator'
import {
  PANEL_GAP,
  PANEL_EDGE_INSET,
  PANEL_SASH_HALF_HIT_WIDTH,
  PANEL_SASH_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
  PANEL_STACK_VERTICAL_OVERFLOW,
  RADIUS_EDGE,
  RADIUS_INNER,
} from './panel-constants'
import { hasOpenOverlay } from '@/lib/overlay-detection'
import { getNextPermissionMode } from '@/lib/permission-mode-cycle'
import { clearSourceIconCaches } from '@/lib/icon-cache'
import { dispatchFocusInputEvent } from './input/focus-input-events'
import { resolveEffectiveConnectionSlug } from '@config/llm-connections'
import { getWorkspaceDisplayName } from '@/utils/workspace'

/**
 * AppShellProps - Minimal props interface for AppShell component
 *
 * Data and callbacks come via contextValue (AppShellContextType).
 * Only UI-specific state is passed as separate props.
 *
 * Adding new features:
 * 1. Add to AppShellContextType in context/AppShellContext.tsx
 * 2. Update App.tsx to include in contextValue
 * 3. Use via useAppShellContext() hook in child components
 */
interface AppShellProps {
  /** All data and callbacks - passed directly to AppShellProvider */
  contextValue: AppShellContextType
  /** UI-specific props */
  defaultLayout?: number[]
  defaultCollapsed?: boolean
  menuNewChatTrigger?: number
  /** Focused mode - hides sidebars, shows only the chat content */
  isFocusedMode?: boolean
  /** True while the active workspace session list is refreshing. */
  isSessionListLoading?: boolean
  /** Reports when the project tree's cross-workspace session snapshots are ready. */
  onProjectSessionSnapshotsReadyChange?: (ready: boolean) => void
}

interface ProjectSessionRevealRequest {
  workspaceId: string
  sessionId: string
  nonce: number
}

interface SessionSearchResult {
  session: SessionMeta
  workspace: Workspace
  workspaceName: string
}

type WorkspaceSkillsState = {
  skills: LoadedSkill[]
  status: 'loading' | 'ready' | 'error'
  requestId: number
}

const EMPTY_SKILLS: LoadedSkill[] = []
const EMPTY_SESSION_ATOM = atom<Session | null>(null)

function SidebarSessionSearch({
  workspaces,
  workspaceSessions,
  activeWorkspaceId,
  selectedSessionId,
  onSelectSession,
  onRevealSession,
}: {
  workspaces: Workspace[]
  workspaceSessions: Map<string, SessionMeta[]>
  activeWorkspaceId: string | null
  selectedSessionId?: string | null
  onSelectSession: (
    workspaceId: string,
    sessionId: string,
  ) => void | Promise<void>
  onRevealSession: (workspaceId: string, sessionId: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const workspacesById = React.useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  )

  const results = React.useMemo<SessionSearchResult[]>(() => {
    const matches: SessionSearchResult[] = []

    for (const [workspaceId, sessions] of workspaceSessions) {
      const workspace = workspacesById.get(workspaceId)
      if (!workspace) continue

      const workspaceName = getWorkspaceDisplayName(workspace, t)
      for (const session of sessions) {
        if (session.hidden || session.isArchived) continue
        const title = getSessionTitle(session)
        if (
          normalizedQuery &&
          !title.toLocaleLowerCase().includes(normalizedQuery)
        ) {
          continue
        }

        matches.push({ session, workspace, workspaceName })
      }
    }

    return matches
      .sort((a, b) => compareSessionsByActivityDesc(a.session, b.session))
      .slice(0, 12)
  }, [normalizedQuery, t, workspaceSessions, workspacesById])

  React.useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) setQuery('')
  }, [])

  const handleSelectResult = React.useCallback(
    (result: SessionSearchResult) => {
      onRevealSession(result.workspace.id, result.session.id)
      setOpen(false)
      setQuery('')
      void onSelectSession(result.workspace.id, result.session.id)
    },
    [onRevealSession, onSelectSession],
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            'group flex w-full items-center gap-2 rounded-[6px] px-2 py-[5px]',
            'text-[13px] font-normal select-none outline-none titlebar-no-drag',
            'hover:bg-sidebar-hover data-[state=open]:bg-sidebar-hover',
            'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
          )}
        >
          <Search
            className="h-3.5 w-3.5 shrink-0"
            style={{
              color: 'color-mix(in oklch, var(--foreground) 60%, transparent)',
            }}
          />
          <span className="min-w-0 flex-1 truncate text-left">
            {t('sidebar.search')}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-black/25"
        className={cn(
          'titlebar-no-drag w-[440px] max-w-[calc(100vw-32px)] overflow-hidden p-0 gap-0',
          'border border-foreground/10 bg-popover/92 text-popover-foreground shadow-modal-small backdrop-blur-xl',
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <DialogTitle className="sr-only">{t('sidebar.search')}</DialogTitle>
        <div className="border-b border-foreground/8 px-4 py-3">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('session.searchSessionsPlaceholder')}
              className="h-7 min-w-0 flex-1 bg-transparent text-[14px] font-medium text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
        <div className="px-2 py-2">
          <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            {normalizedQuery
              ? t('session.results', { count: results.length })
              : t('session.recentSessions')}
          </div>
          <div className="max-h-[360px] overflow-y-auto pr-1">
            {results.length > 0 ? (
              <div className="grid gap-0.5">
                {results.map((result) => {
                  const title = getSessionTitle(result.session)
                  const isActive =
                    result.workspace.id === activeWorkspaceId &&
                    result.session.id === selectedSessionId

                  return (
                    <button
                      type="button"
                      key={`${result.workspace.id}:${result.session.id}`}
                      onClick={() => handleSelectResult(result)}
                      className={cn(
                        'grid h-9 min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-[7px] px-2 text-left',
                        'text-[13px] text-foreground/86 transition-colors hover:bg-foreground/[0.055]',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                        isActive && 'bg-foreground/[0.07] text-foreground',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'h-2.5 w-2.5 rounded-full border border-foreground/35',
                          result.session.isProcessing &&
                            'border-accent/80 bg-accent/20',
                        )}
                      />
                      <span className="min-w-0 truncate font-medium">
                        {title}
                      </span>
                      <span className="min-w-0 max-w-[8rem] truncate text-[12px] text-muted-foreground">
                        {result.workspaceName}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="flex h-24 items-center justify-center rounded-[8px] text-[13px] font-medium text-muted-foreground">
                {t('session.noSessionsFound')}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Filter mode for tri-state filtering: include shows only matching, exclude hides matching */
type FilterMode = 'include' | 'exclude'

const altClickTooltipLabel = isMac
  ? '⌥ click to exclude'
  : 'Alt click to exclude'
const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 320
const SESSION_LIST_MIN_WIDTH = 240
const SESSION_LIST_MAX_WIDTH = 480

/** Wraps children in a Tooltip that shows instantly on hover — only rendered when `show` is true. */
function AltExcludeTooltip({
  show,
  children,
}: {
  show: boolean
  children: React.ReactNode
}) {
  if (!show) return children
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        {altClickTooltipLabel}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * FilterModeBadge - Display-only badge showing the current filter mode.
 * Shows a checkmark for 'include' and an X for 'exclude'. Used as a visual
 * indicator inside DropdownMenuSubTrigger rows (the actual mode switching
 * happens via the sub-menu content, not this badge).
 */
function FilterModeBadge({ mode }: { mode: FilterMode }) {
  return (
    <span
      className={cn(
        'flex items-center justify-center h-5 w-5 rounded-[4px] -mr-1',
        mode === 'include'
          ? 'bg-background text-foreground shadow-minimal'
          : 'bg-destructive/10 text-destructive shadow-tinted',
      )}
      style={
        mode === 'exclude'
          ? ({
              '--shadow-color': 'var(--destructive-rgb)',
            } as React.CSSProperties)
          : undefined
      }
    >
      {mode === 'include' ? (
        <Check className="!h-2.5 !w-2.5" />
      ) : (
        <X className="!h-2.5 !w-2.5" />
      )}
    </span>
  )
}

/**
 * FilterModeSubMenuItems - Shared sub-menu content for switching filter mode.
 * Renders Include / Exclude / Remove options using StyledDropdownMenuItem for
 * consistent styling. Used inside StyledDropdownMenuSubContent by both leaf
 * and group label items when they have an active filter mode.
 */
function FilterModeSubMenuItems({
  mode,
  onChangeMode,
  onRemove,
}: {
  mode: FilterMode
  onChangeMode: (mode: FilterMode) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <StyledDropdownMenuItem
        onClick={(e) => {
          e.preventDefault()
          onChangeMode('include')
        }}
        className={cn(mode === 'include' && 'bg-foreground/[0.03]')}
      >
        <Check className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{t('filter.include')}</span>
      </StyledDropdownMenuItem>
      <StyledDropdownMenuItem
        onClick={(e) => {
          e.preventDefault()
          onChangeMode('exclude')
        }}
        className={cn(mode === 'exclude' && 'bg-foreground/[0.03]')}
      >
        <X className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{t('filter.exclude')}</span>
      </StyledDropdownMenuItem>
      <StyledDropdownMenuSeparator />
      <StyledDropdownMenuItem
        onClick={(e) => {
          e.preventDefault()
          onRemove()
        }}
      >
        <Trash2 className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{t('common.clear')}</span>
      </StyledDropdownMenuItem>
    </>
  )
}

/**
 * FilterMenuRow - Consistent layout for filter menu items.
 * Enforces: [icon 14px box] [label flex] [accessory 12px box]
 */
function FilterMenuRow({
  icon,
  label,
  accessory,
  iconClassName,
  iconStyle,
  noIconContainer,
}: {
  icon: React.ReactNode
  label: React.ReactNode
  accessory?: React.ReactNode
  /** Additional classes for icon container (e.g., for status icon scaling) */
  iconClassName?: string
  /** Style for icon container (e.g., for status icon color) */
  iconStyle?: React.CSSProperties
  /** When true, skip the icon container (for icons that have their own container) */
  noIconContainer?: boolean
}) {
  return (
    <>
      {noIconContainer ? (
        // Wrapper for color inheritance. Clone icon to add bare prop (removes EntityIcon container).
        <span style={iconStyle}>
          {React.isValidElement(icon)
            ? React.cloneElement(
                icon as React.ReactElement<{ bare?: boolean }>,
                { bare: true },
              )
            : icon}
        </span>
      ) : (
        <span
          className={cn(
            'h-3.5 w-3.5 flex items-center justify-center shrink-0',
            iconClassName,
          )}
          style={iconStyle}
        >
          {icon}
        </span>
      )}
      <span className="flex-1">{label}</span>
      <span className="shrink-0">{accessory}</span>
    </>
  )
}

/**
 * FilterLabelItems - Recursive component for rendering label tree in the filter dropdown.
 *
 * Rendering rules by label state:
 * - **Inactive leaf**: StyledDropdownMenuItem — click to add as 'include'
 * - **Active leaf**: DropdownMenuSub — SubTrigger shows label + mode badge, SubContent
 *   has Include/Exclude/Remove options (uses Radix's built-in safe-triangle hover)
 * - **Group (with children)**: Always a DropdownMenuSub. When active, SubContent shows
 *   mode options first, then separator, then children. When inactive, shows a self-toggle
 *   item, then separator, then children.
 * - **Pinned labels**: Shown with a check mark, non-interactive (no toggle/sub-menu).
 */
function FilterLabelItems({
  labels,
  labelFilter,
  setLabelFilter,
  pinnedLabelId,
  altHeld,
}: {
  labels: LabelConfig[]
  labelFilter: Map<string, FilterMode>
  setLabelFilter: (
    updater:
      | Map<string, FilterMode>
      | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>),
  ) => void
  /** Label ID pinned by the current route (non-removable, shown as checked+disabled) */
  pinnedLabelId?: string | null
  altHeld?: boolean
}) {
  /** Toggle a label filter: if active → remove, if inactive → add as 'include' (or 'exclude' with Alt) */
  const toggleLabel = (id: string, altKey = false) => {
    setLabelFilter((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, altKey ? 'exclude' : 'include')
      return next
    })
  }

  /** Build callbacks for changing/removing a label's filter mode */
  const makeModeCallbacks = (id: string) => ({
    onChangeMode: (newMode: FilterMode) =>
      setLabelFilter((prev) => {
        const next = new Map(prev)
        next.set(id, newMode)
        return next
      }),
    onRemove: () =>
      setLabelFilter((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      }),
  })

  return (
    <>
      {labels.map((label) => {
        const hasChildren = label.children && label.children.length > 0
        const isPinned = label.id === pinnedLabelId
        const mode = labelFilter.get(label.id)
        const isActive = !!mode && !isPinned

        // --- Group labels (have children) → always DropdownMenuSub ---
        if (hasChildren) {
          // Check if any child has an active filter (to show indicator on parent)
          const hasActiveChild = label.children!.some((child) => {
            const childMode = labelFilter.get(child.id)
            return !!childMode && child.id !== pinnedLabelId
          })
          const showIndicator = isActive || hasActiveChild || isPinned

          return (
            <DropdownMenuSub key={label.id}>
              <StyledDropdownMenuSubTrigger>
                <FilterMenuRow
                  icon={<LabelIcon label={label} size="lg" hasChildren />}
                  label={label.name}
                  accessory={
                    showIndicator ? (
                      <Check className="h-3 w-3 text-muted-foreground" />
                    ) : undefined
                  }
                />
              </StyledDropdownMenuSubTrigger>
              <StyledDropdownMenuSubContent minWidth="min-w-[160px]">
                {isActive ? (
                  // Active group: group title as nested sub-trigger for mode options, then children
                  <>
                    <DropdownMenuSub>
                      {/* Click the group title to clear, hover to open mode submenu */}
                      <StyledDropdownMenuSubTrigger
                        onClick={(e) => {
                          e.preventDefault()
                          toggleLabel(label.id, e.altKey)
                        }}
                      >
                        <FilterMenuRow
                          icon={
                            <LabelIcon label={label} size="lg" hasChildren />
                          }
                          label={label.name}
                          accessory={<FilterModeBadge mode={mode} />}
                        />
                      </StyledDropdownMenuSubTrigger>
                      <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                        <FilterModeSubMenuItems
                          mode={mode}
                          {...makeModeCallbacks(label.id)}
                        />
                      </StyledDropdownMenuSubContent>
                    </DropdownMenuSub>
                    <StyledDropdownMenuSeparator />
                    <FilterLabelItems
                      labels={label.children!}
                      labelFilter={labelFilter}
                      setLabelFilter={setLabelFilter}
                      pinnedLabelId={pinnedLabelId}
                      altHeld={altHeld}
                    />
                  </>
                ) : (
                  // Inactive group: self-toggle item, then children
                  <>
                    <AltExcludeTooltip show={!!altHeld && !isPinned}>
                      <StyledDropdownMenuItem
                        disabled={isPinned}
                        onClick={(e) => {
                          if (isPinned) return
                          e.preventDefault()
                          toggleLabel(label.id, e.altKey)
                        }}
                      >
                        <FilterMenuRow
                          icon={
                            <LabelIcon label={label} size="lg" hasChildren />
                          }
                          label={label.name}
                          accessory={
                            isPinned ? (
                              <Check className="h-3 w-3 text-muted-foreground" />
                            ) : undefined
                          }
                        />
                      </StyledDropdownMenuItem>
                    </AltExcludeTooltip>
                    <StyledDropdownMenuSeparator />
                    <FilterLabelItems
                      labels={label.children!}
                      labelFilter={labelFilter}
                      setLabelFilter={setLabelFilter}
                      pinnedLabelId={pinnedLabelId}
                      altHeld={altHeld}
                    />
                  </>
                )}
              </StyledDropdownMenuSubContent>
            </DropdownMenuSub>
          )
        }

        // --- Active leaf label → DropdownMenuSub with mode options ---
        if (isActive) {
          return (
            <DropdownMenuSub key={label.id}>
              {/* Click the item itself to clear, hover to open mode submenu */}
              <StyledDropdownMenuSubTrigger
                onClick={(e) => {
                  e.preventDefault()
                  toggleLabel(label.id, e.altKey)
                }}
              >
                <FilterMenuRow
                  icon={<LabelIcon label={label} size="lg" />}
                  label={label.name}
                  accessory={<FilterModeBadge mode={mode} />}
                />
              </StyledDropdownMenuSubTrigger>
              <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                <FilterModeSubMenuItems
                  mode={mode}
                  {...makeModeCallbacks(label.id)}
                />
              </StyledDropdownMenuSubContent>
            </DropdownMenuSub>
          )
        }

        // --- Inactive / pinned leaf label → simple toggleable item ---
        return (
          <AltExcludeTooltip key={label.id} show={!!altHeld && !isPinned}>
            <StyledDropdownMenuItem
              disabled={isPinned}
              onClick={(e) => {
                if (isPinned) return
                e.preventDefault()
                toggleLabel(label.id, e.altKey)
              }}
            >
              <FilterMenuRow
                icon={<LabelIcon label={label} size="lg" />}
                label={label.name}
                accessory={
                  isPinned ? (
                    <Check className="h-3 w-3 text-muted-foreground" />
                  ) : undefined
                }
              />
            </StyledDropdownMenuItem>
          </AltExcludeTooltip>
        )
      })}
    </>
  )
}

/**
 * AppShell - Main 3-panel layout container
 *
 * Layout: [LeftSidebar 20%] | [NavigatorPanel 32%] | [MainContentPanel 48%]
 *
 * Session Filters:
 * - 'allSessions': Shows all sessions
 * - 'flagged': Shows flagged sessions
 * - 'state': Shows sessions with a specific todo state
 */
export function AppShell(props: AppShellProps) {
  // Wrap with EscapeInterruptProvider so AppShellContent can use useEscapeInterrupt
  return (
    <EscapeInterruptProvider>
      <AppShellContent {...props} />
    </EscapeInterruptProvider>
  )
}

/**
 * AppShellContent - Inner component that contains all the AppShell logic
 * Separated to allow useEscapeInterrupt hook to work (must be inside provider)
 */
function AppShellContent({
  contextValue,
  defaultLayout = [20, 32, 48],
  defaultCollapsed = false,
  menuNewChatTrigger,
  isFocusedMode = false,
  isSessionListLoading = false,
  onProjectSessionSnapshotsReadyChange,
}: AppShellProps) {
  // Destructure commonly used values from context
  // Note: sessions is NOT destructured here - we use sessionMetaMapAtom instead
  // to prevent closures from retaining the full messages array
  const {
    workspaces,
    activeWorkspaceId,
    llmConnections,
    workspaceDefaultLlmConnection,
    sessionOptions,
    onSelectWorkspace,
    onRefreshWorkspaces,
    onDeleteSession,
    onFlagSession,
    onUnflagSession,
    onArchiveSession,
    onUnarchiveSession,
    onMarkSessionRead,
    onMarkSessionUnread,
    onSessionStatusChange,
    onRenameSession,
    onOpenSettings,
    onOpenKeyboardShortcuts,
    onOpenStoredUserPreferences,
    onReset,
    onSendMessage,
    openNewChat,
    pendingPermissions,
  } = contextValue

  const { t } = useTranslation()

  // About dialog state (only shown when brand has credits)
  const [showAboutDialog, setShowAboutDialog] = React.useState(false)

  // Get hotkey labels from centralized action registry
  const newChatHotkey = useActionLabel('app.newChat').hotkey

  const [isSidebarVisible, setIsSidebarVisible] = React.useState(() => {
    return storage.get(storage.KEYS.sidebarVisible, !defaultCollapsed)
  })
  const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    return storage.get(storage.KEYS.sidebarWidth, 220)
  })
  // Session list width in pixels.
  const [sessionListWidth, setSessionListWidth] = React.useState(() => {
    return storage.get(storage.KEYS.sessionListWidth, 300)
  })

  // Hides both sidebar and navigator (CMD+. toggle)
  // Seed from either focused window param or persisted preference, then keep it toggleable.
  const [isSidebarAndNavigatorHidden, setIsSidebarAndNavigatorHidden] =
    React.useState(() => {
      return isFocusedMode || storage.get(storage.KEYS.focusModeEnabled, false)
    })
  const [
    collapseSessionNavigatorForProjectDraft,
    setCollapseSessionNavigatorForProjectDraft,
  ] = React.useState(false)
  const [projectDraftTargetWorkspaceId, setProjectDraftTargetWorkspaceId] =
    React.useState<string | null>(null)

  // Auto-compact mode: shell width below mobile threshold hides sidebar/navigator
  // and switches to single-panel mode. Works in both webui (narrow viewport) and
  // desktop (narrow window or small screen).
  const shellRef = useRef<HTMLDivElement>(null)
  const shellWidth = useContainerWidth(shellRef)
  const MOBILE_THRESHOLD = 768
  const isAutoCompact = shellWidth > 0 && shellWidth < MOBILE_THRESHOLD

  const effectiveSidebarAndNavigatorHidden =
    isSidebarAndNavigatorHidden || isAutoCompact

  const [isResizing, setIsResizing] = React.useState<
    'sidebar' | 'session-list' | null
  >(null)
  const [sidebarHandleY, setSidebarHandleY] = React.useState<number | null>(
    null,
  )
  const [sessionListHandleY, setSessionListHandleY] = React.useState<
    number | null
  >(null)
  const resizeHandleRef = React.useRef<HTMLDivElement>(null)
  const sessionListHandleRef = React.useRef<HTMLDivElement>(null)
  const [session, setSession] = useSession()
  const { resolvedMode, isDark, setMode } = useTheme()
  const {
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    navigateToSource,
    navigateToSession,
  } = useNavigation()

  // Double-Esc interrupt feature: first Esc shows warning, second Esc interrupts
  const { handleEscapePress } = useEscapeInterrupt()

  // UNIFIED NAVIGATION STATE - single source of truth from NavigationContext
  // Derived from focused panel's route — all panels are peers
  const navState = useNavigationState()

  const store = useStore()
  const panelStack = useAtomValue(panelStackAtom)
  const panelCount = useAtomValue(panelCountAtom)
  const focusedPanelRoute = useAtomValue(focusedPanelRouteAtom)
  const focusedSessionId = useAtomValue(focusedSessionIdAtom)

  // Navigate the focused panel to a session.
  // If the session is already open in another panel, focus that panel instead.
  const setFocusedPanel = useSetAtom(focusedPanelIdAtom)
  const navigateToSessionInPanel = useCallback(
    (sessionId: string) => {
      // Check if the session is already open in any panel — focus it instead of navigating
      const stack = store.get(panelStackAtom)
      for (const entry of stack) {
        if (parseSessionIdFromRoute(entry.route) === sessionId) {
          setFocusedPanel(entry.id)
          return
        }
      }

      // Not open in any panel — navigate() updates the focused panel
      navigateToSession(sessionId)
    },
    [store, setFocusedPanel, navigateToSession],
  )

  const sessionsContext = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      return {
        filter: navState.filter,
        sessionId: navState.details?.sessionId ?? null,
      }
    }
    return null
  }, [navState])

  const sessionFilter = sessionsContext?.filter ?? null
  const shouldCollapseProjectDraftNavigator =
    collapseSessionNavigatorForProjectDraft &&
    isSessionsNavigation(navState) &&
    !sessionsContext?.sessionId
  const isAllSessionsNavigatorHidden =
    isSessionsNavigation(navState) &&
    sessionsContext?.filter.kind === 'allSessions'
  const isSessionNavigatorCollapsed =
    !isAutoCompact &&
    isSessionsNavigation(navState) &&
    (isAllSessionsNavigatorHidden ||
      !!sessionsContext?.sessionId ||
      shouldCollapseProjectDraftNavigator)
  const effectiveNavigatorWidth = isAutoCompact
    ? isAllSessionsNavigatorHidden
      ? 0
      : sessionListWidth
    : effectiveSidebarAndNavigatorHidden || isSessionNavigatorCollapsed
      ? 0
      : sessionListWidth
  const isNavigatorResizeAvailable =
    !effectiveSidebarAndNavigatorHidden && effectiveNavigatorWidth > 0
  const isSidebarResizeAvailable =
    !effectiveSidebarAndNavigatorHidden && isSidebarVisible

  useEffect(() => {
    if (
      !collapseSessionNavigatorForProjectDraft &&
      !projectDraftTargetWorkspaceId
    )
      return
    if (projectDraftTargetWorkspaceId) {
      if (activeWorkspaceId !== projectDraftTargetWorkspaceId) return
      if (isSessionsNavigation(navState) && !sessionsContext?.sessionId) {
        setWorkspaceSessionSnapshotLoadingIds((prev) => {
          if (!prev.has(projectDraftTargetWorkspaceId)) return prev
          const next = new Set(prev)
          next.delete(projectDraftTargetWorkspaceId)
          return next
        })
        setProjectDraftTargetWorkspaceId(null)
      }
      return
    }
    if (!isSessionsNavigation(navState) || sessionsContext?.sessionId) {
      setCollapseSessionNavigatorForProjectDraft(false)
    }
  }, [
    activeWorkspaceId,
    collapseSessionNavigatorForProjectDraft,
    navState,
    projectDraftTargetWorkspaceId,
    sessionsContext?.sessionId,
  ])

  // Derive source filter from navigation state (only when in sources navigator)
  const sourceFilter: SourceFilter | null = isSourcesNavigation(navState)
    ? (navState.filter ?? null)
    : null

  // Derive automation filter from navigation state (only when in automations navigator)
  const automationFilter: AutomationFilter | null = isAutomationsNavigation(
    navState,
  )
    ? (navState.filter ?? null)
    : null

  // Per-view filter storage: each session list view (allSessions, flagged, state:X, label:X, view:X)
  // has its own independent set of status and label filters.
  // Each filter entry stores a mode ('include' or 'exclude') for tri-state filtering.
  type FilterEntry = Record<string, FilterMode> // id → mode
  type ViewFiltersMap = Record<
    string,
    {
      statuses: FilterEntry
      labels: FilterEntry
      groupingMode?: ChatGroupingMode
    }
  >

  // Compute a stable key for the current chat filter view
  const sessionFilterKey = useMemo(() => {
    if (!sessionFilter) return null
    switch (sessionFilter.kind) {
      case 'allSessions':
        return 'allSessions'
      case 'flagged':
        return 'flagged'
      case 'archived':
        return 'archived'
      case 'state':
        return `state:${sessionFilter.stateId}`
      case 'label':
        return `label:${sessionFilter.labelId}`
      case 'view':
        return `view:${sessionFilter.viewId}`
      default:
        return 'allSessions'
    }
  }, [sessionFilter])

  const [viewFiltersMap, setViewFiltersMap] = React.useState<ViewFiltersMap>(
    () => {
      const saved = storage.get<ViewFiltersMap>(storage.KEYS.viewFilters, {})
      // Backward compat: migrate old format (arrays) into new format (Record<string, FilterMode>)
      if (
        saved.allSessions &&
        Array.isArray((saved.allSessions as any).statuses)
      ) {
        // Old format: { statuses: string[], labels: string[] } → new: { statuses: Record, labels: Record }
        for (const key of Object.keys(saved)) {
          const entry = saved[key] as any
          if (Array.isArray(entry.statuses)) {
            const newStatuses: FilterEntry = {}
            for (const id of entry.statuses) newStatuses[id] = 'include'
            const newLabels: FilterEntry = {}
            for (const id of entry.labels) newLabels[id] = 'include'
            saved[key] = { statuses: newStatuses, labels: newLabels }
          }
        }
      }
      // Also migrate legacy global filters if no allSessions entry exists
      if (!saved.allSessions) {
        const oldStatuses = storage.get<SessionStatusId[]>(
          storage.KEYS.listFilter,
          [],
        )
        const oldLabels = storage.get<string[]>(storage.KEYS.labelFilter, [])
        if (oldStatuses.length > 0 || oldLabels.length > 0) {
          const statuses: FilterEntry = {}
          for (const id of oldStatuses) statuses[id] = 'include'
          const labels: FilterEntry = {}
          for (const id of oldLabels) labels[id] = 'include'
          saved.allSessions = { statuses, labels }
        }
      }
      return saved
    },
  )

  // Derive current view's status filter as a Map<SessionStatusId, FilterMode>
  const listFilter = useMemo(() => {
    if (!sessionFilterKey) return new Map<SessionStatusId, FilterMode>()
    const entry = viewFiltersMap[sessionFilterKey]?.statuses ?? {}
    return new Map<SessionStatusId, FilterMode>(
      Object.entries(entry) as [SessionStatusId, FilterMode][],
    )
  }, [viewFiltersMap, sessionFilterKey])

  // Derive current view's label filter as a Map<string, FilterMode>
  const labelFilter = useMemo(() => {
    if (!FEATURE_FLAGS.sessionLabelsUi) return new Map<string, FilterMode>()
    if (!sessionFilterKey) return new Map<string, FilterMode>()
    const entry = viewFiltersMap[sessionFilterKey]?.labels ?? {}
    return new Map<string, FilterMode>(
      Object.entries(entry) as [string, FilterMode][],
    )
  }, [viewFiltersMap, sessionFilterKey])

  // Setter for status filter — updates only the current view's entry in the map
  const setListFilter = useCallback(
    (
      updater:
        | Map<SessionStatusId, FilterMode>
        | ((
            prev: Map<SessionStatusId, FilterMode>,
          ) => Map<SessionStatusId, FilterMode>),
    ) => {
      if (!FEATURE_FLAGS.sessionLabelsUi) return
      setViewFiltersMap((prev) => {
        if (!sessionFilterKey) return prev
        const current = new Map<SessionStatusId, FilterMode>(
          Object.entries(prev[sessionFilterKey]?.statuses ?? {}) as [
            SessionStatusId,
            FilterMode,
          ][],
        )
        const next = typeof updater === 'function' ? updater(current) : updater
        return {
          ...prev,
          [sessionFilterKey]: {
            statuses: Object.fromEntries(next),
            labels: prev[sessionFilterKey]?.labels ?? {},
          },
        }
      })
    },
    [sessionFilterKey],
  )

  // Setter for label filter — updates only the current view's entry in the map
  const setLabelFilter = useCallback(
    (
      updater:
        | Map<string, FilterMode>
        | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>),
    ) => {
      setViewFiltersMap((prev) => {
        if (!sessionFilterKey) return prev
        const current = new Map<string, FilterMode>(
          Object.entries(prev[sessionFilterKey]?.labels ?? {}) as [
            string,
            FilterMode,
          ][],
        )
        const next = typeof updater === 'function' ? updater(current) : updater
        return {
          ...prev,
          [sessionFilterKey]: {
            statuses: prev[sessionFilterKey]?.statuses ?? {},
            labels: Object.fromEntries(next),
          },
        }
      })
    },
    [sessionFilterKey],
  )
  // Search state for session list
  const [searchActive, setSearchActive] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')

  // Grouping mode for chat list: per-view (stored in viewFiltersMap).
  const isStateSubView = sessionFilter?.kind === 'state'

  const chatGroupingMode: ChatGroupingMode =
    viewFiltersMap[sessionFilterKey ?? '']?.groupingMode ?? 'none'

  const setChatGroupingMode = useCallback(
    (mode: ChatGroupingMode) => {
      setViewFiltersMap((prev) => {
        if (!sessionFilterKey) return prev
        const existing = prev[sessionFilterKey] ?? { statuses: {}, labels: {} }
        return {
          ...prev,
          [sessionFilterKey]: { ...existing, groupingMode: mode },
        }
      })
    },
    [sessionFilterKey],
  )

  // Ref for ChatDisplay navigation (exposed via forwardRef)
  const chatDisplayRef = React.useRef<ChatDisplayHandle>(null)
  // Track match count and index from ChatDisplay (for SessionList navigation UI)
  const [chatMatchInfo, setChatMatchInfo] = React.useState<{
    sessionId: string | null
    count: number
    index: number
    isHighlighting?: boolean
  }>({ sessionId: null, count: 0, index: 0 })

  // Callback for immediate match info updates from ChatDisplay
  // Memo guard prevents render feedback loops from identical updates
  const handleChatMatchInfoChange = React.useCallback(
    (info: {
      sessionId: string | null
      count: number
      index: number
      isHighlighting: boolean
    }) => {
      setChatMatchInfo((prev) => {
        if (
          prev.sessionId === info.sessionId &&
          prev.count === info.count &&
          prev.index === info.index &&
          prev.isHighlighting === info.isHighlighting
        ) {
          return prev
        }
        return info
      })
    },
    [],
  )

  // Reset match info when search is deactivated
  React.useEffect(() => {
    if (!searchActive || !searchQuery) {
      setChatMatchInfo({ sessionId: null, count: 0, index: 0 })
    }
  }, [searchActive, searchQuery])

  // Filter dropdown: inline search query for filtering statuses/labels in a flat list.
  // When empty, the dropdown shows hierarchical submenus. When typing, shows a flat filtered list.
  const [filterDropdownQuery, setFilterDropdownQuery] = React.useState('')
  const [filterAltHeld, setFilterAltHeld] = React.useState(false)

  // Reset search only when navigator or filter changes (not when selecting sessions)
  const navFilterKey = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      const filter = navState.filter
      return `chats:${filter.kind}:${filter.kind === 'state' ? filter.stateId : ''}`
    }
    return navState.navigator
  }, [navState])

  React.useEffect(() => {
    setSearchActive(false)
    setSearchQuery('')
  }, [navFilterKey])

  // Cmd+F to activate search
  useAction('app.search', () => setSearchActive(true))

  // Unified sidebar keyboard navigation state
  // Load expanded folders from localStorage (default: all collapsed)
  const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(
    () => {
      const saved = storage.get<string[]>(storage.KEYS.expandedFolders, [])
      return new Set(saved)
    },
  )
  const [focusedSidebarItemId, setFocusedSidebarItemId] = React.useState<
    string | null
  >(null)
  const sidebarItemRefs = React.useRef<Map<string, HTMLElement>>(new Map())
  // Track expandable sidebar sections for this app run only.
  // Automations defaults collapsed and is independent of workspace switches.
  const [collapsedItems, setCollapsedItems] = React.useState<Set<string>>(
    () => new Set(['nav:automations']),
  )
  const isExpanded = React.useCallback(
    (id: string) => !collapsedItems.has(id),
    [collapsedItems],
  )
  const toggleExpanded = React.useCallback((id: string) => {
    setCollapsedItems((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  // Sources state (workspace-scoped)
  const [sources, setSources] = React.useState<LoadedSource[]>([])
  // Sync sources to atom for NavigationContext auto-selection
  const setSourcesAtom = useSetAtom(sourcesAtom)
  React.useEffect(() => {
    setSourcesAtom(sources)
  }, [sources, setSourcesAtom])

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const remoteWorkspaceId = activeWorkspace?.remoteServer?.remoteWorkspaceId

  // Use session metadata from Jotai atom (lightweight, no messages)
  // This prevents closures from retaining full message arrays
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const activeSessionMeta = session.selected
    ? sessionMetaMap.get(session.selected)
    : undefined
  const activeSessionBelongsToActiveWorkspace = Boolean(
    activeSessionMeta &&
      activeWorkspaceId &&
      (activeSessionMeta.workspaceId === activeWorkspaceId ||
        (remoteWorkspaceId &&
          activeSessionMeta.workspaceId === remoteWorkspaceId)),
  )
  const scopedActiveSessionMeta = activeSessionBelongsToActiveWorkspace
    ? activeSessionMeta
    : undefined
  const activeSessionWorkingDirectory =
    scopedActiveSessionMeta?.workingDirectory
  const [workspaceSkillWorkingDirectory, setWorkspaceSkillWorkingDirectory] =
    React.useState<string | undefined>(undefined)
  const activeSkillsWorkingDirectory =
    activeSessionWorkingDirectory ??
    workspaceSkillWorkingDirectory ??
    activeWorkspace?.rootPath

  // Skills state is bucketed by workspace + working directory so project-level
  // skills from one session do not overwrite another session in the same workspace.
  const [skillsByScopeKey, setSkillsByScopeKey] = React.useState<
    Record<string, WorkspaceSkillsState>
  >({})
  const [qwenCapabilityCache, setQwenCapabilityCache] = React.useState<
    Record<string, QwenCapabilitySnapshot>
  >({})
  const skillsRequestIdRef = React.useRef(0)
  const activeSkillsScopeKey = getWorkspaceSkillsCacheKey(
    activeWorkspaceId,
    activeSkillsWorkingDirectory,
  )
  const activeSkillsState = activeSkillsScopeKey
    ? skillsByScopeKey[activeSkillsScopeKey]
    : undefined
  const skills = activeSkillsState?.skills ?? EMPTY_SKILLS
  // Sync skills to atom for NavigationContext auto-selection
  const setSkillsAtom = useSetAtom(skillsAtom)
  React.useEffect(() => {
    setSkillsAtom(skills)
  }, [skills, setSkillsAtom])
  // Automations — state, handlers, loading, subscriptions
  // Send to Workspace dialog state (driven by sendToWorkspaceAtom set from SessionMenu/BatchSessionMenu)
  const sendToWorkspaceIds = useAtomValue(sendToWorkspaceAtom)
  const setSendToWorkspaceIds = useSetAtom(sendToWorkspaceAtom)
  const handleTransferComplete = useCallback(
    (targetWorkspaceId: string, _newSessionIds: string[]) => {
      onSelectWorkspace(targetWorkspaceId)
    },
    [onSelectWorkspace],
  )
  const {
    automations,
    automationTestResults,
    automationPendingDelete,
    pendingDeleteAutomation,
    setAutomationPendingDelete,
    handleTestAutomation,
    handleToggleAutomation,
    handleDuplicateAutomation,
    handleDeleteAutomation,
    confirmDeleteAutomation,
    getAutomationHistory,
    handleReplayAutomation,
  } = useAutomations(activeWorkspaceId)

  // Whether local MCP servers are enabled (affects stdio source status)
  const [localMcpEnabled, setLocalMcpEnabled] = React.useState(true)

  // Enabled permission modes for Shift+Tab cycling (min 2 modes)
  const [enabledModes, setEnabledModes] = React.useState<PermissionMode[]>([
    ...PERMISSION_MODE_ORDER,
  ])

  // Load workspace settings (for localMcpEnabled, cyclablePermissionModes, and default skill cwd) on workspace change
  React.useEffect(() => {
    if (!activeWorkspaceId) {
      setWorkspaceSkillWorkingDirectory(undefined)
      return
    }
    setWorkspaceSkillWorkingDirectory(activeWorkspace?.rootPath)
    let cancelled = false
    window.electronAPI
      .getWorkspaceSettings(activeWorkspaceId)
      .then((settings) => {
        if (cancelled) return
        if (settings) {
          setLocalMcpEnabled(settings.localMcpEnabled ?? true)
          setWorkspaceSkillWorkingDirectory(
            settings.workingDirectory ?? activeWorkspace?.rootPath,
          )
          // Load cyclablePermissionModes from workspace settings
          if (
            settings.cyclablePermissionModes &&
            settings.cyclablePermissionModes.length >= 2
          ) {
            setEnabledModes(settings.cyclablePermissionModes)
          }
        }
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[Chat] Failed to load workspace settings:', err)
      })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, activeWorkspace?.rootPath])

  // Reset UI state when workspace changes
  // This prevents stale search queries, focused items, and filter state from persisting
  const previousWorkspaceRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!activeWorkspaceId) return

    const previousWorkspaceId = previousWorkspaceRef.current

    // Clear transient UI state only on workspace SWITCH (not initial mount)
    if (
      previousWorkspaceId !== null &&
      previousWorkspaceId !== activeWorkspaceId
    ) {
      // Clear search state
      setSearchActive(false)
      setSearchQuery('')

      // Clear filter dropdown state
      setFilterDropdownQuery('')
      setFilterDropdownSelectedIdx(0)

      // Clear focused sidebar item
      setFocusedSidebarItemId(null)
    }

    // Load workspace-scoped state on BOTH initial mount AND workspace switch
    // This fixes CMD+R losing filters - previously only ran on workspace switch
    if (previousWorkspaceId !== activeWorkspaceId) {
      const newViewFilters = storage.get<ViewFiltersMap>(
        storage.KEYS.viewFilters,
        {},
        activeWorkspaceId,
      )
      setViewFiltersMap(newViewFilters)

      const newExpandedFolders = storage.get<string[]>(
        storage.KEYS.expandedFolders,
        [],
        activeWorkspaceId,
      )
      setExpandedFolders(new Set(newExpandedFolders))
    }

    previousWorkspaceRef.current = activeWorkspaceId
  }, [activeWorkspaceId])

  // Load sources from backend on mount
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    window.electronAPI
      .getSources(activeWorkspaceId)
      .then((loaded) => {
        setSources(loaded || [])
      })
      .catch((err) => {
        console.error('[Chat] Failed to load sources:', err)
      })
  }, [activeWorkspaceId])

  // Subscribe to live source updates (when sources are added/removed dynamically)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onSourcesChanged(
      (workspaceId, updatedSources) => {
        if (workspaceId !== activeWorkspaceId) return
        // Clear icon cache so updated source icons are re-fetched on render
        clearSourceIconCaches()
        setSources(updatedSources || [])
      },
    )
    return cleanup
  }, [activeWorkspaceId])

  // Handle session source selection changes
  const handleSessionSourcesChange = React.useCallback(
    async (sessionId: string, sourceSlugs: string[]) => {
      try {
        await window.electronAPI.sessionCommand(sessionId, {
          type: 'setSources',
          sourceSlugs,
        })
        // Session will emit a 'sources_changed' event that updates the session state
      } catch (err) {
        console.error('[Chat] Failed to set session sources:', err)
      }
    },
    [],
  )

  // Handle session label changes (add/remove via # menu or badge X)
  const handleSessionLabelsChange = React.useCallback(
    async (sessionId: string, labels: string[]) => {
      try {
        await window.electronAPI.sessionCommand(sessionId, {
          type: 'setLabels',
          labels,
        })
        // Session will emit a 'labels_changed' event that updates the session state
      } catch (err) {
        console.error('[Chat] Failed to set session labels:', err)
      }
    },
    [],
  )

  // Load dynamic statuses from workspace config
  const { statuses: statusConfigs, isLoading: isLoadingStatuses } = useStatuses(
    activeWorkspace?.id || null,
  )
  const [sessionStatuses, setSessionStatuses] = React.useState<SessionStatus[]>(
    [],
  )

  // Convert StatusConfig to SessionStatus with resolved icons
  React.useEffect(() => {
    if (!activeWorkspace?.id || statusConfigs.length === 0) {
      setSessionStatuses([])
      return
    }

    setSessionStatuses(
      statusConfigsToSessionStatuses(statusConfigs, activeWorkspace.id, isDark),
    )
  }, [statusConfigs, activeWorkspace?.id, isDark])

  // Optimistic status order: immediately reflects drag-drop order while IPC propagates.
  // Cleared when statusConfigs changes (config watcher is source of truth).
  const [optimisticStatusOrder, setOptimisticStatusOrder] = React.useState<
    string[] | null
  >(null)

  // Clear optimistic state when the config watcher fires (statusConfigs changes)
  React.useEffect(() => {
    setOptimisticStatusOrder(null)
  }, [statusConfigs])

  // Derive effective todo states: apply optimistic reorder if active, otherwise use canonical order
  const effectiveSessionStatuses = React.useMemo(() => {
    if (!optimisticStatusOrder) return sessionStatuses
    // Reorder sessionStatuses array to match optimistic order
    const stateMap = new Map(sessionStatuses.map((s) => [s.id, s]))
    const reordered: SessionStatus[] = []
    for (const id of optimisticStatusOrder) {
      const state = stateMap.get(id)
      if (state) reordered.push(state)
    }
    // Append any states not in the optimistic order (shouldn't happen, but defensive)
    for (const state of sessionStatuses) {
      if (!optimisticStatusOrder.includes(state.id)) reordered.push(state)
    }
    return reordered
  }, [sessionStatuses, optimisticStatusOrder])

  // Load labels from workspace config
  const { labels: labelConfigs } = useLabels(activeWorkspace?.id || null)
  const displayLabelConfigs = useMemo(
    () =>
      FEATURE_FLAGS.sessionLabelsUi ? sortLabelsForDisplay(labelConfigs) : [],
    [labelConfigs],
  )

  // Views: compiled once on config load, evaluated per session in list/chat
  const { evaluateSession: evaluateViews, viewConfigs } = useViews(
    activeWorkspace?.id || null,
  )

  // Build flat LabelMenuItem[] from hierarchical labels for the filter dropdown's search mode.
  // Uses the same structure as the # inline menu so the two search surfaces stay aligned.
  const flatLabelMenuItems = useMemo(
    (): LabelMenuItem[] => createLabelMenuItems(displayLabelConfigs),
    [displayLabelConfigs],
  )

  // Filter dropdown keyboard navigation: tracks highlighted item index in flat search mode.
  // Unified index: [0..matchedStates-1] = statuses, [matchedStates..total-1] = labels.
  const [filterDropdownSelectedIdx, setFilterDropdownSelectedIdx] =
    React.useState(0)
  const filterDropdownListRef = React.useRef<HTMLDivElement>(null)
  const filterDropdownInputRef = React.useRef<HTMLInputElement>(null)

  // Compute filtered results for the dropdown's search mode (memoized for use in both
  // the keyboard handler and the JSX render).
  const filterDropdownResults = useMemo(() => {
    if (!filterDropdownQuery.trim())
      return { states: [] as SessionStatus[], labels: [] as LabelMenuItem[] }
    return {
      states: filterLabelMenuStates(
        effectiveSessionStatuses,
        filterDropdownQuery,
      ),
      labels: filterLabelMenuItems(flatLabelMenuItems, filterDropdownQuery),
    }
  }, [filterDropdownQuery, effectiveSessionStatuses, flatLabelMenuItems])

  // Reset selected index when query changes
  React.useEffect(() => {
    setFilterDropdownSelectedIdx(0)
  }, [filterDropdownQuery])

  // Scroll keyboard-highlighted item into view
  React.useEffect(() => {
    if (!filterDropdownListRef.current) return
    const el = filterDropdownListRef.current.querySelector(
      '[data-filter-selected="true"]',
    )
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [filterDropdownSelectedIdx])

  // Ensure session messages are loaded when selected
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)

  // Handle selecting a source from the list (preserves current filter type)
  const handleSourceSelect = React.useCallback(
    (source: LoadedSource) => {
      if (!activeWorkspaceId) return
      navigateToSource(source.config.slug)
    },
    [activeWorkspaceId, navigateToSource],
  )

  // Handle selecting a skill from the list
  const handleSkillSelect = React.useCallback(
    (skill: LoadedSkill) => {
      if (!activeWorkspaceId) return
      navigate(routes.view.skills(skill.slug))
    },
    [activeWorkspaceId],
  )

  // Handle selecting an automation from the list
  const handleAutomationSelect = React.useCallback(
    (automationId: string) => {
      // Preserve current automation filter when selecting an automation
      const type = isAutomationsNavigation(navState)
        ? navState.filter?.automationType
        : undefined
      navigate(routes.view.automations({ automationId, type }))
    },
    [navState],
  )

  // Focus zone management
  const { focusZone, focusNextZone, focusPreviousZone } = useFocusContext()

  // Register focus zones
  const { zoneRef: sidebarRef, isFocused: sidebarFocused } = useFocusZone({
    zoneId: 'sidebar',
  })

  // Global keyboard shortcuts using centralized action registry
  // Actions are defined in @/actions/definitions.ts

  // Zone navigation - explicit keyboard intent, always move DOM focus
  useAction('nav.focusSidebar', () =>
    focusZone('sidebar', { intent: 'keyboard' }),
  )
  useAction('nav.focusNavigator', () =>
    focusZone('navigator', { intent: 'keyboard' }),
  )
  useAction('nav.focusChat', () => focusZone('chat', { intent: 'keyboard' }))

  // Tab navigation between zones
  useAction(
    'nav.nextZone',
    () => {
      focusNextZone()
    },
    { enabled: () => !document.querySelector('[role="dialog"]') },
  )

  // Shift+Tab cycles permission mode through enabled modes (textarea handles its own, this handles when focus is elsewhere)
  // In multi-panel, targets the focused panel's session
  const navSessionId = isSessionsNavigation(navState)
    ? (navState.details?.sessionId ?? null)
    : null
  const effectiveSessionId =
    focusedSessionId ??
    navSessionId ??
    (panelCount === 0 ? session.selected : null)

  // Focus chat input for the target session only (multi-panel safe).
  const focusChatInputForSession = useCallback(
    (targetSessionId?: string | null) => {
      if (!targetSessionId) return
      dispatchFocusInputEvent({ sessionId: targetSessionId })
    },
    [],
  )

  useAction(
    'chat.cyclePermissionMode',
    () => {
      if (effectiveSessionId) {
        const currentOptions =
          contextValue.sessionOptions.get(effectiveSessionId)
        const currentMode =
          currentOptions?.permissionMode ?? contextValue.globalPermissionMode
        const nextMode = getNextPermissionMode(currentMode, enabledModes)
        contextValue.onSessionOptionsChange(effectiveSessionId, {
          permissionMode: nextMode,
        })
      }
    },
    { enabled: () => Boolean(effectiveSessionId) },
  )

  const handleToggleSidebar = useCallback(() => {
    if (isSidebarAndNavigatorHidden) {
      setIsSidebarAndNavigatorHidden(false)
      return
    }
    setIsSidebarVisible((v) => !v)
  }, [isSidebarAndNavigatorHidden])

  // Sidebar toggle (CMD+B)
  useAction('view.toggleSidebar', handleToggleSidebar)

  // Focus mode toggle (CMD+.) - hides both sidebars
  useAction('view.toggleFocusMode', () =>
    setIsSidebarAndNavigatorHidden((v) => !v),
  )

  // Panel focus navigation (CMD+SHIFT+[ / ])
  const focusNextPanel = useSetAtom(focusNextPanelAtom)
  const focusPrevPanel = useSetAtom(focusPrevPanelAtom)
  useAction('panel.focusNext', focusNextPanel, {
    enabled: () => panelCount > 1,
  })
  useAction('panel.focusPrev', focusPrevPanel, {
    enabled: () => panelCount > 1,
  })

  // New chat
  useAction('app.newChat', () => handleNewChat())
  useAction('app.newChatInPanel', () => handleNewChat(true))

  // Settings
  useAction('app.settings', onOpenSettings)

  // Keyboard shortcuts
  useAction('app.keyboardShortcuts', onOpenKeyboardShortcuts)

  // New window
  useAction('app.newWindow', () => window.electronAPI.menuNewWindow())

  // Quit (note: also handled by native menu on macOS)
  useAction('app.quit', () => window.electronAPI.menuQuit())

  // History navigation
  useAction('nav.goBack', goBack)
  useAction('nav.goForward', goForward)

  // History navigation (arrow key alternatives)
  useAction('nav.goBackAlt', goBack)
  useAction('nav.goForwardAlt', goForward)

  // Search match navigation (CMD+G next, CMD+SHIFT+G prev)
  useAction(
    'chat.nextSearchMatch',
    () => chatDisplayRef.current?.goToNextMatch(),
    {
      enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0,
    },
  )
  useAction(
    'chat.prevSearchMatch',
    () => chatDisplayRef.current?.goToPrevMatch(),
    {
      enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0,
    },
  )

  // ESC to stop processing - requires double-press within 1 second
  // First press shows warning overlay, second press interrupts
  // In multi-panel, targets the focused panel's session
  useAction(
    'chat.stopProcessing',
    () => {
      if (effectiveSessionId) {
        const meta = sessionMetaMap.get(effectiveSessionId)
        if (meta?.isProcessing) {
          // handleEscapePress returns true on second press (within timeout)
          const shouldInterrupt = handleEscapePress()
          if (shouldInterrupt) {
            window.electronAPI
              .cancelProcessing(effectiveSessionId, false)
              .catch((err) => {
                console.error('[AppShell] Failed to cancel processing:', err)
              })
          }
        }
      }
    },
    {
      // Only active when no overlay is open and session is processing
      // Overlays (dialogs, menus, popovers, etc.) should handle their own Escape
      enabled: () => {
        if (hasOpenOverlay()) return false
        if (!effectiveSessionId) return false
        const meta = sessionMetaMap.get(effectiveSessionId)
        return meta?.isProcessing ?? false
      },
    },
    [effectiveSessionId, handleEscapePress],
  )

  // Theme toggle (CMD+SHIFT+A)
  useAction('app.toggleTheme', () =>
    setMode(resolvedMode === 'dark' ? 'light' : 'dark'),
  )

  // Global paste listener for file attachments
  // Fires when Cmd+V is pressed anywhere in the app (not just textarea)
  React.useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      // Skip if a dialog or menu is open
      if (document.querySelector('[role="dialog"], [role="menu"]')) {
        return
      }

      // Skip if there are no files in the clipboard
      const files = e.clipboardData?.files
      if (!files || files.length === 0) return

      // Skip if the active element is an input/textarea/contenteditable (let it handle paste directly)
      const activeElement = document.activeElement as HTMLElement | null
      if (
        activeElement?.tagName === 'TEXTAREA' ||
        activeElement?.tagName === 'INPUT' ||
        activeElement?.isContentEditable
      ) {
        return
      }

      // Prevent default paste behavior
      e.preventDefault()

      // Dispatch custom event for FreeFormInput to handle (target focused session only)
      const filesArray = Array.from(files)
      const targetSessionId = focusedSessionId ?? session.selected
      if (!targetSessionId) return
      window.dispatchEvent(
        new CustomEvent('craft:paste-files', {
          detail: { files: filesArray, sessionId: targetSessionId },
        }),
      )
    }

    document.addEventListener('paste', handleGlobalPaste)
    return () => document.removeEventListener('paste', handleGlobalPaste)
  }, [focusedSessionId, session.selected])

  // Resize effect for sidebar, session list, browser host lane, and metadata right sidebar.
  React.useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing === 'sidebar') {
        const newWidth = Math.min(
          Math.max(e.clientX, SIDEBAR_MIN_WIDTH),
          SIDEBAR_MAX_WIDTH,
        )
        setSidebarWidth(newWidth)
        if (resizeHandleRef.current) {
          const rect = resizeHandleRef.current.getBoundingClientRect()
          setSidebarHandleY(e.clientY - rect.top)
        }
      } else if (isResizing === 'session-list') {
        const offset = isSidebarVisible ? sidebarWidth : 0
        const newWidth = Math.min(
          Math.max(e.clientX - offset, SESSION_LIST_MIN_WIDTH),
          SESSION_LIST_MAX_WIDTH,
        )
        setSessionListWidth(newWidth)
        if (sessionListHandleRef.current) {
          const rect = sessionListHandleRef.current.getBoundingClientRect()
          setSessionListHandleY(e.clientY - rect.top)
        }
      }
    }

    const handleMouseUp = () => {
      if (isResizing === 'sidebar') {
        storage.set(storage.KEYS.sidebarWidth, sidebarWidth)
        setSidebarHandleY(null)
      } else if (isResizing === 'session-list') {
        storage.set(storage.KEYS.sessionListWidth, sessionListWidth)
        setSessionListHandleY(null)
      }
      setIsResizing(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, sidebarWidth, sessionListWidth, isSidebarVisible])

  // Spring transition config - shared between sidebar and header
  // Critical damping (no bounce): damping = 2 * sqrt(stiffness * mass)
  const springTransition = {
    type: 'spring' as const,
    stiffness: 600,
    damping: 49,
  }

  const workspaceSessions = useAtomValue(workspaceSessionsAtom)
  const workspaceSessionMetaCache = useAtomValue(workspaceSessionMetaCacheAtom)
  const setWorkspaceSessionMetaCache = useSetAtom(workspaceSessionMetaCacheAtom)
  const workspaceSessionMetaCacheRef = useRef(workspaceSessionMetaCache)

  useEffect(() => {
    workspaceSessionMetaCacheRef.current = workspaceSessionMetaCache
  }, [workspaceSessionMetaCache])

  const firstActiveWorkspaceSessionMeta = React.useMemo<
    SessionMeta | undefined
  >(() => {
    if (!activeWorkspaceId) return undefined

    const orderedWorkspaceMetas = getWorkspaceSessionMetas(
      workspaceSessions,
      activeWorkspaceId,
    )
    const liveWorkspaceMetas = Array.from(sessionMetaMap.values()).filter(
      (s) =>
        s.workspaceId === activeWorkspaceId ||
        (remoteWorkspaceId && s.workspaceId === remoteWorkspaceId),
    )
    const workspaceMetas =
      liveWorkspaceMetas.length === 0 && orderedWorkspaceMetas.length > 0
        ? orderedWorkspaceMetas
        : mergeStableSessionMetaList(orderedWorkspaceMetas, liveWorkspaceMetas)

    return workspaceMetas.find((s) => !s.hidden && !s.isArchived)
  }, [activeWorkspaceId, remoteWorkspaceId, sessionMetaMap, workspaceSessions])

  const hasPendingPrompt = React.useCallback(
    (sessionId: string) => {
      return (pendingPermissions.get(sessionId)?.length ?? 0) > 0
    },
    [pendingPermissions],
  )

  // Workspace-level unread indicators (needed for workspace selectors across all workspaces)
  const [workspaceUnreadMap, setWorkspaceUnreadMap] = useState<
    Record<string, boolean>
  >({})

  const skillDiscoverySessionMeta =
    scopedActiveSessionMeta ?? firstActiveWorkspaceSessionMeta
  const activeEffectiveConnectionSlug = React.useMemo(
    () =>
      resolveEffectiveConnectionSlug(
        skillDiscoverySessionMeta?.llmConnection,
        workspaceDefaultLlmConnection,
        llmConnections,
      ),
    [
      skillDiscoverySessionMeta?.llmConnection,
      llmConnections,
      workspaceDefaultLlmConnection,
    ],
  )
  const activeEffectiveConnection = React.useMemo(
    () =>
      activeEffectiveConnectionSlug
        ? llmConnections.find(
            (connection) => connection.slug === activeEffectiveConnectionSlug,
          )
        : undefined,
    [activeEffectiveConnectionSlug, llmConnections],
  )
  const shouldUseQwenAcpSkills =
    activeEffectiveConnection?.providerType === 'qwen'
  const activeQwenSessionId =
    shouldUseQwenAcpSkills
      ? activeSessionBelongsToActiveWorkspace
        ? (session.selected ?? null)
        : (firstActiveWorkspaceSessionMeta?.id ?? null)
      : null
  const activeQwenCapabilityCacheKey = getQwenCapabilityCacheKey(
    activeWorkspaceId,
    activeSkillsWorkingDirectory,
    activeEffectiveConnectionSlug,
  )
  const activeQwenCapabilitySnapshot = activeQwenCapabilityCacheKey
    ? qwenCapabilityCache[activeQwenCapabilityCacheKey]
    : undefined
  const selectedSessionAtom = React.useMemo(
    () =>
      session.selected
        ? sessionAtomFamily(session.selected)
        : EMPTY_SESSION_ATOM,
    [session.selected],
  )
  const selectedSession = useAtomValue(selectedSessionAtom)
  const getQwenCapabilitySnapshot = React.useCallback(
    (
      workspaceId?: string | null,
      workingDirectory?: string | null,
      connectionSlug?: string | null,
    ) => {
      const key = getQwenCapabilityCacheKey(
        workspaceId,
        workingDirectory,
        connectionSlug,
      )
      if (key && qwenCapabilityCache[key]) return qwenCapabilityCache[key]

      if (!workspaceId || workspaceId !== activeWorkspaceId) return undefined

      const requestedDirectory = (workingDirectory ?? '').trim()
      const defaultDirectories = [
        activeSkillsWorkingDirectory,
        workspaceSkillWorkingDirectory,
        activeWorkspace?.rootPath,
      ].filter(
        (directory): directory is string =>
          Boolean(directory && directory.trim()),
      )
      const fallbackDirectories = new Set<string | null>()

      if (!requestedDirectory) {
        for (const directory of defaultDirectories) {
          fallbackDirectories.add(directory)
        }
      } else if (
        defaultDirectories.some(
          (directory) => directory.trim() === requestedDirectory,
        )
      ) {
        fallbackDirectories.add(null)
      }

      for (const fallbackDirectory of fallbackDirectories) {
        const fallbackKey = getQwenCapabilityCacheKey(
          workspaceId,
          fallbackDirectory,
          connectionSlug,
        )
        if (fallbackKey && qwenCapabilityCache[fallbackKey]) {
          return qwenCapabilityCache[fallbackKey]
        }
      }

      return undefined
    },
    [
      activeSkillsWorkingDirectory,
      activeWorkspace?.rootPath,
      activeWorkspaceId,
      qwenCapabilityCache,
      workspaceSkillWorkingDirectory,
    ],
  )
  const shouldLoadSkills = shouldLoadWorkspaceSkills({
    isSkillsNavigation:
      isSkillsNavigation(navState) || isSkillMarketplaceNavigation(navState),
    llmConnectionCount: llmConnections.length,
    providerType: activeEffectiveConnection?.providerType,
  })
  const skillsLoading =
    shouldLoadSkills &&
    (!activeSkillsState ||
      (activeSkillsState.status === 'loading' && skills.length === 0))

  React.useEffect(() => {
    if (
      !shouldUseQwenAcpSkills ||
      !activeQwenCapabilityCacheKey ||
      !selectedSession
    )
      return

    const availableCommands = selectedSession.availableCommands ?? []
    const availableSkills = selectedSession.availableSkills
    const availableSkillDetails = selectedSession.availableSkillDetails
    if (
      availableCommands.length === 0 &&
      !availableSkills?.length &&
      !availableSkillDetails?.length
    )
      return

    setQwenCapabilityCache((prev) => {
      const current = prev[activeQwenCapabilityCacheKey]
      if (
        current?.availableCommands === availableCommands &&
        current.availableSkills === availableSkills &&
        current.availableSkillDetails === availableSkillDetails
      ) {
        return prev
      }

      const nextBase = {
        availableCommands,
        ...(availableSkills ? { availableSkills } : {}),
        ...(availableSkillDetails ? { availableSkillDetails } : {}),
      }
      const nextSkills =
        availableSkills?.length || availableSkillDetails?.length
          ? providerSkillsFromQwenCapabilities(nextBase)
          : (current?.skills ?? [])

      return {
        ...prev,
        [activeQwenCapabilityCacheKey]: {
          ...nextBase,
          skills: nextSkills,
        },
      }
    })
  }, [activeQwenCapabilityCacheKey, selectedSession, shouldUseQwenAcpSkills])

  // Subscribe to live skill updates (when skills are added/removed dynamically)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onSkillsChanged(
      (workspaceId, updatedSkills) => {
        const isActiveWorkspace = workspaceId === activeWorkspaceId
        setQwenCapabilityCache((prev) => {
          if (
            !shouldUseQwenAcpSkills ||
            !isActiveWorkspace ||
            !activeQwenCapabilityCacheKey
          ) {
            return Object.keys(prev).length === 0 ? prev : {}
          }

          const safeSkills = updatedSkills || []
          const current = prev[activeQwenCapabilityCacheKey]
          return {
            [activeQwenCapabilityCacheKey]: {
              ...qwenCapabilitiesFromSkills(safeSkills),
              availableCommands: current?.availableCommands ?? [],
            },
          }
        })

        if (shouldUseQwenAcpSkills) {
          const safeSkills = updatedSkills || []
          if (!isActiveWorkspace || !shouldLoadSkills || !activeSkillsScopeKey)
            return

          setSkillsByScopeKey((prev) => ({
            ...prev,
            [activeSkillsScopeKey]: {
              skills: safeSkills,
              status: 'ready',
              requestId: prev[activeSkillsScopeKey]?.requestId ?? 0,
            },
          }))
          return
        }

        if (!isActiveWorkspace || !shouldLoadSkills || !activeSkillsScopeKey)
          return
        setSkillsByScopeKey((prev) => ({
          ...prev,
          [activeSkillsScopeKey]: {
            skills: updatedSkills || [],
            status: 'ready',
            requestId: prev[activeSkillsScopeKey]?.requestId ?? 0,
          },
        }))
      },
    )
    return cleanup
  }, [
    activeQwenCapabilityCacheKey,
    activeSkillsScopeKey,
    activeWorkspaceId,
    shouldLoadSkills,
    shouldUseQwenAcpSkills,
  ])

  const reloadSkills = React.useCallback(
    async (options?: { force?: boolean }) => {
      const workspaceId = activeWorkspaceId
      const scopeKey = activeSkillsScopeKey
      if (!workspaceId || !scopeKey) return
      const requestId = ++skillsRequestIdRef.current
      if (!shouldLoadSkills) {
        setSkillsByScopeKey((prev) => ({
          ...prev,
          [scopeKey]: {
            skills: [],
            status: 'ready',
            requestId,
          },
        }))
        return
      }

      if (
        shouldUseQwenAcpSkills &&
        !options?.force &&
        activeQwenCapabilitySnapshot
      ) {
        setSkillsByScopeKey((prev) => ({
          ...prev,
          [scopeKey]: {
            skills: activeQwenCapabilitySnapshot.skills,
            status: 'ready',
            requestId,
          },
        }))
        return
      }

      setSkillsByScopeKey((prev) => ({
        ...prev,
        [scopeKey]: {
          skills: prev[scopeKey]?.skills ?? [],
          status: 'loading',
          requestId,
        },
      }))
      try {
        const loaded = await window.electronAPI.getSkills(
          workspaceId,
          activeSkillsWorkingDirectory,
          activeQwenSessionId ?? undefined,
        )
        if (shouldUseQwenAcpSkills && activeQwenCapabilityCacheKey) {
          setQwenCapabilityCache((prev) => {
            const current = prev[activeQwenCapabilityCacheKey]
            const skills = loaded || []
            if (current?.skills === skills) return prev

            return {
              ...prev,
              [activeQwenCapabilityCacheKey]: {
                ...qwenCapabilitiesFromSkills(skills),
                availableCommands: current?.availableCommands ?? [],
              },
            }
          })
        }
        setSkillsByScopeKey((prev) => {
          if (prev[scopeKey]?.requestId !== requestId) return prev
          return {
            ...prev,
            [scopeKey]: {
              skills: loaded || [],
              status: 'ready',
              requestId,
            },
          }
        })
      } catch (err) {
        console.error('[Chat] Failed to load skills:', err)
        setSkillsByScopeKey((prev) => {
          if (prev[scopeKey]?.requestId !== requestId) return prev
          return {
            ...prev,
            [scopeKey]: {
              skills: prev[scopeKey]?.skills ?? [],
              status: 'error',
              requestId,
            },
          }
        })
      }
    },
    [
      activeQwenCapabilityCacheKey,
      activeQwenCapabilitySnapshot,
      activeSkillsScopeKey,
      activeWorkspaceId,
      activeSkillsWorkingDirectory,
      activeQwenSessionId,
      shouldLoadSkills,
      shouldUseQwenAcpSkills,
    ],
  )

  React.useEffect(() => {
    void reloadSkills()
  }, [reloadSkills])

  // Filter session metadata by active workspace, but take the display order from
  // workspaceSessionsAtom. sessionMetaMapAtom still carries live event updates.
  // For remote workspaces, sessions have the remote workspace ID (not the local one),
  // so we match live metadata against both the local and remote workspace IDs.
  const workspaceSessionMetas = useMemo(() => {
    const liveMetas = Array.from(sessionMetaMap.values())
    if (!activeWorkspaceId) return liveMetas.filter((s) => !s.hidden)

    const activeWorkspaceMetas = getWorkspaceSessionMetas(
      workspaceSessions,
      activeWorkspaceId,
    )
    const liveWorkspaceMetas = liveMetas.filter(
      (s) =>
        s.workspaceId === activeWorkspaceId ||
        (remoteWorkspaceId && s.workspaceId === remoteWorkspaceId),
    )
    if (liveWorkspaceMetas.length === 0 && activeWorkspaceMetas.length > 0) {
      return activeWorkspaceMetas.filter((s) => !s.hidden)
    }
    return mergeStableSessionMetaList(
      activeWorkspaceMetas,
      liveWorkspaceMetas,
    ).filter((s) => !s.hidden)
  }, [sessionMetaMap, workspaceSessions, activeWorkspaceId, remoteWorkspaceId])

  const [
    workspaceSessionSnapshotRefreshTick,
    setWorkspaceSessionSnapshotRefreshTick,
  ] = useState(0)
  const [
    workspaceSessionSnapshotLoadingIds,
    setWorkspaceSessionSnapshotLoadingIds,
  ] = useState<Set<string>>(new Set())
  const [sessionListRefreshWorkspaceIds, setSessionListRefreshWorkspaceIds] =
    useState<Set<string>>(new Set())
  const workspaceSessionSnapshotRetryAttemptsRef = useRef<Map<string, number>>(
    new Map(),
  )
  const workspaceSessionSnapshotRetryTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map())

  const scheduleWorkspaceSessionSnapshotRetry = useCallback(
    (workspaceId: string): boolean => {
      const attempts =
        workspaceSessionSnapshotRetryAttemptsRef.current.get(workspaceId) ?? 0
      if (attempts >= 3) return false
      if (workspaceSessionSnapshotRetryTimersRef.current.has(workspaceId))
        return true

      workspaceSessionSnapshotRetryAttemptsRef.current.set(
        workspaceId,
        attempts + 1,
      )
      const delay = 400 * (attempts + 1)
      const timer = setTimeout(() => {
        workspaceSessionSnapshotRetryTimersRef.current.delete(workspaceId)
        setWorkspaceSessionSnapshotRefreshTick((tick) => tick + 1)
      }, delay)
      workspaceSessionSnapshotRetryTimersRef.current.set(workspaceId, timer)
      return true
    },
    [],
  )

  useEffect(() => {
    return () => {
      for (const timer of workspaceSessionSnapshotRetryTimersRef.current.values()) {
        clearTimeout(timer)
      }
      workspaceSessionSnapshotRetryTimersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const cleanup = window.electronAPI.onSessionListRefreshStateChanged(
      (workspaceId, isRefreshing) => {
        setSessionListRefreshWorkspaceIds((prev) => {
          const hasWorkspace = prev.has(workspaceId)
          if (isRefreshing === hasWorkspace) return prev

          const next = new Set(prev)
          if (isRefreshing) next.add(workspaceId)
          else next.delete(workspaceId)
          return next
        })
      },
    )

    return cleanup
  }, [])

  useEffect(() => {
    if (!activeWorkspaceId) return

    setWorkspaceSessionMetaCache((prev) => {
      const merged = mergeStableSessionMetaList(
        prev.get(activeWorkspaceId),
        workspaceSessionMetas,
      )
      if (areSessionMetaListsEquivalent(prev.get(activeWorkspaceId), merged))
        return prev
      const next = new Map(prev)
      next.set(activeWorkspaceId, merged)
      return next
    })
  }, [activeWorkspaceId, setWorkspaceSessionMetaCache, workspaceSessionMetas])

  useEffect(() => {
    let cancelled = false

    const loadWorkspaceSessionSnapshots = async () => {
      const snapshotWorkspaces = workspaces.filter(
        (workspace) => workspace.id !== activeWorkspaceId,
      )
      if (snapshotWorkspaces.length === 0) {
        setWorkspaceSessionSnapshotLoadingIds(new Set())
        onProjectSessionSnapshotsReadyChange?.(true)
        return
      }

      const previousCache = workspaceSessionMetaCacheRef.current
      onProjectSessionSnapshotsReadyChange?.(false)
      setWorkspaceSessionSnapshotLoadingIds(
        new Set(
          snapshotWorkspaces
            .filter((workspace) => !previousCache.has(workspace.id))
            .map((workspace) => workspace.id),
        ),
      )
      let hasPendingRetry = false
      const pendingRetryWorkspaceIds = new Set<string>()
      const entries = await Promise.all(
        workspaces.map(async (workspace) => {
          if (workspace.id === activeWorkspaceId) {
            return [
              workspace.id,
              previousCache.get(workspace.id) ?? [],
            ] as const
          }

          const hasPreviousSnapshot = previousCache.has(workspace.id)
          const previous = previousCache.get(workspace.id) ?? []

          try {
            const sessions =
              await loadProjectWorkspaceSessionSnapshot(workspace)
            workspaceSessionSnapshotRetryAttemptsRef.current.delete(
              workspace.id,
            )
            const retryTimer =
              workspaceSessionSnapshotRetryTimersRef.current.get(workspace.id)
            if (retryTimer) {
              clearTimeout(retryTimer)
              workspaceSessionSnapshotRetryTimersRef.current.delete(
                workspace.id,
              )
            }
            return [workspace.id, sessions] as const
          } catch (error) {
            console.error(
              `[AppShell] Failed to load sessions for workspace ${workspace.id}:`,
              error,
            )
            const willRetry = scheduleWorkspaceSessionSnapshotRetry(
              workspace.id,
            )
            hasPendingRetry = willRetry || hasPendingRetry
            if (willRetry && !hasPreviousSnapshot) {
              pendingRetryWorkspaceIds.add(workspace.id)
            }
            return [workspace.id, previous] as const
          }
        }),
      )

      if (!cancelled) {
        setWorkspaceSessionMetaCache((prev) => {
          const next = new Map(prev)
          let changed = false
          for (const [workspaceId, sessions] of entries) {
            if (workspaceId === activeWorkspaceId) continue
            const merged = mergeStableSessionMetaList(
              next.get(workspaceId),
              sessions,
            )
            if (areSessionMetaListsEquivalent(next.get(workspaceId), merged))
              continue
            next.set(workspaceId, merged)
            changed = true
          }
          return changed ? next : prev
        })
        setWorkspaceSessionSnapshotLoadingIds(pendingRetryWorkspaceIds)
        onProjectSessionSnapshotsReadyChange?.(!hasPendingRetry)
      }
    }

    void loadWorkspaceSessionSnapshots()

    return () => {
      cancelled = true
    }
  }, [
    workspaces,
    activeWorkspaceId,
    workspaceSessionSnapshotRefreshTick,
    setWorkspaceSessionMetaCache,
    scheduleWorkspaceSessionSnapshotRetry,
    onProjectSessionSnapshotsReadyChange,
  ])

  const projectTreeWorkspaceSessions = useMemo(() => {
    const next = new Map(workspaceSessionMetaCache)
    if (activeWorkspaceId) {
      next.set(
        activeWorkspaceId,
        mergeStableSessionMetaList(
          next.get(activeWorkspaceId),
          workspaceSessionMetas,
        ),
      )
    }
    return next
  }, [workspaceSessionMetaCache, activeWorkspaceId, workspaceSessionMetas])

  const projectTreeLoadingWorkspaceSessionIds = useMemo(() => {
    const next = new Set(workspaceSessionSnapshotLoadingIds)
    for (const workspaceId of sessionListRefreshWorkspaceIds) {
      next.add(workspaceId)
    }
    if (
      activeWorkspaceId &&
      isSessionListLoading &&
      (projectTreeWorkspaceSessions.get(activeWorkspaceId)?.length ?? 0) === 0
    ) {
      next.add(activeWorkspaceId)
    }
    if (projectDraftTargetWorkspaceId) {
      next.delete(projectDraftTargetWorkspaceId)
    }
    return next
  }, [
    activeWorkspaceId,
    isSessionListLoading,
    projectDraftTargetWorkspaceId,
    projectTreeWorkspaceSessions,
    sessionListRefreshWorkspaceIds,
    workspaceSessionSnapshotLoadingIds,
  ])
  const [projectSessionRevealRequest, setProjectSessionRevealRequest] =
    React.useState<ProjectSessionRevealRequest | null>(null)

  const handleRevealProjectSession = useCallback(
    (workspaceId: string, sessionId: string) => {
      setProjectSessionRevealRequest({
        workspaceId,
        sessionId,
        nonce: Date.now(),
      })
    },
    [],
  )

  // Active sessions exclude archived - use this for all counts and filters except archived view
  const activeSessionMetas = useMemo(() => {
    return workspaceSessionMetas.filter((s) => !s.isArchived)
  }, [workspaceSessionMetas])

  const refreshWorkspaceUnreadMap = useCallback(async () => {
    try {
      const summary = await window.electronAPI.getUnreadSummary()
      const next: Record<string, boolean> = {}

      for (const workspace of workspaces) {
        next[workspace.id] = !!summary.hasUnreadByWorkspace[workspace.id]
      }

      setWorkspaceUnreadMap(next)
    } catch (error) {
      console.error(
        '[AppShell] Failed to refresh workspace unread indicators:',
        error,
      )
    }
  }, [workspaces])

  // Initial + workspace-list refresh
  useEffect(() => {
    void refreshWorkspaceUnreadMap()
  }, [refreshWorkspaceUnreadMap])

  // Keep active workspace unread indicator in sync with live metadata updates
  useEffect(() => {
    if (!activeWorkspaceId) return
    const activeHasUnread = activeSessionMetas.some(
      (session) => !!session.hasUnread,
    )
    setWorkspaceUnreadMap((prev) => ({
      ...prev,
      [activeWorkspaceId]: activeHasUnread,
    }))
  }, [activeWorkspaceId, activeSessionMetas])

  // Keep cross-workspace indicators in sync with global unread updates from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onUnreadSummaryChanged((summary) => {
      const next: Record<string, boolean> = {}
      for (const workspace of workspaces) {
        next[workspace.id] = !!summary.hasUnreadByWorkspace[workspace.id]
      }
      setWorkspaceUnreadMap(next)
    })

    return cleanup
  }, [workspaces])

  // Count sessions by todo state (scoped to workspace)
  const isMetaDone = (s: SessionMeta) =>
    s.sessionStatus === 'done' || s.sessionStatus === 'cancelled'
  const flaggedCount = activeSessionMetas.filter((s) => s.isFlagged).length
  const archivedCount = workspaceSessionMetas.filter((s) => s.isArchived).length

  // Compute session counts per label (cumulative: parent includes descendants).
  // Flatten the tree for iteration, use the tree for descendant lookups.
  // Uses activeSessionMetas to exclude archived sessions from counts.
  const labelCounts = useMemo(() => {
    const allLabels = flattenLabels(labelConfigs)
    const counts: Record<string, number> = {}
    for (const label of allLabels) {
      // Direct count: sessions explicitly tagged with this label (handles valued entries like "priority::3")
      const directCount = activeSessionMetas.filter((s) =>
        s.labels?.some((l) => extractLabelId(l) === label.id),
      ).length
      counts[label.id] = directCount
    }
    // Add descendant counts to parents (cumulative)
    for (const label of allLabels) {
      const descendants = getDescendantIds(labelConfigs, label.id)
      if (descendants.length > 0) {
        const descendantCount = activeSessionMetas.filter((s) =>
          s.labels?.some((l) => descendants.includes(extractLabelId(l))),
        ).length
        counts[label.id] = (counts[label.id] || 0) + descendantCount
      }
    }
    return counts
  }, [activeSessionMetas, labelConfigs])

  // Count sessions by individual todo state (dynamic based on effectiveSessionStatuses)
  // Uses activeSessionMetas to exclude archived sessions from counts.
  const sessionStatusCounts = useMemo(() => {
    const counts: Record<SessionStatusId, number> = {}
    // Initialize counts for all dynamic statuses
    for (const state of effectiveSessionStatuses) {
      counts[state.id] = 0
    }
    // Count sessions
    for (const s of activeSessionMetas) {
      const state = (s.sessionStatus || 'todo') as SessionStatusId
      // Increment count (initialize to 0 if status not in effectiveSessionStatuses yet)
      counts[state] = (counts[state] || 0) + 1
    }
    return counts
  }, [activeSessionMetas, effectiveSessionStatuses])

  // Count automations by type for the Automations dropdown subcategories
  const automationTypeCounts = useMemo(() => {
    const counts = { scheduled: 0, event: 0, agentic: 0 }
    for (const automation of automations) {
      if (automation.event === 'SchedulerTick') counts.scheduled++
      else if ((APP_EVENTS as string[]).includes(automation.event))
        counts.event++
      else if ((AGENT_EVENTS as string[]).includes(automation.event))
        counts.agentic++
    }
    return counts
  }, [automations])

  // Filter session metadata based on sidebar mode and chat filter
  const filteredSessionMetas = useMemo(() => {
    // When in sources mode, return empty (no sessions to show)
    if (!sessionFilter) {
      return []
    }

    let result: SessionMeta[]

    switch (sessionFilter.kind) {
      case 'allSessions':
        // "All Sessions" - shows active (non-archived) sessions
        result = activeSessionMetas
        break
      case 'flagged':
        result = activeSessionMetas.filter((s) => s.isFlagged)
        break
      case 'archived':
        // Archived view shows only archived sessions
        result = workspaceSessionMetas.filter((s) => s.isArchived)
        break
      case 'state':
        // Filter by specific todo state (excludes archived)
        result = activeSessionMetas.filter(
          (s) => (s.sessionStatus || 'todo') === sessionFilter.stateId,
        )
        break
      case 'label': {
        if (sessionFilter.labelId === '__all__') {
          // "Labels" header: show all active sessions that have at least one label
          result = activeSessionMetas.filter(
            (s) => s.labels && s.labels.length > 0,
          )
        } else {
          // Specific label: includes sessions tagged with this label or any descendant
          const descendants = getDescendantIds(
            labelConfigs,
            sessionFilter.labelId,
          )
          const matchIds = new Set([sessionFilter.labelId, ...descendants])
          result = activeSessionMetas.filter((s) =>
            s.labels?.some((l) => matchIds.has(extractLabelId(l))),
          )
        }
        break
      }
      case 'view': {
        // Filter by view: __all__ shows any session matched by any view,
        // otherwise filter to the specific view (excludes archived)
        result = activeSessionMetas.filter((s) => {
          const matched = evaluateViews(s)
          if (sessionFilter.viewId === '__all__') {
            return matched.length > 0
          }
          return matched.some((v) => v.id === sessionFilter.viewId)
        })
        break
      }
      default:
        result = activeSessionMetas
    }

    // Apply secondary filters (status + labels, AND-ed together) in ALL views.
    // These layer on top of the primary sessionFilter to allow further narrowing.
    // Each filter supports include/exclude modes:
    //   - Includes: if any exist, only matching items pass
    //   - Excludes: matching items are removed (applied after includes)
    if (listFilter.size > 0) {
      const statusIncludes = new Set<SessionStatusId>()
      const statusExcludes = new Set<SessionStatusId>()
      for (const [id, mode] of listFilter) {
        if (mode === 'include') statusIncludes.add(id)
        else statusExcludes.add(id)
      }
      if (statusIncludes.size > 0) {
        result = result.filter((s) =>
          statusIncludes.has((s.sessionStatus || 'todo') as SessionStatusId),
        )
      }
      if (statusExcludes.size > 0) {
        result = result.filter(
          (s) =>
            !statusExcludes.has((s.sessionStatus || 'todo') as SessionStatusId),
        )
      }
    }
    // Filter by labels — supports include/exclude with descendant expansion
    if (labelFilter.size > 0) {
      const labelIncludes = new Set<string>()
      const labelExcludes = new Set<string>()
      for (const [id, mode] of labelFilter) {
        // Expand to include descendant label IDs
        const ids = [id, ...getDescendantIds(labelConfigs, id)]
        for (const expandedId of ids) {
          if (mode === 'include') labelIncludes.add(expandedId)
          else labelExcludes.add(expandedId)
        }
      }
      if (labelIncludes.size > 0) {
        result = result.filter((s) =>
          s.labels?.some((l) => labelIncludes.has(extractLabelId(l))),
        )
      }
      if (labelExcludes.size > 0) {
        result = result.filter(
          (s) => !s.labels?.some((l) => labelExcludes.has(extractLabelId(l))),
        )
      }
    }

    return result
  }, [
    workspaceSessionMetas,
    activeSessionMetas,
    sessionFilter,
    listFilter,
    labelFilter,
    labelConfigs,
  ])

  // Derive "pinned" (non-removable) filters from the current sessionFilter path.
  // These represent filters that are implicit in the current deeplink/route and
  // should be displayed as fixed chips in the filter bar that users cannot remove.
  const pinnedFilters = useMemo(() => {
    if (!sessionFilter)
      return {
        pinnedStatusId: null as string | null,
        pinnedLabelId: null as string | null,
        pinnedFlagged: false,
      }
    switch (sessionFilter.kind) {
      case 'state':
        return {
          pinnedStatusId: sessionFilter.stateId,
          pinnedLabelId: null,
          pinnedFlagged: false,
        }
      case 'label':
        // Don't pin the __all__ pseudo-label — that just means "any label"
        return {
          pinnedStatusId: null,
          pinnedLabelId:
            sessionFilter.labelId !== '__all__' ? sessionFilter.labelId : null,
          pinnedFlagged: false,
        }
      case 'flagged':
        return {
          pinnedStatusId: null,
          pinnedLabelId: null,
          pinnedFlagged: true,
        }
      default:
        return {
          pinnedStatusId: null,
          pinnedLabelId: null,
          pinnedFlagged: false,
        }
    }
  }, [sessionFilter])

  // Ensure session messages are loaded when selected
  React.useEffect(() => {
    const selectedSessionId = session.selected
    if (selectedSessionId) {
      ensureMessagesLoaded(selectedSessionId).catch((error) => {
        console.error(
          `[AppShell] Failed to pre-load messages for session ${selectedSessionId}:`,
          error,
        )
      })
    }
  }, [session.selected, ensureMessagesLoaded])

  // Wrap delete handler to clear selection when deleting the currently selected session
  // This prevents stale state during re-renders that could cause crashes
  const handleDeleteSession = useCallback(
    async (
      sessionId: string,
      skipConfirmation?: boolean,
      displayTitle?: string,
    ): Promise<boolean> => {
      // Clear selection first if this is the selected session
      if (session.selected === sessionId) {
        setSession({ selected: null })
      }
      return onDeleteSession(sessionId, skipConfirmation, displayTitle)
    },
    [session.selected, setSession, onDeleteSession],
  )

  // Extend context value with local overrides (wrapped onDeleteSession, sources, skills, labels, enabledModes, rightSidebarOpenButton, effectiveSessionStatuses)
  const appShellContextValue = React.useMemo<AppShellContextType>(
    () => ({
      ...contextValue,
      activeSessionId: session.selected,
      activeQwenSessionId,
      onDeleteSession: handleDeleteSession,
      enabledSources: sources,
      skills,
      reloadSkills,
      getQwenCapabilitySnapshot,
      activeSessionWorkingDirectory: activeSkillsWorkingDirectory,
      labels: displayLabelConfigs,
      onSessionLabelsChange: handleSessionLabelsChange,
      enabledModes,
      sessionStatuses: effectiveSessionStatuses,
      onSessionSourcesChange: handleSessionSourcesChange,
      rightSidebarButton: null,
      isCompactMode: isAutoCompact,
      // Search state for ChatDisplay highlighting
      sessionListSearchQuery: searchActive ? searchQuery : undefined,
      isSearchModeActive: searchActive,
      chatDisplayRef,
      onChatMatchInfoChange: handleChatMatchInfoChange,
      onTestAutomation: handleTestAutomation,
      onToggleAutomation: handleToggleAutomation,
      onDuplicateAutomation: handleDuplicateAutomation,
      onDeleteAutomation: handleDeleteAutomation,
      automationTestResults,
      getAutomationHistory,
      onReplayAutomation: handleReplayAutomation,
    }),
    [
      contextValue,
      session.selected,
      activeQwenSessionId,
      handleDeleteSession,
      sources,
      skills,
      reloadSkills,
      getQwenCapabilitySnapshot,
      activeSkillsWorkingDirectory,
      displayLabelConfigs,
      handleSessionLabelsChange,
      enabledModes,
      effectiveSessionStatuses,
      handleSessionSourcesChange,
      isAutoCompact,
      searchActive,
      searchQuery,
      handleChatMatchInfoChange,
      handleTestAutomation,
      handleToggleAutomation,
      handleDuplicateAutomation,
      handleDeleteAutomation,
      automationTestResults,
      getAutomationHistory,
      handleReplayAutomation,
    ],
  )

  // Persist expanded folders to localStorage (workspace-scoped)
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(
      storage.KEYS.expandedFolders,
      [...expandedFolders],
      activeWorkspaceId,
    )
  }, [expandedFolders, activeWorkspaceId])

  // Persist sidebar visibility to localStorage
  React.useEffect(() => {
    storage.set(storage.KEYS.sidebarVisible, isSidebarVisible)
  }, [isSidebarVisible])

  // Persist focus mode state to localStorage
  React.useEffect(() => {
    storage.set(storage.KEYS.focusModeEnabled, isSidebarAndNavigatorHidden)
  }, [isSidebarAndNavigatorHidden])

  // Listen for focus mode toggle from menu (View → Focus Mode)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onMenuToggleFocusMode?.(() => {
      setIsSidebarAndNavigatorHidden((v) => !v)
    })
    return cleanup
  }, [])

  // Listen for sidebar toggle from menu (View → Toggle Sidebar)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onMenuToggleSidebar?.(() => {
      handleToggleSidebar()
    })
    return cleanup
  }, [handleToggleSidebar])

  // Persist per-view filter map to localStorage (workspace-scoped)
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(storage.KEYS.viewFilters, viewFiltersMap, activeWorkspaceId)
  }, [viewFiltersMap, activeWorkspaceId])

  const handleAllSessionsClick = useCallback(() => {
    setCollapseSessionNavigatorForProjectDraft(false)
    setProjectDraftTargetWorkspaceId(null)
    navigate(routes.view.allSessions())
  }, [])

  const handleFlaggedClick = useCallback(() => {
    setCollapseSessionNavigatorForProjectDraft(false)
    setProjectDraftTargetWorkspaceId(null)
    navigate(routes.view.flagged())
  }, [])

  const handleArchivedClick = useCallback(() => {
    setCollapseSessionNavigatorForProjectDraft(false)
    setProjectDraftTargetWorkspaceId(null)
    navigate(routes.view.archived())
  }, [])

  // Handler for individual todo state views
  const handleSessionStatusClick = useCallback((stateId: SessionStatusId) => {
    setCollapseSessionNavigatorForProjectDraft(false)
    setProjectDraftTargetWorkspaceId(null)
    navigate(routes.view.state(stateId))
  }, [])

  // Handler for label filter views (hierarchical — includes descendant labels)
  const handleLabelClick = useCallback((labelId: string) => {
    setCollapseSessionNavigatorForProjectDraft(false)
    setProjectDraftTargetWorkspaceId(null)
    navigate(routes.view.label(labelId))
  }, [])

  const handleViewClick = useCallback((viewId: string) => {
    setCollapseSessionNavigatorForProjectDraft(false)
    setProjectDraftTargetWorkspaceId(null)
    navigate(routes.view.view(viewId))
  }, [])

  // DnD handler: reorder statuses (flat list drag-and-drop)
  // Sets optimistic order immediately for instant UI feedback, then fires IPC.
  const handleStatusReorder = useCallback(
    (orderedIds: string[]) => {
      if (!activeWorkspaceId) return
      setOptimisticStatusOrder(orderedIds)
      window.electronAPI.reorderStatuses(activeWorkspaceId, orderedIds)
    },
    [activeWorkspaceId],
  )

  // Handler for skills view
  const handleSkillsClick = useCallback(() => {
    navigate(routes.view.skills())
  }, [])

  const handleSkillMarketplaceClick = useCallback(() => {
    navigate(routes.view.skillMarketplace())
  }, [])

  const handleMarketplaceSkillSelect = useCallback((skillId: string) => {
    navigate(routes.view.skillMarketplace(skillId))
  }, [])

  // Handlers for automations view
  const handleAutomationsClick = useCallback(() => {
    navigate(routes.view.automations())
  }, [])

  const handleAutomationsScheduledClick = useCallback(() => {
    navigate(routes.view.automationsScheduled())
  }, [])

  const handleAutomationsEventClick = useCallback(() => {
    navigate(routes.view.automationsEvent())
  }, [])

  const handleAutomationsAgenticClick = useCallback(() => {
    navigate(routes.view.automationsAgentic())
  }, [])

  // Handler for settings view
  const handleSettingsClick = useCallback((subpage?: SettingsSubpage) => {
    navigate(routes.view.settings(subpage))
  }, [])

  // ============================================================================
  // EDIT POPOVER STATE
  // ============================================================================
  // State to control which EditPopover is open (triggered from context menus).
  // We use controlled popovers instead of deep links so the user can type
  // their request in the popover UI before opening a new chat window.
  // add-source variants: add-source (generic), add-source-api, add-source-mcp, add-source-local
  const [editPopoverOpen, setEditPopoverOpen] = useState<
    | 'statuses'
    | 'labels'
    | 'views'
    | 'add-source'
    | 'add-source-api'
    | 'add-source-mcp'
    | 'add-source-local'
    | 'add-skill'
    | 'add-label'
    | 'automation-config'
    | null
  >(null)

  // Stores the Y position of the last right-clicked sidebar item so the EditPopover
  // appears near it rather than at a fixed location. Updated synchronously before
  // the setTimeout that opens the popover, ensuring the ref is set before render.
  const editPopoverAnchorY = useRef<number>(120)
  // Tracks which label was right-clicked when opening label EditPopovers,
  // so the agent knows the target for commands like "make this red" or "add below this"
  const editLabelTargetId = useRef<string | undefined>(undefined)

  // Stores the trigger element (button) so we can keep it highlighted while the
  // EditPopover is open (after Radix removes data-state="open" on context menu close).
  const editPopoverTriggerRef = useRef<Element | null>(null)

  // Captures the bounding rect of the currently-open context menu trigger (the button).
  // Radix sets data-state="open" on the button (via ContextMenuTrigger asChild)
  // while the menu is visible, so we can locate it in the DOM at click time.
  const captureContextMenuPosition = useCallback(() => {
    const trigger = document.querySelector(
      '.group\\/section > [data-state="open"]',
    )
    if (trigger) {
      const rect = trigger.getBoundingClientRect()
      editPopoverAnchorY.current = rect.top
      editPopoverTriggerRef.current = trigger
    }
  }, [])

  // Sync data-edit-active attribute on the trigger element with EditPopover open state.
  // This keeps the sidebar item visually highlighted while the popover is shown,
  // since Radix's data-state="open" disappears when the context menu closes.
  useEffect(() => {
    const el = editPopoverTriggerRef.current
    if (!el) return
    if (editPopoverOpen) {
      el.setAttribute('data-edit-active', 'true')
    } else {
      el.removeAttribute('data-edit-active')
      editPopoverTriggerRef.current = null
    }
  }, [editPopoverOpen])

  // Handler for "Configure Statuses" context menu action
  // Opens the EditPopover for status configuration
  // Uses setTimeout to delay opening until after context menu closes,
  // preventing the popover from immediately closing due to focus shift
  const openConfigureStatuses = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('statuses'), 50)
  }, [captureContextMenuPosition])

  // Handler for "Configure Labels" context menu action
  // Opens the EditPopover for label configuration, storing which label was right-clicked
  const openConfigureLabels = useCallback(
    (labelId?: string) => {
      editLabelTargetId.current = labelId
      captureContextMenuPosition()
      setTimeout(() => setEditPopoverOpen('labels'), 50)
    },
    [captureContextMenuPosition],
  )

  // Handler for "Edit Views" context menu action
  // Opens the EditPopover for view configuration
  const openConfigureViews = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('views'), 50)
  }, [captureContextMenuPosition])

  // Handler for "Delete View" context menu action
  // Removes the view from config by filtering it out and saving
  const handleDeleteView = useCallback(
    async (viewId: string) => {
      if (!activeWorkspace?.id) return
      try {
        const updated = viewConfigs.filter((v) => v.id !== viewId)
        await window.electronAPI.saveViews(activeWorkspace.id, updated)
      } catch (err) {
        console.error('[AppShell] Failed to delete view:', err)
      }
    },
    [activeWorkspace?.id, viewConfigs],
  )

  // Handler for "Add New Label" context menu action
  // Opens the EditPopover with 'add-label' context, storing which label was right-clicked
  // so the agent knows to add the new label relative to it
  const handleAddLabel = useCallback(
    (parentId?: string) => {
      editLabelTargetId.current = parentId
      captureContextMenuPosition()
      setTimeout(() => setEditPopoverOpen('add-label'), 50)
    },
    [captureContextMenuPosition],
  )

  // Handler for "Delete Label" context menu action
  // Deletes the label and all its descendants, stripping from sessions
  const handleDeleteLabel = useCallback(
    async (labelId: string) => {
      if (!activeWorkspace?.id) return
      try {
        await window.electronAPI.deleteLabel(activeWorkspace.id, labelId)
      } catch (err) {
        console.error('[AppShell] Failed to delete label:', err)
      }
    },
    [activeWorkspace?.id],
  )

  // Handler for "Add Source" context menu action
  // Opens the EditPopover for adding a new source
  // Optional sourceType param allows filter-aware context (from subcategory menus or filtered views)
  const openAddSource = useCallback(
    (sourceType?: 'api' | 'mcp' | 'local') => {
      captureContextMenuPosition()
      const key = sourceType
        ? (`add-source-${sourceType}` as const)
        : ('add-source' as const)
      setTimeout(() => setEditPopoverOpen(key), 50)
    },
    [captureContextMenuPosition],
  )

  // Handler for "Add Skill" context menu action
  // Opens the EditPopover for adding a new skill
  const openAddSkill = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('add-skill'), 50)
  }, [captureContextMenuPosition])

  // Handler for "Add Automation" context menu action
  // Opens the EditPopover for adding a new automation
  const openAddAutomation = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('automation-config'), 50)
  }, [captureContextMenuPosition])

  // Create a new chat and select it
  const handleNewChat = useCallback(
    (newPanel: boolean = false) => {
      if (!activeWorkspace) return

      setCollapseSessionNavigatorForProjectDraft(false)
      setProjectDraftTargetWorkspaceId(null)

      // Exit search mode and switch to All Sessions
      setSearchActive(false)
      setSearchQuery('')

      // Delegate to NavigationContext which handles session creation
      navigate(
        routes.action.newSession(),
        newPanel ? { newPanel: true, targetLaneId: 'main' } : undefined,
      )

      // Focus the chat input after navigation completes
      setTimeout(() => focusZone('chat', { intent: 'programmatic' }), 50)
    },
    [activeWorkspace, focusZone],
  )

  const handleNewProjectSession = useCallback(
    async (workspaceId: string) => {
      setSearchActive(false)
      setSearchQuery('')
      setProjectDraftTargetWorkspaceId(workspaceId)
      setWorkspaceSessionSnapshotLoadingIds((prev) => {
        if (!prev.has(workspaceId)) return prev
        const next = new Set(prev)
        next.delete(workspaceId)
        return next
      })
      setCollapseSessionNavigatorForProjectDraft(true)

      const createSessionInCurrentWorkspace = () => {
        setProjectDraftTargetWorkspaceId(workspaceId)
        setCollapseSessionNavigatorForProjectDraft(true)
        navigate(routes.action.newSession())
        setTimeout(() => focusZone('chat', { intent: 'programmatic' }), 50)
      }

      if (workspaceId !== activeWorkspaceId) {
        await Promise.resolve(
          onSelectWorkspace(workspaceId, false, {
            suppressSessionListLoading: true,
          }),
        )
        setTimeout(createSessionInCurrentWorkspace, 50)
        return
      }

      createSessionInCurrentWorkspace()
    },
    [activeWorkspaceId, focusZone, onSelectWorkspace],
  )

  const handleSelectProjectSession = useCallback(
    async (workspaceId: string, sessionId: string) => {
      setCollapseSessionNavigatorForProjectDraft(false)
      setProjectDraftTargetWorkspaceId(null)
      setSearchActive(false)
      setSearchQuery('')

      if (workspaceId !== activeWorkspaceId) {
        const route = routes.view.allSessions(sessionId)
        await Promise.resolve(
          onSelectWorkspace(workspaceId, false, {
            route,
            suppressSessionListLoading: true,
          }),
        )
        requestAnimationFrame(() => {
          focusZone('chat', { intent: 'programmatic' })
        })
        return
      }

      navigate(routes.view.allSessions(sessionId))
      focusZone('chat', { intent: 'programmatic' })
    },
    [activeWorkspaceId, focusZone, onSelectWorkspace],
  )

  // Delete Source - simplified since agents system is removed
  const handleDeleteSource = useCallback(
    async (sourceSlug: string) => {
      if (!activeWorkspace) return
      try {
        await window.electronAPI.deleteSource(activeWorkspace.id, sourceSlug)
        toast.success(t('toast.deletedSource'))
      } catch (error) {
        console.error('[Chat] Failed to delete source:', error)
        toast.error(t('toast.failedToDeleteSource'))
      }
    },
    [activeWorkspace],
  )

  // Delete Skill
  const handleDeleteSkill = useCallback(
    async (skillSlug: string) => {
      if (!activeWorkspace) return
      try {
        await window.electronAPI.deleteSkill(
          activeWorkspace.id,
          skillSlug,
          activeSkillsWorkingDirectory,
          activeQwenSessionId ?? undefined,
        )
        await reloadSkills({ force: true })
        toast.success(t('toast.deletedSkill', { slug: skillSlug }))
      } catch (error) {
        console.error('[Chat] Failed to delete skill:', error)
        toast.error(t('toast.failedToDeleteSkill'))
      }
    },
    [
      activeSkillsWorkingDirectory,
      activeQwenSessionId,
      activeWorkspace,
      reloadSkills,
      t,
    ],
  )

  const handleSetSkillEnabled = useCallback(
    async (skill: LoadedSkill, enabled: boolean) => {
      if (!activeWorkspace) return
      const scope = skill.providerLevel === 'project' ? 'project' : 'global'
      try {
        await window.electronAPI.setSkillEnabled(
          activeWorkspace.id,
          skill.slug,
          enabled,
          activeSkillsWorkingDirectory,
          activeQwenSessionId ?? undefined,
          scope,
        )
        await reloadSkills({ force: true })
      } catch (error) {
        console.error('[Chat] Failed to update skill:', error)
        toast.error(t('toast.failedToUpdateSkill', 'Failed to update skill'))
        throw error
      }
    },
    [
      activeSkillsWorkingDirectory,
      activeQwenSessionId,
      activeWorkspace,
      reloadSkills,
      t,
    ],
  )

  // Respond to menu bar "New Chat" trigger
  const menuTriggerRef = useRef(menuNewChatTrigger)
  useEffect(() => {
    // Skip initial render
    if (menuTriggerRef.current === menuNewChatTrigger) return
    menuTriggerRef.current = menuNewChatTrigger
    handleNewChat()
  }, [menuNewChatTrigger, handleNewChat])

  // Unified sidebar items: nav buttons only (agents system removed)
  type SidebarItem = {
    id: string
    type: 'nav'
    action?: () => void
  }

  const unifiedSidebarItems = React.useMemo((): SidebarItem[] => {
    const result: SidebarItem[] = []

    result.push({ id: 'nav:skills', type: 'nav', action: handleSkillsClick })
    result.push({
      id: 'nav:skill-marketplace',
      type: 'nav',
      action: handleSkillMarketplaceClick,
    })
    result.push({
      id: 'nav:automations',
      type: 'nav',
      action: handleAutomationsClick,
    })
    result.push({
      id: 'nav:settings',
      type: 'nav',
      action: () => handleSettingsClick(),
    })

    return result
  }, [
    handleSkillsClick,
    handleSkillMarketplaceClick,
    handleMarketplaceSkillSelect,
    handleAutomationsClick,
    handleSettingsClick,
  ])

  // Toggle folder expanded state
  const handleToggleFolder = React.useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  // Get props for any sidebar item (unified roving tabindex pattern)
  const getSidebarItemProps = React.useCallback(
    (id: string) => ({
      tabIndex: focusedSidebarItemId === id ? 0 : -1,
      'data-focused': focusedSidebarItemId === id,
      ref: (el: HTMLElement | null) => {
        if (el) {
          sidebarItemRefs.current.set(id, el)
        } else {
          sidebarItemRefs.current.delete(id)
        }
      },
    }),
    [focusedSidebarItemId],
  )

  // Unified sidebar keyboard navigation
  const handleSidebarKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (!sidebarFocused || unifiedSidebarItems.length === 0) return

      const currentIndex = unifiedSidebarItems.findIndex(
        (item) => item.id === focusedSidebarItemId,
      )
      const currentItem =
        currentIndex >= 0 ? unifiedSidebarItems[currentIndex] : null

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault()
          const nextIndex =
            currentIndex < unifiedSidebarItems.length - 1 ? currentIndex + 1 : 0
          const nextItem = unifiedSidebarItems[nextIndex]
          setFocusedSidebarItemId(nextItem.id)
          sidebarItemRefs.current.get(nextItem.id)?.focus()
          break
        }
        case 'ArrowUp': {
          e.preventDefault()
          const prevIndex =
            currentIndex > 0 ? currentIndex - 1 : unifiedSidebarItems.length - 1
          const prevItem = unifiedSidebarItems[prevIndex]
          setFocusedSidebarItemId(prevItem.id)
          sidebarItemRefs.current.get(prevItem.id)?.focus()
          break
        }
        case 'ArrowLeft': {
          e.preventDefault()
          // At boundary - do nothing (Left doesn't change zones from sidebar)
          break
        }
        case 'ArrowRight': {
          e.preventDefault()
          // Move to next zone (navigator) - keyboard navigation
          focusZone('navigator', { intent: 'keyboard' })
          break
        }
        case 'Enter':
        case ' ': {
          e.preventDefault()
          if (currentItem?.type === 'nav' && currentItem.action) {
            currentItem.action()
          }
          break
        }
        case 'Home': {
          e.preventDefault()
          if (unifiedSidebarItems.length > 0) {
            const firstItem = unifiedSidebarItems[0]
            setFocusedSidebarItemId(firstItem.id)
            sidebarItemRefs.current.get(firstItem.id)?.focus()
          }
          break
        }
        case 'End': {
          e.preventDefault()
          if (unifiedSidebarItems.length > 0) {
            const lastItem = unifiedSidebarItems[unifiedSidebarItems.length - 1]
            setFocusedSidebarItemId(lastItem.id)
            sidebarItemRefs.current.get(lastItem.id)?.focus()
          }
          break
        }
      }
    },
    [sidebarFocused, unifiedSidebarItems, focusedSidebarItemId, focusZone],
  )

  // Focus sidebar item when sidebar zone gains focus
  React.useEffect(() => {
    if (sidebarFocused && unifiedSidebarItems.length > 0) {
      // Set focused item if not already set
      const itemId = focusedSidebarItemId || unifiedSidebarItems[0].id
      if (!focusedSidebarItemId) {
        setFocusedSidebarItemId(itemId)
      }
      // Actually focus the DOM element
      requestAnimationFrame(() => {
        sidebarItemRefs.current.get(itemId)?.focus()
      })
    }
  }, [sidebarFocused, focusedSidebarItemId, unifiedSidebarItems])

  // Get title based on navigation state
  const listTitle = React.useMemo(() => {
    // Sources navigator
    if (isSourcesNavigation(navState)) {
      return t('sidebar.sources')
    }

    // Skills navigator
    if (isSkillsNavigation(navState)) {
      return t('sidebar.allSkills')
    }

    if (isSkillMarketplaceNavigation(navState)) {
      return t('sidebar.skillMarketplace')
    }

    // Automations navigator
    if (isAutomationsNavigation(navState)) {
      if (!automationFilter) return t('sidebar.allAutomations')
      switch (automationFilter.automationType) {
        case 'scheduled':
          return t('sidebar.scheduled')
        case 'event':
          return t('sidebar.eventBased')
        case 'agentic':
          return t('sidebar.agentic')
        default:
          return t('sidebar.allAutomations')
      }
    }

    // Settings navigator
    if (isSettingsNavigation(navState)) return t('sidebar.settings')

    // Sessions navigator - use sessionFilter
    if (!sessionFilter) return t('sidebar.allSessions')

    switch (sessionFilter.kind) {
      case 'flagged':
        return t('sidebar.flagged')
      case 'state': {
        const state = effectiveSessionStatuses.find(
          (s) => s.id === sessionFilter.stateId,
        )
        return state
          ? t(`status.${state.id}`, state.label)
          : t('sidebar.allSessions')
      }
      case 'label':
        if (!FEATURE_FLAGS.sessionLabelsUi) return t('sidebar.allSessions')
        return sessionFilter.labelId === '__all__'
          ? t('sidebar.labels')
          : getLabelDisplayName(labelConfigs, sessionFilter.labelId)
      case 'view':
        return sessionFilter.viewId === '__all__'
          ? t('sidebar.views')
          : viewConfigs.find((v) => v.id === sessionFilter.viewId)?.name ||
              t('sidebar.views')
      default:
        return t('sidebar.allSessions')
    }
  }, [
    navState,
    t,
    sessionFilter,
    automationFilter,
    labelConfigs,
    viewConfigs,
    effectiveSessionStatuses,
  ])

  const browserDockExpandedLeft = effectiveSidebarAndNavigatorHidden
    ? PANEL_EDGE_INSET
    : isSidebarVisible
      ? sidebarWidth + PANEL_GAP
      : PANEL_EDGE_INSET

  return (
    <AppShellProvider value={appShellContextValue}>
      {/* === TOP BAR === */}
      <TopBar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={onSelectWorkspace}
        workspaceUnreadMap={workspaceUnreadMap}
        onWorkspaceCreated={() => onRefreshWorkspaces?.()}
        onWorkspaceRemoved={() => onRefreshWorkspaces?.()}
        onNewChat={() => handleNewChat()}
        onNewWindow={() => window.electronAPI.menuNewWindow()}
        onOpenSettings={onOpenSettings}
        onOpenSettingsSubpage={handleSettingsClick}
        onOpenKeyboardShortcuts={onOpenKeyboardShortcuts}
        onShowAbout={
          BRAND.creditsEntries.length > 0
            ? () => setShowAboutDialog(true)
            : undefined
        }
        onBack={goBack}
        onForward={goForward}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onToggleSidebar={handleToggleSidebar}
        onToggleFocusMode={() =>
          setIsSidebarAndNavigatorHidden((prev) => !prev)
        }
        isCompact={isAutoCompact}
      />

      {/* About dialog */}
      <AboutDialog open={showAboutDialog} onOpenChange={setShowAboutDialog} />

      {/* === OUTER LAYOUT: Unified Panel Stack | Right Sidebar === */}
      <div
        ref={shellRef}
        className="flex items-stretch relative"
        style={{
          height: '100%',
          paddingRight: 0,
          paddingBottom: 0,
          paddingLeft: 0,
          gap: PANEL_GAP,
        }}
      >
        <PanelStackContainer
          sidebarSlot={
            <div
              ref={sidebarRef}
              style={{ width: sidebarWidth }}
              className="h-full font-sans relative"
              data-focus-zone="sidebar"
              tabIndex={sidebarFocused ? 0 : -1}
              onKeyDown={handleSidebarKeyDown}
            >
              <div className="flex h-full flex-col select-none pt-[48px]">
                {/* Sidebar Top Section */}
                <div className="flex-1 flex flex-col min-h-0">
                  {/* New Session Button - matches sidebar rows, with context menu for "Open in New Window" */}
                  <div className="px-2 pb-0 shrink-0 grid gap-0.5">
                    <ContextMenu modal={true}>
                      <ContextMenuTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => handleNewChat(e.metaKey || e.ctrlKey)}
                          className={cn(
                            'group flex w-full items-center gap-2 rounded-[6px] px-2 py-[5px]',
                            'text-[13px] font-normal select-none outline-none titlebar-no-drag',
                            'hover:bg-sidebar-hover data-[state=open]:bg-sidebar-hover',
                            'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
                          )}
                          data-tutorial="new-chat-button"
                        >
                          <SquarePenRounded
                            className="h-3.5 w-3.5 shrink-0"
                            style={{
                              color:
                                'color-mix(in oklch, var(--foreground) 60%, transparent)',
                            }}
                          />
                          <span className="min-w-0 flex-1 truncate text-left">
                            {t('session.newSession')}
                          </span>
                          {newChatHotkey && (
                            <span
                              className={cn(
                                'ml-auto shrink-0 text-xs text-foreground/30 opacity-0 transition-opacity',
                                'group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:opacity-100',
                              )}
                            >
                              {newChatHotkey}
                            </span>
                          )}
                        </button>
                      </ContextMenuTrigger>
                      <StyledContextMenuContent>
                        <ContextMenuProvider>
                          <SidebarMenu type="newSession" />
                        </ContextMenuProvider>
                      </StyledContextMenuContent>
                    </ContextMenu>
                    <SidebarSessionSearch
                      workspaces={workspaces}
                      workspaceSessions={projectTreeWorkspaceSessions}
                      activeWorkspaceId={activeWorkspaceId}
                      selectedSessionId={effectiveSessionId}
                      onSelectSession={handleSelectProjectSession}
                      onRevealSession={handleRevealProjectSession}
                    />
                  </div>
                  <div className="shrink-0 border-b border-foreground/5 pt-0 pb-2">
                    <LeftSidebar
                      isCollapsed={false}
                      className="py-0 mt-0.5"
                      getItemProps={getSidebarItemProps}
                      focusedItemId={focusedSidebarItemId}
                      links={[
                        {
                          id: 'nav:skills',
                          title: t('sidebar.skills'),
                          label: skillsLoading
                            ? undefined
                            : String(skills.length),
                          icon: Zap,
                          variant: isSkillsNavigation(navState)
                            ? 'default'
                            : 'ghost',
                          onClick: handleSkillsClick,
                          contextMenu: {
                            type: 'skills',
                            onAddSkill: openAddSkill,
                          },
                        },
                        {
                          id: 'nav:skill-marketplace',
                          title: t('sidebar.skillMarketplace'),
                          icon: Store,
                          variant: isSkillMarketplaceNavigation(navState)
                            ? 'default'
                            : 'ghost',
                          onClick: handleSkillMarketplaceClick,
                        },
                        {
                          id: 'nav:automations',
                          title: t('sidebar.automations'),
                          label: String(automations.length),
                          icon: ListTodo,
                          variant:
                            isAutomationsNavigation(navState) &&
                            !automationFilter
                              ? 'default'
                              : 'ghost',
                          onClick: handleAutomationsClick,
                          expandable: true,
                          expanded: isExpanded('nav:automations'),
                          onToggle: () => toggleExpanded('nav:automations'),
                          contextMenu: {
                            type: 'automations' as const,
                            onAddAutomation: openAddAutomation,
                          },
                          items: [
                            {
                              id: 'nav:automations:scheduled',
                              title: t('sidebar.scheduled'),
                              label: String(automationTypeCounts.scheduled),
                              icon: Clock,
                              variant:
                                automationFilter?.kind === 'type' &&
                                automationFilter.automationType === 'scheduled'
                                  ? 'default'
                                  : 'ghost',
                              onClick: handleAutomationsScheduledClick,
                              contextMenu: {
                                type: 'automations' as const,
                                onAddAutomation: openAddAutomation,
                              },
                            },
                            {
                              id: 'nav:automations:event',
                              title: t('sidebar.eventBased'),
                              label: String(automationTypeCounts.event),
                              icon: Radio,
                              variant:
                                automationFilter?.kind === 'type' &&
                                automationFilter.automationType === 'event'
                                  ? 'default'
                                  : 'ghost',
                              onClick: handleAutomationsEventClick,
                              contextMenu: {
                                type: 'automations' as const,
                                onAddAutomation: openAddAutomation,
                              },
                            },
                            {
                              id: 'nav:automations:agentic',
                              title: t('sidebar.agentic'),
                              label: String(automationTypeCounts.agentic),
                              icon: Bot,
                              variant:
                                automationFilter?.kind === 'type' &&
                                automationFilter.automationType === 'agentic'
                                  ? 'default'
                                  : 'ghost',
                              onClick: handleAutomationsAgenticClick,
                              contextMenu: {
                                type: 'automations' as const,
                                onAddAutomation: openAddAutomation,
                              },
                            },
                          ],
                        },
                        {
                          id: 'nav:settings',
                          title: t('sidebar.settings'),
                          icon: Settings,
                          variant: isSettingsNavigation(navState)
                            ? 'default'
                            : 'ghost',
                          onClick: () => handleSettingsClick(),
                        },
                      ]}
                    />
                  </div>
                  <WorkspaceProjectTree
                    workspaces={workspaces}
                    activeWorkspaceId={activeWorkspaceId}
                    selectedSessionId={effectiveSessionId}
                    workspaceSessions={projectTreeWorkspaceSessions}
                    loadingWorkspaceSessionIds={
                      projectTreeLoadingWorkspaceSessionIds
                    }
                    workspaceUnreadMap={workspaceUnreadMap}
                    revealRequest={projectSessionRevealRequest}
                    onSelectWorkspace={onSelectWorkspace}
                    onSelectSession={handleSelectProjectSession}
                    onNewSession={handleNewProjectSession}
                    onWorkspaceCreated={() => onRefreshWorkspaces?.()}
                    onWorkspaceChanged={() => onRefreshWorkspaces?.()}
                    sessionStatuses={effectiveSessionStatuses}
                    labels={displayLabelConfigs}
                    onDeleteSession={handleDeleteSession}
                    onFlagSession={onFlagSession}
                    onUnflagSession={onUnflagSession}
                    onArchiveSession={onArchiveSession}
                    onUnarchiveSession={onUnarchiveSession}
                    onMarkSessionUnread={onMarkSessionUnread}
                    onSessionStatusChange={onSessionStatusChange}
                    onRenameSession={onRenameSession}
                    onSessionLabelsChange={handleSessionLabelsChange}
                  />
                </div>
              </div>
            </div>
          }
          sidebarWidth={
            effectiveSidebarAndNavigatorHidden
              ? 0
              : isSidebarVisible
                ? sidebarWidth
                : 0
          }
          navigatorSlot={
            isAllSessionsNavigatorHidden ||
            isSessionNavigatorCollapsed ? null : (
              <div
                style={{ width: isAutoCompact ? '100%' : sessionListWidth }}
                className="h-full flex flex-col min-w-0 relative z-panel"
              >
                <PanelHeader
                  title={isSidebarVisible ? listTitle : undefined}
                  compensateForStoplight={!isSidebarVisible}
                  badge={
                    automationFilter?.automationType === 'scheduled' ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-muted-foreground/50 cursor-default flex items-center titlebar-no-drag">
                            <Info className="h-3 w-3" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-[220px]">
                          Scheduling requires your machine to be running. It can
                          be locked, but must be powered on.
                        </TooltipContent>
                      </Tooltip>
                    ) : undefined
                  }
                  actions={
                    <>
                      {/* Filter dropdown - available in ALL chat views.
                      Shows user-added filters (removable) and pinned filters (non-removable, derived from route).
                      Pinned filters: state views pin a status, label views pin a label, flagged pins the flag. */}
                      {isSessionsNavigation(navState) && (
                        <DropdownMenu
                          onOpenChange={(open) => {
                            if (!open) {
                              setFilterDropdownQuery('')
                              setFilterAltHeld(false)
                            }
                          }}
                        >
                          <DropdownMenuTrigger asChild>
                            <HeaderIconButton
                              icon={<ListFilter className="h-4 w-4" />}
                              className={
                                listFilter.size > 0 || labelFilter.size > 0
                                  ? 'bg-accent/5 text-accent rounded-[8px] shadow-tinted'
                                  : 'rounded-[8px]'
                              }
                              style={
                                listFilter.size > 0 || labelFilter.size > 0
                                  ? ({
                                      '--shadow-color': 'var(--accent-rgb)',
                                    } as React.CSSProperties)
                                  : undefined
                              }
                            />
                          </DropdownMenuTrigger>
                          <StyledDropdownMenuContent
                            align="end"
                            light
                            minWidth="min-w-[200px]"
                            onKeyDown={(e: React.KeyboardEvent) => {
                              if (e.key === 'Alt') setFilterAltHeld(true)
                              // When on the first menu item and pressing Up, refocus the search input
                              if (
                                e.key === 'ArrowUp' &&
                                !filterDropdownQuery.trim()
                              ) {
                                const menu = (e.target as HTMLElement).closest(
                                  '[role="menu"]',
                                )
                                const items =
                                  menu?.querySelectorAll('[role="menuitem"]')
                                if (
                                  items &&
                                  items.length > 0 &&
                                  document.activeElement === items[0]
                                ) {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  filterDropdownInputRef.current?.focus()
                                }
                              }
                            }}
                            onKeyUp={(e: React.KeyboardEvent) => {
                              if (e.key === 'Alt') setFilterAltHeld(false)
                            }}
                          >
                            {/* Header with title and clear button (only clears user-added filters, never pinned) */}
                            <div className="flex items-center justify-between px-2 py-1.5">
                              <span className="text-xs font-medium text-muted-foreground">
                                {t('sidebar.filterChats')}
                              </span>
                              {(listFilter.size > 0 ||
                                labelFilter.size > 0) && (
                                <button
                                  onClick={(e) => {
                                    e.preventDefault()
                                    setListFilter(new Map())
                                    setLabelFilter(new Map())
                                  }}
                                  className="text-xs text-muted-foreground hover:text-foreground"
                                >
                                  Clear
                                </button>
                              )}
                            </div>

                            {/* Search input — typing switches from hierarchical submenus to a flat filtered list.
                            stopPropagation prevents Radix from intercepting keys. Arrow/Enter handled for navigation. */}
                            <div className="px-1 pb-3 border-b border-foreground/5">
                              <div className="bg-background rounded-[6px] shadow-minimal px-2 py-1.5">
                                <input
                                  ref={filterDropdownInputRef}
                                  type="text"
                                  value={filterDropdownQuery}
                                  onChange={(e) =>
                                    setFilterDropdownQuery(e.target.value)
                                  }
                                  onKeyDown={(e) => {
                                    // When input is empty, let ArrowDown/ArrowUp blur the input
                                    // so Radix's native menu keyboard navigation takes over
                                    if (
                                      !filterDropdownQuery.trim() &&
                                      (e.key === 'ArrowDown' ||
                                        e.key === 'ArrowUp')
                                    ) {
                                      e.preventDefault()
                                      ;(e.target as HTMLInputElement).blur()
                                      // Focus the first menu item so Radix's keyboard navigation activates
                                      const menu = (
                                        e.target as HTMLElement
                                      ).closest('[role="menu"]')
                                      const firstItem = menu?.querySelector(
                                        '[role="menuitem"]',
                                      ) as HTMLElement | null
                                      firstItem?.focus()
                                      return
                                    }
                                    e.stopPropagation()
                                    const { states: ms, labels: ml } =
                                      filterDropdownResults
                                    const total = ms.length + ml.length
                                    if (total === 0) return
                                    switch (e.key) {
                                      case 'ArrowDown':
                                        e.preventDefault()
                                        setFilterDropdownSelectedIdx((prev) =>
                                          prev < total - 1 ? prev + 1 : 0,
                                        )
                                        break
                                      case 'ArrowUp':
                                        e.preventDefault()
                                        setFilterDropdownSelectedIdx((prev) =>
                                          prev > 0 ? prev - 1 : total - 1,
                                        )
                                        break
                                      case 'Enter': {
                                        e.preventDefault()
                                        const mode: FilterMode = e.altKey
                                          ? 'exclude'
                                          : 'include'
                                        const idx = filterDropdownSelectedIdx
                                        if (idx < ms.length) {
                                          // Toggle a status filter
                                          const state = ms[idx]
                                          if (
                                            state.id !==
                                            pinnedFilters.pinnedStatusId
                                          ) {
                                            setListFilter((prev) => {
                                              const next = new Map(prev)
                                              if (next.has(state.id))
                                                next.delete(state.id)
                                              else next.set(state.id, mode)
                                              return next
                                            })
                                          }
                                        } else {
                                          // Toggle a label filter
                                          const item = ml[idx - ms.length]
                                          if (
                                            item &&
                                            item.id !==
                                              pinnedFilters.pinnedLabelId
                                          ) {
                                            setLabelFilter((prev) => {
                                              const next = new Map(prev)
                                              if (next.has(item.id))
                                                next.delete(item.id)
                                              else next.set(item.id, mode)
                                              return next
                                            })
                                          }
                                        }
                                        break
                                      }
                                    }
                                  }}
                                  placeholder={t(
                                    FEATURE_FLAGS.sessionLabelsUi
                                      ? 'sidebar.searchStatusesLabels'
                                      : 'sidebar.searchStatuses',
                                  )}
                                  className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                                  autoFocus
                                />
                              </div>
                            </div>

                            {/* ── Conditional body: hierarchical (no query) vs flat filtered list (has query) ── */}
                            {filterDropdownQuery.trim() === '' ? (
                              <>
                                {/* === HIERARCHICAL MODE (default) === */}

                                {/* Active filter chips: pinned (non-removable) + user-added (removable) */}
                                {(pinnedFilters.pinnedFlagged ||
                                  pinnedFilters.pinnedStatusId ||
                                  pinnedFilters.pinnedLabelId ||
                                  listFilter.size > 0 ||
                                  labelFilter.size > 0) && (
                                  <>
                                    {/* Pinned: flagged */}
                                    {pinnedFilters.pinnedFlagged && (
                                      <StyledDropdownMenuItem disabled>
                                        <FilterMenuRow
                                          icon={
                                            <Flag className="h-3.5 w-3.5" />
                                          }
                                          label={t('sidebar.flagged')}
                                          accessory={
                                            <Check className="h-3 w-3 text-muted-foreground" />
                                          }
                                        />
                                      </StyledDropdownMenuItem>
                                    )}
                                    {/* Pinned: status from state view */}
                                    {(() => {
                                      if (!pinnedFilters.pinnedStatusId)
                                        return null
                                      const state =
                                        effectiveSessionStatuses.find(
                                          (s) =>
                                            s.id ===
                                            pinnedFilters.pinnedStatusId,
                                        )
                                      if (!state) return null
                                      return (
                                        <StyledDropdownMenuItem
                                          disabled
                                          key={`pinned-status-${state.id}`}
                                        >
                                          <FilterMenuRow
                                            icon={state.icon}
                                            label={state.label}
                                            accessory={
                                              <Check className="h-3 w-3 text-muted-foreground" />
                                            }
                                            iconStyle={
                                              state.iconColorable
                                                ? { color: state.resolvedColor }
                                                : undefined
                                            }
                                            noIconContainer
                                          />
                                        </StyledDropdownMenuItem>
                                      )
                                    })()}
                                    {/* Pinned: label from label view */}
                                    {(() => {
                                      if (!pinnedFilters.pinnedLabelId)
                                        return null
                                      const label = findLabelById(
                                        labelConfigs,
                                        pinnedFilters.pinnedLabelId,
                                      )
                                      if (!label) return null
                                      return (
                                        <StyledDropdownMenuItem
                                          disabled
                                          key={`pinned-label-${label.id}`}
                                        >
                                          <FilterMenuRow
                                            icon={
                                              <LabelIcon
                                                label={label}
                                                size="lg"
                                              />
                                            }
                                            label={label.name}
                                            accessory={
                                              <Check className="h-3 w-3 text-muted-foreground" />
                                            }
                                          />
                                        </StyledDropdownMenuItem>
                                      )
                                    })()}
                                    {/* User-added: selected statuses with mode pill (include/exclude) */}
                                    {effectiveSessionStatuses
                                      .filter((s) => listFilter.has(s.id))
                                      .map((state) => {
                                        const applyColor = state.iconColorable
                                        const mode = listFilter.get(state.id)!
                                        return (
                                          <DropdownMenuSub
                                            key={`sel-status-${state.id}`}
                                          >
                                            <StyledDropdownMenuSubTrigger
                                              onClick={(e) => {
                                                e.preventDefault()
                                                setListFilter((prev) => {
                                                  const next = new Map(prev)
                                                  next.delete(state.id)
                                                  return next
                                                })
                                              }}
                                            >
                                              <FilterMenuRow
                                                icon={state.icon}
                                                label={state.label}
                                                accessory={
                                                  <FilterModeBadge
                                                    mode={mode}
                                                  />
                                                }
                                                iconStyle={
                                                  applyColor
                                                    ? {
                                                        color:
                                                          state.resolvedColor,
                                                      }
                                                    : undefined
                                                }
                                                noIconContainer
                                              />
                                            </StyledDropdownMenuSubTrigger>
                                            <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                              <FilterModeSubMenuItems
                                                mode={mode}
                                                onChangeMode={(newMode) =>
                                                  setListFilter((prev) => {
                                                    const next = new Map(prev)
                                                    next.set(state.id, newMode)
                                                    return next
                                                  })
                                                }
                                                onRemove={() =>
                                                  setListFilter((prev) => {
                                                    const next = new Map(prev)
                                                    next.delete(state.id)
                                                    return next
                                                  })
                                                }
                                              />
                                            </StyledDropdownMenuSubContent>
                                          </DropdownMenuSub>
                                        )
                                      })}
                                    {/* User-added: selected labels with mode pill (include/exclude) */}
                                    {Array.from(labelFilter).map(
                                      ([labelId, mode]) => {
                                        const label = findLabelById(
                                          labelConfigs,
                                          labelId,
                                        )
                                        if (!label) return null
                                        return (
                                          <DropdownMenuSub
                                            key={`sel-label-${labelId}`}
                                          >
                                            <StyledDropdownMenuSubTrigger
                                              onClick={(e) => {
                                                e.preventDefault()
                                                setLabelFilter((prev) => {
                                                  const next = new Map(prev)
                                                  next.delete(labelId)
                                                  return next
                                                })
                                              }}
                                            >
                                              <FilterMenuRow
                                                icon={
                                                  <LabelIcon
                                                    label={label}
                                                    size="lg"
                                                  />
                                                }
                                                label={label.name}
                                                accessory={
                                                  <FilterModeBadge
                                                    mode={mode}
                                                  />
                                                }
                                              />
                                            </StyledDropdownMenuSubTrigger>
                                            <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                              <FilterModeSubMenuItems
                                                mode={mode}
                                                onChangeMode={(newMode) =>
                                                  setLabelFilter((prev) => {
                                                    const next = new Map(prev)
                                                    next.set(labelId, newMode)
                                                    return next
                                                  })
                                                }
                                                onRemove={() =>
                                                  setLabelFilter((prev) => {
                                                    const next = new Map(prev)
                                                    next.delete(labelId)
                                                    return next
                                                  })
                                                }
                                              />
                                            </StyledDropdownMenuSubContent>
                                          </DropdownMenuSub>
                                        )
                                      },
                                    )}
                                    <StyledDropdownMenuSeparator />
                                  </>
                                )}

                                {/* Statuses submenu - hierarchical with toggle selection */}
                                <DropdownMenuSub>
                                  <StyledDropdownMenuSubTrigger>
                                    <Inbox className="h-3.5 w-3.5" />
                                    <span className="flex-1">
                                      {t('sidebar.statuses')}
                                    </span>
                                  </StyledDropdownMenuSubTrigger>
                                  <StyledDropdownMenuSubContent minWidth="min-w-[180px]">
                                    {effectiveSessionStatuses.map((state) => {
                                      const applyColor = state.iconColorable
                                      const isPinned =
                                        state.id ===
                                        pinnedFilters.pinnedStatusId
                                      const currentMode = listFilter.get(
                                        state.id,
                                      )
                                      const isActive =
                                        !!currentMode && !isPinned
                                      // Active status → DropdownMenuSub with mode options (Radix safe-triangle hover)
                                      if (isActive) {
                                        return (
                                          <DropdownMenuSub key={state.id}>
                                            <StyledDropdownMenuSubTrigger
                                              onClick={(e) => {
                                                e.preventDefault()
                                                setListFilter((prev) => {
                                                  const next = new Map(prev)
                                                  next.delete(state.id)
                                                  return next
                                                })
                                              }}
                                            >
                                              <FilterMenuRow
                                                icon={state.icon}
                                                label={state.label}
                                                accessory={
                                                  <FilterModeBadge
                                                    mode={currentMode}
                                                  />
                                                }
                                                iconStyle={
                                                  applyColor
                                                    ? {
                                                        color:
                                                          state.resolvedColor,
                                                      }
                                                    : undefined
                                                }
                                                noIconContainer
                                              />
                                            </StyledDropdownMenuSubTrigger>
                                            <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                              <FilterModeSubMenuItems
                                                mode={currentMode}
                                                onChangeMode={(newMode) =>
                                                  setListFilter((prev) => {
                                                    const next = new Map(prev)
                                                    next.set(state.id, newMode)
                                                    return next
                                                  })
                                                }
                                                onRemove={() =>
                                                  setListFilter((prev) => {
                                                    const next = new Map(prev)
                                                    next.delete(state.id)
                                                    return next
                                                  })
                                                }
                                              />
                                            </StyledDropdownMenuSubContent>
                                          </DropdownMenuSub>
                                        )
                                      }
                                      // Inactive / pinned status → simple toggleable item
                                      return (
                                        <AltExcludeTooltip
                                          key={state.id}
                                          show={filterAltHeld && !isPinned}
                                        >
                                          <StyledDropdownMenuItem
                                            disabled={isPinned}
                                            onClick={(e) => {
                                              if (isPinned) return
                                              e.preventDefault()
                                              setListFilter((prev) => {
                                                const next = new Map(prev)
                                                if (next.has(state.id))
                                                  next.delete(state.id)
                                                else
                                                  next.set(
                                                    state.id,
                                                    e.altKey
                                                      ? 'exclude'
                                                      : 'include',
                                                  )
                                                return next
                                              })
                                            }}
                                          >
                                            <FilterMenuRow
                                              icon={state.icon}
                                              label={state.label}
                                              accessory={
                                                isPinned ? (
                                                  <Check className="h-3 w-3 text-muted-foreground" />
                                                ) : null
                                              }
                                              iconStyle={
                                                applyColor
                                                  ? {
                                                      color:
                                                        state.resolvedColor,
                                                    }
                                                  : undefined
                                              }
                                              noIconContainer
                                            />
                                          </StyledDropdownMenuItem>
                                        </AltExcludeTooltip>
                                      )
                                    })}
                                  </StyledDropdownMenuSubContent>
                                </DropdownMenuSub>

                                {FEATURE_FLAGS.sessionLabelsUi && (
                                  <DropdownMenuSub>
                                    <StyledDropdownMenuSubTrigger>
                                      <Tag className="h-3.5 w-3.5" />
                                      <span className="flex-1">
                                        {t('sidebar.labels')}
                                      </span>
                                    </StyledDropdownMenuSubTrigger>
                                    <StyledDropdownMenuSubContent minWidth="min-w-[180px]">
                                      {labelConfigs.length === 0 ? (
                                        <StyledDropdownMenuItem disabled>
                                          <span className="text-muted-foreground">
                                            {t('table.noLabelsConfigured')}
                                          </span>
                                        </StyledDropdownMenuItem>
                                      ) : (
                                        <FilterLabelItems
                                          labels={displayLabelConfigs}
                                          labelFilter={labelFilter}
                                          setLabelFilter={setLabelFilter}
                                          pinnedLabelId={
                                            pinnedFilters.pinnedLabelId
                                          }
                                          altHeld={filterAltHeld}
                                        />
                                      )}
                                    </StyledDropdownMenuSubContent>
                                  </DropdownMenuSub>
                                )}

                                {/* Group by submenu - hidden in state sub-views (always date there) */}
                                {!isStateSubView && (
                                  <>
                                    <StyledDropdownMenuSeparator />
                                    <DropdownMenuSub>
                                      <StyledDropdownMenuSubTrigger>
                                        <Layers className="h-3.5 w-3.5" />
                                        <span className="flex-1">
                                          {t('sidebar.group')}
                                        </span>
                                      </StyledDropdownMenuSubTrigger>
                                      <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                        <StyledDropdownMenuItem
                                          onClick={() =>
                                            setChatGroupingMode('none')
                                          }
                                        >
                                          <ListTodo className="h-3.5 w-3.5" />
                                          <span className="flex-1">
                                            {t(
                                              'sidebar.groupNone',
                                              'No grouping',
                                            )}
                                          </span>
                                          {chatGroupingMode === 'none' && (
                                            <Check className="h-3 w-3 text-muted-foreground" />
                                          )}
                                        </StyledDropdownMenuItem>
                                        <StyledDropdownMenuItem
                                          onClick={() =>
                                            setChatGroupingMode('date')
                                          }
                                        >
                                          <Calendar className="h-3.5 w-3.5" />
                                          <span className="flex-1">
                                            {t('sidebar.groupByDate')}
                                          </span>
                                          {chatGroupingMode === 'date' && (
                                            <Check className="h-3 w-3 text-muted-foreground" />
                                          )}
                                        </StyledDropdownMenuItem>
                                        <StyledDropdownMenuItem
                                          onClick={() =>
                                            setChatGroupingMode('status')
                                          }
                                        >
                                          <Inbox className="h-3.5 w-3.5" />
                                          <span className="flex-1">
                                            {t('sidebar.groupByStatus')}
                                          </span>
                                          {chatGroupingMode === 'status' && (
                                            <Check className="h-3 w-3 text-muted-foreground" />
                                          )}
                                        </StyledDropdownMenuItem>
                                      </StyledDropdownMenuSubContent>
                                    </DropdownMenuSub>
                                  </>
                                )}

                                <StyledDropdownMenuSeparator />
                                <StyledDropdownMenuItem
                                  onClick={() => {
                                    setSearchActive(true)
                                  }}
                                >
                                  <Search className="h-3.5 w-3.5" />
                                  <span className="flex-1">
                                    {t('sidebar.search')}
                                  </span>
                                </StyledDropdownMenuItem>
                              </>
                            ) : (
                              <>
                                {/* === FLAT FILTERED MODE (has query) ===
                                Uses the same filter/score logic as the # inline menu.
                                Shows matching statuses and labels in a single flat list.
                                Supports keyboard navigation (ArrowUp/Down/Enter in input). */}
                                {filterDropdownResults.states.length === 0 &&
                                filterDropdownResults.labels.length === 0 ? (
                                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                                    {FEATURE_FLAGS.sessionLabelsUi
                                      ? 'No matching statuses or labels'
                                      : 'No matching statuses'}
                                  </div>
                                ) : (
                                  <div
                                    ref={filterDropdownListRef}
                                    className="max-h-[240px] overflow-y-auto py-1"
                                  >
                                    {/* Matched statuses */}
                                    {filterDropdownResults.states.length >
                                      0 && (
                                      <>
                                        <div className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                                          Statuses
                                        </div>
                                        {filterDropdownResults.states.map(
                                          (state, index) => {
                                            const applyColor =
                                              state.iconColorable
                                            const isPinned =
                                              state.id ===
                                              pinnedFilters.pinnedStatusId
                                            const currentMode = listFilter.get(
                                              state.id,
                                            )
                                            const isHighlighted =
                                              index ===
                                              filterDropdownSelectedIdx
                                            const isActive =
                                              !!currentMode && !isPinned
                                            // Active status → DropdownMenuSub with mode options
                                            if (isActive) {
                                              return (
                                                <DropdownMenuSub
                                                  key={`flat-status-${state.id}`}
                                                >
                                                  <StyledDropdownMenuSubTrigger
                                                    data-filter-selected={
                                                      isHighlighted
                                                    }
                                                    onMouseEnter={() =>
                                                      setFilterDropdownSelectedIdx(
                                                        index,
                                                      )
                                                    }
                                                    className={cn(
                                                      'mx-1',
                                                      isHighlighted &&
                                                        'bg-foreground/5',
                                                    )}
                                                    onClick={(e) => {
                                                      e.preventDefault()
                                                      setListFilter((prev) => {
                                                        const next = new Map(
                                                          prev,
                                                        )
                                                        next.delete(state.id)
                                                        return next
                                                      })
                                                    }}
                                                  >
                                                    <FilterMenuRow
                                                      icon={state.icon}
                                                      label={state.label}
                                                      accessory={
                                                        <FilterModeBadge
                                                          mode={currentMode}
                                                        />
                                                      }
                                                      iconStyle={
                                                        applyColor
                                                          ? {
                                                              color:
                                                                state.resolvedColor,
                                                            }
                                                          : undefined
                                                      }
                                                      noIconContainer
                                                    />
                                                  </StyledDropdownMenuSubTrigger>
                                                  <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                                    <FilterModeSubMenuItems
                                                      mode={currentMode}
                                                      onChangeMode={(newMode) =>
                                                        setListFilter(
                                                          (prev) => {
                                                            const next =
                                                              new Map(prev)
                                                            next.set(
                                                              state.id,
                                                              newMode,
                                                            )
                                                            return next
                                                          },
                                                        )
                                                      }
                                                      onRemove={() =>
                                                        setListFilter(
                                                          (prev) => {
                                                            const next =
                                                              new Map(prev)
                                                            next.delete(
                                                              state.id,
                                                            )
                                                            return next
                                                          },
                                                        )
                                                      }
                                                    />
                                                  </StyledDropdownMenuSubContent>
                                                </DropdownMenuSub>
                                              )
                                            }
                                            // Inactive / pinned status → plain div with click-to-toggle
                                            return (
                                              <AltExcludeTooltip
                                                key={`flat-status-${state.id}`}
                                                show={
                                                  filterAltHeld && !isPinned
                                                }
                                              >
                                                <div
                                                  data-filter-selected={
                                                    isHighlighted
                                                  }
                                                  onMouseEnter={() =>
                                                    setFilterDropdownSelectedIdx(
                                                      index,
                                                    )
                                                  }
                                                  onClick={(e) => {
                                                    if (isPinned) return
                                                    e.preventDefault()
                                                    setListFilter((prev) => {
                                                      const next = new Map(prev)
                                                      if (next.has(state.id))
                                                        next.delete(state.id)
                                                      else
                                                        next.set(
                                                          state.id,
                                                          e.altKey
                                                            ? 'exclude'
                                                            : 'include',
                                                        )
                                                      return next
                                                    })
                                                  }}
                                                  className={cn(
                                                    // SVG sizing matches StyledDropdownMenuSubTrigger so icons render at the same size
                                                    "flex cursor-pointer select-none items-center gap-2 rounded-[4px] mx-1 px-2 py-1.5 text-sm [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
                                                    isHighlighted &&
                                                      'bg-foreground/5',
                                                    isPinned &&
                                                      'opacity-50 pointer-events-none',
                                                  )}
                                                >
                                                  <FilterMenuRow
                                                    icon={state.icon}
                                                    label={state.label}
                                                    accessory={
                                                      isPinned ? (
                                                        <Check className="h-3 w-3 text-muted-foreground" />
                                                      ) : null
                                                    }
                                                    iconStyle={
                                                      applyColor
                                                        ? {
                                                            color:
                                                              state.resolvedColor,
                                                          }
                                                        : undefined
                                                    }
                                                    noIconContainer
                                                  />
                                                </div>
                                              </AltExcludeTooltip>
                                            )
                                          },
                                        )}
                                      </>
                                    )}
                                    {/* Separator between sections */}
                                    {filterDropdownResults.states.length > 0 &&
                                      filterDropdownResults.labels.length >
                                        0 && (
                                        <div className="my-1 mx-2 border-t border-border/40" />
                                      )}
                                    {/* Matched labels — flat list with parent breadcrumbs */}
                                    {filterDropdownResults.labels.length >
                                      0 && (
                                      <>
                                        <div className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                                          Labels
                                        </div>
                                        {filterDropdownResults.labels.map(
                                          (item, index) => {
                                            // Offset by state count for unified index
                                            const flatIndex =
                                              filterDropdownResults.states
                                                .length + index
                                            const isPinned =
                                              item.id ===
                                              pinnedFilters.pinnedLabelId
                                            const currentMode = labelFilter.get(
                                              item.id,
                                            )
                                            const isHighlighted =
                                              flatIndex ===
                                              filterDropdownSelectedIdx
                                            const isActive =
                                              !!currentMode && !isPinned
                                            const labelDisplay =
                                              item.parentPath ? (
                                                <>
                                                  <span className="text-muted-foreground">
                                                    {item.parentPath}
                                                  </span>
                                                  {item.label}
                                                </>
                                              ) : (
                                                item.label
                                              )
                                            // Active label → DropdownMenuSub with mode options
                                            if (isActive) {
                                              return (
                                                <DropdownMenuSub
                                                  key={`flat-label-${item.id}`}
                                                >
                                                  <StyledDropdownMenuSubTrigger
                                                    data-filter-selected={
                                                      isHighlighted
                                                    }
                                                    onMouseEnter={() =>
                                                      setFilterDropdownSelectedIdx(
                                                        flatIndex,
                                                      )
                                                    }
                                                    className={cn(
                                                      'mx-1',
                                                      isHighlighted &&
                                                        'bg-foreground/5',
                                                    )}
                                                    onClick={(e) => {
                                                      e.preventDefault()
                                                      setLabelFilter((prev) => {
                                                        const next = new Map(
                                                          prev,
                                                        )
                                                        next.delete(item.id)
                                                        return next
                                                      })
                                                    }}
                                                  >
                                                    <FilterMenuRow
                                                      icon={
                                                        <LabelIcon
                                                          label={item.config}
                                                          size="lg"
                                                        />
                                                      }
                                                      label={labelDisplay}
                                                      accessory={
                                                        <FilterModeBadge
                                                          mode={currentMode}
                                                        />
                                                      }
                                                    />
                                                  </StyledDropdownMenuSubTrigger>
                                                  <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                                    <FilterModeSubMenuItems
                                                      mode={currentMode}
                                                      onChangeMode={(newMode) =>
                                                        setLabelFilter(
                                                          (prev) => {
                                                            const next =
                                                              new Map(prev)
                                                            next.set(
                                                              item.id,
                                                              newMode,
                                                            )
                                                            return next
                                                          },
                                                        )
                                                      }
                                                      onRemove={() =>
                                                        setLabelFilter(
                                                          (prev) => {
                                                            const next =
                                                              new Map(prev)
                                                            next.delete(item.id)
                                                            return next
                                                          },
                                                        )
                                                      }
                                                    />
                                                  </StyledDropdownMenuSubContent>
                                                </DropdownMenuSub>
                                              )
                                            }
                                            // Inactive / pinned label → plain div with click-to-toggle
                                            return (
                                              <AltExcludeTooltip
                                                key={`flat-label-${item.id}`}
                                                show={
                                                  filterAltHeld && !isPinned
                                                }
                                              >
                                                <div
                                                  data-filter-selected={
                                                    isHighlighted
                                                  }
                                                  onMouseEnter={() =>
                                                    setFilterDropdownSelectedIdx(
                                                      flatIndex,
                                                    )
                                                  }
                                                  onClick={(e) => {
                                                    if (isPinned) return
                                                    e.preventDefault()
                                                    setLabelFilter((prev) => {
                                                      const next = new Map(prev)
                                                      if (next.has(item.id))
                                                        next.delete(item.id)
                                                      else
                                                        next.set(
                                                          item.id,
                                                          e.altKey
                                                            ? 'exclude'
                                                            : 'include',
                                                        )
                                                      return next
                                                    })
                                                  }}
                                                  className={cn(
                                                    // SVG sizing matches StyledDropdownMenuSubTrigger so icons render at the same size
                                                    "flex cursor-pointer select-none items-center gap-2 rounded-[4px] mx-1 px-2 py-1.5 text-sm [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
                                                    isHighlighted &&
                                                      'bg-foreground/5',
                                                    isPinned &&
                                                      'opacity-50 pointer-events-none',
                                                  )}
                                                >
                                                  <FilterMenuRow
                                                    icon={
                                                      <LabelIcon
                                                        label={item.config}
                                                        size="lg"
                                                      />
                                                    }
                                                    label={labelDisplay}
                                                    accessory={
                                                      isPinned ? (
                                                        <Check className="h-3 w-3 text-muted-foreground" />
                                                      ) : null
                                                    }
                                                  />
                                                </div>
                                              </AltExcludeTooltip>
                                            )
                                          },
                                        )}
                                      </>
                                    )}
                                  </div>
                                )}
                              </>
                            )}
                          </StyledDropdownMenuContent>
                        </DropdownMenu>
                      )}
                      {/* Add Source button (only for sources mode) - uses filter-aware edit config */}
                      {isSourcesNavigation(navState) && activeWorkspace && (
                        <EditPopover
                          trigger={
                            <HeaderIconButton
                              icon={<Plus className="h-4 w-4" />}
                              tooltip={t('sidebarMenu.addSource')}
                              data-tutorial="add-source-button"
                            />
                          }
                          {...getEditConfig(
                            sourceFilter?.kind === 'type'
                              ? (`add-source-${sourceFilter.sourceType}` as EditContextKey)
                              : 'add-source',
                            activeWorkspace.rootPath,
                          )}
                        />
                      )}
                      {/* Add Automation button (only for automations mode) */}
                      {isAutomationsNavigation(navState) && activeWorkspace && (
                        <EditPopover
                          trigger={
                            <HeaderIconButton
                              icon={<Plus className="h-4 w-4" />}
                              tooltip={t('sidebarMenu.addAutomation')}
                            />
                          }
                          {...getEditConfig(
                            'automation-config',
                            activeWorkspace.rootPath,
                          )}
                        />
                      )}
                    </>
                  }
                />
                {/* Content: SessionList, SourcesListPanel, or SettingsNavigator based on navigation state */}
                {isSourcesNavigation(navState) && (
                  /* Sources List - filtered by type if sourceFilter is active */
                  <SourcesListPanel
                    sources={sources}
                    sourceFilter={sourceFilter}
                    workspaceRootPath={activeWorkspace?.rootPath}
                    onDeleteSource={handleDeleteSource}
                    onSourceClick={handleSourceSelect}
                    selectedSourceSlug={
                      isSourcesNavigation(navState) && navState.details
                        ? navState.details.sourceSlug
                        : null
                    }
                    localMcpEnabled={localMcpEnabled}
                  />
                )}
                {isSkillsNavigation(navState) && activeWorkspaceId && (
                  /* Skills List */
                  <SkillsListPanel
                    skills={skills}
                    workspaceId={activeWorkspaceId}
                    workspaceRootPath={activeWorkspace?.rootPath}
                    isLoading={skillsLoading}
                    onSkillClick={handleSkillSelect}
                    onDeleteSkill={handleDeleteSkill}
                    onSetSkillEnabled={handleSetSkillEnabled}
                    selectedSkillSlug={
                      isSkillsNavigation(navState) &&
                      navState.details?.type === 'skill'
                        ? navState.details.skillSlug
                        : null
                    }
                  />
                )}
                {isSkillMarketplaceNavigation(navState) &&
                  activeWorkspaceId && (
                    <SkillMarketplacePanel
                      workspaceId={activeWorkspaceId}
                      workingDirectory={activeSkillsWorkingDirectory}
                      activeSessionId={activeQwenSessionId}
                      selectedSkillId={
                        navState.details?.type === 'marketplaceSkill'
                          ? navState.details.skillId
                          : null
                      }
                      onSkillSelect={handleMarketplaceSkillSelect}
                      onInstalled={reloadSkills}
                    />
                  )}
                {isAutomationsNavigation(navState) && (
                  /* Automations List - filtered by type if automationFilter is active */
                  <AutomationsListPanel
                    automations={automations}
                    automationFilter={
                      automationFilter
                        ? {
                            kind:
                              AUTOMATION_TYPE_TO_FILTER_KIND[
                                automationFilter.automationType
                              ] ?? 'all',
                          }
                        : undefined
                    }
                    onAutomationClick={handleAutomationSelect}
                    onTestAutomation={handleTestAutomation}
                    onToggleAutomation={handleToggleAutomation}
                    onDuplicateAutomation={handleDuplicateAutomation}
                    onDeleteAutomation={handleDeleteAutomation}
                    selectedAutomationId={
                      isAutomationsNavigation(navState) && navState.details
                        ? navState.details.automationId
                        : null
                    }
                    workspaceRootPath={activeWorkspace?.rootPath}
                  />
                )}
                {isSettingsNavigation(navState) && (
                  /* Settings Navigator */
                  <SettingsNavigator
                    selectedSubpage={navState.subpage}
                    onSelectSubpage={(subpage) => handleSettingsClick(subpage)}
                  />
                )}
                {isSessionsNavigation(navState) && (
                  /* Sessions List */
                  <>
                    {/* SessionList: Scrollable list of session cards */}
                    {/* Key on sidebarMode forces full remount when switching views, skipping animations */}
                    <SessionList
                      key={sessionFilter?.kind}
                      items={
                        searchActive
                          ? workspaceSessionMetas
                          : filteredSessionMetas
                      }
                      onDelete={handleDeleteSession}
                      onFlag={onFlagSession}
                      onUnflag={onUnflagSession}
                      onArchive={onArchiveSession}
                      onUnarchive={onUnarchiveSession}
                      onMarkUnread={onMarkSessionUnread}
                      onSessionStatusChange={onSessionStatusChange}
                      onRename={onRenameSession}
                      onFocusChatInput={(targetSessionId) => {
                        focusChatInputForSession(
                          targetSessionId ??
                            focusedSessionId ??
                            session.selected,
                        )
                      }}
                      onSessionSelect={(selectedMeta) => {
                        navigateToSession(selectedMeta.id)
                      }}
                      onOpenInNewWindow={(selectedMeta) => {
                        if (activeWorkspaceId) {
                          window.electronAPI.openSessionInNewWindow(
                            activeWorkspaceId,
                            selectedMeta.id,
                          )
                        }
                      }}
                      onNavigateToView={(view) => {
                        if (view === 'allSessions') {
                          navigate(routes.view.allSessions())
                        } else if (view === 'flagged') {
                          navigate(routes.view.flagged())
                        }
                      }}
                      sessionOptions={sessionOptions}
                      searchActive={searchActive}
                      searchQuery={searchQuery}
                      onSearchChange={setSearchQuery}
                      onSearchClose={() => {
                        setSearchActive(false)
                        setSearchQuery('')
                      }}
                      sessionStatuses={effectiveSessionStatuses}
                      evaluateViews={evaluateViews}
                      labels={displayLabelConfigs}
                      onLabelsChange={handleSessionLabelsChange}
                      groupingMode={chatGroupingMode}
                      workspaceId={activeWorkspaceId ?? undefined}
                      statusFilter={listFilter}
                      labelFilterMap={labelFilter}
                      focusedSessionId={
                        panelCount === 0
                          ? null
                          : panelCount > 1
                            ? focusedSessionId
                            : undefined
                      }
                      onNavigateToSession={
                        panelCount > 1 ? navigateToSessionInPanel : undefined
                      }
                      hasPendingPrompt={hasPendingPrompt}
                      activeChatMatchInfo={chatMatchInfo}
                      isLoading={isSessionListLoading}
                    />
                  </>
                )}
              </div>
            )
          }
          navigatorWidth={effectiveNavigatorWidth}
          isSidebarAndNavigatorHidden={effectiveSidebarAndNavigatorHidden}
          isRightSidebarVisible={false}
          isCompact={isAutoCompact}
          isResizing={!!isResizing}
        />

        <BrowserDockPanel
          expandedLeft={browserDockExpandedLeft}
          autoHideKey={focusedPanelRoute}
          isCompact={isAutoCompact}
        />

        {/* Sidebar Resize Handle */}
        {isSidebarResizeAvailable && (
          <div
            ref={resizeHandleRef}
            onMouseDown={(e) => {
              e.preventDefault()
              setIsResizing('sidebar')
            }}
            onMouseMove={(e) => {
              if (resizeHandleRef.current) {
                const rect = resizeHandleRef.current.getBoundingClientRect()
                setSidebarHandleY(e.clientY - rect.top)
              }
            }}
            onMouseLeave={() => {
              if (!isResizing) setSidebarHandleY(null)
            }}
            className="absolute cursor-col-resize z-panel flex justify-center"
            style={{
              width: PANEL_SASH_HIT_WIDTH,
              top: PANEL_STACK_VERTICAL_OVERFLOW,
              bottom: PANEL_STACK_VERTICAL_OVERFLOW,
              left: isSidebarVisible
                ? sidebarWidth + PANEL_GAP / 2 - PANEL_SASH_HALF_HIT_WIDTH
                : -PANEL_GAP,
              transition:
                isResizing === 'sidebar' ? undefined : 'left 0.15s ease-out',
            }}
          >
            <div
              className="h-full"
              style={{
                ...getResizeGradientStyle(
                  sidebarHandleY,
                  resizeHandleRef.current?.clientHeight ?? null,
                ),
                width: PANEL_SASH_LINE_WIDTH,
              }}
            />
          </div>
        )}

        {/* Session List Resize Handle (absolute, hidden when the navigator is not visible) */}
        {isNavigatorResizeAvailable && (
          <div
            ref={sessionListHandleRef}
            onMouseDown={(e) => {
              e.preventDefault()
              setIsResizing('session-list')
            }}
            onMouseMove={(e) => {
              if (sessionListHandleRef.current) {
                const rect =
                  sessionListHandleRef.current.getBoundingClientRect()
                setSessionListHandleY(e.clientY - rect.top)
              }
            }}
            onMouseLeave={() => {
              if (isResizing !== 'session-list') setSessionListHandleY(null)
            }}
            className="absolute cursor-col-resize z-panel flex justify-center"
            style={{
              width: PANEL_SASH_HIT_WIDTH,
              top: PANEL_STACK_VERTICAL_OVERFLOW,
              bottom: PANEL_STACK_VERTICAL_OVERFLOW,
              left:
                (isSidebarVisible
                  ? sidebarWidth + PANEL_GAP
                  : PANEL_EDGE_INSET) +
                sessionListWidth +
                PANEL_GAP / 2 -
                PANEL_SASH_HALF_HIT_WIDTH,
              transition:
                isResizing === 'session-list'
                  ? undefined
                  : 'left 0.15s ease-out',
            }}
          >
            <div
              className="h-full"
              style={{
                ...getResizeGradientStyle(
                  sessionListHandleY,
                  sessionListHandleRef.current?.clientHeight ?? null,
                ),
                width: PANEL_SASH_LINE_WIDTH,
              }}
            />
          </div>
        )}
      </div>

      {/* ============================================================================
       * CONTEXT MENU TRIGGERED EDIT POPOVERS
       * ============================================================================
       * These EditPopovers are opened programmatically from sidebar context menus.
       * They use controlled state (editPopoverOpen) and invisible anchors for positioning.
       * The anchor Y position is captured from the right-clicked item (editPopoverAnchorY ref)
       * so the popover appears near the triggering item rather than at a fixed location.
       * modal={true} prevents auto-close when focus shifts after context menu closes.
       */}
      {activeWorkspace && (
        <>
          {/* Configure Statuses EditPopover - anchored near sidebar */}
          <EditPopover
            open={editPopoverOpen === 'statuses'}
            onOpenChange={(isOpen) =>
              setEditPopoverOpen(isOpen ? 'statuses' : null)
            }
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{
                  left: sidebarWidth + 20,
                  top: editPopoverAnchorY.current,
                }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            secondaryAction={{
              label: 'Edit File',
              filePath: `${activeWorkspace.rootPath}/statuses/config.json`,
            }}
            {...getEditConfig('edit-statuses', activeWorkspace.rootPath)}
          />
          {FEATURE_FLAGS.sessionLabelsUi && (
            <EditPopover
              open={editPopoverOpen === 'labels'}
              onOpenChange={(isOpen) =>
                setEditPopoverOpen(isOpen ? 'labels' : null)
              }
              modal={true}
              trigger={
                <div
                  className="fixed w-0 h-0 pointer-events-none"
                  style={{
                    left: sidebarWidth + 20,
                    top: editPopoverAnchorY.current,
                  }}
                  aria-hidden="true"
                />
              }
              side="bottom"
              align="start"
              secondaryAction={{
                label: 'Edit File',
                filePath: `${activeWorkspace.rootPath}/labels/config.json`,
              }}
              {...(() => {
                // Spread base config, override context to include which label was right-clicked
                const config = getEditConfig(
                  'edit-labels',
                  activeWorkspace.rootPath,
                )
                const targetLabel = editLabelTargetId.current
                  ? findLabelById(labelConfigs, editLabelTargetId.current)
                  : undefined
                if (!targetLabel) return config
                return {
                  ...config,
                  context: {
                    ...config.context,
                    context:
                      (config.context.context || '') +
                      ` The user right-clicked on the label "${targetLabel.name}" (id: "${targetLabel.id}"). ` +
                      'If they refer to "this label" or "this", they mean this specific label.',
                  },
                }
              })()}
            />
          )}
          {/* Edit Views EditPopover - anchored near sidebar */}
          <EditPopover
            open={editPopoverOpen === 'views'}
            onOpenChange={(isOpen) =>
              setEditPopoverOpen(isOpen ? 'views' : null)
            }
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{
                  left: sidebarWidth + 20,
                  top: editPopoverAnchorY.current,
                }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            secondaryAction={{
              label: 'Edit File',
              filePath: `${activeWorkspace.rootPath}/views.json`,
            }}
            {...getEditConfig('edit-views', activeWorkspace.rootPath)}
          />
          {/* Add Source EditPopovers - one for each variant (generic + filter-specific)
           * editPopoverOpen can be: 'add-source', 'add-source-api', 'add-source-mcp', 'add-source-local'
           * Each variant uses its corresponding EditContextKey for filter-aware agent context */}
          {(
            [
              'add-source',
              'add-source-api',
              'add-source-mcp',
              'add-source-local',
            ] as const
          ).map((variant) => (
            <EditPopover
              key={variant}
              open={editPopoverOpen === variant}
              onOpenChange={(isOpen) =>
                setEditPopoverOpen(isOpen ? variant : null)
              }
              modal={true}
              trigger={
                <div
                  className="fixed w-0 h-0 pointer-events-none"
                  style={{
                    left: sidebarWidth + 20,
                    top: editPopoverAnchorY.current,
                  }}
                  aria-hidden="true"
                />
              }
              side="bottom"
              align="start"
              {...getEditConfig(variant, activeWorkspace.rootPath)}
            />
          ))}
          {/* Add Skill EditPopover */}
          <EditPopover
            open={editPopoverOpen === 'add-skill'}
            onOpenChange={(isOpen) =>
              setEditPopoverOpen(isOpen ? 'add-skill' : null)
            }
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{
                  left: sidebarWidth + 20,
                  top: editPopoverAnchorY.current,
                }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            {...getEditConfig('add-skill', activeWorkspace.rootPath)}
          />
          {/* Add Automation EditPopover - triggered from "Add Automation" context menu in automations */}
          <EditPopover
            open={editPopoverOpen === 'automation-config'}
            onOpenChange={(isOpen) =>
              setEditPopoverOpen(isOpen ? 'automation-config' : null)
            }
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{
                  left: sidebarWidth + 20,
                  top: editPopoverAnchorY.current,
                }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            {...getEditConfig('automation-config', activeWorkspace.rootPath)}
          />
          {/* Add Label EditPopover - triggered from "Add New Label" context menu on labels */}
          <EditPopover
            open={editPopoverOpen === 'add-label'}
            onOpenChange={(isOpen) =>
              setEditPopoverOpen(isOpen ? 'add-label' : null)
            }
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{
                  left: sidebarWidth + 20,
                  top: editPopoverAnchorY.current,
                }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            secondaryAction={{
              label: 'Edit File',
              filePath: `${activeWorkspace.rootPath}/labels/config.json`,
            }}
            {...(() => {
              // Spread base config, override context to include which label was right-clicked
              const config = getEditConfig(
                'add-label',
                activeWorkspace.rootPath,
              )
              const targetLabel = editLabelTargetId.current
                ? findLabelById(labelConfigs, editLabelTargetId.current)
                : undefined
              if (!targetLabel) return config
              return {
                ...config,
                context: {
                  ...config.context,
                  context:
                    (config.context.context || '') +
                    ` The user right-clicked on the label "${targetLabel.name}" (id: "${targetLabel.id}"). ` +
                    'The new label should be added as a sibling after this label, or as a child if the user specifies.',
                },
              }
            })()}
          />
        </>
      )}

      {/* Delete automation confirmation dialog */}
      <Dialog
        open={!!automationPendingDelete}
        onOpenChange={(open) => {
          if (!open) setAutomationPendingDelete(null)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('dialog.deleteAutomation.title')}</DialogTitle>
            <DialogDescription>
              <Trans
                i18nKey="dialog.deleteAutomation.description"
                values={{ name: pendingDeleteAutomation?.name }}
                components={{ strong: <strong /> }}
              />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAutomationPendingDelete(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDeleteAutomation}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send to Workspace dialog (driven by sendToWorkspaceAtom) */}
      <SendToWorkspaceDialog
        open={sendToWorkspaceIds.length > 0}
        onOpenChange={(open) => {
          if (!open) setSendToWorkspaceIds([])
        }}
        sessionIds={sendToWorkspaceIds}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onTransferComplete={handleTransferComplete}
      />

      {/* Messaging dialogs (pairing-code + WA connect) — driven by messagingDialogAtom.
          Mounted here so they survive context-menu / dropdown close. */}
      <MessagingDialogHost />
    </AppShellProvider>
  )
}
