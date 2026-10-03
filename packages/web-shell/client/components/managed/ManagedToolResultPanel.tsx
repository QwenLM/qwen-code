import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { sanitizeControlChars } from '../messages/toolFormatting';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { ManagedToolResultSummary } from './ManagedToolResultSummary';
import type {
  ManagedArtifact,
  ManagedArtifactResponse,
  ManagedToolResult,
  ManagedToolResultReader,
} from './managed-tool-result-types';

export const MANAGED_OUTPUT_PAGE_BYTES = 64 * 1024;
const MAX_CACHE_BYTES = 4 * (MANAGED_OUTPUT_PAGE_BYTES + 3);

export function ManagedToolResultPanel({
  reader,
  sessionId,
  clientId,
  itemId,
  onClose,
}: {
  reader: ManagedToolResultReader;
  sessionId: string;
  clientId: string;
  itemId?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [result, setResult] = useState<ManagedToolResult>();
  const [artifacts, setArtifacts] = useState<ManagedArtifact[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string>();
  const pageAbort = useRef<AbortController | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [owner, setOwner] = useState({ reader, sessionId, itemId });
  const ownsContent =
    owner.reader === reader &&
    owner.sessionId === sessionId &&
    owner.itemId === itemId;

  useEffect(() => {
    const abort = new AbortController();
    const options = { clientId, signal: abort.signal };
    setOwner({ reader, sessionId, itemId });
    setLoading(true);
    setError(undefined);
    setResult(undefined);
    setArtifacts([]);
    setSelectedId(undefined);
    setNextCursor(undefined);
    void (async () => {
      if (itemId) {
        const response = await reader.getResult(sessionId, itemId, options);
        if (abort.signal.aborted) return;
        setResult(response.result);
        setArtifacts(response.result.artifacts);
        setSelectedId(response.result.artifacts[0]?.id);
      } else {
        const page = await reader.listArtifacts(sessionId, {
          ...options,
          limit: 50,
        });
        if (abort.signal.aborted) return;
        setArtifacts(page.data.map((entry) => entry.artifact));
        setSelectedId(page.data[0]?.artifact.id);
        setNextCursor(
          page.hasMore ? (page.nextCursor ?? undefined) : undefined,
        );
      }
    })()
      .catch((failure: unknown) => {
        if (!abort.signal.aborted) setError(failure);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => {
      abort.abort();
      pageAbort.current?.abort();
    };
  }, [reader, sessionId, clientId, itemId, revision]);

  const loadMore = async () => {
    if (!nextCursor || loading) return;
    const abort = new AbortController();
    pageAbort.current = abort;
    setLoading(true);
    setError(undefined);
    try {
      const page = await reader.listArtifacts(sessionId, {
        clientId,
        signal: abort.signal,
        cursor: nextCursor,
        limit: 50,
      });
      if (abort.signal.aborted) return;
      setArtifacts((current) => [
        ...new Map(
          [...current, ...page.data.map((entry) => entry.artifact)].map(
            (artifact) => [artifact.id, artifact],
          ),
        ).values(),
      ]);
      setNextCursor(page.hasMore ? (page.nextCursor ?? undefined) : undefined);
    } catch (failure) {
      if (!abort.signal.aborted) setError(failure);
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  };

  const selected = ownsContent
    ? artifacts.find((artifact) => artifact.id === selectedId)
    : undefined;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
        aria-describedby="managed-output-description"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{t('managed.result.outputs')}</DialogTitle>
          <DialogDescription id="managed-output-description">
            {t('managed.result.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setRevision((value) => value + 1);
            }}
          >
            {t('managed.result.refresh')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('managed.result.close')}
          </Button>
        </div>
        {(loading || !ownsContent) && (
          <p role="status">{t('managed.loading')}</p>
        )}
        {ownsContent && error !== undefined && <ResultError error={error} />}
        {ownsContent && result && <ManagedToolResultSummary result={result} />}
        {ownsContent && result?.preview && (
          <section aria-label={t('managed.result.preview')}>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap">
              {sanitizeControlChars(result.preview.text)}
            </pre>
            {result.preview.truncated && (
              <p>{t('managed.result.previewTruncated')}</p>
            )}
          </section>
        )}
        {ownsContent &&
          !loading &&
          error === undefined &&
          artifacts.length === 0 && <p>{t('managed.result.empty')}</p>}
        {ownsContent && artifacts.length > 0 && (
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label={t('managed.result.outputs')}
          >
            {artifacts.map((artifact) => (
              <Button
                key={artifact.id}
                variant={artifact.id === selectedId ? 'secondary' : 'outline'}
                aria-pressed={artifact.id === selectedId}
                onClick={() => setSelectedId(artifact.id)}
              >
                {artifact.stream_role} · {artifact.byte_length.toLocaleString()}{' '}
                B
              </Button>
            ))}
          </div>
        )}
        {ownsContent && nextCursor && (
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void loadMore()}
          >
            {t('managed.more')}
          </Button>
        )}
        {selected && (
          <ManagedArtifactContent
            key={`${sessionId}:${selected.id}:${selected.revision}:${revision}`}
            artifact={selected}
            reader={reader}
            clientId={clientId}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface CachedPage {
  bytes: Uint8Array;
  prefix: Uint8Array;
}

function ManagedArtifactContent({
  artifact,
  reader,
  clientId,
}: {
  artifact: ManagedArtifact;
  reader: ManagedToolResultReader;
  clientId: string;
}) {
  const { t } = useI18n();
  const [metadata, setMetadata] = useState<ManagedArtifactResponse>();
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<CachedPage>();
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [downloadError, setDownloadError] = useState<unknown>();
  const cache = useRef(new Map<number, CachedPage>());
  const lifetime = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    void reader
      .getArtifact(artifact.session_id, artifact.id, {
        clientId,
        signal: abort.signal,
      })
      .then((response) => {
        if (abort.signal.aborted) return;
        if (
          response.artifact.revision !== artifact.revision ||
          response.artifact.sha256 !== artifact.sha256
        ) {
          throw new JavaManagedAgentHttpError(
            412,
            'artifact_revision_changed',
            'Artifact revision changed',
          );
        }
        setMetadata(response);
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted) {
          setError(failure);
          setLoading(false);
        }
      });
    const pages = cache.current;
    return () => {
      abort.abort();
      pages.clear();
    };
  }, [reader, artifact, clientId]);

  useEffect(() => {
    if (!metadata) return undefined;
    const abort = new AbortController();
    setPage(undefined);
    setError(undefined);
    if (
      !metadata.access.can_read_content ||
      metadata.artifact.availability !== 'available'
    ) {
      setLoading(false);
      return () => abort.abort();
    }
    setLoading(true);
    void (async () => {
      let loaded = cache.current.get(offset);
      if (!loaded) {
        const options = { clientId, signal: abort.signal };
        const bytes =
          artifact.byte_length === 0
            ? new Uint8Array()
            : await reader.readRange(
                artifact,
                offset,
                MANAGED_OUTPUT_PAGE_BYTES,
                options,
              );
        const previous = cache.current.get(offset - MANAGED_OUTPUT_PAGE_BYTES);
        // A UTF-8 character spans at most 4 bytes, so the previous page's last
        // 3 bytes can be an incomplete character; they prime this page's
        // TextDecoder (whose output for them is discarded — those bytes were
        // already rendered with the previous page) so a character split across
        // the page boundary stays whole.
        const prefix =
          offset === 0
            ? new Uint8Array()
            : previous
              ? previous.bytes.slice(-3)
              : await reader.readRange(artifact, offset - 3, 3, options);
        loaded = { bytes, prefix };
        if (abort.signal.aborted) return;
        cache.current.set(offset, loaded);
        let total = [...cache.current.values()].reduce(
          (sum, entry) =>
            sum + entry.bytes.byteLength + entry.prefix.byteLength,
          0,
        );
        while (total > MAX_CACHE_BYTES) {
          const first = cache.current.entries().next().value;
          if (!first) break;
          total -= first[1].bytes.byteLength + first[1].prefix.byteLength;
          cache.current.delete(first[0]);
        }
      }
      if (!abort.signal.aborted) setPage(loaded);
    })()
      .catch((failure: unknown) => {
        if (!abort.signal.aborted) setError(failure);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [reader, artifact, clientId, metadata, offset]);

  const canRead =
    metadata?.access.can_read_content &&
    metadata.artifact.availability === 'available';
  const download = async () => {
    const abort = lifetime.current;
    if (!abort || abort.signal.aborted || !canRead || downloading) return;
    setDownloading(true);
    setDownloadError(undefined);
    try {
      await reader.downloadArtifact(artifact, {
        clientId,
        signal: abort.signal,
      });
    } catch (failure) {
      if (
        !abort.signal.aborted &&
        !(failure instanceof DOMException && failure.name === 'AbortError')
      )
        setDownloadError(failure);
    } finally {
      if (!abort.signal.aborted) setDownloading(false);
    }
  };

  const text = useMemo(() => {
    if (!page) return '';
    const decoder = new TextDecoder();
    decoder.decode(page.prefix, { stream: true });
    return sanitizeControlChars(
      decoder.decode(page.bytes, {
        stream: offset + page.bytes.byteLength < artifact.byte_length,
      }),
    );
  }, [page, offset, artifact.byte_length]);
  return (
    <section className="min-w-0 space-y-3" aria-label={artifact.stream_role}>
      {loading && <p role="status">{t('managed.result.reading')}</p>}
      {error !== undefined && <ResultError error={error} />}
      {metadata && !metadata.access.can_read_content && (
        <p>{t('managed.result.forbidden')}</p>
      )}
      {metadata?.artifact.availability === 'unavailable' && (
        <p>{t('managed.result.unavailable')}</p>
      )}
      {page && (
        <>
          <p className="text-xs text-muted-foreground">
            {t('managed.result.range', {
              start: offset,
              end: offset + page.bytes.byteLength,
              total: artifact.byte_length,
            })}
          </p>
          <pre
            className="max-h-[45vh] overflow-auto whitespace-pre-wrap break-all rounded border p-3"
            data-managed-output-bytes={page.bytes.byteLength}
          >
            {artifact.byte_length === 0
              ? t('managed.result.emptyStream')
              : text}
          </pre>
        </>
      )}
      {canRead && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={loading || offset === 0}
            onClick={() =>
              setOffset((value) =>
                Math.max(0, value - MANAGED_OUTPUT_PAGE_BYTES),
              )
            }
          >
            {t('managed.result.previous')}
          </Button>
          <Button
            variant="outline"
            disabled={
              loading ||
              offset + MANAGED_OUTPUT_PAGE_BYTES >= artifact.byte_length
            }
            onClick={() =>
              setOffset((value) => value + MANAGED_OUTPUT_PAGE_BYTES)
            }
          >
            {t('managed.result.next')}
          </Button>
          {reader.canDownload ? (
            <Button disabled={downloading} onClick={() => void download()}>
              {t(downloading ? 'common.downloading' : 'common.download')}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('managed.result.downloadUnsupported')}
            </p>
          )}
        </div>
      )}
      {downloadError !== undefined && <ResultError error={downloadError} />}
    </section>
  );
}

function ResultError({ error }: { error: unknown }) {
  const { t } = useI18n();
  const message =
    error instanceof JavaManagedAgentHttpError && error.status === 410
      ? t('managed.result.expired')
      : error instanceof JavaManagedAgentHttpError && error.status === 412
        ? t('managed.result.changed')
        : error instanceof JavaManagedAgentHttpError && error.status === 403
          ? t('managed.result.forbidden')
          : error instanceof Error
            ? error.message
            : String(error);
  return (
    <p role="alert" className="text-destructive">
      {message}
    </p>
  );
}
