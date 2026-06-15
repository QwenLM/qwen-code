/**
 * Info_DataTable
 *
 * Enhanced data table for Info pages with built-in search, sort, and filter UI.
 * Wraps shadcn DataTable with Info-page styling and toolbar controls.
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import type { ColumnDef } from '@tanstack/react-table'
import { DataTable, SortableHeader } from '@/components/ui/data-table'
import { Input } from '@/components/ui/input'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'

export interface Info_DataTableProps<TData, TValue> {
  /** TanStack Table column definitions */
  columns: ColumnDef<TData, TValue>[]
  /** Table data */
  data: TData[]
  /** Show search input in toolbar */
  searchable?: boolean | {
    /** Placeholder text */
    placeholder?: string
    /** Column ID to search (defaults to global search) */
    column?: string
  }
  /** Max height with scroll (similar to Info_Markdown) */
  maxHeight?: number
  /** Show loading state */
  loading?: boolean
  /** Show error message */
  error?: string
  /** Empty state content */
  emptyContent?: React.ReactNode
  /**
   * Floating action rendered OVER the table header (e.g., fullscreen button).
   * Uses absolute positioning inside scroll container - appears on hover via group-hover.
   * Parent should have 'group' class for hover detection.
   */
  floatingAction?: React.ReactNode
  /** Enable tree/hierarchical rows (passed through to DataTable) */
  getSubRows?: (row: TData) => TData[] | undefined
  /** Additional class names */
  className?: string
}

/**
 * Info_DataTable - Enhanced data table for Info pages
 *
 * @example
 * ```tsx
 * const columns: ColumnDef<ToolRow>[] = [
 *   {
 *     accessorKey: 'name',
 *     header: ({ column }) => <SortableHeader column={column} title="Name" />,
 *   },
 *   // ...
 * ]
 *
 * <Info_DataTable
 *   columns={columns}
 *   data={tools}
 *   searchable={{ placeholder: 'Search tools...' }}
 *   maxHeight={400}
 * />
 * ```
 */
export function Info_DataTable<TData, TValue>({
  columns,
  data,
  searchable = false,
  maxHeight,
  loading = false,
  error,
  emptyContent,
  floatingAction,
  getSubRows,
  className,
}: Info_DataTableProps<TData, TValue>) {
  const { t } = useTranslation()
  const [searchValue, setSearchValue] = React.useState('')

  // Parse searchable prop
  const searchConfig = React.useMemo(() => {
    if (!searchable) return null
    if (searchable === true) {
      return { placeholder: t("common.search"), column: undefined }
    }
    return {
      placeholder: searchable.placeholder ?? t("common.search"),
      column: searchable.column,
    }
  }, [searchable, t])

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner className="text-muted-foreground" />
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        {error === 'Source requires authentication' ? (
          <span>{t('sourceInfo.authenticateToViewData')}</span>
        ) : (
          <span>{error}</span>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        // overflow-x-hidden on outer container so the sticky floating action
        // doesn't scroll horizontally with table content. The inner wrapper
        // handles horizontal overflow independently.
        maxHeight && 'overflow-y-auto overflow-x-hidden',
        className
      )}
      style={maxHeight ? { maxHeight } : undefined}
    >
      {/* Floating action - sticky positioned to stay at top-right while scrolling.
          Uses sticky + float instead of absolute because parent SettingsCard has
          overflow-hidden which clips absolute elements. Sticky respects overflow containers.
          Height 0 ensures it doesn't add vertical space to the layout. */}
      {floatingAction && (
        <div className="sticky top-2.5 float-right mr-1.5 z-20 h-0">
          {floatingAction}
        </div>
      )}

      {/* Inner wrapper handles horizontal overflow independently so the table
          can scroll horizontally without dragging the floating action along. */}
      <div className="overflow-x-auto">
        <DataTable
          columns={columns}
          data={data}
          globalFilter={searchConfig?.column ? undefined : searchValue}
          filterColumn={searchConfig?.column}
          filterValue={searchConfig?.column ? searchValue : undefined}
          emptyContent={emptyContent}
          getSubRows={getSubRows}
          noBorder
          noWrapper
        />
      </div>
    </div>
  )
}

// Re-export SortableHeader for convenience
export { SortableHeader } from '@/components/ui/data-table'
export type { ColumnDef } from '@tanstack/react-table'
