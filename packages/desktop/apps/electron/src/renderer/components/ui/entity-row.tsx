/**
 * EntityRow — Reusable visual skeleton for list items.
 *
 * Extracted from SessionItem/SourceItem/SkillItem which all share the same layout:
 * - Absolutely-positioned icon on the left
 * - Title + badge/subtitle row
 * - Optional trailing content (timestamp, count)
 * - Hover-visible MoreHorizontal dropdown + context menu
 * - Selection/multi-select styling
 * - Optional separator above
 * - Optional children below the button (e.g. expanded child list)
 * - Optional overlay (e.g. match count badge)
 *
 * Domain-specific logic (what icon, what badges, what menu items) is injected via slots.
 */

import * as React from 'react'
import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
} from '@/components/ui/styled-dropdown'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
} from '@/components/ui/styled-context-menu'
import { DropdownMenuProvider, ContextMenuProvider } from '@/components/ui/menu-context'
import { cn } from '@/lib/utils'

export interface EntityRowProps {
  /** Left icon area — rendered in-flow as a flex child before the content column.
   *  Consumers can pass multiple icons (e.g. via a fragment) for a horizontal icon group. */
  icon?: React.ReactNode
  /** Title content (ReactNode for search highlighting support) */
  title: React.ReactNode
  /** Additional className on the title wrapper (e.g. shimmer animation) */
  titleClassName?: string
  /** Content rendered inline after the title (e.g. timestamp). On hover, swapped with the more button.
   *  When set, the title row becomes single-line (truncated) and the absolute more button is hidden. */
  titleTrailing?: React.ReactNode
  /** Content rendered inline immediately after the title, on the same row.
   *  Lives between the title and the trailing slot. Use for tiny, high-priority
   *  inline chips (e.g. platform bindings) that should read as part of the title
   *  area, not as badges below. `shrink-0` so long titles truncate first. */
  titleSuffix?: React.ReactNode
  /** Optional subtitle line beneath the title */
  subtitle?: React.ReactNode
  /** Badge/subtitle row beneath the title */
  badges?: React.ReactNode
  /** Right-aligned content in the badge row (timestamp, child toggle) */
  trailing?: React.ReactNode
  /** Content rendered below the main button (e.g. expanded child list) */
  children?: React.ReactNode
  /** Absolutely-positioned overlay (e.g. match count badge) */
  overlay?: React.ReactNode

  // --- Interaction ---
  /** Selection state */
  isSelected?: boolean
  /** Multi-select highlight (left accent bar + tinted bg) */
  isInMultiSelect?: boolean
  /** Click handler — use onMouseDown for modifier key detection (Session), or onClick for simple cases */
  onMouseDown?: (e: React.MouseEvent) => void
  /** Simple click handler (used when modifier key detection isn't needed) */
  onClick?: () => void
  /** Show separator above this row */
  showSeparator?: boolean

  // --- Menu ---
  /** Menu content — rendered in BOTH dropdown and context menu via providers.
   *  Should be a component that uses useMenuComponents() for its items. */
  menuContent?: React.ReactNode
  /** Context menu content when different from dropdown (e.g. batch menu in multi-select) */
  contextMenuContent?: React.ReactNode
  /** Whether to hide the more button (e.g. when overlay is showing) */
  hideMoreButton?: boolean

  // --- Passthrough ---
  /** Additional props spread onto the <button> (aria attrs, keyboard handlers, tabIndex, ref) */
  buttonProps?: Record<string, unknown>
  /** Data attributes on the outer wrapper div */
  dataAttributes?: Record<string, string | undefined>
  /** Outer wrapper className */
  className?: string
  /** Separator padding class (default: 'pl-12 pr-4') */
  separatorClassName?: string
}

