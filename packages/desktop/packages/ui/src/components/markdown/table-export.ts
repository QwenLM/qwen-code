/**
 * table-export.ts - Export utilities for datatable/spreadsheet blocks
 *
 * Converts column/row data to Markdown, CSV, and XLSX formats.
 * XLSX uses fflate for ZIP compression — no heavyweight spreadsheet library needed.
 */

import { zipSync } from 'fflate'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExportColumn {
  key: string
  label: string
  type?: string
}

// ── Markdown ─────────────────────────────────────────────────────────────────

export function tableToMarkdown(columns: ExportColumn[], rows: Record<string, unknown>[]): string {
  const headers = columns.map((c) => c.label)
  const separator = columns.map(() => '---')
  const dataRows = rows.map((row) =>
    columns.map((col) => {
      const v = row[col.key]
      if (v === null || v === undefined) return ''
      return String(v).replace(/\|/g, '\\|')
    })
  )

  const formatRow = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [formatRow(headers), formatRow(separator), ...dataRows.map(formatRow)].join('\n')
}

// ── CSV (RFC 4180) ───────────────────────────────────────────────────────────

export function tableToCsv(columns: ExportColumn[], rows: Record<string, unknown>[]): string {
  const escapeField = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }

  const header = columns.map((c) => escapeField(c.label)).join(',')
  const dataRows = rows.map((row) =>
    columns.map((col) => escapeField(row[col.key])).join(',')
  )

  return [header, ...dataRows].join('\r\n')
}

// ── XLSX ─────────────────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function colIndexToLetter(i: number): string {
  let result = ''
  let n = i
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result
    n = Math.floor(n / 26) - 1
  }
  return result
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

// ── XLSX Styles ──────────────────────────────────────────────────────────────
//
// cellXfs index map (the `s` attribute on <c> elements):
//   0 = default
//   1 = currency    ($#,##0)
//   2 = percent +   (green 0.0%)
//   3 = percent -   (red   0.0%)
//   4 = percent 0   (0.0%)
//   5 = number      (#,##0)
//   6 = bold header
//   7 = boolean yes (green)
//   8 = boolean no  (muted gray)
//   9 = badge success (green)
//  10 = badge error   (red)
//  11 = badge default (gray)

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="3">
    <numFmt numFmtId="164" formatCode="$#,##0"/>
    <numFmt numFmtId="165" formatCode="0.0%"/>
    <numFmt numFmtId="166" formatCode="#,##0"/>
  </numFmts>
  <fonts count="5">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><sz val="11"/><name val="Calibri"/><color rgb="FF16A34A"/></font>
    <font><sz val="11"/><name val="Calibri"/><color rgb="FFDC2626"/></font>
    <font><sz val="11"/><name val="Calibri"/><b/></font>
    <font><sz val="11"/><name val="Calibri"/><color rgb="FF737373"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="12">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
    <xf numFmtId="165" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
</styleSheet>`

/** Style index constants matching cellXfs order in STYLES */
const S = {
  DEFAULT: 0,
  CURRENCY: 1,
  PERCENT_POS: 2,
  PERCENT_NEG: 3,
  PERCENT_ZERO: 4,
  NUMBER: 5,
  BOLD: 6,
  BOOL_YES: 7,
  BOOL_NO: 8,
  BADGE_SUCCESS: 9,
  BADGE_ERROR: 10,
  BADGE_DEFAULT: 11,
} as const

function getCellStyle(col: ExportColumn, val: unknown): number {
  switch (col.type) {
    case 'currency':
      return S.CURRENCY
    case 'percent': {
      const n = typeof val === 'number' ? val : Number(val)
      if (isNaN(n) || n === 0) return S.PERCENT_ZERO
      return n > 0 ? S.PERCENT_POS : S.PERCENT_NEG
    }
    case 'number':
    case 'formula':
      return S.NUMBER
    case 'boolean':
      return val ? S.BOOL_YES : S.BOOL_NO
    case 'badge': {
      const s = String(val).toLowerCase()
      if (s === 'active' || s === 'passing' || s === 'success' || s === 'done') return S.BADGE_SUCCESS
      if (s === 'revoked' || s === 'failed' || s === 'error') return S.BADGE_ERROR
      return S.BADGE_DEFAULT
    }
    default:
      return S.DEFAULT
  }
}

function buildSheetXml(columns: ExportColumn[], rows: Record<string, unknown>[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  xml += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  xml += '<sheetData>'

  // Header row (bold)
  xml += '<row r="1">'
  columns.forEach((col, ci) => {
    const ref = `${colIndexToLetter(ci)}1`
    xml += `<c r="${ref}" s="${S.BOLD}" t="inlineStr"><is><t>${xmlEscape(col.label)}</t></is></c>`
  })
  xml += '</row>'

  // Data rows
  rows.forEach((row, ri) => {
    const rowNum = ri + 2
    xml += `<row r="${rowNum}">`
    columns.forEach((col, ci) => {
      const ref = `${colIndexToLetter(ci)}${rowNum}`
      const val = row[col.key]
      if (val === null || val === undefined) return
      const style = getCellStyle(col, val)
      const sAttr = style ? ` s="${style}"` : ''

      if (typeof val === 'number' && isFinite(val)) {
        xml += `<c r="${ref}"${sAttr} t="n"><v>${val}</v></c>`
      } else if (col.type === 'boolean') {
        // Write as string "Yes"/"No" with color
        const label = val ? 'Yes' : 'No'
        xml += `<c r="${ref}"${sAttr} t="inlineStr"><is><t>${label}</t></is></c>`
      } else {
        xml += `<c r="${ref}"${sAttr} t="inlineStr"><is><t>${xmlEscape(String(val))}</t></is></c>`
      }
    })
    xml += '</row>'
  })

  xml += '</sheetData></worksheet>'
  return xml
}

export function tableToXlsx(columns: ExportColumn[], rows: Record<string, unknown>[], filename: string): void {
  const enc = new TextEncoder()
  const sheetXml = buildSheetXml(columns, rows)

  const zipData = zipSync({
    '[Content_Types].xml': enc.encode(CONTENT_TYPES),
    '_rels/.rels': enc.encode(RELS),
    'xl/workbook.xml': enc.encode(WORKBOOK),
    'xl/_rels/workbook.xml.rels': enc.encode(WORKBOOK_RELS),
    'xl/worksheets/sheet1.xml': enc.encode(sheetXml),
    'xl/styles.xml': enc.encode(STYLES),
  })

  const blob = new Blob([zipData.buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
