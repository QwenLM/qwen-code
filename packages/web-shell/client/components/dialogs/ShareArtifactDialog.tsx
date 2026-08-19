import { useEffect, useRef, useState } from 'react';
import type {
  DaemonArtifactCredentialSource,
  DaemonArtifactPublishConfig,
} from '@qwen-code/sdk/daemon';
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

export type ShareArtifactActions = Pick<
  DaemonWorkspaceActions,
  'artifactPublishConfig' | 'publishArtifact'
>;

interface ShareArtifactDialogProps {
  workspacePath: string;
  title: string;
  workspaceActions: ShareArtifactActions;
  onClose: () => void;
}

/** Sources that mean the daemon can already authenticate without typed keys. */
function hasUsableCredentials(
  source: DaemonArtifactCredentialSource | undefined,
): boolean {
  return source !== undefined && source !== 'none' && source !== 'request';
}

export function ShareArtifactDialog({
  workspacePath,
  title,
  workspaceActions,
  onClose,
}: ShareArtifactDialogProps) {
  const { t } = useI18n();
  const [config, setConfig] = useState<DaemonArtifactPublishConfig | null>(
    null,
  );
  const [endpoint, setEndpoint] = useState('');
  const [bucket, setBucket] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [accessKeySecret, setAccessKeySecret] = useState('');
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<{
    url: string;
    reachable?: boolean | null;
    reachableStatus?: number;
  } | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    // StrictMode replays setup -> cleanup -> setup without re-running useRef's
    // initializer, so restore the flag or every upload looks abandoned.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    workspaceActions
      .artifactPublishConfig()
      .then((loaded) => {
        if (!mountedRef.current) return;
        setConfig(loaded);
        setEndpoint(loaded.endpoint);
        setBucket(loaded.bucket);
        setPublicBaseUrl(loaded.publicBaseUrl);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        setError(t('share.configFailed', { message: extractErrorDetail(err) }));
      });
  }, [t, workspaceActions]);

  const credentialsDetected = hasUsableCredentials(config?.credentialsSource);
  const typedCredentials = Boolean(
    accessKeyId.trim() && accessKeySecret.trim(),
  );

  const upload = async () => {
    if (!endpoint.trim() || !bucket.trim()) {
      setError(t('share.destinationRequired'));
      return;
    }
    if (!credentialsDetected && !typedCredentials) {
      setError(t('share.credentialsRequired'));
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const published = await workspaceActions.publishArtifact({
        path: workspacePath,
        title,
        config: {
          endpoint: endpoint.trim(),
          bucket: bucket.trim(),
          publicBaseUrl: publicBaseUrl.trim(),
          ...(typedCredentials
            ? {
                accessKeyId: accessKeyId.trim(),
                accessKeySecret: accessKeySecret.trim(),
              }
            : {}),
        },
        remember: 'memory',
      });
      if (!mountedRef.current) return;
      setResult({
        url: published.url,
        reachable: published.reachable,
        ...(published.reachableStatus !== undefined
          ? { reachableStatus: published.reachableStatus }
          : {}),
      });
    } catch (err) {
      if (!mountedRef.current) return;
      setError(t('share.failed', { message: extractErrorDetail(err) }));
    } finally {
      if (mountedRef.current) setUploading(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
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
      {result ? (
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
                value={result.url}
                onFocus={(event) => event.currentTarget.select()}
              />
              <FieldDescription data-share-reachability>
                {result.reachable === true
                  ? t('share.reachableYes')
                  : result.reachable === false
                    ? t('share.reachableNo', {
                        status: result.reachableStatus ?? '',
                      })
                    : t('share.reachableUnknown')}
              </FieldDescription>
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
      ) : (
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            void upload();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="share-endpoint">
                {t('share.endpointLabel')}
              </FieldLabel>
              <Input
                id="share-endpoint"
                type="text"
                placeholder="oss-cn-hangzhou.aliyuncs.com"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                disabled={uploading}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="share-bucket">
                {t('share.bucketLabel')}
              </FieldLabel>
              <Input
                id="share-bucket"
                type="text"
                value={bucket}
                onChange={(event) => setBucket(event.target.value)}
                disabled={uploading}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="share-access-key-id">
                {t('share.accessKeyIdLabel')}
              </FieldLabel>
              <Input
                id="share-access-key-id"
                type="text"
                value={accessKeyId}
                onChange={(event) => setAccessKeyId(event.target.value)}
                disabled={uploading}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="share-access-key-secret">
                {t('share.accessKeySecretLabel')}
              </FieldLabel>
              <Input
                id="share-access-key-secret"
                type="password"
                value={accessKeySecret}
                onChange={(event) => setAccessKeySecret(event.target.value)}
                disabled={uploading}
                autoComplete="off"
              />
              <FieldDescription
                className="text-xs"
                data-share-credential-status
              >
                {credentialsDetected
                  ? t(`share.credentialsFrom.${config?.credentialsSource}`)
                  : t('share.credentialsHint')}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="share-public-base-url">
                {t('share.publicBaseUrlLabel')}
              </FieldLabel>
              <Input
                id="share-public-base-url"
                type="text"
                placeholder="https://share.example.com"
                value={publicBaseUrl}
                onChange={(event) => setPublicBaseUrl(event.target.value)}
                disabled={uploading}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
              <FieldDescription
                className="text-xs"
                data-share-public-base-url-hint
              >
                {t('share.publicBaseUrlHint')}
              </FieldDescription>
            </Field>
          </FieldGroup>

          <FieldDescription className="text-xs" data-share-storage-note>
            {t('share.storageNote')}
          </FieldDescription>

          {error && <FieldError>{error}</FieldError>}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={uploading}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={uploading}>
              {t(uploading ? 'share.uploading' : 'share.upload')}
            </Button>
          </div>
        </form>
      )}
    </DialogShell>
  );
}
