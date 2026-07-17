import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { useI18n } from '../../i18n';
import { useInteractionBlocker } from '../../interactionBlockContext';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '../ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { XIcon } from 'lucide-react';
import styles from './EnhancedMarkdownTable.module.css';

type TableElement = ReactElement<{
  children?: ReactNode;
  style?: CSSProperties;
}>;
type TextFilterOperator =
  | 'contains'
  | 'equals'
  | 'notEquals'
  | 'startsWith'
  | 'endsWith';
type NumberFilterOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'between';
type TableDensity = 'standard' | 'compact' | 'comfortable';

export interface EnhancedTableCell {
  key: string;
  content: ReactNode;
  text: string;
  rawText?: string;
  isHeader: boolean;
  textAlign?: CSSProperties['textAlign'];
}

export interface EnhancedTableRow {
  key: string;
  cells: EnhancedTableCell[];
}

export interface EnhancedTableData {
  headers: EnhancedTableCell[];
  rows: EnhancedTableRow[];
  columnCount: number;
}

interface SortState {
  columnIndex: number;
  direction: 'asc' | 'desc';
}

interface SelectionRange {
  anchorRow: number;
  anchorCol: number;
  focusRow: number;
  focusCol: number;
}

interface SelectionStatistics {
  selectedCount: number;
  nonEmptyCount: number;
  numericCount: number;
  sum: number;
  average: number;
  min: number;
  max: number;
  format: 'number' | 'percent' | 'currency';
  currencySymbol?: string;
}

interface ColumnFilter {
  selectedValues?: string[];
  textFilter?: {
    operator: TextFilterOperator;
    value: string;
  };
  numberFilter?: {
    operator: NumberFilterOperator;
    value: string;
    valueTo?: string;
  };
}

interface OpenFilterMenu {
  columnIndex: number;
}

interface ColumnContextMenu {
  left: number;
  top: number;
}

interface ColumnResizeState {
  columnIndex: number;
  startX: number;
  startWidth: number;
}

interface CellDialogState {
  rowKey: string;
  columnIndex: number;
}

interface FilterOption {
  value: string;
  label: string;
  count: number;
}

const TEXT_FILTER_LABEL_KEYS: Record<TextFilterOperator, string> = {
  contains: 'markdownTable.filter.text.contains',
  equals: 'markdownTable.filter.text.equals',
  notEquals: 'markdownTable.filter.text.notEquals',
  startsWith: 'markdownTable.filter.text.startsWith',
  endsWith: 'markdownTable.filter.text.endsWith',
};

const NUMBER_FILTER_LABEL_KEYS: Record<NumberFilterOperator, string> = {
  gt: 'markdownTable.filter.number.gt',
  gte: 'markdownTable.filter.number.gte',
  lt: 'markdownTable.filter.number.lt',
  lte: 'markdownTable.filter.number.lte',
  between: 'markdownTable.filter.number.between',
};

export const MAX_ENHANCED_TABLE_ROWS = 500;
export const MAX_ENHANCED_TABLE_COLUMNS = 50;
const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 80;
const MAX_COLUMN_WIDTH = 640;
const KEYBOARD_COLUMN_RESIZE_STEP = 16;
const COLUMN_DRAG_MIME = 'application/x-qwen-web-shell-table-column';
const LONG_CELL_TEXT_LENGTH = 60;
const LONG_CELL_LINE_COUNT = 3;
const DENSITY_ORDER: TableDensity[] = ['standard', 'compact', 'comfortable'];
const DEFAULT_COLUMN_STYLE: CSSProperties = {
  width: DEFAULT_COLUMN_WIDTH,
  minWidth: DEFAULT_COLUMN_WIDTH,
  maxWidth: DEFAULT_COLUMN_WIDTH,
};
const COMPACT_AUTO_COLUMN_STYLE: CSSProperties = {
  width: 'auto',
};

function clampColumnWidth(width: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width));
}

function isInteractiveSelectionTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'a, button, input, textarea, select, [contenteditable="true"]',
      ),
    )
  );
}

function hasNativeSelection(): boolean {
  const selection = document.getSelection();
  return Boolean(selection && !selection.isCollapsed);
}

function isTagElement(node: ReactNode, tag: string): node is TableElement {
  return isValidElement<{ children?: ReactNode }>(node) && node.type === tag;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isLongCellText(value: string): boolean {
  return (
    value.length > LONG_CELL_TEXT_LENGTH ||
    value.split(/\r\n|\r|\n/).length > LONG_CELL_LINE_COUNT
  );
}

function nextDensity(current: TableDensity): TableDensity {
  const index = DENSITY_ORDER.indexOf(current);
  return DENSITY_ORDER[(index + 1) % DENSITY_ORDER.length] ?? 'standard';
}

function densityClassName(density: TableDensity): string {
  switch (density) {
    case 'compact':
      return styles.densityCompact;
    case 'comfortable':
      return styles.densityComfortable;
    case 'standard':
    default:
      return styles.densityStandard;
  }
}

function getTextContent(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(getTextContent).join('');
  }
  if (isValidElement<{ alt?: string; children?: ReactNode }>(node)) {
    if (node.type === 'img') return node.props.alt ?? '';
    return getTextContent(node.props.children);
  }
  return '';
}

function emptyCell(rowKey: string, columnIndex: number): EnhancedTableCell {
  return {
    key: `${rowKey}-empty-${columnIndex}`,
    content: '',
    text: '',
    rawText: '',
    isHeader: false,
  };
}

function parseRow(rowNode: TableElement, rowKey: string): EnhancedTableRow {
  const cellNodes = Children.toArray(rowNode.props.children).filter(
    (child) => isTagElement(child, 'td') || isTagElement(child, 'th'),
  );
  return {
    key: rowKey,
    cells: cellNodes.map((cellNode, cellIndex) => {
      const rawText = getTextContent(cellNode.props.children);
      return {
        key: `${rowKey}-${cellIndex}`,
        content: cellNode.props.children,
        text: normalizeText(rawText),
        rawText,
        isHeader: cellNode.type === 'th',
        textAlign: cellNode.props.style?.textAlign,
      };
    }),
  };
}

function parseRows(
  sectionNode: TableElement,
  prefix: string,
): EnhancedTableRow[] {
  return Children.toArray(sectionNode.props.children)
    .filter((child) => isTagElement(child, 'tr'))
    .map((rowNode, rowIndex) => parseRow(rowNode, `${prefix}-${rowIndex}`));
}

function normalizeRow(
  row: EnhancedTableRow,
  columnCount: number,
): EnhancedTableRow {
  return {
    ...row,
    cells: Array.from(
      { length: columnCount },
      (_, columnIndex) =>
        row.cells[columnIndex] ?? emptyCell(row.key, columnIndex),
    ),
  };
}

function parseTable(
  children: ReactNode,
  defaultColumnLabel: (columnIndex: number) => string,
): EnhancedTableData {
  const topLevel = Children.toArray(children);
  const headerRows: EnhancedTableRow[] = [];
  const bodyRows: EnhancedTableRow[] = [];
  const directRows: EnhancedTableRow[] = [];

  topLevel.forEach((child, index) => {
    if (isTagElement(child, 'thead')) {
      headerRows.push(...parseRows(child, `head-${index}`));
    } else if (isTagElement(child, 'tbody')) {
      bodyRows.push(...parseRows(child, `body-${index}`));
    } else if (isTagElement(child, 'tfoot')) {
      bodyRows.push(...parseRows(child, `foot-${index}`));
    } else if (isTagElement(child, 'tr')) {
      directRows.push(parseRow(child, `row-${index}`));
    }
  });

  if (directRows.length > 0) {
    const [firstRow, ...restRows] = directRows;
    if (firstRow?.cells.some((cell) => cell.isHeader)) {
      headerRows.push(firstRow);
      bodyRows.push(...restRows);
    } else {
      bodyRows.push(...directRows);
    }
  }

  const allRows = [...headerRows, ...bodyRows];
  const columnCount = Math.max(0, ...allRows.map((row) => row.cells.length));
  const firstHeaderRow = headerRows[0];
  const headers = Array.from({ length: columnCount }, (_, columnIndex) => {
    const cell = firstHeaderRow?.cells[columnIndex];
    if (cell) return cell;
    const label = defaultColumnLabel(columnIndex);
    return {
      key: `header-${columnIndex}`,
      content: label,
      text: label,
      rawText: label,
      isHeader: true,
    };
  });

  return {
    headers,
    rows: bodyRows.map((row) => normalizeRow(row, columnCount)),
    columnCount,
  };
}

