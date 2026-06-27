/**
 * ShikiCodeViewer - Electron wrapper for the portable ShikiCodeViewer
 *
 * This thin wrapper imports the portable component from @craft-agent/ui
 * and connects it to Electron's ThemeContext and preset themes.
 */

import * as React from 'react'
import { ShikiCodeViewer as BaseShikiCodeViewer, type ShikiCodeViewerProps as BaseProps } from '@craft-agent/ui'
import { useTheme } from '@/hooks/useTheme'

export interface ShikiCodeViewerProps extends Omit<BaseProps, 'theme' | 'shikiTheme'> {}

/**
 * ShikiCodeViewer - Syntax highlighted code viewer with line numbers
 * Connected to Electron's theme context and preset themes.
 */
export function ShikiCodeViewer(props: ShikiCodeViewerProps) {
  const { isDark, shikiTheme } = useTheme()

  return <BaseShikiCodeViewer {...props} theme={isDark ? 'dark' : 'light'} shikiTheme={shikiTheme} />
}
