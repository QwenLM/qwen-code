import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { isMac } from "@/lib/platform"
import { useActionLabel } from "@/actions"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuShortcut,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from "@/components/ui/styled-dropdown"
import * as Icons from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@craft-agent/ui"
import { CraftAgentsSymbol } from "./icons/CraftAgentsSymbol"
import { SquarePenRounded } from "./icons/SquarePenRounded"
import { TopBarButton } from "./ui/TopBarButton"
import {
  EDIT_MENU,
  VIEW_MENU,
  WINDOW_MENU,
  SETTINGS_ITEMS,
  getShortcutDisplay,
} from "../../shared/menu-schema"
import type { MenuItem, MenuSection, SettingsMenuItem } from "../../shared/menu-schema"
import { SETTINGS_ICONS } from "./icons/SettingsIcons"
import { getDocUrl } from '@craft-agent/shared/docs/doc-links'

// Map of action handlers for menu items that need custom behavior
type MenuActionHandlers = {
  toggleFocusMode?: () => void
  toggleSidebar?: () => void
}

// Map of IPC handlers for role-based menu items
const roleHandlers: Record<string, () => void> = {
  undo: () => window.electronAPI.menuUndo(),
  redo: () => window.electronAPI.menuRedo(),
  cut: () => window.electronAPI.menuCut(),
  copy: () => window.electronAPI.menuCopy(),
  paste: () => window.electronAPI.menuPaste(),
  selectAll: () => window.electronAPI.menuSelectAll(),
  zoomIn: () => window.electronAPI.menuZoomIn(),
  zoomOut: () => window.electronAPI.menuZoomOut(),
  resetZoom: () => window.electronAPI.menuZoomReset(),
  minimize: () => window.electronAPI.menuMinimize(),
  zoom: () => window.electronAPI.menuMaximize(),
}

/**
 * Get the Lucide icon component by name
 */
function getIcon(name: string): React.ComponentType<{ className?: string }> | null {
  const IconComponent = Icons[name as keyof typeof Icons] as React.ComponentType<{ className?: string }> | undefined
  return IconComponent ?? null
}

/**
 * Renders a single menu item from the schema
 */
function renderMenuItem(
  item: MenuItem,
  index: number,
  actionHandlers: MenuActionHandlers,
  t: (key: string) => string,
): React.ReactNode {
  if (item.type === 'separator') {
    return <StyledDropdownMenuSeparator key={`sep-${index}`} />
  }

  const Icon = getIcon(item.icon)
  const shortcut = getShortcutDisplay(item, isMac)

  if (item.type === 'role') {
    const handler = roleHandlers[item.role]
    // Gracefully handle missing role handlers with console warning
    const safeHandler = handler ?? (() => {
      console.warn(`[AppMenu] No handler registered for role: ${item.role}`)
    })
    return (
      <StyledDropdownMenuItem key={item.role} onClick={safeHandler}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(item.labelKey)}
        {shortcut && <DropdownMenuShortcut className="pl-6">{shortcut}</DropdownMenuShortcut>}
      </StyledDropdownMenuItem>
    )
  }

  if (item.type === 'action') {
    // Map action IDs to handlers
    const handler = item.id === 'toggleFocusMode'
      ? actionHandlers.toggleFocusMode
      : item.id === 'toggleSidebar'
        ? actionHandlers.toggleSidebar
        : undefined
    return (
      <StyledDropdownMenuItem key={item.id} onClick={handler}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(item.labelKey)}
        {shortcut && <DropdownMenuShortcut className="pl-6">{shortcut}</DropdownMenuShortcut>}
      </StyledDropdownMenuItem>
    )
  }

  return null
}

/**
 * Renders a menu section as a submenu
 */
