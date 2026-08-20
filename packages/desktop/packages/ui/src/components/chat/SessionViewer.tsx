/**
 * SessionViewer - Read-only session transcript viewer
 *
 * Platform-agnostic component for viewing session transcripts.
 * Used by the web viewer app. For interactive chat, Electron uses ChatDisplay.
 *
 * Renders a session's messages as turn cards with gradient fade at top/bottom.
 */

import type { ReactNode } from 'react'
import { useMemo, useState, useCallback } from 'react'
import type { StoredSession } from '@craft-agent/core'
import { cn } from '../../lib/utils'
import { CHAT_LAYOUT, CHAT_CLASSES } from '../../lib/layout'
import { PlatformProvider, type PlatformActions } from '../../context'
import { TurnCard } from './TurnCard'
import { UserMessageBubble } from './UserMessageBubble'
import { SystemMessage } from './SystemMessage'
import {
  groupMessagesByTurn,
  storedToMessage,
  getAssistantTurnUiKey,
  type ActivityItem,
} from './turn-utils'

export type SessionViewerMode = 'interactive' | 'readonly'

export interface SessionViewerProps {
  /** Session data to display */
  session: StoredSession
  /** View mode - 'readonly' for web viewer, 'interactive' for Electron */
  mode?: SessionViewerMode
  /** Platform-specific actions (file opening, URL handling, etc.) */
  platformActions?: PlatformActions
  /** Additional className for the container */
  className?: string
  /** Callback when a turn is clicked */
  onTurnClick?: (turnId: string) => void
  /** Callback when an activity is clicked */
  onActivityClick?: (activity: ActivityItem) => void
  /** Default expanded state for turns (true for readonly, false for interactive) */
  defaultExpanded?: boolean
  /** Custom header content */
  header?: ReactNode
  /** Custom footer content (input area for interactive mode) */
  footer?: ReactNode
  /** Optional session folder path for stripping from file paths in tool display */
  sessionFolderPath?: string
}

/**
 * CraftAgentLogo - The Qwen Code "C" logo for branding
 */
function CraftAgentLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(3.4502, 3)" fill="currentColor">
        <path
          d="M3.17890888,3.6 L3.17890888,0 L16,0 L16,3.6 L3.17890888,3.6 Z M9.642,7.2 L9.64218223,10.8 L0,10.8 L0,3.6 L16,3.6 L16,7.2 L9.642,7.2 Z M3.17890888,18 L3.178,14.4 L0,14.4 L0,10.8 L16,10.8 L16,18 L3.17890888,18 Z"
          fillRule="nonzero"
        />
      </g>
    </svg>
  )
}

/**
 * SessionViewer - Read-only session transcript viewer component
 */
