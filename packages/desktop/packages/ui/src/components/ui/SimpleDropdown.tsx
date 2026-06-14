import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ReactDOM from 'react-dom'
import { cn } from '../../lib/utils'

/**
 * SimpleDropdown - A lightweight dropdown menu without external dependencies
 *
 * Features:
 * - Click-outside detection
 * - Portal rendering for proper stacking
 * - Keyboard navigation (Escape/ArrowUp/ArrowDown/Enter)
 * - Position-aware (flips if near edge)
 */

interface SimpleDropdownContextValue {
  close: () => void
  highlightedId: string | null
  setHighlightedId: (id: string) => void
  setItemRef: (id: string, el: HTMLButtonElement | null) => void
}

const SimpleDropdownContext = React.createContext<SimpleDropdownContextValue | null>(null)

export interface SimpleDropdownItemProps {
  /** Click handler */
  onClick: (e?: React.MouseEvent) => void
  /** Item content */
  children: React.ReactNode
  /** Optional icon (rendered before label) */
  icon?: React.ReactNode
  /** Destructive variant - red text */
  variant?: 'default' | 'destructive'
  /** Additional className */
  className?: string
  /** Optional ref callback to access the underlying button */
  buttonRef?: (el: HTMLButtonElement | null) => void
  /** Optional hover callback */
  onMouseEnter?: (e: React.MouseEvent<HTMLButtonElement>) => void
}

export function SimpleDropdownItem({
  onClick,
  children,
  icon,
  variant = 'default',
  className,
  buttonRef,
  onMouseEnter,
}: SimpleDropdownItemProps) {
  const dropdownCtx = React.useContext(SimpleDropdownContext)
  const itemId = React.useId()

  const setCombinedRef = React.useCallback((el: HTMLButtonElement | null) => {
    buttonRef?.(el)
    dropdownCtx?.setItemRef(itemId, el)
  }, [buttonRef, dropdownCtx, itemId])

  const handleClick = React.useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    onClick(e)
    dropdownCtx?.close()
  }, [onClick, dropdownCtx])

  const handleMouseEnter = React.useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    dropdownCtx?.setHighlightedId(itemId)
    onMouseEnter?.(e)
  }, [dropdownCtx, itemId, onMouseEnter])

  const isHighlighted = dropdownCtx?.highlightedId === itemId

  return (
    <button
      ref={setCombinedRef}
      type="button"
      data-simple-dropdown-item="true"
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onFocus={() => dropdownCtx?.setHighlightedId(itemId)}
      className={cn(
        'flex items-center gap-2 w-full px-2.5 py-1.5 text-left text-[13px] rounded-[4px]',
        'hover:bg-foreground/[0.05] focus:bg-foreground/[0.05] focus:outline-none',
        'transition-colors',
        isHighlighted && 'bg-foreground/[0.05]',
        variant === 'destructive' && 'text-destructive hover:text-destructive',
        className
      )}
    >
      {icon && (
        <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0 [&>svg]:w-3.5 [&>svg]:h-3.5">
          {icon}
        </span>
      )}
      <span className="flex-1">{children}</span>
    </button>
  )
}

export interface SimpleDropdownProps {
  /** Trigger element */
  trigger: React.ReactNode
  /** Menu items */
  children: React.ReactNode
  /** Alignment relative to trigger */
  align?: 'start' | 'end'
  /** Additional className for the menu */
  className?: string
  /** Whether the dropdown is disabled */
  disabled?: boolean
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void
  /** Enable built-in ArrowUp/ArrowDown/Enter keyboard navigation (default: true) */
  keyboardNavigation?: boolean
}

