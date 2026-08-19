import { useEffect, useRef, useState } from 'react';
import type { DaemonWorkspaceActions } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
import { DialogShell } from './DialogShell';
import { Button } from '../ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../ui/field';
import { Input } from '../ui/input';
import {
  parseShareEndpoint,
  publishHtmlArtifact,
  readShareTarget,
  storeShareTarget,
  type ShareTarget,
} from '../artifacts/shareArtifact';

const ENDPOINT_HINT_ID = 'share-endpoint-hint';
const ENDPOINT_ERROR_ID = 'share-endpoint-error';
const TOKEN_HINT_ID = 'share-token-hint';

interface ShareArtifactDialogProps {
  workspacePath: string;
  title: string;
  workspaceActions: Pick<DaemonWorkspaceActions, 'readFileBytes' | 'stat'>;
  onClose: () => void;
}

export function ShareArtifactDialog({
  workspacePath,
  title,
  workspaceActions,
  onClose,
}: ShareArtifactDialogProps) {
  const { t } = useI18n();
  const [target, setTarget] = useState<ShareTarget | undefined>(
    readShareTarget,
  );
  const [editing, setEditing] = useState(target === undefined);
  const [endpointInput, setEndpointInput] = useState(target?.endpoint ?? '');
  const [tokenInput, setTokenInput] = useState(target?.token ?? '');
  const [sharing, setSharing] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    // StrictMode replays setup -> cleanup -> setup without re-running useRef's
    // initializer, so restore the flag or every upload looks cancelled.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const publish = async (activeTarget: ShareTarget) => {
    setSharing(true);
    setError(null);
    try {
      const url = await publishHtmlArtifact(
        workspaceActions,
        workspacePath,
        activeTarget,
        () => !mountedRef.current,
      );
      if (!mountedRef.current) return;
      setShareUrl(url);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(t('share.failed', { message: extractErrorDetail(err) }));
    } finally {
      if (mountedRef.current) setSharing(false);
    }
  };

  const saveAndShare = () => {
    const endpoint = parseShareEndpoint(endpointInput);
    if (!endpoint) {
      setError(t('share.endpointInvalid'));
      return;
    }
    const next: ShareTarget = {
      endpoint,
      token: tokenInput.trim() || undefined,
    };
    storeShareTarget(next);
    setTarget(next);
    setEditing(false);
    void publish(next);
  };

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      if (mountedRef.current) setCopied(true);
    } catch {
      // Clipboard access can be blocked; the URL stays selectable in the field.
    }
  };

  return (
    <DialogShell
      title={t('share.title')}
      subtitle={title}
      size="md"
      onClose={onClose}
    >
      {shareUrl ? (
        <div className="flex flex-col gap-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="share-result-url">
                {t('share.resultLabel')}
              </FieldLabel>
              <Input
                id="share-result-url"
                type="text"
                readOnly
                value={shareUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
              <FieldDescription>{t('share.resultHint')}</FieldDescription>
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => void copy()}>
              {t(copied ? 'share.copied' : 'common.copy')}
            </Button>
            <Button type="button" onClick={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </div>
      ) : editing ? (
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            saveAndShare();
          }}
        >
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="share-endpoint">
                {t('share.endpointLabel')}
              </FieldLabel>
              <Input
                id="share-endpoint"
                type="text"
                placeholder="https://example.com/publish"
                value={endpointInput}
                onChange={(event) => {
                  setEndpointInput(event.target.value);
                  if (error) setError(null);
                }}
                disabled={sharing}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={
                  error
                    ? `${ENDPOINT_ERROR_ID} ${ENDPOINT_HINT_ID}`
                    : ENDPOINT_HINT_ID
                }
                aria-invalid={error ? true : undefined}
              />
              <FieldDescription id={ENDPOINT_HINT_ID}>
                {t('share.endpointHint')}
              </FieldDescription>
              {error && <FieldError id={ENDPOINT_ERROR_ID}>{error}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="share-token">
                {t('share.tokenLabel')}
              </FieldLabel>
              <Input
                id="share-token"
                type="password"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                disabled={sharing}
                autoComplete="off"
                aria-describedby={TOKEN_HINT_ID}
              />
              <FieldDescription id={TOKEN_HINT_ID}>
                {t('share.tokenHint')}
              </FieldDescription>
            </Field>
          </FieldGroup>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={sharing}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={sharing}>
              {t(sharing ? 'share.sharing' : 'share.saveAndShare')}
            </Button>
          </div>
        </form>
      ) : (
        target && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <p className="text-sm">{t('share.confirmWarning')}</p>
              <p className="break-all text-sm text-muted-foreground">
                {target.endpoint}
              </p>
            </div>
            {error && <FieldError>{error}</FieldError>}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setError(null);
                  setEditing(true);
                }}
                disabled={sharing}
              >
                {t('share.reconfigure')}
              </Button>
              <Button
                type="button"
                onClick={() => void publish(target)}
                disabled={sharing}
              >
                {t(sharing ? 'share.sharing' : 'share.action')}
              </Button>
            </div>
          </div>
        )
      )}
    </DialogShell>
  );
}
