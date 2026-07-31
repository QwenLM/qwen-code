/**
 * MarkdownSpreadsheetBlock - Excel-style grid for markdown ```spreadsheet code blocks
 *
 * Renders structured JSON as a spreadsheet with column letters, row numbers,
 * and type-aware cell formatting. No external dependencies beyond React.
 *
 * Expected JSON shape (inline):
 * {
 *   "filename": "Q1_Revenue.xlsx",
 *   "sheetName": "Summary",
 *   "columns": [{ "key": "region", "label": "Region", "type": "text" }],
 *   "rows": [{ "region": "North" }]
 * }
 *
 * File-backed shape (src field):
 * {
 *   "src": "data/revenue.json",
 *   "filename": "Q1_Revenue.xlsx",
 *   "columns": [{ "key": "region", "label": "Region", "type": "text" }]
 * }
 *
 * Falls back to CodeBlock if JSON parsing fails.
 */

import * as React from 'react'
import { Maximize2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { DataTableOverlay } from '../overlay/DataTableOverlay'
import { useScrollFade } from './useScrollFade'
import { TableExportDropdown } from './TableExportDropdown'
import { usePlatform } from '../../context/PlatformContext'
import { useTranslation } from 'react-i18next'

// ── Types ────────────────────────────────────────────────────────────────────

interface ColumnDef {
  key: string
  label: string
  type?: 'text' | 'number' | 'currency' | 'percent' | 'formula'
}

interface SpreadsheetData {
  filename?: string
  sheetName?: string
  columns: ColumnDef[]
  rows: Record<string, unknown>[]
}

interface SpreadsheetSpec {
  src?: string
  filename?: string
  sheetName?: string
  columns?: ColumnDef[]
  rows?: Record<string, unknown>[]
}

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
    case 'number':
    case 'formula': {
      const n = typeof value === 'number' ? value : Number(value)
      if (isNaN(n)) return String(value)
      return <span className="tabular-nums">{n.toLocaleString()}</span>
    }
    default:
      return String(value)
  }
}

function isNumericType(type?: string): boolean {
  return type === 'number' || type === 'currency' || type === 'percent' || type === 'formula'
}

function isNumericValue(v: unknown): boolean {
  if (typeof v === 'number') return true
  if (typeof v === 'string') return /^-?[\d,]+\.?\d*%?$/.test(v.replace(/[$€£¥]/g, ''))
  return false
}

// ── Error boundary ───────────────────────────────────────────────────────────

class SpreadsheetErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownSpreadsheetBlock] Render failed, falling back to CodeBlock:', error)
  }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ── Main component ───────────────────────────────────────────────────────────

export interface MarkdownSpreadsheetBlockProps {
  code: string
  className?: string
}

