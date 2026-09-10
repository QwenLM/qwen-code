import { useEffect, useState } from 'react';
import { LinkIcon, PlusIcon } from 'lucide-react';
import type {
  DaemonSessionAttachmentReference,
  SessionSource,
  SessionSourceInput,
} from '@qwen-code/sdk/daemon';
import type { useSessionSources } from '../../hooks/useSessionSources';
import { useI18n } from '../../i18n';
import { DialogShell } from '../dialogs/DialogShell';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { FileTypeIcon } from '../FileTypeIcon';
import { Skeleton } from '../ui/skeleton';
import type { AttachmentPreviewRequest } from '../../adapters/messageTypes';
import type { ImageTabSource } from '../artifacts/ArtifactPanel';
import styles from './EnvironmentPanel.module.css';

export type SourcesState = ReturnType<typeof useSessionSources>;

interface SourcesSectionProps {
  hidden?: boolean;
  state?: SourcesState;
  attachments?: readonly DaemonSessionAttachmentReference[];
  attachmentsLoading?: boolean;
  attachmentsError?: string;
  onRetryAttachments?: () => void;
  onOpen?: (source: SessionSource) => void;
  retryRegistration?: () => Promise<void>;
  onDialogOpenChange?: (open: boolean) => void;
  onReadImage?: (attachmentId: string) => Promise<string>;
  onImagePreview?: (src: string, alt?: string, source?: ImageTabSource) => void;
  onAttachmentPreview?: (file: AttachmentPreviewRequest) => void;
  onAttachmentPreviewError?: (error: unknown) => void;
}

