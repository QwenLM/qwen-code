import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { extractErrorDetail } from '../../utils/errorDetail';
import {
  downloadWorkspaceFile,
  readWorkspaceFileAsBlob,
} from './artifactUtils';
import type { ArtifactWorkspaceActions } from './useArtifactWorkspaceTarget';
import ExcelWorker from './excel-preview.worker?worker&inline';
import {
  excelColumnLabel,
  MAX_EXCEL_PREVIEW_BYTES,
  MAX_EXCEL_PREVIEW_CELLS,
  type ExcelPreviewCell,
  type ExcelPreviewResult,
  type ExcelPreviewWorkbookInfo,
  type ExcelPreviewSheet,
} from './excel-preview-types';

const MAX_VISIBLE_SHEET_TABS = 50;

export default function SpreadsheetPreview({
  workspacePath,
  workspaceActions,
  data,
  artifactVersion,
}: {
  workspacePath: string;
  workspaceActions?: ArtifactWorkspaceActions;
  data?: Blob;
  artifactVersion?: string;
}) {
  const { t } = useI18n();
  const [workbook, setWorkbook] = useState<ExcelPreviewWorkbookInfo>();
  const [selectedSheet, setSelectedSheet] = useState<{
    index: number;
    sheet: ExcelPreviewSheet;
  }>();
  const [error, setError] = useState<string>();
  const [downloadUrl, setDownloadUrl] = useState<string>();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [sheetIndex, setSheetIndex] = useState(0);
  const workerRef = useRef<Worker | undefined>(undefined);
  const requestedSheetRef = useRef<number | undefined>(undefined);
  const sheetTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const ownerRef = useRef<object | undefined>(undefined);
  const sheetTabsRef = useRef<HTMLDivElement>(null);
  const focusSheetTabRef = useRef(false);
  useEffect(() => {
    if (focusSheetTabRef.current) {
      focusSheetTabRef.current = false;
      sheetTabsRef.current
        ?.querySelector<HTMLButtonElement>('[data-state="active"]')
        ?.focus();
    }
  }, [sheetIndex]);
  useEffect(() => {
    const owner = {};
    ownerRef.current = owner;
    let cancelled = false;
    let failed = false;
    let worker: Worker | undefined;
    let loadTimeout: ReturnType<typeof setTimeout> | undefined;
    let url: string | undefined;
    setWorkbook(undefined);
    setError(undefined);
    setDownloadUrl(undefined);
    setDownloading(false);
    setDownloadError(undefined);
    setSheetIndex(0);
    setSelectedSheet(undefined);
    requestedSheetRef.current = undefined;
    const fail = (message: string) => {
      if (cancelled || failed) return;
      failed = true;
      worker?.terminate();
      clearTimeout(loadTimeout);
      setError(message);
    };
    const load = async () => {
      const blob =
        data ??
        (await readWorkspaceFileAsBlob(
          workspaceActions!.readFileBytes,
          workspacePath,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          {
            statFile: async (path) => {
              const stat = await workspaceActions!.stat(path);
              if (stat.sizeBytes > MAX_EXCEL_PREVIEW_BYTES)
                throw new Error(t('excel.tooLarge'));
              return stat;
            },
            isCancelled: () => cancelled,
            maxBytes: MAX_EXCEL_PREVIEW_BYTES,
          },
        ));
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setDownloadUrl(url);
      if (blob.size > MAX_EXCEL_PREVIEW_BYTES) {
        fail(t('excel.tooLarge'));
        return;
      }
      const bytes = await blob.arrayBuffer();
      if (cancelled) return;
      worker = new ExcelWorker();
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<ExcelPreviewResult>) => {
        if (cancelled || failed) return;
        const result = event.data;
        if (result.type === 'error') {
          fail(t('excel.invalid'));
        } else if (result.type === 'loaded') {
          clearTimeout(loadTimeout);
          setWorkbook(result.workbook);
        } else if (result.index === requestedSheetRef.current) {
          clearTimeout(sheetTimeoutRef.current);
          setSelectedSheet({ index: result.index, sheet: result.sheet });
        }
      };
      worker.onerror = () => fail(t('excel.invalid'));
      loadTimeout = setTimeout(() => fail(t('excel.timeout')), 30000);
      worker.postMessage({ type: 'load', data: bytes }, [bytes]);
    };
    void load().catch((reason: unknown) => fail(extractErrorDetail(reason)));
    return () => {
      cancelled = true;
      ownerRef.current = undefined;
      worker?.terminate();
      clearTimeout(loadTimeout);
      if (workerRef.current === worker) workerRef.current = undefined;
      if (url) URL.revokeObjectURL(url);
    };
  }, [data, workspacePath, workspaceActions, artifactVersion, attempt, t]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!workbook?.sheetNames.length || !worker || error) return;
    requestedSheetRef.current = sheetIndex;
    setSelectedSheet(undefined);
    const timeout = setTimeout(() => {
      requestedSheetRef.current = undefined;
      worker.terminate();
      setError(t('excel.timeout'));
    }, 30000);
    sheetTimeoutRef.current = timeout;
    worker.postMessage({ type: 'sheet', index: sheetIndex });
    return () => clearTimeout(timeout);
  }, [workbook, sheetIndex, error, t]);

  const sheet =
    selectedSheet?.index === sheetIndex ? selectedSheet.sheet : undefined;

  const sheetTabStart =
    Math.floor(sheetIndex / MAX_VISIBLE_SHEET_TABS) * MAX_VISIBLE_SHEET_TABS;
  const sheetTabEnd = Math.min(
    sheetTabStart + MAX_VISIBLE_SHEET_TABS,
    workbook?.sheetNames.length ?? 0,
  );

  return (
    <Tabs
      value={String(sheetIndex)}
      onValueChange={(value) => setSheetIndex(Number(value))}
      data-web-shell-excel-preview
      className="h-full min-h-0 min-w-0 flex-1 gap-0 bg-background text-foreground"
    >
      <div className="flex min-w-0 items-end gap-2 border-b border-border">
        {workbook && workbook.sheetNames.length > MAX_VISIBLE_SHEET_TABS && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            aria-label={t('excel.previousWorksheets')}
            disabled={sheetTabStart === 0}
            onClick={() => setSheetIndex(sheetTabStart - 1)}
          >
            <ChevronLeftIcon />
          </Button>
        )}
        {workbook && workbook.sheetNames.length > 0 ? (
          <TabsList
            ref={sheetTabsRef}
            variant="line"
            aria-label={t('excel.worksheet')}
            className="-mb-px min-w-0 flex-1 justify-start gap-1 overflow-x-auto p-0 group-data-horizontal/tabs:h-6"
            onKeyDownCapture={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? Math.min(sheetIndex + 1, workbook.sheetNames.length - 1)
                  : event.key === 'ArrowLeft'
                    ? Math.max(sheetIndex - 1, 0)
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? workbook.sheetNames.length - 1
                        : undefined;
              if (next !== undefined) {
                event.preventDefault();
                if (next !== sheetIndex) {
                  focusSheetTabRef.current = true;
                  setSheetIndex(next);
                }
              }
            }}
          >
            {workbook.sheetNames
              .slice(sheetTabStart, sheetTabEnd)
              .map((name, offset) => (
                <TabsTrigger
                  key={sheetTabStart + offset}
                  value={String(sheetTabStart + offset)}
                  title={name}
                  className="h-6 max-w-48 flex-none rounded-none rounded-t-lg border-border bg-muted/40 px-4 py-0 text-xs font-normal text-foreground after:hidden data-[state=active]:border-b-background data-[state=active]:bg-background data-[state=active]:text-[var(--agent-blue-400)] dark:data-[state=active]:text-[var(--agent-blue-400)]"
                >
                  <span className="truncate">{name}</span>
                </TabsTrigger>
              ))}
          </TabsList>
        ) : (
          <span className="flex-1" />
        )}
        {workbook && workbook.sheetNames.length > MAX_VISIBLE_SHEET_TABS && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            aria-label={t('excel.nextWorksheets')}
            disabled={sheetTabEnd === workbook.sheetNames.length}
            onClick={() => setSheetIndex(sheetTabEnd)}
          >
            <ChevronRightIcon />
          </Button>
        )}
        {downloadUrl ? (
          <Button variant="ghost" size="sm" asChild>
            <a
              href={downloadUrl}
              download={workspacePath.split(/[/\\]/).pop()}
              onClick={(event) => event.stopPropagation()}
            >
              <DownloadIcon />
              {t('common.download')}
            </a>
          </Button>
        ) : (
          workspaceActions && (
            <Button
              variant="ghost"
              size="sm"
              disabled={downloading}
              onClick={() => {
                const owner = ownerRef.current;
                setDownloading(true);
                setDownloadError(undefined);
                void downloadWorkspaceFile(
                  workspaceActions,
                  workspacePath,
                  undefined,
                  () => ownerRef.current !== owner,
                )
                  .catch((reason: unknown) => {
                    if (ownerRef.current === owner)
                      setDownloadError(extractErrorDetail(reason));
                  })
                  .finally(() => {
                    if (ownerRef.current === owner) setDownloading(false);
                  });
              }}
            >
              <DownloadIcon />
              {t('common.download')}
            </Button>
          )
        )}
      </div>
      {downloadError && (
        <p role="status" className="px-3 py-2 text-xs text-destructive">
          {downloadError}
        </p>
      )}
      <TabsContent
        value={String(sheetIndex)}
        className="flex min-h-0 flex-1 flex-col pt-2"
      >
        {!error && sheet?.truncated && (
          <p
            role="status"
            className="border-b border-border px-3 py-2 text-xs text-muted-foreground"
          >
            {t('excel.truncated', {
              cells: MAX_EXCEL_PREVIEW_CELLS.toLocaleString(),
            })}
          </p>
        )}
        {error ? (
          <div role="alert" className="space-y-3 p-4 text-sm">
            <p>{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : !workbook || (workbook.sheetNames.length > 0 && !sheet) ? (
          <div role="status" className="p-4 text-sm text-muted-foreground">
            {t('common.loading')}
          </div>
        ) : !sheet?.rows.length || !sheet.columns ? (
          <div className="p-4 text-sm text-muted-foreground">
            {t('excel.empty')}
          </div>
        ) : (
          <SpreadsheetTable key={sheetIndex} sheet={sheet} />
        )}
      </TabsContent>
    </Tabs>
  );
}