export function SimpleDropdown({
  trigger,
  children,
  align = 'end',
  className,
  disabled = false,
  onOpenChange,
  keyboardNavigation = true,
}: SimpleDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  // Notify parent of open state changes
  const setIsOpenWithCallback = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    setIsOpen(prev => {
      const newValue = typeof open === 'function' ? open(prev) : open
      if (newValue !== prev) {
        onOpenChange?.(newValue)
      }
      return newValue
    })
  }, [onOpenChange])

  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Item registry (supports nested SimpleDropdownItem usage)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const itemOrder = useRef<string[]>([])

  const getNavigableIds = useCallback(() => {
    return itemOrder.current.filter((id) => itemRefs.current.has(id))
  }, [])

  const setItemRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) {
      itemRefs.current.set(id, el)
      if (!itemOrder.current.includes(id)) itemOrder.current.push(id)
      if (!highlightedId) setHighlightedId(id)
      return
    }

    itemRefs.current.delete(id)
    itemOrder.current = itemOrder.current.filter(existingId => existingId !== id)

    setHighlightedId((prev) => {
      if (prev !== id) return prev
      const nextIds = getNavigableIds()
      return nextIds[0] ?? null
    })
  }, [getNavigableIds, highlightedId])

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return

    const rect = triggerRef.current.getBoundingClientRect()
    const menuWidth = 160 // Approximate menu width

    let left = align === 'end' ? rect.right - menuWidth : rect.left
    const top = rect.bottom + 4

    // Keep menu within viewport
    if (left < 8) left = 8
    if (left + menuWidth > window.innerWidth - 8) {
      left = window.innerWidth - menuWidth - 8
    }

    setPosition({ top, left })
  }, [align])

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (disabled) return

    if (!isOpen) {
      // Calculate position before opening to prevent animation from wrong position
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect()
        const menuWidth = 160
        let left = align === 'end' ? rect.right - menuWidth : rect.left
        const top = rect.bottom + 4
        if (left < 8) left = 8
        if (left + menuWidth > window.innerWidth - 8) {
          left = window.innerWidth - menuWidth - 8
        }
        setPosition({ top, left })
      }
    }
    setIsOpenWithCallback(prev => !prev)
  }, [disabled, isOpen, align, setIsOpenWithCallback])

  const handleClose = useCallback(() => {
    setIsOpenWithCallback(false)
  }, [setIsOpenWithCallback])

  // Update position when opening (for edge cases like window resize)
  useEffect(() => {
    if (isOpen) {
      updatePosition()
    }
  }, [isOpen, updatePosition])

  // Reset keyboard highlight when menu opens
  useEffect(() => {
    if (!isOpen) {
      setHighlightedId(null)
      itemRefs.current.clear()
      itemOrder.current = []
      return
    }

    setHighlightedId((prev) => {
      if (prev) return prev
      const ids = getNavigableIds()
      return ids[0] ?? null
    })
  }, [isOpen, getNavigableIds])

  // Keep highlighted item visible when navigating by keyboard.
  useEffect(() => {
    if (!isOpen || !highlightedId) return
    itemRefs.current.get(highlightedId)?.scrollIntoView({ block: 'nearest' })
  }, [isOpen, highlightedId])

  // Click outside detection + keyboard nav
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        handleClose()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose()
        return
      }

      if (!menuRef.current) return
      const target = e.target as Node | null
      if (!target || !menuRef.current.contains(target)) return

      if (!keyboardNavigation) return

      const navigableIds = getNavigableIds()
      if (navigableIds.length === 0) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const currentIndex = highlightedId ? navigableIds.indexOf(highlightedId) : -1
        const delta = e.key === 'ArrowDown' ? 1 : -1
        const nextIndex = currentIndex < 0
          ? 0
          : (currentIndex + delta + navigableIds.length) % navigableIds.length
        setHighlightedId(navigableIds[nextIndex] ?? null)
        return
      }

      if (e.key === 'Enter') {
        if (!highlightedId) return
        e.preventDefault()
        itemRefs.current.get(highlightedId)?.click()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [isOpen, handleClose, getNavigableIds, highlightedId, keyboardNavigation])

  const contextValue = useMemo<SimpleDropdownContextValue>(() => ({
    close: handleClose,
    highlightedId,
    setHighlightedId,
    setItemRef,
  }), [handleClose, highlightedId, setItemRef])

  return (
    <>
      <div
        ref={triggerRef}
        onClick={handleToggle}
        className={cn('inline-flex', disabled && 'opacity-50 pointer-events-none')}
      >
        {trigger}
      </div>

      {isOpen && position && ReactDOM.createPortal(
        <SimpleDropdownContext.Provider value={contextValue}>
          <div
            ref={menuRef}
            className={cn(
              'fixed z-50 min-w-[140px] p-1',
              'bg-background rounded-[8px] shadow-strong border border-border/50',
              'animate-in fade-in-0 zoom-in-95 duration-100',
              className
            )}
            style={{ top: position.top, left: position.left }}
          >
            {children}
          </div>
        </SimpleDropdownContext.Provider>,
        document.body
      )}
    </>
  )
}
