/**
 * ActiveTasksBar - Compact horizontal display of running background tasks
 *
 * Shows above/below the ChatInput when background tasks are active.
 * Each task shows: type icon, ID (shortened), elapsed time, kill button
 */

import React from 'react'
import { cn } from '@/lib/utils'
import { Spinner } from '@craft-agent/ui'
import { TaskActionMenu, type TerminalOverlayData } from './TaskActionMenu'

export interface BackgroundTask {
  /** Task or shell ID */
  id: string
  /** Task type */
  type: 'agent' | 'shell'
  /** Tool use ID for correlation with messages */
  toolUseId: string
  /** When the task started */
  startTime: number
  /** Elapsed seconds (from progress events) */
  elapsedSeconds: number
  /** Task intent/description */
  intent?: string
}

export interface ActiveTasksBarProps {
  /** Active background tasks */
  tasks: BackgroundTask[]
  /** Session ID for opening preview windows */
  sessionId: string
  /** Callback when kill button is clicked */
  onKillTask?: (taskId: string) => void
  /** Callback to insert message into input field */
  onInsertMessage?: (text: string) => void
  /** Callback to show terminal output overlay */
  onShowTerminalOverlay?: (data: TerminalOverlayData) => void
  /** Additional class name */
  className?: string
}

/** Format elapsed time in a compact way */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

/** Shorten task ID for compact display (show first 8 chars) */
function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id
}

/**
 * ActiveTasksBar - Badge-style display of running background tasks
 * Styled to match ActiveOptionBadges for visual consistency
 * Only renders when there are active tasks
 */
export function ActiveTasksBar({ tasks, sessionId, onKillTask, onInsertMessage, onShowTerminalOverlay, className }: ActiveTasksBarProps) {
  // Don't render if no tasks
  if (tasks.length === 0) return null

  return (
    <>
      {tasks.map((task) => (
        <TaskActionMenu
          key={task.id}
          task={task}
          sessionId={sessionId}
          onKillTask={onKillTask || (() => {})}
          onInsertMessage={onInsertMessage}
          onShowTerminalOverlay={onShowTerminalOverlay}
          className={className}
        />
      ))}
    </>
  )
}