function renderMenuSection(
  section: MenuSection,
  actionHandlers: MenuActionHandlers,
  t: (key: string) => string,
): React.ReactNode {
  const Icon = getIcon(section.icon)
  return (
    <DropdownMenuSub key={section.id}>
      <StyledDropdownMenuSubTrigger>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(section.labelKey)}
      </StyledDropdownMenuSubTrigger>
      <StyledDropdownMenuSubContent>
        {section.items.map((item, index) => renderMenuItem(item, index, actionHandlers, t))}
      </StyledDropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

interface AppMenuProps {
  onNewChat: () => void
  onNewWindow?: () => void
  onOpenSettings: () => void
  /** Navigate to a specific settings subpage */
  onOpenSettingsSubpage: (subpage: SettingsMenuItem['id']) => void
  onOpenKeyboardShortcuts: () => void
  onOpenStoredUserPreferences: () => void
  onBack?: () => void
  onForward?: () => void
  canGoBack?: boolean
  canGoForward?: boolean
  onToggleSidebar?: () => void
  onToggleFocusMode?: () => void
}

/**
 * AppMenu - Main application dropdown menu and top bar navigation
 *
 * Contains the Craft logo dropdown with all menu functionality:
 * - File actions (New Chat, New Window)
 * - Edit submenu (Undo, Redo, Cut, Copy, Paste, Select All)
 * - View submenu (Zoom In/Out, Reset)
 * - Window submenu (Minimize, Maximize)
 * - Settings submenu (Settings, Stored User Preferences)
 * - Help submenu (Documentation, Keyboard Shortcuts)
 * - Debug submenu (dev only)
 * - Quit
 *
 * On Windows/Linux, this is the only menu (native menu is hidden).
 * On macOS, this mirrors the native menu for consistency.
 */
export function AppMenu({
  onNewChat,
  onNewWindow,
  onOpenSettings,
  onOpenSettingsSubpage,
  onOpenKeyboardShortcuts,
  onOpenStoredUserPreferences,
  onBack,
  onForward,
  canGoBack = true,
  canGoForward = true,
  onToggleSidebar,
  onToggleFocusMode,
}: AppMenuProps) {
  const { t } = useTranslation()
  const [isDebugMode, setIsDebugMode] = useState(false)

  // Get hotkey labels from centralized action registry
  const newChatHotkey = useActionLabel('app.newChat').hotkey
  const newWindowHotkey = useActionLabel('app.newWindow').hotkey
  const settingsHotkey = useActionLabel('app.settings').hotkey
  const keyboardShortcutsHotkey = useActionLabel('app.keyboardShortcuts').hotkey
  const quitHotkey = useActionLabel('app.quit').hotkey
  const goBackHotkey = useActionLabel('nav.goBackAlt').hotkey
  const goForwardHotkey = useActionLabel('nav.goForwardAlt').hotkey

  useEffect(() => {
    window.electronAPI.isDebugMode().then(setIsDebugMode)
  }, [])

  // Action handlers for schema-driven menu items
  const actionHandlers: MenuActionHandlers = {
    toggleFocusMode: onToggleFocusMode,
    toggleSidebar: onToggleSidebar,
  }

  return (
    <div className="flex items-center gap-[5px] w-full">
      {/* Craft Logo Menu - interactive island */}
      <div className="pointer-events-auto titlebar-no-drag">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <TopBarButton aria-label="Craft menu">
            <CraftAgentsSymbol className="h-4 text-accent" />
          </TopBarButton>
        </DropdownMenuTrigger>
        <StyledDropdownMenuContent align="start" minWidth="min-w-48">
          {/* File actions at root level */}
          <StyledDropdownMenuItem onClick={onNewChat}>
            <SquarePenRounded className="h-3.5 w-3.5" />
            New Chat
            {newChatHotkey && <DropdownMenuShortcut className="pl-6">{newChatHotkey}</DropdownMenuShortcut>}
          </StyledDropdownMenuItem>
          {onNewWindow && (
            <StyledDropdownMenuItem onClick={onNewWindow}>
              <Icons.AppWindow className="h-3.5 w-3.5" />
              New Window
              {newWindowHotkey && <DropdownMenuShortcut className="pl-6">{newWindowHotkey}</DropdownMenuShortcut>}
            </StyledDropdownMenuItem>
          )}

          <StyledDropdownMenuSeparator />

          {/* Edit, View, Window submenus from shared schema */}
          {renderMenuSection(EDIT_MENU, actionHandlers, t)}
          {renderMenuSection(VIEW_MENU, actionHandlers, t)}
          {renderMenuSection(WINDOW_MENU, actionHandlers, t)}

          <StyledDropdownMenuSeparator />

          {/* Settings submenu - items from shared schema */}
          <DropdownMenuSub>
            <StyledDropdownMenuSubTrigger>
              <Icons.Settings className="h-3.5 w-3.5" />
              Settings
            </StyledDropdownMenuSubTrigger>
            <StyledDropdownMenuSubContent>
              {/* Main settings entry with keyboard shortcut */}
              <StyledDropdownMenuItem onClick={onOpenSettings}>
                <Icons.Settings className="h-3.5 w-3.5" />
                Settings...
                {settingsHotkey && <DropdownMenuShortcut className="pl-6">{settingsHotkey}</DropdownMenuShortcut>}
              </StyledDropdownMenuItem>
              <StyledDropdownMenuSeparator />
              {/* All settings subpages from shared schema */}
              {SETTINGS_ITEMS.map((item) => {
                const Icon = SETTINGS_ICONS[item.id]
                return (
                  <StyledDropdownMenuItem
                    key={item.id}
                    onClick={() => onOpenSettingsSubpage(item.id)}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {t(item.labelKey)}
                  </StyledDropdownMenuItem>
                )
              })}
            </StyledDropdownMenuSubContent>
          </DropdownMenuSub>

          {/* Help submenu */}
          <DropdownMenuSub>
            <StyledDropdownMenuSubTrigger>
              <Icons.HelpCircle className="h-3.5 w-3.5" />
              Help
            </StyledDropdownMenuSubTrigger>
            <StyledDropdownMenuSubContent>
              <StyledDropdownMenuItem onClick={() => window.electronAPI.openUrl('https://agents.craft.do/docs')}>
                <Icons.HelpCircle className="h-3.5 w-3.5" />
                Help & Documentation
                <Icons.ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />
              </StyledDropdownMenuItem>
              <StyledDropdownMenuItem onClick={() => window.electronAPI.openUrl(getDocUrl('automations'))}>
                <Icons.Webhook className="h-3.5 w-3.5" />
                Automations
                <Icons.ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />
              </StyledDropdownMenuItem>
              <StyledDropdownMenuSeparator />
              <StyledDropdownMenuItem onClick={onOpenKeyboardShortcuts}>
                <Icons.Keyboard className="h-3.5 w-3.5" />
                Keyboard Shortcuts
                {keyboardShortcutsHotkey && <DropdownMenuShortcut className="pl-6">{keyboardShortcutsHotkey}</DropdownMenuShortcut>}
              </StyledDropdownMenuItem>
            </StyledDropdownMenuSubContent>
          </DropdownMenuSub>

          {/* Debug submenu (dev only) */}
          {isDebugMode && (
            <>
              <DropdownMenuSub>
                <StyledDropdownMenuSubTrigger>
                  <Icons.Bug className="h-3.5 w-3.5" />
                  Debug
                </StyledDropdownMenuSubTrigger>
                <StyledDropdownMenuSubContent>
                  <StyledDropdownMenuItem onClick={() => window.electronAPI.checkForUpdates()}>
                    <Icons.Download className="h-3.5 w-3.5" />
                    Check for Updates
                  </StyledDropdownMenuItem>
                  <StyledDropdownMenuItem onClick={() => window.electronAPI.installUpdate()}>
                    <Icons.Download className="h-3.5 w-3.5" />
                    Install Update
                  </StyledDropdownMenuItem>
                  <StyledDropdownMenuSeparator />
                  <StyledDropdownMenuItem onClick={() => window.electronAPI.menuToggleDevTools()}>
                    <Icons.Bug className="h-3.5 w-3.5" />
                    Toggle DevTools
                    <DropdownMenuShortcut className="pl-6">{isMac ? '⌥⌘I' : 'Ctrl+Shift+I'}</DropdownMenuShortcut>
                  </StyledDropdownMenuItem>
                </StyledDropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          )}

          <StyledDropdownMenuSeparator />

          {/* Quit */}
          <StyledDropdownMenuItem onClick={() => window.electronAPI.menuQuit()}>
            <Icons.LogOut className="h-3.5 w-3.5" />
            {t("menu.quitCraftAgents")}
            {quitHotkey && <DropdownMenuShortcut className="pl-6">{quitHotkey}</DropdownMenuShortcut>}
          </StyledDropdownMenuItem>
        </StyledDropdownMenuContent>
      </DropdownMenu>
      </div>

      {/* Spacer - pointer-events-none inherited from parent, drag passes through */}
      <div className="flex-1" />

      {/* Nav Buttons - interactive island */}
      <div className="pointer-events-auto titlebar-no-drag flex items-center gap-[5px]">
        {/* Back Navigation */}
        <Tooltip>
          <TooltipTrigger asChild>
            <TopBarButton
              onClick={onBack}
              disabled={!canGoBack}
              aria-label="Go back"
            >
              <Icons.ChevronLeft className="h-[22px] w-[22px] text-foreground/70" strokeWidth={1.5} />
            </TopBarButton>
          </TooltipTrigger>
          <TooltipContent side="bottom">Back {goBackHotkey}</TooltipContent>
        </Tooltip>

        {/* Forward Navigation */}
        <Tooltip>
          <TooltipTrigger asChild>
            <TopBarButton
              onClick={onForward}
              disabled={!canGoForward}
              aria-label="Go forward"
            >
              <Icons.ChevronRight className="h-[22px] w-[22px] text-foreground/70" strokeWidth={1.5} />
            </TopBarButton>
          </TooltipTrigger>
          <TooltipContent side="bottom">Forward {goForwardHotkey}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
