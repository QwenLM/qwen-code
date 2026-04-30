/**
 * Settings Pages
 *
 * All pages that appear under the settings navigator.
 */

export { default as SettingsNavigator } from './SettingsNavigator'
export { default as AppSettingsPage, meta as AppSettingsMeta } from './AppSettingsPage'
export { default as AiSettingsPage, meta as AiSettingsMeta } from './AiSettingsPage'
export { default as AppearanceSettingsPage, meta as AppearanceMeta } from './AppearanceSettingsPage'
export { default as InputSettingsPage, meta as InputMeta } from './InputSettingsPage'
export { default as WorkspaceSettingsPage, meta as WorkspaceSettingsMeta } from './WorkspaceSettingsPage'
export { default as PermissionsSettingsPage, meta as PermissionsMeta } from './PermissionsSettingsPage'
export { default as LabelsSettingsPage, meta as LabelsMeta } from './LabelsSettingsPage'
export { default as ShortcutsPage, meta as ShortcutsMeta } from './ShortcutsPage'
export { default as PreferencesPage, meta as PreferencesMeta } from './PreferencesPage'

// Re-export types
export type { DetailsPageMeta } from '@/lib/navigation-registry'
