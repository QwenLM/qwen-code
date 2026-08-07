/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { CheckCircle2Icon, KeyRoundIcon } from 'lucide-react';
import type {
  DaemonChannelConfigFieldDescriptor,
  DaemonChannelInstanceSnapshot,
  DaemonChannelPairingApprovalResult,
  DaemonChannelPairingApprovalsSnapshot,
  DaemonChannelPairingRequestsSnapshot,
  DaemonChannelPairingRevocationRequest,
  DaemonChannelPairingRevocationResult,
  DaemonChannelTypeDescriptor,
  DaemonChannelUpsertRequest,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Spinner } from '../ui/spinner';
import { Switch } from '../ui/switch';
import styles from './ChannelEditorDialog.module.css';
import { ChannelPairingRequests } from './ChannelPairingRequests';
import {
  buildChannelUpsertRequest,
  createChannelEditorDraft,
  hasDescriptorSenderPolicy,
  validateChannelEditorDraft,
  type ChannelEditorDraft,
  type ChannelEditorValidationCode,
} from './channel-editor-state';
import { PLATFORM_MARKS } from './channel-platform';

const FIELD_LABEL_KEYS: Record<string, Record<string, string>> = {
  dingtalk: {
    clientId: 'channels.editor.field.dingtalk.clientId',
    clientSecret: 'channels.editor.field.dingtalk.clientSecret',
  },
  wecom: {
    botId: 'channels.editor.field.wecom.botId',
    secret: 'channels.editor.field.wecom.secret',
    wsUrl: 'channels.editor.field.wecom.wsUrl',
  },
  feishu: {
    clientId: 'channels.editor.field.feishu.clientId',
    clientSecret: 'channels.editor.field.feishu.clientSecret',
  },
  github: {
    token: 'channels.editor.field.github.token',
    useLocalGh: 'channels.editor.field.github.useLocalGh',
    baseUrl: 'channels.editor.field.github.baseUrl',
    groupPolicy: 'channels.editor.field.github.groupPolicy',
    senderPolicy: 'channels.editor.field.github.senderPolicy',
    allowedUsers: 'channels.editor.field.github.allowedUsers',
    reasonFilter: 'channels.editor.field.github.reasonFilter',
  },
  gitlab: {
    token: 'channels.editor.field.gitlab.token',
    baseUrl: 'channels.editor.field.gitlab.baseUrl',
    groupPolicy: 'channels.editor.field.gitlab.groupPolicy',
    senderPolicy: 'channels.editor.field.gitlab.senderPolicy',
    allowedUsers: 'channels.editor.field.gitlab.allowedUsers',
    action_prompt_template:
      'channels.editor.field.gitlab.action_prompt_template',
  },
};

export interface ChannelEditorDialogProps {
  open: boolean;
  descriptor: DaemonChannelTypeDescriptor;
  instance?: DaemonChannelInstanceSnapshot;
  expectedRevision: string;
  existingNames: readonly string[];
  onOpenChange: (open: boolean) => void;
  onSave: (
    name: string,
    request: DaemonChannelUpsertRequest,
  ) => Promise<unknown>;
  onReload: () => Promise<unknown>;
  listPairingRequests: (
    name: string,
  ) => Promise<DaemonChannelPairingRequestsSnapshot>;
  approvePairingRequest: (
    name: string,
    code: string,
  ) => Promise<DaemonChannelPairingApprovalResult>;
  listPairingApprovals: (
    name: string,
  ) => Promise<DaemonChannelPairingApprovalsSnapshot>;
  revokePairingApproval: (
    name: string,
    request: DaemonChannelPairingRevocationRequest,
  ) => Promise<DaemonChannelPairingRevocationResult>;
}

