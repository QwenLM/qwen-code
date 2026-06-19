/**
 * useAutomations
 *
 * Encapsulates all automations state management:
 * - Loading automations from automations.json
 * - Subscribing to live updates
 * - Test, toggle, duplicate, delete handlers
 * - Delete confirmation state
 * - Syncing automations to Jotai atom for cross-component access
 */

import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { automationsAtom } from '@/atoms/automations'
import { parseAutomationsConfig, type AutomationListItem, type TestResult, type ExecutionEntry } from '@/components/automations/types'

async function loadAutomationsFromServer(workspaceId: string): Promise<AutomationListItem[]> {
  const json = await window.electronAPI.getAutomations(workspaceId)
  if (!json) return [] // No automations configured yet
  return parseAutomationsConfig(json)
}

export interface UseAutomationsResult {
  automations: AutomationListItem[]
  automationTestResults: Record<string, TestResult>
  automationPendingDelete: string | null
  pendingDeleteAutomation: AutomationListItem | undefined
  setAutomationPendingDelete: (id: string | null) => void
  handleTestAutomation: (automationId: string) => void
  handleToggleAutomation: (automationId: string) => void
  handleDuplicateAutomation: (automationId: string) => void
  handleDeleteAutomation: (automationId: string) => void
  confirmDeleteAutomation: () => void
  getAutomationHistory: (automationId: string) => Promise<ExecutionEntry[]>
  handleReplayAutomation: (automationId: string, event: string) => void
}

