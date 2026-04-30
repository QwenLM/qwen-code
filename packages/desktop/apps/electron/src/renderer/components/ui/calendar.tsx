/**
 * Calendar - Date picker calendar based on react-day-picker v9.
 *
 * Adapted from the official shadcn/ui Calendar component.
 * Supports single/range selection and dropdown month/year navigation.
 */

import * as React from 'react'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { DayButton, DayPicker, getDefaultClassNames } from 'react-day-picker'

import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = 'label',
  formatters,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  const defaultClassNames = getDefaultClassNames()

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      captionLayout={captionLayout}
      formatters={{
        // Show short month names in the dropdown (Jan, Feb, ...)
        formatMonthDropdown: (date) =>
          date.toLocaleString('default', { month: 'short' }),
        ...formatters,
      }}
      className={cn(
        'bg-background p-3 [--cell-size:2rem]',
        className
      )}
      classNames={{
        root: cn('w-full', defaultClassNames.root),
        months: cn(
          'relative flex flex-col gap-4 md:flex-row',
          defaultClassNames.months
        ),
        month: cn('relative flex w-full flex-col gap-4', defaultClassNames.month),
        nav: cn(
          'absolute inset-x-0 top-1.5 flex h-[--cell-size] w-full items-center justify-between gap-1',
          defaultClassNames.nav
        ),
        button_previous: cn(
          buttonVariants({ variant: 'ghost' }),
          'h-[--cell-size] w-[--cell-size] select-none p-0 aria-disabled:opacity-50',
          defaultClassNames.button_previous
        ),
        button_next: cn(
          buttonVariants({ variant: 'ghost' }),
          'h-[--cell-size] w-[--cell-size] select-none p-0 aria-disabled:opacity-50',
          defaultClassNames.button_next
        ),
        month_caption: cn(
          'flex h-[--cell-size] w-full items-center justify-center px-[--cell-size]',
          defaultClassNames.month_caption
        ),
        // Dropdown container for month/year selectors
        dropdowns: cn(
          'flex h-[--cell-size] w-full items-center justify-center gap-1.5 text-sm font-medium',
          defaultClassNames.dropdowns
        ),
        // Individual dropdown wrapper (month or year)
        dropdown_root: cn(
          'relative rounded-[5px] shadow-minimal',
          defaultClassNames.dropdown_root
        ),
        // The native <select> is visually hidden; the caption_label shows the displayed value
        dropdown: cn('absolute inset-0 opacity-0 cursor-pointer', defaultClassNames.dropdown),
        caption_label: cn(
          'select-none font-medium',
          captionLayout === 'label'
            ? 'text-sm'
            : 'flex h-7 items-center gap-1 rounded-md pl-2 pr-1 text-sm [&>svg]:text-foreground/40 [&>svg]:size-3.5',
          defaultClassNames.caption_label
        ),
        table: 'w-full border-collapse',
        weekdays: cn('flex', defaultClassNames.weekdays),
        weekday: cn(
          'text-foreground/40 flex-1 select-none rounded-md text-[0.8rem] font-normal',
          defaultClassNames.weekday
        ),
        week: cn('mt-2 flex w-full', defaultClassNames.week),
        day: cn(
          'relative flex-1 p-0 text-center select-none',
          defaultClassNames.day
        ),
        today: cn(
          'bg-foreground/5 rounded-md',
          defaultClassNames.today
        ),
        outside: cn(
          'text-foreground/25 aria-selected:text-foreground/40',
          defaultClassNames.outside
        ),
        disabled: cn(
          'text-foreground/25 opacity-50',
          defaultClassNames.disabled
        ),
        hidden: cn('invisible', defaultClassNames.hidden),
        ...classNames,
      }}
      components={{
        Chevron: ({ className, orientation, ...props }) => {
          if (orientation === 'left') {
            return <ChevronLeftIcon className={cn('size-4', className)} {...props} />
          }
          if (orientation === 'right') {
            return <ChevronRightIcon className={cn('size-4', className)} {...props} />
          }
          // Down chevron used in dropdown caption labels
          return <ChevronDownIcon className={cn('size-3.5', className)} {...props} />
        },
        DayButton: CalendarDayButton,
      }}
      {...props}
    />
  )
}

/**
 * CalendarDayButton - Individual day cell button.
 * Uses flex sizing to fill the parent cell, with proper selection/focus states.
 */
function CalendarDayButton({
  className,
  day,
  modifiers,
  ...props
}: React.ComponentProps<typeof DayButton>) {
  const ref = React.useRef<HTMLButtonElement>(null)

  // Focus the button when react-day-picker marks it as focused (keyboard nav)
  React.useEffect(() => {
    if (modifiers.focused) {
      ref.current?.focus()
    }
  }, [modifiers.focused])

  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex items-center justify-center rounded-md text-sm',
        // Fill the cell: flexible width, fixed min size from CSS var
        'h-[--cell-size] w-full min-w-[--cell-size] select-none',
        'hover:bg-foreground/5 transition-colors cursor-pointer',
        // Selection state from modifiers
        modifiers.selected && 'bg-background shadow-minimal font-medium',
        'outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className
      )}
      {...props}
    />
  )
}

export { Calendar }
