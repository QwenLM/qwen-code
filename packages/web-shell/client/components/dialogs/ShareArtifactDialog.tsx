import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonArtifactProviderSetupStage,
  DaemonArtifactProviderSetupStatus,
  DaemonArtifactPublishConfig,
  DaemonArtifactPublishProviderKind,
  DaemonArtifactPublishResult,
} from '@qwen-code/sdk/daemon';
import type { DaemonWorkspaceActions } from '@qwen-code/webui/daemon-react-sdk';
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckBigIcon,
  CopyIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  RocketIcon,
  ServerIcon,
  Share2Icon,
  SquareIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
import { DialogShell } from './DialogShell';
import { Button } from '../ui/button';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { Spinner } from '../ui/spinner';

export type ShareArtifactActions = Pick<
  DaemonWorkspaceActions,
  'artifactPublishConfig' | 'setupArtifactProvider' | 'publishArtifact'
>;

interface ShareArtifactDialogProps {
  workspacePath: string;
  title: string;
  workspaceActions: ShareArtifactActions;
  onClose: () => void;
}

const QUICK_PROVIDERS: DaemonArtifactPublishProviderKind[] = [
  'cloudflare',
  'vercel',
  'netlify',
];
const PROVIDERS: DaemonArtifactPublishProviderKind[] = [
  ...QUICK_PROVIDERS,
  'oss',
];
const SETUP_STAGES: DaemonArtifactProviderSetupStage[] = [
  'install',
  'authenticate',
  'connect',
  'ready',
];

type ArtifactShareConfig = DaemonArtifactPublishConfig & {
  setups: Record<
    DaemonArtifactPublishProviderKind,
    DaemonArtifactProviderSetupStatus
  >;
};

function fallbackSetup(
  provider: DaemonArtifactPublishProviderKind,
  ready: boolean,
): DaemonArtifactProviderSetupStatus {
  return {
    provider,
    stage: ready ? 'ready' : 'install',
    cliInstalled: ready,
    authenticated: ready,
    linked: ready,
    configured: ready,
  };
}

function normalizeConfig(
  config: DaemonArtifactPublishConfig,
): ArtifactShareConfig {
  const legacy = config.setup as
    | (DaemonArtifactProviderSetupStatus & {
        linkedSite?: DaemonArtifactProviderSetupStatus['project'];
      })
    | undefined;
  const setups = Object.fromEntries(
    PROVIDERS.map((provider) => {
      const ready =
        config.providers?.some(
          (item) => item.kind === provider && item.configured,
        ) ?? false;
      const setup =
        config.setups?.[provider] ??
        (provider === 'netlify' && legacy
          ? {
              ...legacy,
              provider: 'netlify' as const,
              project: legacy.project ?? legacy.linkedSite,
            }
          : fallbackSetup(provider, ready));
      return [provider, setup];
    }),
  ) as ArtifactShareConfig['setups'];
  return { ...config, setups };
}

function formatPublishedAt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

