/**
 * EntityList — Reusable container for rendering a scrollable list of EntityRow items.
 *
 * Handles:
 * - ScrollArea wrapping with proper padding
 * - Optional grouped layout with section headers
 * - Collapsible groups with chevron toggle and item count
 * - Empty state rendering (centered, outside ScrollArea)
 * - Header (e.g. search bar) and footer (e.g. infinite scroll sentinel) slots
 *
 * Domain-specific logic (filtering, keyboard nav, multi-select) lives in the consumer.
 */

import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
  StyledContextMenuSeparator,
} from '@/components/ui/styled-context-menu'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

export interface EntityListGroup<T> {
  /** Unique key for the group */
  key: string
  /** Label shown in the section header */
  label: string
  /** Items in this group (empty array for collapsed groups — items are excluded from the data pipeline) */
  items: T[]
  /** Whether this group supports collapse/expand (default: false) */
  collapsible?: boolean
  /** Number of hidden items when collapsed. Present on collapsed placeholder groups (items will be []). */
  collapsedCount?: number
}

export interface EntityListProps<T> {
  /** Flat item list (used when not grouped) */
  items?: T[]
  /** Grouped items with section headers (takes precedence over items) */
  groups?: EntityListGroup<T>[]
  /** Render function for each item */
  renderItem: (item: T, index: number, isFirstInGroup: boolean) => React.ReactNode
  /** Unique key extractor */
  getKey: (item: T) => string
  /** Empty state content — rendered centered, outside ScrollArea */
  emptyState?: React.ReactNode
  /** Header content above the list (e.g. search bar) — rendered outside ScrollArea */
  header?: React.ReactNode
  /** Footer content after all items (e.g. infinite scroll sentinel) — inside ScrollArea */
  footer?: React.ReactNode
  /** Ref for the inner list container (for keyboard navigation zones) */
  containerRef?: React.Ref<HTMLDivElement>
  /** Props spread on the inner list container (role, aria-label, data-focus-zone) */
  containerProps?: Record<string, string>
  /** Ref to the ScrollArea viewport element (for scroll-based pagination) */
  viewportRef?: React.RefObject<HTMLDivElement>
  /** Additional ScrollArea class */
  scrollAreaClassName?: string
  className?: string
  /** Set of collapsed group keys (for collapsible groups) */
  collapsedGroups?: Set<string>
  /** Called when a collapsible group header is clicked */
  onToggleCollapse?: (groupKey: string) => void
  /** Collapse all collapsible groups */
  onCollapseAll?: () => void
  /** Expand all collapsible groups */
  onExpandAll?: () => void
}

// ============================================================================
// Section Header
// ============================================================================

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-4 py-2">
      <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
    </div>
  )
}

/** Collapsible group header with chevron toggle and item count when collapsed */
function CollapsibleGroupHeader({
  label,
  isCollapsed,
  itemCount,
  onToggle,
  onCollapseAll,
  onExpandAll,
}: {
  label: string
  isCollapsed: boolean
  itemCount: number
  onToggle: () => void
  onCollapseAll?: () => void
  onExpandAll?: () => void
}) {
  return (
    <ContextMenu modal>
      <ContextMenuTrigger asChild>
        <button
          onClick={onToggle}
          className="w-full py-2 px-4 flex items-center gap-1.5 cursor-pointer group/header relative"
        >
          <div className="absolute inset-y-0.5 left-2 right-2 rounded-[6px] group-hover/header:bg-foreground/2 transition-colors pointer-events-none" />
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground/60 transition-transform relative",
              !isCollapsed && "rotate-90"
            )}
          />
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground relative">
            {label}{isCollapsed && <> · <span className="text-muted-foreground/50">{itemCount}</span></>}
          </span>
        </button>
      </ContextMenuTrigger>
      <StyledContextMenuContent>
        <StyledContextMenuItem onClick={onToggle}>
          {isCollapsed ? 'Expand' : 'Collapse'}
        </StyledContextMenuItem>
        <StyledContextMenuSeparator />
        <StyledContextMenuItem onClick={onCollapseAll}>
          Collapse All
        </StyledContextMenuItem>
        <StyledContextMenuItem onClick={onExpandAll}>
          Expand All
        </StyledContextMenuItem>
      </StyledContextMenuContent>
    </ContextMenu>
  )
}

// ============================================================================
// Component
// ============================================================================

export function EntityList<T>({
  items,
  groups,
  renderItem,
  getKey,
  emptyState,
  header,
  footer,
  containerRef,
  containerProps,
  viewportRef,
  scrollAreaClassName,
  className,
  collapsedGroups,
  onToggleCollapse,
  onCollapseAll,
  onExpandAll,
}: EntityListProps<T>) {
  // Determine if we have content
  const hasGroups = groups && groups.length > 0
  const hasItems = items && items.length > 0
  const isEmpty = !hasGroups && !hasItems

  // Empty state — rendered outside everything for proper centering
  if (isEmpty && emptyState) {
    return (
      <div className={cn('flex flex-col flex-1', className)}>
        {header}
        {emptyState}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', className)}>
      {header}
      <ScrollArea className={cn('flex-1', scrollAreaClassName)} viewportRef={viewportRef}>
        <div
          ref={containerRef}
          className="flex flex-col pb-2"
          {...containerProps}
        >
          <div className="pt-1">
            {hasGroups
              ? groups!.map((group) => {
                  const isCollapsed = group.collapsible && collapsedGroups?.has(group.key)

                  return (
                    <div key={group.key}>
                      {group.collapsible && onToggleCollapse ? (
                        <CollapsibleGroupHeader
                          label={group.label}
                          isCollapsed={!!isCollapsed}
                          itemCount={isCollapsed ? (group.collapsedCount ?? 0) : group.items.length}
                          onToggle={() => onToggleCollapse(group.key)}
                          onCollapseAll={onCollapseAll}
                          onExpandAll={onExpandAll}
                        />
                      ) : (
                        <SectionHeader label={group.label} />
                      )}
                      {group.items.map((item, indexInGroup) =>
                        <React.Fragment key={getKey(item)}>
                          {renderItem(item, indexInGroup, indexInGroup === 0)}
                        </React.Fragment>
                      )}
                    </div>
                  )
                })
              : items?.map((item, index) =>
                  <React.Fragment key={getKey(item)}>
                    {renderItem(item, index, index === 0)}
                  </React.Fragment>
                )
            }
          </div>
          {footer}
        </div>
      </ScrollArea>
    </div>
  )
}
