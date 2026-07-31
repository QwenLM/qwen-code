/**
 * ShikiDiffViewer - Electron wrapper for the portable ShikiDiffViewer
 *
 * Connects the base component to Electron's ThemeContext, passing the
 * app's Shiki theme (e.g. dracula, nord) so the diff viewer uses matching
 * syntax highlighting. Falls back to craft-dark/craft-light (transparent bg)
 * when no Shiki theme is configured.
 */

import * as React from 'react'
import { ShikiDiffViewer as BaseShikiDiffViewer, type ShikiDiffViewerProps as BaseProps } from '@craft-agent/ui'
import { useTheme } from '@/hooks/useTheme'

export interface ShikiDiffViewerProps extends Omit<BaseProps, 'theme' | 'shikiTheme'> {}

/**
 * ShikiDiffViewer - Shiki-based diff viewer component
 * Connected to Electron's theme context. Passes the app's Shiki theme
 * so the diff viewer uses the matching syntax theme (e.g. dracula, nord).
 */
export function ShikiDiffViewer(props: ShikiDiffViewerProps) {
  const { isDark, shikiTheme } = useTheme()

  return <BaseShikiDiffViewer {...props} theme={isDark ? 'dark' : 'light'} shikiTheme={shikiTheme} />
}
