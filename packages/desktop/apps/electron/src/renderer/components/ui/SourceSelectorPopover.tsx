import * as React from 'react'
import { Check, DatabaseZap } from 'lucide-react'
import { FilterableSelectPopover } from '@craft-agent/ui'

import { cn } from '@/lib/utils'
import { SourceAvatar } from '@/components/ui/source-avatar'
import type { LoadedSource } from '../../../shared/types'

export interface SourceSelectorPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
  sources: LoadedSource[]
  selectedSlugs: string[]
  onToggleSlug: (slug: string) => void
}

export function SourceSelectorPopover({
  open,
  onOpenChange,
  anchorRef,
  sources,
  selectedSlugs,
  onToggleSlug,
}: SourceSelectorPopoverProps) {
  return (
    <FilterableSelectPopover
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      items={sources}
      getKey={(source) => source.config.slug}
      getLabel={(source) => source.config.name}
      isSelected={(source) => selectedSlugs.includes(source.config.slug)}
      onToggle={(source) => onToggleSlug(source.config.slug)}
      filterPlaceholder="Search sources..."
      emptyState={(
        <>
          No sources configured.
          <br />
          Add sources in Settings.
        </>
      )}
      noResultsState="No matching sources."
      minWidth={200}
      maxWidth={320}
      renderItem={(source, state, index) => (
        <div
          data-tutorial={index === 0 ? 'source-dropdown-item-first' : undefined}
          className={cn(
            'flex cursor-pointer select-none items-center gap-3 rounded-[6px] px-3 py-2 text-[13px]',
            state.highlighted && 'bg-foreground/5',
            state.selected && 'bg-foreground/3',
          )}
        >
          <div className="shrink-0 text-muted-foreground flex items-center">
            {source.config.slug
              ? <SourceAvatar source={source} size="sm" />
              : <DatabaseZap className="h-4 w-4" />}
          </div>
          <div className="flex-1 min-w-0 truncate">{source.config.name}</div>
          <div
            className={cn(
              'shrink-0 h-4 w-4 rounded-full bg-current flex items-center justify-center',
              !state.selected && 'opacity-0',
            )}
          >
            <Check className="h-2.5 w-2.5 text-white dark:text-black" strokeWidth={3} />
          </div>
        </div>
      )}
    />
  )
}
