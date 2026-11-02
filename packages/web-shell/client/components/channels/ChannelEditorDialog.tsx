/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useEffect,
  useId,
  useRef,
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
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { extractErrorDetail } from '../../utils/errorDetail';
import { workspaceLabel } from '../../utils/workspace';
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
import { Textarea } from '../ui/textarea';
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
  defaultGroupSenders,
  hasDescriptorGroupPolicy,
  hasDescriptorPrivatePolicy,
  configuredPrivatePolicy,
  PRIVATE_ONLY_FIELD_KEYS,
  projectRepositoryGroup,
  repositoryAllowlistIds,
  toList,
  validateChannelEditorDraft,
  type ChannelEditorDraft,
  type ChannelSecretDraft,
  type ChannelEditorValidationCode,
  type ChannelGroupOverrideDraft,
  type ChannelGroupSenders,
} from './channel-editor-state';
import {
  isRepositoryOnlyChannelType,
  PLATFORM_MARKS,
} from './channel-platform';

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
  dws: {
    privatePolicy: 'channels.editor.field.dws.privatePolicy',
  },
  github: {
    token: 'channels.editor.field.github.token',
    useLocalGh: 'channels.editor.field.github.useLocalGh',
    baseUrl: 'channels.editor.field.github.baseUrl',
    pollInterval: 'channels.editor.field.github.pollInterval',
    groupPolicy: 'channels.editor.field.github.groupPolicy',
    reasonFilter: 'channels.editor.field.github.reasonFilter',
  },
  gitlab: {
    token: 'channels.editor.field.gitlab.token',
    baseUrl: 'channels.editor.field.gitlab.baseUrl',
    groupPolicy: 'channels.editor.field.gitlab.groupPolicy',
    action_prompt_template:
      'channels.editor.field.gitlab.action_prompt_template',
  },
};

const SHARED_ACCESS_FIELD_KEYS = new Set([
  'privatePolicy',
  'allowedUsers',
  'groupPolicy',
  'operators',
]);
const GROUP_SENDERS_OPTIONS = ['open', 'allowlist'] as const;
const SHARED_SESSION_FIELD_KEYS = new Set([
  'outputMode',
  'sessionScope',
  'multiSession',
  'instructions',
]);

const SHARED_FIELD_LABEL_KEYS: Record<string, string> = {
  outputMode: 'channels.editor.field.shared.outputMode',
  privatePolicy: 'channels.editor.field.shared.privatePolicy',
  allowedUsers: 'channels.editor.field.shared.allowedUsers',
  groupPolicy: 'channels.editor.field.shared.groupPolicy',
  operators: 'channels.editor.field.shared.operators',
  sessionScope: 'channels.editor.field.shared.sessionScope',
  multiSession: 'channels.editor.field.shared.multiSession',
  instructions: 'channels.editor.field.shared.instructions',
};

/** Per-platform placeholders that spell out the expected value shape. */
const FIELD_PLACEHOLDER_KEYS: Record<string, string> = {
  'github.baseUrl': 'https://ghe.example.com/api/v3',
};

const CONNECTION_FIELD_KEYS = new Set(['baseUrl', 'wsUrl', 'pollInterval']);
const ROUTING_FIELD_KEYS = new Set([
  'reasonFilter',
  'messageRoutes',
  'defaultMessageRoute',
]);

/** Every repository starts fully inheriting; nothing is materialized. */
const EMPTY_GROUP_OVERRIDE: ChannelGroupOverrideDraft = {
  requireMention: '',
  senders: '',
  allowedUsers: '',
};

function fieldSectionKey(
  field: DaemonChannelConfigFieldDescriptor,
): 'credentials' | 'connection' | 'routing' {
  if (CONNECTION_FIELD_KEYS.has(field.key)) return 'connection';
  if (ROUTING_FIELD_KEYS.has(field.key)) return 'routing';
  return 'credentials';
}

