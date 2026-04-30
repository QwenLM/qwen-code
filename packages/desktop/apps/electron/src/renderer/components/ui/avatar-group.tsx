/**
 * AvatarGroup - Display overlapping avatars with overflow indicator
 *
 * Shows up to `max` avatars with slight overlap, plus a "+N" badge for overflow.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

interface AvatarGroupProps {
  children: React.ReactNode
  max?: number  // Max avatars to show before "+N" indicator
  className?: string
}

export function AvatarGroup({ children, max = 3, className }: AvatarGroupProps) {
  const childArray = React.Children.toArray(children)
  const shown = childArray.slice(0, max)
  const overflow = childArray.length - max

  return (
    <div className={cn("flex -space-x-1.5", className)}>
      {shown.map((child, i) => (
        <div key={i} className="ring-1 ring-background rounded-full">
          {child}
        </div>
      ))}
      {overflow > 0 && (
        <div className="flex items-center justify-center h-4 w-4 rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-1 ring-background">
          +{overflow}
        </div>
      )}
    </div>
  )
}
