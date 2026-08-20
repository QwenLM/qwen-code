/**
 * ToolsDataTable
 *
 * Typed Data Table for displaying MCP tools.
 * Features: searchable tools, sortable columns, max-height scroll.
 */

import * as React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ColumnDef } from '@tanstack/react-table'
import { Info_DataTable, SortableHeader } from './Info_DataTable'
import { Info_Badge } from './Info_Badge'
import { Info_StatusBadge } from './Info_StatusBadge'

export type ToolPermission = 'allowed' | 'requires-permission'

export interface ToolRow {
  name: string
  description: string
  permission: ToolPermission
}

interface ToolsDataTableProps {
  data: ToolRow[]
  /** Show loading spinner */
  loading?: boolean
  /** Show error message */
  error?: string
  /** Max height with scroll (default: 400) */
  maxHeight?: number
  className?: string
}

function getColumns(t: TFunction): ColumnDef<ToolRow>[] {
  return [
    {
      accessorKey: 'permission',
      header: ({ column }) => <SortableHeader column={column} title={t("table.access")} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <Info_StatusBadge status={row.original.permission} className="whitespace-nowrap" />
        </div>
      ),
      minSize: 80,
    },
    {
      accessorKey: 'name',
      header: ({ column }) => <SortableHeader column={column} title={t("table.tool")} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <Info_Badge color="muted" className="whitespace-nowrap">
            {row.original.name}
          </Info_Badge>
        </div>
      ),
      minSize: 100,
    },
    {
      id: 'description',
      accessorKey: 'description',
      header: () => <span className="p-1.5 pl-2.5">{t("common.description")}</span>,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5 min-w-0">
          <span className="truncate block">{row.original.description}</span>
        </div>
      ),
      meta: { fillWidth: true, truncate: true },
    },
  ]
}

export function ToolsDataTable({
  data,
  loading,
  error,
  maxHeight = 400,
  className,
}: ToolsDataTableProps) {
  const { t } = useTranslation()
  const columns = useMemo(() => getColumns(t), [t])

  return (
    <Info_DataTable
      columns={columns}
      data={data}
      loading={loading}
      error={error}
      maxHeight={maxHeight}
      emptyContent={t("table.noToolsAvailable")}
      className={className}
    />
  )
}
