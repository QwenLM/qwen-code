import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import {
  flexRender,
  type Row,
  type Table as TanStackTable,
} from '@tanstack/react-table';

import { cn } from '@/lib/utils';
import { Button } from './button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './table';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

export interface DataTableColumnMeta<TData = unknown> {
  headerClassName?: string;
  width?: number;
  fixedWidth?: boolean;
  fluidWeight?: number;
  fixed?: 'left' | 'right';
  fixedOffset?: number;
  fixedEdge?: boolean;
  stopRowClick?: boolean;
  truncate?: boolean | ((row: TData) => boolean);
  tooltip?: (row: TData) => ReactNode;
}

function columnMeta<TData = unknown>(column: {
  columnDef: { meta?: unknown };
}): DataTableColumnMeta<TData> {
  return (column.columnDef.meta ?? {}) as DataTableColumnMeta<TData>;
}

function fixedClassName<TData>(
  meta: DataTableColumnMeta<TData>,
  header: boolean,
  showLeftShadow: boolean,
  showRightShadow: boolean,
): string | undefined {
  if (!meta.fixed) return undefined;
  const showShadow =
    meta.fixedEdge &&
    (meta.fixed === 'left' ? showLeftShadow : showRightShadow);
  return cn(
    'sticky bg-background transition-colors',
    header
      ? 'z-20'
      : 'z-10 group-hover:bg-[color-mix(in_srgb,var(--muted)_50%,var(--background))] group-data-[state=selected]:bg-muted',
    meta.fixedEdge &&
      "after:pointer-events-none after:absolute after:top-0 after:-bottom-px after:w-[30px] after:content-[''] after:transition-shadow",
    meta.fixedEdge &&
      (meta.fixed === 'left' ? 'after:left-full' : 'after:right-full'),
    showShadow &&
      (meta.fixed === 'left'
        ? 'after:shadow-[inset_10px_0_8px_-8px_var(--border)]'
        : 'after:shadow-[inset_-10px_0_8px_-8px_var(--border)]'),
  );
}

function columnWidthStyle<TData>(
  meta: DataTableColumnMeta<TData>,
  fluidLayout: boolean,
  availableWidth: number,
  minimumWidth: number,
  fluidWeight: number,
): CSSProperties | undefined {
  const width = resolvedColumnWidth(
    meta,
    fluidLayout,
    availableWidth,
    minimumWidth,
    fluidWeight,
  );
  if (width === undefined || meta.width === undefined) return undefined;
  return {
    width,
    minWidth: meta.width,
    maxWidth: fluidLayout && !meta.fixedWidth ? 'none' : meta.width,
  };
}

function resolvedColumnWidth<TData>(
  meta: DataTableColumnMeta<TData>,
  fluidLayout: boolean,
  availableWidth: number,
  minimumWidth: number,
  fluidWeight: number,
): number | undefined {
  if (meta.width === undefined) return undefined;
  if (!fluidLayout || meta.fixedWidth || fluidWeight === 0) return meta.width;
  const weight = meta.fluidWeight ?? meta.width;
  return (
    meta.width +
    Math.max(0, availableWidth - minimumWidth) * (weight / fluidWeight)
  );
}

function columnStyle<TData>(
  meta: DataTableColumnMeta<TData>,
  fluidLayout: boolean,
  availableWidth: number,
  minimumWidth: number,
  fluidWeight: number,
  fixedOffset?: number,
): CSSProperties | undefined {
  const style =
    columnWidthStyle(
      meta,
      fluidLayout,
      availableWidth,
      minimumWidth,
      fluidWeight,
    ) ?? {};
  if (meta.fixed) style[meta.fixed] = fixedOffset ?? meta.fixedOffset ?? 0;
  return Object.keys(style).length > 0 ? style : undefined;
}

