import * as React from 'react'
import { cn } from '@/lib/utils'

interface TableProps extends React.ComponentProps<'table'> {
  /** Skip the wrapper div with overflow-x-auto (required for sticky headers) */
  noWrapper?: boolean
}

function Table({ className, noWrapper, ...props }: TableProps) {
  const table = (
    <table
      className={cn('w-full caption-bottom text-sm border-separate border-spacing-0', className)}
      {...props}
    />
  )

  if (noWrapper) {
    return table
  }

  return (
    <div className="relative w-full overflow-x-auto">
      {table}
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <thead
      className={cn('', className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      className={cn(
        'bg-muted/50 border-t font-medium [&>tr]:last:border-b-0',
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      className={cn(
        'transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  // Use bg-card for sticky headers - it's always opaque unlike bg-background which may have transparency in scenic mode
  return (
    <th
      className={cn(
        'relative p-1.5 text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0 sticky top-0 z-10 shadow-bottom-border bg-card',
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      className={cn(
        'p-1.5 align-middle [&:has([role=checkbox])]:pr-0 shadow-bottom-border-thin',
        className
      )}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
