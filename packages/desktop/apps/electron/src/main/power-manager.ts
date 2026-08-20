/**
 * Power Manager - Prevents screen sleep while sessions are running
 *
 * Uses Electron's powerSaveBlocker API to prevent the display from sleeping
 * when the "Keep screen awake" setting is enabled and at least one session
 * is actively processing.
 */

import { powerSaveBlocker } from 'electron'
import { mainLog } from './logger'

// Track the current power blocker ID (null when not blocking)
let powerBlockerId: number | null = null

// Track the number of active (processing) sessions
let activeSessionCount = 0

// Cache the setting value to avoid repeated config reads
let settingEnabled = false

/**
 * Initialize the power manager by loading the current setting.
 * Call this on app startup.
 */
export async function initPowerManager(): Promise<void> {
  const { getKeepAwakeWhileRunning } = await import('@craft-agent/shared/config/storage')
  settingEnabled = getKeepAwakeWhileRunning()
  mainLog.info('[power] Power manager initialized', { settingEnabled })
}

/**
 * Update the power state based on active sessions and setting.
 * Called when:
 * - A session starts or stops processing
 * - The setting is toggled
 */
function updatePowerState(): void {
  const shouldBlock = settingEnabled && activeSessionCount > 0

  if (shouldBlock && powerBlockerId === null) {
    // Start blocking display sleep
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')
    mainLog.info('[power] Started power save blocker', { blockerId: powerBlockerId, activeSessionCount })
  } else if (!shouldBlock && powerBlockerId !== null) {
    // Stop blocking
    powerSaveBlocker.stop(powerBlockerId)
    mainLog.info('[power] Stopped power save blocker', { blockerId: powerBlockerId })
    powerBlockerId = null
  }
}

/**
 * Called when a session starts processing.
 */
export function onSessionStarted(): void {
  activeSessionCount++
  mainLog.debug('[power] Session started processing', { activeSessionCount })
  updatePowerState()
}

/**
 * Called when a session stops processing (complete, error, or cancelled).
 */
export function onSessionStopped(): void {
  if (activeSessionCount > 0) {
    activeSessionCount--
  }
  mainLog.debug('[power] Session stopped processing', { activeSessionCount })
  updatePowerState()
}

/**
 * Update the keep awake setting.
 * Called from IPC handler when user toggles the setting.
 */
export function setKeepAwakeSetting(enabled: boolean): void {
  settingEnabled = enabled
  mainLog.info('[power] Keep awake setting changed', { enabled, activeSessionCount })
  updatePowerState()
}

/**
 * Get the current keep awake setting value.
 */
export function getKeepAwakeSetting(): boolean {
  return settingEnabled
}

/**
 * Check if power blocker is currently active.
 * Useful for debugging.
 */
export function isPowerBlockerActive(): boolean {
  return powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)
}

/**
 * Clean up power blocker on app quit.
 * Note: Electron automatically releases blockers on quit, but this is explicit.
 */
export function cleanup(): void {
  if (powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId)
    mainLog.info('[power] Cleaned up power save blocker on shutdown')
    powerBlockerId = null
  }
  activeSessionCount = 0
}
