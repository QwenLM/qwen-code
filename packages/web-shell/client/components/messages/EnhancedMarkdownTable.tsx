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

export interface EnhancedTableCell {
  key: string;
  content: ReactNode;
  text: string;
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
  left: number;
  top: number;
}

interface ColumnResizeState {
  columnIndex: number;
  startX: number;
  startWidth: number;
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
const DEFAULT_COLUMN_STYLE: CSSProperties = {
  width: DEFAULT_COLUMN_WIDTH,
  minWidth: DEFAULT_COLUMN_WIDTH,
  maxWidth: DEFAULT_COLUMN_WIDTH,
};

function clampColumnWidth(width: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width));
}

const FOCUSABLE_FILTER_MENU_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableFilterMenuElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_FILTER_MENU_SELECTOR),
  ).filter((element) => !element.hasAttribute('hidden'));
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
    isHeader: false,
  };
}

function parseRow(rowNode: TableElement, rowKey: string): EnhancedTableRow {
  const cellNodes = Children.toArray(rowNode.props.children).filter(
    (child) => isTagElement(child, 'td') || isTagElement(child, 'th'),
  );
  return {
    key: rowKey,
    cells: cellNodes.map((cellNode, cellIndex) => ({
      key: `${rowKey}-${cellIndex}`,
      content: cellNode.props.children,
      text: normalizeText(getTextContent(cellNode.props.children)),
      isHeader: cellNode.type === 'th',
      textAlign: cellNode.props.style?.textAlign,
    })),
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
  const inspectedValue = value.replace(
    /[\u200B-\u200D\u2060\u00AD\uFEFF]/g,
    '',
  );
  return /^[=+\-@]/.test(inspectedValue) ? `'${value}` : value;
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
          sanitizeForClipboard(row.cells[columnIndex]?.text ?? ''),
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
        sanitizeForClipboard(headers[columnIndex]?.text ?? ''),
      )
      .join('\t'),
    ...rows.map((row) =>
      visibleColumnIndexes
        .map((columnIndex) =>
          sanitizeForClipboard(row.cells[columnIndex]?.text ?? ''),
        )
        .join('\t'),
    ),
  ];
  return lines.join('\n');
}

function selectionSize(
  range: SelectionRange | null,
  visibleColumnIndexes: number[],
): number {
  if (!range) return 0;
  const { minRow, maxRow } = getSelectionRowBounds(range);
  const selectedColumnCount = getSelectedColumnIndexes(
    range,
    visibleColumnIndexes,
  ).length;
  return (maxRow - minRow + 1) * selectedColumnCount;
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
    <div className={styles.filterMenuSection}>
      <button
        className={`${styles.filterMenuAction} ${
          sortedThisColumn?.direction === 'asc' ? styles.activeAction : ''
        }`}
        type="button"
        onClick={() => onSort(columnIndex, 'asc')}
      >
        {t('markdownTable.sort.asc')}
      </button>
      <button
        className={`${styles.filterMenuAction} ${
          sortedThisColumn?.direction === 'desc' ? styles.activeAction : ''
        }`}
        type="button"
        onClick={() => onSort(columnIndex, 'desc')}
      >
        {t('markdownTable.sort.desc')}
      </button>
      <button
        className={styles.filterMenuAction}
        type="button"
        onClick={() => onSort(columnIndex, null)}
      >
        {t('markdownTable.sort.clear')}
      </button>
    </div>
  );
}

