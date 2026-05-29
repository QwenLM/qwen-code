/**
 * TopBar - Persistent top bar above all panels (Slack-style)
 *
 * Layout: [Sidebar] [Menu] [Back] [Forward]
 *
 * Fixed at top of window, 48px tall.
 * macOS: offset left to avoid stoplight controls.
 */

import { useTranslation } from 'react-i18next';
import * as Icons from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui';
import { CraftAgentsSymbol } from '../icons/CraftAgentsSymbol';
import { PanelLeftRounded } from '../icons/PanelLeftRounded';
import { TopBarButton } from '../ui/TopBarButton';
import { cn } from '@/lib/utils';
import { isMac } from '@/lib/platform';
import { useActionLabel } from '@/actions';
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
} from '@/components/ui/styled-dropdown';
import {
  EDIT_MENU,
  VIEW_MENU,
  WINDOW_MENU,
  SETTINGS_ITEMS,
  getShortcutDisplay,
} from '../../../shared/menu-schema';
import type {
  MenuItem,
  MenuSection,
  SettingsMenuItem,
} from '../../../shared/menu-schema';
import { SETTINGS_ICONS } from '../icons/SettingsIcons';
import { SquarePenRounded } from '../icons/SquarePenRounded';
import { useEffect, useState } from 'react';
import type { Workspace } from '../../../shared/types';
import type { ViewRoute } from '../../../shared/routes';

// --- Menu rendering (moved from AppMenu) ---

type MenuActionHandlers = {
  toggleFocusMode?: () => void;
  toggleSidebar?: () => void;
};

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
};

function getIcon(
  name: string,
): React.ComponentType<{ className?: string }> | null {
  const IconComponent = Icons[name as keyof typeof Icons] as
    | React.ComponentType<{ className?: string }>
    | undefined;
  return IconComponent ?? null;
}

function renderMenuItem(
  item: MenuItem,
  index: number,
  actionHandlers: MenuActionHandlers,
  t: (key: string) => string,
): React.ReactNode {
  if (item.type === 'separator') {
    return <StyledDropdownMenuSeparator key={`sep-${index}`} />;
  }

  const Icon = getIcon(item.icon);
  const shortcut = getShortcutDisplay(item, isMac);

  if (item.type === 'role') {
    const handler = roleHandlers[item.role];
    const safeHandler =
      handler ??
      (() => {
        window.electronAPI.debugLog(
          `[TopBar] No handler registered for role: ${item.role}`,
        );
      });
    return (
      <StyledDropdownMenuItem key={item.role} onClick={safeHandler}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(item.labelKey)}
        {shortcut && (
          <DropdownMenuShortcut className="pl-6">
            {shortcut}
          </DropdownMenuShortcut>
        )}
      </StyledDropdownMenuItem>
    );
  }

  if (item.type === 'action') {
    const handler =
      item.id === 'toggleFocusMode'
        ? actionHandlers.toggleFocusMode
        : item.id === 'toggleSidebar'
          ? actionHandlers.toggleSidebar
          : undefined;
    return (
      <StyledDropdownMenuItem key={item.id} onClick={handler}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(item.labelKey)}
        {shortcut && (
          <DropdownMenuShortcut className="pl-6">
            {shortcut}
          </DropdownMenuShortcut>
        )}
      </StyledDropdownMenuItem>
    );
  }

  return null;
}

function renderMenuSection(
  section: MenuSection,
  actionHandlers: MenuActionHandlers,
  t: (key: string) => string,
): React.ReactNode {
  const Icon = getIcon(section.icon);
  return (
    <DropdownMenuSub key={section.id}>
      <StyledDropdownMenuSubTrigger>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(section.labelKey)}
      </StyledDropdownMenuSubTrigger>
      <StyledDropdownMenuSubContent>
        {section.items.map((item, index) =>
          renderMenuItem(item, index, actionHandlers, t),
        )}
      </StyledDropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// --- TopBar ---

interface TopBarProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (
    workspaceId: string,
    openInNewWindow?: boolean,
    options?: { route?: ViewRoute; suppressSessionListLoading?: boolean },
  ) => void | Promise<void>;
  workspaceUnreadMap?: Record<string, boolean>;
  onWorkspaceCreated?: (workspace: Workspace) => void;
  onWorkspaceRemoved?: () => void;
  onNewChat: () => void;
  onNewWindow?: () => void;
  onOpenSettings: () => void;
  onOpenSettingsSubpage: (subpage: SettingsMenuItem['id']) => void;
  onOpenKeyboardShortcuts: () => void;
  onShowAbout?: () => void;
  onBack: () => void;
  onForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onToggleSidebar: () => void;
  onToggleFocusMode: () => void;
  /** When true, hides controls that don't apply in compact/mobile layout */
  isCompact?: boolean;
}