export function SessionViewer({
  session,
  mode = 'readonly',
  platformActions = {},
  className,
  onTurnClick,
  onActivityClick,
  defaultExpanded = false,
  header,
  footer,
  sessionFolderPath,
}: SessionViewerProps) {
  // Convert StoredMessage[] to Message[] and group into turns
  const turns = useMemo(
    () => groupMessagesByTurn(session.messages.map(storedToMessage)),
    [session.messages]
  )

  // Track expanded turns (for controlled state)
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => {
    // Default: all turns collapsed, can override with defaultExpanded prop
    if (defaultExpanded) {
      return new Set(
        turns
          .map((turn, index) => turn.type === 'assistant' ? getAssistantTurnUiKey(turn, index) : null)
          .filter((key): key is string => !!key)
      )
    }
    return new Set()
  })

  // Track expanded activity groups
  const [expandedActivityGroups, setExpandedActivityGroups] = useState<Set<string>>(new Set())

  const handleExpandedChange = useCallback((turnId: string, expanded: boolean) => {
    setExpandedTurns(prev => {
      const next = new Set(prev)
      if (expanded) {
        next.add(turnId)
      } else {
        next.delete(turnId)
      }
      return next
    })
  }, [])

  const handleExpandedActivityGroupsChange = useCallback((groups: Set<string>) => {
    setExpandedActivityGroups(groups)
  }, [])

  const handleOpenActivityDetails = useCallback((activity: ActivityItem) => {
    if (onActivityClick) {
      onActivityClick(activity)
    } else if (platformActions.onOpenActivityDetails) {
      platformActions.onOpenActivityDetails(session.id, activity.id)
    }
  }, [onActivityClick, platformActions, session.id])

  const handleOpenTurnDetails = useCallback((turnId: string) => {
    if (onTurnClick) {
      onTurnClick(turnId)
    } else if (platformActions.onOpenTurnDetails) {
      platformActions.onOpenTurnDetails(session.id, turnId)
    }
  }, [onTurnClick, platformActions, session.id])

  return (
    <PlatformProvider actions={platformActions}>
      <div className={cn("flex flex-col h-full", className)}>
        {/* Header */}
        {header && (
          <div className="shrink-0 border-b">
            {header}
          </div>
        )}

        {/* Messages area with gradient fade mask at top/bottom */}
        <div
          className="flex-1 min-h-0"
          style={{
            maskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'
          }}
        >
          <div className="h-full overflow-y-auto">
            <div className={cn(CHAT_LAYOUT.maxWidth, "mx-auto", CHAT_LAYOUT.containerPadding, CHAT_LAYOUT.messageSpacing)}>
            {turns.map((turn, index) => {
              if (turn.type === 'user') {
                return (
                  <div key={turn.message.id} className={CHAT_LAYOUT.userMessagePadding}>
                    <UserMessageBubble
                      content={turn.message.content}
                      attachments={turn.message.attachments}
                      textElements={turn.message.textElements}
                      onUrlClick={platformActions.onOpenUrl}
                      onFileClick={platformActions.onOpenFile}
                    />
                  </div>
                )
              }

              if (turn.type === 'system') {
                const msgType = turn.message.role === 'error' ? 'error' :
                               turn.message.role === 'warning' ? 'warning' :
                               turn.message.role === 'info' ? 'info' : 'system'
                return (
                  <SystemMessage
                    key={turn.message.id}
                    content={turn.message.content}
                    type={msgType}
                  />
                )
              }

              if (turn.type === 'assistant') {
                const assistantUiKey = getAssistantTurnUiKey(turn, index)
                return (
                  <TurnCard
                    key={assistantUiKey}
                    turnId={turn.turnId}
                    activities={turn.activities}
                    response={turn.response}
                    intent={turn.intent}
                    isStreaming={turn.isStreaming}
                    isComplete={turn.isComplete}
                    isExpanded={expandedTurns.has(assistantUiKey)}
                    onExpandedChange={(expanded) => handleExpandedChange(assistantUiKey, expanded)}
                    onOpenFile={platformActions.onOpenFile}
                    onOpenUrl={platformActions.onOpenUrl}
                    onPopOut={platformActions.onOpenMarkdownPreview}
                    onOpenDetails={() => handleOpenTurnDetails(turn.turnId)}
                    onOpenActivityDetails={handleOpenActivityDetails}
                    todos={turn.todos}
                    expandedActivityGroups={expandedActivityGroups}
                    onExpandedActivityGroupsChange={handleExpandedActivityGroupsChange}
                    hasEditOrWriteActivities={turn.activities.some(a =>
                      a.toolName === 'Edit' || a.toolName === 'Write'
                    )}
                    onOpenMultiFileDiff={platformActions.onOpenMultiFileDiff
                      ? () => platformActions.onOpenMultiFileDiff!(session.id, turn.turnId)
                      : undefined
                    }
                    sessionFolderPath={sessionFolderPath}
                    annotationInteractionMode={mode === 'readonly' ? 'tooltip-only' : 'interactive'}
                  />
                )
              }

              return null
            })}

            {/* Bottom branding */}
            <div className={CHAT_CLASSES.brandingContainer}>
              <CraftAgentLogo className="w-8 h-8 text-[#9570BE]/40" />
            </div>
            </div>
          </div>
        </div>

        {/* Footer (input area) */}
        {footer && (
          <div className="shrink-0 border-t">
            {footer}
          </div>
        )}
      </div>
    </PlatformProvider>
  )
}
