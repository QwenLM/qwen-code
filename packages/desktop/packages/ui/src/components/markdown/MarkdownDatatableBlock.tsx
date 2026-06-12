/**
 * MarkdownDatatableBlock - Interactive data table for markdown ```datatable code blocks
 *
 * Renders structured JSON as a sortable table with fullscreen expand.
 * No TanStack dependency — uses native HTML table + React state for lightweight
 * portability across Electron and the web viewer.
 *
 * Expected JSON shape (inline):
 * {
 *   "title": "Sales by Region",
 *   "columns": [{ "key": "region", "label": "Region", "type": "text" }],
 *   "rows": [{ "region": "North America" }]
 * }
 *
 * File-backed shape (src field):
 * {
 *   "src": "data/transactions.json",
 *   "title": "Transactions",
 *   "columns": [{ "key": "id", "label": "ID", "type": "text" }]
 * }
 *
 * When `src` is present, rows are loaded from the file via PlatformContext.onReadFile.
 * The file can contain full {title, columns, rows} or just a rows array [...].
 * Inline title/columns take precedence over file values.
 *
 * Falls back to CodeBlock if JSON parsing fails.
 */

import * as React from 'react'
import niceTicks from 'nice-ticks'
import { ArrowUpDown, Check, ChevronRight, Group, ListFilter, Maximize2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { DataTableOverlay } from '../overlay/DataTableOverlay'
import { useScrollFade } from './useScrollFade'
import { TableExportDropdown } from './TableExportDropdown'
import { usePlatform } from '../../context/PlatformContext'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from '../ui/StyledDropdown'
import { useTranslation } from 'react-i18next'

// ── Types ────────────────────────────────────────────────────────────────────

interface ColumnDef {
  key: string
  label: string
  type?: 'text' | 'number' | 'currency' | 'percent' | 'boolean' | 'date' | 'badge'
  align?: 'left' | 'center' | 'right'
}

interface DatatableData {
  title?: string
  columns: ColumnDef[]
  rows: Record<string, unknown>[]
}

interface DatatableSpec {
  src?: string
  title?: string
  columns?: ColumnDef[]
  rows?: Record<string, unknown>[]
}

type SortDir = 'asc' | 'desc' | null

// ── Cell formatting ──────────────────────────────────────────────────────────

function formatCell(value: unknown, type?: ColumnDef['type']): React.ReactNode {
  if (value === null || value === undefined) return <span className="text-muted-foreground/40">—</span>
  switch (type) {
    case 'currency': {
      const num = typeof value === 'number' ? value : Number(value)
      if (isNaN(num)) return String(value)
      return <span className="tabular-nums">{num.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
    }
    case 'percent': {
      const pct = typeof value === 'number' ? value : Number(value)
      if (isNaN(pct)) return String(value)
      const formatted = (pct * 100).toFixed(1) + '%'
      const positive = pct > 0
      return <span className={cn('tabular-nums', positive && 'text-success', pct < 0 && 'text-destructive')}>{positive ? '+' : ''}{formatted}</span>
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      if (isNaN(n)) return String(value)
      return <span className="tabular-nums">{n.toLocaleString()}</span>
    }
    case 'boolean':
      return value ? <span className="text-success">Yes</span> : <span className="text-muted-foreground">No</span>
    case 'badge': {
      const s = String(value).toLowerCase()
      const color = s === 'active' || s === 'passing' || s === 'success' || s === 'done'
        ? 'bg-success/10 text-success'
        : s === 'revoked' || s === 'failed' || s === 'error'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-muted text-muted-foreground'
      return <span className={cn('inline-block px-1.5 py-0.5 rounded text-[11px] font-medium', color)}>{String(value)}</span>
    }
    default:
      return String(value)
  }
}

function colAlign(type?: ColumnDef['type'], explicit?: string): string {
  if (explicit) return `text-${explicit}`
  if (type === 'number' || type === 'currency' || type === 'percent') return 'text-right'
  return 'text-left'
}

// ── Sort icon ────────────────────────────────────────────────────────────────

function SortIcon({ dir }: { dir: SortDir }) {
  return (
    <svg className={cn('w-3 h-3 shrink-0', dir ? 'opacity-60' : 'opacity-20')} viewBox="0 0 16 16" fill="currentColor">
      {dir === 'asc' ? (
        <path d="M8 3l4 5H4l4-5z" />
      ) : dir === 'desc' ? (
        <path d="M8 13l4-5H4l4 5z" />
      ) : (
        <>
          <path d="M8 3l3 4H5l3-4z" />
          <path d="M8 13l3-4H5l3 4z" />
        </>
      )}
    </svg>
  )
}

// ── Grouping granularity ─────────────────────────────────────────────────

interface GranularityOption {
  label: string
  value: string
}

const DATE_GRANULARITIES: GranularityOption[] = [
  { label: 'Hour', value: 'hour' },
  { label: 'Day', value: 'day' },
  { label: 'Month', value: 'month' },
  { label: 'Year', value: 'year' },
]

function formatCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(abs >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K'
  if (abs >= 1) return String(Math.round(n))
  if (abs >= 0.01) return n.toFixed(2)
  return String(n)
}

function computeNumericGranularities(values: number[], type: 'number' | 'currency' | 'percent'): GranularityOption[] {
  if (values.length < 2) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return []

  const tickCounts = [3, 5, 8, 15]
  const seen = new Set<number>()
  const options: GranularityOption[] = [{ label: 'Exact', value: 'exact' }]

  for (const count of tickCounts) {
    const ticks = niceTicks(min, max, count)
    if (ticks.length < 2) continue
    const step = Math.abs(ticks[1]! - ticks[0]!)
    if (step <= 0 || seen.has(step)) continue
    seen.add(step)

    let label: string
    if (type === 'percent') {
      label = formatCompact(step * 100) + '%'
    } else if (type === 'currency') {
      label = '$' + formatCompact(step)
    } else {
      label = formatCompact(step)
    }
    options.push({ label, value: String(step) })
  }

  return options.length > 1 ? options : []
}

function computeDateGranularities(values: number[]): GranularityOption[] {
  if (values.length < 2) return DATE_GRANULARITIES
  const min = Math.min(...values)
  const max = Math.max(...values)
  const spanMs = max - min

  const HOUR = 3600_000
  const DAY = 86400_000
  const MONTH = 30 * DAY
  const YEAR = 365 * DAY

  const opts: GranularityOption[] = []
  if (spanMs < 2 * YEAR) opts.push({ label: 'Hour', value: 'hour' })
  if (spanMs >= 2 * DAY || spanMs < 2 * YEAR) opts.push({ label: 'Day', value: 'day' })
  if (spanMs >= 2 * MONTH) opts.push({ label: 'Month', value: 'month' })
  if (spanMs >= 2 * YEAR) opts.push({ label: 'Year', value: 'year' })
  return opts.length ? opts : DATE_GRANULARITIES
}

function computeGranularityOptions(data: DatatableData): Map<string, GranularityOption[]> {
  const result = new Map<string, GranularityOption[]>()
  for (const col of data.columns) {
    if (col.type === 'date') {
      const timestamps = data.rows
        .map((r) => new Date(r[col.key] as string | number).getTime())
        .filter((t) => !isNaN(t))
      result.set(col.key, computeDateGranularities(timestamps))
    } else if (col.type === 'number' || col.type === 'currency' || col.type === 'percent') {
      const nums = data.rows
        .map((r) => typeof r[col.key] === 'number' ? r[col.key] as number : Number(r[col.key]))
        .filter((n) => !isNaN(n))
      const opts = computeNumericGranularities(nums, col.type)
      if (opts.length > 0) result.set(col.key, opts)
    }
    // text, badge, boolean → no entry → no sub-menu
  }
  return result
}

function bucketValue(value: unknown, type: ColumnDef['type'], granularity: string): string {
  if (value === null || value === undefined) return '—'

  if (type === 'date') {
    const d = new Date(value as string | number)
    if (isNaN(d.getTime())) return String(value)
    switch (granularity) {
      case 'hour': return d.toLocaleDateString() + ' ' + d.getHours() + ':00'
      case 'day': return d.toLocaleDateString()
      case 'month': return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
      case 'year': return String(d.getFullYear())
    }
  }

  if (type === 'number' || type === 'currency' || type === 'percent') {
    const n = typeof value === 'number' ? value : Number(value)
    if (isNaN(n)) return String(value)
    if (granularity === 'exact') {
      if (type === 'currency') return '$' + n.toLocaleString()
      if (type === 'percent') return (n * 100).toFixed(1) + '%'
      return n.toLocaleString()
    }
    const size = parseFloat(granularity)
    if (!size) return String(n)
    const lo = Math.floor(n / size) * size
    const hi = lo + size
    if (type === 'percent') return `${(lo * 100).toFixed(0)}%–${(hi * 100).toFixed(0)}%`
    if (type === 'currency') return `$${formatCompact(lo)}–$${formatCompact(hi)}`
    return `${formatCompact(lo)}–${formatCompact(hi)}`
  }

  return String(value)
}

function defaultGranularity(type: ColumnDef['type'], options: GranularityOption[]): string {
  if (!options.length) return 'exact'
  if (type === 'date') return options.find((o) => o.value === 'day')?.value ?? options[0]!.value
  // For numeric: pick the second option (first non-Exact) if available
  return options.length > 1 ? options[1]!.value : options[0]!.value
}

// ── Error boundary ───────────────────────────────────────────────────────────

class DatatableErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownDatatableBlock] Render failed, falling back to CodeBlock:', error)
  }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ── Main component ───────────────────────────────────────────────────────────