export function EntityRow({
  icon,
  title,
  titleClassName,
  titleTrailing,
  titleSuffix,
  subtitle,
  badges,
  trailing,
  children,
  overlay,
  isSelected = false,
  isInMultiSelect = false,
  onMouseDown,
  onClick,
  showSeparator = false,
  menuContent,
  contextMenuContent,
  hideMoreButton = false,
  buttonProps,
  dataAttributes,
  className,
  separatorClassName = 'pl-12 pr-4',
}: EntityRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)

  // Resolve context menu content: use override if provided, else fall back to dropdown menu content
  const resolvedContextMenu = contextMenuContent ?? menuContent

  // Build the inner content (shared between with-context-menu and without)
  const innerContent = (
    <div className="relative group select-none pl-2 mr-2">
      {/* Selection indicator bar */}
      {(isSelected || isInMultiSelect) && (
        <div className="absolute left-0 inset-y-0 w-[2px] bg-accent" />
      )}

      {/* Main content button */}
      <button
        {...(buttonProps as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        className={cn(
          "entity-row-btn flex w-full items-start gap-2 pl-2 pr-4 py-3 text-left text-sm outline-none rounded-[8px]",
          "transition-[background-color] duration-75",
          (isSelected || isInMultiSelect)
            ? "bg-foreground/3"
            : "hover:bg-foreground/2",
          (buttonProps as Record<string, unknown>)?.className as string | undefined,
        )}
        onMouseDown={onMouseDown}
        onClick={!onMouseDown ? onClick : undefined}
      >
        {/* Content column */}
        <div className="flex flex-col gap-1.5 min-w-0 flex-1">
          {/* Title */}
          {titleTrailing ? (
            <div className="flex items-center gap-[10px] w-full min-w-0">
              {icon && (
                <div className="shrink-0 flex items-center gap-[10px] [&>*]:w-3 [&>*]:h-3">
                  {icon}
                </div>
              )}
              <div className={cn("font-sans truncate min-w-0", titleClassName)}>
                {title}
              </div>
              {titleSuffix && <div className="shrink-0 flex items-center">{titleSuffix}</div>}
              <div className="shrink-0 ml-auto relative -mr-1">
                <span className={cn(menuOpen || contextMenuOpen ? "invisible" : "group-hover:invisible")}>
                  {titleTrailing}
                </span>
                {menuContent && !hideMoreButton && (
                  <div
                    className={cn(
                      "absolute inset-0 flex items-center justify-end overflow-visible",
                      menuOpen || contextMenuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    )}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <DropdownMenu modal={true} open={menuOpen} onOpenChange={setMenuOpen}>
                      <DropdownMenuTrigger asChild>
                        <div className="p-1 rounded-[6px] hover:bg-foreground/10 data-[state=open]:bg-foreground/10 cursor-pointer">
                          <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                        </div>
                      </DropdownMenuTrigger>
                      <StyledDropdownMenuContent align="end">
                        <DropdownMenuProvider>
                          {menuContent}
                        </DropdownMenuProvider>
                      </StyledDropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-[10px] w-full pr-6 min-w-0">
              {icon && (
                <div className="shrink-0 flex items-center gap-[10px] [&>*]:w-3 [&>*]:h-3">
                  {icon}
                </div>
              )}
              <div className={cn("font-medium font-sans line-clamp-2 min-w-0 -mb-[2px]", titleClassName)}>
                {title}
              </div>
              {titleSuffix && <div className="shrink-0 self-center flex items-center">{titleSuffix}</div>}
            </div>
          )}

          {/* Subtitle line */}
          {subtitle && (
            <div className="flex items-start gap-[10px] w-full text-[12px] text-foreground/55 min-w-0 -mt-1">
              {icon && (
                <div className="shrink-0 flex items-center gap-[10px] [&>*]:w-3 [&>*]:h-3 invisible" aria-hidden="true">
                  {icon}
                </div>
              )}
              <div className="min-w-0 flex-1 line-clamp-2 leading-[1.35]">
                {subtitle}
              </div>
            </div>
          )}

          {/* Badges / metadata row */}
          {(badges || trailing) && (
            <div className="flex items-center gap-[10px] text-xs text-foreground/70 w-full -mb-[2px] min-w-0">
              {/* Invisible spacer matching icon container width */}
              {icon && (
                <div className="shrink-0 flex items-center gap-[10px] [&>*]:w-3 [&>*]:h-3 invisible" aria-hidden="true">
                  {icon}
                </div>
              )}
              {badges && (
                <div
                  className="flex-1 flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-hide"
                  style={{
                    maskImage: 'linear-gradient(to right, black calc(100% - 16px), transparent 100%)',
                    WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 16px), transparent 100%)',
                  }}
                >
                  {badges}
                </div>
              )}
              {trailing && (
                <div className="shrink-0 flex items-center gap-1 ml-auto">
                  {trailing}
                </div>
              )}
            </div>
          )}
        </div>
      </button>

      {/* Children rendered below the button */}
      {children}

      {/* Overlay (e.g. match count badge) */}
      {overlay}

      {/* More menu button — visible on hover or when menu is open (skipped when titleTrailing handles it inline) */}
      {menuContent && !hideMoreButton && !titleTrailing && (
        <div
          className={cn(
            "absolute right-2 top-2 transition-opacity z-10",
            menuOpen || contextMenuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          )}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center rounded-[8px] overflow-hidden border border-transparent hover:border-border/50">
            <DropdownMenu modal={true} open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <div className="p-1.5 hover:bg-foreground/10 data-[state=open]:bg-foreground/10 cursor-pointer">
                  <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                </div>
              </DropdownMenuTrigger>
              <StyledDropdownMenuContent align="end">
                <DropdownMenuProvider>
                  {menuContent}
                </DropdownMenuProvider>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div
      className={className}
      data-selected={isSelected || undefined}
      {...dataAttributes}
    >
      {/* Separator */}
      {showSeparator && (
        <div className={separatorClassName}>
          <Separator />
        </div>
      )}

      {/* Wrap with ContextMenu if menu content is provided */}
      {resolvedContextMenu ? (
        <ContextMenu modal={true} onOpenChange={setContextMenuOpen}>
          <ContextMenuTrigger asChild>
            {innerContent}
          </ContextMenuTrigger>
          <StyledContextMenuContent>
            <ContextMenuProvider>
              {resolvedContextMenu}
            </ContextMenuProvider>
          </StyledContextMenuContent>
        </ContextMenu>
      ) : (
        innerContent
      )}
    </div>
  )
}
