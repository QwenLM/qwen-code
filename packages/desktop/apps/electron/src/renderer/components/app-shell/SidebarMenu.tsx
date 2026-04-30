/**
 * SidebarMenu - Shared menu content for sidebar navigation items
 *
 * Used by:
 * - LeftSidebar (context menu via right-click on nav items)
 * - AppShell (context menu for New Chat button)
 *
 * Uses MenuComponents context to render with either DropdownMenu or ContextMenu
 * primitives, allowing the same component to work in both scenarios.
 *
 * Provides actions based on the sidebar item type:
 * - "Configure Statuses" (for allSessions/status/flagged items) - triggers EditPopover callback
 * - "Add Source" (for sources) - triggers EditPopover callback
 * - "Add Skill" (for skills) - triggers EditPopover callback
 * - "Open in New Window" (for newSession only) - uses deep link
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import {
  AppWindow,
  CheckCheck,
  Settings2,
  Plus,
  Trash2,
  ExternalLink,
} from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'
import { getDocUrl, type DocFeature } from '@craft-agent/shared/docs/doc-links'

export type SidebarMenuType = 'allSessions' | 'flagged' | 'status' | 'sources' | 'skills' | 'automations' | 'labels' | 'views' | 'newSession'

export interface SidebarMenuProps {
  /** Type of sidebar item (determines available menu items) */
  type: SidebarMenuType
  /** Status ID for status items (e.g., 'todo', 'done') - not currently used but kept for future */
  statusId?: string
  /** Label ID — when set, this is an individual label item (enables Delete Label) */
  labelId?: string
  /** Handler for "Configure Statuses" action - only for allSessions/status/flagged types */
  onConfigureStatuses?: () => void
  /** Handler for "Mark All Read" action - only for allSessions type */
  onMarkAllRead?: () => void
  /** Handler for "Configure Labels" action - receives labelId when triggered from a specific label */
  onConfigureLabels?: (labelId?: string) => void
  /** Handler for "Add New Label" action - creates a label (parentId = labelId if set) */
  onAddLabel?: (parentId?: string) => void
  /** Handler for "Delete Label" action - deletes the label identified by labelId */
  onDeleteLabel?: (labelId: string) => void
  /** Handler for "Add Source" action - only for sources type */
  onAddSource?: () => void
  /** Handler for "Add Skill" action - only for skills type */
  onAddSkill?: () => void
  /** Handler for "Add Automation" action - only for automations type */
  onAddAutomation?: () => void
  /** Source type filter for "Learn More" link - determines which docs page to open */
  sourceType?: 'api' | 'mcp' | 'local'
  /** Handler for "Edit Views" action - for views type */
  onConfigureViews?: () => void
  /** View ID — when set, this is an individual view (enables Delete) */
  viewId?: string
  /** Handler for "Delete View" action */
  onDeleteView?: (id: string) => void
}

/**
 * SidebarMenu - Renders the menu items for sidebar navigation actions
 * This is the content only, not wrapped in a DropdownMenu or ContextMenu
 */
