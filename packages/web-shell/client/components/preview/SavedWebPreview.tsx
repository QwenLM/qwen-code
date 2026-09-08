import { useEffect, useMemo, useState } from 'react';
import {
  DaemonHttpError,
  type DaemonSessionArtifact,
} from '@qwen-code/sdk/daemon';
import {
  useConnection,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { artifactPreviewDocument } from '../artifacts/artifactUtils';
import { Button } from '../ui/button';

export function SavedWebPreview({
  artifact,
  sourceSessionId,
}: {
  artifact: DaemonSessionArtifact;
  sourceSessionId?: string;
}) {
  const { t } = useI18n();
  const { client } = useWorkspace();
  const connection = useConnection();
  const sessionId = sourceSessionId ?? connection.sessionId;
  const clientId =
    sessionId === connection.sessionId ? connection.clientId : undefined;
  const [attempt, setAttempt] = useState(0);
  const [frameRevision, setFrameRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    html?: string;
    failed?: 'unavailable' | 'request';
  }>();
  const key = `${sessionId}:${artifact.id}:${attempt}`;
  useEffect(() => {
    const controller = new AbortController();
    if (!sessionId) {
      setResult({ key, failed: 'request' });
      return;
    }
    void client
      .readSessionArtifactContent(sessionId, artifact.id, {
        clientId,
        signal: controller.signal,
      })
      .then(
        (html) => {
          if (!controller.signal.aborted) setResult({ key, html });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setResult({
              key,
              failed:
                error instanceof DaemonHttpError &&
                error.status === 404 &&
                typeof error.body === 'object' &&
                error.body !== null &&
                'error' in error.body &&
                error.body.error === 'artifact_snapshot_unavailable'
                  ? 'unavailable'
                  : 'request',
            });
        },
      );
    return () => controller.abort();
  }, [artifact.id, client, clientId, key, sessionId]);
  const current = result?.key === key ? result : undefined;
  const title = t('webPreview.savedFrame');
  const previewDocument = useMemo(
    () =>
      current?.html === undefined
        ? undefined
        : artifactPreviewDocument(current.html, title),
    [current?.html, title],
  );

  return (
    <section
      className="flex h-full min-h-0 flex-col gap-3"
      data-web-shell-saved-preview
    >
      <div className="flex shrink-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>
          {t('webPreview.saved')} ·{' '}
          <time dateTime={artifact.createdAt}>
            {new Date(artifact.createdAt).toLocaleString()}
          </time>
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (current?.html !== undefined) {
              setFrameRevision((value) => value + 1);
            } else {
              setAttempt((value) => value + 1);
            }
          }}
        >
          {t(current?.failed ? 'common.retry' : 'webPreview.refresh')}
        </Button>
      </div>
      {current?.failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t(
            current.failed === 'unavailable'
              ? 'webPreview.savedUnavailable'
              : 'webPreview.savedLoadFailed',
          )}
        </p>
      ) : current?.html !== undefined ? (
        <iframe
          key={frameRevision}
          className="min-h-0 w-full flex-1 rounded-lg border border-border bg-white"
          title={t('webPreview.savedFrame')}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts"
          srcDoc={previewDocument}
        />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      )}
    </section>
  );
}