function configuredAllowedUsers(instance?: DaemonChannelInstanceSnapshot) {
  const value = instance?.config['allowedUsers'];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function FieldShell({
  id,
  label,
  required,
  hint,
  description,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  description?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <div className={styles.fieldHeader}>
        <Label htmlFor={id}>
          {label}
          {required ? (
            <span className={styles.required} aria-hidden="true">
              *
            </span>
          ) : null}
        </Label>
        {hint ? <span className={styles.hint}>{hint}</span> : null}
      </div>
      {children}
      {description ? (
        <p className={styles.fieldDescription}>{description}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ChannelEditorDialog({
  open,
  descriptor,
  instance,
  expectedRevision,
  existingNames,
  onOpenChange,
  onSave,
  onReload,
  listPairingRequests,
  approvePairingRequest,
  listPairingApprovals,
  revokePairingApproval,
}: ChannelEditorDialogProps) {
  const { t } = useI18n();
  const formId = useId();
  const [draft, setDraft] = useState<ChannelEditorDraft>(() =>
    createChannelEditorDraft(descriptor, instance),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(createChannelEditorDraft(descriptor, instance));
    setErrors({});
    setSubmitError(undefined);
  }, [descriptor, instance, open]);

  const fieldLabel = (field: DaemonChannelConfigFieldDescriptor) => {
    const key = FIELD_LABEL_KEYS[descriptor.type]?.[field.key];
    return key ? t(key) : field.label;
  };

  const fieldDescription = (field: DaemonChannelConfigFieldDescriptor) => {
    const labelKey = FIELD_LABEL_KEYS[descriptor.type]?.[field.key];
    if (labelKey) {
      const descKey = `${labelKey}.description`;
      const translated = t(descKey);
      if (translated !== descKey) return translated;
    }
    return field.description;
  };

  const validationMessage = (
    field: DaemonChannelConfigFieldDescriptor | undefined,
    code: ChannelEditorValidationCode,
  ) => {
    if (code === 'duplicate') return t('channels.editor.validation.duplicate');
    if (code === 'credential')
      return t('channels.editor.validation.credential');
    if (code === 'invalid') return t('channels.editor.validation.invalidName');
    if (code === 'invalidOption')
      return t('channels.editor.validation.invalidOption');
    if (code === 'number') return t('channels.editor.validation.number');
    if (code === 'outOfRange') {
      return t('channels.editor.validation.outOfRange', {
        min:
          field && field.kind === 'number' ? (field.exclusiveMinimum ?? 0) : 0,
      });
    }
    if (code === 'policy') return t('channels.editor.validation.policy');
    return t('channels.editor.validation.required', {
      label: field ? fieldLabel(field) : t('channels.editor.instanceName'),
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateChannelEditorDraft(
      descriptor,
      draft,
      existingNames,
    );
    if (Object.keys(validation).length > 0) {
      setErrors(
        Object.fromEntries(
          Object.entries(validation).map(([key, code]) => [
            key,
            validationMessage(
              descriptor.fields.find((field) => field.key === key),
              code,
            ),
          ]),
        ),
      );
      return;
    }
    setSaving(true);
    setSubmitError(undefined);
    try {
      await onSave(
        draft.name.trim(),
        buildChannelUpsertRequest(
          descriptor,
          draft,
          expectedRevision,
          instance,
        ),
      );
      onOpenChange(false);
    } catch (error) {
      setSubmitError(extractErrorDetail(error));
    } finally {
      setSaving(false);
    }
  };

  const reloadLatest = async () => {
    setReloading(true);
    try {
      await onReload();
      onOpenChange(false);
    } catch (error) {
      setSubmitError(extractErrorDetail(error));
    } finally {
      setReloading(false);
    }
  };

  const renderSecret = (field: DaemonChannelConfigFieldDescriptor) => {
    const id = `${formId}-${field.key}`;
    const stored = instance?.secrets[field.key];
    const secret = draft.secrets[field.key] ?? {
      operation: 'replace' as const,
      value: '',
    };
    const error = errors[field.key];
    const showInput = secret.operation === 'replace';
    const operations = field.required
      ? (['preserve', 'replace'] as const)
      : (['preserve', 'replace', 'clear'] as const);
    return (
      <FieldShell
        key={field.key}
        id={id}
        label={fieldLabel(field)}
        required={field.required}
        description={fieldDescription(field)}
        hint={
          field.envResolvable
            ? t('channels.editor.environmentReference')
            : undefined
        }
        error={error}
      >
        {stored?.present ? (
          <div className={styles.secretState}>
            <span className={styles.secretStatus}>
              <CheckCircle2Icon size={15} />
              {stored.source === 'environment'
                ? t('channels.editor.secret.environment')
                : t('channels.editor.secret.stored')}
            </span>
            <div className={styles.secretActions}>
              {operations.map((operation) => (
                <Button
                  key={operation}
                  type="button"
                  size="xs"
                  variant={
                    secret.operation === operation ? 'secondary' : 'ghost'
                  }
                  aria-pressed={secret.operation === operation}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      secrets: {
                        ...current.secrets,
                        [field.key]:
                          operation === 'replace'
                            ? { operation, value: '' }
                            : { operation },
                      },
                    }))
                  }
                >
                  {t(`channels.editor.secret.${operation}`)}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        {showInput ? (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            value={secret.value ?? ''}
            aria-invalid={Boolean(error)}
            aria-required={field.required}
            placeholder={t('channels.editor.secret.placeholder', {
              label: fieldLabel(field),
            })}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                secrets: {
                  ...current.secrets,
                  [field.key]: {
                    operation: 'replace',
                    value: event.target.value,
                  },
                },
              }))
            }
          />
        ) : null}
        {secret.operation === 'clear' ? (
          <p className={styles.hint}>{t('channels.editor.secret.clearHint')}</p>
        ) : null}
      </FieldShell>
    );
  };

  const renderField = (field: DaemonChannelConfigFieldDescriptor) => {
    if (field.kind === 'object') return null;
    if (field.kind === 'secret') return renderSecret(field);
    const id = `${formId}-${field.key}`;
    const value = draft.values[field.key];
    const error = errors[field.key];
    const update = (next: string | boolean) =>
      setDraft((current) => ({
        ...current,
        values: { ...current.values, [field.key]: next },
      }));
    if (field.kind === 'boolean') {
      return (
        <FieldShell
          key={field.key}
          id={id}
          label={fieldLabel(field)}
          required={field.required}
          description={fieldDescription(field)}
          error={error}
        >
          <Switch
            id={id}
            checked={value === true}
            aria-required={field.required}
            onCheckedChange={(checked) => update(checked)}
          />
        </FieldShell>
      );
    }
    if (field.kind === 'enum') {
      return (
        <FieldShell
          key={field.key}
          id={id}
          label={fieldLabel(field)}
          required={field.required}
          description={fieldDescription(field)}
          error={error}
        >
          <Select value={String(value ?? '')} onValueChange={update}>
            <SelectTrigger
              id={id}
              className="w-full"
              aria-required={field.required}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {field.options?.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldShell>
      );
    }
    if (field.kind === 'record') {
      let record: Record<string, string> = {};
      if (typeof value === 'string' && value) {
        try {
          const parsed: unknown = JSON.parse(value);
          if (isRecord(parsed)) {
            record = parsed as Record<string, string>;
          }
        } catch {
          /* malformed — render empty */
        }
      }
      const updateRecord = (key: string, val: string) => {
        const next = { ...record, [key]: val };
        update(JSON.stringify(next));
      };
      return (
        <FieldShell
          key={field.key}
          id={id}
          label={fieldLabel(field)}
          required={field.required}
          description={fieldDescription(field)}
          error={error}
        >
          <div className={styles.recordFields}>
            {field.options?.map((option) => {
              const optKey = `${FIELD_LABEL_KEYS[descriptor.type]?.[field.key] ?? ''}.option.${option.value}`;
              const translated = t(optKey);
              const displayLabel =
                translated !== optKey ? translated : option.label;
              return (
                <div key={option.value} className={styles.recordRow}>
                  <Label
                    htmlFor={`${id}-${option.value}`}
                    className={styles.recordLabel}
                  >
                    {displayLabel}
                  </Label>
                  <Input
                    id={`${id}-${option.value}`}
                    value={record[option.value] ?? ''}
                    onChange={(event) =>
                      updateRecord(option.value, event.target.value)
                    }
                  />
                </div>
              );
            })}
          </div>
        </FieldShell>
      );
    }
    return (
      <FieldShell
        key={field.key}
        id={id}
        label={fieldLabel(field)}
        required={field.required}
        description={fieldDescription(field)}
        hint={
          field.envResolvable
            ? t('channels.editor.environmentReference')
            : undefined
        }
        error={error}
      >
        <Input
          id={id}
          type={field.kind === 'number' ? 'number' : 'text'}
          value={String(value ?? '')}
          aria-invalid={Boolean(error)}
          aria-required={field.required}
          onChange={(event) => update(event.target.value)}
        />
      </FieldShell>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] p-5 sm:max-w-xl">
        <DialogHeader>
          <div className={styles.platformHeader}>
            <span className={styles.platformMark} aria-hidden="true">
              {PLATFORM_MARKS[descriptor.type] ??
                descriptor.displayName[0]?.toUpperCase() ??
                '?'}
            </span>
            <div>
              <DialogTitle>
                {t(
                  instance
                    ? 'channels.editor.editTitle'
                    : 'channels.editor.addTitle',
                  { platform: descriptor.displayName },
                )}
              </DialogTitle>
              <DialogDescription className="mt-1">
                {t(
                  instance
                    ? 'channels.editor.editDescription'
                    : 'channels.editor.addDescription',
                )}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <form className={styles.form} onSubmit={submit}>
          <div className={styles.body}>
            {submitError ? (
              <Alert variant="destructive">
                <KeyRoundIcon />
                <AlertTitle>{t('channels.editor.saveError')}</AlertTitle>
                <AlertDescription>{submitError}</AlertDescription>
                <Button
                  className="mt-2 w-fit"
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={reloading}
                  onClick={() => void reloadLatest()}
                >
                  {reloading ? <Spinner /> : null}
                  {t('channels.editor.reloadLatest')}
                </Button>
              </Alert>
            ) : null}

            <section className={styles.section}>
              <h3 className={styles.sectionHeading}>
                {t('channels.editor.section.identity')}
              </h3>
              <FieldShell
                id={`${formId}-name`}
                label={t('channels.editor.instanceName')}
                required
                error={errors['name']}
              >
                <Input
                  id={`${formId}-name`}
                  value={draft.name}
                  disabled={Boolean(instance)}
                  aria-invalid={Boolean(errors['name'])}
                  aria-required
                  placeholder={t('channels.editor.instanceNamePlaceholder')}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </FieldShell>
            </section>

            <section className={styles.section}>
              <h3 className={styles.sectionHeading}>
                {t('channels.editor.section.credentials')}
              </h3>
              {descriptor.fields.map(renderField)}
            </section>

            {(() => {
              const descriptorPolicy = hasDescriptorSenderPolicy(descriptor);
              const effectivePolicy = descriptorPolicy
                ? String(draft.values['senderPolicy'] ?? '')
                : draft.senderPolicy;
              const showRadioGroup = !descriptorPolicy;
              const descriptorGroupPolicy = descriptor.fields.some(
                (field) => field.key === 'groupPolicy',
              );
              const effectiveGroupPolicy = descriptorGroupPolicy
                ? String(draft.values['groupPolicy'] ?? '')
                : String(instance?.config.groupPolicy ?? '');
              const showPairing =
                effectivePolicy === 'pairing' ||
                effectiveGroupPolicy === 'pairing';
              if (!showRadioGroup && !showPairing) return null;
              return (
                <section className={styles.section}>
                  <h3 className={styles.sectionHeading}>
                    {t('channels.editor.section.access')}
                  </h3>
                  {showRadioGroup ? (
                    <>
                      <RadioGroup
                        className={styles.policyGrid}
                        value={draft.senderPolicy}
                        aria-invalid={Boolean(errors['senderPolicy'])}
                        onValueChange={(value) =>
                          setDraft((current) => ({
                            ...current,
                            senderPolicy:
                              value === 'pairing' || value === 'open'
                                ? value
                                : '',
                          }))
                        }
                      >
                        {(['pairing', 'open'] as const).map((policy) => (
                          <Label
                            key={policy}
                            className={styles.policyCard}
                            data-selected={draft.senderPolicy === policy}
                          >
                            <RadioGroupItem value={policy} />
                            <span className={styles.policyCopy}>
                              <span className={styles.policyTitle}>
                                {t(`channels.editor.policy.${policy}.title`)}
                              </span>
                              <span className={styles.policyDescription}>
                                {t(
                                  `channels.editor.policy.${policy}.description`,
                                )}
                              </span>
                            </span>
                          </Label>
                        ))}
                      </RadioGroup>
                      {errors['senderPolicy'] ? (
                        <p role="alert" className="text-xs text-destructive">
                          {errors['senderPolicy']}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                  {showPairing ? (
                    instance?.config.senderPolicy === 'pairing' ||
                    instance?.config.groupPolicy === 'pairing' ? (
                      <ChannelPairingRequests
                        channelName={instance.name}
                        listRequests={listPairingRequests}
                        approveRequest={approvePairingRequest}
                        listApprovals={listPairingApprovals}
                        revokeApproval={revokePairingApproval}
                        staticAllowedUsers={configuredAllowedUsers(instance)}
                      />
                    ) : (
                      <Alert>
                        <KeyRoundIcon />
                        <AlertTitle>
                          {t('channels.editor.pairing.saveFirst.title')}
                        </AlertTitle>
                        <AlertDescription>
                          {t('channels.editor.pairing.saveFirst.description')}
                        </AlertDescription>
                      </Alert>
                    )
                  ) : null}
                </section>
              );
            })()}
          </div>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('channels.editor.cancel')}
            </Button>
            <Button type="submit" disabled={saving || reloading}>
              {saving ? <Spinner /> : null}
              {t('channels.editor.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