export function SourcesSection({
  hidden = false,
  state,
  attachments = [],
  attachmentsLoading = false,
  attachmentsError,
  onRetryAttachments,
  onOpen,
  retryRegistration,
  onDialogOpenChange,
  onReadImage,
  onImagePreview,
  onAttachmentPreview,
  onAttachmentPreviewError,
}: SourcesSectionProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (hidden) setAdding(false);
  }, [hidden]);
  useEffect(() => {
    setAdding(false);
    setExpanded(false);
  }, [state?.owner, state?.supported]);
  useEffect(() => {
    onDialogOpenChange?.(adding && state?.supported === true);
    return () => onDialogOpenChange?.(false);
  }, [adding, onDialogOpenChange, state?.supported]);
  const sources = state?.supported ? state.sources : [];
  const attachmentIds = new Set(
    sources.flatMap((source) =>
      source.locator.type === 'attachment' ? [source.locator.attachmentId] : [],
    ),
  );
  const entries: Array<
    | { type: 'source'; source: SessionSource }
    | { type: 'attachment'; attachment: DaemonSessionAttachmentReference }
  > = sources.map((source) => ({ type: 'source', source }));
  for (const attachment of attachments) {
    if (attachmentIds.has(attachment.attachmentId)) continue;
    attachmentIds.add(attachment.attachmentId);
    entries.push({ type: 'attachment', attachment });
  }
  if (
    !state?.supported &&
    !entries.length &&
    !attachmentsLoading &&
    !attachmentsError
  )
    return null;
  const loading = attachmentsLoading || (state?.supported && state.loading);
  return (
    <section
      className={styles.section}
      aria-label={t('sources.title')}
      data-testid="sources-section"
    >
      <div className={styles.sectionHeaderRow}>
        <h3 className={`${styles.sectionHeader} ${styles.sourceTitle}`}>
          {t('sources.title')}{' '}
          <span className="text-muted-foreground">{entries.length}</span>
        </h3>
        {state?.supported && (
          <button
            type="button"
            className={styles.sectionAction}
            aria-label={t('sources.add')}
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
          </button>
        )}
      </div>
      {retryRegistration && (
        <div className={styles.emptyDescription} role="alert">
          {t('sources.registrationFailed')}{' '}
          <Button
            size="sm"
            variant="link"
            onClick={() => void retryRegistration()}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      {state?.supported && state.error && (
        <div className="mt-2 text-xs text-destructive" role="alert">
          {state.error}{' '}
          <Button size="sm" variant="link" onClick={() => void state.refresh()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {attachmentsError && (
        <div className="mt-2 text-xs text-destructive" role="alert">
          {t('sources.attachmentsLoadFailed', { error: attachmentsError })}{' '}
          <Button size="sm" variant="link" onClick={onRetryAttachments}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      <ul className={styles.attachmentFiles}>
        {(expanded ? entries : entries.slice(0, 3)).map((entry) =>
          entry.type === 'source' ? (
            <li key={`source:${entry.source.id}`}>
              <button
                type="button"
                className={styles.attachmentFile}
                title={sourceLocation(entry.source)}
                onClick={() => onOpen?.(entry.source)}
                aria-label={`${t('sources.open')} ${entry.source.title}`}
              >
                {entry.source.kind === 'link' ? (
                  <LinkIcon
                    size={16}
                    strokeWidth={1.7}
                    className={styles.attachmentFileIcon}
                  />
                ) : (
                  <FileTypeIcon
                    name={sourceLocation(entry.source)}
                    size={16}
                    strokeWidth={1.7}
                    className={styles.attachmentFileIcon}
                    aria-hidden="true"
                  />
                )}
                <span className={styles.attachmentFileName}>
                  {entry.source.title}
                </span>
              </button>
            </li>
          ) : (
            <li key={`attachment:${entry.attachment.attachmentId}`}>
              <AttachmentRow
                attachment={entry.attachment}
                onReadImage={onReadImage}
                onImagePreview={onImagePreview}
                onAttachmentPreview={onAttachmentPreview}
                onPreviewError={onAttachmentPreviewError}
              />
            </li>
          ),
        )}
      </ul>
      {loading && !entries.length && (
        <ul
          className={styles.attachmentFiles}
          data-testid="environment-file-list-skeleton"
          role="status"
          aria-label={t('common.loading')}
        >
          {[72, 88, 64].map((width) => (
            <li key={width} className={styles.attachmentFile}>
              <Skeleton className="size-4 shrink-0 rounded-sm" />
              <Skeleton className="h-4" style={{ width: `${width}%` }} />
            </li>
          ))}
        </ul>
      )}
      {!loading &&
        !entries.length &&
        state?.hydrated &&
        !state.error &&
        !attachmentsError && (
          <p className={styles.emptyDescription}>{t('sources.empty')}</p>
        )}
      {entries.length > 3 && (
        <button
          type="button"
          className={styles.attachmentFile}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {t(expanded ? 'common.collapse' : 'sources.viewAll')}
        </button>
      )}
      {adding && state?.supported && (
        <AddSourceDialog state={state} onClose={() => setAdding(false)} />
      )}
    </section>
  );
}

export function sourceLocation(source: SessionSource): string {
  switch (source.locator.type) {
    case 'workspace_file':
      return source.locator.workspacePath;
    case 'attachment':
      return source.locator.attachmentId;
    case 'url':
      return source.locator.url;
  }
}

function AddSourceDialog({
  state,
  onClose,
}: {
  state: SourcesState;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [type, setType] = useState<'workspace_file' | 'url'>('workspace_file');
  const [locator, setLocator] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const resolved =
        type === 'url'
          ? new URL(locator).hostname
          : locator.split(/[\\/]/).at(-1) || locator;
      const sourceLocator: SessionSourceInput['locator'] =
        type === 'workspace_file'
          ? { type, workspacePath: locator }
          : { type, url: locator };
      await state.upsert({
        title: title.trim() || resolved.trim().slice(0, 200),
        locator: sourceLocator,
        ...(description ? { description } : {}),
      });
      if (state.owner.isCurrent()) onClose();
    } catch (err) {
      if (state.owner.isCurrent())
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (state.owner.isCurrent()) setBusy(false);
    }
  };
  return (
    <DialogShell
      title={t('sources.add')}
      subtitle={t('sources.explanation')}
      onClose={onClose}
      size="sm"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          {t('sources.type')}
          <select
            className="h-8 rounded-lg border border-input bg-background px-2"
            value={type}
            onChange={(event) => {
              setType(event.target.value as typeof type);
              setLocator('');
              setError(undefined);
            }}
          >
            <option value="workspace_file">{t('sources.workspaceFile')}</option>
            <option value="url">{t('sources.link')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('sources.location')}
          <Input
            value={locator}
            onChange={(event) => setLocator(event.target.value)}
            required
            maxLength={type === 'url' ? 2048 : 500}
            placeholder={
              type === 'url' ? 'https://example.com' : 'docs/requirements.md'
            }
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('sources.name')}
          <Input
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('sources.description')}
          <Input
            value={description}
            maxLength={1000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        {error && (
          <div role="alert" className="text-xs text-destructive">
            {error}
          </div>
        )}
        <Button type="submit" disabled={busy || !locator}>
          {t('sources.add')}
        </Button>
      </form>
    </DialogShell>
  );
}

function AttachmentRow({
  attachment,
  onReadImage,
  onImagePreview,
  onAttachmentPreview,
  onPreviewError,
}: {
  attachment: DaemonSessionAttachmentReference;
  onReadImage?: (attachmentId: string) => Promise<string>;
  onImagePreview?: (src: string, alt?: string, source?: ImageTabSource) => void;
  onAttachmentPreview?: (file: AttachmentPreviewRequest) => void;
  onPreviewError?: (error: unknown) => void;
}) {
  const isImage = attachment.type === 'image';
  const openPreview = () => {
    if (isImage) {
      const source: ImageTabSource = {
        kind: 'attachment',
        attachmentId: attachment.attachmentId,
      };
      void onReadImage?.(attachment.attachmentId)
        .then((dataUrl) => {
          onImagePreview?.(dataUrl, attachment.attachmentId, source);
        })
        .catch((error: unknown) => onPreviewError?.(error));
      return;
    }
    onAttachmentPreview?.({
      name: attachment.attachmentId,
      mimeType: attachment.mimeType,
      attachmentId: attachment.attachmentId,
    });
  };
  return (
    <button
      type="button"
      className={styles.attachmentFile}
      title={attachment.attachmentId}
      onClick={openPreview}
    >
      <FileTypeIcon
        name={attachment.attachmentId}
        mimeType={attachment.mimeType}
        size={16}
        strokeWidth={1.7}
        className={styles.attachmentFileIcon}
        aria-hidden="true"
      />
      <span className={styles.attachmentFileName}>
        {attachment.attachmentId}
      </span>
    </button>
  );
}
