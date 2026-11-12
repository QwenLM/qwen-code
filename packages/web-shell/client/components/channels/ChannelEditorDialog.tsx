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
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ExpandIcon,
  KeyRoundIcon,
  ShrinkIcon,
  Trash2Icon,
} from 'lucide-react';
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Spinner } from '../ui/spinner';
import { Switch } from '../ui/switch';
import styles from './ChannelEditorDialog.module.css';
import { ChannelPairingRequests } from './ChannelPairingRequests';
import { ChannelQrLogin } from './ChannelQrLogin';
import type { DaemonChannelQrLoginHandlers } from '../../daemon/workspace/types';
import { WeixinLoginPanel, type WeixinLoginApi } from './WeixinLoginPanel';
import {
  buildChannelUpsertRequest,
  createChannelEditorDraft,
  defaultGroupSenders,
  hasDescriptorGroupPolicy,
  hasDescriptorPrivatePolicy,
  configuredPrivatePolicy,
  GROUP_ONLY_FIELD_KEYS,
  PRIVATE_ONLY_FIELD_KEYS,
  invalidRepositoryGroupEntries,
  isRepoFilterActive,
  projectRepositoryGroup,
  recordHasRoute,
  repositoryAllowlistIds,
  retainedRepositorySettings,
  toList,
  validateChannelEditorDraft,
  type ChannelEditorDraft,
  type ChannelSecretDraft,
  type ChannelEditorValidationCode,
  type ChannelGroupOverrideDraft,
  type ChannelGroupSenders,
} from './channel-editor-state';
import {
  isPrivateOnlyChannelType,
  isRepositoryOnlyChannelType,
  PLATFORM_MARKS,
} from './channel-platform';

