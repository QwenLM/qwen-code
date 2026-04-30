import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuPortal,
} from "./context-menu"
import { cn } from "@/lib/utils"

/**
 * Styled Context Menu Components
 *
 * Pre-styled context menu components matching the StyledDropdownMenu style.
 * These wrap the base context-menu components with consistent styling.
 */

// Re-export unchanged components
export { ContextMenu, ContextMenuTrigger }

// Styled content - matches StyledDropdownMenuContent
interface StyledContextMenuContentProps
  extends React.ComponentPropsWithoutRef<typeof ContextMenuContent> {
  /** Minimum width - defaults to min-w-40 */
  minWidth?: string
}

export const StyledContextMenuContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuContent>,
  StyledContextMenuContentProps
>(({ className, minWidth = "min-w-40", ...props }, ref) => (
  <ContextMenuContent
    ref={ref}
    className={cn(
      "w-fit font-sans whitespace-nowrap text-xs flex flex-col gap-0.5",
      minWidth,
      className
    )}
    {...props}
  />
))
StyledContextMenuContent.displayName = "StyledContextMenuContent"

// Styled menu item - matches StyledDropdownMenuItem
interface StyledContextMenuItemProps
  extends React.ComponentPropsWithoutRef<typeof ContextMenuItem> {
  /** Destructive variant - red text */
  variant?: "default" | "destructive"
}

export const StyledContextMenuItem = React.forwardRef<
  React.ComponentRef<typeof ContextMenuItem>,
  StyledContextMenuItemProps
>(({ className, variant = "default", ...props }, ref) => (
  <ContextMenuItem
    ref={ref}
    className={cn(
      "gap-3 pr-4 rounded-[4px] hover:bg-foreground/[0.03] focus:bg-foreground/[0.03]",
      "[&_svg]:size-auto [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0",
      variant === "destructive" && "text-destructive focus:text-destructive hover:text-destructive [&_svg]:!text-destructive",
      className
    )}
    {...props}
  />
))
StyledContextMenuItem.displayName = "StyledContextMenuItem"

// Styled separator - matches StyledDropdownMenuSeparator
export const StyledContextMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof ContextMenuSeparator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuSeparator>
>(({ className, ...props }, ref) => (
  <ContextMenuSeparator
    ref={ref}
    className={cn("bg-foreground/10", className)}
    {...props}
  />
))
StyledContextMenuSeparator.displayName = "StyledContextMenuSeparator"

// Re-export Sub for submenus
export { ContextMenuSub as StyledContextMenuSub }

// Styled sub-menu trigger - matches StyledDropdownMenuSubTrigger
export const StyledContextMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof ContextMenuSubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuSubTrigger>
>(({ className, ...props }, ref) => (
  <ContextMenuSubTrigger
    ref={ref}
    className={cn(
      "gap-3 pr-4 rounded-[4px] hover:bg-foreground/10 focus:bg-foreground/10 data-[state=open]:bg-foreground/10",
      "[&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0",
      className
    )}
    {...props}
  />
))
StyledContextMenuSubTrigger.displayName = "StyledContextMenuSubTrigger"

// Styled sub-menu content - matches StyledDropdownMenuSubContent
interface StyledContextMenuSubContentProps
  extends React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent> {
  /** Minimum width - defaults to min-w-36 */
  minWidth?: string
}

export const StyledContextMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubContent>,
  StyledContextMenuSubContentProps
>(({ className, minWidth = "min-w-36", sideOffset = -4, ...props }, ref) => (
  <ContextMenuPortal>
    <ContextMenuPrimitive.SubContent
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "popover-styled w-fit font-sans whitespace-nowrap text-xs flex flex-col gap-0.5 z-dropdown overflow-hidden p-1",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        minWidth,
        className
      )}
      {...props}
    />
  </ContextMenuPortal>
))
StyledContextMenuSubContent.displayName = "StyledContextMenuSubContent"