function SetupProgress({
  stage,
  hasError,
  provider,
}: {
  stage: DaemonArtifactProviderSetupStage;
  hasError: boolean;
  provider: DaemonArtifactPublishProviderKind;
}) {
  const { t } = useI18n();
  const current = SETUP_STAGES.indexOf(stage);
  return (
    <ol
      className="grid grid-cols-4 gap-1"
      aria-label={t('share.progress')}
      data-share-progress
      data-share-netlify-progress
    >
      {SETUP_STAGES.map((item, index) => {
        const complete = index < current || stage === 'ready';
        const active = index === current && stage !== 'ready';
        const failed = active && hasError;
        return (
          <li
            key={item}
            className="relative flex min-w-0 flex-col items-center gap-2 text-center"
            data-share-step={item}
            data-share-netlify-step={item}
            data-state={
              complete
                ? 'complete'
                : failed
                  ? 'error'
                  : active
                    ? 'active'
                    : 'pending'
            }
          >
            {index > 0 && (
              <span
                className={`absolute right-1/2 top-3 h-px w-full ${
                  index <= current ? 'bg-primary' : 'bg-border'
                }`}
              />
            )}
            <span
              className={`relative z-10 flex size-6 items-center justify-center rounded-full border text-xs ${
                complete
                  ? 'border-primary bg-primary text-primary-foreground'
                  : failed
                    ? 'border-destructive bg-background text-destructive'
                    : active
                      ? 'border-primary bg-background text-primary'
                      : 'border-border bg-background text-muted-foreground'
              }`}
            >
              {complete ? <CheckIcon className="size-3.5" /> : index + 1}
            </span>
            <span
              className={`truncate text-xs ${
                active || complete || failed
                  ? 'text-foreground'
                  : 'text-muted-foreground'
              }`}
            >
              {t(
                provider === 'oss'
                  ? `share.oss.stage.${item}`
                  : `share.stage.${item}`,
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function ShareArtifactDialog({
  workspacePath,
  title,
  workspaceActions,
  onClose,
}: ShareArtifactDialogProps) {
  const { t } = useI18n();
  const [selectedProvider, setSelectedProvider] =
    useState<DaemonArtifactPublishProviderKind>('cloudflare');
  const [config, setConfig] = useState<ArtifactShareConfig | null>(null);
  const [checkingConfig, setCheckingConfig] = useState(true);
  const [setupBusy, setSetupBusy] = useState(false);
  const [pollingProvider, setPollingProvider] =
    useState<DaemonArtifactPublishProviderKind | null>(null);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<
    Partial<Record<DaemonArtifactPublishProviderKind, string>>
  >({});
  const [configError, setConfigError] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [result, setResult] = useState<DaemonArtifactPublishResult | null>(
    null,
  );
  const [ossForm, setOssForm] = useState({
    endpoint: '',
    bucket: '',
    publicBaseUrl: '',
    keyPrefix: 'artifacts',
    accessKeyId: '',
    accessKeySecret: '',
    securityToken: '',
  });

  const mountedRef = useRef(true);
  const activeOperationRef = useRef<AbortController | null>(null);
  const authorizationWindowRef = useRef<Window | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeOperationRef.current?.abort();
      authorizationWindowRef.current?.close();
    };
  }, []);

  const stopActiveOperation = useCallback(() => {
    activeOperationRef.current?.abort();
    activeOperationRef.current = null;
    authorizationWindowRef.current?.close();
    authorizationWindowRef.current = null;
    setSetupBusy(false);
    setPollingProvider(null);
    setUploading(false);
  }, []);

  const handleClose = useCallback(() => {
    stopActiveOperation();
    onClose();
  }, [onClose, stopActiveOperation]);

  const setCurrentError = useCallback(
    (message?: string) => {
      setErrors((current) => ({
        ...current,
        [selectedProvider]: message,
      }));
    },
    [selectedProvider],
  );

  const applyConfig = useCallback((loaded: DaemonArtifactPublishConfig) => {
    setConfig((current) => {
      const normalized = normalizeConfig(loaded);
      return !normalized.publications && current?.publications
        ? { ...normalized, publications: current.publications }
        : normalized;
    });
  }, []);

  const loadConfig = useCallback(async () => {
    setCheckingConfig(true);
    setConfigError(false);
    try {
      const loaded =
        await workspaceActions.artifactPublishConfig(workspacePath);
      if (!mountedRef.current) return;
      applyConfig(loaded);
      setPollingProvider(null);
      setErrors({});
    } catch (err) {
      if (!mountedRef.current) return;
      setConfig(null);
      setConfigError(true);
      const message = t('share.configFailed', {
        message: extractErrorDetail(err),
      });
      setErrors({
        cloudflare: message,
        vercel: message,
        netlify: message,
        oss: message,
      });
    } finally {
      if (mountedRef.current) setCheckingConfig(false);
    }
  }, [applyConfig, t, workspaceActions, workspacePath]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const ossTarget = config?.setups.oss?.oss;
  useEffect(() => {
    if (!ossTarget) return;
    setOssForm((current) => ({
      ...current,
      endpoint: ossTarget.endpoint,
      bucket: ossTarget.bucket,
      publicBaseUrl: ossTarget.publicBaseUrl,
      keyPrefix: ossTarget.keyPrefix || 'artifacts',
    }));
  }, [ossTarget]);

  useEffect(() => {
    if (!pollingProvider) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const controller = new AbortController();
    activeOperationRef.current?.abort();
    activeOperationRef.current = controller;
    const checkAuthorization = async () => {
      try {
        const checked = await workspaceActions.setupArtifactProvider(
          pollingProvider,
          { action: 'poll' },
          { signal: controller.signal },
        );
        if (cancelled || controller.signal.aborted || !mountedRef.current) {
          return;
        }
        applyConfig(checked);
        if (checked.setup.authorizationPending) {
          timer = window.setTimeout(checkAuthorization, 2_500);
          return;
        }
        setPollingProvider(null);
        setConfigError(false);
      } catch {
        if (cancelled || controller.signal.aborted || !mountedRef.current) {
          return;
        }
        setPollingProvider(null);
        setErrors((current) => ({
          ...current,
          [pollingProvider]: t('share.setupFailed'),
        }));
      }
    };
    timer = window.setTimeout(checkAuthorization, 2_500);
    return () => {
      cancelled = true;
      controller.abort();
      if (activeOperationRef.current === controller) {
        activeOperationRef.current = null;
      }
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyConfig, pollingProvider, t, workspaceActions]);

  const setup = config?.setups[selectedProvider];
  const currentError = errors[selectedProvider];
  const providerName = t(`share.provider.${selectedProvider}`);
  const polling = pollingProvider === selectedProvider;
  const publication = config?.publications?.[selectedProvider];
  const publicationState = publication
    ? publication.upToDate
      ? 'current'
      : 'stale'
    : 'unpublished';
  const publicationPublishedAt = formatPublishedAt(publication?.publishedAt);

  const startSetup = async (accountId?: string) => {
    const controller = new AbortController();
    activeOperationRef.current?.abort();
    activeOperationRef.current = controller;
    const authWindow =
      selectedProvider === 'netlify' && !setup?.authenticated
        ? window.open(
            '',
            'qwen-netlify-authorization',
            'popup,width=720,height=760',
          )
        : null;
    if (authWindow) {
      authWindow.opener = null;
      authorizationWindowRef.current = authWindow;
    }
    setSetupBusy(true);
    setCurrentError();
    setConfigError(false);
    try {
      const prepared = await workspaceActions.setupArtifactProvider(
        selectedProvider,
        {
          action: accountId ? 'connect' : 'prepare',
          ...(accountId ? { accountId } : {}),
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || !mountedRef.current) {
        authWindow?.close();
        return;
      }
      let authorizationOpened = true;
      if (prepared.authorizationUrl) {
        if (authWindow) {
          authWindow.location.href = prepared.authorizationUrl;
        } else {
          authorizationOpened = Boolean(
            window.open(
              prepared.authorizationUrl,
              '_blank',
              'noopener,noreferrer',
            ),
          );
        }
        if (!authorizationOpened) setCurrentError(t('share.popupBlocked'));
      } else {
        authWindow?.close();
      }
      applyConfig(prepared);
      if (prepared.setup.authorizationPending && authorizationOpened) {
        setPollingProvider(selectedProvider);
      }
    } catch {
      authWindow?.close();
      if (controller.signal.aborted || !mountedRef.current) return;
      setCurrentError(t('share.setupFailed'));
    } finally {
      if (activeOperationRef.current === controller) {
        activeOperationRef.current = null;
        if (mountedRef.current) setSetupBusy(false);
      }
    }
  };

  const configureOss = async () => {
    const controller = new AbortController();
    activeOperationRef.current?.abort();
    activeOperationRef.current = controller;
    setSetupBusy(true);
    setCurrentError();
    setConfigError(false);
    try {
      const prepared = await workspaceActions.setupArtifactProvider(
        'oss',
        {
          action: 'connect',
          endpoint: ossForm.endpoint,
          bucket: ossForm.bucket,
          publicBaseUrl: ossForm.publicBaseUrl,
          keyPrefix: ossForm.keyPrefix,
          ...(ossForm.accessKeyId ? { accessKeyId: ossForm.accessKeyId } : {}),
          ...(ossForm.accessKeySecret
            ? { accessKeySecret: ossForm.accessKeySecret }
            : {}),
          ...(ossForm.securityToken
            ? { securityToken: ossForm.securityToken }
            : {}),
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || !mountedRef.current) return;
      applyConfig(prepared);
      setOssForm((current) => ({
        ...current,
        accessKeyId: '',
        accessKeySecret: '',
        securityToken: '',
      }));
    } catch (err) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setCurrentError(
        t('share.oss.setupFailed', { message: extractErrorDetail(err) }),
      );
    } finally {
      if (activeOperationRef.current === controller) {
        activeOperationRef.current = null;
        if (mountedRef.current) setSetupBusy(false);
      }
    }
  };

  const ready = setup?.stage === 'ready';
  const upload = async (force = false) => {
    if (!ready) {
      setCurrentError(t('share.notReady', { provider: providerName }));
      return;
    }
    const controller = new AbortController();
    activeOperationRef.current?.abort();
    activeOperationRef.current = controller;
    setUploading(true);
    setCurrentError();
    try {
      const published = await workspaceActions.publishArtifact(
        {
          path: workspacePath,
          title,
          provider: selectedProvider,
          ...(force ? { force: true } : {}),
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || !mountedRef.current) return;
      setResult(published);
    } catch (err) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setCurrentError(t('share.failed', { message: extractErrorDetail(err) }));
    } finally {
      if (activeOperationRef.current === controller) {
        activeOperationRef.current = null;
        if (mountedRef.current) setUploading(false);
      }
    }
  };

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      if (mountedRef.current) setCopiedUrl(url);
    } catch {
      // The URL remains selectable when clipboard access is unavailable.
    }
  };

  const stage = setup?.stage ?? 'install';
  const statusText = checkingConfig
    ? t('share.checking', { provider: providerName })
    : selectedProvider === 'oss'
      ? stage === 'install'
        ? t('share.oss.storageStatus')
        : stage === 'authenticate'
          ? t('share.oss.credentialsStatus')
          : stage === 'connect'
            ? t('share.oss.domainStatus')
            : t('share.ready', { provider: providerName })
      : stage === 'install'
        ? t('share.installStatus', { provider: providerName })
        : stage === 'authenticate'
          ? t(
              polling ? 'share.authorizationPending' : 'share.authorizeStatus',
              {
                provider: providerName,
              },
            )
          : stage === 'connect'
            ? setup?.accounts && setup.accounts.length > 1
              ? t('share.chooseAccount', { provider: providerName })
              : t('share.connectStatus', { provider: providerName })
            : t('share.ready', { provider: providerName });
  const detailCurrent = checkingConfig
    ? t('share.details.current.checking')
    : setupBusy
      ? t(
          selectedProvider === 'oss'
            ? 'share.oss.details.running'
            : 'share.details.current.running',
          { provider: providerName },
        )
      : polling
        ? t('share.details.current.authorizing', { provider: providerName })
        : statusText;
  const targetType = t(`share.details.target.${selectedProvider}`);
  const targetDescription = setup?.project?.name
    ? t('share.details.targetReady', {
        type: targetType,
        target: setup.project.name,
      })
    : targetType;
  const ossReady = config?.setups.oss?.stage === 'ready';
  const ossPublication = config?.publications?.oss;
  const ossProviderStatusKey = ossPublication
    ? ossPublication.upToDate
      ? 'share.providerStatus.published'
      : 'share.providerStatus.updated'
    : ossReady
      ? 'share.providerStatus.ready'
      : 'share.providerStatus.setup';

  return (
    <DialogShell
      title={t('share.title')}
      subtitle={title}
      size="lg"
      onClose={handleClose}
    >
      {result ? (
        <div className="flex flex-col gap-4" data-share-result>
          <div className="rounded-xl border border-[var(--success-color)]/25 bg-[var(--success-bg)] p-5">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-[var(--success-color)]/25 bg-background text-[var(--success-color)] shadow-sm">
                <CircleCheckBigIcon className="size-5" />
              </span>
              <div className="min-w-0">
                <h3 className="font-medium text-foreground">
                  {t(
                    result.reused
                      ? 'share.successReusedTitle'
                      : 'share.successTitle',
                  )}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t(
                    result.reused
                      ? 'share.successReusedDescription'
                      : 'share.successDescription',
                  )}
                </p>
              </div>
            </div>
          </div>
          <FieldGroup className="rounded-xl border border-border bg-muted/15 p-4">
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel htmlFor="share-result-url">
                  {t('share.resultLabel')}
                </FieldLabel>
                <span className="text-xs text-muted-foreground">
                  {t(`share.provider.${result.provider}`)}
                </span>
              </div>
              <div className="flex gap-2">
                <Input
                  id="share-result-url"
                  type="text"
                  readOnly
                  value={result.url}
                  className="min-w-0 flex-1"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={t(
                    copiedUrl === result.url ? 'share.copied' : 'common.copy',
                  )}
                  title={t(
                    copiedUrl === result.url ? 'share.copied' : 'common.copy',
                  )}
                  onClick={() => void copyUrl(result.url)}
                >
                  {copiedUrl === result.url ? <CheckIcon /> : <CopyIcon />}
                </Button>
              </div>
            </Field>
          </FieldGroup>
          {result.recorded === false && (
            <Alert className="border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300">
              <CircleAlertIcon />
              <AlertTitle>{t('share.historySaveFailedTitle')}</AlertTitle>
              <AlertDescription>
                {t('share.historySaveFailedDescription')}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" asChild>
              <a href={result.url} target="_blank" rel="noopener noreferrer">
                <ExternalLinkIcon data-icon="inline-start" />
                {t('artifact.openLink')}
              </a>
            </Button>
            <Button type="button" onClick={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void (selectedProvider === 'oss' ? configureOss() : upload());
          }}
        >
          <div role="group" aria-label={t('share.providerLabel')}>
            <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-border bg-muted/25 p-1.5">
              {QUICK_PROVIDERS.map((provider) => {
                const selected = selectedProvider === provider;
                const providerReady =
                  config?.setups[provider]?.stage === 'ready';
                const providerPublication = config?.publications?.[provider];
                const providerStatusKey = providerPublication
                  ? providerPublication.upToDate
                    ? 'share.providerStatus.published'
                    : 'share.providerStatus.updated'
                  : providerReady
                    ? 'share.providerStatus.ready'
                    : 'share.providerStatus.setup';
                return (
                  <Button
                    key={provider}
                    type="button"
                    variant="ghost"
                    className={`h-auto min-w-0 justify-start gap-2 rounded-lg px-2.5 py-2 text-xs sm:px-3 ${
                      selected
                        ? 'border-border bg-background text-foreground shadow-sm hover:bg-background'
                        : 'text-muted-foreground'
                    }`}
                    onClick={() => setSelectedProvider(provider)}
                    disabled={setupBusy || uploading}
                    data-share-provider={provider}
                    aria-pressed={selected}
                  >
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${
                        providerReady
                          ? 'bg-[var(--success-color)]'
                          : selected
                            ? 'bg-primary'
                            : 'bg-muted-foreground/45'
                      }`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-sm font-medium">
                        {t(`share.provider.${provider}`)}
                      </span>
                      <span className="hidden truncate text-[11px] font-normal text-muted-foreground sm:block">
                        {t(providerStatusKey)}
                      </span>
                    </span>
                    {providerReady && (
                      <CheckIcon
                        className="ml-auto hidden size-3.5 text-[var(--success-color)] sm:block"
                        data-share-provider-ready
                        aria-hidden="true"
                      />
                    )}
                  </Button>
                );
              })}
            </div>
            <Button
              type="button"
              variant="outline"
              className={`mt-2 h-auto w-full justify-start gap-3 rounded-xl px-3 py-2.5 text-xs ${
                selectedProvider === 'oss'
                  ? 'border-primary/35 bg-primary/5 text-foreground shadow-sm hover:bg-primary/5'
                  : 'text-muted-foreground'
              }`}
              onClick={() => setSelectedProvider('oss')}
              disabled={setupBusy || uploading}
              data-share-provider="oss"
              aria-pressed={selectedProvider === 'oss'}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
                <ServerIcon className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {t('share.provider.oss')}
                  </span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                    {t('share.oss.customBadge')}
                  </span>
                </span>
                <span className="block truncate text-[11px] font-normal text-muted-foreground">
                  {t(ossProviderStatusKey)} · {t('share.oss.subtitle')}
                </span>
              </span>
              <span
                className={`size-1.5 shrink-0 rounded-full ${
                  ossReady
                    ? 'bg-[var(--success-color)]'
                    : selectedProvider === 'oss'
                      ? 'bg-primary'
                      : 'bg-muted-foreground/45'
                }`}
                aria-hidden="true"
              />
              {ossReady && (
                <CheckIcon
                  className="size-3.5 text-[var(--success-color)]"
                  data-share-provider-ready
                  aria-hidden="true"
                />
              )}
            </Button>
          </div>

          <SetupProgress
            stage={stage}
            hasError={Boolean(currentError)}
            provider={selectedProvider}
          />

          <div
            className={`rounded-xl border p-4 transition-colors ${
              ready && publicationState === 'current'
                ? 'border-[var(--success-color)]/25 bg-[var(--success-bg)]'
                : ready && publicationState === 'stale'
                  ? 'border-amber-500/30 bg-amber-500/5'
                  : 'border-border bg-muted/20'
            }`}
            data-share-publication-state={publicationState}
          >
            <div className="flex items-start gap-3">
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-full border bg-background ${
                  ready && publicationState === 'current'
                    ? 'border-[var(--success-color)]/30 text-[var(--success-color)]'
                    : ready && publicationState === 'stale'
                      ? 'border-amber-500/30 text-amber-600 dark:text-amber-400'
                      : 'border-border text-muted-foreground'
                }`}
              >
                {checkingConfig || setupBusy || polling ? (
                  <Spinner />
                ) : ready && publicationState === 'current' ? (
                  <CircleCheckBigIcon className="size-4.5" />
                ) : ready && publicationState === 'stale' ? (
                  <RefreshCwIcon className="size-4" />
                ) : ready ? (
                  <RocketIcon className="size-4" />
                ) : (
                  <Share2Icon className="size-4" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <div className="font-medium">
                    {!ready
                      ? t('share.setupWith', { provider: providerName })
                      : publicationState === 'current'
                        ? t('share.publication.currentTitle')
                        : publicationState === 'stale'
                          ? t('share.publication.staleTitle')
                          : t('share.publication.firstTitle')}
                  </div>
                  {ready && (
                    <span className="rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                      {providerName}
                    </span>
                  )}
                </div>
                <FieldDescription
                  className="mt-1"
                  data-share-status
                  data-share-netlify-status
                >
                  {!ready
                    ? statusText
                    : publicationState === 'current'
                      ? t('share.publication.currentDescription')
                      : publicationState === 'stale'
                        ? t('share.publication.staleDescription')
                        : t('share.publication.firstDescription')}
                </FieldDescription>
                {publication && (
                  <div
                    className="mt-3 flex min-w-0 items-center gap-2 rounded-lg border border-border/80 bg-background/80 px-3 py-2 shadow-sm"
                    data-share-publication
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-foreground">
                        {publication.url}
                      </div>
                      {publicationPublishedAt && (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {t('share.publication.publishedAt', {
                            time: publicationPublishedAt,
                          })}
                        </div>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      aria-label={t(
                        copiedUrl === publication.url
                          ? 'share.copied'
                          : 'common.copy',
                      )}
                      onClick={() => void copyUrl(publication.url)}
                    >
                      {copiedUrl === publication.url ? (
                        <CheckIcon />
                      ) : (
                        <CopyIcon />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      asChild
                    >
                      <a
                        href={publication.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t('artifact.openLink')}
                      >
                        <ExternalLinkIcon />
                      </a>
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {currentError && (
            <Alert variant="destructive" data-share-error>
              <CircleAlertIcon />
              <AlertTitle>{t('share.errorTitle')}</AlertTitle>
              <AlertDescription>{currentError}</AlertDescription>
            </Alert>
          )}

          {selectedProvider === 'oss' && (
            <FieldGroup
              className="rounded-xl border border-border bg-muted/10 p-4"
              data-share-oss-form
            >
              <div>
                <div className="text-sm font-medium">
                  {t('share.oss.formTitle')}
                </div>
                <FieldDescription className="mt-1">
                  {t('share.oss.formDescription')}
                </FieldDescription>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="share-oss-endpoint">
                    {t('share.oss.endpoint')}
                  </FieldLabel>
                  <Input
                    id="share-oss-endpoint"
                    value={ossForm.endpoint}
                    placeholder="oss-cn-hangzhou.aliyuncs.com"
                    spellCheck={false}
                    onChange={(event) =>
                      setOssForm((current) => ({
                        ...current,
                        endpoint: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="share-oss-bucket">
                    {t('share.oss.bucket')}
                  </FieldLabel>
                  <Input
                    id="share-oss-bucket"
                    value={ossForm.bucket}
                    placeholder="my-artifacts"
                    spellCheck={false}
                    onChange={(event) =>
                      setOssForm((current) => ({
                        ...current,
                        bucket: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="share-oss-public-base-url">
                  {t('share.oss.publicBaseUrl')}
                </FieldLabel>
                <Input
                  id="share-oss-public-base-url"
                  type="url"
                  value={ossForm.publicBaseUrl}
                  placeholder="https://artifacts.example.com"
                  spellCheck={false}
                  onChange={(event) =>
                    setOssForm((current) => ({
                      ...current,
                      publicBaseUrl: event.target.value,
                    }))
                  }
                />
                <FieldDescription>
                  {t('share.oss.publicBaseUrlDescription')}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="share-oss-key-prefix">
                  {t('share.oss.keyPrefix')}
                </FieldLabel>
                <Input
                  id="share-oss-key-prefix"
                  value={ossForm.keyPrefix}
                  spellCheck={false}
                  onChange={(event) =>
                    setOssForm((current) => ({
                      ...current,
                      keyPrefix: event.target.value,
                    }))
                  }
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="share-oss-access-key-id">
                    {t('share.oss.accessKeyId')}
                  </FieldLabel>
                  <Input
                    id="share-oss-access-key-id"
                    value={ossForm.accessKeyId}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      setOssForm((current) => ({
                        ...current,
                        accessKeyId: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="share-oss-access-key-secret">
                    {t('share.oss.accessKeySecret')}
                  </FieldLabel>
                  <Input
                    id="share-oss-access-key-secret"
                    type="password"
                    value={ossForm.accessKeySecret}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      setOssForm((current) => ({
                        ...current,
                        accessKeySecret: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="share-oss-security-token">
                  {t('share.oss.securityToken')}
                </FieldLabel>
                <Input
                  id="share-oss-security-token"
                  type="password"
                  value={ossForm.securityToken}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setOssForm((current) => ({
                      ...current,
                      securityToken: event.target.value,
                    }))
                  }
                />
                <FieldDescription>
                  {t(
                    ossTarget?.credentialsSource === 'environment'
                      ? 'share.oss.credentialsFromEnvironment'
                      : 'share.oss.credentialsDescription',
                  )}
                </FieldDescription>
              </Field>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant={ready ? 'outline' : 'default'}
                  onClick={() => void configureOss()}
                  disabled={setupBusy || uploading}
                  data-share-action="configure-oss"
                >
                  {setupBusy && <Spinner data-icon="inline-start" />}
                  {t(ready ? 'share.oss.saveChanges' : 'share.oss.save')}
                </Button>
              </div>
            </FieldGroup>
          )}

          {stage === 'connect' &&
            setup?.accounts &&
            setup.accounts.length > 1 && (
              <div className="grid gap-2" data-share-account-picker>
                {setup.accounts.map((account) => (
                  <Button
                    key={account.id}
                    type="button"
                    variant="outline"
                    onClick={() => void startSetup(account.id)}
                    disabled={setupBusy}
                  >
                    {account.name}
                  </Button>
                ))}
              </div>
            )}

          <FieldDescription
            className="rounded-lg border border-border/70 bg-muted/15 px-3 py-2 text-xs"
            data-share-storage-note
          >
            {t(
              selectedProvider === 'oss'
                ? ready
                  ? 'share.oss.publicNote'
                  : 'share.oss.storageNote'
                : ready
                  ? 'share.publicNote'
                  : 'share.storageNote',
              { provider: providerName },
            )}
          </FieldDescription>

          <details
            className="group rounded-lg border border-border bg-muted/20"
            data-share-details
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
              {t('share.details.summary')}
              <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-border px-4 py-3">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                <dt className="text-muted-foreground">
                  {t('share.details.currentLabel')}
                </dt>
                <dd data-share-details-current>{detailCurrent}</dd>
                <dt className="text-muted-foreground">
                  {t('share.details.cliLabel')}
                </dt>
                <dd>{t(`share.details.cli.${selectedProvider}`)}</dd>
                <dt className="text-muted-foreground">
                  {t('share.details.targetLabel')}
                </dt>
                <dd>{targetDescription}</dd>
                <dt className="text-muted-foreground">
                  {t('share.details.savedLabel')}
                </dt>
                <dd>{t(`share.details.saved.${selectedProvider}`)}</dd>
              </dl>
              <div className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                <p>
                  {t(
                    selectedProvider === 'oss'
                      ? 'share.oss.details.domainNote'
                      : 'share.details.installNote',
                  )}
                </p>
                <p>
                  {t(
                    selectedProvider === 'oss'
                      ? 'share.oss.details.credentialsNote'
                      : 'share.details.credentialsNote',
                  )}
                </p>
              </div>
            </div>
          </details>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {setupBusy || polling || uploading ? (
              <Button
                type="button"
                variant="outline"
                onClick={stopActiveOperation}
                data-share-action="stop"
              >
                <SquareIcon data-icon="inline-start" />
                {t('share.stop')}
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={handleClose}>
                {t('common.cancel')}
              </Button>
            )}
            {!checkingConfig &&
              !ready &&
              selectedProvider !== 'oss' &&
              !(stage === 'connect' && (setup?.accounts?.length ?? 0) > 1) && (
                <Button
                  type="button"
                  onClick={() =>
                    void (configError ? loadConfig() : startSetup())
                  }
                  disabled={setupBusy || polling}
                  data-share-action="prepare"
                  data-share-netlify-action={
                    stage === 'connect' ? 'connect' : 'prepare'
                  }
                >
                  {setupBusy && <Spinner data-icon="inline-start" />}
                  {t(
                    currentError
                      ? 'share.retry'
                      : stage === 'authenticate'
                        ? 'share.authorize'
                        : stage === 'connect'
                          ? 'share.connect'
                          : 'share.start',
                    { provider: providerName },
                  )}
                </Button>
              )}
            {ready && publicationState === 'current' && publication ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void upload(true)}
                  disabled={uploading || setupBusy || polling}
                  data-share-action="republish"
                >
                  {uploading ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <RefreshCwIcon data-icon="inline-start" />
                  )}
                  {t(
                    uploading
                      ? 'share.uploading'
                      : 'share.publication.republish',
                  )}
                </Button>
                <Button asChild>
                  <a
                    href={publication.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLinkIcon data-icon="inline-start" />
                    {t('share.publication.openCurrent')}
                  </a>
                </Button>
              </>
            ) : (
              <Button
                type={selectedProvider === 'oss' ? 'button' : 'submit'}
                onClick={
                  selectedProvider === 'oss' ? () => void upload() : undefined
                }
                disabled={
                  uploading || setupBusy || polling || checkingConfig || !ready
                }
                data-share-action="publish"
              >
                {uploading && <Spinner data-icon="inline-start" />}
                {t(
                  uploading
                    ? 'share.uploading'
                    : publicationState === 'stale'
                      ? 'share.publication.publishNewVersion'
                      : 'share.publication.publishFirst',
                )}
              </Button>
            )}
          </div>
        </form>
      )}
    </DialogShell>
  );
}
