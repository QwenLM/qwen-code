/**
 * AutomationAvatar
 *
 * Small icon component that visually categorizes automations by event type.
 * Uses colored backgrounds with matching Lucide icons.
 */

import * as React from 'react'
import {
  Clock,
  Tag,
  Shield,
  Flag,
  ListChecks,
  Zap,
  CheckCircle2,
  AlertTriangle,
  MessageSquare,
  Webhook,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getEventCategory, type AutomationTrigger, type EventCategory } from './types'

// ============================================================================
// Size Configuration
// ============================================================================

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg'

const sizeConfig: Record<AvatarSize, { container: string; icon: string }> = {
  xs: { container: 'h-3.5 w-3.5', icon: 'h-2 w-2' },
  sm: { container: 'h-4 w-4', icon: 'h-2.5 w-2.5' },
  md: { container: 'h-5 w-5', icon: 'h-3 w-3' },
  lg: { container: 'h-6 w-6', icon: 'h-3.5 w-3.5' },
}

// ============================================================================
// Event → Icon + Color Mapping
// ============================================================================

const categoryConfig: Record<EventCategory, { icon: React.ElementType; bg: string; text: string }> = {
  scheduled:    { icon: Clock,          bg: 'bg-success/10',      text: 'text-success' },
  label:        { icon: Tag,            bg: 'bg-accent/10',       text: 'text-accent' },
  permission:   { icon: Shield,         bg: 'bg-warning/10',      text: 'text-warning' },
  flag:         { icon: Flag,           bg: 'bg-info/10',         text: 'text-info' },
  todo:         { icon: ListChecks,     bg: 'bg-info/10',         text: 'text-info' },
  'agent-pre':  { icon: Zap,            bg: 'bg-warning/10',      text: 'text-warning' },
  'agent-post': { icon: CheckCircle2,   bg: 'bg-success/10',      text: 'text-success' },
  'agent-error':{ icon: AlertTriangle,  bg: 'bg-destructive/10',  text: 'text-destructive' },
  session:      { icon: MessageSquare,  bg: 'bg-foreground/10',   text: 'text-foreground/70' },
  other:        { icon: Webhook,        bg: 'bg-foreground/10',   text: 'text-foreground/70' },
}

// ============================================================================
// Component
// ============================================================================

export interface AutomationAvatarProps {
  event: AutomationTrigger
  size?: AvatarSize
  /** Fill parent container (h-full w-full). Overrides size. */
  fluid?: boolean
  className?: string
}

export function AutomationAvatar({ event, size = 'md', fluid, className }: AutomationAvatarProps) {
  const category = getEventCategory(event)
  const config = categoryConfig[category]
  const sizes = sizeConfig[size]
  const Icon = config.icon

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-[4px] ring-1 ring-border/30 shrink-0',
        fluid ? 'h-full w-full' : sizes.container,
        config.bg,
        className
      )}
    >
      <Icon className={cn(fluid ? 'h-[60%] w-[60%]' : sizes.icon, config.text)} />
    </span>
  )
}