function VisibilityMenuSection({ onHideColumn }: { onHideColumn: () => void }) {
  const { t } = useI18n();

  return (
    <div className={styles.filterMenuSection}>
      <button
        className={styles.filterMenuAction}
        type="button"
        onClick={onHideColumn}
      >
        {t('markdownTable.hideColumn')}
      </button>
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
    <div className={styles.filterMenuSection}>
      <input
        ref={searchInputRef}
        className={styles.filterSearch}
        value={search}
        onChange={(event) => onSearchChange(event.currentTarget.value)}
        placeholder={t('markdownTable.filter.searchPlaceholder')}
        name={`markdown-table-option-search-${columnIndex}`}
        aria-label={t('markdownTable.filter.searchAria', {
          column: columnName,
        })}
      />
      <label className={styles.filterOption}>
        <input
          type="checkbox"
          name={`markdown-table-filter-all-${columnIndex}`}
          checked={allFilteredSelected}
          onChange={(event) =>
            onFilteredSelectionChange(event.currentTarget.checked)
          }
        />
        <span>{t('markdownTable.filter.selectVisible')}</span>
        <span className={styles.optionCount}>{filteredOptions.length}</span>
      </label>
      <div className={styles.filterOptionList}>
        {visibleOptions.map((option, optionIndex) => (
          <label key={option.value} className={styles.filterOption}>
            <input
              type="checkbox"
              name={`markdown-table-filter-option-${columnIndex}-${optionIndex}`}
              checked={selectedValues.has(option.value)}
              onChange={() => onToggleValue(option.value)}
            />
            <span className={styles.optionLabel}>{option.label}</span>
            <span className={styles.optionCount}>{option.count}</span>
          </label>
        ))}
        {filteredOptions.length > visibleOptions.length && (
          <div className={styles.optionLimitHint}>
            {t('markdownTable.filter.optionLimit', {
              count: visibleOptions.length,
            })}
          </div>
        )}
        {filteredOptions.length === 0 && (
          <div className={styles.optionLimitHint}>
            {t('markdownTable.filter.noOptions')}
          </div>
        )}
      </div>
    </div>
  );
}

