/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { AlertCircleIcon, KeyRoundIcon, QrCodeIcon } from 'lucide-react';
import type {
  DaemonChannelConfigFieldDescriptor,
  DaemonChannelInstanceSnapshot,
  DaemonChannelTypeDescriptor,
  DaemonChannelUpsertRequest,
} from '@qwen-code/sdk/daemon';
import { Alert, AlertDescription } from '../ui/alert';
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
import {
  buildChannelUpsertRequest,
  channelEditorNeedsQrHandoff,
  createChannelEditorState,
  selectChannelEditorType,
  SHARED_CHANNEL_FIELDS,
  updateChannelEditorField,
  updateSecretEditor,
  validateChannelEditor,
  type ChannelEditorState,
} from './channel-editor-state';

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
  error?: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    name: string,
    request: DaemonChannelUpsertRequest,
  ) => Promise<boolean | void>;
  onQrHandoff?: (handoff: ChannelEditorQrHandoff) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

const SECTION_FIELDS = [
  {
    title: 'Identity',
    keys: ['identity.id', 'identity.displayName', 'identity.description'],
  },
  {
    title: 'Model and workspace',
    keys: ['model', 'cwd', 'approvalMode', 'instructions'],
  },
  {
    title: 'Messaging policies',
    keys: ['senderPolicy', 'allowedUsers', 'dmPolicy', 'groupPolicy'],
  },
  {
    title: 'Routing',
    keys: ['sessionScope', 'dispatchMode', 'groupHistoryLimit'],
  },
  {
    title: 'Streaming',
    keys: [
      'blockStreaming',
      'blockStreamingChunk.minChars',
      'blockStreamingChunk.maxChars',
      'blockStreamingCoalesce.idleMs',
    ],
  },
  { title: 'Memory', keys: ['memoryScope.namespace'] },
  { title: 'Webhooks', keys: ['webhooks'] },
] as const;

function fieldError(
  errors: ReturnType<typeof validateChannelEditor>,
  key: string,
): string | undefined {
  return errors.find((error) => error.field === key)?.message;
}

function ConfigField({
  descriptor,
  state,
  setState,
  errors,
}: {
  descriptor: DaemonChannelConfigFieldDescriptor;
  state: ChannelEditorState;
  setState: (state: ChannelEditorState) => void;
  errors: ReturnType<typeof validateChannelEditor>;
}) {
  const id = useId();
  const error = fieldError(errors, descriptor.key);
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy = [
    descriptor.description || descriptor.envResolvable ? descriptionId : '',
    error ? errorId : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (descriptor.kind === 'secret') {
    const secret = state.secrets[descriptor.key];
    if (!secret) return null;
    return (
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor={id}>
          {descriptor.label}
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
              Keep stored
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
            {secret.present ? 'Replace' : 'Enter credential'}
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
              Clear stored credential
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
            Permanently remove the stored {descriptor.label.toLowerCase()}.
          </label>
        ) : null}
        {descriptor.description || descriptor.envResolvable ? (
          <FieldDescription id={descriptionId}>
            {descriptor.description}
            {descriptor.description && descriptor.envResolvable ? ' ' : null}
            {descriptor.envResolvable
              ? 'Environment references are supported.'
              : null}
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
            placeholder={`Select ${descriptor.label.toLowerCase()}`}
          />
        </SelectTrigger>
        <SelectContent>
          {descriptor.options?.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
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
        {descriptor.label}
        {descriptor.required ? <span aria-hidden="true">*</span> : null}
      </FieldLabel>
      {control}
      {descriptor.description || descriptor.envResolvable ? (
        <FieldDescription id={descriptionId}>
          {descriptor.description}
          {descriptor.description && descriptor.envResolvable ? ' ' : null}
          {descriptor.envResolvable
            ? 'Environment references are supported.'
            : null}
        </FieldDescription>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

export function ChannelEditorDialog({
  open,
  catalog,
  expectedRevision,
  instance,
  error,
  onOpenChange,
  onSubmit,
  onQrHandoff,
  returnFocusRef,
}: ChannelEditorDialogProps) {
  const manageableCatalog = useMemo(
    () => catalog.filter((descriptor) => descriptor.manageable),
    [catalog],
  );
  const [state, setState] = useState(() =>
    createChannelEditorState({ catalog, expectedRevision, instance }),
  );
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setState(createChannelEditorState({ catalog, expectedRevision, instance }));
    setSaving(false);
  }, [catalog, expectedRevision, instance, open]);

  const descriptor = manageableCatalog.find((item) => item.type === state.type);
  const errors = validateChannelEditor(state);
  const nameError = fieldError(errors, 'name');
  const typeError = fieldError(errors, 'type');

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
        className="max-h-[min(88vh,760px)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
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
            {instance ? `Edit ${instance.name}` : 'Add channel'}
          </DialogTitle>
          <DialogDescription>
            Configure this workspace connection. Stored credentials are never
            shown.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto pr-1">
          <FieldGroup className="gap-6">
            {error ? (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <FieldSet>
              <FieldLegend>Channel</FieldLegend>
              <Field data-invalid={Boolean(nameError)}>
                <FieldLabel htmlFor="channel-editor-name">Name *</FieldLabel>
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
                    The channel name cannot be changed.
                  </FieldDescription>
                ) : null}
                <FieldError id="channel-editor-name-error">
                  {nameError}
                </FieldError>
              </Field>
              <Field data-invalid={Boolean(typeError)}>
                <FieldLabel htmlFor="channel-editor-type">Type *</FieldLabel>
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
                    <SelectValue placeholder="Select channel type" />
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
                    The channel type cannot be changed.
                  </FieldDescription>
                ) : null}
                <FieldError>{typeError}</FieldError>
              </Field>
            </FieldSet>

            {descriptor?.auth.includes('qr') &&
            descriptor.auth.includes('credentials') ? (
              <FieldSet>
                <FieldLegend>Authentication</FieldLegend>
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
                    <KeyRoundIcon /> Enter credentials
                  </Button>
                  <Button
                    type="button"
                    variant={
                      state.authMethod === 'qr' ? 'secondary' : 'outline'
                    }
                    onClick={() => setState({ ...state, authMethod: 'qr' })}
                  >
                    <QrCodeIcon /> Continue with QR code
                  </Button>
                </div>
                {state.authMethod === 'qr' ? (
                  <FieldDescription>
                    Save this configuration, then continue to QR authentication.
                  </FieldDescription>
                ) : null}
              </FieldSet>
            ) : null}

            {descriptor &&
            state.authMethod === 'credentials' &&
            descriptor.fields.length > 0 ? (
              <FieldSet>
                <FieldLegend>{descriptor.displayName} settings</FieldLegend>
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
                key={section.title}
                className="group rounded-lg border p-3"
              >
                <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                  {section.title}
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
                </FieldGroup>
              </details>
            ))}
          </FieldGroup>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={errors.length > 0 || saving}
            onClick={() => void submit()}
          >
            {saving ? <Spinner /> : null}
            {instance
              ? 'Save changes'
              : channelEditorNeedsQrHandoff(state)
                ? 'Save and continue'
                : 'Add channel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
