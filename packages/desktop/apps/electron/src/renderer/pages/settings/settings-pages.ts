/**
 * Settings Page Components Registry
 *
 * Maps settings subpage IDs to their React components.
 * TypeScript enforces that all pages defined in settings-registry have a component here.
 *
 * To add a new settings page:
 * 1. Add to SETTINGS_PAGES in shared/settings-registry.ts
 * 2. Create the page component (e.g., NewSettingsPage.tsx)
 * 3. Add to SETTINGS_PAGE_COMPONENTS below
 * 4. Add icon to SETTINGS_ICONS in components/icons/SettingsIcons.tsx
 */

import type { ComponentType } from 'react';
import type { SettingsSubpage } from '../../../shared/settings-registry';
import { FEATURE_FLAGS } from '@craft-agent/shared/feature-flags';

import AppSettingsPage from './AppSettingsPage';
import AiSettingsPage from './AiSettingsPage';
import GeneralSettingsPage from './GeneralSettingsPage';
import McpServersSettingsPage from './McpServersSettingsPage';
import HooksSettingsPage from './HooksSettingsPage';
import ExtensionsSettingsPage from './ExtensionsSettingsPage';
import MemorySettingsPage from './MemorySettingsPage';
import AppearanceSettingsPage from './AppearanceSettingsPage';
import InputSettingsPage from './InputSettingsPage';
import WorkspaceSettingsPage from './WorkspaceSettingsPage';
import PermissionsSettingsPage from './PermissionsSettingsPage';
import LabelsSettingsPage from './LabelsSettingsPage';
import MessagingSettingsPage from './MessagingSettingsPage';
import ServerSettingsPage from './ServerSettingsPage';
import ShortcutsPage from './ShortcutsPage';
import PreferencesPage from './PreferencesPage';

/**
 * Map of settings subpage IDs to their page components.
 * TypeScript will error if a page from SETTINGS_PAGES is missing here.
 */
export const SETTINGS_PAGE_COMPONENTS: Record<SettingsSubpage, ComponentType> =
  {
    app: AppSettingsPage,
    ai: AiSettingsPage,
    general: GeneralSettingsPage,
    mcpServers: McpServersSettingsPage,
    hooks: HooksSettingsPage,
    extensions: ExtensionsSettingsPage,
    memory: MemorySettingsPage,
    appearance: AppearanceSettingsPage,
    input: InputSettingsPage,
    workspace: WorkspaceSettingsPage,
    permissions: PermissionsSettingsPage,
    labels: LabelsSettingsPage,
    messaging: MessagingSettingsPage,
    server: ServerSettingsPage,
    shortcuts: ShortcutsPage,
    preferences: PreferencesPage,
  };

/**
 * Get the component for a settings subpage
 */
export function getSettingsPageComponent(
  subpage: SettingsSubpage,
): ComponentType {
  if (subpage === 'labels' && !FEATURE_FLAGS.sessionLabelsUi) {
    return GeneralSettingsPage;
  }
  return SETTINGS_PAGE_COMPONENTS[subpage];
}
