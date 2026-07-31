/**
 * SettingsSegmentedControl
 *
 * Horizontal button group for selecting between options.
 * Ideal for theme selection, font selection, etc.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SettingsSegmentedOption<T extends string = string> {
  /** Value for this option */
  value: T
  /** Display label */
  label: string
  /** Optional icon */
  icon?: React.ReactNode
}

export interface SettingsSegmentedControlProps<T extends string = string> {
  /** Currently selected value */
  value: T
  /** Change handler */
  onValueChange: (value: T) => void
  /** Available options */
  options: SettingsSegmentedOption<T>[]
  /** Size variant */
  size?: 'sm' | 'md'
  /** Additional className */
  className?: string
}

/**
 * SettingsSegmentedControl - Horizontal button group
 *
 * @example
 * <SettingsSegmentedControl
 *   value={theme}
 *   onValueChange={setTheme}
 *   options={[
 *     { value: 'system', label: 'System', icon: <Monitor /> },
 *     { value: 'light', label: 'Light', icon: <Sun /> },
 *     { value: 'dark', label: 'Dark', icon: <Moon /> },
 *   ]}
 * />
 */
export function SettingsSegmentedControl<T extends string = string>({
  value,
  onValueChange,
  options,
  size = 'md',
  className,
}: SettingsSegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      className={cn('inline-flex gap-1', className)}
    >
      {options.map((option) => {
        const isSelected = option.value === value

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg transition-all',
              size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
              isSelected
                ? 'bg-background shadow-minimal'
                : 'bg-transparent hover:bg-foreground/5'
            )}
          >
            {option.icon && (
              <span
                className={cn(
                  'w-4 h-4',
                  isSelected ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {option.icon}
              </span>
            )}
            <span
              className={cn(
                isSelected ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * SettingsSegmentedControlCard - Card variant with individual backgrounds
 *
 * Each option is a small card (like Amie's app icon selector)
 */
export interface SettingsSegmentedCardOption<T extends string = string> {
  value: T
  label: string
  icon?: React.ReactNode
}

export interface SettingsSegmentedControlCardProps<T extends string = string> {
  value: T
  onValueChange: (value: T) => void
  options: SettingsSegmentedCardOption<T>[]
  /** Number of columns */
  columns?: 2 | 3 | 4
  className?: string
}

export function SettingsSegmentedControlCard<T extends string = string>({
  value,
  onValueChange,
  options,
  columns = 3,
  className,
}: SettingsSegmentedControlCardProps<T>) {
  return (
    <div
      role="radiogroup"
      className={cn(
        'grid gap-2',
        columns === 2 && 'grid-cols-2',
        columns === 3 && 'grid-cols-3',
        columns === 4 && 'grid-cols-4',
        className
      )}
    >
      {options.map((option) => {
        const isSelected = option.value === value

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'flex items-center gap-2 px-3 py-2.5 rounded-xl transition-colors text-left',
              isSelected ? 'bg-muted' : 'bg-muted/50 hover:bg-muted/70'
            )}
          >
            {/* Radio indicator */}
            <div
              className={cn(
                'w-[16px] h-[16px] rounded-full border-2 shrink-0',
                'flex items-center justify-center transition-colors',
                isSelected
                  ? 'border-foreground bg-foreground'
                  : 'border-muted-foreground/40'
              )}
            >
              {isSelected && (
                <div className="w-[6px] h-[6px] rounded-full bg-background" />
              )}
            </div>

            {/* Label */}
            <span className="text-sm">{option.label}</span>

            {/* Icon on right */}
            {option.icon && (
              <span className="ml-auto shrink-0">{option.icon}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
