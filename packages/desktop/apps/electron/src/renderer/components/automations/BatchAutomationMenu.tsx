/**
 * BatchAutomationMenu - Context menu content for batch operations on multi-selected automations.
 *
 * Self-contained component that uses hooks to access selection state, automation metadata,
 * and mutation callbacks. Renders polymorphic menu items via useMenuComponents() so it
 * works in both DropdownMenu and ContextMenu scenarios.
 *
 * Mirrors the BatchSessionMenu pattern with automation-specific actions:
 * Enable/Disable All and Delete.
 */

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { Power, PowerOff, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useMenuComponents } from '@/components/ui/menu-context'
import { automationSelection } from '@/hooks/useEntitySelection'
import { automationsAtom } from '@/atoms/automations'
import { useAppShellContext } from '@/context/AppShellContext'

const {
  useSelection: useAutomationSelection,
  useSelectedIds: useAutomationSelectedIds,
} = automationSelection

export function BatchAutomationMenu() {
  const { t } = useTranslation()
  const { MenuItem, Separator } = useMenuComponents()

  const selectedIds = useAutomationSelectedIds()
  const { clearMultiSelect } = useAutomationSelection()
  const automations = useAtomValue(automationsAtom)

  const {
    activeWorkspaceId,
  } = useAppShellContext()

  // Resolve selected automations metadata
  const selectedAutomations = useMemo(() => {
    return [...selectedIds]
      .map(id => automations.find(a => a.id === id))
      .filter((a): a is NonNullable<typeof a> => a != null)
  }, [selectedIds, automations])

  // Check if all selected are enabled
  const allEnabled = useMemo(() => {
    return selectedAutomations.length > 0 && selectedAutomations.every(a => a.enabled)
  }, [selectedAutomations])

  // Batch toggle — sequential IPC to avoid read-modify-write race on automations.json
  const handleBatchToggle = useCallback(async () => {
    if (!activeWorkspaceId) return
    const targetEnabled = !allEnabled
    const count = selectedAutomations.length
    clearMultiSelect()
    for (const a of selectedAutomations) {
      await window.electronAPI.setAutomationEnabled(
        activeWorkspaceId,
        a.event,
        a.matcherIndex,
        targetEnabled,
      ).catch(() => {})
    }
    toast(targetEnabled
      ? t('automations.batchEnabled', { count })
      : t('automations.batchDisabled', { count })
    )
  }, [activeWorkspaceId, selectedAutomations, allEnabled, clearMultiSelect, t])

  // Batch delete — sequential IPC in reverse matcherIndex order so earlier indices stay valid
  const handleBatchDelete = useCallback(async () => {
    if (!activeWorkspaceId) return
    const count = selectedIds.size
    clearMultiSelect()
    const sorted = [...selectedAutomations].sort((a, b) => b.matcherIndex - a.matcherIndex)
    for (const a of sorted) {
      await window.electronAPI.deleteAutomation(
        activeWorkspaceId,
        a.event,
        a.matcherIndex,
      ).catch(() => {})
    }
    toast(t('automations.batchDeleted', { count }))
  }, [activeWorkspaceId, selectedIds.size, selectedAutomations, clearMultiSelect, t])

  const count = selectedIds.size

  return (
    <>
      {/* Header showing selection count */}
      <div className="px-2 py-1.5 text-xs text-muted-foreground font-medium">
        {t('automations.batchSelected', { count })}
      </div>
      <Separator />

      {/* Enable/Disable All */}
      <MenuItem onClick={handleBatchToggle}>
        {allEnabled ? (
          <PowerOff className="h-3.5 w-3.5" />
        ) : (
          <Power className="h-3.5 w-3.5" />
        )}
        <span className="flex-1">{allEnabled ? t('automations.menuDisableAll') : t('automations.menuEnableAll')}</span>
      </MenuItem>

      <Separator />

      {/* Delete */}
      {activeWorkspaceId && (
        <MenuItem onClick={handleBatchDelete} variant="destructive">
          <Trash2 className="h-3.5 w-3.5" />
          <span className="flex-1">{t('automations.menuDelete')}</span>
        </MenuItem>
      )}
    </>
  )
}
