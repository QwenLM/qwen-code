/**
 * useWorkspaceIcon Hook
 *
 * Fetches workspace icons as data URLs for rendering in img tags.
 * Handles file:// to data URL conversion via IPC since Electron's CSP
 * blocks direct file:// URLs in the renderer.
 *
 * Used by settings pages that display workspace icons.
 */

import { useState, useEffect, useRef } from 'react'
import type { Workspace } from '../../shared/types'

// Module-level cache to avoid redundant fetches across component instances
// Key: workspaceId, Value: { dataUrl, sourceUrl }
const iconCache = new Map<string, { dataUrl: string; sourceUrl: string }>()

/**
 * Hook to get a workspace icon as a renderable URL.
 *
 * - Remote URLs (http/https) are returned directly
 * - Local file:// URLs are converted to data URLs via IPC
 * - Returns undefined while loading or if no icon exists
 *
 * @param workspace - The workspace object with iconUrl
 * @returns Data URL or remote URL for the icon, or undefined
 */
export function useWorkspaceIcon(workspace: Workspace | undefined): string | undefined {
  const [iconUrl, setIconUrl] = useState<string | undefined>(() => {
    if (!workspace?.iconUrl) return undefined

    // Remote URLs can be used directly
    if (workspace.iconUrl.startsWith('http://') || workspace.iconUrl.startsWith('https://')) {
      return workspace.iconUrl
    }

    // Check cache for file:// URLs
    const cached = iconCache.get(workspace.id)
    if (cached && cached.sourceUrl === workspace.iconUrl) {
      return cached.dataUrl
    }

    return undefined
  })

  // Track the workspace to detect changes
  const workspaceRef = useRef(workspace)

  useEffect(() => {
    if (!workspace?.iconUrl) {
      setIconUrl(undefined)
      return
    }

    // Remote URLs - use directly
    if (workspace.iconUrl.startsWith('http://') || workspace.iconUrl.startsWith('https://')) {
      setIconUrl(workspace.iconUrl)
      return
    }

    // Not a file:// URL - skip
    if (!workspace.iconUrl.startsWith('file://')) {
      setIconUrl(undefined)
      return
    }

    // Check if already cached with same source URL
    const cached = iconCache.get(workspace.id)
    if (cached && cached.sourceUrl === workspace.iconUrl) {
      setIconUrl(cached.dataUrl)
      return
    }

    // Extract icon filename from file:// URL
    // e.g., "file:///path/to/icon.png?t=123" -> "icon.png"
    const urlWithoutQuery = workspace.iconUrl.split('?')[0]
    const iconFilename = urlWithoutQuery.split('/').pop()
    if (!iconFilename) {
      setIconUrl(undefined)
      return
    }

    // Fetch via IPC and convert to data URL
    let cancelled = false

    async function fetchIcon() {
      try {
        const result = await window.electronAPI.readWorkspaceImage(workspace!.id, iconFilename!)
        if (cancelled) return

        if (result) {
          // readWorkspaceImage returns raw SVG for .svg files, data URL for others
          let dataUrl = result
          if (iconFilename!.endsWith('.svg')) {
            dataUrl = `data:image/svg+xml;base64,${btoa(result)}`
          }

          // Cache the result
          iconCache.set(workspace!.id, { dataUrl, sourceUrl: workspace!.iconUrl! })
          setIconUrl(dataUrl)
        } else {
          setIconUrl(undefined)
        }
      } catch (error) {
        console.error(`Failed to load icon for workspace ${workspace!.id}:`, error)
        if (!cancelled) {
          setIconUrl(undefined)
        }
      }
    }

    fetchIcon()

    return () => {
      cancelled = true
    }
  }, [workspace?.id, workspace?.iconUrl])

  return iconUrl
}

/**
 * Hook to get icons for multiple workspaces at once.
 * More efficient than calling useWorkspaceIcon for each workspace.
 *
 * @param workspaces - Array of workspace objects
 * @returns Map of workspaceId -> icon URL (data URL or remote URL)
 */
export function useWorkspaceIcons(workspaces: Workspace[]): Map<string, string> {
  const [iconMap, setIconMap] = useState<Map<string, string>>(() => {
    const map = new Map<string, string>()
    for (const ws of workspaces) {
      if (!ws.iconUrl) continue

      // Remote URLs
      if (ws.iconUrl.startsWith('http://') || ws.iconUrl.startsWith('https://')) {
        map.set(ws.id, ws.iconUrl)
        continue
      }

      // Cached file:// URLs
      const cached = iconCache.get(ws.id)
      if (cached && cached.sourceUrl === ws.iconUrl) {
        map.set(ws.id, cached.dataUrl)
      }
    }
    return map
  })

  useEffect(() => {
    let cancelled = false

    async function fetchIcons() {
      const newMap = new Map<string, string>()

      for (const workspace of workspaces) {
        if (!workspace.iconUrl) continue

        // Remote URLs - use directly
        if (workspace.iconUrl.startsWith('http://') || workspace.iconUrl.startsWith('https://')) {
          newMap.set(workspace.id, workspace.iconUrl)
          continue
        }

        // Not a file:// URL - skip
        if (!workspace.iconUrl.startsWith('file://')) continue

        // Check cache first
        const cached = iconCache.get(workspace.id)
        if (cached && cached.sourceUrl === workspace.iconUrl) {
          newMap.set(workspace.id, cached.dataUrl)
          continue
        }

        // Extract icon filename
        const urlWithoutQuery = workspace.iconUrl.split('?')[0]
        const iconFilename = urlWithoutQuery.split('/').pop()
        if (!iconFilename) continue

        try {
          const result = await window.electronAPI.readWorkspaceImage(workspace.id, iconFilename)
          if (cancelled) return

          if (result) {
            let dataUrl = result
            if (iconFilename.endsWith('.svg')) {
              dataUrl = `data:image/svg+xml;base64,${btoa(result)}`
            }

            iconCache.set(workspace.id, { dataUrl, sourceUrl: workspace.iconUrl })
            newMap.set(workspace.id, dataUrl)
          }
        } catch (error) {
          console.error(`Failed to load icon for workspace ${workspace.id}:`, error)
        }
      }

      if (!cancelled) {
        setIconMap(newMap)
      }
    }

    fetchIcons()

    return () => {
      cancelled = true
    }
  }, [workspaces])

  return iconMap
}
