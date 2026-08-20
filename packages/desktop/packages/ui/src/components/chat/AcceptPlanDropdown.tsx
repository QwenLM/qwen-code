import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as ReactDOM from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * AcceptPlanDropdown - Dropdown for accepting plans with or without compaction
 *
 * Provides two options:
 * 1. Accept - Execute the plan immediately
 * 2. Accept & Compact - Summarize conversation first, then execute
 *
 * The compact option is useful when context is running low after a long planning session.
 */

interface AcceptPlanDropdownProps {
  /** Callback when user selects "Accept" (execute immediately) */
  onAccept: () => void
  /** Callback when user selects "Accept & Compact" (compact first, then execute) */
  onAcceptWithCompact: () => void
  /** Trigger label */
  acceptLabel?: string
  /** Primary dropdown option label */
  acceptOptionLabel?: string
  /** Additional className for the trigger button */
  className?: string
}

export function AcceptPlanDropdown({
  onAccept,
  onAcceptWithCompact,
  acceptLabel,
  acceptOptionLabel,
  className,
}: AcceptPlanDropdownProps) {
  const { t } = useTranslation()
  const effectiveAcceptLabel = acceptLabel ?? t('plan.acceptPlan')
  const effectiveAcceptOptionLabel = acceptOptionLabel ?? t('plan.accept')
  const [isOpen, setIsOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Calculate menu position relative to trigger
  // Prefers below the button, falls back to above if insufficient space
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return

    const rect = triggerRef.current.getBoundingClientRect()
    const menuWidth = 280
    const menuHeight = 120 // Approximate height for 2 items with subtitles
    const gap = 4

    // Check if there's enough space below the button
    const spaceBelow = window.innerHeight - rect.bottom
    const top = spaceBelow >= menuHeight + gap
      ? rect.bottom + gap  // Position below
      : rect.top - menuHeight - gap  // Position above

    let left = rect.right - menuWidth
    // Keep menu within viewport horizontally
    if (left < 8) left = 8
    if (left + menuWidth > window.innerWidth - 8) {
      left = window.innerWidth - menuWidth - 8
    }

    setPosition({ top, left })
  }, [])

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()

    if (!isOpen) {
      // Calculate position before opening
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect()
        const menuWidth = 280
        const menuHeight = 120
        const gap = 4
        // Prefer below, fall back to above if no space
        const spaceBelow = window.innerHeight - rect.bottom
        const top = spaceBelow >= menuHeight + gap
          ? rect.bottom + gap
          : rect.top - menuHeight - gap
        let left = rect.right - menuWidth
        if (left < 8) left = 8
        if (left + menuWidth > window.innerWidth - 8) {
          left = window.innerWidth - menuWidth - 8
        }
        setPosition({ top, left })
      }
    }
    setIsOpen(prev => !prev)
  }, [isOpen])

  const handleClose = useCallback(() => {
    setIsOpen(false)
  }, [])

  // Handle option selection
  const handleSelectAccept = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    handleClose()
    onAccept()
  }, [handleClose, onAccept])

  const handleSelectCompact = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    handleClose()
    onAcceptWithCompact()
  }, [handleClose, onAcceptWithCompact])

  // Update position when opening
  useEffect(() => {
    if (isOpen) {
      updatePosition()
    }
  }, [isOpen, updatePosition])

  // Click outside detection
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

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen, handleClose])

  return (
    <>
      {/* Trigger button - matches existing Accept Plan button styling */}
      <div
        ref={triggerRef}
        onClick={handleToggle}
        className="inline-flex"
      >
        <button
          type="button"
          className={cn(
            "h-[28px] pl-2.5 pr-2 text-xs font-medium rounded-[6px] flex items-center gap-1.5 transition-all",
            "bg-success/5 text-success hover:bg-success/10 shadow-tinted",
            className
          )}
          style={{ '--shadow-color': '34, 136, 82' } as React.CSSProperties}
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 25 24" fill="currentColor">
            <path fillRule="nonzero" d="M13.7207031,22.6523438 C13.264974,22.6523438 12.9361979,22.4895833 12.734375,22.1640625 C12.5325521,21.8385417 12.360026,21.4316406 12.2167969,20.9433594 L10.6640625,15.7871094 C10.5729167,15.4615885 10.5403646,15.1995443 10.5664062,15.0009766 C10.5924479,14.8024089 10.6998698,14.6022135 10.8886719,14.4003906 L20.859375,3.6484375 C20.9179688,3.58984375 20.9472656,3.52473958 20.9472656,3.453125 C20.9472656,3.38151042 20.921224,3.32291667 20.8691406,3.27734375 C20.8170573,3.23177083 20.7568359,3.20735677 20.6884766,3.20410156 C20.6201172,3.20084635 20.5566406,3.22851562 20.4980469,3.28710938 L9.78515625,13.296875 C9.5703125,13.4921875 9.36197917,13.601237 9.16015625,13.6240234 C8.95833333,13.6468099 8.70117188,13.609375 8.38867188,13.5117188 L3.11523438,11.9101562 C2.64648438,11.7669271 2.25911458,11.5960286 1.953125,11.3974609 C1.64713542,11.1988932 1.49414062,10.875 1.49414062,10.4257812 C1.49414062,10.0742188 1.63411458,9.77148438 1.9140625,9.51757812 C2.19401042,9.26367188 2.5390625,9.05859375 2.94921875,8.90234375 L19.7460938,2.46679688 C19.9739583,2.38216146 20.1871745,2.31542969 20.3857422,2.26660156 C20.5843099,2.21777344 20.764974,2.19335938 20.9277344,2.19335938 C21.2467448,2.19335938 21.4973958,2.28450521 21.6796875,2.46679688 C21.8619792,2.64908854 21.953125,2.89973958 21.953125,3.21875 C21.953125,3.38802083 21.9287109,3.5703125 21.8798828,3.765625 C21.8310547,3.9609375 21.7643229,4.17252604 21.6796875,4.40039062 L15.2832031,21.109375 C15.1009115,21.578125 14.8828125,21.952474 14.6289062,22.2324219 C14.375,22.5123698 14.0722656,22.6523438 13.7207031,22.6523438 Z" />
          </svg>
          <span>{effectiveAcceptLabel}</span>
          <ChevronDown className={cn(
            "h-3 w-3 transition-transform duration-150",
            isOpen && "rotate-180"
          )} />
        </button>
      </div>

      {/* Dropdown menu - rendered via portal */}
      {isOpen && position && ReactDOM.createPortal(
        <div
          ref={menuRef}
          className={cn(
            "fixed z-50 min-w-[280px] p-1.5",
            "bg-background rounded-[8px] shadow-strong border border-border/50",
            "animate-in fade-in-0 zoom-in-95 duration-100"
          )}
          style={{ top: position.top, left: position.left }}
        >
          {/* Option 1: Accept (execute immediately) */}
          <button
            type="button"
            onClick={handleSelectAccept}
            className={cn(
              "flex flex-col w-full px-3 py-2 text-left rounded-[6px]",
              "hover:bg-foreground/[0.05] focus:bg-foreground/[0.05] focus:outline-none",
              "transition-colors"
            )}
          >
            <span className="text-[13px] font-medium">{effectiveAcceptOptionLabel}</span>
            <span className="text-xs text-muted-foreground">
              {t('plan.executeImmediately')}
            </span>
          </button>

          {/* Option 2: Accept & Compact */}
          <button
            type="button"
            onClick={handleSelectCompact}
            className={cn(
              "flex flex-col w-full px-3 py-2 text-left rounded-[6px]",
              "hover:bg-foreground/[0.05] focus:bg-foreground/[0.05] focus:outline-none",
              "transition-colors"
            )}
          >
            <span className="text-[13px] font-medium">{t('plan.acceptAndCompact')}</span>
            <span className="text-xs text-muted-foreground">
              {t('plan.worksForComplex')}
            </span>
          </button>
        </div>,
        document.body
      )}
    </>
  )
}
