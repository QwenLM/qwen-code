/**
 * Renderer-side Performance Instrumentation
 *
 * Tracks session switch timing from click to render complete.
 * Logs via electron-log to the main log file.
 *
 * Usage:
 *   // In SessionList click handler:
 *   rendererPerf.startSessionSwitch(sessionId)
 *
 *   // In ChatTabPanel when session loads:
 *   rendererPerf.markSessionSwitch(sessionId, 'session.loaded')
 *
 *   // When render is complete:
 *   rendererPerf.endSessionSwitch(sessionId)
 */

import log from 'electron-log/renderer'

const perfLog = log.scope('perf')

interface SessionSwitchMetric {
  sessionId: string
  startTime: number
  marks: Array<{ name: string; elapsed: number }>
  endTime?: number
  duration?: number
}

// Pending session switches (keyed by sessionId)
const pendingSwitches = new Map<string, SessionSwitchMetric>()

// Recent completed metrics for analysis
const recentMetrics: SessionSwitchMetric[] = []
const MAX_RECENT_METRICS = 50

// Debug mode detection (matches main process pattern)
let debugMode = false

/**
 * Initialize perf tracking. Call this once on app startup.
 * In Electron renderer, we check if we're in dev mode.
 */
export function initRendererPerf(isDebug: boolean): void {
  debugMode = isDebug
  if (debugMode) {
    perfLog.info('Renderer performance tracking enabled')
  }
}

/**
 * Check if perf tracking is enabled
 */
export function isRendererPerfEnabled(): boolean {
  return debugMode
}

/**
 * Start tracking a session switch.
 * Call this when user clicks on a session in the list.
 * Clears any other pending switches (user navigated away before completion).
 */
export function startSessionSwitch(sessionId: string): void {
  if (!debugMode) return

  // Clear any other pending switches - user navigated away before they completed
  pendingSwitches.clear()

  const metric: SessionSwitchMetric = {
    sessionId,
    startTime: performance.now(),
    marks: [],
  }
  pendingSwitches.set(sessionId, metric)

  // Log the tap immediately (0ms elapsed) - shows the start of the flow
  perfLog.info(`${sessionId.slice(0, 8)}... session-list.tap: 0.0ms`)
}

/**
 * Add a checkpoint mark during session switch.
 * Use for intermediate steps like 'session.loaded', 'agent.status', etc.
 */
export function markSessionSwitch(sessionId: string, markName: string): void {
  if (!debugMode) return

  const metric = pendingSwitches.get(sessionId)
  if (!metric) return

  const elapsed = performance.now() - metric.startTime
  metric.marks.push({ name: markName, elapsed })

  perfLog.info(`${sessionId.slice(0, 8)}... ${markName}: ${elapsed.toFixed(1)}ms`)
}

/**
 * End session switch tracking and log final duration.
 * Call this when the chat display has fully rendered.
 */
export function endSessionSwitch(sessionId: string): number | null {
  if (!debugMode) return null

  const metric = pendingSwitches.get(sessionId)
  if (!metric) return null

  metric.endTime = performance.now()
  metric.duration = metric.endTime - metric.startTime

  // Store in recent metrics
  recentMetrics.push(metric)
  if (recentMetrics.length > MAX_RECENT_METRICS) {
    recentMetrics.shift()
  }

  // Clean up pending
  pendingSwitches.delete(sessionId)

  // Log completion with breakdown
  const marksStr = metric.marks.map((m) => `${m.name}:${m.elapsed.toFixed(0)}ms`).join(' → ')
  perfLog.info(
    `Session switch complete: ${metric.duration.toFixed(1)}ms` +
      (marksStr ? ` (${marksStr})` : '')
  )

  return metric.duration
}

/**
 * Get recent session switch metrics for analysis
 */
export function getRecentMetrics(): SessionSwitchMetric[] {
  return [...recentMetrics]
}

/**
 * Get statistics for session switch times
 */
export function getSessionSwitchStats(): {
  count: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  minMs: number
  maxMs: number
} | null {
  if (recentMetrics.length === 0) return null

  const durations = recentMetrics
    .filter((m) => m.duration !== undefined)
    .map((m) => m.duration!)

  if (durations.length === 0) return null

  const sorted = [...durations].sort((a, b) => a - b)
  const sum = durations.reduce((a, b) => a + b, 0)

  return {
    count: durations.length,
    avgMs: sum / durations.length,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  }
}

/**
 * Clear all metrics
 */
export function clearMetrics(): void {
  pendingSwitches.clear()
  recentMetrics.length = 0
}

// Export as namespace for convenient usage
export const rendererPerf = {
  init: initRendererPerf,
  isEnabled: isRendererPerfEnabled,
  startSessionSwitch,
  markSessionSwitch,
  endSessionSwitch,
  getRecentMetrics,
  getStats: getSessionSwitchStats,
  clear: clearMetrics,
}

export default rendererPerf
