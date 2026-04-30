/**
 * EntityPanel<T> — Config-driven entity list with built-in keyboard nav + multi-select.
 *
 * Wraps EntityList + EntityRow + useEntityListInteractions so consumers
 * only provide a data mapping via `mapItem`.
 */

import * as React from 'react'
import { useAction } from '@/actions'
import { EntityList } from './entity-list'
import { EntityRow } from './entity-row'
import { useEntityListInteractions } from '@/hooks/useEntityListInteractions'
import type { createEntitySelection } from '@/hooks/useEntitySelection'

export interface EntityPanelItem {
  icon?: React.ReactNode
  title: React.ReactNode
  badges?: React.ReactNode
  trailing?: React.ReactNode
  menu?: React.ReactNode
  dataAttributes?: Record<string, string | undefined>
}

export interface EntityPanelProps<T> {
  items: T[]
  getId: (item: T) => string
  mapItem: (item: T) => EntityPanelItem
  selection: ReturnType<typeof createEntitySelection>
  onItemClick: (item: T) => void
  selectedId?: string | null
  emptyState?: React.ReactNode
  className?: string
}

export function EntityPanel<T>({
  items,
  getId,
  mapItem,
  selection,
  onItemClick,
  selectedId,
  emptyState,
  className,
}: EntityPanelProps<T>) {
  const selectionStore = selection.useSelectionStore()
  const interactions = useEntityListInteractions<T>({
    items,
    getId,
    keyboard: {
      onNavigate: (item) => onItemClick(item),
      onActivate: (item) => onItemClick(item),
    },
    multiSelect: true,
    selectionStore,
  })

  useAction('navigator.clearSelection', () => {
    interactions.selection.clear()
  }, {
    enabled: () => interactions.selection.isMultiSelectActive,
  }, [interactions.selection])

  return (
    <EntityList
      items={items}
      getKey={getId}
      containerRef={interactions.listProps.containerRef}
      containerProps={interactions.listProps.containerProps}
      className={className}
      emptyState={emptyState}
      renderItem={(item, index, isFirst) => {
        const mapped = mapItem(item)
        const rowProps = interactions.getRowProps(item, index)
        return (
          <EntityRow
            icon={mapped.icon}
            title={mapped.title}
            badges={mapped.badges}
            trailing={mapped.trailing}
            isSelected={selectedId === getId(item)}
            isInMultiSelect={rowProps.isInMultiSelect}
            showSeparator={!isFirst}
            onMouseDown={(e) => {
              rowProps.onMouseDown(e)
              if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button !== 2) {
                onItemClick(item)
              }
            }}
            buttonProps={rowProps.buttonProps}
            menuContent={mapped.menu}
            dataAttributes={mapped.dataAttributes}
          />
        )
      }}
    />
  )
}
