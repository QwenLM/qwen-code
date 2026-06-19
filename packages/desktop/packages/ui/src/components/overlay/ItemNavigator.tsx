/**
 * ItemNavigator - Shared arrow + dropdown navigation for overlay items.
 *
 * Renders left/right arrows with a clickable label between them.
 * Clicking the label opens a dropdown listing all items for direct selection.
 * The active item shows a check icon.
 *
 * Uses StyledDropdown components for consistent popover styling (vibrancy, blur, sizing).
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Check } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '../ui/StyledDropdown'
import { cn } from '../../lib/utils'

interface NavigatorItem {
  label?: string
}

export interface ItemNavigatorProps {
  items: NavigatorItem[]
  activeIndex: number
  onSelect: (index: number) => void
  /** Size variant — 'sm' for inline blocks, 'md' for fullscreen overlays */
  size?: 'sm' | 'md'
}

export function ItemNavigator({ items, activeIndex, onSelect, size = 'sm' }: ItemNavigatorProps) {
  const { t } = useTranslation()
  const goToPrev = useCallback(() => {
    onSelect(Math.max(0, activeIndex - 1))
  }, [onSelect, activeIndex])

  const goToNext = useCallback(() => {
    onSelect(Math.min(items.length - 1, activeIndex + 1))
  }, [onSelect, activeIndex, items.length])

  if (items.length <= 1) return null

  const activeItem = items[activeIndex]
  const displayLabel = activeItem?.label || `${activeIndex + 1} / ${items.length}`

  return (
    <div className="flex items-center gap-1 select-none">
      <button
        onClick={goToPrev}
        disabled={activeIndex === 0}
        className={cn(
          'bg-background shadow-minimal cursor-pointer',
          'text-foreground/50 hover:text-foreground transition-colors',
          'disabled:opacity-30 disabled:cursor-not-allowed',
          size === 'md' ? 'p-1.5 rounded-[8px]' : 'p-1 rounded-[6px]'
        )}
        title={t('overlay.previousItem')}
      >
        <ChevronLeft className={size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              'flex items-center text-muted-foreground font-medium',
              'bg-background shadow-minimal cursor-pointer',
              'hover:opacity-80 transition-opacity',
              size === 'md' ? 'text-[13px] px-3 h-[28px] w-[144px] justify-center rounded-[8px]' : 'text-[12px] px-2.5 h-[22px] w-[112px] justify-center rounded-[6px]'
            )}
            title={t('overlay.selectItem')}
          >
            <span className="truncate max-w-[120px]">{displayLabel}</span>
          </button>
        </DropdownMenuTrigger>
        <StyledDropdownMenuContent align="center" className="max-h-64 overflow-y-auto" style={{ zIndex: 'var(--z-floating-menu, 400)' }}>
          {items.map((item, idx) => (
            <StyledDropdownMenuItem
              key={idx}
              onSelect={() => onSelect(idx)}
            >
              <span className="flex-1 truncate">
                {item.label || `Item ${idx + 1}`}
              </span>
              {idx === activeIndex && <Check className="w-3.5 h-3.5 text-accent" />}
            </StyledDropdownMenuItem>
          ))}
        </StyledDropdownMenuContent>
      </DropdownMenu>

      <button
        onClick={goToNext}
        disabled={activeIndex === items.length - 1}
        className={cn(
          'bg-background shadow-minimal cursor-pointer',
          'text-foreground/50 hover:text-foreground transition-colors',
          'disabled:opacity-30 disabled:cursor-not-allowed',
          size === 'md' ? 'p-1.5 rounded-[8px]' : 'p-1 rounded-[6px]'
        )}
        title={t('overlay.nextItem')}
      >
        <ChevronRight className={size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
      </button>
    </div>
  )
}
