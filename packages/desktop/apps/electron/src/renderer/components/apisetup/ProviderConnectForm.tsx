import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  Cloud,
  KeyRound,
  Loader2,
  Server,
  SlidersHorizontal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type {
  QwenProviderCatalog,
  QwenProviderConnectParams,
  QwenProviderConnectResult,
  QwenProviderSummary,
} from '../../../shared/types';

type ProviderGroup = 'alibaba' | 'third-party' | 'custom';

interface ProviderConnectFormProps {
  onConnected: (result: QwenProviderConnectResult) => void;
  onCancel?: () => void;
  showHeader?: boolean;
  className?: string;
}

const PROVIDER_GROUPS: ProviderGroup[] = ['alibaba', 'third-party', 'custom'];

const PROVIDER_GROUP_ICONS: Record<ProviderGroup, ReactNode> = {
  alibaba: <Cloud className="size-4" />,
  'third-party': <Server className="size-4" />,
  custom: <SlidersHorizontal className="size-4" />,
};

function isProviderGroup(value: string | undefined): value is ProviderGroup {
  return value === 'alibaba' || value === 'third-party' || value === 'custom';
}

function parseModelIds(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function defaultProtocol(provider: QwenProviderSummary): string {
  return provider.protocolOptions[0] || provider.protocol;
}

function defaultBaseUrl(provider: QwenProviderSummary): string {
  if (typeof provider.baseUrl === 'string') return provider.baseUrl;
  if (Array.isArray(provider.baseUrl)) return provider.baseUrl[0]?.url ?? '';
  return provider.baseUrlPlaceholder ?? '';
}

function initialModelIds(provider: QwenProviderSummary): string[] {
  const existingModelIds = provider.existingConfig?.modelIds ?? [];
  return existingModelIds.length > 0
    ? existingModelIds
    : provider.defaultModelIds;
}

function AnimatedSection({
  children,
  className,
  subtle = false,
}: {
  children: ReactNode;
  className?: string;
  subtle?: boolean;
}) {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    setEntered(false);
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      className={cn(
        'transition-[opacity,transform] ease-out motion-reduce:translate-y-0 motion-reduce:opacity-100 motion-reduce:transition-none',
        subtle ? 'duration-100' : 'duration-150',
        entered ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ProviderConnectForm({
  onConnected,
  onCancel,
  showHeader = true,
  className,
}: ProviderConnectFormProps) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<QwenProviderCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<ProviderGroup>('alibaba');
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );
  const [protocol, setProtocol] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelIdsText, setModelIdsText] = useState('');
  const [enableThinking, setEnableThinking] = useState(false);
  const [contextWindowSize, setContextWindowSize] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const groups = useMemo(
    () =>
      PROVIDER_GROUPS.map((id) => ({
        id,
        title: t(`providerConnect.groups.${id}.title`),
        description: t(`providerConnect.groups.${id}.description`),
        icon: PROVIDER_GROUP_ICONS[id],
      })),
    [t],
  );

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await window.electronAPI.listQwenProviders();
      setCatalog(result);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : t('providerConnect.loadFailed'),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const providersByGroup = useMemo(() => {
    const groups: Record<ProviderGroup, QwenProviderSummary[]> = {
      alibaba: [],
      'third-party': [],
      custom: [],
    };
    for (const provider of catalog?.providers ?? []) {
      const group = isProviderGroup(provider.uiGroup)
        ? provider.uiGroup
        : 'third-party';
      groups[group].push(provider);
    }
    return groups;
  }, [catalog]);

  const activeGroup = groups.find((group) => group.id === selectedGroup);

  const selectedProvider = useMemo(
    () =>
      catalog?.providers.find(
        (provider) => provider.id === selectedProviderId,
      ) ?? null,
    [catalog, selectedProviderId],
  );

  const selectProvider = useCallback((provider: QwenProviderSummary) => {
    const existingConfig = provider.existingConfig;
    const contextWindowSize = existingConfig?.advancedConfig?.contextWindowSize;
    setSelectedProviderId(provider.id);
    setProtocol(existingConfig?.protocol ?? defaultProtocol(provider));
    setBaseUrl(existingConfig?.baseUrl ?? defaultBaseUrl(provider));
    setApiKey(existingConfig?.apiKey ?? '');
    setModelIdsText(initialModelIds(provider).join(', '));
    setEnableThinking(existingConfig?.advancedConfig?.enableThinking === true);
    setContextWindowSize(
      typeof contextWindowSize === 'number' ? String(contextWindowSize) : '',
    );
    setFormError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!selectedProvider) return;
    const modelIds = parseModelIds(modelIdsText);
    if (!apiKey.trim()) {
      setFormError(t('providerConnect.errors.apiKeyRequired'));
      return;
    }
    if (modelIds.length === 0) {
      setFormError(t('providerConnect.errors.modelRequired'));
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const contextSize = Number(contextWindowSize);
      const params: QwenProviderConnectParams = {
        providerId: selectedProvider.id,
        protocol,
        baseUrl,
        apiKey: apiKey.trim(),
        modelIds,
        scope: 'user',
        ...(selectedProvider.showAdvancedConfig
          ? {
              advancedConfig: {
                ...(enableThinking ? { enableThinking: true } : {}),
                ...(Number.isFinite(contextSize) && contextSize > 0
                  ? { contextWindowSize: contextSize }
                  : {}),
              },
            }
          : {}),
      };
      const result = await window.electronAPI.connectQwenProvider(params);
      if (!result.success) {
        setFormError(result.error || t('providerConnect.errors.connectFailed'));
        return;
      }
      toast.success(
        t('providerConnect.connectedToast', {
          provider: result.providerLabel || selectedProvider.label,
        }),
      );
      onConnected(result);
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : t('providerConnect.errors.connectFailed'),
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    apiKey,
    baseUrl,
    contextWindowSize,
    enableThinking,
    modelIdsText,
    onConnected,
    protocol,
    selectedProvider,
    t,
  ]);

  if (loading) {
    return (
      <div
        className={cn(
          'flex items-center justify-center py-12 text-sm text-muted-foreground',
          className,
        )}
      >
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t('providerConnect.loading')}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={cn('space-y-4', className)}>
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {loadError}
        </div>
        <Button type="button" variant="outline" onClick={loadCatalog}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  if (!selectedProvider) {
    return (
      <AnimatedSection
        key="provider-list"
        className={cn('space-y-5', className)}
      >
        {showHeader && (
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">
              {t('providerConnect.title')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('providerConnect.description')}
            </p>
          </div>
        )}

        <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              onClick={() => setSelectedGroup(group.id)}
              className={cn(
                'flex h-8 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium transition-colors',
                selectedGroup === group.id
                  ? 'bg-background text-foreground shadow-minimal'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {group.icon}
              <span className="truncate">{group.title}</span>
            </button>
          ))}
        </div>
        {activeGroup && (
          <p className="text-xs text-muted-foreground">
            {activeGroup.description}
          </p>
        )}

        <AnimatedSection key={selectedGroup} subtle className="space-y-3">
          {providersByGroup[selectedGroup].map((provider) => (
            <button
              key={provider.id}
              type="button"
              onClick={() => selectProvider(provider)}
              className="flex w-full items-start gap-3 rounded-md border border-border bg-background p-3 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <KeyRound className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{provider.label}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {provider.description}
                </div>
              </div>
            </button>
          ))}
        </AnimatedSection>

        {onCancel && (
          <div className="flex justify-end">
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          </div>
        )}
      </AnimatedSection>
    );
  }

  const fixedBaseUrl = typeof selectedProvider.baseUrl === 'string';
  const baseUrlOptions = Array.isArray(selectedProvider.baseUrl)
    ? selectedProvider.baseUrl
    : [];
  const showProtocol = selectedProvider.protocolOptions.length > 1;
  const showBaseUrlInput = !fixedBaseUrl || baseUrlOptions.length > 0;

  return (
    <AnimatedSection
      key={selectedProvider.id}
      className={cn('space-y-5', className)}
    >
      <div className="flex items-start gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={() => setSelectedProviderId(null)}
          disabled={submitting}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{selectedProvider.label}</h2>
          <p className="text-sm text-muted-foreground">
            {selectedProvider.description}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {showProtocol && (
          <div className="space-y-2">
            <Label>{t('providerConnect.protocol')}</Label>
            <Select
              value={protocol}
              onValueChange={setProtocol}
              disabled={submitting}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {selectedProvider.protocolOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {showBaseUrlInput && (
          <div className="space-y-2">
            <Label>
              {selectedProvider.uiLabels?.baseUrlStepTitle === 'Region'
                ? t('providerConnect.region')
                : selectedProvider.uiLabels?.baseUrlStepTitle ||
                  t('providerConnect.baseUrl')}
            </Label>
            {baseUrlOptions.length > 0 ? (
              <Select
                value={baseUrl}
                onValueChange={setBaseUrl}
                disabled={submitting}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {baseUrlOptions.map((option) => (
                    <SelectItem key={option.id} value={option.url}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={
                  selectedProvider.baseUrlPlaceholder ||
                  'https://api.example.com/v1'
                }
                disabled={submitting}
              />
            )}
          </div>
        )}

        <div className="space-y-2">
          <Label>{t('providerConnect.apiKey')}</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              selectedProvider.apiKeyPlaceholder ||
              t('providerConnect.apiKeyPlaceholder')
            }
            disabled={submitting}
          />
        </div>

        <div className="space-y-2">
          <Label>{t('providerConnect.models')}</Label>
          <Textarea
            value={modelIdsText}
            onChange={(event) => setModelIdsText(event.target.value)}
            placeholder={t('providerConnect.modelsPlaceholder')}
            className="min-h-20"
            disabled={submitting || !selectedProvider.modelsEditable}
          />
        </div>

        {selectedProvider.showAdvancedConfig && (
          <div className="grid gap-3 rounded-md border border-border p-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enableThinking}
                onChange={(event) => setEnableThinking(event.target.checked)}
                disabled={submitting}
              />
              {t('providerConnect.enableThinking')}
            </label>
            <div className="space-y-2">
              <Label>{t('providerConnect.contextWindow')}</Label>
              <Input
                type="number"
                min={1}
                value={contextWindowSize}
                onChange={(event) => setContextWindowSize(event.target.value)}
                placeholder={t('providerConnect.optional')}
                disabled={submitting}
              />
            </div>
          </div>
        )}
      </div>

      {formError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {formError}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            {t('common.cancel')}
          </Button>
        )}
        <Button type="button" onClick={handleSubmit} disabled={submitting}>
          {submitting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
          {t('auth.connect')}
        </Button>
      </div>
    </AnimatedSection>
  );
}
