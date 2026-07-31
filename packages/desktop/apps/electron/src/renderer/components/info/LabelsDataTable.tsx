/**
 * LabelsDataTable
 *
 * Hierarchical data table for displaying label configurations.
 * Uses TanStack Table's built-in expand/collapse for tree rendering.
 * Columns: Color, Name (indented + chevron), Value Type.
 */

import * as React from 'react'
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ColumnDef, Row } from '@tanstack/react-table'
import { ChevronRight, Maximize2 } from 'lucide-react'
import { Info_DataTable, SortableHeader } from './Info_DataTable'
import { Info_Badge } from './Info_Badge'
import { DataTableOverlay } from '@craft-agent/ui'
import { LabelIcon } from '@/components/ui/label-icon'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'
import type { LabelConfig } from '@craft-agent/shared/labels'

interface LabelsDataTableProps {
  /** Label tree (root-level nodes with nested children) */
  data: LabelConfig[]
  /** Show search input */
  searchable?: boolean
  /** Max height with scroll */
  maxHeight?: number
  /** Enable fullscreen button */
  fullscreen?: boolean
  /** Title for fullscreen overlay */
  fullscreenTitle?: string
  className?: string
}

/**
 * ExpandableNameCell - Renders label name with indentation and expand/collapse chevron.
 * Depth-based indentation with a rotating chevron for parent nodes.
 */
function ExpandableNameCell({ row }: { row: Row<LabelConfig> }) {
  const canExpand = row.getCanExpand()
  const isExpanded = row.getIsExpanded()

  return (
    <div
      className="flex items-center gap-1.5 p-1.5 pl-2.5"
      // Indent based on depth: 16px per level
      style={{ paddingLeft: `${row.depth * 16 + 10}px` }}
    >
      {/* Expand/collapse chevron for parent nodes */}
      {canExpand ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            row.toggleExpanded()
          }}
          className="p-0.5 rounded hover:bg-foreground/5 transition-colors"
        >
          <ChevronRight
            className={cn(
              'w-3 h-3 text-muted-foreground transition-transform duration-150',
              isExpanded && 'rotate-90'
            )}
          />
        </button>
      ) : (
        // Spacer to keep alignment consistent with expandable rows
        <span className="w-4" />
      )}
      <span className="text-sm truncate">{row.original.name}</span>
    </div>
  )
}

// Column definitions for the labels tree table
function getColumns(t: TFunction): ColumnDef<LabelConfig>[] {
  return [
    {
      id: 'color',
      header: () => <span className="p-1.5 pl-2.5">{t("common.color")}</span>,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <LabelIcon
            label={row.original}
            size="sm"
            hasChildren={!!row.original.children?.length}
          />
        </div>
      ),
      minSize: 60,
      maxSize: 60,
    },
    {
      accessorKey: 'name',
      header: ({ column }) => <SortableHeader column={column} title={t("common.name")} />,
      cell: ({ row }) => <ExpandableNameCell row={row} />,
      meta: { fillWidth: true },
    },
    {
      id: 'valueType',
      accessorKey: 'valueType',
      header: ({ column }) => <SortableHeader column={column} title={t("common.type")} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          {row.original.valueType ? (
            <Info_Badge color="muted" className="capitalize whitespace-nowrap">
              {t(`sidebar.labelValueType.${row.original.valueType}`)}
            </Info_Badge>
          ) : (
            <span className="text-muted-foreground/50 text-sm">—</span>
          )}
        </div>
      ),
      minSize: 120,
    },
  ]
}

/**
 * Extract children from a LabelConfig for tree expansion.
 * Returns undefined if no children (tells TanStack this is a leaf node).
 */
function getSubRows(row: LabelConfig): LabelConfig[] | undefined {
  return row.children?.length ? row.children : undefined
}

export function LabelsDataTable({
  data,
  searchable = false,
  maxHeight = 400,
  fullscreen = false,
  fullscreenTitle = 'Labels',
  className,
}: LabelsDataTableProps) {
  const { t } = useTranslation()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const { isDark } = useTheme()
  const columns = useMemo(() => getColumns(t), [t])

  // Fullscreen button (shown on hover via group class)
  const fullscreenButton = fullscreen ? (
    <button
      onClick={() => setIsFullscreen(true)}
      className={cn(
        'p-1 rounded-[6px] transition-all',
        'opacity-0 group-hover:opacity-100',
        'bg-background/80 backdrop-blur-sm shadow-minimal',
        'text-muted-foreground/50 hover:text-foreground',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100'
      )}
      title={t("table.viewFullscreen")}
    >
      <Maximize2 className="w-3.5 h-3.5" />
    </button>
  ) : undefined

  // Count all labels recursively for the subtitle
  const countLabels = (labels: LabelConfig[]): number =>
    labels.reduce((sum, l) => sum + 1 + countLabels(l.children || []), 0)
  const totalCount = countLabels(data)

  return (
    <>
      <Info_DataTable
        columns={columns}
        data={data}
        searchable={searchable ? { placeholder: t("table.searchLabels") } : false}
        maxHeight={maxHeight}
        emptyContent={t("table.noLabelsConfigured")}
        floatingAction={fullscreenButton}
        className={cn(fullscreen && 'group', className)}
        getSubRows={getSubRows}
      />

      {/* Fullscreen overlay */}
      {fullscreen && (
        <DataTableOverlay
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          title={fullscreenTitle}
          subtitle={t("table.labelCount", { count: totalCount })}
          theme={isDark ? 'dark' : 'light'}
        >
          <Info_DataTable
            columns={columns}
            data={data}
            searchable={searchable ? { placeholder: t("table.searchLabels") } : false}
            emptyContent={t("table.noLabelsConfigured")}
            getSubRows={getSubRows}
          />
        </DataTableOverlay>
      )}
    </>
  )
}
