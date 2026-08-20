/**
 * MenuComponents Context
 *
 * Provides menu primitives (MenuItem, Separator, Sub, SubTrigger, SubContent)
 * that work with both DropdownMenu and ContextMenu.
 *
 * This allows menu content components (SessionMenu, SourceMenu, SkillMenu) to
 * render identically in both dropdown and context menu scenarios without duplication.
 *
 * Usage:
 * - Wrap dropdown menu content with <DropdownMenuProvider>
 * - Wrap context menu content with <ContextMenuProvider>
 * - Use useMenuComponents() in menu content to get the right primitives
 */

import * as React from 'react'
import {
  DropdownMenuSub,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from './styled-dropdown'
import {
  StyledContextMenuSub,
  StyledContextMenuItem,
  StyledContextMenuSeparator,
  StyledContextMenuSubTrigger,
  StyledContextMenuSubContent,
} from './styled-context-menu'

/**
 * Menu component types that can be provided via context.
 * These are the styled variants that match our design system.
 */
export interface MenuComponents {
  MenuItem: typeof StyledDropdownMenuItem | typeof StyledContextMenuItem
  Separator: typeof StyledDropdownMenuSeparator | typeof StyledContextMenuSeparator
  Sub: typeof DropdownMenuSub | typeof StyledContextMenuSub
  SubTrigger: typeof StyledDropdownMenuSubTrigger | typeof StyledContextMenuSubTrigger
  SubContent: typeof StyledDropdownMenuSubContent | typeof StyledContextMenuSubContent
}

// Context with dropdown components as default (for backwards compatibility)
const MenuComponentsContext = React.createContext<MenuComponents>({
  MenuItem: StyledDropdownMenuItem,
  Separator: StyledDropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: StyledDropdownMenuSubTrigger,
  SubContent: StyledDropdownMenuSubContent,
})

/**
 * Hook to get menu components from context.
 * Returns styled dropdown components by default if no provider is present.
 */
export function useMenuComponents(): MenuComponents {
  return React.useContext(MenuComponentsContext)
}

// Dropdown menu components (default)
const dropdownComponents: MenuComponents = {
  MenuItem: StyledDropdownMenuItem,
  Separator: StyledDropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: StyledDropdownMenuSubTrigger,
  SubContent: StyledDropdownMenuSubContent,
}

// Context menu components
const contextMenuComponents: MenuComponents = {
  MenuItem: StyledContextMenuItem,
  Separator: StyledContextMenuSeparator,
  Sub: StyledContextMenuSub,
  SubTrigger: StyledContextMenuSubTrigger,
  SubContent: StyledContextMenuSubContent,
}

/**
 * Provider for dropdown menu context.
 * Wrap dropdown menu content with this to use dropdown primitives.
 */
export function DropdownMenuProvider({ children }: { children: React.ReactNode }) {
  return (
    <MenuComponentsContext.Provider value={dropdownComponents}>
      {children}
    </MenuComponentsContext.Provider>
  )
}

/**
 * Provider for context menu.
 * Wrap context menu content with this to use context menu primitives.
 */
export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  return (
    <MenuComponentsContext.Provider value={contextMenuComponents}>
      {children}
    </MenuComponentsContext.Provider>
  )
}
