import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { cn } from '../../lib/utils'

/**
 * Simple animated collapsible content wrapper.
 */
function AnimatedCollapsibleContent({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {isOpen && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

interface CollapsibleSectionProps {
  sectionId: string
  headingLevel: number
  isCollapsed: boolean
  onToggle: (sectionId: string) => void
  children: React.ReactNode
}

/**
 * CollapsibleSection
 *
 * Renders a markdown section with a collapsible heading.
 * - First child is the heading (rendered as trigger)
 * - Remaining children are the content (collapsible)
 * - Chevron appears on hover, rotates when expanded
 * - Only H1-H4 are collapsible; H5-H6 render normally
 */
export function CollapsibleSection({
  sectionId,
  headingLevel,
  isCollapsed,
  onToggle,
  children,
}: CollapsibleSectionProps) {
  // Extract heading (first child) and content (rest)
  const childArray = React.Children.toArray(children)
  const heading = childArray[0]
  const content = childArray.slice(1)

  // Only make H1-H4 collapsible
  if (headingLevel > 4) {
    return <>{children}</>
  }

  const isExpanded = !isCollapsed
  const hasContent = content.length > 0

  return (
    <div className="markdown-collapsible-section" data-section-id={sectionId}>
      {/* Heading with toggle trigger */}
      <div
        className={cn(
          'relative group',
          hasContent && 'cursor-pointer'
        )}
        onClick={() => hasContent && onToggle(sectionId)}
      >
        {/* Chevron - always visible when collapsed, hover-only when expanded */}
        <motion.div
          initial={false}
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className={cn(
            'absolute -left-4 top-[5px] select-none transition-opacity',
            !hasContent && 'opacity-0',
            hasContent && isCollapsed && 'opacity-100',
            hasContent && isExpanded && 'opacity-0 group-hover:opacity-100'
          )}
        >
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        </motion.div>

        {/* Heading content */}
        {heading}
      </div>

      {/* Collapsible content */}
      {hasContent && (
        <AnimatedCollapsibleContent isOpen={isExpanded}>
          <div className="collapsible-section-content">
            {content}
          </div>
        </AnimatedCollapsibleContent>
      )}
    </div>
  )
}