export interface MarkdownDatatableBlockProps {
  code: string
  className?: string
}

export function MarkdownDatatableBlock({ code, className }: MarkdownDatatableBlockProps) {
  const { t } = useTranslation()
  const { onReadFile } = usePlatform()

  // Parse the inline JSON spec (may have src field for file-backed data)
  const spec = React.useMemo<DatatableSpec | null>(() => {
    try {
      const raw = JSON.parse(code)
      // Valid if it has inline data OR a src reference
      if (raw.src || (Array.isArray(raw.columns) && Array.isArray(raw.rows))) {
        return raw as DatatableSpec
      }
      return null
    } catch {
      return null
    }
  }, [code])

  // Load file data when src is present
  const [fileData, setFileData] = React.useState<DatatableData | null>(null)
  const [fileError, setFileError] = React.useState<string | null>(null)
  const [fileLoading, setFileLoading] = React.useState(false)

  React.useEffect(() => {
    if (!spec?.src || !onReadFile) return
    setFileLoading(true)
    setFileError(null)
    onReadFile(spec.src)
      .then((content) => {
        try {
          const raw = JSON.parse(content)
          // File can be full {title, columns, rows} or just a rows array
          if (Array.isArray(raw)) {
            setFileData({ rows: raw, columns: [], title: undefined })
          } else if (raw && typeof raw === 'object') {
            setFileData({
              title: raw.title,
              columns: Array.isArray(raw.columns) ? raw.columns : [],
              rows: Array.isArray(raw.rows) ? raw.rows : [],
            })
          } else {
            setFileError('File does not contain valid datatable data')
          }
        } catch {
          setFileError('Failed to parse data file as JSON')
        }
      })
      .catch((err) => {
        setFileError(err instanceof Error ? err.message : 'Failed to read data file')
      })
      .finally(() => setFileLoading(false))
  }, [spec?.src, onReadFile])

  // Merge: inline spec takes precedence, file provides rows
  const parsed = React.useMemo<DatatableData | null>(() => {
    if (!spec) return null
    if (spec.src) {
      if (!fileData) return null // Still loading or error
      return {
        title: spec.title ?? fileData.title,
        columns: (spec.columns && spec.columns.length > 0) ? spec.columns : fileData.columns,
        rows: fileData.rows,
      }
    }
    // Inline data - must have columns and rows
    if (!Array.isArray(spec.columns) || !Array.isArray(spec.rows)) return null
    return { title: spec.title, columns: spec.columns, rows: spec.rows }
  }, [spec, fileData])

  const [sortKey, setSortKey] = React.useState<string | null>(null)
  const [sortDir, setSortDir] = React.useState<SortDir>(null)
  const [isFullscreen, setIsFullscreen] = React.useState(false)
  const [groupKey, setGroupKey] = React.useState<string | null>(null)
  const [groupGranularity, setGroupGranularity] = React.useState<string>('exact')
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set())
  const { scrollRef, maskImage } = useScrollFade()

  const handleSort = React.useCallback((key: string) => {
    setSortKey((prev) => {
      if (prev !== key) { setSortDir('asc'); return key }
      setSortDir((d) => d === 'asc' ? 'desc' : d === 'desc' ? null : 'asc')
      return key
    })
  }, [])

  const processedRows = React.useMemo(() => {
    if (!parsed) return []
    let rows = [...parsed.rows]
    // Sort
    if (sortKey && sortDir) {
      rows.sort((a, b) => {
        const av = a[sortKey]
        const bv = b[sortKey]
        if (av === bv) return 0
        if (av === null || av === undefined) return 1
        if (bv === null || bv === undefined) return -1
        const cmp = typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv))
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
    return rows
  }, [parsed, sortKey, sortDir])

  const granularityOptions = React.useMemo(() => {
    if (!parsed) return new Map<string, GranularityOption[]>()
    return computeGranularityOptions(parsed)
  }, [parsed])

  const groupedData = React.useMemo(() => {
    if (!groupKey || !parsed) return null
    const col = parsed.columns.find((c) => c.key === groupKey)
    const hasGranularity = granularityOptions.has(groupKey)
    const groups: { value: string; rows: Record<string, unknown>[] }[] = []
    const map = new Map<string, Record<string, unknown>[]>()
    for (const row of processedRows) {
      const val = hasGranularity
        ? bucketValue(row[groupKey], col?.type, groupGranularity)
        : String(row[groupKey] ?? '—')
      if (!map.has(val)) { map.set(val, []); groups.push({ value: val, rows: map.get(val)! }) }
      map.get(val)!.push(row)
    }
    return groups
  }, [processedRows, groupKey, groupGranularity, parsed, granularityOptions])

  const toggleCollapsed = React.useCallback((value: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }, [])

  const hasActiveControls = (sortKey !== null && sortDir !== null) || groupKey !== null

  const clearControls = React.useCallback(() => {
    setSortKey(null)
    setSortDir(null)
    setGroupKey(null)
    setGroupGranularity('exact')
    setCollapsedGroups(new Set())
  }, [])

  // Loading state for file-backed datatable
  if (spec?.src && fileLoading) {
    return (
      <div className={cn('rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{spec.title || t('datatable.defaultTitle')}</span>
        </div>
        <div className="py-8 text-center text-muted-foreground text-[13px]">{t('datatable.loadingData')}</div>
      </div>
    )
  }

  // Error state for file-backed datatable
  if (spec?.src && fileError) {
    return (
      <div className={cn('rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{spec.title || t('datatable.defaultTitle')}</span>
        </div>
        <div className="py-6 text-center text-destructive/70 text-[13px]">{fileError}</div>
      </div>
    )
  }

  if (!parsed) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  const groupColumnLabel = groupKey ? parsed.columns.find((c) => c.key === groupKey)?.label ?? groupKey : ''

  const renderRows = (rows: Record<string, unknown>[]) =>
    rows.map((row, i) => (
      <tr key={i} className="border-b border-foreground/[0.03] last:border-0 hover:bg-foreground/[0.015] transition-colors">
        {parsed.columns.map((col) => (
          <td key={col.key} className={cn('py-2 px-3 whitespace-nowrap', colAlign(col.type, col.align))}>
            {formatCell(row[col.key], col.type)}
          </td>
        ))}
      </tr>
    ))

  const tableContent = (maxHeight?: boolean, scrollable?: boolean) => (
    <div
      ref={scrollable ? scrollRef : undefined}
      className={cn(maxHeight && 'max-h-[400px]', 'overflow-y-auto')}
      style={scrollable ? {
        overflowX: 'auto',
        maskImage,
        WebkitMaskImage: maskImage,
      } : { overflowX: 'auto' }}
    >
      <table className="w-max min-w-full text-[13px]">
        <thead>
          <tr className="border-b border-foreground/[0.06] bg-foreground/[0.02]">
            {parsed.columns.map((col) => (
              <th
                key={col.key}
                className={cn('py-2 px-3 text-[12px] cursor-pointer select-none whitespace-nowrap', colAlign(col.type, col.align))}
                onClick={() => handleSort(col.key)}
              >
                <span className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground transition-colors">
                  {col.label}
                  <SortIcon dir={sortKey === col.key ? sortDir : null} />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groupedData ? groupedData.map((group) => (
            <React.Fragment key={group.value}>
              <tr
                className="cursor-pointer select-none"
                onClick={() => toggleCollapsed(group.value)}
              >
                <td colSpan={parsed.columns.length} className="py-2 px-3 bg-foreground/[0.03] border-b border-foreground/[0.06]">
                  <span className="inline-flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
                    <ChevronRight className={cn('w-3 h-3 transition-transform', !collapsedGroups.has(group.value) && 'rotate-90')} />
                    {groupColumnLabel}: {group.value}
                    <span className="text-muted-foreground/50">({group.rows.length})</span>
                  </span>
                </td>
              </tr>
              {!collapsedGroups.has(group.value) && renderRows(group.rows)}
            </React.Fragment>
          )) : processedRows.length ? renderRows(processedRows) : (
            <tr>
              <td colSpan={parsed.columns.length} className="py-6 text-center text-muted-foreground text-[13px]">
                No rows
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )

  const renderControlsDropdown = (alwaysVisible?: boolean) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'p-1 rounded-[6px] transition-all select-none',
            'bg-background shadow-minimal',
            'data-[state=open]:opacity-100',
            hasActiveControls
              ? 'opacity-100 bg-accent/5 text-accent shadow-tinted'
              : alwaysVisible
                ? 'opacity-70 hover:opacity-100 transition-opacity'
                : 'opacity-0 group-hover:opacity-100 text-muted-foreground/50 hover:text-foreground',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100',
          )}
          title={t('table.tableControls')}
        >
          <ListFilter className="w-3.5 h-3.5" />
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent sideOffset={6} align="end" className="min-w-36" style={{ zIndex: 'var(--z-floating-menu, 400)' }}>
        {/* Sort sub-menu */}
        <DropdownMenuSub>
          <StyledDropdownMenuSubTrigger>
            <ArrowUpDown />
            <span className="flex-1">{t('table.sortBy')}</span>
            {sortKey && sortDir && <Check className="w-3 h-3 text-accent" />}
          </StyledDropdownMenuSubTrigger>
          <StyledDropdownMenuSubContent style={{ zIndex: 'calc(var(--z-floating-menu, 400) + 1)' }}>
            {parsed.columns.map((col) => {
              const isActive = sortKey === col.key && sortDir !== null
              return (
                <StyledDropdownMenuItem
                  key={`sort-${col.key}`}
                  onSelect={(e) => { e.preventDefault(); handleSort(col.key) }}
                >
                  <span className={cn('flex-1', isActive && 'text-accent font-medium')}>{col.label}</span>
                  {isActive && <SortIcon dir={sortDir} />}
                </StyledDropdownMenuItem>
              )
            })}
          </StyledDropdownMenuSubContent>
        </DropdownMenuSub>
        {/* Group sub-menu */}
        <DropdownMenuSub>
          <StyledDropdownMenuSubTrigger>
            <Group />
            <span className="flex-1">{t('table.groupBy')}</span>
            {groupKey && <Check className="w-3 h-3 text-accent" />}
          </StyledDropdownMenuSubTrigger>
          <StyledDropdownMenuSubContent style={{ zIndex: 'calc(var(--z-floating-menu, 400) + 1)' }}>
            {parsed.columns.map((col) => {
              const isActive = groupKey === col.key
              const opts = granularityOptions.get(col.key)

              // Typed column with granularity options → nested sub-menu
              if (opts && opts.length > 0) {
                return (
                  <DropdownMenuSub key={`group-${col.key}`}>
                    <StyledDropdownMenuSubTrigger>
                      <span className={cn('flex-1', isActive && 'text-accent font-medium')}>{col.label}</span>
                      {isActive && <Check className="w-3 h-3 text-accent" />}
                    </StyledDropdownMenuSubTrigger>
                    <StyledDropdownMenuSubContent style={{ zIndex: 'calc(var(--z-floating-menu, 400) + 2)' }}>
                      {opts.map((opt) => {
                        const optActive = isActive && groupGranularity === opt.value
                        return (
                          <StyledDropdownMenuItem
                            key={opt.value}
                            onSelect={(e) => {
                              e.preventDefault()
                              if (isActive && groupGranularity === opt.value) {
                                setGroupKey(null)
                              } else {
                                setGroupKey(col.key)
                                setGroupGranularity(opt.value)
                              }
                              setCollapsedGroups(new Set())
                            }}
                          >
                            <span className={cn('flex-1', optActive && 'text-accent font-medium')}>{opt.label}</span>
                            {optActive && <Check className="w-3.5 h-3.5 text-accent" />}
                          </StyledDropdownMenuItem>
                        )
                      })}
                    </StyledDropdownMenuSubContent>
                  </DropdownMenuSub>
                )
              }

              // Plain column (text, badge, boolean) → direct click
              return (
                <StyledDropdownMenuItem
                  key={`group-${col.key}`}
                  onSelect={(e) => {
                    e.preventDefault()
                    if (isActive) {
                      setGroupKey(null)
                    } else {
                      setGroupKey(col.key)
                      setGroupGranularity('exact')
                    }
                    setCollapsedGroups(new Set())
                  }}
                >
                  <span className={cn('flex-1', isActive && 'text-accent font-medium')}>{col.label}</span>
                  {isActive && <Check className="w-3.5 h-3.5 text-accent" />}
                </StyledDropdownMenuItem>
              )
            })}
          </StyledDropdownMenuSubContent>
        </DropdownMenuSub>
        {/* Clear */}
        {hasActiveControls && (
          <>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onSelect={clearControls}>
              <span className="text-accent">{t('common.clearAll')}</span>
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <DatatableErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        {/* Control button */}
        <div className="absolute top-[7px] right-10 z-10">
          {renderControlsDropdown()}
        </div>

        {/* Expand button */}
        <button
          onClick={() => setIsFullscreen(true)}
          className={cn(
            "absolute top-[7px] right-2 p-1 rounded-[6px] transition-all z-10 select-none",
            "bg-background shadow-minimal",
            hasActiveControls ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            "text-muted-foreground/50 hover:text-foreground",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100"
          )}
          title={t('common.viewFullscreen')}
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>

        {/* Header */}
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">
            {parsed.title || t('datatable.defaultTitle')}
          </span>
        </div>

        {/* Table with max height and scroll fade */}
        {tableContent(true, true)}
      </div>

      {/* Fullscreen overlay */}
      <DataTableOverlay
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        title={parsed.title || t('datatable.defaultTitle')}
        subtitle={t('datatable.rowCount', { count: parsed.rows.length })}
        headerActions={
          <div className="flex items-center gap-1.5">
            {renderControlsDropdown(true)}
            <TableExportDropdown columns={parsed.columns} rows={parsed.rows} filename={parsed.title || t('datatable.defaultTitle')} />
          </div>
        }
      >
        <div className="px-6">
          <div className="bg-background shadow-minimal rounded-[12px] overflow-hidden">
            {tableContent(false)}
          </div>
        </div>
      </DataTableOverlay>
    </DatatableErrorBoundary>
  )
}
