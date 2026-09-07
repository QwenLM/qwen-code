import { useEffect, useState } from 'react';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  useConnection,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { artifactPreviewDocument } from '../artifacts/artifactUtils';

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
  const [result, setResult] = useState<{
    key: string;
    html?: string;
    failed?: boolean;
  }>();
  const key = `${sessionId}:${artifact.id}`;
  useEffect(() => {
    const controller = new AbortController();
    if (!sessionId) {
      setResult({ key, failed: true });
      return;
    }
    void client
      .readSessionArtifactContent(sessionId, artifact.id, {
        clientId: connection.clientId,
        signal: controller.signal,
      })
      .then(
        (html) => {
          if (!controller.signal.aborted) setResult({ key, html });
        },
        () => {
          if (!controller.signal.aborted) setResult({ key, failed: true });
        },
      );
    return () => controller.abort();
  }, [artifact.id, client, connection.clientId, key, sessionId]);
  const current = result?.key === key ? result : undefined;

  return (
    <section
      className="flex h-full min-h-0 flex-col gap-3"
      data-web-shell-saved-preview
    >
      <p className="shrink-0 text-xs text-muted-foreground">
        {t('webPreview.saved')} ·{' '}
        <time dateTime={artifact.createdAt}>
          {new Date(artifact.createdAt).toLocaleString()}
        </time>
      </p>
      {current?.failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t('webPreview.savedUnavailable')}
        </p>
      ) : current?.html !== undefined ? (
        <iframe
          className="min-h-0 w-full flex-1 rounded-lg border border-border bg-white"
          title={t('webPreview.savedFrame')}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts"
          srcDoc={artifactPreviewDocument(
            current.html,
            t('webPreview.savedFrame'),
          )}
        />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      )}
    </section>
  );
}