function SpreadsheetTable({ sheet }: { sheet: ExcelPreviewSheet }) {
  const { t } = useI18n();
  const gutterWidth = `max(56px, calc(${String(sheet.rows.length).length}ch + 0.5rem + 1px))`;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: sheet.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 29,
    paddingStart: 29,
    overscan: 5,
  });
  const rows = virtualizer.getVirtualItems();
  const start = rows[0]?.index ?? 0;
  const end = (rows.at(-1)?.index ?? -1) + 1;
  const merged = useMemo(() => {
    const cells = new Map<
      string,
      { rowSpan: number; colSpan: number; cell: ExcelPreviewCell | null } | null
    >();
    // Keep merged content visible when its original master is outside the mounted rows.
    for (const merge of sheet.merges) {
      const top = Math.max(start, merge.top);
      const bottom = Math.min(end - 1, merge.bottom);
      const right = Math.min(sheet.columns - 1, merge.right);
      for (let r = top; r <= bottom; r++) {
        for (let c = merge.left; c <= right; c++) cells.set(`${r}:${c}`, null);
      }
      if (top <= bottom)
        cells.set(`${top}:${merge.left}`, {
          rowSpan: bottom - top + 1,
          colSpan: right - merge.left + 1,
          cell: sheet.rows[merge.top]?.[merge.left] ?? null,
        });
    }
    return cells;
  }, [sheet, start, end]);

  return (
    <div
      ref={scrollRef}
      data-web-shell-excel-scroll
      className="min-h-0 flex-1 overflow-auto border-t border-border [overflow-anchor:none]"
      tabIndex={0}
      role="region"
      aria-label={sheet.name}
    >
      <table
        aria-label={sheet.name}
        aria-rowcount={sheet.rows.length + 1}
        className="min-w-full table-fixed border-separate border-spacing-0 text-sm tabular-nums"
        style={{ width: `calc(${gutterWidth} + ${sheet.columns * 160}px)` }}
      >
        <colgroup>
          <col style={{ width: gutterWidth }} />
          {Array.from({ length: sheet.columns }, (_, c) => (
            <col key={c} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-20 bg-muted">
          <tr aria-rowindex={1}>
            <th
              className="sticky left-0 z-10 border-b border-r border-border bg-muted px-2 py-1"
              aria-label={t('excel.row')}
            />
            {Array.from({ length: sheet.columns }, (_, c) => (
              <th
                key={c}
                scope="col"
                className="border-b border-r border-border px-2 py-1 font-normal"
              >
                {excelColumnLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr aria-hidden="true">
            <td
              colSpan={sheet.columns + 1}
              style={{
                height: Math.max(0, (rows[0]?.start ?? 29) - 29),
                padding: 0,
                border: 0,
              }}
            />
          </tr>
          {rows.map((virtualRow) => {
            const r = virtualRow.index;
            return (
              <tr
                key={virtualRow.key}
                data-index={r}
                ref={virtualizer.measureElement}
                aria-rowindex={r + 2}
              >
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-r border-border bg-muted whitespace-nowrap px-1 py-1 text-right font-normal text-muted-foreground"
                >
                  {r + 1}
                </th>
                {sheet.rows[r]!.map((value, c) => {
                  const merge = merged.get(`${r}:${c}`);
                  if (merge === null) return null;
                  const cell = merge?.cell ?? value;
                  return (
                    <td
                      key={c}
                      rowSpan={merge?.rowSpan}
                      colSpan={merge?.colSpan}
                      title={cell?.formula ? `=${cell.formula}` : cell?.text}
                      style={{
                        ...cell?.style,
                        // Workbook colors need a white canvas, independent of the shell theme.
                        color: cell?.style.color ?? '#000000',
                        backgroundColor:
                          cell?.style.backgroundColor ?? '#ffffff',
                      }}
                      className="border-b border-r border-border px-2 py-1 align-top whitespace-pre-wrap break-words"
                    >
                      {cell?.uncalculated ? (
                        <span className="text-muted-foreground">
                          ={cell.formula} ({t('excel.notCalculated')})
                        </span>
                      ) : (
                        cell?.text
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          <tr aria-hidden="true">
            <td
              colSpan={sheet.columns + 1}
              style={{
                height: Math.max(
                  0,
                  virtualizer.getTotalSize() - (rows.at(-1)?.end ?? 29),
                ),
                padding: 0,
                border: 0,
              }}
            />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
