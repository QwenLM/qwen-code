/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from 'react';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FolderIcon,
  InfoIcon,
  KeyRoundIcon,
  QrCodeIcon,
} from 'lucide-react';
import type {
  DaemonChannelConfigFieldDescriptor,
  DaemonChannelInstanceSnapshot,
  DaemonChannelTypeDescriptor,
  DaemonChannelUpsertRequest,
} from '@qwen-code/sdk/daemon';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../ui/field';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Spinner } from '../ui/spinner';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import { useI18n } from '../../i18n';
import {
  buildChannelUpsertRequest,
  channelCredentialPolicyFields,
  channelEditorNeedsQrHandoff,
  channelEditorWebhookSources,
  createChannelEditorState,
  selectChannelEditorType,
  SHARED_CHANNEL_FIELDS,
  updateChannelEditorField,
  updateSecretEditor,
  validateChannelEditor,
  type ChannelEditorState,
  type ChannelCredentialPolicyFields,
} from './channel-editor-state';
import {
  ChannelPairingManager,
  type ChannelPairingManagerProps,
} from './ChannelPairingManager';

export interface ChannelEditorQrHandoff {
  name: string;
  type: string;
  request: DaemonChannelUpsertRequest;
}

interface ChannelEditorDialogProps {
  open: boolean;
  catalog: readonly DaemonChannelTypeDescriptor[];
  expectedRevision: string;
  instance?: DaemonChannelInstanceSnapshot;
  initialName?: string;
  initialType?: string;
  workspaceCwd?: string;
  error?: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    name: string,
    request: DaemonChannelUpsertRequest,
  ) => Promise<boolean | void>;
  onQrHandoff?: (handoff: ChannelEditorQrHandoff) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  pairing?: Omit<ChannelPairingManagerProps, 'channelName'>;
}

const SECTION_FIELDS = [
  {
    key: 'identity',
    keys: ['identity.id', 'identity.displayName', 'identity.description'],
  },
  {
    key: 'modelWorkspace',
    keys: ['model', 'approvalMode', 'instructions'],
  },
  {
    key: 'messagingPolicies',
    keys: ['senderPolicy', 'allowedUsers', 'dmPolicy', 'groupPolicy'],
  },
  {
    key: 'routing',
    keys: ['sessionScope', 'dispatchMode', 'groupHistoryLimit'],
  },
  {
    key: 'streaming',
    keys: [
      'blockStreaming',
      'blockStreamingChunk.minChars',
      'blockStreamingChunk.maxChars',
      'blockStreamingCoalesce.idleMs',
    ],
  },
  { key: 'memory', keys: ['memoryScope.namespace'] },
  { key: 'webhooks', keys: ['webhooks'] },
] as const;

function fieldError(
  errors: ReturnType<typeof validateChannelEditor>,
  key: string,
): string | undefined {
  return errors.find((error) => error.field === key)?.message;
}