export function MarkdownSpreadsheetBlock({ code, className }: MarkdownSpreadsheetBlockProps) {
  const { t } = useTranslation()
  const { onReadFile } = usePlatform()

  // Parse the inline JSON spec (may have src field for file-backed data)
  const spec = React.useMemo<SpreadsheetSpec | null>(() => {
    try {
      const raw = JSON.parse(code)
      if (raw.src || (Array.isArray(raw.columns) && Array.isArray(raw.rows))) {
        return raw as SpreadsheetSpec
      }
      return null
    } catch {
      return null
    }
  }, [code])

  // Load file data when src is present
  const [fileData, setFileData] = React.useState<SpreadsheetData | null>(null)
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
          if (Array.isArray(raw)) {
            setFileData({ rows: raw, columns: [] })
          } else if (raw && typeof raw === 'object') {
            setFileData({
              filename: raw.filename,
              sheetName: raw.sheetName,
              columns: Array.isArray(raw.columns) ? raw.columns : [],
              rows: Array.isArray(raw.rows) ? raw.rows : [],
            })
          } else {
            setFileError('File does not contain valid spreadsheet data')
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
  const parsed = React.useMemo<SpreadsheetData | null>(() => {
    if (!spec) return null
    if (spec.src) {
      if (!fileData) return null
      return {
        filename: spec.filename ?? fileData.filename,
        sheetName: spec.sheetName ?? fileData.sheetName,
        columns: (spec.columns && spec.columns.length > 0) ? spec.columns : fileData.columns,
        rows: fileData.rows,
      }
    }
    if (!Array.isArray(spec.columns) || !Array.isArray(spec.rows)) return null
    return { filename: spec.filename, sheetName: spec.sheetName, columns: spec.columns, rows: spec.rows }
  }, [spec, fileData])

  const [isFullscreen, setIsFullscreen] = React.useState(false)
  const { scrollRef, maskImage } = useScrollFade()

  // Loading state for file-backed spreadsheet
  if (spec?.src && fileLoading) {
    const loadingLabel = [spec.filename, spec.sheetName].filter(Boolean).join(' — ') || t('spreadsheet.defaultTitle')
    return (
      <div className={cn('rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{loadingLabel}</span>
        </div>
        <div className="py-8 text-center text-muted-foreground text-[13px]">{t('datatable.loadingData')}</div>
      </div>
    )
  }

  // Error state for file-backed spreadsheet
  if (spec?.src && fileError) {
    const errorLabel = [spec.filename, spec.sheetName].filter(Boolean).join(' — ') || t('spreadsheet.defaultTitle')
    return (
      <div className={cn('rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{errorLabel}</span>
        </div>
        <div className="py-6 text-center text-destructive/70 text-[13px]">{fileError}</div>
      </div>
    )
  }

  if (!parsed) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const colLetters = parsed.columns.map((_, i) => String.fromCharCode(65 + i))
  const label = [parsed.filename, parsed.sheetName].filter(Boolean).join(' — ') || t('spreadsheet.defaultTitle')
  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

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
        {/* Column letter headers */}
        <thead>
          <tr className="border-b border-foreground/[0.08] bg-foreground/[0.03]">
            <th className="text-center py-1 px-2 font-normal text-muted-foreground/40 w-10 border-r border-foreground/[0.06] text-[11px]" />
            {colLetters.map((letter) => (
              <th key={letter} className="text-center py-1 px-3 font-normal text-muted-foreground/40 border-r border-foreground/[0.06] last:border-0 text-[11px]">{letter}</th>
            ))}
          </tr>
          {/* Row 1: column labels */}
          <tr className="border-b border-foreground/[0.06] bg-foreground/[0.02]">
            <td className="text-center py-1.5 px-2 text-muted-foreground/40 border-r border-foreground/[0.06] text-[11px] font-mono">1</td>
            {parsed.columns.map((col) => (
              <td key={col.key} className="py-1.5 px-3 font-semibold text-foreground border-r border-foreground/[0.06] last:border-0">{col.label}</td>
            ))}
          </tr>
        </thead>
        <tbody>
          {parsed.rows.map((row, i) => (
            <tr key={i} className="border-b border-foreground/[0.03] last:border-0 hover:bg-foreground/[0.015] transition-colors">
              <td className="text-center py-1.5 px-2 text-muted-foreground/40 border-r border-foreground/[0.06] text-[11px] font-mono">{i + 2}</td>
              {parsed.columns.map((col) => {
                const val = row[col.key]
                const numeric = isNumericType(col.type) || isNumericValue(val)
                return (
                  <td key={col.key} className={cn(
                    'py-1.5 px-3 border-r border-foreground/[0.06] last:border-0 tabular-nums',
                    numeric && 'text-right',
                    col.type === 'formula' && 'text-info',
                  )}>
                    {formatCell(val, col.type)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <SpreadsheetErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        {/* Expand button */}
        <button
          onClick={() => setIsFullscreen(true)}
          className={cn(
            "absolute top-[7px] right-2 p-1 rounded-[6px] transition-all z-10 select-none",
            "opacity-0 group-hover:opacity-100",
            "bg-background shadow-minimal",
            "text-muted-foreground/50 hover:text-foreground",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100"
          )}
          title={t('common.viewFullscreen')}
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>

        {/* Header */}
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{label}</span>
        </div>

        {/* Table with max height and scroll fade */}
        {tableContent(true, true)}
      </div>

      {/* Fullscreen overlay */}
      <DataTableOverlay
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        title={label}
        subtitle={`${t('datatable.rowCount', { count: parsed.rows.length })} × ${t('spreadsheet.colCount', { count: parsed.columns.length })}`}
        headerActions={<TableExportDropdown columns={parsed.columns} rows={parsed.rows} filename={parsed.filename || parsed.sheetName || t('spreadsheet.defaultTitle')} />}
      >
        <div className="px-6">
          <div className="bg-background shadow-minimal rounded-[12px] overflow-hidden">
            {tableContent(false)}
          </div>
        </div>
      </DataTableOverlay>
    </SpreadsheetErrorBoundary>
  )
}
