/**
 * ShortcutsPage
 *
 * Displays keyboard shortcuts reference from the centralized action registry.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import { isMac } from '@/lib/platform'
import { actionsByCategory, useActionLabel, type ActionId } from '@/actions'

interface ShortcutItem {
  keys: string[]
  description: string
}

interface ShortcutSection {
  title: string
  shortcuts: ShortcutItem[]
}

// Component-specific shortcuts that aren't in the centralized registry
function useComponentSpecificSections(): ShortcutSection[] {
  const { t } = useTranslation()
  return [
    {
      title: t('shortcuts.listNavigation'),
      shortcuts: [
        { keys: ['↑', '↓'], description: t('shortcuts.navigateItems') },
        { keys: ['Home'], description: t('shortcuts.goToFirst') },
        { keys: ['End'], description: t('shortcuts.goToLast') },
      ],
    },
    {
      title: t('shortcuts.sessionList'),
      shortcuts: [
        { keys: ['Enter'], description: t('shortcuts.focusChatInput') },
        { keys: ['Right-click'], description: t('shortcuts.openContextMenu') },
        { keys: [isMac ? '⌥' : 'Alt', 'Click'], description: t('shortcuts.addFilterExcluded') },
      ],
    },
    {
      title: t('shortcuts.agentTree'),
      shortcuts: [
        { keys: ['←'], description: t('shortcuts.collapseFolder') },
        { keys: ['→'], description: t('shortcuts.expandFolder') },
      ],
    },
    {
      title: t('shortcuts.chatInput'),
      shortcuts: [
        { keys: ['Enter'], description: t('shortcuts.sendMessage') },
        { keys: ['Shift', 'Enter'], description: t('shortcuts.newLine') },
        { keys: ['Esc'], description: t('shortcuts.closeDialogBlur') },
      ],
    },
  ]
}

function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[11px] font-medium font-sans bg-muted border border-border rounded ${className || ''}`}>
      {children}
    </kbd>
  )
}

/**
 * Renders a shortcut row for an action from the registry
 */
function ActionShortcutRow({ actionId }: { actionId: ActionId }) {
  const { label, hotkey } = useActionLabel(actionId)

  if (!hotkey) return null

  // Split hotkey into individual keys for display
  // Mac: symbols are concatenated (⌘⇧N) - need smart splitting
  // Windows: separated by + (Ctrl+Shift+N) - split on +
  const keys = isMac
    ? hotkey.match(/[⌘⇧⌥←→]|Tab|Esc|./g) || []
    : hotkey.split('+')

  return (
    <div className="group flex items-center justify-between py-1.5">
      <span className="text-sm">{label}</span>
      <div className="flex-1 mx-3 h-px bg-[repeating-linear-gradient(90deg,currentColor_0_2px,transparent_2px_8px)] opacity-0 group-hover:opacity-15" />
      <div className="flex items-center gap-1">
        {keys.map((key, keyIndex) => (
          <Kbd key={keyIndex} className="group-hover:bg-foreground/10 group-hover:border-foreground/20">{key}</Kbd>
        ))}
      </div>
    </div>
  )
}

export default function ShortcutsPage() {
  const { t } = useTranslation()
  const componentSpecificSections = useComponentSpecificSections()

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("shortcuts.title")} actions={<HeaderMenu route={routes.view.settings('shortcuts')} />} />
      <Separator />
      <ScrollArea className="flex-1">
        <div className="px-5 py-4">
          <div className="space-y-6">
            {/* Registry-driven sections */}
            {Object.entries(actionsByCategory).map(([category, actions]) => (
              <div key={category}>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 pb-1.5 border-b border-border/50">
                  {category}
                </h3>
                <div className="space-y-0.5">
                  {actions.map(action => (
                    <ActionShortcutRow key={action.id} actionId={action.id as ActionId} />
                  ))}
                </div>
              </div>
            ))}

            {/* Component-specific sections */}
            {componentSpecificSections.map((section) => (
              <div key={section.title}>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 pb-1.5 border-b border-border/50">
                  {section.title}
                </h3>
                <div className="space-y-0.5">
                  {section.shortcuts.map((shortcut, index) => (
                    <div
                      key={index}
                      className="group flex items-center justify-between py-1.5"
                    >
                      <span className="text-sm">{shortcut.description}</span>
                      <div className="flex-1 mx-3 h-px bg-[repeating-linear-gradient(90deg,currentColor_0_2px,transparent_2px_8px)] opacity-0 group-hover:opacity-15" />
                      <div className="flex items-center gap-1">
                        {shortcut.keys.map((key, keyIndex) => (
                          <Kbd key={keyIndex} className="group-hover:bg-foreground/10 group-hover:border-foreground/20">{key}</Kbd>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
