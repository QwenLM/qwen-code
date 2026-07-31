import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { SourceAvatar } from '@/components/ui/source-avatar'
import type { LoadedSkill, LoadedSource } from '../../../shared/types'
import type { MentionItemType } from './mention-menu'

// ============================================================================
// Types
// ============================================================================

export interface MentionBadgeProps {
  type: MentionItemType
  label: string
  /** Skill data for skill mentions */
  skill?: LoadedSkill
  /** Source data for source mentions */
  source?: LoadedSource
  /** Workspace ID for skill avatar */
  workspaceId?: string
  /** Called when the remove button is clicked */
  onRemove?: () => void
  /** Additional className */
  className?: string
}

// ============================================================================
// MentionBadge Component
// ============================================================================

/**
 * MentionBadge - Inline badge for displaying active @mentions
 *
 * Used in the ActiveMentionBadges row above the input field to show
 * skills and sources that have been mentioned via @.
 */
export function MentionBadge({
  type,
  label,
  skill,
  source,
  workspaceId,
  onRemove,
  className,
}: MentionBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 h-6 pl-1 pr-1.5 rounded-[6px]',
        'bg-foreground/5 text-[12px] text-foreground',
        'transition-colors hover:bg-foreground/8',
        className
      )}
    >
      {/* Icon based on type */}
      {type === 'skill' && skill && (
        <SkillAvatar skill={skill} size="xs" workspaceId={workspaceId} />
      )}
      {type === 'source' && source && (
        <SourceAvatar source={source} size="xs" />
      )}

      {/* Label */}
      <span className="truncate max-w-[100px]">{label}</span>

      {/* Remove button */}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="shrink-0 h-4 w-4 rounded-[3px] flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

// ============================================================================
// ActiveMentionBadges Component
// ============================================================================

export interface ParsedMention {
  id: string
  type: MentionItemType
  label: string
  skill?: LoadedSkill
  source?: LoadedSource
}

export interface ActiveMentionBadgesProps {
  /** Parsed mentions to display */
  mentions: ParsedMention[]
  /** Workspace ID for skill avatars */
  workspaceId?: string
  /** Called when a mention is removed */
  onRemove?: (id: string, type: MentionItemType) => void
  /** Additional className for the container */
  className?: string
}

/**
 * ActiveMentionBadges - Row of mention badges shown above the input
 *
 * Displays all active @mentions (skills and sources) as removable badges.
 * Hidden when there are no mentions.
 */
export function ActiveMentionBadges({
  mentions,
  workspaceId,
  onRemove,
  className,
}: ActiveMentionBadgesProps) {
  if (mentions.length === 0) return null

  return (
    <div className={cn('flex flex-wrap gap-1 px-4 pt-2', className)}>
      {mentions.map((mention) => (
        <MentionBadge
          key={`${mention.type}-${mention.id}`}
          type={mention.type}
          label={mention.label}
          skill={mention.skill}
          source={mention.source}
          workspaceId={workspaceId}
          onRemove={onRemove ? () => onRemove(mention.id, mention.type) : undefined}
        />
      ))}
    </div>
  )
}
