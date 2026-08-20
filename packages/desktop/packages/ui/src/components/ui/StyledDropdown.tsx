/**
 * StyledDropdown - Shared styled dropdown components
 *
 * Pre-styled Radix dropdown wrappers matching the app's vibrancy style:
 * - popover-styled background with blur
 * - Consistent item spacing and subtle hover states (foreground/[0.03])
 * - Icon sizing standardization (3.5 × 3.5)
 *
 * Wraps raw @radix-ui/react-dropdown-menu primitives with the full class set
 * (shadcn base layer + styled additions) so consumers get the correct look
 * without depending on the shadcn wrapper layer in apps/electron.
 */

import * as React from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from '../../lib/utils'

const SUPPORTED_HOVER_PREFIXES = ['bg-', 'text-', 'border-', 'ring-', 'opacity-']

/**
 * Mirror hover styles to open-state styles for Radix triggers.
 *
 * Example:
 * - hover:bg-foreground/5 -> data-[state=open]:bg-foreground/5
 *
 * Consumers can still provide explicit data-[state=open]:* classes to override.
 */
export function mirrorHoverToOpenStateClasses(className?: string): string | undefined {
  if (!className) return className

  const tokens = className.trim().split(/\s+/)
  const mirrored: string[] = []

  for (const token of tokens) {
    if (!token.includes('hover:')) continue

    const hoverIdx = token.indexOf('hover:')
    const afterHover = token.slice(hoverIdx + 'hover:'.length)
    const utility = afterHover.includes(':') ? afterHover.slice(afterHover.lastIndexOf(':') + 1) : afterHover

    if (!SUPPORTED_HOVER_PREFIXES.some(prefix => utility.startsWith(prefix))) continue

    mirrored.push(token.replace('hover:', 'data-[state=open]:'))
  }

  return cn(...mirrored, className)
}

// Re-export raw primitives that need no styling
const DropdownMenu = DropdownMenuPrimitive.Root
const DropdownMenuSub = DropdownMenuPrimitive.Sub

interface DropdownMenuTriggerProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger> {
  /** Auto-mirror hover:* classes to data-[state=open]:* while menu is open. Default: true */
  autoMirrorHoverToOpen?: boolean
}

const DropdownMenuTrigger = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Trigger>,
  DropdownMenuTriggerProps
>(({ className, autoMirrorHoverToOpen = true, asChild, children, ...props }, ref) => {
  const triggerClassName = autoMirrorHoverToOpen ? mirrorHoverToOpenStateClasses(className) : className

  if (asChild && autoMirrorHoverToOpen && React.isValidElement(children)) {
    const childClassName = (children.props as { className?: string }).className
    const mergedChildClassName = mirrorHoverToOpenStateClasses(cn(childClassName, className))

    return (
      <DropdownMenuPrimitive.Trigger
        ref={ref}
        asChild
        {...props}
      >
        {React.cloneElement(children as React.ReactElement<{ className?: string }>, {
          className: mergedChildClassName,
        })}
      </DropdownMenuPrimitive.Trigger>
    )
  }

  return (
    <DropdownMenuPrimitive.Trigger
      ref={ref}
      asChild={asChild}
      className={triggerClassName}
      {...props}
    >
      {children}
    </DropdownMenuPrimitive.Trigger>
  )
})
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger'

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuSub }

// ── Content ──────────────────────────────────────────────────────────────────

interface StyledDropdownMenuContentProps
  extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> {
  minWidth?: string
  /** Force light mode instead of dark */
  light?: boolean
}

export const StyledDropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  StyledDropdownMenuContentProps
>(({ className, minWidth = 'min-w-40', light = false, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        // shadcn base layer
        'popover-styled overflow-x-hidden overflow-y-auto p-1 z-dropdown',
        'max-h-(--radix-dropdown-menu-content-available-height)',
        'origin-(--radix-dropdown-menu-content-transform-origin)',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
        'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        // styled additions
        'w-fit font-sans whitespace-nowrap text-xs flex flex-col gap-0.5',
        minWidth,
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
))
StyledDropdownMenuContent.displayName = 'StyledDropdownMenuContent'

// ── Item ─────────────────────────────────────────────────────────────────────

interface StyledDropdownMenuItemProps
  extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> {
  variant?: 'default' | 'destructive'
}

export const StyledDropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  StyledDropdownMenuItemProps
>(({ className, variant = 'default', ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      // shadcn base layer
      'relative flex cursor-default items-center gap-2 px-2 py-1.5 text-sm outline-hidden select-none',
      '[&_svg]:pointer-events-none [&_svg]:shrink-0',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      // styled additions
      'pr-4 rounded-[4px] hover:bg-foreground/[0.03] focus:bg-foreground/[0.03]',
      '[&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0',
      variant === 'destructive' && 'text-destructive focus:text-destructive hover:text-destructive [&_svg]:!text-destructive',
      className,
    )}
    {...props}
  />
))
StyledDropdownMenuItem.displayName = 'StyledDropdownMenuItem'

// ── Separator ────────────────────────────────────────────────────────────────

export const StyledDropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn('bg-foreground/10 -mx-1 my-1 h-px', className)}
    {...props}
  />
))
StyledDropdownMenuSeparator.displayName = 'StyledDropdownMenuSeparator'

// ── Sub-menu trigger ─────────────────────────────────────────────────────────

export const StyledDropdownMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      'relative flex cursor-default items-center gap-2 px-2 py-1.5 text-sm outline-hidden select-none',
      '[&_svg]:pointer-events-none [&_svg]:shrink-0',
      'pr-1.5 rounded-[4px] hover:bg-foreground/10 focus:bg-foreground/10 data-[state=open]:bg-foreground/10',
      '[&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0',
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRightIcon className="ml-auto size-4" />
  </DropdownMenuPrimitive.SubTrigger>
))
StyledDropdownMenuSubTrigger.displayName = 'StyledDropdownMenuSubTrigger'

// ── Sub-menu content ─────────────────────────────────────────────────────────

interface StyledDropdownMenuSubContentProps
  extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent> {
  minWidth?: string
}

export const StyledDropdownMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubContent>,
  StyledDropdownMenuSubContentProps
>(({ className, minWidth = 'min-w-36', sideOffset = -4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'popover-styled w-fit font-sans whitespace-nowrap text-xs flex flex-col gap-0.5 z-dropdown overflow-x-hidden overflow-y-auto p-1',
        'max-h-(--radix-dropdown-menu-content-available-height)',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        minWidth,
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
))
StyledDropdownMenuSubContent.displayName = 'StyledDropdownMenuSubContent'

// ── Shortcut ─────────────────────────────────────────────────────────────────

export function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('text-muted-foreground ml-auto text-xs tracking-widest', className)}
      {...props}
    />
  )
}
