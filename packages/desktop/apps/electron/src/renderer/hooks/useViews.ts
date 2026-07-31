/**
 * useViews Hook
 *
 * React hook that loads view configs, compiles their Filtrex expressions,
 * and provides an evaluator function to match sessions against views.
 *
 * Compilation happens once on config load (useMemo). The compiled functions
 * run at native JS speed — no parsing overhead per evaluation.
 *
 * Re-compiles on LABELS_CHANGED events (views changes trigger same broadcast).
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { ViewConfig, CompiledView, ViewEvaluationContext } from '@craft-agent/shared/views'
import { compileAllViews, evaluateViews, buildViewContext } from '@craft-agent/shared/views'
import type { SessionMeta } from '../atoms/sessions'

export interface UseViewsResult {
  /** Raw view configs (for display in sidebar, settings, etc.) */
  viewConfigs: ViewConfig[]
  /** Loading state */
  isLoading: boolean
  /**
   * Evaluate a session against all compiled views.
   * Returns the configs of matching views.
   * Fast: runs compiled native JS functions, no parsing.
   */
  evaluateSession: (meta: SessionMeta) => ViewConfig[]
  /** Force re-fetch from IPC */
  refresh: () => Promise<void>
}

/**
 * Load and compile views for a workspace.
 * Expressions are compiled once on load, then evaluated per-session per-render.
 * Subscribes to live changes via LABELS_CHANGED event (views trigger same broadcast).
 */
export function useViews(workspaceId: string | null): UseViewsResult {
  const [configs, setConfigs] = useState<ViewConfig[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setConfigs([])
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const views = await window.electronAPI.listViews(workspaceId)
      setConfigs(views)
    } catch (err) {
      console.error('[useViews] Failed to load views:', err)
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId])

  // Load on workspace change
  useEffect(() => {
    refresh()
  }, [refresh])

  // Subscribe to live changes (views changes trigger LABELS_CHANGED broadcast)
  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onLabelsChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) {
        refresh()
      }
    })

    return cleanup
  }, [workspaceId, refresh])

  // Compile all expressions once when configs change.
  // This is the one-time parsing overhead — after this, evaluation is native speed.
  const compiled: CompiledView[] = useMemo(() => {
    if (configs.length === 0) return []
    return compileAllViews(configs)
  }, [configs])

  // Memoized evaluator function — stable reference across renders.
  // Builds evaluation context from SessionMeta, then runs all compiled functions.
  const evaluateSession = useCallback((meta: SessionMeta): ViewConfig[] => {
    if (compiled.length === 0) return []

    // Build the evaluation context from session metadata.
    // This maps SessionMeta fields to the flat context object expected by expressions.
    const context: ViewEvaluationContext = buildViewContext({
      name: meta.name,
      preview: meta.preview,
      sessionStatus: meta.sessionStatus,
      permissionMode: meta.permissionMode,
      model: meta.model,
      lastMessageRole: meta.lastMessageRole,
      lastMessageAt: meta.lastMessageAt,
      createdAt: meta.createdAt,
      messageCount: meta.messageCount,
      isFlagged: meta.isFlagged,
      hasUnread: meta.hasUnread,
      isProcessing: meta.isProcessing,
      labels: meta.labels,
      tokenUsage: meta.tokenUsage,
    })

    return evaluateViews(context, compiled)
  }, [compiled])

  return {
    viewConfigs: configs,
    isLoading,
    evaluateSession,
    refresh,
  }
}
