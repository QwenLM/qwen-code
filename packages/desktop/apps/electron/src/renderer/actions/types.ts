export type ActionScope = 'global' | 'navigator' | 'chat' | 'sidebar'

export interface ActionDefinition {
  id: string
  label: string
  description?: string
  defaultHotkey: string | null  // null = no default hotkey
  category: string
  scope?: ActionScope           // Default: 'global'
  /** When-clause expression controlling when the action fires.
   *  Omit = fires everywhere (default). Examples:
   *  - '!inputFocus'              — only outside text inputs
   *  - 'chatFocus && !hasSelection' — chat zone, no text selected
   *  - 'navigatorFocus'           — only when navigator is focused
   *  @see evaluateWhen() in keybinding-context.ts */
  when?: string
}

export type ActionId = keyof typeof import('./definitions').actions

export interface ActionHandler {
  actionId: ActionId
  handler: () => void
  enabled?: () => boolean
}
