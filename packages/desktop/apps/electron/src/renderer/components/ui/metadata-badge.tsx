import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MetadataBadgeProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Primary label text */
  label: string
  /** Optional secondary value text */
  value?: string
  /** Optional leading icon */
  icon?: React.ReactNode
  /** Optional trailing hint icon when no value is set */
  valueHintIcon?: React.ReactNode
  /** Color tint source for chip background/text */
  badgeColor?: string
  /** Enable hover/click styling */
  interactive?: boolean
  /** Active/open state styling */
  isActive?: boolean
  /** Show dropdown chevron on the right */
  showChevron?: boolean
  /** Shadow style for the chip */
  shadow?: 'none' | 'minimal'
}

export const MetadataBadge = React.forwardRef<HTMLButtonElement, MetadataBadgeProps>(
  function MetadataBadge(
    {
      label,
      value,
      icon,
      valueHintIcon,
      badgeColor = 'var(--foreground)',
      interactive = false,
      isActive = false,
      showChevron = false,
      shadow = 'minimal',
      className,
      type = 'button',
      style,
      ...buttonProps
    },
    ref
  ) {
    return (
      <button
        ref={ref}
        type={type}
        {...buttonProps}
        className={cn(
          'h-[30px] pl-3 pr-4 text-xs font-medium rounded-[8px] flex items-center shrink-0',
          'outline-none select-none transition-colors',
          shadow === 'minimal' && 'shadow-minimal',
          'bg-[color-mix(in_srgb,var(--background)_97%,var(--badge-color))]',
          'text-[color-mix(in_srgb,var(--foreground)_80%,var(--badge-color))]',
          interactive && 'cursor-pointer hover:bg-[color-mix(in_srgb,var(--background)_92%,var(--badge-color))]',
          interactive && isActive && 'bg-[color-mix(in_srgb,var(--background)_92%,var(--badge-color))]',
          !interactive && 'cursor-default',
          className
        )}
        style={{ ...style, '--badge-color': badgeColor } as React.CSSProperties}
      >
        {icon}

        <span className={cn('whitespace-nowrap', icon ? 'ml-2' : '')}>{label}</span>

        {value ? (
          <>
            <span className="opacity-30 mx-1">·</span>
            <span className="opacity-60 whitespace-nowrap max-w-[140px] truncate">{value}</span>
          </>
        ) : (
          valueHintIcon && (
            <>
              <span className="opacity-30 mx-1">·</span>
              {valueHintIcon}
            </>
          )
        )}

        {showChevron && (
          <ChevronDown className="h-3 w-3 opacity-40 ml-1 shrink-0" />
        )}
      </button>
    )
  }
)
