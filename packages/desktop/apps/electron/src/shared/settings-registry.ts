/**
 * Settings Registry - Single Source of Truth
 *
 * This file defines all settings pages in one place. All other files that need
 * settings page information should import from here.
 *
 * To add a new settings page:
 * 1. Add an entry to SETTINGS_PAGES below
 * 2. Create the page component in renderer/pages/settings/
 * 3. Add to SETTINGS_PAGE_COMPONENTS in renderer/pages/settings/settings-pages.ts
 * 4. Add icon to SETTINGS_ICONS in renderer/components/icons/SettingsIcons.tsx
 *
 * That's it - types, routes, and validation are derived automatically.
 */

/**
 * Settings page definition
 */
export interface SettingsPageDefinition {
  /** Unique identifier used in routes and navigation */
  id: string
  /** i18n key for display label in settings navigator */
  labelKey: string
  /** i18n key for short description shown in settings navigator */
  descriptionKey: string
}

/**
 * The canonical list of all settings pages.
 * Order here determines display order in the settings navigator.
 *
 * ADD NEW PAGES HERE - everything else derives from this list.
 *
 * NOTE: labelKey/descriptionKey are i18n translation keys, resolved at render
 * time via t(). Do NOT call i18n.t() here — this module loads before i18n init.
 */
export const SETTINGS_PAGES = [
  { id: 'app' as const, labelKey: 'settings.app.title', descriptionKey: 'settings.app.description' },
  { id: 'ai' as const, labelKey: 'settings.ai.title', descriptionKey: 'settings.ai.description' },
  { id: 'appearance' as const, labelKey: 'settings.appearance.title', descriptionKey: 'settings.appearance.description' },
  { id: 'input' as const, labelKey: 'settings.input.title', descriptionKey: 'settings.input.description' },
  { id: 'workspace' as const, labelKey: 'settings.workspace.title', descriptionKey: 'settings.workspace.description' },
  { id: 'permissions' as const, labelKey: 'settings.permissions.title', descriptionKey: 'settings.permissions.description' },
  { id: 'labels' as const, labelKey: 'settings.labels.title', descriptionKey: 'settings.labels.description' },
  { id: 'messaging' as const, labelKey: 'settings.messaging.title', descriptionKey: 'settings.messaging.description' },
  { id: 'server' as const, labelKey: 'settings.server.title', descriptionKey: 'settings.server.description' },
  { id: 'shortcuts' as const, labelKey: 'settings.shortcuts.title', descriptionKey: 'settings.shortcuts.description' },
  { id: 'preferences' as const, labelKey: 'settings.preferences.title', descriptionKey: 'settings.preferences.description' },
] satisfies readonly SettingsPageDefinition[]

/**
 * Settings subpage type - derived from SETTINGS_PAGES
 * This replaces the manual union type in types.ts
 */
export type SettingsSubpage = (typeof SETTINGS_PAGES)[number]['id']

/**
 * Array of valid settings subpage IDs - for runtime validation
 */
export const VALID_SETTINGS_SUBPAGES: readonly SettingsSubpage[] = SETTINGS_PAGES.map(p => p.id)

/**
 * Type guard to check if a string is a valid settings subpage
 */
export function isValidSettingsSubpage(value: string): value is SettingsSubpage {
  return VALID_SETTINGS_SUBPAGES.includes(value as SettingsSubpage)
}

/**
 * Get settings page definition by ID
 */
export function getSettingsPage(id: SettingsSubpage): SettingsPageDefinition {
  const page = SETTINGS_PAGES.find(p => p.id === id)
  if (!page) throw new Error(`Unknown settings page: ${id}`)
  return page
}
