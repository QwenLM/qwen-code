import { useMemo } from 'react'
import {
  resolveTheme,
  DEFAULT_THEME,
  type ThemeOverrides,
  type ThemeFile,
  type ShikiThemeConfig,
} from '@config/theme'
import { useTheme as useThemeContext } from '@/context/ThemeContext'

interface UseThemeOptions {
  /**
   * App-level theme override (from ~/.craft-agent/theme.json)
   * When provided, merges with the preset theme from context.
   */
  appTheme?: ThemeOverrides | null
}

interface UseThemeResult {
  theme: ThemeOverrides
  defaultTheme: ThemeOverrides
  shikiTheme: string
  shikiConfig: ShikiThemeConfig
  presetTheme: ThemeFile | null
  isDark: boolean
  /** Whether the theme is in scenic mode (background image with glass panels) */
  isScenic: boolean
}

/**
 * Hook to access theme state from ThemeContext.
 *
 * Theme loading and DOM manipulation happen in ThemeProvider (singleton).
 * This hook just reads the already-resolved values - no async loading,
 * no per-component effects.
 *
 * Optionally accepts appTheme to merge with preset (for app-level overrides).
 *
 * @example
 * ```tsx
 * // Simple usage - just read theme state
 * const { isDark, shikiTheme } = useTheme()
 *
 * // With app-level override
 * const [appTheme] = useAtom(appThemeAtom)
 * const { theme } = useTheme({ appTheme })
 * ```
 */
export function useTheme({ appTheme }: UseThemeOptions = {}): UseThemeResult {
  const context = useThemeContext()

  // If appTheme provided, merge with preset for app-level overrides
  // Otherwise just use the resolved theme from context
  const theme = useMemo(() => {
    if (appTheme && context.presetTheme) {
      // Merge: preset + appTheme
      return resolveTheme({ ...context.presetTheme, ...appTheme })
    }
    if (appTheme) {
      // No preset, just appTheme
      return resolveTheme(appTheme)
    }
    // Use context's resolved theme directly
    return context.resolvedTheme
  }, [context.presetTheme, context.resolvedTheme, appTheme])

  return {
    theme,
    defaultTheme: DEFAULT_THEME,
    shikiTheme: context.shikiTheme,
    shikiConfig: context.shikiConfig,
    presetTheme: context.presetTheme,
    isDark: context.isDark,
    isScenic: context.isScenic,
  }
}