function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  const isPercent = trimmed.endsWith('%');
  const numericText = isPercent ? trimmed.slice(0, -1) : trimmed;
  const normalized = numericText.replace(/[$€£¥₹,\s]/g, '');
  if (!/^-?(\d+(\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return isPercent ? parsed / 100 : parsed;
}

function compareCellText(a: string, b: string): number {
  const aNumber = parseNumber(a);
  const bNumber = parseNumber(b);
  if (aNumber !== null && bNumber !== null && aNumber !== bNumber) {
    return aNumber - bNumber;
  }
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function getSelectionRowBounds(range: SelectionRange) {
  return {
    minRow: Math.min(range.anchorRow, range.focusRow),
    maxRow: Math.max(range.anchorRow, range.focusRow),
  };
}

function getSelectedColumnIndexes(
  range: SelectionRange | null,
  visibleColumnIndexes: number[],
): number[] {
  if (!range) return [];
  const anchorIndex = visibleColumnIndexes.indexOf(range.anchorCol);
  const focusIndex = visibleColumnIndexes.indexOf(range.focusCol);
  if (anchorIndex === -1 || focusIndex === -1) return [];
  const minIndex = Math.min(anchorIndex, focusIndex);
  const maxIndex = Math.max(anchorIndex, focusIndex);
  return visibleColumnIndexes.slice(minIndex, maxIndex + 1);
}

function sanitizeForClipboard(value: string): string {
  const inspectedValue = value
    .replace(/[\u200B-\u200D\u2060\u00AD\uFEFF]/g, '')
    .trimStart();
  return /^[=+\-@]/.test(inspectedValue) ? `'${value}` : value;
}

function cellClipboardText(cell: EnhancedTableCell | undefined): string {
  return (cell?.rawText ?? cell?.text ?? '').replace(/[\r\n\t]+/g, ' ');
}

function cellReadableText(cell: EnhancedTableCell): string {
  return cell.rawText || cell.text;
}

function applyColumnWidth(
  current: Record<number, number>,
  columnIndex: number,
  nextWidth: number,
): Record<number, number> {
  const currentWidth = current[columnIndex] ?? DEFAULT_COLUMN_WIDTH;
  if (currentWidth === nextWidth) return current;
  if (nextWidth === DEFAULT_COLUMN_WIDTH) {
    const next = { ...current };
    delete next[columnIndex];
    return next;
  }
  return {
    ...current,
    [columnIndex]: nextWidth,
  };
}

function getSelectionText(
  range: SelectionRange | null,
  rows: EnhancedTableRow[],
  visibleColumnIndexes: number[],
): string {
  if (!range) return '';
  const { minRow, maxRow } = getSelectionRowBounds(range);
  const selectedColumns = getSelectedColumnIndexes(range, visibleColumnIndexes);
  if (selectedColumns.length === 0) return '';

  const lines: string[] = [];
  for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex++) {
    const row = rows[rowIndex];
    if (!row) continue;
    lines.push(
      selectedColumns
        .map((columnIndex) =>
          sanitizeForClipboard(cellClipboardText(row.cells[columnIndex])),
        )
        .join('\t'),
    );
  }
  return lines.join('\n');
}

function getVisibleTableText(
  headers: EnhancedTableCell[],
  rows: EnhancedTableRow[],
  visibleColumnIndexes: number[],
): string {
  if (visibleColumnIndexes.length === 0) return '';
  const lines = [
    visibleColumnIndexes
      .map((columnIndex) =>
        sanitizeForClipboard(cellClipboardText(headers[columnIndex])),
      )
      .join('\t'),
    ...rows.map((row) =>
      visibleColumnIndexes
        .map((columnIndex) =>
          sanitizeForClipboard(cellClipboardText(row.cells[columnIndex])),
        )
        .join('\t'),
    ),
  ];
  return lines.join('\n');
}

function getSelectionStatistics(
  range: SelectionRange | null,
  rows: EnhancedTableRow[],
  visibleColumnIndexes: number[],
): SelectionStatistics | null {
  if (!range) return null;
  const { minRow, maxRow } = getSelectionRowBounds(range);
  const selectedColumns = getSelectedColumnIndexes(range, visibleColumnIndexes);
  if (selectedColumns.length === 0) return null;

  let selectedCount = 0;
  let nonEmptyCount = 0;
  let numericCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let allPercent = true;
  let allCurrency = true;
  let currencySymbol: string | undefined;

  for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex++) {
    const row = rows[rowIndex];
    if (!row) continue;
    selectedColumns.forEach((columnIndex) => {
      const cell = row.cells[columnIndex];
      if (!cell) return;
      selectedCount += 1;
      const value = cell.text.trim();
      if (!value) return;
      nonEmptyCount += 1;
      const numericValue = parseNumber(value);
      if (numericValue === null) return;

      numericCount += 1;
      sum += numericValue;
      min = Math.min(min, numericValue);
      max = Math.max(max, numericValue);
      allPercent = allPercent && value.endsWith('%');

      const symbols = value.match(/[$€£¥₹]/g);
      const currentSymbol = symbols?.length === 1 ? symbols[0] : undefined;
      if (!currentSymbol) {
        allCurrency = false;
      } else if (currencySymbol === undefined) {
        currencySymbol = currentSymbol;
      } else if (currencySymbol !== currentSymbol) {
        allCurrency = false;
      }
    });
  }

  if (selectedCount === 0) return null;
  const format =
    numericCount > 0 && allPercent
      ? 'percent'
      : numericCount > 0 && allCurrency && currencySymbol
        ? 'currency'
        : 'number';
  return {
    selectedCount,
    nonEmptyCount,
    numericCount,
    sum,
    average: numericCount > 0 ? sum / numericCount : 0,
    min: numericCount > 0 ? min : 0,
    max: numericCount > 0 ? max : 0,
    format,
    currencySymbol,
  };
}

function formatSelectionStatistic(
  value: number,
  statistics: SelectionStatistics,
  language: string,
): string {
  const normalizedValue = Object.is(value, -0) ? 0 : value;
  const locale = language === 'en' ? 'en-US' : language;
  if (statistics.format === 'percent') {
    return new Intl.NumberFormat(locale, {
      style: 'percent',
      maximumFractionDigits: 6,
    }).format(normalizedValue);
  }

  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 6,
  }).format(Math.abs(normalizedValue));
  if (statistics.format === 'currency' && statistics.currencySymbol) {
    return `${normalizedValue < 0 ? '-' : ''}${statistics.currencySymbol}${formatted}`;
  }
  return normalizedValue < 0 ? `-${formatted}` : formatted;
}

function moveColumn(order: number[], fromColumn: number, toColumn: number) {
  if (fromColumn === toColumn) return order;
  const fromIndex = order.indexOf(fromColumn);
  const toIndex = order.indexOf(toColumn);
  if (fromIndex === -1 || toIndex === -1) return order;
  const next = [...order];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return order;
  next.splice(toIndex, 0, moved);
  return next;
}

function moveVisibleColumn(
  order: number[],
  fromColumn: number,
  toColumn: number,
  hiddenColumns: Set<number>,
) {
  if (hiddenColumns.size === 0) return moveColumn(order, fromColumn, toColumn);
  const visibleColumns = order.filter(
    (columnIndex) => !hiddenColumns.has(columnIndex),
  );
  const nextVisibleColumns = moveColumn(visibleColumns, fromColumn, toColumn);
  if (nextVisibleColumns === visibleColumns) return order;
  let visibleIndex = 0;
  return order.map((columnIndex) => {
    if (hiddenColumns.has(columnIndex)) return columnIndex;
    const nextColumn = nextVisibleColumns[visibleIndex];
    visibleIndex += 1;
    return nextColumn ?? columnIndex;
  });
}

function initialColumnOrder(columnCount: number): number[] {
  return Array.from({ length: columnCount }, (_, index) => index);
}

function hasColumnDragData(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(COLUMN_DRAG_MIME);
}

function isFilterActive(filter: ColumnFilter | undefined): boolean {
  if (!filter) return false;
  if (filter.selectedValues !== undefined) return true;
  if (filter.textFilter?.value.trim()) return true;
  if (filter.numberFilter?.value.trim()) return true;
  return false;
}

function matchesTextFilter(value: string, filter: ColumnFilter['textFilter']) {
  if (!filter?.value.trim()) return true;
  const cellText = value.toLowerCase();
  const filterText = filter.value.trim().toLowerCase();
  switch (filter.operator) {
    case 'equals':
      return cellText === filterText;
    case 'notEquals':
      return cellText !== filterText;
    case 'startsWith':
      return cellText.startsWith(filterText);
    case 'endsWith':
      return cellText.endsWith(filterText);
    case 'contains':
    default:
      return cellText.includes(filterText);
  }
}

function matchesNumberFilter(
  value: string,
  filter: ColumnFilter['numberFilter'],
) {
  if (!filter?.value.trim()) return true;
  const cellNumber = parseNumber(value);
  const filterNumber = parseNumber(filter.value);
  if (cellNumber === null || filterNumber === null) return false;

  switch (filter.operator) {
    case 'gt':
      return cellNumber > filterNumber;
    case 'gte':
      return cellNumber >= filterNumber;
    case 'lt':
      return cellNumber < filterNumber;
    case 'lte':
      return cellNumber <= filterNumber;
    case 'between': {
      const filterNumberTo = parseNumber(filter.valueTo ?? '');
      if (filterNumberTo === null) return false;
      const min = Math.min(filterNumber, filterNumberTo);
      const max = Math.max(filterNumber, filterNumberTo);
      return cellNumber >= min && cellNumber <= max;
    }
    default:
      return true;
  }
}

function matchesColumnFilter(value: string, filter: ColumnFilter): boolean {
  if (
    filter.selectedValues !== undefined &&
    !filter.selectedValues.includes(value)
  ) {
    return false;
  }
  return (
    matchesTextFilter(value, filter.textFilter) &&
    matchesNumberFilter(value, filter.numberFilter)
  );
}

function applyFilters(
  rows: EnhancedTableRow[],
  filters: Record<number, ColumnFilter>,
  excludeColumnIndex?: number,
): EnhancedTableRow[] {
  const activeFilters = Object.entries(filters)
    .map(([key, value]) => [Number(key), value] as const)
    .filter(
      ([columnIndex, value]) =>
        columnIndex !== excludeColumnIndex && isFilterActive(value),
    );

  if (activeFilters.length === 0) return rows;
  return rows.filter((row) =>
    activeFilters.every(([columnIndex, filter]) =>
      matchesColumnFilter(row.cells[columnIndex]?.text ?? '', filter),
    ),
  );
}

function sortRows(
  rows: EnhancedTableRow[],
  sort: SortState | null,
): EnhancedTableRow[] {
  if (!sort) return rows;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const result = compareCellText(
        a.row.cells[sort.columnIndex]?.text ?? '',
        b.row.cells[sort.columnIndex]?.text ?? '',
      );
      const sorted = sort.direction === 'asc' ? result : -result;
      return sorted === 0 ? a.index - b.index : sorted;
    })
    .map(({ row }) => row);
}

