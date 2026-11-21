import { useEffect, useRef, useState } from 'react';
import {
  getDocument,
  PDFDataRangeTransport,
  PDFWorker,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import jbig2Url from 'pdfjs-dist/wasm/jbig2.wasm?url';
import openJpegUrl from 'pdfjs-dist/wasm/openjpeg.wasm?url';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
import { Button } from '../ui/button';
import type { ArtifactWorkspaceActions } from './useArtifactWorkspaceTarget';
import PdfWorker from './pdf-preview.worker?worker&inline';

const CHUNK_BYTES = 256 * 1024;

export default function WorkspacePdfRangePreview({
  workspacePath,
  workspaceActions,
  initialStat,
  onOpenFull,
}: {
  workspacePath: string;
  workspaceActions: Pick<ArtifactWorkspaceActions, 'stat' | 'readFileBytes'>;
  initialStat: { sizeBytes: number; modifiedMs: number };
  onOpenFull: () => void;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [readyPage, setReadyPage] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    let port: Worker | undefined;
    let worker: PDFWorker | undefined;
    let loading: ReturnType<typeof getDocument> | undefined;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (loading) {
        void loading
          .destroy()
          .catch(() => undefined)
          .finally(() => {
            worker?.destroy();
            port?.terminate();
          });
      } else {
        worker?.destroy();
        port?.terminate();
      }
    };
    const fail = (reason: unknown) => {
      if (disposed) return;
      setError(extractErrorDetail(reason));
      dispose();
    };

    class PdfResources {
      async fetch({ kind, filename }: { kind: string; filename: string }) {
        if (kind === 'cMapUrl') {
          const error = new Error(t('pdf.externalFontMap'));
          fail(error);
          throw error;
        }
        const url =
          kind === 'wasmUrl' &&
          (filename === 'jbig2.wasm'
            ? jbig2Url
            : filename === 'openjpeg.wasm'
              ? openJpegUrl
              : undefined);
        if (!url) throw new Error(`PDF resource is unavailable: ${filename}`);
        const response = await fetch(url);
        if (!response.ok)
          throw new Error(`Could not load PDF resource: ${filename}`);
        return new Uint8Array(await response.arrayBuffer());
      }
    }

    const { sizeBytes, modifiedMs } = initialStat;

    async function readRange(begin: number, end: number) {
      const bytes = new Uint8Array(end - begin);
      for (let offset = begin; offset < end; offset += CHUNK_BYTES) {
        if (disposed) return;
        const maxBytes = Math.min(CHUNK_BYTES, end - offset);
        const file = await workspaceActions.readFileBytes(workspacePath, {
          offset,
          maxBytes,
        });
        if (disposed) return;
        const binary = atob(file.contentBase64);
        if (
          file.sizeBytes !== sizeBytes ||
          file.offset !== offset ||
          file.returnedBytes !== maxBytes ||
          binary.length !== maxBytes
        ) {
          throw new Error(t('pdf.fileChanged'));
        }
        for (let index = 0; index < binary.length; index++) {
          bytes[offset - begin + index] = binary.charCodeAt(index);
        }
      }
      if (disposed) return;
      const stat = await workspaceActions.stat(workspacePath);
      if (stat.sizeBytes !== sizeBytes || stat.modifiedMs !== modifiedMs) {
        throw new Error(t('pdf.fileChanged'));
      }
      if (!disposed) range.onDataRange(begin, bytes);
    }

    const range = new PDFDataRangeTransport(sizeBytes, null);
    range.requestDataRange = (begin, end) => {
      if (!disposed) void readRange(begin, end).catch(fail);
    };

    setDocument(undefined);
    setPage(1);
    setReadyPage(0);
    setError(undefined);
    try {
      port = new PdfWorker();
      const failWorker = () => {
        fail(new Error(t('pdf.workerFailed')));
        worker?.destroy();
        port?.terminate();
      };
      port.addEventListener('error', failWorker, { once: true });
      port.addEventListener('messageerror', failWorker, { once: true });
      worker = PDFWorker.create({ port });
      loading = getDocument({
        range,
        worker,
        rangeChunkSize: CHUNK_BYTES,
        disableAutoFetch: true,
        disableStream: true,
        BinaryDataFactory: PdfResources,
        stopAtErrors: true,
      });
      void loading.promise.then((loaded) => {
        if (!disposed) setDocument(loaded);
      }, fail);
    } catch (reason) {
      fail(reason);
    }
    return dispose;
  }, [workspacePath, workspaceActions, initialStat, t]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!document || !canvas) return;
    let cancelled = false;
    let render: RenderTask | undefined;
    void (async () => {
      const pdfPage = await document.getPage(page);
      if (cancelled) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({
        scale: Math.min(2, 1600 / Math.max(base.width, base.height)),
      });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      render = pdfPage.render({ canvas, viewport });
      await render.promise;
      pdfPage.cleanup();
      if (!cancelled) setReadyPage(page);
    })().catch((reason: unknown) => {
      if (!cancelled)
        setError((current) => current ?? extractErrorDetail(reason));
    });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [document, page]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-1 border-b border-border p-1">
        {document && !error && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={page === 1 || readyPage !== page}
              onClick={() => setPage(page - 1)}
            >
              {t('pdf.previousPage')}
            </Button>
            <span className="text-sm" aria-live="polite">
              {page} / {document.numPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page === document.numPages || readyPage !== page}
              onClick={() => setPage(page + 1)}
            >
              {t('pdf.nextPage')}
            </Button>
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={onOpenFull}>
          {t('pdf.openFull')}
        </Button>
      </div>
      {error ? (
        <div role="alert" className="p-4 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {readyPage !== page && (
            <div className="p-4 text-sm" role="status">
              {t('attachment.loadingPreview')}
            </div>
          )}
          <canvas
            key={page}
            ref={canvasRef}
            className="mx-auto block h-auto max-w-full"
            hidden={readyPage !== page}
            aria-label={t('pdf.page', { page })}
          />
        </div>
      )}
    </div>
  );
}
