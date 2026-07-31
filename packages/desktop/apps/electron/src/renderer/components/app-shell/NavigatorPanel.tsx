/**
 * NavigatorPanel - Middle panel component for list-based navigation
 *
 * Displays a header with title, optional action buttons, and
 * renders children (SessionList or SourcesListPanel) in a scrollable area.
 *
 * Layout:
 * ┌────────────────────────────┐
 * │ Header (title)             │
 * │ + action buttons           │
 * ├────────────────────────────┤
 * │                            │
 * │   children (list content)  │
 * │                            │
 * └────────────────────────────┘
 */

import * as React from 'react'
import { Panel } from './Panel'
import { PanelHeader } from './PanelHeader'
import { cn } from '@/lib/utils'

export interface NavigatorPanelProps {
  /** Panel title (e.g., "Conversations", "Sources") */
  title: string
  /** Panel width in pixels */
  width: number
  /** Action buttons rendered in the header (filter, add, etc.) */
  headerActions?: React.ReactNode
  /** Main content (SessionList, SourcesListPanel, etc.) */
  children: React.ReactNode
  /** Optional className for the container */
  className?: string
}

export function NavigatorPanel({
  title,
  width,
  headerActions,
  children,
  className,
}: NavigatorPanelProps) {
  return (
    <Panel variant="shrink" width={width} className={className}>
      <PanelHeader
        title={title}
        actions={headerActions}
      />
      {children}
    </Panel>
  )
}
