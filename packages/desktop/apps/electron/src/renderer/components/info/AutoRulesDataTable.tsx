/**
 * AutoRulesDataTable
 *
 * Flat data table displaying all auto-label rules across all labels.
 * Each row shows which label a rule belongs to, the regex pattern, flags,
 * value template, and description.
 *
 * Rules are collected by recursively traversing the label tree and flattening
 * all autoRules into a single list.
 */

import * as React from 'react'
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ColumnDef } from '@tanstack/react-table'
import { Maximize2 } from 'lucide-react'
import { Info_DataTable, SortableHeader } from './Info_DataTable'
import { Info_Badge } from './Info_Badge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
import { DataTableOverlay } from '@craft-agent/ui'
import { LabelIcon } from '@/components/ui/label-icon'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'
import { toast } from 'sonner'
import type { LabelConfig, AutoLabelRule } from '@craft-agent/shared/labels'

/**
 * Flattened auto-rule row: associates a rule with its parent label
 */
interface AutoRuleRow {
  /** The label this rule belongs to */
  label: LabelConfig
  /** The auto-label rule */
  rule: AutoLabelRule
}

interface AutoRulesDataTableProps {
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
 * PatternBadge - Monospace regex pattern with click-to-copy and tooltip.
 * Mirrors the PatternBadge from PermissionsDataTable for consistency.
 */
function PatternBadge({ pattern }: { pattern: string }) {
  const { t } = useTranslation()
  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(pattern)
      toast.success(t('toast.patternCopied'))
    } catch {
      toast.error(t('toast.failedToCopyPattern'))
    }
  }

  const badge = (
    <button type="button" onClick={handleClick} className="text-left">
      <Info_Badge color="muted" className="font-mono select-none">
        <span className="block overflow-hidden whitespace-nowrap text-ellipsis max-w-[200px]">
          {pattern}
        </span>
      </Info_Badge>
    </button>
  )

  if (pattern.length >= 25) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent className="font-mono max-w-md break-all">{pattern}</TooltipContent>
      </Tooltip>
    )
  }

  return badge
}

// Column definitions for the auto-rules flat table
function getColumns(t: TFunction): ColumnDef<AutoRuleRow>[] {
  return [
    {
      id: 'label',
      header: ({ column }) => <SortableHeader column={column} title={t("table.label")} />,
      accessorFn: (row) => row.label.name,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5 flex items-center gap-1.5">
          <LabelIcon label={row.original.label} size="xs" />
          <span className="text-sm truncate">{row.original.label.name}</span>
        </div>
      ),
      minSize: 100,
    },
    {
      id: 'pattern',
      header: ({ column }) => <SortableHeader column={column} title={t("table.pattern")} />,
      accessorFn: (row) => row.rule.pattern,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <PatternBadge pattern={row.original.rule.pattern} />
        </div>
      ),
      minSize: 120,
    },
    {
      id: 'flags',
      header: () => <span className="p-1.5 pl-2.5">{t("table.flags")}</span>,
      accessorFn: (row) => row.rule.flags ?? 'gi',
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <span className="text-xs text-muted-foreground font-mono">
            {row.original.rule.flags ?? 'gi'}
          </span>
        </div>
      ),
      minSize: 50,
    },
    {
      id: 'template',
      header: () => <span className="p-1.5 pl-2.5">{t("table.template")}</span>,
      accessorFn: (row) => row.rule.valueTemplate ?? '',
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          {row.original.rule.valueTemplate ? (
            <Info_Badge color="muted" className="font-mono whitespace-nowrap">
              {row.original.rule.valueTemplate}
            </Info_Badge>
          ) : (
            <span className="text-muted-foreground/50 text-sm">—</span>
          )}
        </div>
      ),
      minSize: 80,
    },
    {
      id: 'description',
      header: () => <span className="p-1.5 pl-2.5">{t("common.description")}</span>,
      accessorFn: (row) => row.rule.description ?? '',
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5 min-w-0">
          <span className="truncate block text-sm">
            {row.original.rule.description || '—'}
          </span>
        </div>
      ),
      meta: { fillWidth: true, truncate: true },
    },
  ]
}

/**
 * Recursively collect all auto-rules from the label tree,
 * associating each rule with its parent label.
 */
function collectAutoRules(labels: LabelConfig[]): AutoRuleRow[] {
  const rows: AutoRuleRow[] = []

  function traverse(nodes: LabelConfig[]) {
    for (const label of nodes) {
      if (label.autoRules?.length) {
        for (const rule of label.autoRules) {
          rows.push({ label, rule })
        }
      }
      if (label.children?.length) {
        traverse(label.children)
      }
    }
  }

  traverse(labels)
  return rows
}

export function AutoRulesDataTable({
  data,
  searchable = false,
  maxHeight = 400,
  fullscreen = false,
  fullscreenTitle = 'Auto-Apply Rules',
  className,
}: AutoRulesDataTableProps) {
  const { t } = useTranslation()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const { isDark } = useTheme()
  const columns = useMemo(() => getColumns(t), [t])

  // Flatten label tree into auto-rule rows
  const rows = useMemo(() => collectAutoRules(data), [data])

  // Fullscreen button (shown on hover)
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

  return (
    <>
      <Info_DataTable
        columns={columns}
        data={rows}
        searchable={searchable ? { placeholder: t("table.searchRules") } : false}
        maxHeight={maxHeight}
        emptyContent={t("settings.labels.noAutoApplyRules")}
        floatingAction={fullscreenButton}
        className={cn(fullscreen && 'group', className)}
      />

      {/* Fullscreen overlay */}
      {fullscreen && (
        <DataTableOverlay
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          title={fullscreenTitle}
          subtitle={t("table.ruleCount", { count: rows.length })}
          theme={isDark ? 'dark' : 'light'}
        >
          <Info_DataTable
            columns={columns}
            data={rows}
            searchable={searchable ? { placeholder: t("table.searchRules") } : false}
            emptyContent={t("settings.labels.noAutoApplyRules")}
          />
        </DataTableOverlay>
      )}
    </>
  )
}
