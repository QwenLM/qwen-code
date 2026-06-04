import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useWorkspaceActions,
  type DaemonAuthProviderBaseUrlOption,
  type DaemonAuthProviderCatalog,
  type DaemonAuthProviderDescriptor,
} from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
import styles from './AuthMessage.module.css';

export const AUTH_ACTIVE_EVENT = 'web-shell:auth-panel-active';

type AuthView = 'groups' | 'providers' | 'step' | 'review';
type AuthGroupId = 'alibaba' | 'third-party' | 'custom';
type AuthGroup = DaemonAuthProviderCatalog['groups'][number];
type AuthStep = 'protocol' | 'baseUrl' | 'apiKey' | 'models' | 'advancedConfig';

interface AuthMessageProps {
  onMessage: (text: string, type?: 'status' | 'error') => void;
  onClose: () => void;
}

interface Option<T extends string> {
  value: T;
  label: string;
  description?: string;
}

const PROTOCOL_OPTIONS: Array<Option<string>> = [
  {
    value: 'openai',
    label: 'OpenAI-compatible',
    description: 'Standard OpenAI API format (most common)',
  },
  {
    value: 'anthropic',
    label: 'Anthropic-compatible',
    description: 'Anthropic Messages API format',
  },
  {
    value: 'gemini',
    label: 'Gemini-compatible',
    description: 'Google Gemini API format',
  },
];

function defaultBaseUrl(protocol: string): string {
  if (protocol === 'anthropic') return 'https://api.anthropic.com/v1';
  if (protocol === 'gemini') return 'https://generativelanguage.googleapis.com';
  return 'https://api.openai.com/v1';
}

function modelIds(provider: DaemonAuthProviderDescriptor | null): string {
  return (
    provider?.models
      ?.map(
        (model: NonNullable<DaemonAuthProviderDescriptor['models']>[number]) =>
          model.id,
      )
      .join(', ') ?? ''
  );
}

function titleForStep(
  step: AuthStep,
  provider: DaemonAuthProviderDescriptor,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (step === 'protocol') return t('auth.step.protocol');
  if (step === 'baseUrl') {
    return provider.uiLabels?.baseUrlStepTitle ?? t('auth.step.baseUrl');
  }
  if (step === 'apiKey') return t('auth.step.apiKey');
  if (step === 'models') return t('auth.step.models');
  return t('auth.step.advanced');
}

function maskApiKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '(not set)';
  if (trimmed.length <= 6) return '***';
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

function normalizeModelIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
}

