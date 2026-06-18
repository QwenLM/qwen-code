/**
 * Info_Alert
 *
 * Warning/error/info/success alert boxes with compound Title/Description.
 */

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const alertVariants = cva('rounded-[8px] border', {
  variants: {
    variant: {
      warning: 'bg-foreground/5 border-border/50',
      error: 'bg-destructive/5 border-destructive/30',
      info: 'bg-info/5 border-info/30',
      success: 'bg-success/5 border-success/30',
    },
    inline: {
      true: 'px-4 py-2',
      false: 'px-4 py-3',
    },
  },
  defaultVariants: {
    variant: 'warning',
    inline: false,
  },
})

export interface Info_AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  /** Optional leading icon */
  icon?: React.ReactNode
}

function Info_AlertRoot({
  variant,
  inline,
  icon,
  className,
  children,
  ...props
}: Info_AlertProps) {
  return (
    <div className={cn(alertVariants({ variant, inline }), className)} {...props}>
      <div className="flex items-start gap-2 text-sm">
        {icon && (
          <span className="shrink-0 mt-0.5 text-muted-foreground">{icon}</span>
        )}
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  )
}

function Info_AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('font-medium', className)} {...props} />
}

function Info_AlertDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-foreground/60 mt-0.5', className)} {...props} />
}

export const Info_Alert = Object.assign(Info_AlertRoot, {
  Title: Info_AlertTitle,
  Description: Info_AlertDescription,
})
