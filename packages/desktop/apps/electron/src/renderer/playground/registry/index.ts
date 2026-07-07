import type { ComponentEntry, CategoryGroup, Category } from './types'
import { chatComponents } from './chat'
import { turnCardComponents, fullscreenOverlayComponents } from './turn-card'
import { turnCardModesComponents } from './turn-card-modes'
import { messagesComponents } from './messages'
import { inputComponents } from './input'
import { slashCommandComponents } from './slash-command'
import { markdownComponents } from './markdown'
import { iconComponents } from './icons'
import { oauthComponents } from './oauth'
import { toastsComponents } from './toasts'
import { sessionListComponents } from './session-list'
import { editPopoverComponents } from './edit-popover'
import { automationComponents } from './automations'
import { entityListComponents } from './entity-lists'
import { browserUiComponents } from './browser-ui'
import { plannerComponents } from './planner'
import { customShadowsComponents } from './custom-shadows'
import { transportBannerComponents } from './transport-banner'
import { containerTransitionsComponents } from './container-transitions'
import { messagingComponents } from './messaging'

export * from './types'

export const componentRegistry: ComponentEntry[] = [
  ...chatComponents,
  ...turnCardComponents,
  ...turnCardModesComponents,
  ...fullscreenOverlayComponents,
  ...messagesComponents,
  ...inputComponents,
  ...toastsComponents,
  ...slashCommandComponents,
  ...markdownComponents,
  ...iconComponents,
  ...oauthComponents,
  ...sessionListComponents,
  ...editPopoverComponents,
  ...automationComponents,
  ...entityListComponents,
  ...browserUiComponents,
  ...plannerComponents,
  ...customShadowsComponents,
  ...transportBannerComponents,
  ...containerTransitionsComponents,
  ...messagingComponents,
]

export function getCategories(): CategoryGroup[] {
  const categoryOrder: Category[] = ['Automations', 'Onboarding', 'Agent Setup', 'Chat', 'Island', 'Browser', 'Planner', 'Custom Shadows', 'Session List', 'Entity Lists', 'Edit Popover', 'Turn Cards', 'TurnCard Modes', 'Fullscreen', 'Chat Messages', 'Chat Inputs', 'Toast Messages', 'Markdown', 'Icons', 'OAuth', 'Messaging']
  const categoryMap = new Map<Category, ComponentEntry[]>()

  for (const entry of componentRegistry) {
    const existing = categoryMap.get(entry.category) ?? []
    categoryMap.set(entry.category, [...existing, entry])
  }

  return categoryOrder
    .filter(name => categoryMap.has(name))
    .map(name => ({
      name,
      components: categoryMap.get(name)!,
    }))
}

export function getComponentById(id: string): ComponentEntry | undefined {
  return componentRegistry.find(c => c.id === id)
}
