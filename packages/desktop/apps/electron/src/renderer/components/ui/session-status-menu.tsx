import * as React from 'react'
import { useTranslation } from "react-i18next"
import { Command as CommandPrimitive } from 'cmdk'
import { Archive, ArchiveRestore } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  type SessionStatusId,
  type SessionStatus,
  getStateIcon,
  getStateColor,
  getStatusIconStyle,
} from '@/config/session-status-config'

// Re-export types for backwards compatibility
export { type SessionStatusId, type SessionStatus, getStateIcon, getStateColor }

// ============================================================================
// Shared Styles (matching slash-command-menu)
// ============================================================================

const MENU_CONTAINER_STYLE = 'min-w-[180px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small'
const MENU_LIST_STYLE = 'max-h-[240px] overflow-y-auto p-1 [&_[cmdk-list-sizer]]:space-y-px'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-3 rounded-[6px] px-3 py-1.5 text-[13px]'

// ============================================================================
// StateItemContent - Shared item rendering
// ============================================================================

const DEFAULT_STATUS_IDS = new Set(['backlog', 'todo', 'needs-review', 'done', 'cancelled'])

function StateItemContent({ state }: { state: SessionStatus }) {
  const { t } = useTranslation()
  const label = DEFAULT_STATUS_IDS.has(state.id) ? t(`status.${state.id}`, state.label) : state.label
  return (
    <>
      <span className="shrink-0 flex items-center" style={getStatusIconStyle(state)}>
        {state.icon}
      </span>
      <div className="flex-1 min-w-0">{label}</div>
    </>
  )
}

// ============================================================================
// SessionStatusMenu Component - For selecting/changing a session's state
// ============================================================================

export interface SessionStatusMenuProps {
  states?: SessionStatus[]
  activeState: SessionStatusId
  onSelect: (stateId: SessionStatusId) => void
  /** Whether the session is currently archived */
  isArchived?: boolean
  /** Archive action - shows Archive item at bottom when provided and not archived */
  onArchive?: () => void
  /** Unarchive action - shows Unarchive item at bottom when provided and archived */
  onUnarchive?: () => void
  className?: string
}

export function SessionStatusMenu({
  states = [],
  activeState,
  onSelect,
  isArchived,
  onArchive,
  onUnarchive,
  className,
}: SessionStatusMenuProps) {
  const { t } = useTranslation()
  const [filter, setFilter] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Focus input when menu opens
  React.useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus()
    }, 0)
    return () => clearTimeout(timer)
  }, [])

  // Find default value - prefer active state, otherwise first item
  const defaultValue = activeState || states[0]?.id

  return (
    <CommandPrimitive
      className={cn(MENU_CONTAINER_STYLE, className)}
      defaultValue={defaultValue}
    >
      <div className="border-b border-border/50 px-3 py-2">
        <CommandPrimitive.Input
          ref={inputRef}
          value={filter}
          onValueChange={setFilter}
          placeholder={t("status.filterStatuses")}
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
        />
      </div>
      <CommandPrimitive.List className={MENU_LIST_STYLE}>
        <CommandPrimitive.Empty className="py-3 text-center text-sm text-muted-foreground">
          No status found
        </CommandPrimitive.Empty>
        {states.map((state) => {
          const isActive = activeState === state.id
          return (
            <CommandPrimitive.Item
              key={state.id}
              value={state.label}
              onSelect={() => onSelect(state.id)}
              className={cn(
                MENU_ITEM_STYLE,
                'outline-none',
                isActive ? 'bg-foreground/7' : 'data-[selected=true]:bg-foreground/3'
              )}
            >
              <StateItemContent state={state} />
            </CommandPrimitive.Item>
          )
        })}
        {/* Archive/Unarchive item - only shown when handler provided and no filter active */}
        {!filter && (isArchived ? onUnarchive : onArchive) && (
          <>
            <div className="border-t border-border/50 mx-2 my-1" />
            <CommandPrimitive.Item
              value={isArchived ? "unarchive" : "archive"}
              onSelect={() => isArchived ? onUnarchive?.() : onArchive?.()}
              className={cn(
                MENU_ITEM_STYLE,
                'outline-none',
                'data-[selected=true]:bg-foreground/3'
              )}
            >
              <span className="shrink-0 flex items-center opacity-60">
                {isArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
              </span>
              <div className="flex-1 min-w-0">{isArchived ? 'Unarchive' : 'Archive'}</div>
            </CommandPrimitive.Item>
          </>
        )}
      </CommandPrimitive.List>
    </CommandPrimitive>
  )
}
