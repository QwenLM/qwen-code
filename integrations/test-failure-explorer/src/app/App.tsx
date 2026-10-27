/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type {
  DetailData,
  ItemHeader,
  ListData,
  QueryData,
  ReportQuery,
  ShowData,
} from '../app-contract.js';
import { analysisRequestText, type SendAnalysis } from './analysis-request.js';

type Query = (query: ReportQuery, signal: AbortSignal) => Promise<QueryData>;
type Collection = ListData['collection'];
type Status = ItemHeader['status'];
type Field = DetailData['field'];
type Filters = {
  collection: Collection;
  text: string;
  status?: Status;
  failureIds?: string[];
};
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
  sendAnalysis,
}: {
  report: ShowData;
  query?: Query;
  connectionNotice?: string;
  sendAnalysis?: SendAnalysis;
}) {
  const { summary } = report;
  const view =
    report.viewResolution.mode === 'generated' ? report.view : undefined;
  const listSection = view?.sections.find(
    (section) => section.kind === 'failure-list',
  );
  const evidenceSection = view?.sections.find(
    (section) => section.kind === 'evidence',
  );
  const initialText = listSection?.initialTextFilter ?? '';
  const initialDetail = report.initialDetail;
  const initialFailureId = evidenceSection?.initialFailureId;
  const [filters, setFilters] = useState<Filters>({
    collection: 'failures',
    text: initialText,
  });
  const [draftText, setDraftText] = useState(initialText);
  const [draftStatus, setDraftStatus] = useState<Status | 'all'>('all');
  const [page, setPage] = useState(report.firstPage);
  const [listOffset, setListOffset] = useState(0);
  const [listHistory, setListHistory] = useState<number[]>([]);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string>();
  const [item, setItem] = useState<ItemHeader | undefined>(initialDetail?.item);
  const [field, setField] = useState<Field>('diagnostics');
  const [detailPages, setDetailPages] = useState<
    Partial<Record<Field, DetailPage>>
  >(
    initialDetail
      ? { diagnostics: { data: initialDetail, previousOffsets: [] } }
      : {},
  );
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [detailRetry, setDetailRetry] = useState({
    offset: 0,
    previousOffsets: [] as number[],
  });
  const [detailOpen, setDetailOpen] = useState(Boolean(initialDetail));
  const initialEvidenceRequested = useRef(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [analysisStatus, setAnalysisStatus] = useState<{
    state: 'idle' | 'pending' | 'accepted' | 'unconfirmed';
    text: string;
  }>({ state: 'idle', text: '' });
  const analysisRequest = useRef<{
    generation: number;
    controller?: AbortController;
  }>({ generation: 0 });
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
    const analysis = analysisRequest.current;
    return () => {
      list.generation += 1;
      detail.generation += 1;
      list.controller?.abort();
      detail.controller?.abort();
      analysis.generation += 1;
      analysis.controller?.abort();
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
      setFilters({ collection: 'failures', text: initialText });
      setDraftText(initialText);
      setDraftStatus('all');
      setListOffset(0);
      setListHistory([]);
      setListError(undefined);
      if (view) {
        setItem(initialDetail?.item);
        setField('diagnostics');
        setDetailPages(
          initialDetail
            ? { diagnostics: { data: initialDetail, previousOffsets: [] } }
            : {},
        );
        setDetailOpen(Boolean(initialDetail));
        setDetailError(undefined);
      }
    }
  }, [query, report.firstPage, initialText, initialDetail, view]);

  useEffect(() => {
    const current = analysisRequest.current;
    if (!sendAnalysis && current.controller) {
      current.generation += 1;
      current.controller.abort();
      current.controller = undefined;
      setAnalysisStatus({
        state: 'unconfirmed',
        text: 'Connection lost. Acceptance is unknown; check the host review and original conversation before sending again.',
      });
    }
  }, [sendAnalysis]);

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
    if (view) listHeading.current?.focus();
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

  const loadDetail = useCallback(
    async (
      itemId: string,
      nextField: Field,
      offset: number,
      previousOffsets: number[],
    ) => {
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
          { kind: 'detail', itemId, field: nextField, offset },
          controller.signal,
        );
        if (generation !== current.generation || controller.signal.aborted)
          return;
        if (result.kind !== 'detail')
          throw new Error('Unexpected detail response.');
        setItem(result.item);
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
    },
    [query],
  );

  useEffect(() => {
    if (
      !query ||
      !initialFailureId ||
      initialDetail ||
      initialEvidenceRequested.current
    )
      return;
    initialEvidenceRequested.current = true;
    setDetailOpen(true);
    void loadDetail(initialFailureId, 'diagnostics', 0, []);
  }, [query, initialFailureId, initialDetail, loadDetail]);

  function openItem(nextItem: ItemHeader) {
    setDetailOpen(true);
    if (item?.itemId === nextItem.itemId) return;
    setItem(nextItem);
    setField('diagnostics');
    setDetailPages({});
    void loadDetail(nextItem.itemId, 'diagnostics', 0, []);
  }

  function changeField(nextField: Field) {
    detailRequest.current.generation += 1;
    detailRequest.current.controller?.abort();
    setDetailBusy(false);
    setDetailError(undefined);
    setField(nextField);
    if (item && !detailPages[nextField]) {
      void loadDetail(item.itemId, nextField, 0, []);
    }
  }

  function changeCollection(collection: Collection) {
    setDraftText(filters.text);
    setDraftStatus('all');
    void loadList(
      {
        collection,
        text: filters.text,
        ...(filters.failureIds ? { failureIds: filters.failureIds } : {}),
      },
      0,
      [],
    );
  }

  async function requestAnalysis() {
    const current = analysisRequest.current;
    if (!sendAnalysis || current.controller || selectedIds.length === 0) return;
    const controller = new AbortController();
    const generation = ++current.generation;
    current.controller = controller;
    setAnalysisStatus({
      state: 'pending',
      text: 'Review this request in the host. Analysis starts only after host approval and acceptance.',
    });
    try {
      const result = await sendAnalysis([...selectedIds], controller.signal);
      if (generation !== current.generation || controller.signal.aborted)
        return;
      setAnalysisStatus(
        result.isError
          ? {
              state: 'unconfirmed',
              text: 'The host did not confirm acceptance. Check the host review and original conversation before sending again.',
            }
          : {
              state: 'accepted',
              text: 'The daemon accepted the last request. Follow the original conversation for analysis; this does not confirm completion.',
            },
      );
    } catch {
      if (generation !== current.generation || controller.signal.aborted)
        return;
      setAnalysisStatus({
        state: 'unconfirmed',
        text: 'Acceptance is unknown. The request may have timed out or lost its connection; check the host review and original conversation before sending again.',
      });
    } finally {
      if (generation === current.generation) current.controller = undefined;
    }
  }

  function cancelAnalysis() {
    const current = analysisRequest.current;
    if (!current.controller) return;
    current.generation += 1;
    current.controller.abort();
    current.controller = undefined;
    setAnalysisStatus({
      state: 'unconfirmed',
      text: 'Cancellation requested. Acceptance is unknown; check the host review and original conversation before sending again.',
    });
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
    filters.text || filters.status || filters.failureIds
      ? 'No matches for these filters.'
      : summary.computed.assertions === 0 && summary.computed.fileErrors === 0
        ? 'This report contains no assertion or file-error entries.'
        : filters.collection === 'failures'
          ? 'No failed entries were recorded in this report.'
          : `No ${filters.collection} entries were recorded in this report.`;
  const selectionText =
    selectedIds.length > 0
      ? analysisRequestText(report.reportId, selectedIds)
      : '';

  const computedCounts = (
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
  );
  const statusCounts = (
    <div className="status-counts">
      {statuses.map((status) => (
        <span key={status} className={`status-count status-${status}`}>
          <strong>{summary.computed.statuses[status]}</strong> {status}
        </span>
      ))}
    </div>
  );
  const reportedCounts = (
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
  );
  const integrityWarnings = summary.consistencyWarningCount > 0 && (
    <details className="warnings">
      <summary>{summary.consistencyWarningCount} consistency warnings</summary>
      <ul>
        {summary.consistencyWarnings.map((warning, index) => (
          <li key={index}>
            {warning.text}
            {warning.truncated ? '…' : ''}
          </li>
        ))}
      </ul>
      {summary.consistencyWarningCount > summary.consistencyWarnings.length && (
        <p>
          Only the first {summary.consistencyWarnings.length} warnings are
          shown.
        </p>
      )}
    </details>
  );
  const controls = (
    <>
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
              ...(filters.failureIds ? { failureIds: filters.failureIds } : {}),
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
      {filters.failureIds && (
        <p className="group-filter" role="status">
          Group filter: {filters.failureIds.length} referenced failures.
          Collection, text and status filters still apply.
        </p>
      )}
    </>
  );

  function renderEntries(items: ItemHeader[]) {
    return (
      <ul className="entry-list">
        {items.map((entry) => (
          <li key={entry.itemId} data-active={item?.itemId === entry.itemId}>
            <input
              type="checkbox"
              aria-label={`Select ${entry.itemId}`}
              checked={selectedIds.includes(entry.itemId)}
              disabled={
                analysisStatus.state === 'pending' ||
                entry.status !== 'failed' ||
                (selectedIds.length >= 20 &&
                  !selectedIds.includes(entry.itemId))
              }
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelectedIds((previous) => {
                  if (!checked)
                    return previous.filter((id) => id !== entry.itemId);
                  if (previous.length >= 20 || previous.includes(entry.itemId))
                    return previous;
                  return [...previous, entry.itemId];
                });
              }}
            />
            <button
              type="button"
              className="entry-button"
              aria-pressed={item?.itemId === entry.itemId}
              disabled={!query && item?.itemId !== entry.itemId}
              onClick={() => openItem(entry)}
            >
              {listSection ? (
                listSection.columns.map((column) => (
                  <span
                    key={column}
                    data-column={column}
                    className={
                      column === 'status'
                        ? `entry-status status-${entry.status}`
                        : `entry-${column}`
                    }
                  >
                    {column === 'path' || column === 'title' ? (
                      <>
                        {entry[column].text ||
                          (column === 'title' ? '(untitled)' : '')}
                        {entry[column].truncated ? '…' : ''}
                      </>
                    ) : column === 'duration' ? (
                      entry.duration === null ? (
                        'Duration unknown'
                      ) : (
                        `${entry.duration} ms`
                      )
                    ) : (
                      entry.status
                    )}
                  </span>
                ))
              ) : (
                <>
                  <span className="entry-title">
                    {entry.title.text || '(untitled)'}
                    {entry.title.truncated ? '…' : ''}
                  </span>
                  <span className="entry-path">
                    {entry.path.text}
                    {entry.path.truncated ? '…' : ''}
                  </span>
                </>
              )}
              <span className="entry-meta">
                <code>{entry.itemId}</code>
                {!listSection && (
                  <span className={`entry-status status-${entry.status}`}>
                    {entry.status}
                  </span>
                )}
                {entry.kind === 'file-error' && <span>file error</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  const listPane = (
    <section
      className="list-pane"
      aria-label="Report entries"
      aria-busy={listBusy}
    >
      <div className="pane-heading">
        <h2 ref={listHeading} tabIndex={-1}>
          Entries
        </h2>
        <span>
          {total} in report
          {view && page ? ` · ${page.returnedCount} on this page` : ''}
        </span>
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
              onClick={() => void loadList(filters, listOffset, listHistory)}
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
        {page &&
          page.items.length > 0 &&
          (listSection?.groupBy === 'file'
            ? Array.from(
                page.items.reduce((groups, entry) => {
                  const fileId = entry.itemId.split(':')[0];
                  const items = groups.get(fileId) ?? [];
                  items.push(entry);
                  groups.set(fileId, items);
                  return groups;
                }, new Map<string, ItemHeader[]>()),
              ).map(([fileId, items]) => (
                <section
                  className="file-group"
                  key={fileId}
                  aria-label={`File ${fileId}`}
                >
                  <div className="file-group-heading">
                    <span>
                      <code>{fileId}</code>
                      {listSection.columns.includes('path') && (
                        <>
                          {' '}
                          · {items[0].path.text}
                          {items[0].path.truncated ? '…' : ''}
                        </>
                      )}
                    </span>
                    <span>{items.length} on this page</span>
                  </div>
                  {renderEntries(items)}
                </section>
              ))
            : renderEntries(page.items))}
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
  );
  const detailPane = (
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
          {item?.itemId ?? initialFailureId ?? 'Details'}
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
                      item.itemId,
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
                !query || detailBusy || !currentDetail?.previousOffsets.length
              }
              onClick={() => {
                if (currentDetail)
                  void loadDetail(
                    item.itemId,
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
                    item.itemId,
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
        <div className="empty-state">
          {detailBusy ? (
            <p role="status">Loading initial evidence…</p>
          ) : detailError ? (
            <p role="alert">Detail unavailable: {detailError}</p>
          ) : (
            <p>
              {initialFailureId
                ? 'The saved result does not include the initial evidence.'
                : 'Choose an entry to inspect its diagnostics, full path and title.'}
            </p>
          )}
          {initialFailureId && (
            <button
              type="button"
              disabled={!query || detailBusy}
              onClick={() =>
                void loadDetail(initialFailureId, 'diagnostics', 0, [])
              }
            >
              {detailError ? 'Retry initial evidence' : 'Load initial evidence'}
            </button>
          )}
        </div>
      )}
    </section>
  );

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

      {!view && (
        <section className="report-summary" aria-label="Report counts">
          {computedCounts}
          {statusCounts}
          {reportedCounts}
          {integrityWarnings}
        </section>
      )}
      {view && integrityWarnings}

      {(connectionNotice || !query) && (
        <p className="connection-notice" role="status">
          {connectionNotice ||
            'Read-only saved result. This host cannot query report details.'}
        </p>
      )}

      {report.viewResolution.mode === 'fixed' &&
        report.viewResolution.reason && (
          <p className="connection-notice" role="status">
            Fixed report view: {report.viewResolution.reason}.
          </p>
        )}

      {view ? (
        <>
          <div className="view-toolbar">
            <p>Generated view · Layout and hypotheses are model suggestions.</p>
            <button
              type="button"
              disabled={!query}
              onClick={() => {
                setDraftText('');
                setDraftStatus('all');
                void loadList({ collection: 'failures', text: '' }, 0, []);
              }}
            >
              All failures ({summary.computed.failures})
            </button>
          </div>
          <div className="generated-sections">
            {view.sections.map((section) => (
              <Fragment key={section.kind}>
                <section
                  data-view-section={section.kind}
                  className={`view-section view-${section.kind}`}
                  aria-label={
                    section.kind === 'hypothesis-groups'
                      ? 'Model hypotheses'
                      : undefined
                  }
                >
                  {section.kind === 'summary' && (
                    <div className="report-summary">
                      {computedCounts}
                      {reportedCounts}
                    </div>
                  )}
                  {section.kind === 'status-counts' && (
                    <div className="report-summary">
                      <h2>Assertion statuses</h2>
                      {statusCounts}
                    </div>
                  )}
                  {section.kind === 'failure-list' && (
                    <>
                      {controls}
                      {listPane}
                    </>
                  )}
                  {section.kind === 'evidence' && detailPane}
                  {section.kind === 'hypothesis-groups' && (
                    <div className="hypothesis-groups">
                      <h2>Model hypotheses</h2>
                      <p className="hypothesis-notice">
                        Diagnostic suggestions, not confirmed causes. Covers{' '}
                        {
                          new Set(
                            section.groups.flatMap((group) => group.failureIds),
                          ).size
                        }{' '}
                        / {summary.computed.failures} failed entries (unique).
                      </p>
                      <ul>
                        {section.groups.map((group, index) => (
                          <li key={index}>
                            <h3>{group.label}</h3>
                            <p>{group.hypothesis}</p>
                            <p className="hypothesis-references">
                              <code>{group.failureIds.join(', ')}</code>
                            </p>
                            <button
                              type="button"
                              aria-label={`View group ${group.label}`}
                              disabled={!query}
                              onClick={() => {
                                setDraftText(filters.text);
                                setDraftStatus(filters.status ?? 'all');
                                void loadList(
                                  { ...filters, failureIds: group.failureIds },
                                  0,
                                  [],
                                );
                              }}
                            >
                              View {group.failureIds.length} referenced failures
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
                {section.kind === 'failure-list' &&
                  !evidenceSection &&
                  detailOpen && (
                    <section className="view-section view-evidence">
                      {detailPane}
                    </section>
                  )}
              </Fragment>
            ))}
          </div>
        </>
      ) : (
        <>
          {controls}
          <div className="workspace" data-detail-open={detailOpen}>
            {listPane}
            {detailPane}
          </div>
        </>
      )}

      <footer className="selection">
        <div className="selection-heading">
          <span aria-live="polite">
            {selectedIds.length} / 20 failures selected
          </span>
          {selectedIds.length > 0 && (
            <>
              <button
                type="button"
                disabled={analysisStatus.state === 'pending'}
                onClick={() => setSelectedIds([])}
              >
                Clear selection
              </button>
              {sendAnalysis && (
                <button
                  type="button"
                  disabled={analysisStatus.state === 'pending'}
                  onClick={() => void requestAnalysis()}
                >
                  Review selected failures
                </button>
              )}
              {analysisStatus.state === 'pending' && (
                <button type="button" onClick={cancelAnalysis}>
                  Cancel request
                </button>
              )}
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
        {analysisStatus.text && (
          <p className="analysis-status" role="status">
            {analysisStatus.text}
          </p>
        )}
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