export function DataTable<TData>({
  table,
  className,
  emptyContent,
  onRowClick,
  rowClassName,
  ...props
}: Omit<
  ComponentProps<'div'>,
  'children' | 'onClick' | 'onScrollCapture' | 'ref'
> & {
  table: TanStackTable<TData>;
  emptyContent?: ReactNode;
  onRowClick?: (row: Row<TData>) => void;
  rowClassName?: string | ((row: Row<TData>) => string | undefined);
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const rowCount = table.getRowModel().rows.length;
  const visibleColumns = table.getVisibleLeafColumns();
  const widthMetrics = visibleColumns.reduce(
    (metrics, column) => {
      const meta = columnMeta(column);
      metrics.minimum += meta.width ?? 0;
      if (!meta.fixedWidth && meta.width !== undefined) {
        metrics.fluidWeight += meta.fluidWeight ?? meta.width;
      }
      return metrics;
    },
    { minimum: 0, fluidWeight: 0 },
  );
  const [fluidLayout, setFluidLayout] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [fixedShadows, setFixedShadows] = useState({
    left: false,
    right: false,
  });
  const distributeFluidWidth =
    fluidLayout &&
    visibleColumns.every(
      (column) => columnMeta<TData>(column).width !== undefined,
    );
  const resolvedWidths = new Map(
    visibleColumns.map((column) => [
      column.id,
      resolvedColumnWidth(
        columnMeta<TData>(column),
        distributeFluidWidth,
        availableWidth,
        widthMetrics.minimum,
        widthMetrics.fluidWeight,
      ) ?? 0,
    ]),
  );
  const fixedOffsets = new Map<string, number>();
  let leftOffset = 0;
  for (const column of visibleColumns) {
    const meta = columnMeta<TData>(column);
    if (meta.fixed !== 'left') continue;
    const offset = meta.fixedOffset ?? leftOffset;
    fixedOffsets.set(column.id, offset);
    leftOffset = Math.max(
      leftOffset,
      offset + (resolvedWidths.get(column.id) ?? 0),
    );
  }
  let rightOffset = 0;
  for (const column of [...visibleColumns].reverse()) {
    const meta = columnMeta<TData>(column);
    if (meta.fixed !== 'right') continue;
    const offset = meta.fixedOffset ?? rightOffset;
    fixedOffsets.set(column.id, offset);
    rightOffset = Math.max(
      rightOffset,
      offset + (resolvedWidths.get(column.id) ?? 0),
    );
  }

  const updateLayout = useCallback(
    (scroller: HTMLElement) => {
      setAvailableWidth(scroller.clientWidth);
      setFluidLayout(scroller.clientWidth >= widthMetrics.minimum);
      const next = {
        left: scroller.scrollLeft > 0,
        right:
          scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1,
      };
      setFixedShadows((current) =>
        current.left === next.left && current.right === next.right
          ? current
          : next,
      );
    },
    [widthMetrics.minimum],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    const scroller = viewport?.querySelector<HTMLElement>(
      '[data-slot="table-container"]',
    );
    if (!viewport || !scroller) return;
    const update = () => updateLayout(scroller);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    const renderedTable = scroller.querySelector('[data-slot="table"]');
    if (renderedTable) observer.observe(renderedTable);
    return () => observer.disconnect();
  }, [rowCount, updateLayout]);

  return (
    <div
      {...props}
      ref={viewportRef}
      data-slot="data-table-viewport"
      className={cn('overflow-hidden rounded-md border', className)}
      onScrollCapture={(event) => {
        const target = event.target as HTMLElement;
        if (target.dataset.slot === 'table-container') {
          updateLayout(target);
        }
      }}
    >
      <Table
        data-layout={fluidLayout ? 'fluid' : 'scroll'}
        style={{
          minWidth: fluidLayout ? undefined : widthMetrics.minimum,
          tableLayout: 'fixed',
        }}
      >
        <colgroup>
          {table.getVisibleLeafColumns().map((column) => (
            <col
              key={column.id}
              style={columnWidthStyle(
                columnMeta<TData>(column),
                distributeFluidWidth,
                availableWidth,
                widthMetrics.minimum,
                widthMetrics.fluidWeight,
              )}
            />
          ))}
        </colgroup>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const meta = columnMeta(header.column);
                const sorted = header.column.getIsSorted();
                return (
                  <TableHead
                    key={header.id}
                    aria-sort={
                      sorted === 'asc'
                        ? 'ascending'
                        : sorted === 'desc'
                          ? 'descending'
                          : undefined
                    }
                    className={cn(
                      meta.headerClassName,
                      fixedClassName(
                        meta,
                        true,
                        fixedShadows.left,
                        fixedShadows.right,
                      ),
                    )}
                    style={columnStyle(
                      meta,
                      distributeFluidWidth,
                      availableWidth,
                      widthMetrics.minimum,
                      widthMetrics.fluidWeight,
                      fixedOffsets.get(header.column.id),
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rowCount === 0 && emptyContent !== undefined && (
            <TableRow
              data-slot="data-table-empty"
              className="hover:bg-transparent"
            >
              <TableCell
                colSpan={table.getVisibleLeafColumns().length}
                className="h-24 text-center text-muted-foreground"
              >
                {emptyContent}
              </TableCell>
            </TableRow>
          )}
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className={cn(
                'group',
                typeof rowClassName === 'function'
                  ? rowClassName(row)
                  : rowClassName,
              )}
              data-state={row.getIsSelected() ? 'selected' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {row.getVisibleCells().map((cell) => {
                const meta = columnMeta<TData>(cell.column);
                const tooltip = meta.tooltip?.(row.original);
                const content = flexRender(
                  cell.column.columnDef.cell,
                  cell.getContext(),
                );
                const truncate =
                  typeof meta.truncate === 'function'
                    ? meta.truncate(row.original)
                    : meta.truncate !== false;
                const constrained =
                  meta.width !== undefined && !meta.fixedWidth && truncate;
                return (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      fixedClassName(
                        meta,
                        false,
                        fixedShadows.left,
                        fixedShadows.right,
                      ),
                    )}
                    style={columnStyle(
                      meta,
                      distributeFluidWidth,
                      availableWidth,
                      widthMetrics.minimum,
                      widthMetrics.fluidWeight,
                      fixedOffsets.get(cell.column.id),
                    )}
                    onClick={
                      meta.stopRowClick
                        ? (event) => event.stopPropagation()
                        : undefined
                    }
                  >
                    {tooltip !== undefined && tooltip !== null ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div
                            className={cn(constrained && 'min-w-0 truncate')}
                          >
                            {content}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>{tooltip}</TooltipContent>
                      </Tooltip>
                    ) : constrained ? (
                      <div className="min-w-0 truncate">{content}</div>
                    ) : (
                      content
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function DataTablePagination<TData>({
  table,
  pageSizes,
  labels,
  onPageSizeChange,
}: {
  table: TanStackTable<TData>;
  pageSizes: readonly number[];
  labels: {
    rowsPerPage: string;
    previous: ReactNode;
    next: ReactNode;
    page: (current: number, total: number) => ReactNode;
  };
  onPageSizeChange?: (pageSize: number) => void;
}) {
  return (
    <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span className="text-xs text-muted-foreground">
        {labels.rowsPerPage}
      </span>
      <Select
        value={String(table.getState().pagination.pageSize)}
        onValueChange={(value) => {
          const pageSize = Number(value);
          onPageSizeChange?.(pageSize);
          table.setPageSize(pageSize);
        }}
      >
        <SelectTrigger
          size="sm"
          className="w-20 text-xs"
          aria-label={labels.rowsPerPage}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {pageSizes.map((pageSize) => (
            <SelectItem key={pageSize} value={String(pageSize)}>
              {pageSize}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!table.getCanPreviousPage()}
        onClick={() => table.previousPage()}
      >
        {labels.previous}
      </Button>
      <span className="text-xs text-muted-foreground">
        {labels.page(
          table.getState().pagination.pageIndex + 1,
          table.getPageCount(),
        )}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!table.getCanNextPage()}
        onClick={() => table.nextPage()}
      >
        {labels.next}
      </Button>
    </div>
  );
}
