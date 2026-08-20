/**
 * PhaseBadge
 *
 * Colored badge indicating the phase/timing of an automation trigger event.
 * Derives from getEventCategory() to avoid duplicating event classification.
 */

import { getEventCategory, type AutomationTrigger, type EventCategory } from './types'
import { Info_Badge, type BadgeColor } from '@/components/info'

const CATEGORY_BADGE: Record<EventCategory, { label: string; color: BadgeColor }> = {
  'scheduled':   { label: 'Scheduled', color: 'success' },
  'agent-pre':   { label: 'Before',    color: 'warning' },
  'agent-post':  { label: 'After',     color: 'success' },
  'agent-error': { label: 'On Error',  color: 'destructive' },
  'label':       { label: 'Event',     color: 'default' },
  'permission':  { label: 'Event',     color: 'default' },
  'flag':        { label: 'Event',     color: 'default' },
  'todo':        { label: 'Event',     color: 'default' },
  'session':     { label: 'Event',     color: 'default' },
  'other':       { label: 'Event',     color: 'default' },
}

export interface PhaseBadgeProps {
  event: AutomationTrigger
  className?: string
}

export function PhaseBadge({ event, className }: PhaseBadgeProps) {
  const category = getEventCategory(event)
  const badge = CATEGORY_BADGE[category]

  return (
    <Info_Badge color={badge.color} className={className}>
      {badge.label}
    </Info_Badge>
  )
}
