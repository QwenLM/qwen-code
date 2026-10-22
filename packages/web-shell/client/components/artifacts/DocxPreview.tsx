import { useEffect, useRef, useState } from 'react';
import { DownloadIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
import { Button } from '../ui/button';
import {
  DOCX_MIME_TYPE,
  downloadWorkspaceFile,
  readWorkspaceFileAsBlob,
  workspaceFileName,
} from './artifactUtils';
import type { ArtifactWorkspaceActions } from './useArtifactWorkspaceTarget';

const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const FRAME_DOCUMENT = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;">
<style>html,body{margin:0;background:#eee;color:#000}body{overflow:auto}.docx-wrapper{width:max-content;min-width:100%;box-sizing:border-box}</style>
</head><body></body></html>`;

export default function DocxPreview({
  workspacePath,
  workspaceActions,
  data,
  artifactVersion,
  downloadName,
}: {
  workspacePath: string;
  workspaceActions?: Pick<ArtifactWorkspaceActions, 'readFileBytes' | 'stat'>;
  data?: Blob;
  artifactVersion?: string;
  downloadName?: string;
}) {
  const { t } = useI18n();
  const [frameDocument, setFrameDocument] = useState<Document>();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [downloadUrl, setDownloadUrl] = useState<string>();
  const [downloadError, setDownloadError] = useState<string>();
  const [downloading, setDownloading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ownerRef = useRef<object | undefined>(undefined);
  useEffect(() => {
    const owner = {};
    ownerRef.current = owner;
    if (!frameDocument) {
      return () => {
        ownerRef.current = undefined;
      };
    }
    let cancelled = false;
    let failed = false;
    let renderTimeout: ReturnType<typeof setTimeout> | undefined;
    let url: string | undefined;
    const container = frameDocument.createElement('div');
    frameDocument.body.replaceChildren(container);
    const fail = (message: string) => {
      if (cancelled || failed) return;
      failed = true;
      clearTimeout(renderTimeout);
      container.remove();
      setError(message);
    };
    setReady(false);
    setError(undefined);
    setDownloadUrl(undefined);
    setDownloadError(undefined);
    setDownloading(false);
    const load = async () => {
      const blob =
        data ??
        (await readWorkspaceFileAsBlob(
          workspaceActions!.readFileBytes,
          workspacePath,
          DOCX_MIME_TYPE,
          {
            statFile: async (path) => {
              const stat = await workspaceActions!.stat(path);
              if (stat.sizeBytes > MAX_PREVIEW_BYTES)
                throw new Error(t('docx.tooLarge'));
              return stat;
            },
            isCancelled: () => cancelled,
            maxBytes: MAX_PREVIEW_BYTES,
          },
        ));
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setDownloadUrl(url);
      if (blob.size > MAX_PREVIEW_BYTES) {
        fail(t('docx.tooLarge'));
        return;
      }
      renderTimeout = setTimeout(() => fail(t('docx.timeout')), 30000);
      const bytes = await blob.arrayBuffer();
      const { renderAsync } = await import('docx-preview');
      if (cancelled || failed) return;
      try {
        await renderAsync(bytes, container, container, {
          useBase64URL: true,
          renderAltChunks: false,
        });
      } catch {
        fail(t('docx.invalid'));
        return;
      }
      if (cancelled || failed) return;
      clearTimeout(renderTimeout);
      for (const link of container.querySelectorAll('a')) {
        const href = link.getAttribute('href');
        if (href?.startsWith('#')) {
          link.addEventListener('click', (event) => {
            event.preventDefault();
            frameDocument.getElementById(href.slice(1))?.scrollIntoView();
          });
        } else {
          link.removeAttribute('href');
        }
        link.removeAttribute('target');
      }
      setReady(true);
    };
    void load().catch((reason: unknown) => {
      fail(extractErrorDetail(reason));
    });
    return () => {
      cancelled = true;
      ownerRef.current = undefined;
      clearTimeout(renderTimeout);
      container.remove();
      if (url) URL.revokeObjectURL(url);
    };
  }, [
    frameDocument,
    data,
    workspacePath,
    workspaceActions,
    artifactVersion,
    attempt,
    t,
  ]);

  return (
    <div data-web-shell-docx-preview className="flex h-full min-h-0 flex-col">
      <div className="flex justify-end border-b border-border p-1">
        {downloadUrl ? (
          <Button variant="ghost" size="sm" asChild>
            <a
              href={downloadUrl}
              download={downloadName ?? workspaceFileName(workspacePath)}
              onClick={(event) => event.stopPropagation()}
            >
              <DownloadIcon aria-hidden="true" />
              {t('common.download')}
            </a>
          </Button>
        ) : workspaceActions ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={downloading}
            onClick={() => {
              const owner = ownerRef.current;
              const isCancelled = () => ownerRef.current !== owner;
              setDownloading(true);
              setDownloadError(undefined);
              void downloadWorkspaceFile(
                workspaceActions,
                workspacePath,
                DOCX_MIME_TYPE,
                isCancelled,
              )
                .catch((reason: unknown) => {
                  if (!isCancelled())
                    setDownloadError(extractErrorDetail(reason));
                })
                .finally(() => {
                  if (!isCancelled()) setDownloading(false);
                });
            }}
          >
            <DownloadIcon aria-hidden="true" />
            {t('common.download')}
          </Button>
        ) : null}
      </div>
      {downloadError && (
        <p role="alert" className="p-3 text-sm text-destructive">
          {downloadError}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        <iframe
          title={`Preview ${workspacePath}`}
          className="h-full w-full border-0"
          style={{ visibility: ready ? 'visible' : 'hidden' }}
          srcDoc={FRAME_DOCUMENT}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          onLoad={(event) => {
            setFrameDocument(event.currentTarget.contentDocument ?? undefined);
          }}
        />
        {error ? (
          <div role="alert" className="absolute inset-0 space-y-3 p-4 text-sm">
            <p>{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAttempt((v) => v + 1)}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : !ready ? (
          <div
            role="status"
            className="absolute inset-0 p-4 text-sm text-muted-foreground"
          >
            {t('attachment.loadingPreview')}
          </div>
        ) : null}
      </div>
    </div>
  );
}