const FIELD_LABEL_KEYS: Record<string, Record<string, string>> = {
  dingtalk: {
    clientId: 'channels.editor.field.dingtalk.clientId',
    clientSecret: 'channels.editor.field.dingtalk.clientSecret',
  },
  'dingtalk-webhook': {
    webhookUrl: 'channels.editor.field.dingtalkWebhook.webhookUrl',
    signingSecret: 'channels.editor.field.dingtalkWebhook.signingSecret',
  },
  weixin: {
    groupPolicy: 'channels.editor.field.weixin.groupPolicy',
    allowedUsers: 'channels.editor.field.weixin.allowedUsers',
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
    repoFilterMode: 'channels.editor.field.github.repoFilterMode',
    repoFilter: 'channels.editor.field.github.repoFilter',
    deliverToBoundSessions:
      'channels.editor.field.github.deliverToBoundSessions',
    requireBoundWatch: 'channels.editor.field.github.requireBoundWatch',
    prCommentWatch: 'channels.editor.field.github.prCommentWatch',
    prWatchEvents: 'channels.editor.field.github.prWatchEvents',
    prWatchLimit: 'channels.editor.field.github.prWatchLimit',
    prWatchBudgetReserve: 'channels.editor.field.github.prWatchBudgetReserve',
    boundSessionActions: 'channels.editor.field.github.boundSessionActions',
  },
  gitlab: {
    token: 'channels.editor.field.gitlab.token',
    baseUrl: 'channels.editor.field.gitlab.baseUrl',
    groupPolicy: 'channels.editor.field.gitlab.groupPolicy',
    action_prompt_template:
      'channels.editor.field.gitlab.action_prompt_template',
  },
  email: {
    address: 'channels.editor.field.email.address',
    imapHost: 'channels.editor.field.email.imapHost',
    imapUser: 'channels.editor.field.email.imapUser',
    imapPassword: 'channels.editor.field.email.imapPassword',
    smtpHost: 'channels.editor.field.email.smtpHost',
    smtpUser: 'channels.editor.field.email.smtpUser',
    smtpPassword: 'channels.editor.field.email.smtpPassword',
    folder: 'channels.editor.field.email.folder',
    imapPort: 'channels.editor.field.email.imapPort',
    smtpPort: 'channels.editor.field.email.smtpPort',
    imapSecure: 'channels.editor.field.email.imapSecure',
    smtpSecure: 'channels.editor.field.email.smtpSecure',
    proactiveRecipients: 'channels.editor.field.email.proactiveRecipients',
    pollInterval: 'channels.editor.field.email.pollInterval',
    maxMessageBytes: 'channels.editor.field.email.maxMessageBytes',
    maxAttachmentBytes: 'channels.editor.field.email.maxAttachmentBytes',
    maxTextLength: 'channels.editor.field.email.maxTextLength',
    // The shared hints say "stable user IDs ... without pairing", but the
    // Email adapter only accepts bare mailbox addresses and rejects pairing.
    allowedUsers: 'channels.editor.field.email.allowedUsers',
    operators: 'channels.editor.field.email.operators',
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
// One panel: watch events, the watch limit, and action templates only mean
// something with bound delivery enabled.
const BOUND_SESSION_FIELD_KEYS = new Set([
  'deliverToBoundSessions',
  'requireBoundWatch',
  'prCommentWatch',
  'prWatchEvents',
  'prWatchLimit',
  'prWatchBudgetReserve',
  'boundSessionActions',
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
  'github.repoFilter': 'owner/repo, owner/repo',
  'email.allowedUsers': 'you@example.com, colleague@example.com',
  'email.operators': 'you@example.com',
  // The id shape, not a WeChat handle: an operator who reads "user ID" and
  // types their WeChat name gets a silently inert allowlist entry.
  'weixin.allowedUsers': 'oAbCd…@im.wechat',
};

// Email's endpoint and TLS keys are declared by no other channel, so listing
// them here moves only Email's fields: they decide where the mailbox
// credentials are sent, which is Connection rather than Credentials.
const CONNECTION_FIELD_KEYS = new Set([
  'baseUrl',
  'wsUrl',
  'pollInterval',
  'imapHost',
  'imapPort',
  'imapSecure',
  'smtpHost',
  'smtpPort',
  'smtpSecure',
]);
/**
 * Rarely changed tuning, collapsed into one disclosure panel. Primary
 * endpoints stay out: `wsUrl` (WeCom) and `baseUrl` (GitHub Enterprise /
 * self-hosted GitLab) decide where a token is sent, so a fresh draft must
 * show them. `operators` stays out too: it grants permissions, which belongs
 * in Access control, not behind a tuning disclosure. Only non-enum keys
 * belong here — `initialFieldValue` pre-fills enums from their default, so
 * an enum key would count every fresh draft as configured and auto-open the
 * panel, quietly undoing the slim default view.
 */
const ADVANCED_FIELD_KEYS = new Set([
  'pollInterval',
  'reasonFilter',
  'messageRoutes',
  'defaultMessageRoute',
  'multiSession',
  'instructions',
  // Email tuning: the polled mailbox folder (defaults to INBOX) and the size
  // caps are rarely changed, not credentials. `folder` is a plain string, so
  // unlike an enum it is not pre-filled on a fresh draft and does not auto-open
  // this panel.
  'folder',
  'maxMessageBytes',
  'maxAttachmentBytes',
  'maxTextLength',
]);

/** Every repository starts fully inheriting; nothing is materialized. */
const EMPTY_GROUP_OVERRIDE: ChannelGroupOverrideDraft = {
  requireMention: '',
  senders: '',
  allowedUsers: '',
};

function fieldSectionKey(
  field: DaemonChannelConfigFieldDescriptor,
): 'credentials' | 'connection' {
  if (CONNECTION_FIELD_KEYS.has(field.key)) return 'connection';
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
  qrLoginActions?: DaemonChannelQrLoginHandlers;
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
  /**
   * WeChat login is process-global rather than workspace-scoped, so it arrives
   * as its own injected API instead of riding the channel management client.
   * Absent when the host cannot supply it; the panel then does not render.
   */
  weixinLogin?: WeixinLoginApi;
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

/** Draft-value adapter over the shared record rule in channel-editor-state. */
function draftHasRoute(value: string | boolean | undefined): boolean {
  return typeof value === 'string' && recordHasRoute(value);
}

function isAdvancedFieldConfigured(
  field: DaemonChannelConfigFieldDescriptor,
  value: string | boolean | undefined,
): boolean {
  if (field.kind === 'boolean') return value === true;
  if (field.kind === 'record') return draftHasRoute(value);
  return typeof value === 'string' && value.trim() !== '';
}

function FieldShell({
  id,
  label,
  required,
  hint,
  hintId,
  description,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  hintId?: string;
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
        {hint || hintId ? (
          // A hintId keeps the live region mounted while the hint is empty,
          // so screen readers announce the hint when it appears.
          <span
            id={hintId}
            className={styles.hint}
            aria-live={hintId ? 'polite' : undefined}
          >
            {hint}
          </span>
        ) : null}
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
  qrLoginActions,
  listPairingRequests,
  approvePairingRequest,
  listPairingApprovals,
  revokePairingApproval,
  weixinLogin,
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [scrollToErrorKey, setScrollToErrorKey] = useState<string>();
  const dismissedRef = useRef(false);
  /** The token draft as it stood before local gh auth overrode it. */
  const tokenBeforeLocalGh = useRef<ChannelSecretDraft | undefined>(undefined);
  const accessFields = descriptor.fields.filter(
    (field) =>
      SHARED_ACCESS_FIELD_KEYS.has(field.key) &&
      !ADVANCED_FIELD_KEYS.has(field.key),
  );
  const sessionFields = descriptor.fields.filter(
    (field) =>
      SHARED_SESSION_FIELD_KEYS.has(field.key) &&
      !ADVANCED_FIELD_KEYS.has(field.key),
  );
  const advancedFields = descriptor.fields.filter((field) =>
    ADVANCED_FIELD_KEYS.has(field.key),
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
      !SHARED_SESSION_FIELD_KEYS.has(field.key) &&
      !ADVANCED_FIELD_KEYS.has(field.key) &&
      !BOUND_SESSION_FIELD_KEYS.has(field.key),
  );
  const boundSessionFields = descriptor.fields.filter((field) =>
    BOUND_SESSION_FIELD_KEYS.has(field.key),
  );

  useEffect(() => {
    if (!open) return;
    dismissedRef.current = false;
    tokenBeforeLocalGh.current = undefined;
    const fresh = createChannelEditorDraft(descriptor, instance);
    setDraft(fresh);
    // Configured tuning must not hide behind a collapsed panel on open.
    setAdvancedOpen(
      descriptor.fields.some(
        (field) =>
          ADVANCED_FIELD_KEYS.has(field.key) &&
          isAdvancedFieldConfigured(field, fresh.values[field.key]),
      ),
    );
    setErrors({});
    setSubmitError(undefined);
    setFullscreen(false);
  }, [descriptor, instance, open]);

  useEffect(() => {
    setErrors({});
    setSubmitError(undefined);
  }, [workspaceCwd]);

  useEffect(() => {
    if (!scrollToErrorKey) return;
    // Runs after the forced-open panel content mounts (submit sets both in
    // one batch); the id is the same one FieldShell renders, so the scroll
    // lands on the erroring control. The optional call keeps jsdom (no
    // scrollIntoView) from throwing.
    document
      .getElementById(`${formId}-${scrollToErrorKey}`)
      ?.scrollIntoView?.({ block: 'center' });
    setScrollToErrorKey(undefined);
  }, [advancedOpen, scrollToErrorKey, formId]);

  const isFieldVisible = (field: DaemonChannelConfigFieldDescriptor) => {
    // A stored default route must stay repairable even with no routes left.
    if (field.key === 'defaultMessageRoute')
      return (
        draftHasRoute(draft.values['messageRoutes']) ||
        String(draft.values['defaultMessageRoute'] ?? '').trim() !== ''
      );
    return true;
  };

  const advancedConfiguredCount = advancedFields.filter((field) =>
    isAdvancedFieldConfigured(field, draft.values[field.key]),
  ).length;

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
      return t(
        descriptor.type === 'gitlab'
          ? 'channels.editor.validation.invalidProjectPath'
          : 'channels.editor.validation.invalidRepoId',
      );
    if (code === 'repoFilterRequired')
      return t('channels.editor.validation.repoFilterRequired');
    if (code === 'conflictingRepoAliases')
      return t(
        descriptor.type === 'gitlab'
          ? 'channels.editor.validation.conflictingProjectAliases'
          : 'channels.editor.validation.conflictingRepoAliases',
      );
    if (code === 'invalidOption')
      return t('channels.editor.validation.invalidOption');
    if (code === 'requiresBoundDelivery')
      return t('channels.editor.validation.requiresBoundDelivery');
    if (code === 'requiresBoundDeliveryForWatchGate')
      return t('channels.editor.validation.requiresBoundDeliveryForWatchGate');
    if (code === 'number') return t('channels.editor.validation.number');
    if (code === 'outOfRange') {
      const numberField = field && field.kind === 'number' ? field : undefined;
      // Only name the bounds the descriptor actually declares: a field with a
      // maximum and no lower bound has no floor, and inventing "greater than
      // 0" would state a constraint the validator does not enforce.
      const exclusive = numberField?.exclusiveMinimum;
      const inclusive = numberField?.minimum;
      // Name whichever floor the validator actually enforces at the margin.
      // On a tie the exclusive bound is stricter, since it also rejects equality.
      const floorIsInclusive =
        inclusive !== undefined &&
        (exclusive === undefined || inclusive > exclusive);
      return t('channels.editor.validation.outOfRange', {
        ...(floorIsInclusive
          ? { minInclusive: inclusive }
          : exclusive !== undefined
            ? { min: exclusive }
            : {}),
        ...(numberField?.maximum !== undefined
          ? { max: numberField.maximum }
          : {}),
      });
    }
    if (code === 'invalidGroupEntry') {
      // Name the entries: the form has no row for them, so a generic refusal
      // would leave the operator with nothing to act on.
      return t('channels.editor.validation.invalidGroupEntry', {
        repositories: invalidRepositoryGroupEntries(instance).join(', '),
      });
    }
    if (code === 'policy') return t('channels.editor.validation.policy');
    return t('channels.editor.validation.required', {
      label: field ? fieldLabel(field) : t('channels.editor.instanceName'),
    });
  };

  // Re-derive only the errors already on screen, so each remedy (switch in
  // either direction, untick) retires exactly the instruction it satisfies —
  // including invalidOption, whose remedy is unticking the offending value —
  // without surfacing an error the operator never submitted. Submit stays the
  // only population site; deriving through validateChannelEditorDraft keeps
  // the daemon precedence that the parity table pins.
  const refreshErrors = (values: ChannelEditorDraft['values']) =>
    setErrors((current) => {
      const shown = Object.keys(current);
      if (shown.length === 0) return current;
      const validation = validateChannelEditorDraft(
        descriptor,
        { ...draft, values },
        existingNames,
        instance,
      );
      const next = { ...current };
      for (const key of shown) {
        const code = validation[key];
        if (code) {
          next[key] = validationMessage(
            descriptor.fields.find((field) => field.key === key),
            code,
          );
        } else {
          delete next[key];
        }
      }
      return next;
    });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateChannelEditorDraft(
      descriptor,
      draft,
      existingNames,
      instance,
    );
    if (Object.keys(validation).length > 0) {
      // An error below the fold or on a collapsed field would otherwise be
      // invisible: open the advanced panel when needed and bring the first
      // erroring field — advanced or not — into view.
      const advancedErrorKey = Object.keys(validation).find((key) =>
        ADVANCED_FIELD_KEYS.has(key),
      );
      if (advancedErrorKey) setAdvancedOpen(true);
      setScrollToErrorKey(advancedErrorKey ?? Object.keys(validation)[0]);
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
    const update = (next: string | boolean) => {
      if (field.key === 'repoFilterMode' || field.key === 'repoFilter') {
        // Both remedies retire a shown error: switching to off hides the
        // list, and typing a valid entry satisfies the instruction. Submit
        // stays the only site that populates errors.
        refreshErrors({ ...draft.values, [field.key]: next });
      }
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
    };
    if (field.kind === 'boolean') {
      const isLocalGhSwitch =
        field.key === 'useLocalGh' &&
        isRepositoryOnlyChannelType(descriptor.type);
      // Same prerequisite gate as prWatchEvents: name it at the field
      // instead of letting the daemon reject the whole draft after submit.
      // A stored true stays switchable OFF while gated, so turning delivery
      // off never strands the operator with a flag they cannot clear.
      const gateField =
        field.key === 'requireBoundWatch' && descriptor.type === 'github';
      const gatedBoundWatch =
        gateField && draft.values['deliverToBoundSessions'] !== true;
      const updateSwitch = (checked: boolean) => {
        if (
          field.key === 'deliverToBoundSessions' ||
          field.key === 'requireBoundWatch'
        ) {
          // Both directions re-derive shown errors: on retires the dependency
          // instruction, off keeps a shown one instead of dropping it silently.
          // Unticking the gate is itself a remedy for its dependency error.
          refreshErrors({
            ...draft.values,
            [field.key]: checked,
          });
        }
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
          hint={
            gatedBoundWatch
              ? t('channels.editor.field.github.requireBoundWatch.disabledHint')
              : undefined
          }
          // Keep the live region mounted from first render (keyed off the
          // field, not the gated state): a region that enters the DOM already
          // filled is never announced when the hint appears.
          hintId={gateField ? `${id}-disabled-hint` : undefined}
          error={error}
        >
          <Switch
            id={id}
            checked={value === true}
            aria-required={field.required}
            disabled={gatedBoundWatch && value !== true}
            aria-describedby={gateField ? `${id}-disabled-hint` : undefined}
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
      // Same scope as the validation mirror in channel-editor-state.
      const watchField =
        field.key === 'prWatchEvents' && descriptor.type === 'github';
      const gated =
        watchField && draft.values['deliverToBoundSessions'] !== true;
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
        const joined = [
          ...options
            .map((option) => option.value)
            .filter((entry) => next.has(entry.toLowerCase())),
          ...stored.filter((entry) => next.has(entry.toLowerCase())),
        ].join(', ');
        // Unticking is a remedy too: re-derive so a satisfied instruction
        // retires without waiting for a second Save.
        if (watchField) {
          refreshErrors({ ...draft.values, [field.key]: joined });
        }
        update(joined);
      };
      return (
        <FieldShell
          key={field.key}
          id={id}
          label={fieldLabel(field)}
          required={field.required}
          description={fieldDescription(field)}
          hint={
            gated
              ? t('channels.editor.field.github.prWatchEvents.disabledHint')
              : undefined
          }
          hintId={watchField ? `${id}-disabled-hint` : undefined}
          error={error}
        >
          <div
            id={id}
            className={styles.optionGrid}
            role="group"
            aria-label={fieldLabel(field)}
            aria-describedby={gated ? `${id}-disabled-hint` : undefined}
          >
            {[
              ...options,
              ...stored.map((entry) => ({ value: entry, label: entry })),
            ].map((option) => {
              const isSelected = selectedKeys.has(option.value.toLowerCase());
              // A stored selection stays clearable while gated, so turning
              // delivery off never strands the operator with events they
              // cannot remove.
              const optionDisabled = gated && !isSelected;
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
                  data-disabled={optionDisabled}
                >
                  <input
                    type="checkbox"
                    className={styles.optionCheckbox}
                    checked={isSelected}
                    disabled={optionDisabled}
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
            record = Object.fromEntries(
              Object.entries(parsed).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === 'string',
              ),
            );
          }
        } catch {
          /* malformed — render empty */
        }
      }
      const options = field.options ?? [];
      const optionByKey = new Map(
        options.map((option) => [option.value, option]),
      );
      const labelKey =
        FIELD_LABEL_KEYS[descriptor.type]?.[field.key] ??
        SHARED_FIELD_LABEL_KEYS[field.key];
      const translateWithFallback = (suffix: string, fallback: string) => {
        if (!labelKey) return fallback;
        const key = `${labelKey}.${suffix}`;
        const translated = t(key);
        return translated !== key ? translated : fallback;
      };
      // Translated description, else the descriptor's own, else a
      // descriptive option label (GitLab spells the meaning into the label).
      const optionDescription = (key: string): string => {
        const option = optionByKey.get(key);
        const translated = translateWithFallback(
          `optionDescription.${key}`,
          '',
        );
        if (translated) return translated;
        if (option?.description) return option.description;
        const optionLabel = option
          ? fieldOptionLabel(field, option.value, option.label)
          : '';
        return optionLabel !== key ? optionLabel : '';
      };
      // Empty values stay in the draft while editing so a freshly added or
      // cleared row keeps its place; the explicit remove button deletes the
      // key, and the save serializer (parseRouteRecord) filters empty values
      // regardless, so no empty entry can reach the channel validators.
      const writeRecord = (next: Record<string, string>) => {
        update(JSON.stringify(next));
      };
      const setEntry = (key: string, val: string) => {
        writeRecord({ ...record, [key]: val });
      };
      const removeEntry = (key: string) => {
        const next = { ...record };
        delete next[key];
        writeRecord(next);
      };
      // Same gate as prWatchEvents: name the prerequisite at the field
      // instead of surfacing a raw daemon rejection after submit. Stored
      // rows stay editable and removable while gated.
      const gated =
        field.key === 'boundSessionActions' &&
        descriptor.type === 'github' &&
        draft.values['deliverToBoundSessions'] !== true;
      const available = options.filter((option) => !(option.value in record));
      const groups: Array<{
        name: string | undefined;
        options: typeof available;
      }> = [];
      for (const option of available) {
        const last = groups[groups.length - 1];
        if (last && last.name === option.group) last.options.push(option);
        else groups.push({ name: option.group, options: [option] });
      }
      const renderOption = (option: (typeof available)[number]) => {
        const label = fieldOptionLabel(field, option.value, option.label);
        const description = optionDescription(option.value);
        return (
          <SelectItem key={option.value} value={option.value}>
            <span className={styles.recordOption}>
              <span>{label}</span>
              {description && description !== label ? (
                <span className={styles.recordOptionDescription}>
                  {description}
                </span>
              ) : null}
            </span>
          </SelectItem>
        );
      };
      const recordKeys = Object.keys(record);
      return (
        <FieldShell
          key={field.key}
          id={id}
          label={fieldLabel(field)}
          required={field.required}
          description={fieldDescription(field)}
          hint={
            gated
              ? t(
                  'channels.editor.field.github.boundSessionActions.disabledHint',
                )
              : undefined
          }
          hintId={gated ? `${id}-disabled-hint` : undefined}
          error={error}
        >
          <div className={styles.recordFields}>
            {recordKeys.length === 0 ? (
              <p className={styles.recordEmpty}>
                {translateWithFallback(
                  'empty',
                  t('channels.editor.record.empty'),
                )}
              </p>
            ) : null}
            {recordKeys.map((key) => {
              const description = optionDescription(key);
              return (
                <div key={key} className={styles.recordRow}>
                  <div className={styles.recordRowHeader}>
                    <Label
                      htmlFor={`${id}-${key}`}
                      className={styles.recordLabel}
                    >
                      {key}
                    </Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('channels.editor.record.remove', { key })}
                      title={t('channels.editor.record.remove', { key })}
                      onClick={() => removeEntry(key)}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                  {description ? (
                    <p className={styles.recordDescription}>{description}</p>
                  ) : null}
                  <Textarea
                    id={`${id}-${key}`}
                    value={record[key] ?? ''}
                    onChange={(event) => setEntry(key, event.target.value)}
                  />
                </div>
              );
            })}
            {options.length > 0 ? (
              <Select
                value=""
                disabled={gated || available.length === 0}
                onValueChange={(key) => setEntry(key, '')}
              >
                <SelectTrigger
                  id={id}
                  className="w-full"
                  aria-describedby={gated ? `${id}-disabled-hint` : undefined}
                >
                  <SelectValue
                    placeholder={translateWithFallback(
                      'addPlaceholder',
                      t('channels.editor.record.addPlaceholder'),
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((group) =>
                    group.name === undefined ? (
                      group.options.map(renderOption)
                    ) : (
                      <SelectGroup key={group.name}>
                        <SelectLabel>
                          {translateWithFallback(
                            `group.${group.name}`,
                            group.name,
                          )}
                        </SelectLabel>
                        {group.options.map(renderOption)}
                      </SelectGroup>
                    ),
                  )}
                </SelectContent>
              </Select>
            ) : null}
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
    const repositories = repositoryAllowlistIds(
      draft.allowedGroupIds,
      descriptor.type,
    );
    if (repositories.length === 0) return null;
    // Speakers are GitHub logins or GitLab usernames; only the copy differs.
    const speakerCopyKey =
      descriptor.type === 'gitlab'
        ? 'channels.editor.field.gitlab.repositorySpeakers'
        : 'channels.editor.field.github.repositorySpeakers';
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
          // The hint promises what an EMPTY box will do, so ask the projection
          // about that hypothetical rather than about the current draft. A
          // stored list under an inherited policy is deleted when the box is
          // cleared, handing the repository back the channel-wide members —
          // asking about the untouched draft would promise "nobody" instead.
          const ownsSpeakerList = Array.isArray(
            projectRepositoryGroup(storedGroup, {
              ...override,
              allowedUsers: '',
            })['allowedUsers'],
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
                      ? `${speakerCopyKey}.description`
                      : `${speakerCopyKey}.inherited`,
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

  const renderRetainedRepositoryOverrides = (policy: string) => {
    // Read the list back from the request this save builds, not from storage:
    // a repository typed during this visit is written by the save but absent
    // from the stored groups, and announcing only stored entries would let the
    // dialog report success without naming it.
    const retained = retainedRepositorySettings(descriptor, draft, instance);
    // Under open/pairing the runtime resolves per-repository senders and
    // requireMention without consulting groupPolicy, so an entry that can still
    // restrict someone keeps deciding who may drive the agent — but an
    // `allowedUsers` array beside an inherited `open` policy restricts nobody,
    // and naming it as "still applying" would be false. Under disabled the group
    // gate drops every envelope before either lookup, so every retained entry is
    // kept but inert. The policy is the caller's, so the copy cannot disagree
    // with the gate that decided to show this alert.
    const disabled = policy === 'disabled';
    const named = disabled
      ? retained.map((entry) => entry.repositoryId)
      : retained.filter((entry) => entry.applies).map((e) => e.repositoryId);
    if (named.length === 0) return null;
    const variant = disabled ? '.disabled' : '';
    return (
      <Alert>
        <KeyRoundIcon />
        <AlertTitle>
          {t(
            `channels.editor.field.github.retainedRepositorySettings${variant}.title`,
          )}
        </AlertTitle>
        <AlertDescription>
          {t(
            `channels.editor.field.github.retainedRepositorySettings${variant}.description`,
            { repositories: named.join(', ') },
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
      <DialogContent
        className={
          fullscreen
            ? 'flex h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] flex-col p-5 sm:max-w-[calc(100vw-2rem)]'
            : 'max-w-[calc(100%-2rem)] p-5 sm:max-w-xl'
        }
      >
        <DialogHeader>
          <div className={styles.platformHeader}>
            <span className={styles.platformMark} aria-hidden="true">
              {PLATFORM_MARKS[descriptor.type] ??
                descriptor.displayName[0]?.toUpperCase() ??
                '?'}
            </span>
            <div className={styles.platformHeaderText}>
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
                  descriptor.outboundOnly
                    ? 'channels.statusDescription.outbound'
                    : instance
                      ? 'channels.editor.editDescription'
                      : 'channels.editor.addDescription',
                )}
              </DialogDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={styles.fullscreenToggle}
              onClick={() => setFullscreen((value) => !value)}
              aria-label={t(
                fullscreen ? 'common.exitFullscreen' : 'common.fullscreen',
              )}
              aria-pressed={fullscreen}
              title={t(
                fullscreen ? 'common.exitFullscreen' : 'common.fullscreen',
              )}
            >
              {fullscreen ? <ShrinkIcon /> : <ExpandIcon />}
            </Button>
          </div>
        </DialogHeader>
        <form
          className={
            fullscreen ? `${styles.form} ${styles.formFullscreen}` : styles.form
          }
          onSubmit={submit}
        >
          <div
            className={
              fullscreen
                ? `${styles.body} ${styles.bodyFullscreen}`
                : styles.body
            }
          >
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

            {descriptor.type === 'weixin' && weixinLogin ? (
              <section className={styles.section}>
                <h3 className={styles.sectionHeading}>
                  {t('channels.editor.section.credentials')}
                </h3>
                <WeixinLoginPanel api={weixinLogin} />
              </section>
            ) : null}

            {(['credentials', 'connection'] as const).map((section) => {
              const sectionFields = credentialFields.filter(
                (field) =>
                  fieldSectionKey(field) === section &&
                  // The repository list only means something while a filter
                  // mode is active; validation is gated on the same
                  // predicate, so the hidden field can never strand a save.
                  !(
                    field.key === 'repoFilter' &&
                    isRepositoryOnlyChannelType(descriptor.type) &&
                    !isRepoFilterActive(draft.values['repoFilterMode'])
                  ),
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
            })}

            {!descriptor.outboundOnly && boundSessionFields.length > 0 ? (
              <section className={styles.settingsPanel}>
                <div className={styles.settingsPanelHeader}>
                  <h3 className={styles.settingsPanelTitle}>
                    {t('channels.editor.section.boundSessions')}
                  </h3>
                  <p className={styles.settingsPanelDescription}>
                    {t('channels.editor.section.boundSessions.description')}
                  </p>
                </div>
                {boundSessionFields.map(renderField)}
              </section>
            ) : null}

            {!descriptor.outboundOnly && sessionFields.length > 0 ? (
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
              if (descriptor.outboundOnly) return null;
              const repositoryOnly = isRepositoryOnlyChannelType(
                descriptor.type,
              );
              // GitLab allowlists nested project paths; GitHub lists owner/repo.
              const repositoryAllowlistKey =
                descriptor.type === 'gitlab'
                  ? 'channels.editor.field.gitlab.allowedRepos'
                  : 'channels.editor.field.github.allowedRepos';
              const privateOnly = isPrivateOnlyChannelType(descriptor.type);
              const descriptorPolicy = hasDescriptorPrivatePolicy(descriptor);
              const effectivePolicy = repositoryOnly
                ? ''
                : descriptorPolicy
                  ? String(draft.values['privatePolicy'] ?? '')
                  : draft.privatePolicy;
              const showRadioGroup = !descriptorPolicy && !repositoryOnly;
              const descriptorGroupPolicy =
                hasDescriptorGroupPolicy(descriptor);
              // Mirror of the repository-only branch above. The draft skip is
              // what normally keeps this empty: it omits groupPolicy from
              // draft.values, so the descriptor arm below reads ''. This
              // ternary is the guard for the other arm — if the descriptor ever
              // lacked the injected field, the fallback would read the STORED
              // config, and a stored 'pairing' must not resurrect the panel.
              const effectiveGroupPolicy = privateOnly
                ? ''
                : descriptorGroupPolicy
                  ? String(draft.values['groupPolicy'] ?? '')
                  : String(instance?.config.groupPolicy ?? '');
              const showPairing =
                effectivePolicy === 'pairing' ||
                effectiveGroupPolicy === 'pairing';
              const visibleAccessFields = accessFields.filter(
                (field) =>
                  field.key !== 'operators' &&
                  !(repositoryOnly && PRIVATE_ONLY_FIELD_KEYS.has(field.key)) &&
                  !(privateOnly && GROUP_ONLY_FIELD_KEYS.has(field.key)) &&
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
                          ? repositoryAllowlistKey
                          : 'channels.editor.field.shared.allowedGroupIds',
                      )}
                      description={t(
                        repositoryOnly
                          ? `${repositoryAllowlistKey}.description`
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
                            ? `${repositoryAllowlistKey}.placeholder`
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
                    ? renderRetainedRepositoryOverrides(effectiveGroupPolicy)
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
                  {descriptor.supportsQrLogin && instance && qrLoginActions ? (
                    <ChannelQrLogin
                      channelName={instance.name}
                      actions={qrLoginActions}
                      onBound={() => {
                        // The draft was seeded from the pre-bind instance, so
                        // saving it would submit the old empty credentials and
                        // clear the binding just made. Close instead of leaving
                        // a stale draft over a changed store.
                        void onReload();
                        onOpenChange(false);
                      }}
                    />
                  ) : null}

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

            {advancedFields.length > 0 ? (
              <Collapsible
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
                className={styles.settingsPanel}
              >
                {/* Heading outside the trigger: ARIA makes a button's
                    descendants presentational, so a span-in-button title
                    would be invisible to heading navigation. */}
                <h3 className={styles.settingsPanelTitle}>
                  <CollapsibleTrigger className={styles.advancedTrigger}>
                    <ChevronDownIcon
                      size={15}
                      className={styles.advancedChevron}
                      aria-hidden="true"
                    />
                    <span>{t('channels.editor.section.advanced')}</span>
                    {!advancedOpen && advancedConfiguredCount > 0 ? (
                      <span className={styles.advancedBadge}>
                        {t('channels.editor.section.advanced.configuredCount', {
                          count: advancedConfiguredCount,
                        })}
                      </span>
                    ) : null}
                  </CollapsibleTrigger>
                </h3>
                <CollapsibleContent className={styles.advancedContent}>
                  <p className={styles.settingsPanelDescription}>
                    {t('channels.editor.section.advanced.description')}
                  </p>
                  {advancedFields.filter(isFieldVisible).map(renderField)}
                </CollapsibleContent>
              </Collapsible>
            ) : null}
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