export interface ChannelEditorDialogProps {
  open: boolean;
  descriptor: DaemonChannelTypeDescriptor;
  instance?: DaemonChannelInstanceSnapshot;
  expectedRevision: string;
  existingNames: readonly string[];
  workspaces: readonly DaemonWorkspaceCapability[];
  workspaceCwd: string;
  workspaceLoading?: boolean;
  onWorkspaceChange: (workspaceCwd: string) => void;
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
  workspaces,
  workspaceCwd,
  workspaceLoading = false,
  onWorkspaceChange,
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
  const dismissedRef = useRef(false);
  /** The token draft as it stood before local gh auth overrode it. */
  const tokenBeforeLocalGh = useRef<ChannelSecretDraft | undefined>(undefined);
  const accessFields = descriptor.fields.filter((field) =>
    SHARED_ACCESS_FIELD_KEYS.has(field.key),
  );
  const sessionFields = descriptor.fields.filter((field) =>
    SHARED_SESSION_FIELD_KEYS.has(field.key),
  );
  const sessionScopeField = sessionFields.find(
    (field) => field.key === 'sessionScope' && field.kind === 'enum',
  );
  const sessionScopeOptions = (sessionScopeField?.options ?? []).filter(
    (option) =>
      option.value !== 'thread' ||
      instance?.config.sessionScope === 'thread' ||
      (instance !== undefined &&
        instance.config.sessionScope === undefined &&
        sessionScopeField?.default === 'thread'),
  );
  const remainingSessionFields = sessionFields.filter(
    (field) => field !== sessionScopeField,
  );
  const credentialFields = descriptor.fields.filter(
    (field) =>
      !SHARED_ACCESS_FIELD_KEYS.has(field.key) &&
      !SHARED_SESSION_FIELD_KEYS.has(field.key),
  );

  useEffect(() => {
    if (!open) return;
    dismissedRef.current = false;
    tokenBeforeLocalGh.current = undefined;
    setDraft(createChannelEditorDraft(descriptor, instance));
    setErrors({});
    setSubmitError(undefined);
  }, [descriptor, instance, open]);

  useEffect(() => {
    setErrors({});
    setSubmitError(undefined);
  }, [workspaceCwd]);

  const fieldLabel = (field: DaemonChannelConfigFieldDescriptor) => {
    const key =
      FIELD_LABEL_KEYS[descriptor.type]?.[field.key] ??
      SHARED_FIELD_LABEL_KEYS[field.key];
    return key ? t(key) : field.label;
  };

  const fieldDescription = (field: DaemonChannelConfigFieldDescriptor) => {
    const labelKey =
      FIELD_LABEL_KEYS[descriptor.type]?.[field.key] ??
      SHARED_FIELD_LABEL_KEYS[field.key];
    if (labelKey) {
      const descKey = `${labelKey}.description`;
      const translated = t(descKey);
      if (translated !== descKey) return translated;
    }
    return field.description;
  };

  const fieldOptionLabel = (
    field: DaemonChannelConfigFieldDescriptor,
    value: string,
    fallback: string,
  ) => {
    const labelKeys = [
      FIELD_LABEL_KEYS[descriptor.type]?.[field.key],
      SHARED_FIELD_LABEL_KEYS[field.key],
    ].filter((key): key is string => Boolean(key));
    for (const labelKey of labelKeys) {
      const optionKey = `${labelKey}.option.${value}`;
      const translated = t(optionKey);
      if (translated !== optionKey) return translated;
    }
    return fallback;
  };

