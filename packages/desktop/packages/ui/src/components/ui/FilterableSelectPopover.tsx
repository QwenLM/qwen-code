import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'

export interface FilterableSelectRenderState {
  selected: boolean
  highlighted: boolean
}

export interface FilterableSelectPopoverProps<T> {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef: React.RefObject<HTMLElement | null>
  items: T[]
  getKey: (item: T) => string
  getLabel: (item: T) => string
  isSelected: (item: T) => boolean
  onToggle: (item: T) => void
  renderItem?: (item: T, state: FilterableSelectRenderState, index: number) => React.ReactNode
  filterPlaceholder?: string
  emptyState?: React.ReactNode
  noResultsState?: React.ReactNode
  closeOnSelect?: boolean
  minWidth?: number
  maxWidth?: number
}

/**
 * Reusable flat list selector with:
 * - text filtering
 * - keyboard navigation (↑/↓, Enter, Esc)
 * - click-outside dismissal
 * - anchor-based portal positioning
 */
export function FilterableSelectPopover<T>({
  open,
  onOpenChange,
  anchorRef,
  items,
  getKey,
  getLabel,
  isSelected,
  onToggle,
  renderItem,
  filterPlaceholder,
  emptyState,
  noResultsState,
  closeOnSelect = false,
  minWidth = 200,
  maxWidth = 320,
}: FilterableSelectPopoverProps<T>) {
  const { t } = useTranslation()
  const resolvedPlaceholder = filterPlaceholder ?? t('common.search')
  const [filter, setFilter] = React.useState('')
  const [highlightedIndex, setHighlightedIndex] = React.useState(0)
  const [position, setPosition] = React.useState<{ top: number; left: number } | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)

  const filteredItems = React.useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (!query) return items
    return items.filter(item => getLabel(item).toLowerCase().includes(query))
  }, [items, filter, getLabel])

  const updatePosition = React.useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()

    const viewportPadding = 8
    const effectiveMinWidth = Math.min(minWidth, window.innerWidth - viewportPadding * 2)
    const effectiveMaxWidth = Math.min(maxWidth, window.innerWidth - viewportPadding * 2)
    const expectedWidth = Math.max(effectiveMinWidth, effectiveMaxWidth)
    const maxLeft = Math.max(viewportPadding, window.innerWidth - expectedWidth - viewportPadding)

    setPosition({
      top: rect.top,
      left: Math.max(viewportPadding, Math.min(rect.left, maxLeft)),
    })
  }, [anchorRef, minWidth, maxWidth])

  React.useEffect(() => {
    if (!open) return

    setFilter('')
    setHighlightedIndex(0)
    updatePosition()

    const focusInput = () => inputRef.current?.focus()
    const raf = requestAnimationFrame(focusInput)
    const timeout = setTimeout(focusInput, 0)

    const onViewportChange = () => updatePosition()
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timeout)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [open, updatePosition])

  React.useEffect(() => {
    if (highlightedIndex >= filteredItems.length) {
      setHighlightedIndex(Math.max(0, filteredItems.length - 1))
    }
  }, [filteredItems.length, highlightedIndex])

  React.useEffect(() => {
    if (!open || !listRef.current) return
    const selected = listRef.current.querySelector<HTMLElement>('[data-highlighted="true"]')
    selected?.scrollIntoView({ block: 'nearest' })
  }, [open, highlightedIndex, filteredItems.length])

  const handleToggle = React.useCallback((item: T) => {
    onToggle(item)
    if (closeOnSelect) onOpenChange(false)
  }, [onToggle, closeOnSelect, onOpenChange])

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (filteredItems.length === 0) return
      setHighlightedIndex(prev => (prev + 1) % filteredItems.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (filteredItems.length === 0) return
      setHighlightedIndex(prev => (prev - 1 + filteredItems.length) % filteredItems.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = filteredItems[highlightedIndex]
      if (item) handleToggle(item)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onOpenChange(false)
    }
  }

  if (!open || !position || typeof document === 'undefined') return null

  const hasItems = items.length > 0
  const hasResults = filteredItems.length > 0

  return ReactDOM.createPortal(
    <>
      <div
        className="fixed inset-0 z-floating-backdrop"
        onClick={() => onOpenChange(false)}
      />

      <div
        className="fixed z-floating-menu overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small"
        style={{
          top: position.top - 8,
          left: position.left,
          minWidth,
          maxWidth,
          transform: 'translateY(-100%)',
        }}
      >
        {!hasItems ? (
          <div className="p-3 text-xs text-muted-foreground select-none">
            {emptyState ?? 'No items configured.'}
          </div>
        ) : (
          <>
            <div className="border-b border-border/50 px-3 py-2">
              <input
                ref={inputRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder={resolvedPlaceholder}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground placeholder:select-none"
              />
            </div>

            <div ref={listRef} className="max-h-[240px] overflow-y-auto p-1">
              {!hasResults ? (
                <div className="px-3 py-2 text-xs text-muted-foreground select-none">
                  {noResultsState ?? 'No matching items.'}
                </div>
              ) : (
                filteredItems.map((item, index) => {
                  const selected = isSelected(item)
                  const highlighted = index === highlightedIndex
                  return (
                    <button
                      key={getKey(item)}
                      type="button"
                      data-highlighted={highlighted}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onClick={() => handleToggle(item)}
                      className={cn(
                        'w-full text-left outline-none',
                        !renderItem && 'flex cursor-pointer select-none items-center gap-3 rounded-[6px] px-3 py-2 text-[13px]',
                        highlighted && 'bg-foreground/5',
                        selected && 'bg-foreground/3',
                      )}
                    >
                      {renderItem
                        ? renderItem(item, { selected, highlighted }, index)
                        : <span className="truncate">{getLabel(item)}</span>}
                    </button>
                  )
                })
              )}
            </div>
          </>
        )}
      </div>
    </>,
    document.body
  )
}
