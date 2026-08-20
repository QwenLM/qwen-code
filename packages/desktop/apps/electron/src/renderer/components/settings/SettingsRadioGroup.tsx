/**
 * SettingsRadioGroup & SettingsRadioCard
 *
 * Full-width radio card selection pattern (Amie-style).
 * Each option is a separate card with radio indicator on the left.
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { cn } from '@/lib/utils'
import { settingsUI } from './SettingsUIConstants'

// ============================================
// Context
// ============================================

interface RadioGroupContextValue {
  value: string
  onValueChange: (value: string) => void
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null)

function useRadioGroupContext() {
  return React.useContext(RadioGroupContext)
}

// ============================================
// SettingsRadioGroup
// ============================================

export interface SettingsRadioGroupProps<T extends string = string> {
  /** Currently selected value */
  value: T
  /** Change handler */
  onValueChange: (value: T) => void
  /** Radio cards */
  children: React.ReactNode
  /** Additional className */
  className?: string
}

/**
 * SettingsRadioGroup - Container for radio card options
 *
 * @example
 * <SettingsRadioGroup value={model} onValueChange={setModel}>
 *   <SettingsRadioCard value="opus" label="Opus 4.6" description="Most capable" />
 *   <SettingsRadioCard value="sonnet" label="Sonnet 4.6" description="Balanced" />
 * </SettingsRadioGroup>
 */
export function SettingsRadioGroup<T extends string = string>({
  value,
  onValueChange,
  children,
  className,
}: SettingsRadioGroupProps<T>) {
  const childArray = React.Children.toArray(children).filter(Boolean)

  return (
    <RadioGroupContext.Provider
      value={{
        value,
        onValueChange: onValueChange as (value: string) => void,
      }}
    >
      <div
        role="radiogroup"
        className={cn(
          'rounded-xl bg-background shadow-minimal overflow-hidden',
          className
        )}
      >
        {childArray.map((child, index) => (
          <React.Fragment key={index}>
            {index > 0 && <div className="h-px bg-border/50 mx-4" />}
            {child}
          </React.Fragment>
        ))}
      </div>
    </RadioGroupContext.Provider>
  )
}

// ============================================
// SettingsRadioCard
// ============================================

export interface SettingsRadioCardProps {
  /** Value for this option */
  value: string
  /** Option label */
  label: string
  /** Optional description below label */
  description?: string
  /** Optional icon on the right */
  icon?: React.ReactNode
  /** Optional badge (e.g., "Active", "Beta") */
  badge?: React.ReactNode
  /** Disabled state */
  disabled?: boolean
  /** Content to show when this option is selected */
  expandedContent?: React.ReactNode
  /** Additional className */
  className?: string
  /** Standalone mode: whether this option is selected (use instead of RadioGroup) */
  selected?: boolean
  /** Standalone mode: click handler (use instead of RadioGroup) */
  onClick?: () => void
  /** When true, disables card styling (use when inside a SettingsCard) */
  inCard?: boolean
}

/**
 * SettingsRadioCard - Full-width radio option card
 *
 * @example
 * <SettingsRadioCard
 *   value="api_key"
 *   label="API Key"
 *   description="Use your local Qwen Code setup"
 *   expandedContent={<ApiKeyInput />}
 * />
 */
export function SettingsRadioCard({
  value,
  label,
  description,
  icon,
  badge,
  disabled,
  expandedContent,
  className,
  selected,
  onClick,
  inCard,
}: SettingsRadioCardProps) {
  const context = useRadioGroupContext()
  // Support both context-based and standalone usage
  const isSelected = context ? context.value === value : (selected ?? false)
  const handleClick = context ? () => context.onValueChange(value) : onClick
  const id = React.useId()

  // Apply card styling only in standalone mode and not inside a SettingsCard
  const needsCardStyling = !context && !inCard

  return (
    <div
      className={cn(
        'overflow-hidden transition-colors',
        needsCardStyling && 'rounded-xl shadow-minimal bg-background',
        !disabled && 'hover:bg-foreground-3',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
    >
      <button
        type="button"
        role="radio"
        id={id}
        aria-checked={isSelected}
        disabled={disabled}
        onClick={() => !disabled && handleClick?.()}
        className={cn(
          'w-full px-4 py-3.5 text-left flex items-start gap-3',
          !disabled && 'cursor-pointer'
        )}
      >
        {/* Radio circle */}
        <div
          className={cn(
            'w-4 h-4 rounded-full border-[1.5px] mt-[3px] shrink-0',
            'grid place-items-center transition-colors',
            isSelected
              ? 'border-foreground bg-foreground'
              : 'border-muted-foreground/40'
          )}
        >
          {isSelected && (
            <div className="w-2 h-2 rounded-full bg-background" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={settingsUI.label}>{label}</span>
            {badge}
          </div>
          {description && (
            <div className={cn(settingsUI.description, settingsUI.labelDescriptionGap)}>
              {description}
            </div>
          )}
        </div>

        {/* Right icon */}
        {icon && <div className="shrink-0 ml-2">{icon}</div>}
      </button>

      {/* Expanded content */}
      <AnimatePresence initial={false}>
        {isSelected && expandedContent && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 40 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-0">
              <div className="pl-[30px]">{expandedContent}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ============================================
// SettingsRadioOption (Simpler inline variant)
// ============================================

export interface SettingsRadioOptionProps {
  /** Value for this option */
  value: string
  /** Option label */
  label: string
  /** Optional description (inline, after separator) */
  description?: string
  /** Disabled state */
  disabled?: boolean
  /** Additional className */
  className?: string
}

/**
 * SettingsRadioOption - Simple inline radio option (no card background)
 *
 * Use inside a SettingsCard for grouped options without individual backgrounds.
 */
export function SettingsRadioOption({
  value,
  label,
  description,
  disabled,
  className,
}: SettingsRadioOptionProps) {
  const context = useRadioGroupContext()
  if (!context) {
    throw new Error('SettingsRadioOption must be used within SettingsRadioGroup')
  }
  const { value: selectedValue, onValueChange } = context
  const isSelected = selectedValue === value
  const id = React.useId()

  return (
    <button
      type="button"
      role="radio"
      id={id}
      aria-checked={isSelected}
      disabled={disabled}
      onClick={() => !disabled && onValueChange(value)}
      className={cn(
        'w-full px-4 py-3 text-left flex items-center gap-3',
        'hover:bg-muted/50 transition-colors',
        disabled && 'opacity-50 cursor-not-allowed',
        !disabled && 'cursor-pointer',
        className
      )}
    >
      {/* Radio circle */}
      <div
        className={cn(
          'w-4 h-4 rounded-full border-[1.5px] shrink-0',
          'grid place-items-center transition-colors',
          isSelected
            ? 'border-foreground bg-foreground'
            : 'border-muted-foreground/40'
        )}
      >
        {isSelected && (
          <div className="w-2 h-2 rounded-full bg-background" />
        )}
      </div>

      {/* Label */}
      <div className="flex-1 min-w-0 flex items-center">
        <span className="text-sm">{label}</span>
        {description && (
          <span className="text-sm text-muted-foreground ml-1.5">
            · {description}
          </span>
        )}
      </div>
    </button>
  )
}
