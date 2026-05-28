/**
 * MainContentPanel - Right panel component for displaying content
 *
 * Renders content based on the unified NavigationState:
 * - Chats navigator: ChatPage for selected session, or empty state
 * - Sources navigator: SourceInfoPage for selected source, or empty state
 * - Settings navigator: Settings, Preferences, or Shortcuts page
 *
 * The NavigationState is the single source of truth for what to display.
 *
 * In focused mode (single window), wraps content with StoplightProvider
 * so PanelHeader components automatically compensate for macOS traffic lights.
 *
 * When multiple sessions are selected (multi-select mode), shows the
 * MultiSelectPanel with batch action buttons instead of a single chat.
 */

import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Panel } from './Panel'
import { MultiSelectPanel } from './MultiSelectPanel'
import { useAppShellContext } from '@/context/AppShellContext'
import { sessionMetaMapAtom, type SessionMeta } from '@/atoms/sessions'
import { StoplightProvider } from '@/context/StoplightContext'
import {
  useNavigationState,
  isSessionsNavigation,
  isSourcesNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
  isSkillMarketplaceNavigation,
  isAutomationsNavigation,
} from '@/contexts/NavigationContext'
import {
  useSessionSelection,
  useIsMultiSelectActive,
  useSelectedIds,
  useSelectionCount,
} from '@/hooks/useSession'
import {
  sourceSelection,
  skillSelection,
  automationSelection,
} from '@/hooks/useEntitySelection'
import { extractLabelId } from '@craft-agent/shared/labels'
import type { SessionStatusId } from '@/config/session-status-config'
import { SourceInfoPage, ChatPage, DraftChatPage } from '@/pages'
import SkillInfoPage from '@/pages/SkillInfoPage'
import { SkillMarketplaceDetailPanel } from './SkillMarketplaceDetailPanel'
import { getSettingsPageComponent } from '@/pages/settings/settings-pages'
import { AutomationInfoPage } from '../automations/AutomationInfoPage'
import type { ExecutionEntry } from '../automations/types'
import { automationsAtom } from '@/atoms/automations'
import {
  SendResourceToWorkspaceDialog,
  type SendResourceType,
} from './SendResourceToWorkspaceDialog'

export interface MainContentPanelProps {
  /** Whether both sidebar and navigator are hidden (focus mode / CMD+.) */
  isSidebarAndNavigatorHidden?: boolean
  /** Optional className for the container */
  className?: string
  /**
   * Override the navigation state for this panel.
   * When provided, this panel renders based on the override instead of the global NavigationState.
   * Used by PanelSlot to render panels in the panel stack.
   */
  navStateOverride?: import('../../../shared/types').NavigationState | null
}