  const validationMessage = (
    field: DaemonChannelConfigFieldDescriptor | undefined,
    code: ChannelEditorValidationCode,
  ) => {
    if (code === 'duplicate') return t('channels.editor.validation.duplicate');
    if (code === 'credential')
      return t('channels.editor.validation.credential');
    if (code === 'invalid') return t('channels.editor.validation.invalidName');
    if (code === 'invalidGroupId')
      return t('channels.editor.validation.invalidGroupId');
    if (code === 'invalidRepoId')
      return t('channels.editor.validation.invalidRepoId');
    if (code === 'conflictingRepoAliases')
      return t('channels.editor.validation.conflictingRepoAliases');
    if (code === 'invalidOption')
      return t('channels.editor.validation.invalidOption');
    if (code === 'number') return t('channels.editor.validation.number');
    if (code === 'outOfRange') {
      const numberField = field && field.kind === 'number' ? field : undefined;
      return t('channels.editor.validation.outOfRange', {
        min: numberField?.exclusiveMinimum ?? 0,
        ...(numberField?.maximum !== undefined
          ? { max: numberField.maximum }
          : {}),
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
      instance,
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
      if (!dismissedRef.current) onOpenChange(false);
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
    // The GitHub channel reads a token before local gh auth, so an editable
    // token while local gh is selected would silently win over the switch.
    const lockedByLocalGh =
      field.key === 'token' &&
      isRepositoryOnlyChannelType(descriptor.type) &&
      draft.values['useLocalGh'] === true;
    const showInput = secret.operation === 'replace' && !lockedByLocalGh;
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
          lockedByLocalGh
            ? t('channels.editor.field.github.token.localGhHint')
            : field.envResolvable
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
                  disabled={lockedByLocalGh}
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
        values: {
          ...current.values,
          [field.key]: next,
          ...(field.key === 'multiSession' && next === true
            ? { sessionScope: 'user' }
            : {}),
        },
      }));
    if (field.kind === 'boolean') {
      const isLocalGhSwitch =
        field.key === 'useLocalGh' &&
        isRepositoryOnlyChannelType(descriptor.type);
      const updateSwitch = (checked: boolean) => {
        if (!isLocalGhSwitch) {
          update(checked);
          return;
        }
        // Read both outside the updater: it runs lazily during the next
        // render, by which point the ref below has already been reassigned.
        const tokenBeforeToggle = draft.secrets['token'];
        const tokenToRestore = tokenBeforeLocalGh.current;
        setDraft((current) => {
          const secrets = { ...current.secrets };
          if (checked) {
            const hasToken =
              instance?.secrets['token']?.present === true ||
              Boolean(current.secrets['token']?.value?.trim());
            // A stored token outranks local gh auth; clear it so the switch
            // actually takes effect when the draft is saved.
            if (hasToken) secrets['token'] = { operation: 'clear' };
          } else if (secrets['token']?.operation === 'clear') {
            // The switch is a preference: flipping it back restores whatever
            // the operator had, including a PAT they just typed. Falling back
            // to `preserve` unconditionally would discard a new or replacement
            // token and submit the wrong credential operation.
            secrets['token'] =
              tokenToRestore ??
              (instance?.secrets['token']?.present
                ? { operation: 'preserve' }
                : { operation: 'replace', value: '' });
          }
          return {
            ...current,
            values: { ...current.values, [field.key]: checked },
            secrets,
          };
        });
        tokenBeforeLocalGh.current = checked ? tokenBeforeToggle : undefined;
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
          <Switch
            id={id}
            checked={value === true}
            aria-required={field.required}
            onCheckedChange={updateSwitch}
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
                  {fieldOptionLabel(field, option.value, option.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldShell>
      );
    }
    if (field.kind === 'string-list' && field.options?.length) {
      const options = field.options;
      const selected = toList(String(value ?? ''));
      // The adapter matches these values case-insensitively, so a stored
      // `COMMENT` has to tick the canonical `comment` box instead of rendering
      // a second, stray entry beside it.
      const selectedKeys = new Set(
        selected.map((entry) => entry.toLowerCase()),
      );
      const known = new Set(
        options.map((option) => option.value.toLowerCase()),
      );
      // Values written by hand that the descriptor does not know stay visible
      // and removable instead of disappearing on the next save.
      const stored = selected.filter(
        (entry) => !known.has(entry.toLowerCase()),
      );
      const toggleValue = (target: string, checked: boolean) => {
        const next = new Set(selectedKeys);
        if (checked) next.add(target.toLowerCase());
        else next.delete(target.toLowerCase());
        update(
          [
            ...options
              .map((option) => option.value)
              .filter((entry) => next.has(entry.toLowerCase())),
            ...stored.filter((entry) => next.has(entry.toLowerCase())),
          ].join(', '),
        );
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
          <div
            id={id}
            className={styles.optionGrid}
            role="group"
            aria-label={fieldLabel(field)}
          >
            {[
              ...options,
              ...stored.map((entry) => ({ value: entry, label: entry })),
            ].map((option) => {
              const isSelected = selectedKeys.has(option.value.toLowerCase());
              const optionLabel = fieldOptionLabel(
                field,
                option.value,
                option.label,
              );
              return (
                <label
                  key={option.value}
                  className={styles.optionRow}
                  data-selected={isSelected}
                >
                  <input
                    type="checkbox"
                    className={styles.optionCheckbox}
                    checked={isSelected}
                    onChange={(event) =>
                      toggleValue(option.value, event.target.checked)
                    }
                  />
                  <span className={styles.optionLabel}>{optionLabel}</span>
                </label>
              );
            })}
          </div>
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
    if (field.kind === 'string' && field.multiline) {
      return (
        <FieldShell
          key={field.key}
          id={id}
          label={fieldLabel(field)}
          required={field.required}
          description={fieldDescription(field)}
          error={error}
        >
          <Textarea
            id={id}
            value={String(value ?? '')}
            aria-invalid={Boolean(error)}
            aria-required={field.required}
            onChange={(event) => update(event.target.value)}
          />
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
          placeholder={
            FIELD_PLACEHOLDER_KEYS[`${descriptor.type}.${field.key}`]
          }
          aria-invalid={Boolean(error)}
          aria-required={field.required}
          onChange={(event) => update(event.target.value)}
        />
      </FieldShell>
    );
  };

  const updateGroupOverride = (
    repositoryId: string,
    patch: Partial<ChannelGroupOverrideDraft>,
  ) => {
    setDraft((current) => {
      const existing =
        current.groupOverrides[repositoryId] ?? EMPTY_GROUP_OVERRIDE;
      return {
        ...current,
        groupOverrides: {
          ...current.groupOverrides,
          [repositoryId]: { ...existing, ...patch },
        },
      };
    });
  };

  const renderRepositoryOverrides = () => {
    const repositories = repositoryAllowlistIds(draft.allowedGroupIds);
    if (repositories.length === 0) return null;
    const groups = instance?.config['groups'];
    // Fold the stored keys the same way the save path does, so a mixed-case
    // stored repository still finds its own row.
    const storedGroups = isRecord(groups)
      ? Object.fromEntries(
          Object.entries(groups).map(([key, value]) => [
            key.toLowerCase(),
            value,
          ]),
        )
      : {};
    const wildcard = isRecord(storedGroups['*']) ? storedGroups['*'] : {};
    const inheritedRequireMention =
      typeof wildcard['requireMention'] === 'boolean'
        ? wildcard['requireMention']
        : true;
    const inheritedSenders = draft.groupSenders || defaultGroupSenders();
    return (
      <div className={styles.repositoryList}>
        <p className={styles.repositoryListTitle}>
          {t('channels.editor.field.github.repositorySettings')}
        </p>
        <p className={styles.fieldDescription}>
          {t('channels.editor.field.github.repositorySettings.description')}
        </p>
        {repositories.map((repositoryId) => {
          const override =
            draft.groupOverrides[repositoryId] ?? EMPTY_GROUP_OVERRIDE;
          const effectiveSenders = override.senders || inheritedSenders;
          const storedGroup = isRecord(storedGroups[repositoryId])
            ? storedGroups[repositoryId]
            : {};
          // Ask the save path what this row will own, rather than guessing from
          // the draft policy: a stored allowlist with no list inherits its
          // members, and a stored empty list admits nobody even with no policy
          // beside it. The copy has to match what the runtime will resolve.
          const ownsSpeakerList = Array.isArray(
            projectRepositoryGroup(storedGroup, override)['allowedUsers'],
          );
          const headingId = `${formId}-repo-${repositoryId}`;
          const mentionId = `${formId}-mention-${repositoryId}`;
          const sendersId = `${formId}-senders-${repositoryId}`;
          const speakersId = `${formId}-speakers-${repositoryId}`;
          return (
            // Labelled by its own heading so the repeated control names are
            // distinguishable once more than one repository is listed.
            <div
              key={repositoryId}
              className={styles.repositoryRow}
              role="group"
              aria-labelledby={headingId}
            >
              <h4 id={headingId} className={styles.repositoryName}>
                {repositoryId}
              </h4>
              <FieldShell
                id={mentionId}
                label={t('channels.editor.field.github.requireMention')}
              >
                <Select
                  value={override.requireMention || 'inherit'}
                  onValueChange={(value) =>
                    updateGroupOverride(repositoryId, {
                      requireMention:
                        value === 'inherit'
                          ? ''
                          : (value as ChannelGroupOverrideDraft['requireMention']),
                    })
                  }
                >
                  <SelectTrigger id={mentionId} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">
                      {t(
                        inheritedRequireMention
                          ? 'channels.editor.field.github.requireMention.inheritOn'
                          : 'channels.editor.field.github.requireMention.inheritOff',
                      )}
                    </SelectItem>
                    <SelectItem value="true">
                      {t('channels.editor.field.github.requireMention.on')}
                    </SelectItem>
                    <SelectItem value="false">
                      {t('channels.editor.field.github.requireMention.off')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </FieldShell>
              <FieldShell
                id={sendersId}
                label={t('channels.editor.field.github.repositorySenders')}
              >
                <Select
                  value={override.senders || 'inherit'}
                  onValueChange={(value) =>
                    updateGroupOverride(repositoryId, {
                      senders:
                        value === 'inherit'
                          ? ''
                          : (value as ChannelGroupOverrideDraft['senders']),
                    })
                  }
                >
                  <SelectTrigger id={sendersId} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">
                      {t(
                        inheritedSenders === 'allowlist'
                          ? 'channels.editor.field.github.repositorySenders.inheritAllowlist'
                          : 'channels.editor.field.github.repositorySenders.inheritOpen',
                      )}
                    </SelectItem>
                    <SelectItem value="open">
                      {t('channels.editor.field.github.repositorySenders.open')}
                    </SelectItem>
                    <SelectItem value="allowlist">
                      {t(
                        'channels.editor.field.github.repositorySenders.allowlist',
                      )}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </FieldShell>
              {effectiveSenders === 'allowlist' ? (
                <FieldShell
                  id={speakersId}
                  label={t('channels.editor.field.github.repositorySpeakers')}
                  description={t(
                    ownsSpeakerList
                      ? 'channels.editor.field.github.repositorySpeakers.description'
                      : 'channels.editor.field.github.repositorySpeakers.inherited',
                  )}
                >
                  <Input
                    id={speakersId}
                    value={override.allowedUsers}
                    placeholder={t(
                      'channels.editor.field.github.repositorySpeakers.placeholder',
                    )}
                    onChange={(event) =>
                      updateGroupOverride(repositoryId, {
                        allowedUsers: event.target.value,
                      })
                    }
                  />
                </FieldShell>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  };

  const renderRetainedRepositoryOverrides = () => {
    const groups = instance?.config['groups'];
    if (!isRecord(groups)) return null;
    const retained = Object.entries(groups)
      .filter(
        ([groupId, group]) =>
          groupId !== '*' && isRecord(group) && Object.keys(group).length > 0,
      )
      .map(([groupId]) => groupId);
    if (retained.length === 0) return null;
    // The runtime resolves per-repository senders and requireMention without
    // consulting groupPolicy, so these entries keep deciding who may drive the
    // agent after the policy moves off Allowlist. Say so rather than letting
    // the form imply the channel-wide control is the whole story.
    return (
      <Alert>
        <KeyRoundIcon />
        <AlertTitle>
          {t('channels.editor.field.github.retainedRepositorySettings.title')}
        </AlertTitle>
        <AlertDescription>
          {t(
            'channels.editor.field.github.retainedRepositorySettings.description',
            { repositories: retained.join(', ') },
          )}
        </AlertDescription>
      </Alert>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismissedRef.current = true;
        onOpenChange(nextOpen);
      }}
    >
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
              <FieldShell
                id={`${formId}-workspace`}
                label={t('channels.editor.workspace')}
                required
                description={t(
                  instance
                    ? 'channels.editor.workspace.lockedDescription'
                    : 'channels.editor.workspace.description',
                )}
              >
                <Select
                  value={workspaceCwd}
                  disabled={Boolean(instance) || workspaceLoading || saving}
                  onValueChange={onWorkspaceChange}
                >
                  <SelectTrigger
                    id={`${formId}-workspace`}
                    className="w-full"
                    aria-required
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {workspaces.map((entry) => (
                      <SelectItem
                        key={entry.id}
                        value={entry.cwd}
                        disabled={!entry.trusted}
                      >
                        {workspaceLabel(entry)}
                        {entry.primary
                          ? ` · ${t('channels.workspace.primary')}`
                          : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldShell>
            </section>

            {(['credentials', 'connection', 'routing'] as const).map(
              (section) => {
                const sectionFields = credentialFields.filter(
                  (field) => fieldSectionKey(field) === section,
                );
                if (sectionFields.length === 0) return null;
                return (
                  <section key={section} className={styles.section}>
                    <h3 className={styles.sectionHeading}>
                      {t(`channels.editor.section.${section}`)}
                    </h3>
                    {sectionFields.map(renderField)}
                  </section>
                );
              },
            )}

            {sessionFields.length > 0 ? (
              <section className={styles.settingsPanel}>
                <h3 className={styles.settingsPanelTitle}>
                  {t('channels.editor.section.session')}
                </h3>
                {sessionScopeField ? (
                  <div className={styles.sessionScopeField}>
                    <span className={styles.sessionScopeLabel}>
                      {t('channels.editor.session.isolation')}
                    </span>
                    <RadioGroup
                      className={styles.sessionScopeControl}
                      value={String(draft.values[sessionScopeField.key] ?? '')}
                      aria-label={t('channels.editor.session.isolation')}
                      aria-invalid={Boolean(errors[sessionScopeField.key])}
                      aria-required={sessionScopeField.required}
                      onValueChange={(value) =>
                        setDraft((current) => ({
                          ...current,
                          values: {
                            ...current.values,
                            [sessionScopeField.key]: value,
                          },
                        }))
                      }
                    >
                      {sessionScopeOptions.map((option) => (
                        <Label
                          key={option.value}
                          htmlFor={`${formId}-${sessionScopeField.key}-${option.value}`}
                          className={styles.sessionScopeOption}
                          data-selected={
                            draft.values[sessionScopeField.key] === option.value
                          }
                        >
                          <RadioGroupItem
                            id={`${formId}-${sessionScopeField.key}-${option.value}`}
                            className={styles.sessionScopeRadio}
                            value={option.value}
                          />
                          <span>
                            {fieldOptionLabel(
                              sessionScopeField,
                              option.value,
                              option.label,
                            )}
                          </span>
                        </Label>
                      ))}
                    </RadioGroup>
                    <p
                      className={styles.sessionScopeDescription}
                      aria-live="polite"
                    >
                      {t(
                        `channels.editor.field.shared.sessionScope.detail.${String(
                          draft.values[sessionScopeField.key] ?? 'user',
                        )}`,
                      )}
                    </p>
                    {errors[sessionScopeField.key] ? (
                      <p role="alert" className="text-xs text-destructive">
                        {errors[sessionScopeField.key]}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {remainingSessionFields.map(renderField)}
              </section>
            ) : null}

            {(() => {
              const repositoryOnly = isRepositoryOnlyChannelType(
                descriptor.type,
              );
              const descriptorPolicy = hasDescriptorPrivatePolicy(descriptor);
              const effectivePolicy = repositoryOnly
                ? ''
                : descriptorPolicy
                  ? String(draft.values['privatePolicy'] ?? '')
                  : draft.privatePolicy;
              const showRadioGroup = !descriptorPolicy && !repositoryOnly;
              const descriptorGroupPolicy =
                hasDescriptorGroupPolicy(descriptor);
              const effectiveGroupPolicy = descriptorGroupPolicy
                ? String(draft.values['groupPolicy'] ?? '')
                : String(instance?.config.groupPolicy ?? '');
              const showPairing =
                effectivePolicy === 'pairing' ||
                effectiveGroupPolicy === 'pairing';
              const visibleAccessFields = accessFields.filter(
                (field) =>
                  field.key !== 'operators' &&
                  !(repositoryOnly && PRIVATE_ONLY_FIELD_KEYS.has(field.key)) &&
                  (field.key !== 'allowedUsers' ||
                    effectivePolicy === 'allowlist' ||
                    effectivePolicy === 'pairing'),
              );
              const operatorsField = accessFields.find(
                (field) => field.key === 'operators',
              );
              const showGroupSenders =
                descriptorGroupPolicy &&
                effectiveGroupPolicy !== '' &&
                effectiveGroupPolicy !== 'disabled';
              const effectiveGroupSenders =
                draft.groupSenders || defaultGroupSenders();
              if (
                !showRadioGroup &&
                visibleAccessFields.length === 0 &&
                !showGroupSenders &&
                !operatorsField &&
                !showPairing
              ) {
                return null;
              }
              return (
                <section className={styles.settingsPanel}>
                  <div className={styles.settingsPanelHeader}>
                    <h3 className={styles.settingsPanelTitle}>
                      {t('channels.editor.section.access')}
                    </h3>
                    <p className={styles.settingsPanelDescription}>
                      {t('channels.editor.section.access.description')}
                    </p>
                  </div>
                  {showRadioGroup ? (
                    <>
                      <RadioGroup
                        className={styles.policyGrid}
                        value={draft.privatePolicy}
                        aria-invalid={Boolean(errors['privatePolicy'])}
                        onValueChange={(value) =>
                          setDraft((current) => ({
                            ...current,
                            privatePolicy:
                              value === 'disabled' ||
                              value === 'allowlist' ||
                              value === 'pairing' ||
                              value === 'open'
                                ? value
                                : '',
                          }))
                        }
                      >
                        {(
                          ['disabled', 'allowlist', 'pairing', 'open'] as const
                        ).map((policy) => (
                          <Label
                            key={policy}
                            className={styles.policyCard}
                            data-selected={draft.privatePolicy === policy}
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
                      {errors['privatePolicy'] ? (
                        <p role="alert" className="text-xs text-destructive">
                          {errors['privatePolicy']}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                  {visibleAccessFields.map(renderField)}
                  {effectiveGroupPolicy === 'allowlist' ? (
                    <FieldShell
                      id={`${formId}-allowedGroupIds`}
                      label={t(
                        repositoryOnly
                          ? 'channels.editor.field.github.allowedRepos'
                          : 'channels.editor.field.shared.allowedGroupIds',
                      )}
                      description={t(
                        repositoryOnly
                          ? 'channels.editor.field.github.allowedRepos.description'
                          : 'channels.editor.field.shared.allowedGroupIds.description',
                      )}
                      error={errors['allowedGroupIds']}
                    >
                      <Input
                        id={`${formId}-allowedGroupIds`}
                        value={draft.allowedGroupIds}
                        aria-invalid={Boolean(errors['allowedGroupIds'])}
                        placeholder={t(
                          repositoryOnly
                            ? 'channels.editor.field.github.allowedRepos.placeholder'
                            : 'channels.editor.field.shared.allowedGroupIds.placeholder',
                        )}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            allowedGroupIds: event.target.value,
                          }))
                        }
                      />
                    </FieldShell>
                  ) : null}
                  {repositoryOnly && effectiveGroupPolicy === 'allowlist'
                    ? renderRepositoryOverrides()
                    : null}
                  {repositoryOnly && effectiveGroupPolicy !== 'allowlist'
                    ? renderRetainedRepositoryOverrides()
                    : null}
                  {showGroupSenders ? (
                    <FieldShell
                      id={`${formId}-groupSenders`}
                      label={t('channels.editor.field.shared.groupSenders')}
                      description={t(
                        'channels.editor.field.shared.groupSenders.description',
                      )}
                    >
                      <Select
                        value={effectiveGroupSenders}
                        onValueChange={(value) =>
                          setDraft((current) => ({
                            ...current,
                            groupSenders: value as ChannelGroupSenders,
                          }))
                        }
                      >
                        <SelectTrigger
                          id={`${formId}-groupSenders`}
                          className="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {GROUP_SENDERS_OPTIONS.map((option) => (
                            <SelectItem key={option} value={option}>
                              {t(
                                `channels.editor.field.shared.groupSenders.option.${option}`,
                              )}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FieldShell>
                  ) : null}
                  {showGroupSenders && effectiveGroupSenders === 'allowlist' ? (
                    <FieldShell
                      id={`${formId}-groupAllowedUsers`}
                      label={t(
                        'channels.editor.field.shared.groupAllowedUsers',
                      )}
                      description={t(
                        'channels.editor.field.shared.groupAllowedUsers.description',
                      )}
                    >
                      <Input
                        id={`${formId}-groupAllowedUsers`}
                        value={draft.groupAllowedUsers}
                        placeholder={t(
                          'channels.editor.field.shared.groupAllowedUsers.placeholder',
                        )}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            groupAllowedUsers: event.target.value,
                          }))
                        }
                      />
                    </FieldShell>
                  ) : null}
                  {operatorsField ? renderField(operatorsField) : null}
                  {showPairing ? (
                    instance &&
                    ((!repositoryOnly &&
                      configuredPrivatePolicy(instance) === 'pairing') ||
                      instance.config.groupPolicy === 'pairing') ? (
                      <ChannelPairingRequests
                        channelName={instance.name}
                        listRequests={listPairingRequests}
                        approveRequest={approvePairingRequest}
                        listApprovals={listPairingApprovals}
                        revokeApproval={revokePairingApproval}
                        staticAllowedUsers={
                          repositoryOnly ? [] : configuredAllowedUsers(instance)
                        }
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
              onClick={() => {
                dismissedRef.current = true;
                onOpenChange(false);
              }}
            >
              {t('channels.editor.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={
                saving || reloading || workspaceLoading || !expectedRevision
              }
            >
              {saving ? <Spinner /> : null}
              {t('channels.editor.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
