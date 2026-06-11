import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { FadingText } from '@/components/ui/fading-text'
import { cn } from '@/lib/utils'

export interface FreeFormInputContextBadgeProps {
  /** Left area - fully customizable (icon, avatar stack, etc.) */
  icon: React.ReactNode
  /** Label text - shown in expanded state or collapsed with selection */
  label: string
  /** Whether to show expanded state (icon + label + chevron) vs collapsed */
  isExpanded?: boolean
  /** Whether there's an active selection (affects collapsed state styling and shows label) */
  hasSelection?: boolean
  /** Show chevron indicator (for dropdowns) - only visible in expanded state */
  showChevron?: boolean
  /** Click handler */
  onClick?: () => void
  /** Tooltip content - can be string or ReactNode for rich content */
  tooltip?: React.ReactNode
  /** Whether the badge is currently "open" (e.g., dropdown is shown) */
  isOpen?: boolean
  /** Whether the badge is disabled */
  disabled?: boolean
  /** Additional className for the button */
  className?: string
  /** Ref forwarding for positioning dropdowns */
  buttonRef?: React.RefObject<HTMLButtonElement>
  /** Data attribute for tutorials */
  'data-tutorial'?: string
}

/**
 * FreeFormInputContextBadge - Unified context badge for Sources, Files, and Folder selectors
 *
 * Visual States:
 * - Expanded: Icon + Label + Chevron, no background, hover shows background
 * - Collapsed (no selection): Icon only, no background, hover shows background
 * - Collapsed (has selection): Icon + Label (fading), bg-background + shadow-minimal
 * - Open: bg-foreground/5 (like hover)
 */
export const FreeFormInputContextBadge = React.forwardRef<HTMLButtonElement, FreeFormInputContextBadgeProps>(
  function FreeFormInputContextBadge(
    {
      icon,
      label,
      isExpanded = false,
      hasSelection = false,
      showChevron = false,
      onClick,
      tooltip,
      isOpen = false,
      disabled = false,
      className,
      buttonRef,
      'data-tutorial': dataTutorial,
    },
    ref
  ) {
    // Merge refs if both are provided
    const mergedRef = buttonRef || ref

    // Show label in expanded state OR in collapsed state with selection
    const showLabel = isExpanded || hasSelection

    const button = (
      <button
        ref={mergedRef as React.Ref<HTMLButtonElement>}
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        data-tutorial={dataTutorial}
        className={cn(
          // Base styles - shrink + min-w-0 allows badge to compress in tight layouts
          "input-toolbar-btn inline-flex items-center gap-1.5 h-7 rounded-[6px] text-[13px] text-foreground transition-colors select-none shrink min-w-0",
          "disabled:opacity-50 disabled:pointer-events-none",
          // Padding: more padding when showing label
          showLabel ? "px-2" : "px-1.5",
          // Collapsed with selection: visible background + thin 1px border + margin
          !isExpanded && hasSelection && "bg-background border border-foreground/5 mx-0.5",
          // Hover state (when not already showing background from selection)
          !(!isExpanded && hasSelection) && "hover:bg-foreground/5",
          // Open state (dropdown shown)
          isOpen && "bg-foreground/5",
          className
        )}
      >
        {/* Icon area */}
        <span className="shrink-0 flex items-center">
          {icon}
        </span>

        {/* Label - in expanded state or collapsed with selection */}
        {showLabel && (
          isExpanded ? (
            // Expanded: simple truncate, placeholder (no selection) gets 60% opacity
            <span className={cn("truncate max-w-[120px] min-w-0 shrink", !hasSelection && "opacity-50")}>
              {label}
            </span>
          ) : (
            // Collapsed with selection: fading text with max width
            <FadingText className="max-w-[140px] min-w-0 shrink" fadeWidth={20}>
              {label}
            </FadingText>
          )
        )}

        {/* Optional chevron - only in expanded state */}
        {isExpanded && showChevron && (
          <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
        )}
      </button>
    )

    // Wrap with tooltip if provided (skip when dropdown is open to avoid showing tooltip)
    if (tooltip && !isOpen) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            {button}
          </TooltipTrigger>
          <TooltipContent side="top">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      )
    }

    return button
  }
)