function localizeFieldError(
  message: string | undefined,
  label: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | undefined {
  if (!message) return undefined;
  if (message.endsWith(' is required. Enter a replacement credential.'))
    return t('channels.editor.validation.credentialRequired', { label });
  if (message === 'Replacement credentials cannot be empty.')
    return t('channels.editor.validation.replacementEmpty');
  if (message === 'Confirm that the stored credential should be cleared.')
    return t('channels.editor.validation.confirmClear');
  if (message.endsWith(' is required.'))
    return t('channels.editor.validation.required', { label });
  if (message.endsWith(' must be a number.'))
    return t('channels.editor.validation.number', { label });
  if (message.startsWith('Select a valid '))
    return t('channels.editor.validation.selectValid', { label });
  if (message === 'Webhooks must be a JSON object.')
    return t('channels.editor.validation.webhooksObject');
  if (message.startsWith('Webhook source ')) {
    return t('channels.editor.validation.webhookSource', {
      source: message.slice(
        'Webhook source '.length,
        -' is not allowed.'.length,
      ),
    });
  }
  if (message === 'Remove secretEnv before entering a literal secret.')
    return t('channels.editor.validation.removeSecretEnv');
  if (message === 'Enter a replacement webhook secret or restore secretEnv.')
    return t('channels.editor.validation.replaceWebhook');
  if (
    message === 'Enter a webhook secret, remove this source, or add secretEnv.'
  )
    return t('channels.editor.validation.webhookRequired');
  return message;
}

function ConfigField({
  descriptor,
  state,
  setState,
  errors,
  environmentReference,
}: {
  descriptor: DaemonChannelConfigFieldDescriptor;
  state: ChannelEditorState;
  setState: (state: ChannelEditorState) => void;
  errors: ReturnType<typeof validateChannelEditor>;
  environmentReference?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const rawError = fieldError(errors, descriptor.key);
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const translatedLabel = t(`channels.editor.field.${descriptor.key}`);
  const label = translatedLabel.startsWith('channels.editor.field.')
    ? descriptor.label
    : translatedLabel;
  const error = localizeFieldError(rawError, label, t);
  const describedBy = [
    descriptor.description || descriptor.envResolvable ? descriptionId : '',
    error ? errorId : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (descriptor.kind === 'secret') {
    const webhookSource = descriptor.key.startsWith('webhook:')
      ? descriptor.key.slice('webhook:'.length)
      : undefined;
    const secret = webhookSource
      ? state.webhookSecrets[webhookSource]
      : state.secrets[descriptor.key];
    if (!secret) return null;
    if (environmentReference) {
      return (
        <Field>
          <FieldLabel>{label}</FieldLabel>
          <FieldDescription>
            {t('channels.editor.secret.environmentReference', {
              reference: environmentReference,
            })}
          </FieldDescription>
        </Field>
      );
    }
    return (
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor={id}>
          {label}
          {descriptor.required ? <span aria-hidden="true">*</span> : null}
        </FieldLabel>
        <div className="flex flex-wrap gap-2">
          {secret.present ? (
            <Button
              type="button"
              size="sm"
              variant={
                secret.operation === 'preserve' ? 'secondary' : 'outline'
              }
              onClick={() =>
                setState(
                  updateSecretEditor(state, descriptor.key, {
                    operation: 'preserve',
                    value: '',
                  }),
                )
              }
            >
              {t('channels.editor.secret.keep')}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant={secret.operation === 'replace' ? 'secondary' : 'outline'}
            onClick={() =>
              setState(
                updateSecretEditor(state, descriptor.key, {
                  operation: 'replace',
                  value: '',
                }),
              )
            }
          >
            {secret.present
              ? t('channels.editor.secret.replace')
              : t('channels.editor.secret.enter')}
          </Button>
          {secret.present && !descriptor.required ? (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() =>
                setState(
                  updateSecretEditor(state, descriptor.key, {
                    operation: 'clear',
                    value: '',
                    clearConfirmed: false,
                  }),
                )
              }
            >
              {t('channels.editor.secret.clear')}
            </Button>
          ) : null}
        </div>
        {secret.operation === 'replace' ? (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            value={secret.value}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy || undefined}
            onChange={(event) =>
              setState(
                updateSecretEditor(state, descriptor.key, {
                  operation: 'replace',
                  value: event.target.value,
                }),
              )
            }
          />
        ) : (
          <input
            id={id}
            type="password"
            value=""
            readOnly
            className="sr-only"
          />
        )}
        {secret.operation === 'clear' ? (
          <label className="flex items-start gap-2 rounded-lg border border-destructive/30 p-3 text-sm">
            <Checkbox
              checked={secret.clearConfirmed === true}
              onCheckedChange={(checked) =>
                setState(
                  updateSecretEditor(state, descriptor.key, {
                    operation: 'clear',
                    value: '',
                    clearConfirmed: checked === true,
                  }),
                )
              }
            />
            {t('channels.editor.secret.confirmClear', { label })}
          </label>
        ) : null}
        {descriptor.description || descriptor.envResolvable ? (
          <FieldDescription id={descriptionId}>
            {descriptor.description}
            {descriptor.envResolvable ? (
              <span> {t('channels.editor.environmentSupported')}</span>
            ) : null}
          </FieldDescription>
        ) : null}
        <FieldError id={errorId}>{error}</FieldError>
      </Field>
    );
  }

  const value = state.values[descriptor.key];
  const common = {
    id,
    'aria-invalid': Boolean(error),
    'aria-describedby': describedBy || undefined,
  };
  let control;
  if (descriptor.kind === 'boolean') {
    control = (
      <Switch
        {...common}
        checked={value === true}
        onCheckedChange={(checked) =>
          setState(updateChannelEditorField(state, descriptor.key, checked))
        }
      />
    );
  } else if (descriptor.kind === 'enum') {
    control = (
      <Select
        value={typeof value === 'string' ? value : ''}
        onValueChange={(next) =>
          setState(updateChannelEditorField(state, descriptor.key, next))
        }
      >
        <SelectTrigger {...common} className="w-full">
          <SelectValue
            placeholder={t('channels.editor.selectField', { label })}
          />
        </SelectTrigger>
        <SelectContent>
          {descriptor.options?.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {(() => {
                const translated = t(
                  `channels.editor.option.${descriptor.key}.${option.value}`,
                );
                return translated.startsWith('channels.editor.option.')
                  ? option.label
                  : translated;
              })()}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (
    descriptor.key === 'webhooks' ||
    descriptor.key === 'instructions'
  ) {
    control = (
      <Textarea
        {...common}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) =>
          setState(
            updateChannelEditorField(state, descriptor.key, event.target.value),
          )
        }
      />
    );
  } else {
    control = (
      <Input
        {...common}
        type={descriptor.kind === 'number' ? 'number' : 'text'}
        value={
          typeof value === 'string' || typeof value === 'number' ? value : ''
        }
        onChange={(event) =>
          setState(
            updateChannelEditorField(state, descriptor.key, event.target.value),
          )
        }
      />
    );
  }
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>
        {label}
        {descriptor.required ? <span aria-hidden="true">*</span> : null}
      </FieldLabel>
      {control}
      {descriptor.description || descriptor.envResolvable ? (
        <FieldDescription id={descriptionId}>
          {descriptor.description}
          {descriptor.envResolvable ? (
            <span> {t('channels.editor.environmentSupported')}</span>
          ) : null}
        </FieldDescription>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

const CREDENTIAL_POLICY_UI = {
  dingtalk: {
    title: 'channels.dingtalk.title',
    description: 'channels.dingtalk.description',
    idLabel: 'channels.dingtalk.clientId',
    idPlaceholder: 'channels.dingtalk.clientIdPlaceholder',
    secretLabel: 'channels.dingtalk.clientSecret',
    secretPlaceholder: 'channels.dingtalk.clientSecretPlaceholder',
    secretStored: 'channels.dingtalk.clientSecretStored',
    docsUrl: 'https://open-dev.dingtalk.com/',
  },
  feishu: {
    title: 'channels.feishu.title',
    description: 'channels.feishu.description',
    idLabel: 'channels.feishu.appId',
    idPlaceholder: 'channels.feishu.appIdPlaceholder',
    secretLabel: 'channels.feishu.appSecret',
    secretPlaceholder: 'channels.feishu.appSecretPlaceholder',
    secretStored: 'channels.feishu.appSecretStored',
    docsUrl: 'https://open.feishu.cn/app',
  },
  wecom: {
    title: 'channels.wecom.title',
    description: 'channels.wecom.description',
    idLabel: 'channels.wecom.botId',
    idPlaceholder: 'channels.wecom.botIdPlaceholder',
    secretLabel: 'channels.wecom.botSecret',
    secretPlaceholder: 'channels.wecom.botSecretPlaceholder',
    secretStored: 'channels.wecom.botSecretStored',
    docsUrl: 'https://developer.work.weixin.qq.com/',
  },
} as const;

type CredentialPolicyType = keyof typeof CREDENTIAL_POLICY_UI;

function CredentialPolicyEditorFields({
  state,
  setState,
  errors,
  credentialRef,
  credentialFields,
  platformType,
  pairingManager,
}: {
  state: ChannelEditorState;
  setState: (state: ChannelEditorState) => void;
  errors: ReturnType<typeof validateChannelEditor>;
  credentialRef: RefObject<HTMLInputElement | null>;
  credentialFields: ChannelCredentialPolicyFields;
  platformType: CredentialPolicyType;
  pairingManager?: ReactNode;
}) {
  const { t } = useI18n();
  const ui = CREDENTIAL_POLICY_UI[platformType];
  const credentialError = localizeFieldError(
    fieldError(errors, credentialFields.id),
    t(ui.idLabel),
    t,
  );
  const secretError = localizeFieldError(
    fieldError(errors, credentialFields.secret),
    t(ui.secretLabel),
    t,
  );
  const secret = state.secrets[credentialFields.secret];
  const policy = state.values.senderPolicy;
  const id = `${platformType}-credential-id`;
  const secretId = `${platformType}-credential-secret`;

  return (
    <FieldGroup className="gap-6">
      <Field data-invalid={Boolean(credentialError)}>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel htmlFor={id}>{t(ui.idLabel)}</FieldLabel>
          <a
            className="inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={ui.docsUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t('channels.credentialPolicy.docs')}
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </a>
        </div>
        <Input
          ref={credentialRef}
          id={id}
          value={String(state.values[credentialFields.id] ?? '')}
          placeholder={t(ui.idPlaceholder)}
          aria-invalid={Boolean(credentialError)}
          onChange={(event) =>
            setState(
              updateChannelEditorField(
                state,
                credentialFields.id,
                event.target.value,
              ),
            )
          }
        />
        <FieldError>{credentialError}</FieldError>
      </Field>

      <Field data-invalid={Boolean(secretError)}>
        <FieldLabel htmlFor={secretId}>{t(ui.secretLabel)}</FieldLabel>
        <Input
          id={secretId}
          type="password"
          autoComplete="new-password"
          value={secret?.operation === 'replace' ? secret.value : ''}
          placeholder={
            secret?.present ? t(ui.secretStored) : t(ui.secretPlaceholder)
          }
          aria-invalid={Boolean(secretError)}
          onChange={(event) =>
            setState(
              updateSecretEditor(state, credentialFields.secret, {
                operation:
                  event.target.value || !secret?.present
                    ? 'replace'
                    : 'preserve',
                value: event.target.value,
              }),
            )
          }
        />
        <FieldError>{secretError}</FieldError>
      </Field>

      <FieldSet>
        <FieldLegend>{t('channels.credentialPolicy.accessPolicy')}</FieldLegend>
        <div className="grid gap-3">
          {(['pairing', 'open'] as const).map((option) => {
            const selected = policy === option;
            return (
              <Fragment key={option}>
                <button
                  type="button"
                  aria-pressed={selected}
                  className={[
                    'flex min-h-14 items-center justify-between gap-4 rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-accent',
                  ].join(' ')}
                  onClick={() =>
                    setState(
                      updateChannelEditorField(state, 'senderPolicy', option),
                    )
                  }
                >
                  <span>
                    <span className="font-semibold">
                      {t(`channels.credentialPolicy.${option}.title`)}
                    </span>{' '}
                    <span className="text-sm text-muted-foreground">
                      {t(`channels.credentialPolicy.${option}.summary`)}
                    </span>
                  </span>{' '}
                  {selected ? (
                    <CheckCircle2Icon
                      className="size-5 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
                {option === 'pairing' && selected ? pairingManager : null}
              </Fragment>
            );
          })}
        </div>
        {policy === 'pairing' ? (
          <div className="flex gap-3 rounded-xl bg-muted/60 p-4 text-sm leading-6 text-muted-foreground">
            <InfoIcon className="mt-1 size-4 shrink-0" aria-hidden="true" />
            <p>{t('channels.credentialPolicy.pairing.description')}</p>
          </div>
        ) : null}
      </FieldSet>
    </FieldGroup>
  );
}

export function ChannelEditorDialog({
  open,
  catalog,
  expectedRevision,
  instance,
  initialName,
  initialType,
  workspaceCwd,
  error,
  onOpenChange,
  onSubmit,
  onQrHandoff,
  returnFocusRef,
  pairing,
}: ChannelEditorDialogProps) {
  const { t } = useI18n();
  const manageableCatalog = useMemo(
    () => catalog.filter((descriptor) => descriptor.manageable),
    [catalog],
  );
  const [state, setState] = useState(() =>
    createChannelEditorState({
      catalog,
      expectedRevision,
      instance,
      name: initialName,
      type: initialType,
    }),
  );
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const credentialRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setState(
      createChannelEditorState({
        catalog,
        expectedRevision,
        instance,
        name: initialName,
        type: initialType,
      }),
    );
    setSaving(false);
  }, [catalog, expectedRevision, initialName, initialType, instance, open]);

  const descriptor = manageableCatalog.find((item) => item.type === state.type);
  const credentialFields = channelCredentialPolicyFields(descriptor);
  const credentialPolicyType = credentialFields
    ? (descriptor?.type as CredentialPolicyType)
    : undefined;
  const credentialPolicyUi = credentialPolicyType
    ? CREDENTIAL_POLICY_UI[credentialPolicyType]
    : undefined;
  const errors = validateChannelEditor(state);
  const nameError = fieldError(errors, 'name')
    ? t('channels.editor.validation.name')
    : undefined;
  const typeError = fieldError(errors, 'type')
    ? t('channels.editor.validation.type')
    : undefined;

  const submit = async () => {
    if (errors.length > 0 || saving) return;
    const request = buildChannelUpsertRequest(state);
    setSaving(true);
    try {
      const submitted = await onSubmit(state.name, request);
      if (submitted === false) return;
      if (channelEditorNeedsQrHandoff(state)) {
        onQrHandoff?.({ name: state.name, type: state.type, request });
      }
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent
        className={`max-h-[min(88vh,760px)] grid-rows-[auto_minmax(0,1fr)_auto] ${credentialPolicyUi ? 'sm:max-w-xl' : 'sm:max-w-2xl'}`}
        onOpenAutoFocus={(event) => {
          if (credentialPolicyUi) {
            event.preventDefault();
            credentialRef.current?.focus();
            return;
          }
          if (instance) return;
          event.preventDefault();
          nameRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current) return;
          event.preventDefault();
          returnFocusRef.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {credentialPolicyUi
              ? t(credentialPolicyUi.title)
              : instance
                ? t('channels.editor.title.edit', { name: instance.name })
                : descriptor
                  ? t('channels.editor.title.connect', {
                      type: descriptor.displayName,
                    })
                  : t('channels.editor.title.add')}
          </DialogTitle>
          <DialogDescription>
            {t(
              credentialPolicyUi
                ? credentialPolicyUi.description
                : 'channels.editor.description',
            )}
          </DialogDescription>
          {workspaceCwd ? (
            <div
              className="mt-2 flex items-start gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 text-left"
              aria-label={t('channels.editor.currentWorkspace')}
            >
              <FolderIcon
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">
                  {t('channels.editor.currentWorkspace')}
                </p>
                <p
                  className="truncate text-xs text-muted-foreground"
                  title={workspaceCwd}
                >
                  {workspaceCwd}
                </p>
              </div>
            </div>
          ) : null}
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto pr-1">
          {error ? (
            <Alert variant="destructive" className="mb-6">
              <AlertCircleIcon />
              <AlertTitle>{t('channels.editor.saveError')}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {credentialPolicyType && credentialFields ? (
            <CredentialPolicyEditorFields
              state={state}
              setState={setState}
              errors={errors}
              credentialRef={credentialRef}
              credentialFields={credentialFields}
              platformType={credentialPolicyType}
              pairingManager={
                instance && pairing ? (
                  <ChannelPairingManager
                    channelName={instance.name}
                    {...pairing}
                  />
                ) : undefined
              }
            />
          ) : (
            <FieldGroup className="gap-6">
              <FieldSet>
                <FieldLegend>{t('channels.editor.channel')}</FieldLegend>
                <Field data-invalid={Boolean(nameError)}>
                  <FieldLabel htmlFor="channel-editor-name">
                    {t('channels.editor.name')}
                  </FieldLabel>
                  <Input
                    ref={nameRef}
                    id="channel-editor-name"
                    value={state.name}
                    disabled={state.mode === 'edit'}
                    aria-invalid={Boolean(nameError)}
                    aria-describedby={
                      nameError ? 'channel-editor-name-error' : undefined
                    }
                    onChange={(event) =>
                      setState({ ...state, name: event.target.value })
                    }
                  />
                  {state.mode === 'edit' ? (
                    <FieldDescription>
                      {t('channels.editor.nameImmutable')}
                    </FieldDescription>
                  ) : initialName ? (
                    <FieldDescription>
                      {t('channels.editor.nameGenerated')}
                    </FieldDescription>
                  ) : null}
                  <FieldError id="channel-editor-name-error">
                    {nameError}
                  </FieldError>
                </Field>
                {!initialType || state.mode === 'edit' ? (
                  <Field data-invalid={Boolean(typeError)}>
                    <FieldLabel htmlFor="channel-editor-type">
                      {t('channels.editor.type')} *
                    </FieldLabel>
                    <Select
                      value={state.type}
                      disabled={state.mode === 'edit'}
                      onValueChange={(type) =>
                        setState(selectChannelEditorType(state, type))
                      }
                    >
                      <SelectTrigger
                        id="channel-editor-type"
                        className="w-full"
                        aria-invalid={Boolean(typeError)}
                      >
                        <SelectValue
                          placeholder={t('channels.editor.selectType')}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {manageableCatalog.map((item) => (
                          <SelectItem key={item.type} value={item.type}>
                            {item.displayName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {state.mode === 'edit' ? (
                      <FieldDescription>
                        {t('channels.editor.typeImmutable')}
                      </FieldDescription>
                    ) : null}
                    <FieldError>{typeError}</FieldError>
                  </Field>
                ) : null}
              </FieldSet>

              {descriptor?.auth.includes('qr') &&
              descriptor.auth.includes('credentials') ? (
                <FieldSet>
                  <FieldLegend>
                    {t('channels.editor.authentication')}
                  </FieldLegend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button
                      type="button"
                      variant={
                        state.authMethod === 'credentials'
                          ? 'secondary'
                          : 'outline'
                      }
                      onClick={() =>
                        setState({ ...state, authMethod: 'credentials' })
                      }
                    >
                      <KeyRoundIcon /> {t('channels.editor.enterCredentials')}
                    </Button>
                    <Button
                      type="button"
                      variant={
                        state.authMethod === 'qr' ? 'secondary' : 'outline'
                      }
                      onClick={() => setState({ ...state, authMethod: 'qr' })}
                    >
                      <QrCodeIcon /> {t('channels.editor.continueQr')}
                    </Button>
                  </div>
                  {state.authMethod === 'qr' ? (
                    <FieldDescription>
                      {t('channels.editor.qrGuidance')}
                    </FieldDescription>
                  ) : null}
                </FieldSet>
              ) : null}

              {descriptor &&
              state.authMethod === 'credentials' &&
              descriptor.fields.length > 0 ? (
                <FieldSet>
                  <FieldLegend>
                    {t('channels.editor.typeSettings', {
                      type: descriptor.displayName,
                    })}
                  </FieldLegend>
                  {descriptor.fields.map((field) => (
                    <ConfigField
                      key={field.key}
                      descriptor={field}
                      state={state}
                      setState={setState}
                      errors={errors}
                    />
                  ))}
                </FieldSet>
              ) : null}

              {SECTION_FIELDS.map((section) => (
                <details
                  key={section.key}
                  className="group rounded-lg border p-3"
                >
                  <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                    {t(`channels.editor.section.${section.key}`)}
                  </summary>
                  <FieldGroup className="mt-4">
                    {section.keys.map((key) => {
                      const field = SHARED_CHANNEL_FIELDS.find(
                        (item) => item.key === key,
                      )!;
                      return (
                        <ConfigField
                          key={field.key}
                          descriptor={field}
                          state={state}
                          setState={setState}
                          errors={errors}
                        />
                      );
                    })}
                    {section.key === 'webhooks'
                      ? channelEditorWebhookSources(state).map((source) => (
                          <ConfigField
                            key={source.name}
                            descriptor={{
                              key: `webhook:${source.name}`,
                              label: t('channels.editor.webhookSecret', {
                                source: source.name,
                              }),
                              kind: 'secret',
                              description: t(
                                'channels.editor.webhookSecretDescription',
                              ),
                            }}
                            state={state}
                            setState={setState}
                            errors={errors}
                            environmentReference={source.secretEnv}
                          />
                        ))
                      : null}
                  </FieldGroup>
                </details>
              ))}
            </FieldGroup>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            {t('channels.action.cancel')}
          </Button>
          <Button
            type="button"
            disabled={errors.length > 0 || saving}
            onClick={() => void submit()}
          >
            {saving ? <Spinner /> : null}
            {credentialPolicyUi
              ? t('channels.action.save')
              : instance
                ? t('channels.action.saveChanges')
                : channelEditorNeedsQrHandoff(state)
                  ? t('channels.action.saveAndContinue')
                  : t('channels.action.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