function CustomFilterSection({
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
    <div className={styles.filterMenuSection}>
      <div className={styles.conditionTitle}>
        {t('markdownTable.filter.custom')}
      </div>
      {isNumeric ? (
        <>
          <select
            className={styles.conditionSelect}
            value={numberOperator}
            name={`markdown-table-number-operator-${columnIndex}`}
            onChange={(event) =>
              onNumberOperatorChange(
                event.currentTarget.value as NumberFilterOperator,
              )
            }
            aria-label={t('markdownTable.filter.numberAria', {
              column: columnName,
            })}
          >
            {Object.entries(NUMBER_FILTER_LABEL_KEYS).map(
              ([value, labelKey]) => (
                <option key={value} value={value}>
                  {t(labelKey)}
                </option>
              ),
            )}
          </select>
          <div className={styles.conditionInputs}>
            <input
              className={styles.conditionInput}
              value={numberValue}
              onChange={(event) =>
                onNumberValueChange(event.currentTarget.value)
              }
              placeholder={t('markdownTable.filter.numberPlaceholder')}
              name={`markdown-table-number-filter-${columnIndex}`}
            />
            {numberOperator === 'between' && (
              <input
                className={styles.conditionInput}
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
          <select
            className={styles.conditionSelect}
            value={textOperator}
            name={`markdown-table-text-operator-${columnIndex}`}
            onChange={(event) =>
              onTextOperatorChange(
                event.currentTarget.value as TextFilterOperator,
              )
            }
            aria-label={t('markdownTable.filter.textAria', {
              column: columnName,
            })}
          >
            {Object.entries(TEXT_FILTER_LABEL_KEYS).map(([value, labelKey]) => (
              <option key={value} value={value}>
                {t(labelKey)}
              </option>
            ))}
          </select>
          <input
            className={styles.conditionInput}
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
    <div className={styles.filterFooter}>
      <button
        className={styles.secondaryButton}
        type="button"
        onClick={onClear}
      >
        {t('markdownTable.filter.reset')}
      </button>
      <span className={styles.footerSpacer} />
      <button
        className={styles.secondaryButton}
        type="button"
        onClick={onClose}
      >
        {t('markdownTable.filter.cancel')}
      </button>
      <button className={styles.primaryButton} type="button" onClick={onApply}>
        {t('markdownTable.filter.confirm')}
      </button>
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
  style,
  menuRef,
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
  style?: CSSProperties;
  menuRef: RefObject<HTMLDivElement | null>;
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
    <div
      ref={menuRef}
      id={id}
      className={styles.filterMenu}
      style={style}
      role="dialog"
      aria-labelledby={`${id}-title`}
    >
      <div id={`${id}-title`} className={styles.filterMenuTitle}>
        {columnName}
      </div>
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
    </div>
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
  const { t } = useI18n();
  const tableId = useId();
  const [sort, setSort] = useState<SortState | null>(null);
  const [filters, setFilters] = useState<Record<number, ColumnFilter>>({});
  const [selection, setSelection] = useState<SelectionRange | null>(null);
  const [openFilterMenu, setOpenFilterMenu] = useState<OpenFilterMenu | null>(
    null,
  );
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
  const [isDragging, setIsDragging] = useState(false);
  const [copiedVisible, setCopiedVisible] = useState(false);
  const [copiedSelection, setCopiedSelection] = useState(false);
  const draggingRef = useRef(false);
  const copiedVisibleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const copiedSelectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const copiedVisibleGenRef = useRef(0);
  const copiedSelectionGenRef = useRef(0);
  const mountedRef = useRef(true);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const filterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusReturnFrameRef = useRef(0);
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

  const focusFilterTrigger = useCallback(() => {
    if (focusReturnFrameRef.current) {
      cancelAnimationFrame(focusReturnFrameRef.current);
    }
    focusReturnFrameRef.current = requestAnimationFrame(() => {
      focusReturnFrameRef.current = 0;
      const trigger = filterTriggerRef.current;
      if (trigger?.isConnected) trigger.focus();
    });
  }, []);

  const closeFilterMenu = useCallback(() => {
    setOpenFilterMenu(null);
    focusFilterTrigger();
  }, [focusFilterTrigger]);

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
      if (focusReturnFrameRef.current) {
        cancelAnimationFrame(focusReturnFrameRef.current);
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
    setHiddenColumns(new Set());
    setColumnWidths({});
    setColumnOrder(initialColumnOrder(table.columnCount));
    setActiveColumn(null);
    setFreezeFirstColumn(false);
    setResizingColumn(null);
    setDetailRowKey(null);
    resetCopiedVisible();
    resetCopiedSelection();
    draggingRef.current = false;
    draggingColumnRef.current = null;
    setIsDragging(false);
  }, [
    resetCopiedSelection,
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
    };
  }, []);

  useEffect(() => {
    if (!openFilterMenu) return;
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !filterMenuRef.current?.contains(target) &&
        !filterTriggerRef.current?.contains(target)
      ) {
        setOpenFilterMenu(null);
      }
    };
    const handleMenuKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeFilterMenu();
        return;
      }
      if (event.key !== 'Tab') return;
      const menu = filterMenuRef.current;
      const activeElement = document.activeElement;
      if (
        !menu ||
        !(activeElement instanceof Node) ||
        !menu.contains(activeElement)
      ) {
        return;
      }
      const focusableElements = getFocusableFilterMenuElements(menu);
      if (focusableElements.length === 0) return;
      const currentIndex =
        activeElement instanceof HTMLElement
          ? focusableElements.indexOf(activeElement)
          : -1;
      const nextIndex = event.shiftKey
        ? currentIndex <= 0
          ? focusableElements.length - 1
          : currentIndex - 1
        : currentIndex === -1 || currentIndex === focusableElements.length - 1
          ? 0
          : currentIndex + 1;
      event.preventDefault();
      focusableElements[nextIndex]?.focus();
    };
    const closeOnScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && filterMenuRef.current?.contains(target)) {
        return;
      }
      setOpenFilterMenu(null);
    };
    const closeOnResize = () => setOpenFilterMenu(null);
    document.addEventListener('mousedown', closeMenu);
    document.addEventListener('keydown', handleMenuKeyDown);
    document.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', closeOnResize);
    return () => {
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('keydown', handleMenuKeyDown);
      document.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [closeFilterMenu, openFilterMenu]);

  useEffect(() => {
    const clearActiveColumnOnOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && !shellRef.current?.contains(target)) {
        setActiveColumn(null);
      }
    };
    const clearActiveColumnOnEscape = (event: KeyboardEvent) => {
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
  }, []);

  const filteredRows = useMemo(
    () => applyFilters(table.rows, filters),
    [filters, table.rows],
  );
  const visibleRows = useMemo(
    () => sortRows(filteredRows, sort),
    [filteredRows, sort],
  );
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
  }, [detailRowKey, visibleRows]);

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

  const toggleFilterMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    columnIndex: number,
  ) => {
    setSelection(null);
    setActiveColumn(columnIndex);
    filterTriggerRef.current = event.currentTarget;
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 300;
    const menuHeight = 430;
    const nextMenu = {
      columnIndex,
      left: Math.max(
        6,
        Math.min(
          buttonRect.right - menuWidth,
          window.innerWidth - menuWidth - 6,
        ),
      ),
      top:
        window.innerHeight - buttonRect.bottom < menuHeight
          ? Math.max(8, buttonRect.top - menuHeight - 2)
          : buttonRect.bottom + 2,
    };

    setOpenFilterMenu((current) =>
      current?.columnIndex === columnIndex ? null : nextMenu,
    );
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

  const toggleFreezeFirstColumn = () => {
    setFreezeFirstColumn((current) => !current);
  };

  const toggleRowDetail = (rowKey: string) => {
    setSelection(null);
    setDetailRowKey((current) => (current === rowKey ? null : rowKey));
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
      return extra
        ? { ...DEFAULT_COLUMN_STYLE, ...extra }
        : DEFAULT_COLUMN_STYLE;
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
    setResizingColumn({
      columnIndex,
      startX: event.clientX,
      startWidth: columnWidths[columnIndex] ?? DEFAULT_COLUMN_WIDTH,
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
    setColumnWidths((current) => {
      const width = current[columnIndex] ?? DEFAULT_COLUMN_WIDTH;
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

  const selectedCount = selectionSize(selection, orderedVisibleColumnIndexes);
  const activeFilterCount =
    Object.values(filters).filter(isFilterActive).length;
  const rowSummary =
    visibleRows.length === table.rows.length
      ? t('markdownTable.rows', { count: table.rows.length })
      : t('markdownTable.rowsFiltered', {
          visible: visibleRows.length,
          total: table.rows.length,
        });
  const openFilterHeader =
    openFilterMenu === null
      ? undefined
      : table.headers[openFilterMenu.columnIndex];
  const openFilterColumnName =
    openFilterHeader && openFilterMenu
      ? openFilterHeader.text ||
        t('markdownTable.column', { index: openFilterMenu.columnIndex + 1 })
      : '';

  return (
    <div
      ref={shellRef}
      className={`${styles.tableShell} ${isDragging ? styles.dragging : ''}`}
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
        {orderedVisibleColumnIndexes.length > 0 && (
          <button
            className={styles.copyButton}
            type="button"
            onClick={toggleFreezeFirstColumn}
          >
            {freezeFirstColumn
              ? t('markdownTable.unfreezeFirstColumn')
              : t('markdownTable.freezeFirstColumn')}
          </button>
        )}
        {activeFilterCount > 0 && (
          <span className={styles.selection}>
            {t('markdownTable.filtersActive', { count: activeFilterCount })}
          </span>
        )}
        {selectedCount > 0 && (
          <>
            <span className={styles.selection}>
              {t('markdownTable.cellsSelected', { count: selectedCount })}
            </span>
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
                    onDragOver={dragOverColumn}
                    onDrop={(event) => dropColumn(event, columnIndex)}
                    style={columnStyle(columnIndex, headerAlignStyle)}
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
                      <button
                        className={`${styles.filterTrigger} ${
                          isFiltered ? styles.filterTriggerActive : ''
                        }`}
                        type="button"
                        onClick={(event) =>
                          toggleFilterMenu(event, columnIndex)
                        }
                        aria-label={t('markdownTable.filterColumn', {
                          column: columnName,
                        })}
                        aria-expanded={isMenuOpen}
                        aria-controls={isMenuOpen ? filterMenuId : undefined}
                      >
                        ▾
                      </button>
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
                        >
                          {cell.content}
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
                            const headerAlignStyle = header.textAlign
                              ? { textAlign: header.textAlign }
                              : undefined;
                            const cellAlignStyle = cell.textAlign
                              ? { textAlign: cell.textAlign }
                              : undefined;
                            return (
                              <div
                                key={`${row.key}-detail-${columnIndex}`}
                                className={styles.detailItem}
                              >
                                <div
                                  className={styles.detailLabel}
                                  style={headerAlignStyle}
                                >
                                  {header.content}
                                </div>
                                <div
                                  className={styles.detailValue}
                                  style={cellAlignStyle}
                                >
                                  {cell.content}
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
      {openFilterMenu && openFilterHeader && (
        <ColumnFilterMenu
          key={openFilterMenu.columnIndex}
          id={`${tableId}-filter-${openFilterMenu.columnIndex}`}
          columnName={openFilterColumnName}
          columnIndex={openFilterMenu.columnIndex}
          filter={filters[openFilterMenu.columnIndex]}
          isNumeric={numericColumns[openFilterMenu.columnIndex] ?? false}
          options={openFilterOptions}
          sort={sort}
          style={{ left: openFilterMenu.left, top: openFilterMenu.top }}
          menuRef={filterMenuRef}
          canHideColumn={orderedVisibleColumnIndexes.length > 1}
          onApply={setColumnFilter}
          onClose={closeFilterMenu}
          onHideColumn={hideColumn}
          onSort={setColumnSort}
        />
      )}
    </div>
  );
}
