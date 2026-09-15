import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  useDaemonSessionOwnerGuard,
  useWorkspaceActions,
  type DaemonAuthProviderBaseUrlOption,
  type DaemonAuthProviderCatalog,
  type DaemonAuthProviderDescriptor,
  type DaemonAuthProviderInstallRequest,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { useExternalLinkOpener } from '../../hooks/useExternalLinkOpener';
import { Checkbox } from '../ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '../ui/field';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { isVoiceModelId } from '../../voice/voiceModels';
import { Switch } from '../ui/switch';
import styles from './AuthMessage.module.css';

const TOS_PRIVACY_URL =
  'https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/';

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

function getProtocolOptions(
  t: (key: string, vars?: Record<string, string | number>) => string,
): Array<Option<string>> {
  return [
    {
      value: 'openai',
      label: t('auth.protocol.openai'),
      description: t('auth.protocol.openaiDesc'),
    },
    {
      value: 'anthropic',
      label: t('auth.protocol.anthropic'),
      description: t('auth.protocol.anthropicDesc'),
    },
    {
      value: 'gemini',
      label: t('auth.protocol.gemini'),
      description: t('auth.protocol.geminiDesc'),
    },
  ];
}

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

function invalidTokenLimit(value: string): boolean {
  return (
    value.trim() !== '' &&
    (!/^\d+$/.test(value.trim()) ||
      Number(value) < 1 ||
      Number(value) > 10_000_000)
  );
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
  const fieldId = useId();
  const openExternalLink = useExternalLinkOpener();
  const workspaceActions = useWorkspaceActions();
  const sessionOwnerGuard = useDaemonSessionOwnerGuard();
  const ownerRef = useRef(sessionOwnerGuard.capture());
  const ownerChanged = !ownerRef.current.isCurrent();
  if (ownerChanged) ownerRef.current = sessionOwnerGuard.capture();
  const saveOperationRef = useRef(0);
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
  const [purpose, setPurpose] = useState<'chat' | 'image' | 'voice'>('chat');
  const [contextWindow, setContextWindow] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const steps = useMemo(() => provider?.steps ?? [], [provider?.steps]);
  const currentStep = steps[stepIndex] as AuthStep | undefined;
  const shouldReview = provider?.showAdvancedConfig === true;
  const isInputStep =
    currentStep === 'apiKey' ||
    currentStep === 'models' ||
    (currentStep === 'baseUrl' && !Array.isArray(provider?.baseUrl));

  const [optionIndex, setOptionIndex] = useState(0);

  useEffect(() => {
    if (!ownerChanged) return;
    saveOperationRef.current += 1;
    setSaving(false);
    setError(null);
  }, [ownerChanged]);

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
      setPurpose('chat');
      setContextWindow('');
      setMaxTokens('');
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
      if (steps.length === 0) {
        setView(setupBackView);
        return;
      }
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

  const advancedConfig = useMemo<
    DaemonAuthProviderInstallRequest['advancedConfig']
  >(() => {
    if (!steps.includes('advancedConfig')) return undefined;
    const config: NonNullable<
      DaemonAuthProviderInstallRequest['advancedConfig']
    > = {
      replaceExisting: true,
      ...(purpose !== 'chat' ? { purpose } : {}),
      ...(purpose === 'chat' && thinking ? { enableThinking: true } : {}),
      ...(purpose === 'chat' && modality
        ? {
            multimodal: {
              ...(modalityImage ? { image: true } : {}),
              ...(modalityVideo ? { video: true } : {}),
              ...(modalityAudio ? { audio: true } : {}),
              ...(modalityPdf ? { pdf: true } : {}),
            },
          }
        : {}),
      ...(contextWindow.trim() && !invalidTokenLimit(contextWindow)
        ? { contextWindowSize: Number(contextWindow) }
        : {}),
      ...(purpose === 'chat' &&
      maxTokens.trim() &&
      !invalidTokenLimit(maxTokens)
        ? { maxTokens: Number(maxTokens) }
        : {}),
    };
    return config;
  }, [
    steps,
    purpose,
    thinking,
    modality,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindow,
    maxTokens,
  ]);

  const validateAdvanced = useCallback(() => {
    if (!steps.includes('advancedConfig')) return true;
    if (
      purpose === 'voice' &&
      (protocol !== 'openai' ||
        !normalizeModelIds(models).every(isVoiceModelId))
    ) {
      setError(t('auth.purpose.voiceHint'));
      return false;
    }
    if (purpose === 'image') {
      try {
        const url = new URL(baseUrl.trim());
        if (url.protocol !== 'https:' || url.search || url.hash)
          throw new Error();
      } catch {
        setError(t('auth.purpose.imageHint'));
        return false;
      }
    }
    for (const [value, label] of [
      [contextWindow, 'auth.advanced.contextWindow'],
      [purpose === 'chat' ? maxTokens : '', 'auth.advanced.maxTokens'],
    ]) {
      if (invalidTokenLimit(value)) {
        setError(t('auth.advanced.tokenLimitInvalid', { field: t(label) }));
        return false;
      }
    }
    if (
      purpose === 'chat' &&
      modality &&
      !modalityImage &&
      !modalityVideo &&
      !modalityAudio &&
      !modalityPdf
    ) {
      setError(t('auth.advanced.modalitiesRequired'));
      return false;
    }
    return true;
  }, [
    purpose,
    protocol,
    models,
    baseUrl,
    steps,
    contextWindow,
    maxTokens,
    modality,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    t,
  ]);

  const save = useCallback(() => {
    if (!provider || saving || !validateAdvanced()) return;
    const owner = ownerRef.current;
    const operation = ++saveOperationRef.current;
    const isCurrent = () =>
      saveOperationRef.current === operation && owner.isCurrent();
    setSaving(true);
    setError(null);
    workspaceActions
      .installAuthProvider({
        providerId: provider.id,
        protocol,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        modelIds: normalizeModelIds(models),
        advancedConfig,
      })
      .then((result) => {
        if (!isCurrent()) return;
        onMessage(
          result.runtimeSync?.status === 'failed'
            ? `${result.message}\n\n${t('settings.models.runtimeSyncFailed')}`
            : result.message,
        );
        onClose();
      })
      .catch((err: unknown) => {
        if (!isCurrent()) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        onMessage(message, 'error');
      })
      .finally(() => {
        if (isCurrent()) setSaving(false);
      });
  }, [
    apiKey,
    baseUrl,
    advancedConfig,
    validateAdvanced,
    models,
    onClose,
    onMessage,
    protocol,
    provider,
    saving,
    t,
    workspaceActions,
  ]);

  const goNext = useCallback(() => {
    if (!provider || saving) return;
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
    if (currentStep === 'advancedConfig' && !validateAdvanced()) return;
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
    saving,
    validateAdvanced,
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
    },
    [
      currentStep,
      catalog,
      goNext,
      groups,
      provider,
      providers,
      save,
      startProvider,
      view,
    ],
  );

  const renderOptions = <T extends string>(
    options: Array<Option<T>>,
    selected: number,
    onSelect: (index: number) => void,
  ) => (
    <div className={styles.options}>
      {options.map((option, index) => (
        <button
          type="button"
          key={option.value}
          disabled={saving}
          className={`${styles.option} ${selected === index ? styles.optionActive : ''}`}
          onClick={() => {
            onSelect(index);
            activateAtIndex(index);
          }}
        >
          <div className={styles.optionText}>
            <div className={styles.label}>{option.label}</div>
            {option.description && (
              <div className={styles.description}>{option.description}</div>
            )}
          </div>
        </button>
      ))}
    </div>
  );

  const renderStep = () => {
    if (!provider || !currentStep) return null;
    if (currentStep === 'protocol') {
      const allowed = provider.protocolOptions ?? [provider.protocol];
      return renderOptions(
        getProtocolOptions(t).filter((option) =>
          allowed.includes(option.value),
        ),
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
            aria-label={t('auth.step.baseUrl')}
            disabled={saving}
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
              onClick={(event) =>
                openExternalLink(event, provider.documentationUrl)
              }
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
              onClick={(event) =>
                openExternalLink(event, provider.documentationUrl)
              }
            >
              {t('auth.documentation')}: {provider.documentationUrl}
            </a>
          )}
          <input
            className={styles.input}
            type="password"
            value={apiKey}
            aria-label={t('auth.step.apiKey')}
            autoComplete="new-password"
            disabled={saving}
            placeholder={
              provider.apiKeyPlaceholder ?? t('auth.apiKeyPlaceholder')
            }
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
            aria-label={t('auth.step.models')}
            disabled={saving}
            placeholder={defaultIds || t('auth.modelsPlaceholder')}
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
    return (
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${fieldId}-purpose`}>
            {t('auth.purpose.label')}
          </FieldLabel>
          <Select
            value={purpose}
            disabled={saving}
            onValueChange={(value) => {
              setPurpose(value as typeof purpose);
              setError(null);
            }}
          >
            <SelectTrigger
              id={`${fieldId}-purpose`}
              aria-label={t('auth.purpose.label')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['chat', 'image', 'voice'] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`auth.purpose.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {purpose !== 'chat' && (
            <FieldDescription>
              {t(`auth.purpose.${purpose}Hint`)}
            </FieldDescription>
          )}
        </Field>

        <p className="text-sm text-muted-foreground">
          {t('auth.advanced.prompt')}
        </p>
        {purpose === 'chat' &&
          (
            [
              [
                'thinking',
                thinking,
                setThinking,
                'auth.advanced.thinking',
                'auth.advanced.thinkingDesc',
              ],
              [
                'modality',
                modality,
                setModality,
                'auth.advanced.modality',
                'auth.advanced.modalityDesc',
              ],
            ] as const
          ).map(([key, checked, setChecked, label, description]) => (
            <Field orientation="horizontal" key={key}>
              <FieldContent>
                <FieldLabel htmlFor={`${fieldId}-${key}`}>
                  {t(label)}
                </FieldLabel>
                <FieldDescription id={`${fieldId}-${key}-hint`}>
                  {t(description)}
                </FieldDescription>
              </FieldContent>
              <Switch
                id={`${fieldId}-${key}`}
                checked={checked}
                disabled={saving || purpose !== 'chat'}
                aria-label={t(label)}
                aria-describedby={`${fieldId}-${key}-hint`}
                onCheckedChange={(value) => {
                  setChecked(value);
                  setError(null);
                }}
              />
            </Field>
          ))}
        {purpose === 'chat' && modality && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {(
              [
                [
                  'image',
                  modalityImage,
                  setModalityImage,
                  'auth.advanced.modalityImage',
                ],
                [
                  'video',
                  modalityVideo,
                  setModalityVideo,
                  'auth.advanced.modalityVideo',
                ],
                [
                  'audio',
                  modalityAudio,
                  setModalityAudio,
                  'auth.advanced.modalityAudio',
                ],
                [
                  'pdf',
                  modalityPdf,
                  setModalityPdf,
                  'auth.advanced.modalityPdf',
                ],
              ] as const
            ).map(([key, checked, setChecked, label]) => (
              <Field orientation="horizontal" key={key}>
                <Checkbox
                  id={`${fieldId}-${key}`}
                  checked={checked}
                  disabled={saving || purpose !== 'chat'}
                  onCheckedChange={(value) => {
                    setChecked(value === true);
                    setError(null);
                  }}
                />
                <FieldLabel htmlFor={`${fieldId}-${key}`}>
                  {t(label)}
                </FieldLabel>
              </Field>
            ))}
          </div>
        )}
        <div className="grid gap-5 sm:grid-cols-2">
          {(
            [
              [
                'context',
                contextWindow,
                setContextWindow,
                'auth.advanced.contextWindow',
                'auth.advanced.contextDesc',
              ],
              [
                'output',
                maxTokens,
                setMaxTokens,
                'auth.advanced.maxTokens',
                'auth.advanced.maxTokensDesc',
              ],
            ] as const
          )
            .filter(([key]) => purpose === 'chat' || key === 'context')
            .map(([key, value, setValue, label, description]) => (
              <Field key={key} data-invalid={invalidTokenLimit(value)}>
                <FieldLabel htmlFor={`${fieldId}-${key}`}>
                  {t(label)}
                </FieldLabel>
                <Input
                  id={`${fieldId}-${key}`}
                  aria-label={t(label)}
                  inputMode="numeric"
                  value={value}
                  placeholder={t('common.auto')}
                  disabled={saving || (key === 'output' && purpose !== 'chat')}
                  aria-invalid={invalidTokenLimit(value)}
                  aria-describedby={`${fieldId}-${key}-hint`}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.stopPropagation();
                      goNext();
                    }
                  }}
                />
                <FieldDescription id={`${fieldId}-${key}-hint`}>
                  {invalidTokenLimit(value)
                    ? t('auth.advanced.tokenLimitInvalid', { field: t(label) })
                    : t(description)}
                </FieldDescription>
              </Field>
            ))}
        </div>
      </FieldGroup>
    );
  };

  const review = provider
    ? [
        [t('auth.step.provider'), t(provider.label)],
        [
          t('auth.step.protocol'),
          getProtocolOptions(t).find((option) => option.value === protocol)
            ?.label ?? protocol,
        ],
        [t('auth.step.baseUrl'), baseUrl.trim()],
        [
          t('auth.step.apiKey'),
          apiKey.trim() ? t('auth.apiKeySet') : t('auth.notSet'),
        ],
        [t('auth.step.models'), normalizeModelIds(models).join(', ')],
        ...(steps.includes('advancedConfig')
          ? [[t('auth.purpose.label'), t(`auth.purpose.${purpose}`)]]
          : []),
        ...(steps.includes('advancedConfig')
          ? [
              [
                t('auth.advanced.thinking'),
                advancedConfig?.enableThinking
                  ? t('common.enabled')
                  : t('auth.advanced.defaults'),
              ],
              [
                t('auth.advanced.modality'),
                (
                  [
                    ['image', 'auth.advanced.modalityImage'],
                    ['video', 'auth.advanced.modalityVideo'],
                    ['audio', 'auth.advanced.modalityAudio'],
                    ['pdf', 'auth.advanced.modalityPdf'],
                  ] as const
                )
                  .filter(([key]) => advancedConfig?.multimodal?.[key])
                  .map(([, label]) => t(label))
                  .join(', ') || t('auth.advanced.defaults'),
              ],
              [
                t('auth.advanced.contextWindow'),
                advancedConfig?.contextWindowSize ??
                  t('auth.advanced.defaults'),
              ],
              [
                t('auth.advanced.maxTokens'),
                advancedConfig?.maxTokens ?? t('auth.advanced.defaults'),
              ],
            ]
          : []),
      ]
    : [];

  const stepItems = useMemo(() => {
    const items = [t('auth.step.group'), t('auth.step.provider')];
    if (provider) {
      items.push(
        ...steps.map((step) => titleForStep(step as AuthStep, provider, t)),
      );
      if (shouldReview) items.push(t('auth.review'));
    }
    return items;
  }, [provider, shouldReview, steps, t]);

  const activeStep = useMemo(() => {
    if (view === 'groups') return 1;
    if (view === 'providers') return 2;
    if (view === 'step') return Math.min(3 + stepIndex, stepItems.length);
    return stepItems.length;
  }, [stepIndex, stepItems.length, view]);

  const body = (() => {
    if (loading)
      return <div className={styles.muted}>{t('common.loading')}</div>;
    if (view === 'groups') {
      return (
        <>
          {renderOptions(
            groups.map((group: AuthGroup) => ({
              value: group.id,
              label: t(group.label),
              description: t(group.description),
            })),
            groupIndex,
            setGroupIndex,
          )}
          <div className={styles.terms}>
            <div>{t('auth.termsTitle')}:</div>
            <a
              className={styles.link}
              href={TOS_PRIVACY_URL}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => openExternalLink(event, TOS_PRIVACY_URL)}
            >
              {TOS_PRIVACY_URL}
            </a>
          </div>
        </>
      );
    }
    if (view === 'providers') {
      return renderOptions(
        providers.map((item: DaemonAuthProviderDescriptor) => ({
          value: item.id,
          label: t(item.label),
          description: t(item.description),
        })),
        providerIndex,
        setProviderIndex,
      );
    }
    if (view === 'step') return renderStep();
    return (
      <>
        <div className={styles.text}>{t('auth.reviewText')}</div>
        <dl className="grid gap-3 rounded-lg border border-border bg-background p-4 text-sm">
          {review.map(([label, value]) => (
            <div
              key={label}
              className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-4"
            >
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="m-0 break-words [overflow-wrap:anywhere]">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {provider?.showAdvancedConfig && (
          <div className={styles.text}>{t(`auth.purpose.${purpose}Hint`)}</div>
        )}
      </>
    );
  })();

  const primaryAction = () => {
    if (view === 'review') {
      save();
      return;
    }
    if (isInputStep || currentStep === 'advancedConfig') {
      goNext();
      return;
    }
    activate();
  };

  return (
    <div className={styles.panel}>
      <div className={styles.steps}>
        {stepItems.map((label, index) => {
          const stepNumber = index + 1;
          return (
            <div
              key={`${stepNumber}:${label}`}
              className={`${styles.stepPill} ${
                stepNumber === activeStep ? styles.stepPillActive : ''
              } ${stepNumber < activeStep ? styles.stepPillDone : ''}`}
            >
              <span className={styles.stepNumber}>{stepNumber}</span>
              <span className={styles.stepLabel}>{label}</span>
            </div>
          );
        })}
      </div>
      <div className={styles.body}>{body}</div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.actionButton}
          onClick={goBack}
          disabled={view === 'groups' || loading || saving}
        >
          {t('common.previous')}
        </button>
        <button
          type="button"
          className={styles.actionButton}
          onClick={primaryAction}
          disabled={loading || saving}
        >
          {view === 'review'
            ? saving
              ? t('auth.saving')
              : t('auth.save')
            : t('common.next')}
        </button>
      </div>
    </div>
  );
}
