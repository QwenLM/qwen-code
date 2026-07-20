/**
 * @deprecated This file is deprecated. Use mention-menu.tsx instead.
 * The unified mention menu supports both skills and sources with type badges.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import type { LoadedSkill } from '../../../shared/types'

// ============================================================================
// Types
// ============================================================================

export interface InlineSkillMentionProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  skills: LoadedSkill[]
  onSelect: (slug: string) => void
  filter?: string
  position: { x: number; y: number }
  workspaceId?: string
  className?: string
}

// ============================================================================
// Shared Styles (matching slash-command-menu)
// ============================================================================

const MENU_CONTAINER_STYLE = 'min-w-[240px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small'
const MENU_LIST_STYLE = 'max-h-[240px] overflow-y-auto p-1'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-3 rounded-[6px] px-3 py-2 text-[13px]'
const MENU_ITEM_SELECTED = 'bg-foreground/5'

// ============================================================================
// Filter skills utility
// ============================================================================

function filterSkills(skills: LoadedSkill[], filter: string): LoadedSkill[] {
  if (!filter) return skills
  const lowerFilter = filter.toLowerCase()
  return skills.filter(
    skill =>
      skill.slug.toLowerCase().includes(lowerFilter) ||
      skill.metadata.name.toLowerCase().includes(lowerFilter)
  )
}

// ============================================================================
// InlineSkillMention - Autocomplete that follows cursor
// ============================================================================

export function InlineSkillMention({
  open,
  onOpenChange,
  skills,
  onSelect,
  filter = '',
  position,
  workspaceId,
  className,
}: InlineSkillMentionProps) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const filteredSkills = filterSkills(skills, filter)

  // Reset selection when filter changes
  React.useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // Keyboard navigation
  React.useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => (prev < filteredSkills.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => (prev > 0 ? prev - 1 : filteredSkills.length - 1))
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          if (filteredSkills[selectedIndex]) {
            onSelect(filteredSkills[selectedIndex].slug)
            onOpenChange(false)
          }
          break
        case 'Escape':
          e.preventDefault()
          onOpenChange(false)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, filteredSkills, selectedIndex, onSelect, onOpenChange])

  // Close on click outside
  React.useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChange(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, onOpenChange])

  // Hide if no results or not open
  if (!open || filteredSkills.length === 0) return null

  // Calculate bottom position from window height (menu appears above cursor)
  const bottomPosition = typeof window !== 'undefined'
    ? window.innerHeight - Math.round(position.y) + 8
    : 0

  return (
    <div
      ref={menuRef}
      className={cn('fixed z-dropdown', MENU_CONTAINER_STYLE, className)}
      style={{ left: Math.round(position.x) - 10, bottom: bottomPosition }}
    >
      <div className={MENU_LIST_STYLE}>
        {filteredSkills.map((skill, index) => {
          const isSelected = index === selectedIndex
          return (
            <div
              key={skill.slug}
              onClick={() => {
                onSelect(skill.slug)
                onOpenChange(false)
              }}
              onMouseEnter={() => setSelectedIndex(index)}
              className={cn(
                MENU_ITEM_STYLE,
                isSelected && MENU_ITEM_SELECTED
              )}
            >
              <div className="shrink-0">
                <SkillAvatar skill={skill} size="sm" workspaceId={workspaceId} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{skill.metadata.name}</div>
                {skill.metadata.description && (
                  <div className="text-[11px] text-foreground/50 truncate">
                    {skill.metadata.description}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================================
// Hook for managing inline skill mention state
// ============================================================================

/** Interface for elements that can be used with useInlineSkillMention */
export interface SkillMentionInputElement {
  getBoundingClientRect: () => DOMRect
  value: string
  selectionStart: number
}

export interface UseInlineSkillMentionOptions {
  inputRef: React.RefObject<SkillMentionInputElement | null>
  skills: LoadedSkill[]
  onSelect: (slug: string) => void
}

export interface UseInlineSkillMentionReturn {
  isOpen: boolean
  filter: string
  position: { x: number; y: number }
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  handleSelect: (slug: string) => string
}

export function useInlineSkillMention({
  inputRef,
  skills,
  onSelect,
}: UseInlineSkillMentionOptions): UseInlineSkillMentionReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [atStart, setAtStart] = React.useState(-1)
  // Store current input state for handleSelect
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    // Store current state for handleSelect
    currentInputRef.current = { value, cursorPosition }

    const textBeforeCursor = value.slice(0, cursorPosition)
    // Match @ at start of text or after whitespace, followed by optional word chars and hyphens
    const atMatch = textBeforeCursor.match(/(?:^|\s)@([\w-]*)$/)

    if (atMatch && skills.length > 0) {
      const matchStart = textBeforeCursor.lastIndexOf('@')
      setAtStart(matchStart)
      setFilter(atMatch[1] || '')

      if (inputRef.current) {
        const rect = inputRef.current.getBoundingClientRect()

        // Simplified position calculation
        const lineHeight = 20
        const charWidth = 8
        const linesBeforeCursor = textBeforeCursor.split('\n').length - 1
        const charsOnCurrentLine = textBeforeCursor.split('\n').pop()?.length || 0

        // Position above the current line (menu appears above cursor)
        setPosition({
          x: rect.left + Math.min(charsOnCurrentLine * charWidth, rect.width - 100),
          y: rect.top + (linesBeforeCursor + 1) * lineHeight,
        })
      }

      setIsOpen(true)
    } else {
      setIsOpen(false)
      setFilter('')
      setAtStart(-1)
    }
  }, [inputRef, skills.length])

  const handleSelect = React.useCallback((slug: string): string => {
    // Insert @slug at the @ position, replacing the partial text
    let result = ''
    if (atStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, atStart)
      const after = currentValue.slice(cursorPosition)
      // Insert @slug with trailing space
      result = before + '@' + slug + ' ' + after
    }

    onSelect(slug)
    setIsOpen(false)

    return result
  }, [onSelect, atStart])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setAtStart(-1)
  }, [])

  return {
    isOpen,
    filter,
    position,
    handleInputChange,
    close,
    handleSelect,
  }
}
