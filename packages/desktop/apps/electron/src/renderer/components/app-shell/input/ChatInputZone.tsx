import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'
import { flattenLabels, type LabelConfig } from '@craft-agent/shared/labels'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'
import type { SessionStatus } from '@/config/session-status-config'
import type { BackgroundTask } from '../ActiveTasksBar'
import { ActiveOptionBadges } from '../ActiveOptionBadges'
import { InputContainer } from './InputContainer'
import { InputErrorBoundary } from './InputErrorBoundary'
import { FEATURE_FLAGS } from '@craft-agent/shared/feature-flags'
import type {
  GoalControlRequest,
  GoalSnapshotV2,
} from '../../../../shared/types'
import { GoalStatusBar, type GoalStatusBarLabels } from './GoalStatusBar'

interface ChatInputZoneProps {
  compactMode?: boolean
  showOptionBadges?: boolean
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  tasks?: BackgroundTask[]
  sessionId: string
  sessionFolderPath?: string
  onKillTask?: (taskId: string) => void
  onInsertMessage?: (text: string) => void
  sessionLabels?: string[]
  labels?: LabelConfig[]
  onLabelsChange?: (labels: string[]) => void
  sessionStatuses?: SessionStatus[]
  currentSessionStatus?: string
  onSessionStatusChange?: (stateId: string) => void
  goalState?: GoalSnapshotV2
  onGoalControl?: (request: GoalControlRequest) => Promise<void>
  onGoalError?: (error: unknown) => void
  className?: string
  inputProps: React.ComponentProps<typeof InputContainer>
}

export function ChatInputZone({
  compactMode = false,
  showOptionBadges,
  permissionMode = 'ask',
  onPermissionModeChange,
  tasks = [],
  sessionId,
  sessionFolderPath,
  onKillTask,
  onInsertMessage,
  sessionLabels = [],
  labels = [],
  onLabelsChange,
  sessionStatuses = [],
  currentSessionStatus = 'todo',
  onSessionStatusChange,
  goalState,
  onGoalControl,
  onGoalError,
  className,
  inputProps,
}: ChatInputZoneProps) {
  const { t } = useTranslation()
  const [autoOpenLabelId, setAutoOpenLabelId] = React.useState<string | null>(
    null,
  )
  const shouldShowOptionBadges = showOptionBadges ?? !compactMode
  const inputResetKey = `${sessionId}::${inputProps.structuredInput?.type ?? 'freeform'}`
  const visibleLabels = FEATURE_FLAGS.sessionLabelsUi ? labels : []
  const visibleSessionLabels = FEATURE_FLAGS.sessionLabelsUi
    ? sessionLabels
    : []
  const goalLabels = React.useMemo<GoalStatusBarLabels>(
    () => ({
      status: {
        active: t('goal.status.active'),
        paused: t('goal.status.paused'),
        blocked: t('goal.status.blocked'),
        usage_limited: t('goal.status.usageLimited'),
        complete: t('goal.status.complete'),
      },
      activity: {
        idle: t('goal.activity.idle'),
        running: t('goal.activity.running'),
        verifying: t('goal.activity.verifying'),
      },
      edit: t('goal.edit'),
      pause: t('goal.pause'),
      resume: t('goal.resume'),
      clear: t('goal.clear'),
      save: t('common.save'),
      cancel: t('common.cancel'),
      objective: t('goal.objective'),
      elapsed: t('goal.elapsed'),
    }),
    [t],
  )

  const handleClearDraft = React.useCallback(() => {
    inputProps.onInputChange?.('')
    inputProps.onAttachmentsChange?.([])
  }, [inputProps])

  const handleLabelAdd = React.useCallback(
    (labelId: string) => {
      const current = sessionLabels || []
      if (current.includes(labelId)) return

      onLabelsChange?.([...current, labelId])

      const config = flattenLabels(labels || []).find(
        (label) => label.id === labelId,
      )
      if (config?.valueType) {
        setAutoOpenLabelId(labelId)
      }
    },
    [labels, onLabelsChange, sessionLabels],
  )

  return (
    <div
      className={cn(
        CHAT_LAYOUT.maxWidth,
        'mx-auto w-full mt-1',
        compactMode ? 'px-2 pb-3' : 'px-3 @xs/panel:px-4 pb-4',
        className,
      )}
    >
      {shouldShowOptionBadges && (
        <ActiveOptionBadges
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          tasks={tasks}
          sessionId={sessionId}
          sessionFolderPath={sessionFolderPath}
          onKillTask={onKillTask}
          onInsertMessage={onInsertMessage ?? inputProps.onInputChange}
          sessionLabels={visibleSessionLabels}
          labels={visibleLabels}
          onLabelsChange={
            FEATURE_FLAGS.sessionLabelsUi ? onLabelsChange : undefined
          }
          onRemoveLabel={(labelId) => {
            const next = (sessionLabels || []).filter(
              (entry) => entry !== labelId && !entry.startsWith(`${labelId}::`),
            )
            onLabelsChange?.(next)
          }}
          autoOpenLabelId={
            FEATURE_FLAGS.sessionLabelsUi ? autoOpenLabelId : null
          }
          onAutoOpenConsumed={() => setAutoOpenLabelId(null)}
          sessionStatuses={sessionStatuses}
          currentSessionStatus={currentSessionStatus}
          onSessionStatusChange={onSessionStatusChange}
        />
      )}

      {goalState?.goal && onGoalControl && (
        <GoalStatusBar
          snapshot={goalState}
          labels={goalLabels}
          onControl={onGoalControl}
          onError={onGoalError}
        />
      )}

      <InputErrorBoundary
        sessionId={sessionId}
        resetKey={inputResetKey}
        onClearDraft={handleClearDraft}
      >
        <InputContainer
          {...inputProps}
          compactMode={compactMode}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          labels={visibleLabels}
          sessionLabels={visibleSessionLabels}
          onLabelAdd={
            FEATURE_FLAGS.sessionLabelsUi ? handleLabelAdd : undefined
          }
          sessionFolderPath={sessionFolderPath}
          sessionId={sessionId}
          currentSessionStatus={currentSessionStatus}
        />
      </InputErrorBoundary>
    </div>
  )
}