export function MainContentPanel({
  isSidebarAndNavigatorHidden = false,
  className,
  navStateOverride,
}: MainContentPanelProps) {
  const { t } = useTranslation()
  const globalNavState = useNavigationState()
  const navState = navStateOverride ?? globalNavState
  const {
    activeWorkspaceId,
    activeQwenSessionId,
    workspaces,
    onSessionStatusChange,
    onArchiveSession,
    onSessionLabelsChange,
    sessionStatuses,
    labels,
    onTestAutomation,
    onToggleAutomation,
    onDuplicateAutomation,
    onDeleteAutomation,
    onReplayAutomation,
    automationTestResults,
    getAutomationHistory,
    activeSessionWorkingDirectory,
    reloadSkills,
  } = useAppShellContext()

  // Session multi-select state
  const isMultiSelectActive = useIsMultiSelectActive()
  const selectedIds = useSelectedIds()
  const selectionCount = useSelectionCount()
  const { clearMultiSelect } = useSessionSelection()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const automations = useAtomValue(automationsAtom)

  // Execution history for the selected automation
  const selectedAutomationId = isAutomationsNavigation(navState)
    ? navState.details?.automationId
    : undefined
  const [executions, setExecutions] = useState<ExecutionEntry[]>([])

  useEffect(() => {
    if (!selectedAutomationId || !getAutomationHistory) {
      setExecutions([])
      return
    }
    let stale = false

    // Initial fetch
    getAutomationHistory(selectedAutomationId).then((entries) => {
      if (!stale) setExecutions(entries)
    })

    // Re-fetch on automation changes (live updates when automations fire)
    const cleanup = window.electronAPI.onAutomationsChanged(() => {
      if (!stale) {
        getAutomationHistory(selectedAutomationId).then((entries) => {
          if (!stale) setExecutions(entries)
        })
      }
    })

    return () => {
      stale = true
      cleanup()
    }
  }, [selectedAutomationId, getAutomationHistory])

  // Source multi-select state
  const isSourceMultiSelectActive = sourceSelection.useIsMultiSelectActive()
  const sourceSelectionCount = sourceSelection.useSelectionCount()
  const selectedSourceIds = sourceSelection.useSelectedIds()
  const { clearMultiSelect: clearSourceSelection } =
    sourceSelection.useSelection()

  // Skill multi-select state
  const isSkillMultiSelectActive = skillSelection.useIsMultiSelectActive()
  const skillSelectionCount = skillSelection.useSelectionCount()
  const selectedSkillIds = skillSelection.useSelectedIds()
  const { clearMultiSelect: clearSkillSelection } =
    skillSelection.useSelection()

  // Automation multi-select state
  const isAutomationMultiSelectActive =
    automationSelection.useIsMultiSelectActive()
  const automationSelectionCount = automationSelection.useSelectionCount()
  const selectedAutomationIds = automationSelection.useSelectedIds()
  const { clearMultiSelect: clearAutomationSelection } =
    automationSelection.useSelection()

  // Send to Workspace dialog state (shared across resource types)
  const [sendDialogOpen, setSendDialogOpen] = useState(false)
  const [sendResourceType, setSendResourceType] =
    useState<SendResourceType>('source')
  const [sendResourceIds, setSendResourceIds] = useState<string[]>([])
  const [sendResourceLabel, setSendResourceLabel] = useState('')
  const hasOtherWorkspaces = workspaces.length > 1

  const openSendDialog = useCallback(
    (type: SendResourceType, ids: Set<string>) => {
      const count = ids.size
      setSendResourceType(type)
      setSendResourceIds([...ids])
      setSendResourceLabel(`${count} ${type}${count !== 1 ? 's' : ''}`)
      setSendDialogOpen(true)
    },
    [],
  )

  const selectedMetas = useMemo(() => {
    const metas: SessionMeta[] = []
    selectedIds.forEach((id) => {
      const meta = sessionMetaMap.get(id)
      if (meta) metas.push(meta)
    })
    return metas
  }, [selectedIds, sessionMetaMap])

  const activeStatusId = useMemo((): SessionStatusId | null => {
    if (selectedMetas.length === 0) return null
    const first = (selectedMetas[0].sessionStatus || 'todo') as SessionStatusId
    const allSame = selectedMetas.every(
      (meta) => (meta.sessionStatus || 'todo') === first,
    )
    return allSame ? first : null
  }, [selectedMetas])

  const appliedLabelIds = useMemo(() => {
    if (selectedMetas.length === 0) return new Set<string>()
    const toLabelSet = (meta: SessionMeta) =>
      new Set((meta.labels || []).map((entry) => extractLabelId(entry)))
    const [first, ...rest] = selectedMetas.map(toLabelSet)
    const intersection = new Set(first)
    for (const labelSet of rest) {
      for (const id of [...intersection]) {
        if (!labelSet.has(id)) intersection.delete(id)
      }
    }
    return intersection
  }, [selectedMetas])

  // Batch operations for multi-select
  const handleBatchSetStatus = useCallback(
    (status: SessionStatusId) => {
      selectedIds.forEach((sessionId) => {
        onSessionStatusChange(sessionId, status)
      })
    },
    [selectedIds, onSessionStatusChange],
  )

  const handleBatchArchive = useCallback(() => {
    selectedIds.forEach((sessionId) => {
      onArchiveSession(sessionId)
    })
    clearMultiSelect()
  }, [selectedIds, onArchiveSession, clearMultiSelect])

  const handleBatchToggleLabel = useCallback(
    (labelId: string) => {
      if (!onSessionLabelsChange) return
      const allHaveLabel = selectedMetas.every((meta) =>
        (meta.labels || []).some((entry) => extractLabelId(entry) === labelId),
      )

      selectedMetas.forEach((meta) => {
        const labels = meta.labels || []
        const hasLabel = labels.some(
          (entry) => extractLabelId(entry) === labelId,
        )
        const filtered = labels.filter(
          (entry) => extractLabelId(entry) !== labelId,
        )
        const nextLabels = allHaveLabel
          ? filtered
          : hasLabel
            ? labels
            : [...labels, labelId]
        onSessionLabelsChange(meta.id, nextLabels)
      })
    },
    [selectedMetas, onSessionLabelsChange],
  )

  // Wrap content with StoplightProvider so PanelHeaders auto-compensate in focused mode.
  // Also renders the Send to Workspace dialog (portal-based, so it overlays regardless of position).
  const wrapWithStoplight = (content: React.ReactNode) => (
    <StoplightProvider value={isSidebarAndNavigatorHidden}>
      {content}
      <SendResourceToWorkspaceDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        resourceType={sendResourceType}
        resourceIds={sendResourceIds}
        resourceLabel={sendResourceLabel}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId || ''}
      />
    </StoplightProvider>
  )

  // Settings navigator - uses component map from settings-pages.ts
  if (isSettingsNavigation(navState)) {
    const SettingsPageComponent = getSettingsPageComponent(navState.subpage)
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <SettingsPageComponent />
      </Panel>,
    )
  }

  // Sources navigator - show source info, multi-select panel, or empty state
  if (isSourcesNavigation(navState)) {
    if (isSourceMultiSelectActive) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <MultiSelectPanel
            count={sourceSelectionCount}
            entityType="source"
            onSendToWorkspace={
              hasOtherWorkspaces
                ? () => openSendDialog('source', selectedSourceIds)
                : undefined
            }
            onClearSelection={clearSourceSelection}
          />
        </Panel>,
      )
    }
    if (navState.details) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <SourceInfoPage
            sourceSlug={navState.details.sourceSlug}
            workspaceId={activeWorkspaceId || ''}
          />
        </Panel>,
      )
    }
    // No source selected - empty state
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <div className="flex items-center justify-center h-full text-muted-foreground">
          <p className="text-sm">{t('sourcesList.noSourcesConfigured')}</p>
        </div>
      </Panel>,
    )
  }

  // Skills navigator - show skill info, multi-select panel, or empty state
  if (isSkillsNavigation(navState)) {
    if (isSkillMultiSelectActive) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <MultiSelectPanel
            count={skillSelectionCount}
            entityType="skill"
            onSendToWorkspace={
              hasOtherWorkspaces
                ? () => openSendDialog('skill', selectedSkillIds)
                : undefined
            }
            onClearSelection={clearSkillSelection}
          />
        </Panel>,
      )
    }
    if (navState.details?.type === 'skill') {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <SkillInfoPage
            skillSlug={navState.details.skillSlug}
            workspaceId={activeWorkspaceId || ''}
            workingDirectory={activeSessionWorkingDirectory}
            activeSessionId={activeQwenSessionId}
          />
        </Panel>,
      )
    }
    // No skill selected - empty state
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <div className="flex items-center justify-center h-full text-muted-foreground">
          <p className="text-sm">{t('skillsList.noSkillsConfigured')}</p>
        </div>
      </Panel>,
    )
  }

  // Skill marketplace navigator
  if (isSkillMarketplaceNavigation(navState)) {
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <SkillMarketplaceDetailPanel
          workspaceId={activeWorkspaceId || undefined}
          workingDirectory={activeSessionWorkingDirectory}
          activeSessionId={activeQwenSessionId}
          selectedSkillId={
            navState.details?.type === 'marketplaceSkill'
              ? navState.details.skillId
              : null
          }
          onInstalled={reloadSkills}
        />
      </Panel>,
    )
  }

  // Automations navigator - show automation info, multi-select panel, or empty state
  if (isAutomationsNavigation(navState)) {
    if (isAutomationMultiSelectActive) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <MultiSelectPanel
            count={automationSelectionCount}
            entityType="automation"
            onSendToWorkspace={
              hasOtherWorkspaces
                ? () => openSendDialog('automation', selectedAutomationIds)
                : undefined
            }
            onClearSelection={clearAutomationSelection}
          />
        </Panel>,
      )
    }
    if (navState.details) {
      const automation = automations.find(
        (h) => h.id === navState.details!.automationId,
      )
      if (automation) {
        return wrapWithStoplight(
          <Panel variant="grow" className={className}>
            <AutomationInfoPage
              automation={automation}
              executions={executions}
              testResult={automationTestResults?.[automation.id]}
              onTest={
                onTestAutomation
                  ? () => onTestAutomation(automation.id)
                  : undefined
              }
              onToggleEnabled={
                onToggleAutomation
                  ? () => onToggleAutomation(automation.id)
                  : undefined
              }
              onDuplicate={
                onDuplicateAutomation
                  ? () => onDuplicateAutomation(automation.id)
                  : undefined
              }
              onDelete={
                onDeleteAutomation
                  ? () => onDeleteAutomation(automation.id)
                  : undefined
              }
              onReplay={onReplayAutomation}
            />
          </Panel>,
        )
      }
    }
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <div className="flex items-center justify-center h-full text-muted-foreground">
          <p className="text-sm">{t('automations.noAutomationsConfigured')}</p>
        </div>
      </Panel>,
    )
  }

  // Chats navigator - show chat, multi-select panel, or empty state
  if (isSessionsNavigation(navState)) {
    // Multi-select mode: show batch actions panel
    if (isMultiSelectActive) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <MultiSelectPanel
            count={selectionCount}
            sessionStatuses={sessionStatuses}
            activeStatusId={activeStatusId}
            onSetStatus={handleBatchSetStatus}
            labels={labels}
            appliedLabelIds={appliedLabelIds}
            onToggleLabel={handleBatchToggleLabel}
            onArchive={handleBatchArchive}
            onClearSelection={clearMultiSelect}
          />
        </Panel>,
      )
    }

    if (navState.details) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <ChatPage sessionId={navState.details.sessionId} />
        </Panel>,
      )
    }
    // New-chat draft: no session is created until the first message is sent.
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <DraftChatPage />
      </Panel>,
    )
  }

  // Fallback (should not happen with proper NavigationState)
  return wrapWithStoplight(
    <Panel variant="grow" className={className}>
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p className="text-sm">{t('session.selectConversation')}</p>
      </div>
    </Panel>,
  )
}
