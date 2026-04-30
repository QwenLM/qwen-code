/**
 * Notifications Hook
 *
 * Handles native OS notifications and badge Canvas rendering.
 * - Tracks window focus state
 * - Shows notifications for new messages when window is unfocused
 * - Renders badge icons via Canvas API (main process drives badge count directly)
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { Session } from '../../shared/types'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'

/**
 * Draw a badge onto an icon image using Canvas
 * Returns a data URL of the image with badge overlay
 */
function drawBadgeOnIcon(iconDataUrl: string, count: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      // Create canvas at icon size
      const canvas = document.createElement('canvas')
      const size = Math.max(img.width, img.height, 256) // Ensure at least 256px for quality
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Could not get canvas context'))
        return
      }

      // Draw the base icon centered
      const offsetX = (size - img.width) / 2
      const offsetY = (size - img.height) / 2
      ctx.drawImage(img, offsetX, offsetY, img.width, img.height)

      // Badge parameters
      const badgeRadius = size * 0.19  // Badge size relative to icon (increased for 22px on screen)
      // Position: 8px up and 8px to the right (relative to icon size)
      const offsetPx = (8 / 256) * size  // 8px at 256px icon size
      const badgeX = size - badgeRadius - (size * 0.05) + offsetPx  // Moved right
      const badgeY = badgeRadius + (size * 0.05) - offsetPx  // Moved up
      const text = count > 99 ? '99+' : count.toString()

      // Draw red badge circle with larger shadow (50% more blur)
      ctx.shadowColor = 'rgba(0, 0, 0, 0.4)'
      ctx.shadowBlur = size * 0.06
      ctx.shadowOffsetY = size * 0.015

      ctx.beginPath()
      ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2)
      ctx.fillStyle = '#FF3B30'  // iOS/macOS red
      ctx.fill()

      // Reset shadow for text
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetY = 0

      // Draw white text (regular weight)
      const fontSize = count > 99 ? badgeRadius * 0.65 : badgeRadius * 0.95
      ctx.font = `400 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`
      ctx.fillStyle = '#FFFFFF'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, badgeX, badgeY)

      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('Failed to load icon image'))
    img.src = iconDataUrl
  })
}

/**
 * Draw Windows taskbar overlay badge icon (transparent background + red circle)
 */
function drawWindowsBadgeOverlay(count: number): string {
  const canvas = document.createElement('canvas')
  const size = 32
  canvas.width = size
  canvas.height = size

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Could not get canvas context')
  }

  const text = count > 99 ? '99+' : count.toString()
  const badgeRadius = size * 0.46
  const badgeX = size / 2
  const badgeY = size / 2

  // Subtle shadow so overlay reads better on varied taskbar colors
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'
  ctx.shadowBlur = 3
  ctx.shadowOffsetY = 1

  ctx.beginPath()
  ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2)
  ctx.fillStyle = '#FF3B30'
  ctx.fill()

  // Reset shadow for text
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0

  const fontSize = count > 99 ? size * 0.34 : size * 0.48
  ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  ctx.fillStyle = '#FFFFFF'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, badgeX, badgeY)

  return canvas.toDataURL('image/png')
}

interface UseNotificationsOptions {
  /** Current workspace ID */
  workspaceId: string | null
  /** Callback to navigate to a session when notification is clicked */
  onNavigateToSession?: (sessionId: string) => void
  /** Whether notifications are enabled (from app settings) */
  enabled?: boolean
}

interface UseNotificationsResult {
  /** Whether the window is currently focused */
  isWindowFocused: boolean
  /** Show a notification for a session */
  showSessionNotification: (session: Session, messagePreview?: string) => void
}

export function useNotifications({
  workspaceId,
  onNavigateToSession,
  enabled = true,
}: UseNotificationsOptions): UseNotificationsResult {
  const [isWindowFocused, setIsWindowFocused] = useState(true)
  const onNavigateToSessionRef = useRef(onNavigateToSession)

  // Check once whether this server has GUI notification channels (headless servers don't)
  const hasGuiChannels = useMemo(
    () => window.electronAPI.isChannelAvailable(RPC_CHANNELS.notification.SHOW),
    [],
  )

  // Keep ref updated
  useEffect(() => {
    onNavigateToSessionRef.current = onNavigateToSession
  }, [onNavigateToSession])

  // Subscribe to window focus changes
  useEffect(() => {
    if (!hasGuiChannels) return

    // Get initial focus state
    window.electronAPI.getWindowFocusState().then(setIsWindowFocused)

    // Subscribe to focus changes
    const cleanup = window.electronAPI.onWindowFocusChange((isFocused) => {
      setIsWindowFocused(isFocused)
    })

    return cleanup
  }, [hasGuiChannels])

  // Subscribe to notification navigation (when user clicks a notification)
  useEffect(() => {
    if (!hasGuiChannels) return

    const cleanup = window.electronAPI.onNotificationNavigate((data) => {
      onNavigateToSessionRef.current?.(data.sessionId)
    })

    return cleanup
  }, [hasGuiChannels])

  // Subscribe to badge draw requests from main process
  // This uses Canvas API (only available in renderer) to draw badge on icon
  useEffect(() => {
    if (!hasGuiChannels) return

    const cleanup = window.electronAPI.onBadgeDraw(async (data) => {
      try {
        const badgedIconDataUrl = await drawBadgeOnIcon(data.iconDataUrl, data.count)
        await window.electronAPI.setDockIconWithBadge(badgedIconDataUrl)
      } catch (error) {
        console.error('[Notifications] Failed to draw badge:', error)
      }
    })

    // Now that the Canvas listener is subscribed, request initial badge from main
    void window.electronAPI.refreshBadge()

    return cleanup
  }, [hasGuiChannels])

  // Subscribe to Windows taskbar overlay draw requests from main process
  useEffect(() => {
    if (!hasGuiChannels) return

    const cleanup = window.electronAPI.onBadgeDrawWindows(async (data) => {
      try {
        const overlayDataUrl = drawWindowsBadgeOverlay(data.count)
        await window.electronAPI.setDockIconWithBadge(overlayDataUrl)
      } catch (error) {
        console.error('[Notifications] Failed to draw Windows badge overlay:', error)
      }
    })

    return cleanup
  }, [hasGuiChannels])

  // Show notification for a session
  const showSessionNotification = useCallback((session: Session, messagePreview?: string) => {
    // Don't show notification if disabled in settings
    if (!enabled) return
    // Don't show notification if window is focused
    if (isWindowFocused) return
    // Don't show if no workspace
    if (!workspaceId) return
    // Don't show if server doesn't have GUI notification handlers
    if (!hasGuiChannels) return

    // Get session title for notification
    const title = session.name || 'New message'

    // Get message preview (truncate if needed)
    let body = messagePreview || 'Craft Agent has a new message for you'
    if (body.length > 100) {
      body = body.substring(0, 97) + '...'
    }

    window.electronAPI.showNotification(title, body, workspaceId, session.id)
  }, [enabled, isWindowFocused, workspaceId, hasGuiChannels])

  return {
    isWindowFocused,
    showSessionNotification,
  }
}
