/**
 * PanelStackContainer
 *
 * Horizontal layout container for ALL panels:
 * Sidebar → Navigator → Content Panel(s) with resize sashes.
 *
 * Content panels use CSS flex-grow with their proportions as weights:
 * - Each panel gets `flex: <proportion> 1 0px` with `min-width: PANEL_MIN_WIDTH`
 * - Flex distributes available space proportionally — panels fill the viewport
 * - When panels hit min-width, overflow-x: auto kicks in naturally
 *
 * Sidebar and Navigator are NOT part of the proportional layout —
 * they have their own fixed/user-resizable widths managed by AppShell.
 * They just reduce the available width for content panels and scroll with everything else.
 *
 * The right sidebar stays OUTSIDE this container.
 */

import { useRef, useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { panelStackAtom, focusedPanelIdAtom, focusedSessionIdAtom } from '@/atoms/panel-stack'
import { PanelSlot } from './PanelSlot'
import { PanelResizeSash } from './PanelResizeSash'
import {
  PANEL_GAP,
  PANEL_EDGE_INSET,
  PANEL_STACK_VERTICAL_OVERFLOW,
  RADIUS_EDGE,
  RADIUS_INNER,
} from './panel-constants'

/** Spring transition matching AppShell's sidebar/navigator animation */
const PANEL_SPRING = { type: 'spring' as const, stiffness: 600, damping: 49 }

interface PanelStackContainerProps {
  sidebarSlot: React.ReactNode
  sidebarWidth: number
  navigatorSlot: React.ReactNode
  navigatorWidth: number
  isSidebarAndNavigatorHidden: boolean
  isRightSidebarVisible?: boolean
  /** Compact mode: single-panel, list/content toggle (mobile or narrow window) */
  isCompact?: boolean
  isResizing?: boolean
}

export function PanelStackContainer({
  sidebarSlot,
  sidebarWidth,
  navigatorSlot,
  navigatorWidth,
  isSidebarAndNavigatorHidden,
  isRightSidebarVisible,
  isCompact = false,
  isResizing,
}: PanelStackContainerProps) {
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  const focusedSessionId = useAtomValue(focusedSessionIdAtom)

  const contentPanels = panelStack

  // Compact mode: show list OR content based on the focused panel's ROUTE,
  // not just whether a panel exists. When the route has a session selected
  // (e.g., allSessions/session/abc), show content. When on a list view
  // (e.g., allSessions), show navigator. This allows back-navigation to
  // return to the session list.
  const hasSelectedContent = isCompact && !!focusedSessionId
  const visiblePanels = isCompact
    ? contentPanels.filter(e => e.id === focusedPanelId).slice(0, 1)
    : contentPanels

  const scrollRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(contentPanels.length)

  const hasSidebar = sidebarWidth > 0
  // In compact mode, hide navigator when content is selected (show list OR content, not both)
  const hasNavigator = isCompact ? (navigatorWidth > 0 && !hasSelectedContent) : navigatorWidth > 0
  const isMultiPanel = visiblePanels.length > 1
  const isLeftEdge = !hasSidebar && !hasNavigator

  // Auto-scroll to newly pushed content panel
  useEffect(() => {
    if (contentPanels.length > prevCountRef.current && scrollRef.current) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          left: scrollRef.current.scrollWidth,
          behavior: isCompact ? 'instant' : 'smooth',
        })
      })
    }
    prevCountRef.current = contentPanels.length
  }, [contentPanels.length, isCompact])

  const transition = (isResizing || isCompact) ? { duration: 0 } : PANEL_SPRING

  return (
    <div
      ref={scrollRef}
      className="flex-1 min-w-0 flex relative z-panel panel-scroll @container/shell"
      style={{
        overflowX: 'auto',
        overflowY: 'hidden',
        // Extra vertical space for box-shadows (collapsed back with negative margin)
        paddingBlock: PANEL_STACK_VERTICAL_OVERFLOW,
        marginBlock: -PANEL_STACK_VERTICAL_OVERFLOW,
        // Extend to window bottom so scrollbar sits at the very edge
        marginBottom: -6,
        paddingBottom: 6,
        // Extra horizontal space for last panel's box-shadow
        paddingRight: 8,
        marginRight: -8,
      }}
    >
      {/* Inner flex container — flex-grow: 1 fills viewport, content can overflow for scroll.
           Animated paddingLeft provides window-edge spacing when sidebar/navigator are hidden.
           Hidden slots use marginRight: -PANEL_GAP to cancel their trailing flex gap. */}
      <motion.div
        className="flex h-full"
        initial={false}
        animate={{ paddingLeft: !hasSidebar ? PANEL_EDGE_INSET : 0 }}
        transition={transition}
        style={{ gap: PANEL_GAP, flexGrow: 1, minWidth: 0 }}
      >
        {/* === SIDEBAR SLOT === */}
        <motion.div
          data-panel-role="sidebar"
          initial={false}
          animate={{
            width: hasSidebar ? sidebarWidth : 0,
            marginRight: hasSidebar ? 0 : -PANEL_GAP,
            opacity: hasSidebar ? 1 : 0,
          }}
          transition={transition}
          className="h-full relative shrink-0"
          style={{ overflowX: 'clip', overflowY: 'visible' }}
        >
          <div className="h-full" style={{ width: sidebarWidth }}>
            {sidebarSlot}
          </div>
        </motion.div>

        {/* === NAVIGATOR SLOT === */}
        <motion.div
          data-panel-role="navigator"
          initial={false}
          animate={{
            width: hasNavigator ? navigatorWidth : 0,
            marginRight: hasNavigator ? 0 : -PANEL_GAP,
            opacity: hasNavigator ? 1 : 0,
          }}
          transition={transition}
          className={cn(
            'h-full overflow-hidden relative shrink-0 z-[2]',
            'bg-background shadow-middle',
          )}
          style={{
            // In compact mode (no content selected), navigator fills available space
            ...(isCompact && hasNavigator && !hasSelectedContent ? { flex: '1 1 auto' } : {}),
            borderTopLeftRadius: RADIUS_INNER,
            borderBottomLeftRadius: !hasSidebar ? RADIUS_EDGE : RADIUS_INNER,
            borderTopRightRadius: RADIUS_INNER,
            borderBottomRightRadius: RADIUS_INNER,
          }}
        >
          <div className="h-full" style={{ width: isCompact && hasNavigator && !hasSelectedContent ? '100%' : navigatorWidth }}>
            {navigatorSlot}
          </div>
        </motion.div>

        {/* === CONTENT PANELS WITH SASHES === */}
        {visiblePanels.length === 0 ? (
          // Only show empty placeholder when not in compact mode (compact shows navigator instead)
          isCompact ? null : <div className="flex-1 flex items-center justify-center" />
        ) : (
          visiblePanels.map((entry, index) => (
            <PanelSlot
              key={entry.id}
              entry={entry}
              isOnly={visiblePanels.length === 1}
              isFocusedPanel={isMultiPanel ? entry.id === focusedPanelId : true}
              isSidebarAndNavigatorHidden={isSidebarAndNavigatorHidden}
              isAtLeftEdge={index === 0 && isLeftEdge}
              isAtRightEdge={index === visiblePanels.length - 1 && !isRightSidebarVisible}
              proportion={entry.proportion}
              isCompact={isCompact}
              sash={index > 0 ? (
                <PanelResizeSash
                  leftIndex={index - 1}
                  rightIndex={index}
                />
              ) : undefined}
            />
          ))
        )}
      </motion.div>
    </div>
  )
}