export function SidebarMenu({
  type,
  statusId,
  labelId,
  onConfigureStatuses,
  onMarkAllRead,
  onConfigureLabels,
  onAddLabel,
  onDeleteLabel,
  onAddSource,
  onAddSkill,
  onAddAutomation,
  sourceType,
  onConfigureViews,
  viewId,
  onDeleteView,
}: SidebarMenuProps) {
  const { t } = useTranslation()

  // Get menu components from context (works with both DropdownMenu and ContextMenu)
  const { MenuItem, Separator } = useMenuComponents()

  // New Session: only shows "Open in New Window"
  if (type === 'newSession') {
    return (
      <MenuItem onClick={() => window.electronAPI.openUrl('craftagents://action/new-session?window=focused')}>
        <AppWindow className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.openInNewWindow")}</span>
      </MenuItem>
    )
  }

  // All Sessions / Status / Flagged: show "Configure Statuses" (+ "Mark All Read" for allSessions)
  if ((type === 'allSessions' || type === 'status' || type === 'flagged') && onConfigureStatuses) {
    return (
      <>
        {type === 'allSessions' && onMarkAllRead && (
          <>
            <MenuItem onClick={onMarkAllRead}>
              <CheckCheck className="h-3.5 w-3.5" />
              <span className="flex-1">{t("sidebarMenu.markAllRead")}</span>
            </MenuItem>
            <Separator />
          </>
        )}
        <MenuItem onClick={onConfigureStatuses}>
          <Settings2 className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sidebarMenu.configureStatuses")}</span>
        </MenuItem>
      </>
    )
  }

  // Labels: show context-appropriate actions
  // - Header ("Labels" parent): Configure Labels + Add New Label
  // - Individual label items: Add New Label (as child) + Delete Label
  if (type === 'labels') {
    return (
      <>
        {onAddLabel && (
          <MenuItem onClick={() => onAddLabel(labelId)}>
            <Plus className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.addNewLabel")}</span>
          </MenuItem>
        )}
        {onConfigureLabels && (
          <MenuItem onClick={() => onConfigureLabels(labelId)}>
            <Settings2 className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.editLabels")}</span>
          </MenuItem>
        )}
        {labelId && onDeleteLabel && (
          <>
            <Separator />
            <MenuItem onClick={() => onDeleteLabel(labelId)}>
              <Trash2 className="h-3.5 w-3.5" />
              <span className="flex-1">{t("sidebarMenu.deleteLabel")}</span>
            </MenuItem>
          </>
        )}
      </>
    )
  }

  // Views: show "Edit Views" and optionally "Delete View"
  if (type === 'views') {
    return (
      <>
        {onConfigureViews && (
          <MenuItem onClick={onConfigureViews}>
            <Settings2 className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.editViews")}</span>
          </MenuItem>
        )}
        {viewId && onDeleteView && (
          <>
            <Separator />
            <MenuItem onClick={() => onDeleteView(viewId)}>
              <Trash2 className="h-3.5 w-3.5" />
              <span className="flex-1">{t("sidebarMenu.deleteView")}</span>
            </MenuItem>
          </>
        )}
      </>
    )
  }

  // Sources: show "Add Source" and "Learn More"
  if (type === 'sources') {
    // Determine which docs page to open based on source type filter
    const docFeature: DocFeature = sourceType
      ? `sources-${sourceType}` as DocFeature
      : 'sources'

    // Display label varies by source type
    const learnMoreLabel = sourceType === 'api'
      ? t('sidebarMenu.learnMoreApis')
      : sourceType === 'mcp'
        ? t('sidebarMenu.learnMoreMcp')
        : sourceType === 'local'
          ? t('sidebarMenu.learnMoreLocalFolders')
          : t('sidebarMenu.learnMoreSources')

    return (
      <>
        {onAddSource && (
          <MenuItem onClick={onAddSource}>
            <Plus className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.addSource")}</span>
          </MenuItem>
        )}
        <Separator />
        <MenuItem onClick={() => window.electronAPI.openUrl(getDocUrl(docFeature))}>
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="flex-1">{learnMoreLabel}</span>
        </MenuItem>
      </>
    )
  }

  // Skills: show "Add Skill"
  if (type === 'skills' && onAddSkill) {
    return (
      <MenuItem onClick={onAddSkill}>
        <Plus className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.addSkill")}</span>
      </MenuItem>
    )
  }

  // Automations: show "Add Automation" and "Learn More"
  if (type === 'automations') {
    return (
      <>
        {onAddAutomation && (
          <MenuItem onClick={onAddAutomation}>
            <Plus className="h-3.5 w-3.5" />
            <span className="flex-1">{t("sidebarMenu.addAutomation")}</span>
          </MenuItem>
        )}
        <Separator />
        <MenuItem onClick={() => window.electronAPI.openUrl(getDocUrl('automations'))}>
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sidebarMenu.learnMoreAutomations")}</span>
        </MenuItem>
      </>
    )
  }

  // Fallback: return null if no handler provided (shouldn't happen)
  return null
}