export function useAutomations(
  activeWorkspaceId: string | null | undefined,
): UseAutomationsResult {
  const { t } = useTranslation()
  const [automations, setAutomations] = useState<AutomationListItem[]>([])
  const [automationTestResults, setAutomationTestResults] = useState<Record<string, TestResult>>({})
  const [automationPendingDelete, setAutomationPendingDelete] = useState<string | null>(null)

  // Sync automations to Jotai atom for cross-component access (MainContentPanel)
  const setAutomationsAtom = useSetAtom(automationsAtom)
  useEffect(() => {
    setAutomationsAtom(automations)
  }, [automations, setAutomationsAtom])

  // Load automations from server and hydrate lastExecutedAt from history in one step.
  // This avoids the race where a config reload wipes timestamps before the
  // history effect can re-merge them.
  const loadAndHydrate = useCallback(async () => {
    if (!activeWorkspaceId) return
    try {
      const items = await loadAutomationsFromServer(activeWorkspaceId)
      try {
        const map = await window.electronAPI.getAutomationLastExecuted(activeWorkspaceId)
        for (const item of items) {
          item.lastExecutedAt = map[item.id] ?? item.lastExecutedAt
        }
      } catch { /* history unavailable — timestamps stay undefined */ }
      setAutomations(items)
    } catch {
      setAutomations([])
    }
  }, [activeWorkspaceId])

  // Initial load
  useEffect(() => {
    loadAndHydrate()
  }, [loadAndHydrate])

  // Subscribe to live automations updates (when automations.json changes on disk)
  useEffect(() => {
    if (!activeWorkspaceId) return
    const cleanup = window.electronAPI.onAutomationsChanged(() => { loadAndHydrate() })
    return () => { cleanup() }
  }, [activeWorkspaceId, loadAndHydrate])

  // Shared lookup — avoids repeating automations.find() in every callback
  const findAutomation = useCallback((id: string) => automations.find(h => h.id === id), [automations])

  // Test automation — aggregate all action results
  const handleTestAutomation = useCallback((automationId: string) => {
    const automation = findAutomation(automationId)
    if (!automation || !activeWorkspaceId) return

    setAutomationTestResults(prev => ({ ...prev, [automationId]: { state: 'running' } }))

    window.electronAPI.testAutomation({
      workspaceId: activeWorkspaceId,
      automationId: automation.id,
      automationName: automation.name,
      actions: automation.actions,
      permissionMode: automation.permissionMode,
      labels: automation.labels,
    }).then((result) => {
      const actions = result.actions
      if (!actions || actions.length === 0) {
        setAutomationTestResults(prev => ({ ...prev, [automationId]: { state: 'error', stderr: 'No actions to execute' } }))
        return
      }
      const hasError = actions.some(a => !a.success)
      const state = hasError ? 'error' : 'success'
      const stderr = actions.map(a => ('stderr' in a ? a.stderr : 'error' in a ? a.error : undefined)).filter(Boolean).join('\n')
      const duration = actions.reduce((sum, a) => sum + (a.duration ?? 0), 0)
      setAutomationTestResults(prev => ({
        ...prev,
        [automationId]: {
          state,
          stderr: stderr || undefined,
          duration: duration || undefined,
        },
      }))
    }).catch((err: Error) => {
      setAutomationTestResults(prev => ({ ...prev, [automationId]: { state: 'error', stderr: err.message } }))
    })
  }, [findAutomation, activeWorkspaceId])

  const handleToggleAutomation = useCallback((automationId: string) => {
    const automation = findAutomation(automationId)
    if (!automation || !activeWorkspaceId) return
    window.electronAPI.setAutomationEnabled(
      activeWorkspaceId,
      automation.event,
      automation.matcherIndex,
      !automation.enabled,
    ).catch(() => {
      toast.error(t('toast.failedToToggleAutomation'))
    })
  }, [findAutomation, activeWorkspaceId])

  const handleDuplicateAutomation = useCallback((automationId: string) => {
    const automation = findAutomation(automationId)
    if (!automation || !activeWorkspaceId) return
    window.electronAPI.duplicateAutomation(activeWorkspaceId, automation.event, automation.matcherIndex)
      .catch(() => toast.error(t('toast.failedToDuplicateAutomation')))
  }, [findAutomation, activeWorkspaceId])

  // Delete: show confirmation dialog
  const handleDeleteAutomation = useCallback((automationId: string) => {
    setAutomationPendingDelete(automationId)
  }, [])

  const pendingDeleteAutomation = automationPendingDelete ? findAutomation(automationPendingDelete) : undefined

  const confirmDeleteAutomation = useCallback(() => {
    if (!pendingDeleteAutomation || !activeWorkspaceId) return
    window.electronAPI.deleteAutomation(activeWorkspaceId, pendingDeleteAutomation.event, pendingDeleteAutomation.matcherIndex)
      .catch(() => toast.error(t('toast.failedToDeleteAutomation')))
    setAutomationPendingDelete(null)
  }, [pendingDeleteAutomation, activeWorkspaceId])

  // Fetch execution history for a specific automation
  const getAutomationHistory = useCallback(async (automationId: string): Promise<ExecutionEntry[]> => {
    if (!activeWorkspaceId) return []
    try {
      const entries = await window.electronAPI.getAutomationHistory(activeWorkspaceId, automationId, 20)
      const automation = findAutomation(automationId)
      return entries.map(e => ({
        id: `${e.id}-${e.ts}`,
        automationId: e.id,
        event: automation?.event ?? 'LabelAdd',
        status: e.ok ? 'success' as const : 'error' as const,
        duration: e.webhook?.durationMs ?? 0,
        timestamp: e.ts,
        sessionId: e.sessionId,
        actionSummary: e.webhook
          ? `Webhook ${e.webhook.method} ${e.webhook.url}${e.webhook.attempts && e.webhook.attempts > 1 ? ` (${e.webhook.attempts} attempts)` : ''}`
          : e.prompt,
        error: e.webhook?.error ?? e.error,
        webhookDetails: e.webhook ? {
          method: e.webhook.method,
          url: e.webhook.url,
          statusCode: e.webhook.statusCode,
          durationMs: e.webhook.durationMs,
          attempts: e.webhook.attempts,
          error: e.webhook.error,
          responseBody: e.webhook.responseBody,
        } : undefined,
      }))
    } catch {
      return []
    }
  }, [activeWorkspaceId, findAutomation])

  // Replay failed webhook actions for a specific automation
  const handleReplayAutomation = useCallback((automationId: string, event: string) => {
    if (!activeWorkspaceId) return
    window.electronAPI.replayAutomation(activeWorkspaceId, automationId, event)
      .then(() => {
        toast.success(t('toast.webhookReplayCompleted'))
      })
      .catch((err: Error) => {
        toast.error(t("toast.replayFailed", { error: err.message }))
      })
  }, [activeWorkspaceId])

  return {
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
  }
}
