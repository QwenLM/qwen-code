import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, FileDiff, ArrowUpRight } from 'lucide-react'
import { SimpleDropdown, SimpleDropdownItem } from '../ui/SimpleDropdown'
import { cn } from '../../lib/utils'

export interface TurnCardActionsMenuProps {
  /** Callback to open turn details in a new window */
  onOpenDetails?: () => void
  /** Callback to open all edits/writes in multi-file diff view */
  onOpenMultiFileDiff?: () => void
  /** Whether this turn has any Edit or Write activities */
  hasEditOrWriteActivities?: boolean
  /** Additional className for the trigger button */
  className?: string
}

/**
 * TurnCardActionsMenu - Dropdown menu for TurnCard header actions
 *
 * Shows:
 * - "View file changes" when turn has Edit/Write activities
 * - "View turn details" always
 */
export function TurnCardActionsMenu({
  onOpenDetails,
  onOpenMultiFileDiff,
  hasEditOrWriteActivities,
  className,
}: TurnCardActionsMenuProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = React.useState(false)

  // Don't render if no actions available
  if (!onOpenDetails && !onOpenMultiFileDiff) {
    return null
  }

  return (
    <SimpleDropdown
      align="end"
      onOpenChange={setIsOpen}
      trigger={
        <div
          role="button"
          tabIndex={0}
          className={cn(
            "p-1 rounded-[6px] transition-opacity shrink-0",
            "opacity-0 group-hover:opacity-100",
            "bg-background shadow-minimal",
            "text-muted-foreground/50 hover:text-foreground",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100",
            isOpen && "opacity-100 text-foreground",
            className
          )}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
            }
          }}
        >
          <MoreHorizontal className="w-3 h-3" />
        </div>
      }
    >
      {onOpenMultiFileDiff && hasEditOrWriteActivities && (
        <SimpleDropdownItem
          onClick={onOpenMultiFileDiff}
          icon={<FileDiff />}
        >
          {t('chat.viewFileChanges')}
        </SimpleDropdownItem>
      )}
      {onOpenDetails && (
        <SimpleDropdownItem
          onClick={onOpenDetails}
          icon={<ArrowUpRight />}
        >
          {t('chat.viewTurnDetails')}
        </SimpleDropdownItem>
      )}
    </SimpleDropdown>
  )
}