function getColumnOptions(
  rows: EnhancedTableRow[],
  columnIndex: number,
  blankLabel: string,
): FilterOption[] {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    const value = row.cells[columnIndex]?.text ?? '';
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });

  return Array.from(counts.entries())
    .map(([value, count]) => ({
      value,
      label: value || blankLabel,
      count,
    }))
    .sort((a, b) => compareCellText(a.value, b.value));
}

function isMostlyNumericColumn(
  rows: EnhancedTableRow[],
  columnIndex: number,
): boolean {
  let filledCount = 0;
  let numericCount = 0;
  rows.forEach((row) => {
    const value = row.cells[columnIndex]?.text ?? '';
    if (!value) return;
    filledCount += 1;
    if (parseNumber(value) !== null) numericCount += 1;
  });
  return filledCount > 0 && numericCount / filledCount >= 0.7;
}

function hasSameValues(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const aSet = new Set(a);
  return b.every((value) => aSet.has(value));
}

function normalizeFilter(
  filter: ColumnFilter,
  allOptionValues: string[],
): ColumnFilter | undefined {
  const next: ColumnFilter = {};
  if (
    filter.selectedValues !== undefined &&
    !hasSameValues(filter.selectedValues, allOptionValues)
  ) {
    next.selectedValues = filter.selectedValues;
  }

  if (filter.textFilter?.value.trim()) {
    next.textFilter = {
      operator: filter.textFilter.operator,
      value: filter.textFilter.value.trim(),
    };
  }

  if (filter.numberFilter?.value.trim()) {
    const value = filter.numberFilter.value.trim();
    const valueTo = filter.numberFilter.valueTo?.trim();
    if (
      parseNumber(value) !== null &&
      (filter.numberFilter.operator !== 'between' ||
        parseNumber(valueTo ?? '') !== null)
    ) {
      next.numberFilter = {
        operator: filter.numberFilter.operator,
        value,
        valueTo,
      };
    }
  }

  return isFilterActive(next) ? next : undefined;
}

function SortMenuSection({
  columnIndex,
  sortedThisColumn,
  onSort,
}: {
  columnIndex: number;
  sortedThisColumn: SortState | null;
  onSort: (
    columnIndex: number,
    direction: SortState['direction'] | null,
  ) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-1.5 border-b px-2.5 py-2">
      <Button
        variant="ghost"
        size="sm"
        className={`w-full justify-start text-xs ${
          sortedThisColumn?.direction === 'asc' ? 'bg-muted text-primary' : ''
        }`}
        type="button"
        onClick={() => onSort(columnIndex, 'asc')}
      >
        {t('markdownTable.sort.asc')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={`w-full justify-start text-xs ${
          sortedThisColumn?.direction === 'desc' ? 'bg-muted text-primary' : ''
        }`}
        type="button"
        onClick={() => onSort(columnIndex, 'desc')}
      >
        {t('markdownTable.sort.desc')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start text-xs"
        type="button"
        onClick={() => onSort(columnIndex, null)}
      >
        {t('markdownTable.sort.clear')}
      </Button>
    </div>
  );
}

function VisibilityMenuSection({ onHideColumn }: { onHideColumn: () => void }) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-1.5 border-b px-2.5 py-2">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start text-xs"
        type="button"
        onClick={onHideColumn}
      >
        {t('markdownTable.hideColumn')}
      </Button>
    </div>
  );
}