export function TopBar({
  onNewChat,
  onNewWindow,
  onOpenSettings,
  onOpenSettingsSubpage,
  onOpenKeyboardShortcuts,
  onShowAbout,
  onBack,
  onForward,
  canGoBack,
  canGoForward,
  onToggleSidebar,
  onToggleFocusMode,
  isCompact,
}: TopBarProps) {
  const { t } = useTranslation();
  const [isDebugMode, setIsDebugMode] = useState(false);

  const newChatHotkey = useActionLabel('app.newChat').hotkey;
  const newWindowHotkey = useActionLabel('app.newWindow').hotkey;
  const settingsHotkey = useActionLabel('app.settings').hotkey;
  const keyboardShortcutsHotkey = useActionLabel(
    'app.keyboardShortcuts',
  ).hotkey;
  const quitHotkey = useActionLabel('app.quit').hotkey;
  const goBackHotkey = useActionLabel('nav.goBackAlt').hotkey;
  const goForwardHotkey = useActionLabel('nav.goForwardAlt').hotkey;

  useEffect(() => {
    window.electronAPI.isDebugMode().then(setIsDebugMode);
  }, []);

  const actionHandlers: MenuActionHandlers = {
    toggleFocusMode: onToggleFocusMode,
    toggleSidebar: onToggleSidebar,
  };

  const menuLeftPadding = isMac ? 86 : 12;

  return (
    <div
      className="fixed top-0 left-0 h-[48px] pointer-events-none"
      style={{ zIndex: 'calc(var(--z-panel) + 10)' }}
    >
      <div className="flex h-full items-center gap-2">
        {/* === LEFT: Sidebar + Menu + Navigation + Workspace === */}
        <div
          className="titlebar-no-drag pointer-events-auto flex min-w-0 items-center gap-0.5"
          style={{ paddingLeft: menuLeftPadding }}
        >
          <div className="flex items-center gap-0.5">
            {!isCompact && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <TopBarButton
                    onClick={onToggleSidebar}
                    aria-label={t('menu.toggleSidebar')}
                  >
                    <PanelLeftRounded className="h-[18px] w-[18px] text-foreground/70" />
                  </TopBarButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t('menu.toggleSidebar')}
                </TooltipContent>
              </Tooltip>
            )}

            {/* Craft Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <TopBarButton aria-label={t('menu.craftMenu')}>
                  <CraftAgentsSymbol className="h-4 text-accent" />
                </TopBarButton>
              </DropdownMenuTrigger>
              <StyledDropdownMenuContent align="start" minWidth="min-w-48">
                <StyledDropdownMenuItem onClick={onNewChat}>
                  <SquarePenRounded className="h-3.5 w-3.5" />
                  {t('menu.newChat')}
                  {newChatHotkey && (
                    <DropdownMenuShortcut className="pl-6">
                      {newChatHotkey}
                    </DropdownMenuShortcut>
                  )}
                </StyledDropdownMenuItem>
                {onNewWindow && (
                  <StyledDropdownMenuItem onClick={onNewWindow}>
                    <Icons.AppWindow className="h-3.5 w-3.5" />
                    {t('menu.newWindow')}
                    {newWindowHotkey && (
                      <DropdownMenuShortcut className="pl-6">
                        {newWindowHotkey}
                      </DropdownMenuShortcut>
                    )}
                  </StyledDropdownMenuItem>
                )}

                <StyledDropdownMenuSeparator />

                {renderMenuSection(EDIT_MENU, actionHandlers, t)}
                {renderMenuSection(VIEW_MENU, actionHandlers, t)}
                {renderMenuSection(WINDOW_MENU, actionHandlers, t)}

                <StyledDropdownMenuSeparator />

                <DropdownMenuSub>
                  <StyledDropdownMenuSubTrigger>
                    <Icons.Settings className="h-3.5 w-3.5" />
                    {t('sidebar.settings')}
                  </StyledDropdownMenuSubTrigger>
                  <StyledDropdownMenuSubContent>
                    <StyledDropdownMenuItem onClick={onOpenSettings}>
                      <Icons.Settings className="h-3.5 w-3.5" />
                      {t('menu.settings')}
                      {settingsHotkey && (
                        <DropdownMenuShortcut className="pl-6">
                          {settingsHotkey}
                        </DropdownMenuShortcut>
                      )}
                    </StyledDropdownMenuItem>
                    <StyledDropdownMenuSeparator />
                    {SETTINGS_ITEMS.map((item) => {
                      const Icon = SETTINGS_ICONS[item.id];
                      return (
                        <StyledDropdownMenuItem
                          key={item.id}
                          onClick={() => onOpenSettingsSubpage(item.id)}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {t(item.labelKey)}
                        </StyledDropdownMenuItem>
                      );
                    })}
                  </StyledDropdownMenuSubContent>
                </DropdownMenuSub>

                <DropdownMenuSub>
                  <StyledDropdownMenuSubTrigger>
                    <Icons.HelpCircle className="h-3.5 w-3.5" />
                    {t('menu.help')}
                  </StyledDropdownMenuSubTrigger>
                  <StyledDropdownMenuSubContent>
                    <StyledDropdownMenuItem
                      onClick={() =>
                        window.electronAPI.openUrl(
                          'https://agents.craft.do/docs',
                        )
                      }
                    >
                      <Icons.HelpCircle className="h-3.5 w-3.5" />
                      {t('menu.helpAndDocs')}
                      <Icons.ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />
                    </StyledDropdownMenuItem>
                    <StyledDropdownMenuItem onClick={onOpenKeyboardShortcuts}>
                      <Icons.Keyboard className="h-3.5 w-3.5" />
                      {t('menu.keyboardShortcuts')}
                      {keyboardShortcutsHotkey && (
                        <DropdownMenuShortcut className="pl-6">
                          {keyboardShortcutsHotkey}
                        </DropdownMenuShortcut>
                      )}
                    </StyledDropdownMenuItem>
                    {onShowAbout && (
                      <>
                        <StyledDropdownMenuSeparator />
                        <StyledDropdownMenuItem onClick={onShowAbout}>
                          <Icons.Info className="h-3.5 w-3.5" />
                          {t('menu.aboutCraftAgents')}
                        </StyledDropdownMenuItem>
                      </>
                    )}
                  </StyledDropdownMenuSubContent>
                </DropdownMenuSub>

                {isDebugMode && (
                  <>
                    <DropdownMenuSub>
                      <StyledDropdownMenuSubTrigger>
                        <Icons.Bug className="h-3.5 w-3.5" />
                        Debug
                      </StyledDropdownMenuSubTrigger>
                      <StyledDropdownMenuSubContent>
                        <StyledDropdownMenuItem
                          onClick={() => window.electronAPI.checkForUpdates()}
                        >
                          <Icons.Download className="h-3.5 w-3.5" />
                          Check for Updates
                        </StyledDropdownMenuItem>
                        <StyledDropdownMenuItem
                          onClick={() => window.electronAPI.installUpdate()}
                        >
                          <Icons.Download className="h-3.5 w-3.5" />
                          Install Update
                        </StyledDropdownMenuItem>
                        <StyledDropdownMenuSeparator />
                        <StyledDropdownMenuItem
                          onClick={() =>
                            window.electronAPI.menuToggleDevTools()
                          }
                        >
                          <Icons.Bug className="h-3.5 w-3.5" />
                          Toggle DevTools
                          <DropdownMenuShortcut className="pl-6">
                            {isMac ? '⌥⌘I' : 'Ctrl+Shift+I'}
                          </DropdownMenuShortcut>
                        </StyledDropdownMenuItem>
                      </StyledDropdownMenuSubContent>
                    </DropdownMenuSub>
                  </>
                )}

                <StyledDropdownMenuSeparator />

                <StyledDropdownMenuItem
                  onClick={() => window.electronAPI.menuQuit()}
                >
                  <Icons.LogOut className="h-3.5 w-3.5" />
                  {t('menu.quitCraftAgents')}
                  {quitHotkey && (
                    <DropdownMenuShortcut className="pl-6">
                      {quitHotkey}
                    </DropdownMenuShortcut>
                  )}
                </StyledDropdownMenuItem>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Back / Forward */}
          <div
            className={cn(
              'ml-1 flex min-w-0 items-center gap-1',
              isCompact ? 'flex-1' : 'w-[clamp(220px,42vw,640px)]',
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <TopBarButton
                  onClick={onBack}
                  disabled={!canGoBack}
                  aria-label={t('common.back')}
                >
                  <Icons.ChevronLeft
                    className="h-[18px] w-[18px] text-foreground/70"
                    strokeWidth={1.5}
                  />
                </TopBarButton>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('common.back')} {goBackHotkey}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <TopBarButton
                  onClick={onForward}
                  disabled={!canGoForward}
                  aria-label={t('common.forward')}
                >
                  <Icons.ChevronRight
                    className="h-[18px] w-[18px] text-foreground/70"
                    strokeWidth={1.5}
                  />
                </TopBarButton>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('common.forward')} {goForwardHotkey}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