export function AuthMessage({ onMessage, onClose }: AuthMessageProps) {
  const { t } = useI18n();
  const workspaceActions = useWorkspaceActions();
  const [view, setView] = useState<AuthView>('groups');
  const [groupIndex, setGroupIndex] = useState(0);
  const [providerIndex, setProviderIndex] = useState(0);
  const [setupBackView, setSetupBackView] = useState<AuthView>('providers');
  const [stepIndex, setStepIndex] = useState(0);
  const [catalog, setCatalog] = useState<DaemonAuthProviderCatalog>();
  const [groupId, setGroupId] = useState<AuthGroupId>('alibaba');
  const [provider, setProvider] = useState<DaemonAuthProviderDescriptor | null>(
    null,
  );
  const [protocol, setProtocol] = useState('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState('');
  const [thinking, setThinking] = useState(false);
  const [modality, setModality] = useState(false);
  const [modalityImage, setModalityImage] = useState(true);
  const [modalityVideo, setModalityVideo] = useState(true);
  const [modalityAudio, setModalityAudio] = useState(false);
  const [modalityPdf, setModalityPdf] = useState(false);
  const [contextWindow, setContextWindow] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = `auth-${Math.random().toString(36).slice(2)}`;
    window.dispatchEvent(
      new CustomEvent(AUTH_ACTIVE_EVENT, { detail: { id, active: true } }),
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent(AUTH_ACTIVE_EVENT, { detail: { id, active: false } }),
      );
    };
  }, []);

  useEffect(() => {
    workspaceActions
      .getAuthProviders()
      .then((next) => {
        setCatalog(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [workspaceActions]);

  const groups = useMemo(() => catalog?.groups ?? [], [catalog]);
  const providers = useMemo(() => {
    const ids =
      groups.find((group: AuthGroup) => group.id === groupId)?.providerIds ??
      [];
    return ids
      .map((id: string) =>
        catalog?.providers.find(
          (item: DaemonAuthProviderDescriptor) => item.id === id,
        ),
      )
      .filter(
        (
          item: DaemonAuthProviderDescriptor | undefined,
        ): item is DaemonAuthProviderDescriptor => !!item,
      );
  }, [catalog, groupId, groups]);

  const steps = provider?.steps ?? [];
  const currentStep = steps[stepIndex] as AuthStep | undefined;
  const shouldReview = provider?.showAdvancedConfig === true;
  const advancedContextIndex = modality ? 6 : 2;
  const advancedCount = modality ? 7 : 3;
  const totalSteps = steps.length + (shouldReview ? 1 : 0);
  const isInputStep =
    currentStep === 'apiKey' ||
    currentStep === 'models' ||
    (currentStep === 'baseUrl' && !Array.isArray(provider?.baseUrl));

  const selectableCount =
    view === 'groups'
      ? groups.length
      : view === 'providers'
        ? providers.length
        : currentStep === 'protocol'
          ? (provider?.protocolOptions ?? [provider?.protocol]).length
          : currentStep === 'baseUrl' && Array.isArray(provider?.baseUrl)
            ? provider.baseUrl.length
            : currentStep === 'advancedConfig'
              ? advancedCount
              : 0;

  const [optionIndex, setOptionIndex] = useState(0);

  const startProvider = useCallback(
    (
      nextProvider: DaemonAuthProviderDescriptor,
      backView: AuthView = 'providers',
    ) => {
      setProvider(nextProvider);
      setSetupBackView(backView);
      const nextProtocol =
        nextProvider.protocolOptions?.[0] ?? nextProvider.protocol;
      setProtocol(nextProtocol);
      if (typeof nextProvider.baseUrl === 'string') {
        setBaseUrl(nextProvider.baseUrl);
      } else if (Array.isArray(nextProvider.baseUrl)) {
        setBaseUrl(nextProvider.baseUrl[0]?.url ?? '');
      } else {
        setBaseUrl(defaultBaseUrl(nextProtocol));
      }
      setApiKey('');
      setModels(modelIds(nextProvider));
      setThinking(false);
      setModality(false);
      setModalityImage(true);
      setModalityVideo(true);
      setModalityAudio(false);
      setModalityPdf(false);
      setContextWindow('');
      setStepIndex(0);
      setOptionIndex(0);
      setError(null);
      setView(nextProvider.steps.length > 0 ? 'step' : 'review');
    },
    [],
  );

  const goBack = useCallback(() => {
    setError(null);
    if (view === 'groups') {
      onClose();
      return;
    }
    if (view === 'providers') {
      setView('groups');
      return;
    }
    if (view === 'review') {
      setView('step');
      setStepIndex(Math.max(0, steps.length - 1));
      return;
    }
    if (stepIndex > 0) {
      setStepIndex((idx) => idx - 1);
      setOptionIndex(0);
      return;
    }
    setView(setupBackView);
  }, [onClose, setupBackView, stepIndex, steps.length, view]);

  const save = useCallback(() => {
    if (!provider || saving) return;
    setSaving(true);
    setError(null);
    const ctxSize = Number(contextWindow);
    workspaceActions
      .installAuthProvider({
        providerId: provider.id,
        protocol,
        baseUrl,
        apiKey,
        modelIds: normalizeModelIds(models),
        advancedConfig:
          thinking || modality || (Number.isFinite(ctxSize) && ctxSize > 0)
            ? {
                ...(thinking ? { enableThinking: true } : {}),
                ...(modality
                  ? {
                      multimodal: {
                        ...(modalityImage ? { image: true } : {}),
                        ...(modalityVideo ? { video: true } : {}),
                        ...(modalityAudio ? { audio: true } : {}),
                        ...(modalityPdf ? { pdf: true } : {}),
                      },
                    }
                  : {}),
                ...(Number.isFinite(ctxSize) && ctxSize > 0
                  ? { contextWindowSize: ctxSize }
                  : {}),
              }
            : undefined,
      })
      .then((result) => {
        onMessage(result.message);
        onClose();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        onMessage(message, 'error');
      })
      .finally(() => setSaving(false));
  }, [
    apiKey,
    baseUrl,
    contextWindow,
    modality,
    modalityAudio,
    modalityImage,
    modalityPdf,
    modalityVideo,
    models,
    onClose,
    onMessage,
    protocol,
    provider,
    saving,
    thinking,
    workspaceActions,
  ]);

  const goNext = useCallback(() => {
    if (!provider) return;
    if (currentStep === 'baseUrl') {
      const effective = baseUrl.trim() || defaultBaseUrl(protocol);
      if (!effective) {
        setError(t('auth.baseUrlRequired'));
        return;
      }
      if (!/^https?:\/\//i.test(effective)) {
        setError(t('auth.baseUrlInvalid'));
        return;
      }
      if (!baseUrl.trim()) setBaseUrl(effective);
    }
    if (currentStep === 'apiKey' && apiKey.trim().length === 0) {
      setError(t('auth.apiKeyRequired'));
      return;
    }
    if (currentStep === 'models' && normalizeModelIds(models).length === 0) {
      setError(t('auth.modelsRequired'));
      return;
    }
    setError(null);
    if (stepIndex >= steps.length - 1) {
      if (shouldReview) {
        setView('review');
      } else {
        save();
      }
    } else {
      setStepIndex((idx) => idx + 1);
      setOptionIndex(0);
    }
  }, [
    apiKey,
    baseUrl,
    currentStep,
    models,
    protocol,
    provider,
    save,
    shouldReview,
    stepIndex,
    steps.length,
    t,
  ]);

  const activate = useCallback(() => {
    if (view === 'groups') {
      const group = groups[groupIndex];
      if (!group) return;
      if (group.id === 'custom') {
        const customProvider = group.providerIds
          .map((id: string) =>
            catalog?.providers.find(
              (item: DaemonAuthProviderDescriptor) => item.id === id,
            ),
          )
          .find(
            (
              item: DaemonAuthProviderDescriptor | undefined,
            ): item is DaemonAuthProviderDescriptor => !!item,
          );
        if (customProvider) startProvider(customProvider, 'groups');
        return;
      }
      setGroupId(group.id);
      setProviderIndex(0);
      setView('providers');
      return;
    }
    if (view === 'providers') {
      const selected = providers[providerIndex];
      if (selected) startProvider(selected, 'providers');
      return;
    }
    if (view === 'review') {
      save();
      return;
    }
    if (!provider || !currentStep) return;
    if (currentStep === 'protocol') {
      const value = (provider.protocolOptions ?? [provider.protocol])[
        optionIndex
      ];
      if (value) {
        setProtocol(value);
        if (!provider.baseUrl) setBaseUrl(defaultBaseUrl(value));
      }
      goNext();
      return;
    }
    if (currentStep === 'baseUrl' && Array.isArray(provider.baseUrl)) {
      const selected = provider.baseUrl[optionIndex];
      if (selected) setBaseUrl(selected.url);
      goNext();
      return;
    }
    if (currentStep === 'advancedConfig') {
      if (optionIndex === 0) setThinking((value) => !value);
      if (optionIndex === 1) setModality((value) => !value);
      if (modality && optionIndex === 2) setModalityImage((value) => !value);
      if (modality && optionIndex === 3) setModalityVideo((value) => !value);
      if (modality && optionIndex === 4) setModalityAudio((value) => !value);
      if (modality && optionIndex === 5) setModalityPdf((value) => !value);
      if (optionIndex === advancedContextIndex) goNext();
      return;
    }
    goNext();
  }, [
    currentStep,
    catalog,
    goNext,
    groupIndex,
    groups,
    optionIndex,
    provider,
    providerIndex,
    providers,
    save,
    startProvider,
    view,
    modality,
    advancedContextIndex,
  ]);

  const activateAtIndex = useCallback(
    (index: number) => {
      if (view === 'groups') {
        const group = groups[index];
        if (!group) return;
        if (group.id === 'custom') {
          const customProvider = group.providerIds
            .map((id: string) =>
              catalog?.providers.find(
                (item: DaemonAuthProviderDescriptor) => item.id === id,
              ),
            )
            .find(
              (
                item: DaemonAuthProviderDescriptor | undefined,
              ): item is DaemonAuthProviderDescriptor => !!item,
            );
          if (customProvider) startProvider(customProvider, 'groups');
          return;
        }
        setGroupId(group.id);
        setProviderIndex(0);
        setView('providers');
        return;
      }
      if (view === 'providers') {
        const selected = providers[index];
        if (selected) startProvider(selected, 'providers');
        return;
      }
      if (!provider || !currentStep) {
        if (view === 'review') save();
        return;
      }
      if (currentStep === 'protocol') {
        const value = (provider.protocolOptions ?? [provider.protocol])[index];
        if (value) {
          setProtocol(value);
          if (!provider.baseUrl) setBaseUrl(defaultBaseUrl(value));
        }
        goNext();
        return;
      }
      if (currentStep === 'baseUrl' && Array.isArray(provider.baseUrl)) {
        const selected = provider.baseUrl[index];
        if (selected) setBaseUrl(selected.url);
        goNext();
        return;
      }
      if (currentStep === 'advancedConfig') {
        if (index === 0) setThinking((value) => !value);
        if (index === 1) setModality((value) => !value);
        if (modality && index === 2) setModalityImage((value) => !value);
        if (modality && index === 3) setModalityVideo((value) => !value);
        if (modality && index === 4) setModalityAudio((value) => !value);
        if (modality && index === 5) setModalityPdf((value) => !value);
        if (index === advancedContextIndex) goNext();
      }
    },
    [
      currentStep,
      catalog,
      goNext,
      groups,
      modality,
      advancedContextIndex,
      provider,
      providers,
      save,
      startProvider,
      view,
    ],
  );

  useDelayedGlobalKeyDown(
    (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        goBack();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        activate();
        return;
      }
      if (event.key === ' ') {
        if (currentStep === 'advancedConfig') {
          event.preventDefault();
          activate();
        }
        return;
      }
      if (
        selectableCount > 0 &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      ) {
        event.preventDefault();
        const delta = event.key === 'ArrowUp' ? -1 : 1;
        const update = (value: number) =>
          (value + selectableCount + delta) % selectableCount;
        if (view === 'groups') setGroupIndex(update);
        else if (view === 'providers') setProviderIndex(update);
        else setOptionIndex(update);
      }
    },
    [activate, currentStep, goBack, selectableCount, view],
  );

  const renderOptions = <T extends string>(
    options: Array<Option<T>>,
    selected: number,
    onSelect: (index: number) => void,
  ) => (
    <div className={styles.options}>
      {options.map((option, index) => (
        <div
          key={option.value}
          className={`${styles.option} ${selected === index ? styles.optionActive : ''}`}
          onClick={() => {
            onSelect(index);
            activateAtIndex(index);
          }}
        >
          <span className={styles.pointer}>
            {selected === index ? '›' : ' '}
          </span>
          <div>
            <div className={styles.label}>
              {index + 1}. {option.label}
            </div>
            {option.description && (
              <div className={styles.description}>{option.description}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );

  const renderStep = () => {
    if (!provider || !currentStep) return null;
    if (currentStep === 'protocol') {
      const allowed = provider.protocolOptions ?? [provider.protocol];
      return renderOptions(
        PROTOCOL_OPTIONS.filter((option) => allowed.includes(option.value)),
        optionIndex,
        setOptionIndex,
      );
    }
    if (currentStep === 'baseUrl') {
      if (Array.isArray(provider.baseUrl)) {
        return renderOptions(
          provider.baseUrl.map((option: DaemonAuthProviderBaseUrlOption) => ({
            value: option.url,
            label: option.label,
            description: option.url,
          })),
          optionIndex,
          setOptionIndex,
        );
      }
      return (
        <>
          <div className={styles.text}>{t('auth.baseUrlPrompt')}</div>
          <input
            className={styles.input}
            value={baseUrl}
            placeholder={defaultBaseUrl(protocol)}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                goNext();
              }
            }}
            autoFocus
          />
          {provider.documentationUrl && (
            <a
              className={styles.link}
              href={provider.documentationUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t('auth.documentation')}
            </a>
          )}
        </>
      );
    }
    if (currentStep === 'apiKey') {
      return (
        <>
          {provider.documentationUrl && (
            <a
              className={styles.link}
              href={provider.documentationUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t('auth.documentation')}: {provider.documentationUrl}
            </a>
          )}
          <input
            className={styles.input}
            type="password"
            value={apiKey}
            placeholder={provider.apiKeyPlaceholder ?? 'sk-...'}
            onChange={(event) => {
              setApiKey(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                goNext();
              }
            }}
            autoFocus
          />
        </>
      );
    }
    if (currentStep === 'models') {
      const defaultIds = modelIds(provider);
      return (
        <>
          {defaultIds && (
            <div className={styles.muted}>
              {t('auth.modelsPrompt', { modelIds: defaultIds })}
            </div>
          )}
          <input
            className={styles.input}
            value={models}
            placeholder={defaultIds || 'model-id-1, model-id-2'}
            onChange={(event) => {
              setModels(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                goNext();
              }
            }}
            autoFocus
          />
        </>
      );
    }
    const checkmark = (enabled: boolean) => (enabled ? '◉' : '○');
    const advancedOptions: Array<Option<string>> = [
      {
        value: 'thinking',
        label: `${checkmark(thinking)} ${t('auth.advanced.thinking')}`,
        description: t('auth.advanced.thinkingDesc'),
      },
      {
        value: 'modality',
        label: `${checkmark(modality)} ${t('auth.advanced.modality')}`,
        description: t('auth.advanced.modalityDesc'),
      },
    ];
    if (modality) {
      advancedOptions.push(
        { value: 'image', label: `${checkmark(modalityImage)} Image` },
        { value: 'video', label: `${checkmark(modalityVideo)} Video` },
        { value: 'audio', label: `${checkmark(modalityAudio)} Audio` },
        { value: 'pdf', label: `${checkmark(modalityPdf)} PDF` },
      );
    }
    advancedOptions.push({
      value: 'context',
      label: `${t('auth.advanced.contextWindow')}: ${contextWindow || 'auto'}`,
      description: t('auth.advanced.contextDesc'),
    });
    return (
      <>
        <div className={styles.text}>{t('auth.advanced.prompt')}</div>
        {renderOptions(advancedOptions, optionIndex, setOptionIndex)}
        <input
          className={styles.input}
          value={contextWindow}
          placeholder="auto"
          onChange={(event) =>
            setContextWindow(event.target.value.replace(/[^0-9]/g, ''))
          }
          onFocus={() => setOptionIndex(advancedContextIndex)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              goNext();
            }
          }}
        />
      </>
    );
  };

  const review = useMemo(() => {
    if (!provider) return '';
    const envKey = provider.envKey ?? `${protocol.toUpperCase()}_API_KEY`;
    const normalizedIds = normalizeModelIds(models);
    const generationConfig: Record<string, unknown> = {};
    if (thinking) generationConfig['extra_body'] = { enable_thinking: true };
    if (modality) {
      const modalities: Record<string, boolean> = {};
      if (modalityImage) modalities['image'] = true;
      if (modalityVideo) modalities['video'] = true;
      if (modalityAudio) modalities['audio'] = true;
      if (modalityPdf) modalities['pdf'] = true;
      if (Object.keys(modalities).length > 0) {
        generationConfig['modalities'] = modalities;
      }
    }
    const ctxSize = Number(contextWindow);
    if (Number.isFinite(ctxSize) && ctxSize > 0) {
      generationConfig['contextWindowSize'] = ctxSize;
    }
    const hasGenerationConfig = Object.keys(generationConfig).length > 0;
    return JSON.stringify(
      {
        env: { [envKey]: maskApiKey(apiKey) },
        modelProviders: {
          [protocol]: normalizedIds.map((id) => ({
            id,
            name: id,
            baseUrl: baseUrl.trim(),
            envKey,
            ...(hasGenerationConfig ? { generationConfig } : {}),
          })),
        },
        security: { auth: { selectedType: protocol } },
        model: { name: normalizedIds[0] },
      },
      null,
      2,
    );
  }, [
    apiKey,
    baseUrl,
    contextWindow,
    modality,
    modalityAudio,
    modalityImage,
    modalityPdf,
    modalityVideo,
    models,
    protocol,
    provider,
    thinking,
  ]);

  return (
    <div className={styles.panel} data-keyboard-scope>
      <div className={styles.title}>
        {view === 'groups'
          ? t('auth.title')
          : view === 'providers'
            ? t(
                groups.find((group: AuthGroup) => group.id === groupId)
                  ?.label ?? '',
              )
            : provider && currentStep
              ? `${t(provider.uiLabels?.flowTitle ?? provider.label)} · ${t(
                  'auth.stepCount',
                  {
                    step: stepIndex + 1,
                    total: totalSteps,
                  },
                )} · ${titleForStep(currentStep, provider, t)}`
              : provider && view === 'review'
                ? `${t(provider.uiLabels?.flowTitle ?? provider.label)} · ${t(
                    'auth.stepCount',
                    {
                      step: totalSteps,
                      total: totalSteps,
                    },
                  )} · ${t('auth.review')}`
                : t('auth.review')}
      </div>
      {loading && <div className={styles.muted}>{t('common.loading')}</div>}
      {view === 'groups' &&
        !loading &&
        renderOptions(
          groups.map((group: AuthGroup) => ({
            value: group.id,
            label: t(group.label),
            description: t(group.description),
          })),
          groupIndex,
          setGroupIndex,
        )}
      {view === 'providers' &&
        renderOptions(
          providers.map((item: DaemonAuthProviderDescriptor) => ({
            value: item.id,
            label: t(item.label),
            description: t(item.description),
          })),
          providerIndex,
          setProviderIndex,
        )}
      {view === 'step' && renderStep()}
      {view === 'review' && (
        <>
          <div className={styles.text}>{t('auth.reviewText')}</div>
          <div className={styles.preview}>{review}</div>
        </>
      )}
      {error && <div className={styles.error}>{error}</div>}
      {view === 'groups' && !loading && (
        <div className={styles.terms}>
          <div>{t('auth.termsTitle')}:</div>
          <a
            className={styles.link}
            href="https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/"
            target="_blank"
            rel="noreferrer"
          >
            https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/
          </a>
        </div>
      )}
      {view !== 'groups' && (
        <div className={styles.footer}>
          {currentStep === 'advancedConfig'
            ? t('auth.footer.advanced')
            : view === 'review'
              ? saving
                ? t('auth.saving')
                : t('auth.footer.save')
              : isInputStep
                ? t('auth.footer.input')
                : t('auth.footer.back')}
        </div>
      )}
    </div>
  );
}