function ValueFilterSection({
  columnIndex,
  columnName,
  search,
  searchInputRef,
  filteredOptions,
  visibleOptions,
  selectedValues,
  allFilteredSelected,
  onSearchChange,
  onFilteredSelectionChange,
  onToggleValue,
}: {
  columnIndex: number;
  columnName: string;
  search: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  filteredOptions: FilterOption[];
  visibleOptions: FilterOption[];
  selectedValues: Set<string>;
  allFilteredSelected: boolean;
  onSearchChange: (value: string) => void;
  onFilteredSelectionChange: (selected: boolean) => void;
  onToggleValue: (value: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-1.5 border-b px-2.5 py-2">
      <Input
        ref={searchInputRef}
        className="h-7 text-xs"
        value={search}
        onChange={(event) => onSearchChange(event.currentTarget.value)}
        placeholder={t('markdownTable.filter.searchPlaceholder')}
        name={`markdown-table-option-search-${columnIndex}`}
        aria-label={t('markdownTable.filter.searchAria', {
          column: columnName,
        })}
      />
      <Label
        htmlFor={`markdown-table-filter-all-${columnIndex}`}
        className="min-h-7 cursor-pointer gap-2 px-1.5 py-1 text-xs font-normal hover:bg-muted"
      >
        <Checkbox
          id={`markdown-table-filter-all-${columnIndex}`}
          name={`markdown-table-filter-all-${columnIndex}`}
          data-name={`markdown-table-filter-all-${columnIndex}`}
          checked={allFilteredSelected}
          onCheckedChange={(checked) =>
            onFilteredSelectionChange(checked === true)
          }
        />
        <span>{t('markdownTable.filter.selectVisible')}</span>
        <span className="ml-auto text-muted-foreground tabular-nums">
          {filteredOptions.length}
        </span>
      </Label>
      <div className="max-h-[170px] overflow-auto rounded-md border bg-muted/50">
        {visibleOptions.map((option, optionIndex) => (
          <Label
            key={option.value}
            htmlFor={`markdown-table-filter-option-${columnIndex}-${optionIndex}`}
            className="min-h-7 cursor-pointer gap-2 px-1.5 py-1 text-xs font-normal hover:bg-muted"
          >
            <Checkbox
              id={`markdown-table-filter-option-${columnIndex}-${optionIndex}`}
              name={`markdown-table-filter-option-${columnIndex}-${optionIndex}`}
              data-name={`markdown-table-filter-option-${columnIndex}-${optionIndex}`}
              checked={selectedValues.has(option.value)}
              onCheckedChange={() => onToggleValue(option.value)}
            />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <span className="ml-auto text-muted-foreground tabular-nums">
              {option.count}
            </span>
          </Label>
        ))}
        {filteredOptions.length > visibleOptions.length && (
          <div className="p-2 text-center text-muted-foreground">
            {t('markdownTable.filter.optionLimit', {
              count: visibleOptions.length,
            })}
          </div>
        )}
        {filteredOptions.length === 0 && (
          <div className="p-2 text-center text-muted-foreground">
            {t('markdownTable.filter.noOptions')}
          </div>
        )}
      </div>
    </div>
  );
}

function CustomFilterSection({
  overlayId,
  columnIndex,
  columnName,
  isNumeric,
  textOperator,
  textValue,
  numberOperator,
  numberValue,
  numberValueTo,
  onTextOperatorChange,
  onTextValueChange,
  onNumberOperatorChange,
  onNumberValueChange,
  onNumberValueToChange,
}: {
  overlayId: string;
  columnIndex: number;
  columnName: string;
  isNumeric: boolean;
  textOperator: TextFilterOperator;
  textValue: string;
  numberOperator: NumberFilterOperator;
  numberValue: string;
  numberValueTo: string;
  onTextOperatorChange: (value: TextFilterOperator) => void;
  onTextValueChange: (value: string) => void;
  onNumberOperatorChange: (value: NumberFilterOperator) => void;
  onNumberValueChange: (value: string) => void;
  onNumberValueToChange: (value: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-1.5 border-b px-2.5 py-2">
      <div className="font-semibold text-muted-foreground">
        {t('markdownTable.filter.custom')}
      </div>
      {isNumeric ? (
        <>
          <Select
            value={numberOperator}
            name={`markdown-table-number-operator-${columnIndex}`}
            onValueChange={(value) =>
              onNumberOperatorChange(value as NumberFilterOperator)
            }
          >
            <SelectTrigger
              size="sm"
              className="w-full text-xs"
              data-name={`markdown-table-number-operator-${columnIndex}`}
              aria-label={t('markdownTable.filter.numberAria', {
                column: columnName,
              })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              data-markdown-table-filter-owner={overlayId}
              className="z-[calc(var(--web-shell-popover-z-index,1000)+1)]"
            >
              {Object.entries(NUMBER_FILTER_LABEL_KEYS).map(
                ([value, labelKey]) => (
                  <SelectItem
                    key={value}
                    value={value}
                    data-value={value}
                    className="text-xs"
                  >
                    {t(labelKey)}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
          <div className="flex gap-1.5">
            <Input
              className="h-7 text-xs"
              value={numberValue}
              onChange={(event) =>
                onNumberValueChange(event.currentTarget.value)
              }
              placeholder={t('markdownTable.filter.numberPlaceholder')}
              name={`markdown-table-number-filter-${columnIndex}`}
            />
            {numberOperator === 'between' && (
              <Input
                className="h-7 text-xs"
                value={numberValueTo}
                onChange={(event) =>
                  onNumberValueToChange(event.currentTarget.value)
                }
                placeholder={t('markdownTable.filter.toPlaceholder')}
                name={`markdown-table-number-filter-to-${columnIndex}`}
              />
            )}
          </div>
        </>
      ) : (
        <>
          <Select
            value={textOperator}
            name={`markdown-table-text-operator-${columnIndex}`}
            onValueChange={(value) =>
              onTextOperatorChange(value as TextFilterOperator)
            }
          >
            <SelectTrigger
              size="sm"
              className="w-full text-xs"
              data-name={`markdown-table-text-operator-${columnIndex}`}
              aria-label={t('markdownTable.filter.textAria', {
                column: columnName,
              })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              data-markdown-table-filter-owner={overlayId}
              className="z-[calc(var(--web-shell-popover-z-index,1000)+1)]"
            >
              {Object.entries(TEXT_FILTER_LABEL_KEYS).map(
                ([value, labelKey]) => (
                  <SelectItem
                    key={value}
                    value={value}
                    data-value={value}
                    className="text-xs"
                  >
                    {t(labelKey)}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
          <Input
            className="h-7 text-xs"
            value={textValue}
            onChange={(event) => onTextValueChange(event.currentTarget.value)}
            placeholder={t('markdownTable.filter.textPlaceholder')}
            name={`markdown-table-text-filter-${columnIndex}`}
          />
        </>
      )}
    </div>
  );
}

function FilterMenuFooter({
  onClear,
  onClose,
  onApply,
}: {
  onClear: () => void;
  onClose: () => void;
  onApply: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex items-center gap-1.5 px-2.5 py-2">
      <Button variant="outline" size="sm" type="button" onClick={onClear}>
        {t('markdownTable.filter.reset')}
      </Button>
      <span className="flex-1" />
      <Button variant="outline" size="sm" type="button" onClick={onClose}>
        {t('markdownTable.filter.cancel')}
      </Button>
      <Button size="sm" type="button" onClick={onApply}>
        {t('markdownTable.filter.confirm')}
      </Button>
    </div>
  );
}

function ColumnFilterMenu({
  id,
  columnName,
  columnIndex,
  filter,
  isNumeric,
  options,
  sort,
  canHideColumn,
  onApply,
  onClose,
  onHideColumn,
  onSort,
}: {
  id: string;
  columnName: string;
  columnIndex: number;
  filter?: ColumnFilter;
  isNumeric: boolean;
  options: FilterOption[];
  sort: SortState | null;
  canHideColumn: boolean;
  onApply: (columnIndex: number, filter: ColumnFilter | undefined) => void;
  onClose: () => void;
  onHideColumn: (columnIndex: number) => void;
  onSort: (
    columnIndex: number,
    direction: SortState['direction'] | null,
  ) => void;
}) {
  const allOptionValues = useMemo(
    () => options.map((option) => option.value),
    [options],
  );
  const [search, setSearch] = useState('');
  const [selectedValues, setSelectedValues] = useState<Set<string>>(
    () => new Set(filter?.selectedValues ?? allOptionValues),
  );
  const [textOperator, setTextOperator] = useState<TextFilterOperator>(
    filter?.textFilter?.operator ?? 'contains',
  );
  const [textValue, setTextValue] = useState(filter?.textFilter?.value ?? '');
  const [numberOperator, setNumberOperator] = useState<NumberFilterOperator>(
    filter?.numberFilter?.operator ?? 'gt',
  );
  const [numberValue, setNumberValue] = useState(
    filter?.numberFilter?.value ?? '',
  );
  const [numberValueTo, setNumberValueTo] = useState(
    filter?.numberFilter?.valueTo ?? '',
  );
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  const filteredOptions = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return options;
    return options.filter((option) =>
      option.label.toLowerCase().includes(keyword),
    );
  }, [options, search]);
  const visibleOptions = filteredOptions.slice(0, 500);
  const allFilteredSelected =
    filteredOptions.length > 0 &&
    filteredOptions.every((option) => selectedValues.has(option.value));

  const setFilteredSelection = (selected: boolean) => {
    setSelectedValues((current) => {
      const next = new Set(current);
      filteredOptions.forEach((option) => {
        if (selected) {
          next.add(option.value);
        } else {
          next.delete(option.value);
        }
      });
      return next;
    });
  };

  const toggleValue = (value: string) => {
    setSelectedValues((current) => {
      const next = new Set(current);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  };

  const applyDraft = () => {
    onApply(
      columnIndex,
      normalizeFilter(
        {
          selectedValues: Array.from(selectedValues),
          textFilter: {
            operator: textOperator,
            value: textValue,
          },
          numberFilter: {
            operator: numberOperator,
            value: numberValue,
            valueTo: numberValueTo,
          },
        },
        allOptionValues,
      ),
    );
  };

  const clearFilter = () => {
    onApply(columnIndex, undefined);
  };

  const sortedThisColumn = sort?.columnIndex === columnIndex ? sort : null;

  return (
    <PopoverContent
      id={id}
      data-markdown-table-filter-owner={id}
      align="end"
      sideOffset={2}
      collisionPadding={6}
      className="max-h-[min(430px,calc(100vh-16px))] w-[300px] max-w-[80vw] gap-0 overflow-auto p-0 text-xs"
      role="dialog"
      aria-labelledby={`${id}-title`}
    >
      <PopoverHeader className="border-b px-2.5 py-2">
        <PopoverTitle id={`${id}-title`} className="truncate text-xs font-bold">
          {columnName}
        </PopoverTitle>
      </PopoverHeader>
      <SortMenuSection
        columnIndex={columnIndex}
        sortedThisColumn={sortedThisColumn}
        onSort={onSort}
      />
      {canHideColumn && (
        <VisibilityMenuSection onHideColumn={() => onHideColumn(columnIndex)} />
      )}
      <ValueFilterSection
        columnIndex={columnIndex}
        columnName={columnName}
        search={search}
        searchInputRef={searchInputRef}
        filteredOptions={filteredOptions}
        visibleOptions={visibleOptions}
        selectedValues={selectedValues}
        allFilteredSelected={allFilteredSelected}
        onSearchChange={setSearch}
        onFilteredSelectionChange={setFilteredSelection}
        onToggleValue={toggleValue}
      />
      <CustomFilterSection
        overlayId={id}
        columnIndex={columnIndex}
        columnName={columnName}
        isNumeric={isNumeric}
        textOperator={textOperator}
        textValue={textValue}
        numberOperator={numberOperator}
        numberValue={numberValue}
        numberValueTo={numberValueTo}
        onTextOperatorChange={setTextOperator}
        onTextValueChange={setTextValue}
        onNumberOperatorChange={setNumberOperator}
        onNumberValueChange={setNumberValue}
        onNumberValueToChange={setNumberValueTo}
      />
      <FilterMenuFooter
        onClear={clearFilter}
        onClose={onClose}
        onApply={applyDraft}
      />
    </PopoverContent>
  );
}

interface EnhancedMarkdownTableProps {
  children?: ReactNode;
  fallback?: ReactNode;
  toolbarExtra?: ReactNode;
}

export function EnhancedMarkdownTable({
  children,
  fallback,
  toolbarExtra,
}: EnhancedMarkdownTableProps) {
  const { t } = useI18n();
  const table = useMemo(
    () =>
      parseTable(children, (columnIndex) =>
        t('markdownTable.column', { index: columnIndex + 1 }),
      ),
    [children, t],
  );

  if (table.columnCount === 0)
    return <>{fallback ?? <table>{children}</table>}</>;
  if (
    table.rows.length > MAX_ENHANCED_TABLE_ROWS ||
    table.columnCount > MAX_ENHANCED_TABLE_COLUMNS
  ) {
    return <>{fallback ?? <table>{children}</table>}</>;
  }

  return <EnhancedTable table={table} toolbarExtra={toolbarExtra} />;
}

export function EnhancedTable({
  table,
  toolbarExtra,
}: {
  table: EnhancedTableData;
  toolbarExtra?: ReactNode;
}) {
  const { language, t } = useI18n();
  const registerInteractionBlocker = useInteractionBlocker();
  const tableId = useId();
  const [sort, setSort] = useState<SortState | null>(null);
  const [filters, setFilters] = useState<Record<number, ColumnFilter>>({});
  const [selection, setSelection] = useState<SelectionRange | null>(null);
  const [openFilterMenu, setOpenFilterMenu] = useState<OpenFilterMenu | null>(
    null,
  );
  const [columnContextMenu, setColumnContextMenu] =
    useState<ColumnContextMenu | null>(null);
  const [hiddenColumns, setHiddenColumns] = useState<Set<number>>(
    () => new Set(),
  );
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({});
  const [columnOrder, setColumnOrder] = useState<number[]>(() =>
    initialColumnOrder(table.columnCount),
  );
  const [activeColumn, setActiveColumn] = useState<number | null>(null);
  const [freezeFirstColumn, setFreezeFirstColumn] = useState(false);
  const [resizingColumn, setResizingColumn] =
    useState<ColumnResizeState | null>(null);
  const [detailRowKey, setDetailRowKey] = useState<string | null>(null);
  const [cellDialog, setCellDialog] = useState<CellDialogState | null>(null);
  const [longTextExpanded, setLongTextExpanded] = useState(false);
  const [density, setDensity] = useState<TableDensity>('standard');
  const [isDragging, setIsDragging] = useState(false);
  const [copiedVisible, setCopiedVisible] = useState(false);
  const [copiedSelection, setCopiedSelection] = useState(false);
  const [copiedCellDialog, setCopiedCellDialog] = useState(false);
  const draggingRef = useRef(false);
  const copiedVisibleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const copiedSelectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const copiedCellDialogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const copiedVisibleGenRef = useRef(0);
  const copiedSelectionGenRef = useRef(0);
  const copiedCellDialogGenRef = useRef(0);
  const mountedRef = useRef(true);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const columnContextMenuRef = useRef<HTMLDivElement | null>(null);
  const cellDialogRef = useRef<HTMLDivElement | null>(null);
  const cellDialogFocusReturnRef = useRef<HTMLElement | null>(null);
  const pendingSelectionRef = useRef<{
    rowIndex: number;
    columnIndex: number;
  } | null>(null);
  const selectionFrameRef = useRef(0);
  const resizeFrameRef = useRef(0);
  const pendingResizeWidthRef = useRef<number | null>(null);
  const draggingColumnRef = useRef<number | null>(null);
  const tableStructureKey = useMemo(
    () =>
      `${table.columnCount}\0${table.headers.map((header) => header.text).join('\0')}`,
    [table.columnCount, table.headers],
  );
  const tableStructureKeyRef = useRef(tableStructureKey);

  const closeFilterMenu = useCallback(() => {
    setOpenFilterMenu(null);
  }, []);

  const resetCopiedVisible = useCallback(() => {
    copiedVisibleGenRef.current += 1;
    if (copiedVisibleTimerRef.current) {
      clearTimeout(copiedVisibleTimerRef.current);
      copiedVisibleTimerRef.current = null;
    }
    setCopiedVisible(false);
  }, []);

  const resetCopiedSelection = useCallback(() => {
    copiedSelectionGenRef.current += 1;
    if (copiedSelectionTimerRef.current) {
      clearTimeout(copiedSelectionTimerRef.current);
      copiedSelectionTimerRef.current = null;
    }
    setCopiedSelection(false);
  }, []);

  const resetCopiedCellDialog = useCallback(() => {
    copiedCellDialogGenRef.current += 1;
    if (copiedCellDialogTimerRef.current) {
      clearTimeout(copiedCellDialogTimerRef.current);
      copiedCellDialogTimerRef.current = null;
    }
    setCopiedCellDialog(false);
  }, []);

  const flushPendingSelection = useCallback(() => {
    if (selectionFrameRef.current) {
      cancelAnimationFrame(selectionFrameRef.current);
      selectionFrameRef.current = 0;
    }
    const pendingSelection = pendingSelectionRef.current;
    pendingSelectionRef.current = null;
    if (!pendingSelection) return;
    setSelection((current) =>
      current
        ? {
            ...current,
            focusRow: pendingSelection.rowIndex,
            focusCol: pendingSelection.columnIndex,
          }
        : current,
    );
  }, []);

  const stopDragging = useCallback(() => {
    flushPendingSelection();
    draggingRef.current = false;
    setIsDragging(false);
  }, [flushPendingSelection]);

  useEffect(() => {
    const stopDraggingWhenHidden = () => {
      if (document.hidden) stopDragging();
    };
    window.addEventListener('mouseup', stopDragging);
    window.addEventListener('blur', stopDragging);
    document.addEventListener('visibilitychange', stopDraggingWhenHidden);
    return () => {
      window.removeEventListener('mouseup', stopDragging);
      window.removeEventListener('blur', stopDragging);
      document.removeEventListener('visibilitychange', stopDraggingWhenHidden);
      if (selectionFrameRef.current) {
        cancelAnimationFrame(selectionFrameRef.current);
      }
    };
  }, [stopDragging]);

  useEffect(() => {
    if (tableStructureKeyRef.current === tableStructureKey) return;
    tableStructureKeyRef.current = tableStructureKey;
    setSort(null);
    setFilters({});
    setSelection(null);
    setOpenFilterMenu(null);
    setColumnContextMenu(null);
    setHiddenColumns(new Set());
    setColumnWidths({});
    setColumnOrder(initialColumnOrder(table.columnCount));
    setActiveColumn(null);
    setFreezeFirstColumn(false);
    setResizingColumn(null);
    setDetailRowKey(null);
    setCellDialog(null);
    setLongTextExpanded(false);
    setDensity('standard');
    resetCopiedVisible();
    resetCopiedSelection();
    resetCopiedCellDialog();
    draggingRef.current = false;
    draggingColumnRef.current = null;
    setIsDragging(false);
  }, [
    resetCopiedSelection,
    resetCopiedCellDialog,
    resetCopiedVisible,
    table.columnCount,
    tableStructureKey,
  ]);

  useEffect(() => {
    resetCopiedSelection();
  }, [resetCopiedSelection, selection]);

  useEffect(() => {
    // StrictMode simulates an unmount/remount without re-running useRef's
    // initializer, so restore this before clipboard callbacks can run.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copiedVisibleTimerRef.current) {
        clearTimeout(copiedVisibleTimerRef.current);
        copiedVisibleTimerRef.current = null;
      }
      if (copiedSelectionTimerRef.current) {
        clearTimeout(copiedSelectionTimerRef.current);
        copiedSelectionTimerRef.current = null;
      }
      if (copiedCellDialogTimerRef.current) {
        clearTimeout(copiedCellDialogTimerRef.current);
        copiedCellDialogTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!openFilterMenu) return;
    const filterOwnerId = `${tableId}-filter-${openFilterMenu.columnIndex}`;
    const closeOnScroll = (event: Event) => {
      if (event.target instanceof Element) {
        const owner = event.target.closest(
          '[data-markdown-table-filter-owner]',
        );
        if (
          owner?.getAttribute('data-markdown-table-filter-owner') ===
          filterOwnerId
        ) {
          return;
        }
      }
      setOpenFilterMenu(null);
    };
    const closeOnResize = () => setOpenFilterMenu(null);
    document.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', closeOnResize);
    return () => {
      document.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [openFilterMenu, tableId]);

  useEffect(() => {
    if (!columnContextMenu) return;
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!columnContextMenuRef.current?.contains(target)) {
        setColumnContextMenu(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setColumnContextMenu(null);
      }
    };
    const closeOnScrollOrResize = () => setColumnContextMenu(null);
    document.addEventListener('mousedown', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('scroll', closeOnScrollOrResize, true);
    window.addEventListener('resize', closeOnScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('scroll', closeOnScrollOrResize, true);
      window.removeEventListener('resize', closeOnScrollOrResize);
    };
  }, [columnContextMenu]);

  useEffect(() => {
    const clearActiveColumnOnOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !shellRef.current?.contains(target) &&
        !columnContextMenuRef.current?.contains(target)
      ) {
        setActiveColumn(null);
      }
    };
    const clearActiveColumnOnEscape = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        openFilterMenu ||
        cellDialog ||
        columnContextMenu
      )
        return;
      if (event.key === 'Escape') setActiveColumn(null);
    };
    document.addEventListener('mousedown', clearActiveColumnOnOutsideMouseDown);
    document.addEventListener('keydown', clearActiveColumnOnEscape);
    return () => {
      document.removeEventListener(
        'mousedown',
        clearActiveColumnOnOutsideMouseDown,
      );
      document.removeEventListener('keydown', clearActiveColumnOnEscape);
    };
  }, [cellDialog, columnContextMenu, openFilterMenu]);

  const filteredRows = useMemo(
    () => applyFilters(table.rows, filters),
    [filters, table.rows],
  );
  const visibleRows = useMemo(
    () => sortRows(filteredRows, sort),
    [filteredRows, sort],
  );
  useEffect(() => {
    setSelection((current) => {
      if (!current) return current;
      return getSelectionRowBounds(current).maxRow < visibleRows.length
        ? current
        : null;
    });
  }, [visibleRows.length]);
  const openFilterOptions = useMemo(() => {
    if (!openFilterMenu) return [];
    const columnIndex = openFilterMenu.columnIndex;
    return getColumnOptions(
      applyFilters(table.rows, filters, columnIndex),
      columnIndex,
      t('markdownTable.blank'),
    );
  }, [filters, openFilterMenu, t, table.rows]);
  const numericColumns = useMemo(
    () =>
      table.headers.map((_, columnIndex) =>
        isMostlyNumericColumn(table.rows, columnIndex),
      ),
    [table.headers, table.rows],
  );
  const orderedVisibleColumnIndexes = useMemo(
    () =>
      columnOrder
        .filter((index) => index >= 0 && index < table.columnCount)
        .filter((index) => !hiddenColumns.has(index)),
    [columnOrder, hiddenColumns, table.columnCount],
  );
  const frozenColumnIndex = freezeFirstColumn
    ? orderedVisibleColumnIndexes[0]
    : undefined;
  const currentCellDialogCell = useMemo(() => {
    if (!cellDialog) return null;
    const row = visibleRows.find((item) => item.key === cellDialog.rowKey);
    return row?.cells[cellDialog.columnIndex] ?? null;
  }, [cellDialog, visibleRows]);
  const currentCellDialogText = currentCellDialogCell?.text;
  useEffect(() => {
    resetCopiedVisible();
  }, [resetCopiedVisible, orderedVisibleColumnIndexes, visibleRows]);

  useEffect(() => {
    if (!resizingColumn) return;
    const applyPendingResize = () => {
      const nextWidth = pendingResizeWidthRef.current;
      pendingResizeWidthRef.current = null;
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = 0;
      }
      if (nextWidth === null) return;
      setColumnWidths((current) =>
        applyColumnWidth(current, resizingColumn.columnIndex, nextWidth),
      );
    };
    const resizeColumn = (event: MouseEvent) => {
      pendingResizeWidthRef.current = clampColumnWidth(
        resizingColumn.startWidth + event.clientX - resizingColumn.startX,
      );
      if (resizeFrameRef.current) return;
      resizeFrameRef.current = requestAnimationFrame(applyPendingResize);
    };
    const stopResize = () => {
      applyPendingResize();
      setResizingColumn(null);
    };
    const stopResizeWhenHidden = () => {
      if (document.hidden) stopResize();
    };
    window.addEventListener('mousemove', resizeColumn);
    window.addEventListener('mouseup', stopResize);
    window.addEventListener('blur', stopResize);
    document.addEventListener('visibilitychange', stopResizeWhenHidden);
    return () => {
      window.removeEventListener('mousemove', resizeColumn);
      window.removeEventListener('mouseup', stopResize);
      window.removeEventListener('blur', stopResize);
      document.removeEventListener('visibilitychange', stopResizeWhenHidden);
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = 0;
      }
      pendingResizeWidthRef.current = null;
    };
  }, [resizingColumn]);

  useEffect(() => {
    if (detailRowKey && !visibleRows.some((row) => row.key === detailRowKey)) {
      setDetailRowKey(null);
    }
    if (
      cellDialog &&
      !visibleRows.some(
        (row) =>
          row.key === cellDialog.rowKey && row.cells[cellDialog.columnIndex],
      )
    ) {
      setCellDialog(null);
    }
  }, [cellDialog, detailRowKey, visibleRows]);

  useEffect(() => {
    if (!cellDialog) return;
    return registerInteractionBlocker();
  }, [cellDialog, registerInteractionBlocker]);

  useEffect(() => {
    if (!cellDialog) return;
    resetCopiedCellDialog();
  }, [cellDialog, currentCellDialogText, resetCopiedCellDialog]);

  useEffect(() => {
    if (!cellDialog) return;
    return () => {
      const focusReturn = cellDialogFocusReturnRef.current;
      cellDialogFocusReturnRef.current = null;
      if (focusReturn?.isConnected) focusReturn.focus();
    };
  }, [cellDialog]);

  const setColumnFilter = (
    columnIndex: number,
    nextFilter: ColumnFilter | undefined,
  ) => {
    setSelection(null);
    setFilters((current) => {
      const next = { ...current };
      if (nextFilter && isFilterActive(nextFilter)) {
        next[columnIndex] = nextFilter;
      } else {
        delete next[columnIndex];
      }
      return next;
    });
    closeFilterMenu();
  };

  const setColumnSort = (
    columnIndex: number,
    direction: SortState['direction'] | null,
  ) => {
    setSelection(null);
    setActiveColumn(columnIndex);
    setSort(direction ? { columnIndex, direction } : null);
  };

  const toggleSort = (columnIndex: number) => {
    setSelection(null);
    setActiveColumn(columnIndex);
    setSort((current) => {
      if (current?.columnIndex !== columnIndex) {
        return { columnIndex, direction: 'asc' };
      }
      if (current.direction === 'asc') {
        return { columnIndex, direction: 'desc' };
      }
      return null;
    });
  };

  const setFilterMenuOpen = (columnIndex: number, open: boolean) => {
    if (!open) {
      setOpenFilterMenu((current) =>
        current?.columnIndex === columnIndex ? null : current,
      );
      return;
    }
    setSelection(null);
    setActiveColumn(columnIndex);
    setColumnContextMenu(null);
    setOpenFilterMenu({ columnIndex });
  };

  const hideColumn = (columnIndex: number) => {
    if (orderedVisibleColumnIndexes.length <= 1) return;
    setSelection(null);
    setActiveColumn((current) => (current === columnIndex ? null : current));
    closeFilterMenu();
    setFilters((current) => {
      const next = { ...current };
      delete next[columnIndex];
      return next;
    });
    setSort((current) =>
      current?.columnIndex === columnIndex ? null : current,
    );
    setHiddenColumns((current) => {
      const next = new Set(current);
      next.add(columnIndex);
      return next;
    });
  };

  const showHiddenColumns = () => {
    setSelection(null);
    setHiddenColumns(new Set());
  };

  const toggleFreezeFirstColumnFromMenu = () => {
    setFreezeFirstColumn((current) => !current);
    setColumnContextMenu(null);
  };

  const openColumnContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    columnIndex: number,
  ) => {
    if (columnIndex !== orderedVisibleColumnIndexes[0]) {
      return;
    }
    event.preventDefault();
    setSelection(null);
    setActiveColumn(columnIndex);
    setOpenFilterMenu(null);
    const menuWidth = 220;
    const menuHeight = 72;
    setColumnContextMenu({
      left: Math.max(
        6,
        Math.min(event.clientX, window.innerWidth - menuWidth - 6),
      ),
      top: Math.max(
        6,
        Math.min(event.clientY, window.innerHeight - menuHeight - 6),
      ),
    });
  };

  const toggleDensity = () => {
    setDensity((current) => nextDensity(current));
  };

  const toggleRowDetail = (rowKey: string) => {
    setSelection(null);
    setCellDialog(null);
    resetCopiedCellDialog();
    setDetailRowKey((current) => (current === rowKey ? null : rowKey));
  };

  const openCellDialog = (rowKey: string, columnIndex: number) => {
    cellDialogFocusReturnRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setSelection(null);
    setOpenFilterMenu(null);
    setDetailRowKey(null);
    resetCopiedCellDialog();
    setCellDialog({
      rowKey,
      columnIndex,
    });
  };

  const closeCellDialog = () => {
    setCellDialog(null);
    resetCopiedCellDialog();
  };

  const copyCellDialogValue = () => {
    if (currentCellDialogText == null || !navigator.clipboard) return;
    const copyGeneration = copiedCellDialogGenRef.current;
    void navigator.clipboard
      .writeText(sanitizeForClipboard(currentCellDialogText))
      .then(() => {
        if (!mountedRef.current) return;
        if (copiedCellDialogGenRef.current !== copyGeneration) return;
        if (copiedCellDialogTimerRef.current) {
          clearTimeout(copiedCellDialogTimerRef.current);
        }
        setCopiedCellDialog(true);
        copiedCellDialogTimerRef.current = setTimeout(
          () => setCopiedCellDialog(false),
          2000,
        );
      })
      .catch((error: unknown) =>
        console.warn('[web-shell] clipboard write failed:', error),
      );
  };

  const selectionRowBounds = useMemo(
    () => (selection ? getSelectionRowBounds(selection) : null),
    [selection],
  );
  const selectedColumnIndexSet = useMemo(
    () =>
      new Set(getSelectedColumnIndexes(selection, orderedVisibleColumnIndexes)),
    [selection, orderedVisibleColumnIndexes],
  );

  const isCellSelected = (rowIndex: number, columnIndex: number): boolean => {
    if (!selectionRowBounds) return false;
    const { minRow, maxRow } = selectionRowBounds;
    return (
      rowIndex >= minRow &&
      rowIndex <= maxRow &&
      selectedColumnIndexSet.has(columnIndex)
    );
  };

  const columnStyle = (
    columnIndex: number,
    extra?: CSSProperties,
  ): CSSProperties => {
    const width = columnWidths[columnIndex];
    if (width === undefined) {
      const defaultStyle =
        density === 'compact'
          ? COMPACT_AUTO_COLUMN_STYLE
          : DEFAULT_COLUMN_STYLE;
      return extra ? { ...defaultStyle, ...extra } : defaultStyle;
    }
    return {
      width,
      minWidth: width,
      maxWidth: width,
      ...extra,
    };
  };

  const startColumnResize = (
    event: ReactMouseEvent<HTMLButtonElement>,
    columnIndex: number,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const headerCell = event.currentTarget.closest('th');
    const renderedWidth = headerCell?.getBoundingClientRect().width;
    setResizingColumn({
      columnIndex,
      startX: event.clientX,
      startWidth:
        columnWidths[columnIndex] ??
        (renderedWidth ? Math.round(renderedWidth) : DEFAULT_COLUMN_WIDTH),
    });
  };

  const resizeColumnWithKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    columnIndex: number,
  ) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
      return;

    let delta = 0;
    if (event.key === 'ArrowRight') {
      delta = KEYBOARD_COLUMN_RESIZE_STEP;
    } else if (event.key === 'ArrowLeft') {
      delta = -KEYBOARD_COLUMN_RESIZE_STEP;
    }

    if (delta === 0) return;

    event.preventDefault();
    event.stopPropagation();
    const headerCell = event.currentTarget.closest('th');
    const renderedWidth = headerCell?.getBoundingClientRect().width;
    setColumnWidths((current) => {
      const width =
        current[columnIndex] ??
        (renderedWidth ? Math.round(renderedWidth) : DEFAULT_COLUMN_WIDTH);
      const nextWidth = clampColumnWidth(width + delta);
      return applyColumnWidth(current, columnIndex, nextWidth);
    });
  };

  const startColumnDrag = (
    event: ReactDragEvent<HTMLButtonElement>,
    columnIndex: number,
  ) => {
    event.stopPropagation();
    setActiveColumn(columnIndex);
    draggingColumnRef.current = columnIndex;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(COLUMN_DRAG_MIME, String(columnIndex));
  };

  const stopColumnDrag = () => {
    draggingColumnRef.current = null;
  };

  const dragOverColumn = (event: ReactDragEvent<HTMLElement>) => {
    if (
      draggingColumnRef.current === null ||
      !hasColumnDragData(event.dataTransfer)
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const dropColumn = (
    event: ReactDragEvent<HTMLElement>,
    targetColumnIndex: number,
  ) => {
    const sourceColumnIndex = draggingColumnRef.current;
    stopColumnDrag();
    if (sourceColumnIndex === null || !hasColumnDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setSelection(null);
    setActiveColumn(sourceColumnIndex);
    setColumnOrder((current) =>
      moveVisibleColumn(
        current,
        sourceColumnIndex,
        targetColumnIndex,
        hiddenColumns,
      ),
    );
  };

  const startSelectionAtCell = (rowIndex: number, columnIndex: number) => {
    if (openFilterMenu !== null) {
      setOpenFilterMenu(null);
    }
    setActiveColumn(null);
    draggingRef.current = true;
    setSelection({
      anchorRow: rowIndex,
      anchorCol: columnIndex,
      focusRow: rowIndex,
      focusCol: columnIndex,
    });
  };

  const startSelection = (
    event: ReactMouseEvent<HTMLTableCellElement>,
    rowIndex: number,
    columnIndex: number,
  ) => {
    if (event.button !== 0 || isInteractiveSelectionTarget(event.target))
      return;
    event.preventDefault();
    containerRef.current?.focus({ preventScroll: true });
    startSelectionAtCell(rowIndex, columnIndex);
  };

  const extendSelection = (rowIndex: number, columnIndex: number) => {
    if (!draggingRef.current) return;
    setIsDragging(true);
    pendingSelectionRef.current = { rowIndex, columnIndex };
    if (selectionFrameRef.current) return;
    selectionFrameRef.current = requestAnimationFrame(() => {
      selectionFrameRef.current = 0;
      const pendingSelection = pendingSelectionRef.current;
      pendingSelectionRef.current = null;
      if (!pendingSelection) return;
      setSelection((current) =>
        current
          ? {
              ...current,
              focusRow: pendingSelection.rowIndex,
              focusCol: pendingSelection.columnIndex,
            }
          : current,
      );
    });
  };

  const getTouchCell = (
    touch: ReactTouchEvent<HTMLTableCellElement>['touches'][number],
  ) => {
    const element = document.elementFromPoint(touch.clientX, touch.clientY);
    const cell = element?.closest<HTMLTableCellElement>(
      '[data-row-index][data-column-index]',
    );
    if (!cell || !shellRef.current?.contains(cell)) return null;
    const rowIndex = Number(cell.dataset.rowIndex);
    const columnIndex = Number(cell.dataset.columnIndex);
    if (!Number.isInteger(rowIndex) || !Number.isInteger(columnIndex)) {
      return null;
    }
    return { rowIndex, columnIndex };
  };

  const startTouchSelection = (
    event: ReactTouchEvent<HTMLTableCellElement>,
    rowIndex: number,
    columnIndex: number,
  ) => {
    if (
      event.touches.length !== 1 ||
      isInteractiveSelectionTarget(event.target)
    ) {
      return;
    }
    startSelectionAtCell(rowIndex, columnIndex);
  };

  const extendTouchSelection = (
    event: ReactTouchEvent<HTMLTableCellElement>,
  ) => {
    if (!draggingRef.current || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (!touch) return;
    const cell = getTouchCell(touch);
    if (!cell) return;
    event.preventDefault();
    extendSelection(cell.rowIndex, cell.columnIndex);
  };

  const copySelection = () => {
    const text = getSelectionText(
      selection,
      visibleRows,
      orderedVisibleColumnIndexes,
    );
    if (!text || !navigator.clipboard) return;
    const copyGeneration = copiedSelectionGenRef.current;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (!mountedRef.current) return;
        if (copiedSelectionGenRef.current !== copyGeneration) return;
        if (copiedSelectionTimerRef.current) {
          clearTimeout(copiedSelectionTimerRef.current);
        }
        setCopiedSelection(true);
        copiedSelectionTimerRef.current = setTimeout(
          () => setCopiedSelection(false),
          2000,
        );
      })
      .catch((error: unknown) =>
        console.warn('[web-shell] clipboard write failed:', error),
      );
  };

  const copyVisibleTable = () => {
    const text = getVisibleTableText(
      table.headers,
      visibleRows,
      orderedVisibleColumnIndexes,
    );
    if (!text || !navigator.clipboard) return;
    const copyGeneration = copiedVisibleGenRef.current;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (!mountedRef.current) return;
        if (copiedVisibleGenRef.current !== copyGeneration) return;
        if (copiedVisibleTimerRef.current) {
          clearTimeout(copiedVisibleTimerRef.current);
        }
        setCopiedVisible(true);
        copiedVisibleTimerRef.current = setTimeout(
          () => setCopiedVisible(false),
          2000,
        );
      })
      .catch((error: unknown) =>
        console.warn('[web-shell] clipboard write failed:', error),
      );
  };

  const handleCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    if (hasNativeSelection()) return;
    const text = getSelectionText(
      selection,
      visibleRows,
      orderedVisibleColumnIndexes,
    );
    if (!text) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text);
  };

  const selectionStatistics = useMemo(
    () =>
      getSelectionStatistics(
        selection,
        visibleRows,
        orderedVisibleColumnIndexes,
      ),
    [orderedVisibleColumnIndexes, selection, visibleRows],
  );
  const selectedCount = selectionStatistics?.selectedCount ?? 0;
  const activeFilterCount =
    Object.values(filters).filter(isFilterActive).length;
  const densityLabel = t(`markdownTable.density.${density}`);
  const hasLongText = useMemo(
    () =>
      visibleRows.some((row) =>
        orderedVisibleColumnIndexes.some((columnIndex) => {
          const cell = row.cells[columnIndex];
          return cell ? isLongCellText(cellReadableText(cell)) : false;
        }),
      ),
    [orderedVisibleColumnIndexes, visibleRows],
  );
  const rowSummary =
    visibleRows.length === table.rows.length
      ? t('markdownTable.rows', { count: table.rows.length })
      : t('markdownTable.rowsFiltered', {
          visible: visibleRows.length,
          total: table.rows.length,
        });
  const renderCellContent = (cell: EnhancedTableCell, expanded: boolean) => {
    const displayText = cellReadableText(cell);
    const isLong = isLongCellText(displayText);
    return (
      <div
        className={`${styles.cellContent} ${
          isLong && !expanded ? styles.cellContentCollapsed : ''
        }`}
        title={isLong && !expanded ? displayText : undefined}
      >
        <div className={styles.cellText}>{cell.content}</div>
      </div>
    );
  };

  const renderDetailValue = (cell: EnhancedTableCell, expanded: boolean) => {
    const isEmpty = cell.text.length === 0;
    const displayText = cellReadableText(cell);
    const isLong = isLongCellText(displayText);
    return (
      <div
        className={`${styles.detailValueContent} ${
          isLong && !expanded ? styles.detailValueCollapsed : ''
        } ${isEmpty ? styles.emptyValue : ''}`}
        title={isLong && !expanded ? displayText : undefined}
      >
        <div className={styles.detailValueText}>
          {isEmpty ? t('markdownTable.emptyValue') : cell.content}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={shellRef}
      className={`${styles.tableShell} ${densityClassName(density)} ${
        freezeFirstColumn ? styles.hasFrozenColumn : ''
      } ${isDragging ? styles.dragging : ''}`}
    >
      <div className={styles.toolbar}>
        <span className={styles.summary}>{rowSummary}</span>
        <span className={styles.hint}>{t('markdownTable.hint')}</span>
        <button
          className={styles.copyButton}
          type="button"
          onClick={copyVisibleTable}
        >
          {copiedVisible ? (
            <>
              <span className={styles.copyCheck}>✓</span>
              {t('code.copied')}
            </>
          ) : (
            t('markdownTable.copyVisible')
          )}
        </button>
        {hiddenColumns.size > 0 && (
          <button
            className={styles.copyButton}
            type="button"
            onClick={showHiddenColumns}
          >
            {t('markdownTable.showHiddenColumns', {
              count: hiddenColumns.size,
            })}
          </button>
        )}
        <button
          className={styles.copyButton}
          type="button"
          onClick={toggleDensity}
        >
          {t('markdownTable.density', { density: densityLabel })}
        </button>
        {hasLongText && (
          <button
            className={styles.copyButton}
            type="button"
            onClick={() => setLongTextExpanded((current) => !current)}
          >
            {longTextExpanded
              ? t('markdownTable.collapseLongText')
              : t('markdownTable.expandLongText')}
          </button>
        )}
        {activeFilterCount > 0 && (
          <span className={styles.selection}>
            {t('markdownTable.filtersActive', { count: activeFilterCount })}
          </span>
        )}
        {selectedCount > 0 && (
          <>
            {selectionStatistics && (
              <div className={styles.selectionStats}>
                <span className={styles.selectionMetric}>
                  {t('markdownTable.selection.selected')}{' '}
                  <strong className={styles.selectionMetricValue}>
                    {selectionStatistics.selectedCount}
                  </strong>
                </span>
                <span className={styles.selectionMetric}>
                  {t('markdownTable.selection.nonEmpty')}{' '}
                  <strong className={styles.selectionMetricValue}>
                    {selectionStatistics.nonEmptyCount}
                  </strong>
                </span>
                <span className={styles.selectionMetric}>
                  {t('markdownTable.selection.numeric')}{' '}
                  <strong className={styles.selectionMetricValue}>
                    {selectionStatistics.numericCount}
                  </strong>
                </span>
                {selectionStatistics.numericCount > 0 && (
                  <>
                    <span className={styles.selectionMetric}>
                      {t('markdownTable.selection.sum')}{' '}
                      <strong className={styles.selectionMetricValue}>
                        {formatSelectionStatistic(
                          selectionStatistics.sum,
                          selectionStatistics,
                          language,
                        )}
                      </strong>
                    </span>
                    <span className={styles.selectionMetric}>
                      {t('markdownTable.selection.average')}{' '}
                      <strong className={styles.selectionMetricValue}>
                        {formatSelectionStatistic(
                          selectionStatistics.average,
                          selectionStatistics,
                          language,
                        )}
                      </strong>
                    </span>
                    <span className={styles.selectionMetric}>
                      {t('markdownTable.selection.min')}{' '}
                      <strong className={styles.selectionMetricValue}>
                        {formatSelectionStatistic(
                          selectionStatistics.min,
                          selectionStatistics,
                          language,
                        )}
                      </strong>
                    </span>
                    <span className={styles.selectionMetric}>
                      {t('markdownTable.selection.max')}{' '}
                      <strong className={styles.selectionMetricValue}>
                        {formatSelectionStatistic(
                          selectionStatistics.max,
                          selectionStatistics,
                          language,
                        )}
                      </strong>
                    </span>
                  </>
                )}
              </div>
            )}
            <button
              className={styles.copyButton}
              type="button"
              onClick={copySelection}
            >
              {copiedSelection ? (
                <>
                  <span className={styles.copyCheck}>✓</span>
                  {t('code.copied')}
                </>
              ) : (
                t('markdownTable.copyTsv')
              )}
            </button>
          </>
        )}
        {toolbarExtra}
      </div>
      <div
        ref={containerRef}
        className={styles.scroller}
        tabIndex={0}
        onCopy={handleCopy}
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th
                className={`${styles.headerCell} ${styles.actionHeaderCell} ${
                  freezeFirstColumn ? styles.stickyActionHeaderCell : ''
                }`}
              >
                {t('markdownTable.actions')}
              </th>
              {orderedVisibleColumnIndexes.map((columnIndex) => {
                const header = table.headers[columnIndex];
                if (!header) return null;
                const isSorted = sort?.columnIndex === columnIndex;
                const isFiltered = isFilterActive(filters[columnIndex]);
                const isMenuOpen = openFilterMenu?.columnIndex === columnIndex;
                const sortLabel = isSorted
                  ? sort.direction === 'asc'
                    ? '↑'
                    : '↓'
                  : '↕';
                const columnName =
                  header.text ||
                  t('markdownTable.column', { index: columnIndex + 1 });
                const sortAriaLabel = isSorted
                  ? t(
                      sort.direction === 'asc'
                        ? 'markdownTable.sortByColumnAsc'
                        : 'markdownTable.sortByColumnDesc',
                      { column: columnName },
                    )
                  : t('markdownTable.sortByColumn', { column: columnName });
                const ariaSort = isSorted
                  ? sort.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none';
                const filterMenuId = `${tableId}-filter-${columnIndex}`;
                const headerAlignStyle = header.textAlign
                  ? { textAlign: header.textAlign }
                  : undefined;
                const isFrozenColumn = frozenColumnIndex === columnIndex;
                const isActiveColumn = activeColumn === columnIndex;
                return (
                  <th
                    key={header.key}
                    className={`${styles.headerCell} ${
                      isFrozenColumn ? styles.frozenHeaderCell : ''
                    } ${isActiveColumn ? styles.activeHeaderCell : ''}`}
                    aria-sort={ariaSort}
                    onContextMenu={(event) =>
                      openColumnContextMenu(event, columnIndex)
                    }
                    onDragOver={dragOverColumn}
                    onDrop={(event) => dropColumn(event, columnIndex)}
                    style={columnStyle(columnIndex, headerAlignStyle)}
                    title={columnName}
                  >
                    <div className={styles.headerControls}>
                      <button
                        className={styles.headerButton}
                        type="button"
                        onClick={() => toggleSort(columnIndex)}
                        aria-label={sortAriaLabel}
                        style={headerAlignStyle}
                      >
                        <span
                          className={styles.headerText}
                          style={headerAlignStyle}
                        >
                          {header.content}
                        </span>
                        <span className={styles.sortIcon} aria-hidden="true">
                          {sortLabel}
                        </span>
                      </button>
                      <button
                        className={`${styles.reorderHandle} ${
                          isActiveColumn ? styles.reorderHandleVisible : ''
                        }`}
                        type="button"
                        draggable
                        tabIndex={isActiveColumn ? 0 : -1}
                        onDragStart={(event) =>
                          startColumnDrag(event, columnIndex)
                        }
                        onDragEnd={stopColumnDrag}
                        aria-label={t('markdownTable.moveColumn', {
                          column: columnName,
                        })}
                      >
                        ⋮⋮
                      </button>
                      <Popover
                        open={isMenuOpen}
                        onOpenChange={(open) =>
                          setFilterMenuOpen(columnIndex, open)
                        }
                      >
                        <PopoverTrigger asChild>
                          <button
                            className={`${styles.filterTrigger} ${
                              isFiltered ? styles.filterTriggerActive : ''
                            }`}
                            type="button"
                            aria-label={t('markdownTable.filterColumn', {
                              column: columnName,
                            })}
                            aria-controls={
                              isMenuOpen ? filterMenuId : undefined
                            }
                          >
                            ▾
                          </button>
                        </PopoverTrigger>
                        {isMenuOpen && (
                          <ColumnFilterMenu
                            key={columnIndex}
                            id={filterMenuId}
                            columnName={columnName}
                            columnIndex={columnIndex}
                            filter={filters[columnIndex]}
                            isNumeric={numericColumns[columnIndex] ?? false}
                            options={openFilterOptions}
                            sort={sort}
                            canHideColumn={
                              orderedVisibleColumnIndexes.length > 1
                            }
                            onApply={setColumnFilter}
                            onClose={closeFilterMenu}
                            onHideColumn={hideColumn}
                            onSort={setColumnSort}
                          />
                        )}
                      </Popover>
                    </div>
                    <button
                      className={styles.resizeHandle}
                      type="button"
                      onMouseDown={(event) =>
                        startColumnResize(event, columnIndex)
                      }
                      onKeyDown={(event) =>
                        resizeColumnWithKeyboard(event, columnIndex)
                      }
                      role="separator"
                      aria-label={t('markdownTable.resizeColumn', {
                        column: columnName,
                      })}
                      aria-orientation="vertical"
                      aria-valuemin={MIN_COLUMN_WIDTH}
                      aria-valuemax={MAX_COLUMN_WIDTH}
                      aria-valuenow={
                        columnWidths[columnIndex] ?? DEFAULT_COLUMN_WIDTH
                      }
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, rowIndex) => {
              const detailOpen = detailRowKey === row.key;
              const detailId = `${tableId}-detail-${row.key}`;
              return (
                <Fragment key={row.key}>
                  <tr
                    className={rowIndex % 2 === 1 ? styles.evenRow : undefined}
                  >
                    <td
                      className={`${styles.cell} ${styles.actionCell} ${
                        freezeFirstColumn ? styles.stickyActionCell : ''
                      }`}
                    >
                      <button
                        className={styles.rowDetailButton}
                        type="button"
                        onClick={() => toggleRowDetail(row.key)}
                        aria-expanded={detailOpen}
                        aria-controls={detailId}
                        aria-label={t(
                          detailOpen
                            ? 'markdownTable.closeRowDetailsAria'
                            : 'markdownTable.rowDetailsAria',
                          { index: rowIndex + 1 },
                        )}
                      >
                        {t('markdownTable.rowDetails')}
                      </button>
                    </td>
                    {orderedVisibleColumnIndexes.map((columnIndex) => {
                      const cell = row.cells[columnIndex];
                      if (!cell) return null;
                      const cellAlignStyle = cell.textAlign
                        ? { textAlign: cell.textAlign }
                        : undefined;
                      const isFrozenColumn = frozenColumnIndex === columnIndex;
                      return (
                        <td
                          key={cell.key}
                          className={`${styles.cell} ${
                            isCellSelected(rowIndex, columnIndex)
                              ? styles.selectedCell
                              : ''
                          } ${isFrozenColumn ? styles.frozenCell : ''}`}
                          style={columnStyle(columnIndex, cellAlignStyle)}
                          data-row-index={rowIndex}
                          data-column-index={columnIndex}
                          onMouseDown={(event) =>
                            startSelection(event, rowIndex, columnIndex)
                          }
                          onMouseEnter={() =>
                            extendSelection(rowIndex, columnIndex)
                          }
                          onTouchStart={(event) =>
                            startTouchSelection(event, rowIndex, columnIndex)
                          }
                          onTouchMove={extendTouchSelection}
                          onTouchEnd={stopDragging}
                          onTouchCancel={stopDragging}
                          onDoubleClick={(event) => {
                            if (isInteractiveSelectionTarget(event.target)) {
                              return;
                            }
                            openCellDialog(row.key, columnIndex);
                          }}
                        >
                          {renderCellContent(cell, longTextExpanded)}
                        </td>
                      );
                    })}
                  </tr>
                  {detailOpen && (
                    <tr id={detailId} className={styles.detailRow}>
                      <td
                        className={styles.detailCell}
                        colSpan={orderedVisibleColumnIndexes.length + 1}
                      >
                        <div className={styles.detailPanel}>
                          <div className={styles.detailTitle}>
                            {t('markdownTable.detailsHeader')}
                          </div>
                          {orderedVisibleColumnIndexes.map((columnIndex) => {
                            const header = table.headers[columnIndex];
                            const cell = row.cells[columnIndex];
                            if (!header || !cell) return null;
                            return (
                              <div
                                key={`${row.key}-detail-${columnIndex}`}
                                className={styles.detailItem}
                              >
                                <div
                                  className={styles.detailLabel}
                                  title={header.text}
                                >
                                  {header.content}
                                </div>
                                <div className={styles.detailValue}>
                                  {renderDetailValue(cell, longTextExpanded)}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {visibleRows.length === 0 && (
          <div className={styles.emptyState}>
            {table.rows.length === 0
              ? t('markdownTable.empty')
              : t('markdownTable.emptyFiltered')}
          </div>
        )}
      </div>
      {columnContextMenu && orderedVisibleColumnIndexes.length > 0 && (
        <div
          ref={columnContextMenuRef}
          className={styles.columnContextMenu}
          style={{
            left: columnContextMenu.left,
            top: columnContextMenu.top,
          }}
          role="menu"
        >
          <button
            className={styles.columnContextMenuAction}
            type="button"
            role="menuitem"
            onClick={toggleFreezeFirstColumnFromMenu}
          >
            {freezeFirstColumn
              ? t('markdownTable.unfreezeFirstColumn')
              : t('markdownTable.freezeFirstColumn')}
          </button>
        </div>
      )}
      <Dialog
        open={cellDialog !== null && currentCellDialogCell !== null}
        onOpenChange={(open) => {
          if (!open) closeCellDialog();
        }}
      >
        {currentCellDialogCell && (
          <DialogContent
            ref={cellDialogRef}
            className="sm:max-w-lg"
            showCloseButton={false}
            overlayProps={{ onMouseDown: closeCellDialog }}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              cellDialogRef.current?.focus();
            }}
          >
            <DialogClose asChild>
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
                aria-label={t('markdownTable.close')}
              >
                <XIcon />
                <span className="sr-only">{t('markdownTable.close')}</span>
              </Button>
            </DialogClose>
            <DialogHeader>
              <DialogTitle>{t('markdownTable.cellDialogTitle')}</DialogTitle>
            </DialogHeader>
            <div className="max-h-[200px] min-h-[100px] cursor-text overflow-auto rounded-lg border bg-background/70 p-3 leading-relaxed font-semibold whitespace-pre-wrap break-words select-text">
              {currentCellDialogCell.content}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={copyCellDialogValue}>
                {copiedCellDialog
                  ? t('code.copied')
                  : t('markdownTable.copyCell')}
              </Button>
              <DialogClose asChild>
                <Button>{t('markdownTable.close')}</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
