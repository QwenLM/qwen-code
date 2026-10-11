/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import type {
  DetailData,
  ItemHeader,
  ListData,
  QueryData,
  ReportQuery,
  ShowData,
} from '../app-contract.js';

type Query = (query: ReportQuery, signal: AbortSignal) => Promise<QueryData>;
type Collection = ListData['collection'];
type Status = ItemHeader['status'];
type Field = DetailData['field'];
type Filters = { collection: Collection; text: string; status?: Status };
type DetailPage = { data: DetailData; previousOffsets: number[] };

const statuses: Status[] = [
  'failed',
  'passed',
  'skipped',
  'pending',
  'todo',
  'disabled',
];
const collections: Array<{ value: Collection; label: string }> = [
  { value: 'failures', label: 'Failures' },
  { value: 'assertions', label: 'Assertions' },
  { value: 'file-errors', label: 'File errors' },
];
const fields: Field[] = ['diagnostics', 'path', 'title'];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The query is unavailable.';
}

export function ReportApp({
  report,
  query,
  connectionNotice,
}: {
  report: ShowData;
  query?: Query;
  connectionNotice?: string;
}) {
  const { summary } = report;
  const [filters, setFilters] = useState<Filters>({
    collection: 'failures',
    text: '',
  });
  const [draftText, setDraftText] = useState('');
  const [draftStatus, setDraftStatus] = useState<Status | 'all'>('all');
  const [page, setPage] = useState(report.firstPage);
  const [listOffset, setListOffset] = useState(0);
  const [listHistory, setListHistory] = useState<number[]>([]);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string>();
  const [item, setItem] = useState<ItemHeader>();
  const [field, setField] = useState<Field>('diagnostics');
  const [detailPages, setDetailPages] = useState<
    Partial<Record<Field, DetailPage>>
  >({});
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [detailRetry, setDetailRetry] = useState({
    offset: 0,
    previousOffsets: [] as number[],
  });
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const listRequest = useRef<{
    generation: number;
    controller?: AbortController;
  }>({ generation: 0 });
  const detailRequest = useRef<{
    generation: number;
    controller?: AbortController;
  }>({ generation: 0 });
  const listHeading = useRef<HTMLHeadingElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const requestText = useRef<HTMLTextAreaElement>(null);
  const wasDetailOpen = useRef(false);

  useEffect(() => {
    const list = listRequest.current;
    const detail = detailRequest.current;
    return () => {
      list.generation += 1;
      detail.generation += 1;
      list.controller?.abort();
      detail.controller?.abort();
    };
  }, []);

  useEffect(() => {
    if (!query) {
      listRequest.current.generation += 1;
      detailRequest.current.generation += 1;
      listRequest.current.controller?.abort();
      detailRequest.current.controller?.abort();
      setListBusy(false);
      setDetailBusy(false);
      setPage(report.firstPage);
      setFilters({ collection: 'failures', text: '' });
      setDraftText('');
      setDraftStatus('all');
      setListOffset(0);
      setListHistory([]);
      setListError(undefined);
    }
  }, [query, report.firstPage]);

  useEffect(() => {
    if (detailOpen) detailHeading.current?.focus();
    else if (wasDetailOpen.current) listHeading.current?.focus();
    wasDetailOpen.current = detailOpen;
  }, [detailOpen, item?.itemId]);

  async function loadList(
    nextFilters: Filters,
    offset: number,
    previousOffsets: number[],
  ) {
    if (!query) return;
    const current = listRequest.current;
    current.controller?.abort();
    const controller = new AbortController();
    const generation = ++current.generation;
    current.controller = controller;
    setFilters(nextFilters);
    setListOffset(offset);
    setListHistory(previousOffsets);
    setListBusy(true);
    setListError(undefined);
    setPage(undefined);
    setDetailOpen(false);
    try {
      const result = await query(
        { kind: 'list', ...nextFilters, offset, limit: 25 },
        controller.signal,
      );
      if (generation !== current.generation || controller.signal.aborted)
        return;
      if (result.kind !== 'list') throw new Error('Unexpected list response.');
      setPage(result);
    } catch (error) {
      if (generation !== current.generation || controller.signal.aborted)
        return;
      setListError(errorMessage(error));
    } finally {
      if (generation === current.generation) setListBusy(false);
    }
  }

  async function loadDetail(
    nextItem: ItemHeader,
    nextField: Field,
    offset: number,
    previousOffsets: number[],
  ) {
    if (!query) return;
    const current = detailRequest.current;
    current.controller?.abort();
    const controller = new AbortController();
    const generation = ++current.generation;
    current.controller = controller;
    setDetailBusy(true);
    setDetailError(undefined);
    setDetailRetry({ offset, previousOffsets });
    try {
      const result = await query(
        { kind: 'detail', itemId: nextItem.itemId, field: nextField, offset },
        controller.signal,
      );
      if (generation !== current.generation || controller.signal.aborted)
        return;
      if (result.kind !== 'detail')
        throw new Error('Unexpected detail response.');
      setDetailPages((previous) => ({
        ...previous,
        [nextField]: { data: result, previousOffsets },
      }));
    } catch (error) {
      if (generation !== current.generation || controller.signal.aborted)
        return;
      setDetailError(errorMessage(error));
    } finally {
      if (generation === current.generation) setDetailBusy(false);
    }
  }

  function openItem(nextItem: ItemHeader) {
    setDetailOpen(true);
    if (item?.itemId === nextItem.itemId) return;
    setItem(nextItem);
    setField('diagnostics');
    setDetailPages({});
    void loadDetail(nextItem, 'diagnostics', 0, []);
  }

  function changeField(nextField: Field) {
    detailRequest.current.generation += 1;
    detailRequest.current.controller?.abort();
    setDetailBusy(false);
    setDetailError(undefined);
    setField(nextField);
    if (item && !detailPages[nextField]) {
      void loadDetail(item, nextField, 0, []);
    }
  }

  function changeCollection(collection: Collection) {
    setDraftText(filters.text);
    setDraftStatus('all');
    void loadList({ collection, text: filters.text }, 0, []);
  }

  const total =
    filters.collection === 'failures'
      ? summary.computed.failures
      : filters.collection === 'assertions'
        ? summary.computed.assertions
        : summary.computed.fileErrors;
  const currentDetail = detailPages[field];
  const availableStatuses =
    filters.collection === 'failures'
      ? statuses.filter((status) => status === 'failed')
      : filters.collection === 'file-errors'
        ? statuses.filter(
            (status) => status === 'failed' || status === 'passed',
          )
        : statuses;
  const emptyMessage =
    filters.text || filters.status
      ? 'No matches for these filters.'
      : summary.computed.assertions === 0 && summary.computed.fileErrors === 0
        ? 'This report contains no assertion or file-error entries.'
        : filters.collection === 'failures'
          ? 'No failed entries were recorded in this report.'
          : `No ${filters.collection} entries were recorded in this report.`;
  const selectionText = `Analyze these failures using test_report_query:\n${JSON.stringify(
    { reportId: report.reportId, itemIds: selectedIds },
    null,
    2,
  )}`;

  return (
    <main className="explorer" aria-label="Test failure explorer">
      <header className="report-header">
        <div className="heading-line">
          <h1>Test failure explorer</h1>
        </div>
        <div className="source-line">
          <span
            className="source-path"
            title={summary.source.relativePath.text}
          >
            {summary.source.relativePath.text}
            {summary.source.relativePath.truncated ? '…' : ''}
          </span>
          <code title={summary.source.sha256}>
            {summary.source.sha256.slice(0, 12)}
          </code>
          <time dateTime={summary.importedAt}>{summary.importedAt}</time>
        </div>
        <p className="provenance">
          Report only · Process exit {summary.provenance.processExitCode} · Run
          completeness {summary.provenance.runCompleteness} · Tested commit{' '}
          {summary.provenance.testedCommit} · Unhandled errors{' '}
          {summary.provenance.unhandledErrors}
        </p>
      </header>

      <section className="report-summary" aria-label="Report counts">
        <div className="computed-counts">
          <span className="eyebrow">Computed</span>
          <span>
            <strong>{summary.computed.fileEntries}</strong> file entries
          </span>
          <span>
            <strong>{summary.computed.assertions}</strong> assertions
          </span>
          <span>
            <strong>{summary.computed.fileErrors}</strong> file errors
          </span>
        </div>
        <div className="status-counts">
          {statuses.map((status) => (
            <span key={status} className={`status-count status-${status}`}>
              <strong>{summary.computed.statuses[status]}</strong> {status}
            </span>
          ))}
        </div>
        <details className="reported-counts">
          <summary>
            Reported: {summary.reported.numTotalTestSuites} suites ·{' '}
            {summary.reported.numTotalTests} tests · report.success:{' '}
            {String(summary.reported.success)}
          </summary>
          <p>
            Suites: {summary.reported.numPassedTestSuites} passed,{' '}
            {summary.reported.numFailedTestSuites} failed,{' '}
            {summary.reported.numPendingTestSuites} pending. Tests:{' '}
            {summary.reported.numPassedTests} passed,{' '}
            {summary.reported.numFailedTests} failed,{' '}
            {summary.reported.numPendingTests} pending,{' '}
            {summary.reported.numTodoTests} todo.
          </p>
        </details>
        {summary.consistencyWarningCount > 0 && (
          <details className="warnings">
            <summary>
              {summary.consistencyWarningCount} consistency warnings
            </summary>
            <ul>
              {summary.consistencyWarnings.map((warning, index) => (
                <li key={index}>
                  {warning.text}
                  {warning.truncated ? '…' : ''}
                </li>
              ))}
            </ul>
            {summary.consistencyWarningCount >
              summary.consistencyWarnings.length && (
              <p>
                Only the first {summary.consistencyWarnings.length} warnings are
                shown.
              </p>
            )}
          </details>
        )}
      </section>

      {(connectionNotice || !query) && (
        <p className="connection-notice" role="status">
          {connectionNotice ||
            'Read-only saved result. This host cannot query report details.'}
        </p>
      )}

      <nav className="collections" aria-label="Entry collection">
        {collections.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={filters.collection === value}
            disabled={!query}
            onClick={() => changeCollection(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          void loadList(
            {
              collection: filters.collection,
              text: draftText,
              ...(draftStatus === 'all' ? {} : { status: draftStatus }),
            },
            0,
            [],
          );
        }}
      >
        <label className="search-label">
          <span className="sr-only">Search the whole report</span>
          <input
            type="search"
            placeholder="Literal search across this report"
            maxLength={512}
            value={draftText}
            disabled={!query}
            onChange={(event) => setDraftText(event.currentTarget.value)}
          />
        </label>
        <label>
          <span className="sr-only">Entry status</span>
          <select
            value={draftStatus}
            disabled={!query}
            onChange={(event) =>
              setDraftStatus(event.currentTarget.value as Status | 'all')
            }
          >
            <option value="all">All statuses</option>
            {availableStatuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={!query}>
          Search
        </button>
      </form>
      <p className="search-scope">
        Case-sensitive literal text · Entire snapshot, including diagnostics
      </p>

      <div className="workspace" data-detail-open={detailOpen}>
        <section
          className="list-pane"
          aria-label="Report entries"
          aria-busy={listBusy}
        >
          <div className="pane-heading">
            <h2 ref={listHeading} tabIndex={-1}>
              Entries
            </h2>
            <span>{total} in report</span>
          </div>
          <div className="entries-scroll">
            {listBusy && (
              <p className="empty-state" role="status">
                Loading entries…
              </p>
            )}
            {listError && (
              <div className="query-error" role="alert">
                <p>Entries unavailable: {listError}</p>
                <button
                  type="button"
                  disabled={!query}
                  onClick={() =>
                    void loadList(filters, listOffset, listHistory)
                  }
                >
                  Retry entries
                </button>
              </div>
            )}
            {!listBusy && !listError && !page && (
              <div className="empty-state">
                <p>The saved result does not include a first page.</p>
                <button
                  type="button"
                  disabled={!query}
                  onClick={() => void loadList(filters, 0, [])}
                >
                  Load entries
                </button>
              </div>
            )}
            {page?.items.length === 0 && (
              <p className="empty-state">{emptyMessage}</p>
            )}
            {page && page.items.length > 0 && (
              <ul className="entry-list">
                {page.items.map((entry) => (
                  <li
                    key={entry.itemId}
                    data-active={item?.itemId === entry.itemId}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select ${entry.itemId}`}
                      checked={selectedIds.includes(entry.itemId)}
                      disabled={
                        entry.status !== 'failed' ||
                        (selectedIds.length >= 20 &&
                          !selectedIds.includes(entry.itemId))
                      }
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setSelectedIds((previous) => {
                          if (!checked)
                            return previous.filter((id) => id !== entry.itemId);
                          if (
                            previous.length >= 20 ||
                            previous.includes(entry.itemId)
                          )
                            return previous;
                          return [...previous, entry.itemId];
                        });
                      }}
                    />
                    <button
                      type="button"
                      className="entry-button"
                      aria-pressed={item?.itemId === entry.itemId}
                      disabled={!query}
                      onClick={() => openItem(entry)}
                    >
                      <span className="entry-title">
                        {entry.title.text || '(untitled)'}
                        {entry.title.truncated ? '…' : ''}
                      </span>
                      <span className="entry-path">
                        {entry.path.text}
                        {entry.path.truncated ? '…' : ''}
                      </span>
                      <span className="entry-meta">
                        <code>{entry.itemId}</code>
                        <span className={`entry-status status-${entry.status}`}>
                          {entry.status}
                        </span>
                        {entry.kind === 'file-error' && <span>file error</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="pagination">
            <span aria-live="polite">
              {page
                ? `${page.returnedCount ? page.offset + 1 : 0}–${page.offset + page.returnedCount} of ${page.matchedCount} matched`
                : `${total} total entries`}
            </span>
            <button
              type="button"
              aria-label="Previous entries"
              disabled={!query || listBusy || listHistory.length === 0}
              onClick={() =>
                void loadList(
                  filters,
                  listHistory.at(-1) ?? 0,
                  listHistory.slice(0, -1),
                )
              }
            >
              Previous
            </button>
            <button
              type="button"
              aria-label="Next entries"
              disabled={!query || listBusy || !page || page.nextOffset === null}
              onClick={() => {
                if (page?.nextOffset != null)
                  void loadList(filters, page.nextOffset, [
                    ...listHistory,
                    page.offset,
                  ]);
              }}
            >
              Next
            </button>
          </div>
        </section>

        <section
          className="detail-pane"
          aria-label="Entry details"
          aria-busy={detailBusy}
        >
          <div className="pane-heading">
            <button
              className="back-to-list"
              type="button"
              onClick={() => setDetailOpen(false)}
            >
              Back to entries
            </button>
            <h2 ref={detailHeading} tabIndex={-1}>
              {item ? item.itemId : 'Details'}
            </h2>
            {item && (
              <span className={`entry-status status-${item.status}`}>
                {item.status}
              </span>
            )}
          </div>
          {item ? (
            <>
              <p className="detail-title">
                {item.title.text || '(untitled)'}
                {item.title.truncated ? '…' : ''}
              </p>
              <p className="detail-location">
                {item.duration === null
                  ? 'Duration unknown'
                  : `${item.duration} ms`}
                {item.location
                  ? ` · Line ${item.location.line}, column ${item.location.column}`
                  : ' · Location unknown'}
              </p>
              <nav className="detail-fields" aria-label="Detail field">
                {fields.map((value) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={field === value}
                    disabled={!query && !detailPages[value]}
                    onClick={() => changeField(value)}
                  >
                    {value}
                  </button>
                ))}
              </nav>
              <div className="detail-scroll">
                {detailBusy ? (
                  <p className="empty-state" role="status">
                    Loading {field}…
                  </p>
                ) : detailError ? (
                  <div className="query-error" role="alert">
                    <p>Detail unavailable: {detailError}</p>
                    <button
                      type="button"
                      disabled={!query}
                      onClick={() =>
                        void loadDetail(
                          item,
                          field,
                          detailRetry.offset,
                          detailRetry.previousOffsets,
                        )
                      }
                    >
                      Retry detail
                    </button>
                  </div>
                ) : currentDetail ? (
                  currentDetail.data.text ? (
                    <pre>{currentDetail.data.text}</pre>
                  ) : (
                    <p className="empty-state">
                      No {field} was recorded for this entry.
                    </p>
                  )
                ) : (
                  <p className="empty-state">
                    Details are unavailable in this saved result.
                  </p>
                )}
              </div>
              <div className="pagination detail-pagination">
                <span>
                  {currentDetail
                    ? `${currentDetail.data.offset}–${currentDetail.data.offset + currentDetail.data.text.length} / ${currentDetail.data.totalLength} chars`
                    : 'Terminal-safe plain text'}
                </span>
                <button
                  type="button"
                  aria-label="Previous detail fragment"
                  disabled={
                    !query ||
                    detailBusy ||
                    !currentDetail?.previousOffsets.length
                  }
                  onClick={() => {
                    if (currentDetail)
                      void loadDetail(
                        item,
                        field,
                        currentDetail.previousOffsets.at(-1) ?? 0,
                        currentDetail.previousOffsets.slice(0, -1),
                      );
                  }}
                >
                  Previous
                </button>
                <button
                  type="button"
                  aria-label="Next detail fragment"
                  disabled={
                    !query ||
                    detailBusy ||
                    !currentDetail ||
                    currentDetail.data.nextOffset === null
                  }
                  onClick={() => {
                    if (currentDetail?.data.nextOffset != null)
                      void loadDetail(
                        item,
                        field,
                        currentDetail.data.nextOffset,
                        [
                          ...currentDetail.previousOffsets,
                          currentDetail.data.offset,
                        ],
                      );
                  }}
                >
                  Next
                </button>
              </div>
            </>
          ) : (
            <p className="empty-state">
              Choose an entry to inspect its diagnostics, full path and title.
            </p>
          )}
        </section>
      </div>

      <footer className="selection">
        <div className="selection-heading">
          <span aria-live="polite">
            {selectedIds.length} / 20 failures selected
          </span>
          {selectedIds.length > 0 && (
            <>
              <button type="button" onClick={() => setSelectedIds([])}>
                Clear selection
              </button>
              <button
                type="button"
                onClick={() => {
                  requestText.current?.focus();
                  requestText.current?.select();
                }}
              >
                Select request text
              </button>
            </>
          )}
        </div>
        {selectedIds.length > 0 && (
          <label className="copy-request">
            <span>Copy this request manually into the conversation.</span>
            <textarea
              ref={requestText}
              aria-label="Analysis request"
              readOnly
              value={selectionText}
              rows={2}
              spellCheck={false}
            />
          </label>
        )}
      </footer>
    </main>
  );
}
