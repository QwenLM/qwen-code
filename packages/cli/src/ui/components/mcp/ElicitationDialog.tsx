/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import open from 'open';
import {
  getEnumOptions,
  getMultiSelectOptions,
  isMultiSelectSchema,
  isSingleSelectSchema,
  type ElicitationRequestEvent,
  type PrimitiveElicitationSchema,
  validateElicitationInput,
} from '@qwen-code/qwen-code-core';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../keyMatchers.js';
import { TextInput } from '../shared/TextInput.js';
import { theme } from '../../semantic-colors.js';

export type QueuedElicitationRequest = ElicitationRequestEvent & {
  completed?: boolean;
  respond: (result: ElicitResult) => void;
  dismiss: () => void;
  cancel?: () => void;
};

interface Props {
  event: QueuedElicitationRequest;
}

type FormValue = string | boolean | string[];

function getSchema(params: ElicitationRequestEvent['params']) {
  if ('requestedSchema' in params && params.requestedSchema) {
    return params.requestedSchema as {
      properties?: Record<string, PrimitiveElicitationSchema>;
      required?: string[];
    };
  }
  return { properties: {}, required: [] };
}

function fieldLabel(name: string, schema: PrimitiveElicitationSchema): string {
  return typeof schema.title === 'string' ? schema.title : name;
}

export const ElicitationDialog: React.FC<Props> = ({ event }) => {
  if (event.params.mode === 'url') {
    return <UrlElicitationDialog event={event} />;
  }
  return <FormElicitationDialog event={event} />;
};

const FormElicitationDialog: React.FC<Props> = ({ event }) => {
  const schema = useMemo(() => getSchema(event.params), [event.params]);
  const fields = useMemo(
    () => Object.entries(schema.properties ?? {}),
    [schema.properties],
  );
  const required = new Set(schema.required ?? []);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [focusedButton, setFocusedButton] = useState<
    'accept' | 'decline' | null
  >(fields.length === 0 ? 'accept' : null);
  const [enumIndex, setEnumIndex] = useState(0);
  const [values, setValues] = useState<Record<string, FormValue>>(() => {
    const initial: Record<string, FormValue> = {};
    for (const [name, propSchema] of Object.entries(schema.properties ?? {})) {
      if (propSchema.default !== undefined) {
        if (Array.isArray(propSchema.default)) {
          initial[name] = propSchema.default.map(String);
        } else if (typeof propSchema.default === 'boolean') {
          initial[name] = propSchema.default;
        } else {
          initial[name] = String(propSchema.default);
        }
      } else if (propSchema.type === 'boolean') {
        initial[name] = false;
      }
    }
    return initial;
  });
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const current = fields[fieldIndex];
  const currentName = current?.[0];
  const currentSchema = current?.[1];
  const currentValue =
    currentName !== undefined ? values[currentName] : undefined;
  const isTextField =
    currentSchema &&
    !isSingleSelectSchema(currentSchema) &&
    !isMultiSelectSchema(currentSchema) &&
    currentSchema.type !== 'boolean';

  const isMissing = (value: FormValue | undefined) =>
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);
  const hasFieldValue = (value: FormValue | undefined): value is FormValue =>
    !isMissing(value);

  const getFieldError = (
    name: string,
    propSchema: PrimitiveElicitationSchema,
    value: FormValue | undefined,
  ): string | null => {
    if (!hasFieldValue(value)) {
      return required.has(name)
        ? `${fieldLabel(name, propSchema)} is required`
        : null;
    }
    const result = validateElicitationInput(value, propSchema);
    return result.isValid ? null : (result.error ?? 'Invalid value');
  };

  const setFieldValue = (
    name: string,
    propSchema: PrimitiveElicitationSchema,
    value: FormValue,
  ) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    const error = getFieldError(name, propSchema, value);
    setValidationErrors((prev) => {
      const next = { ...prev };
      if (error) {
        next[name] = error;
      } else {
        delete next[name];
      }
      return next;
    });
    setSubmitError(null);
  };

  const moveToNextFieldOrButton = () => {
    if (fieldIndex < fields.length - 1) {
      setFieldIndex(fieldIndex + 1);
      setFocusedButton(null);
      return;
    }
    setFocusedButton('accept');
  };

  useEffect(() => {
    if (!currentName) return;
    setEnumIndex(0);
  }, [currentName]);

  const validateAll = (): {
    content?: Record<string, string | number | boolean | string[]>;
    error?: string;
  } => {
    const content: Record<string, string | number | boolean | string[]> = {};
    const nextErrors: Record<string, string> = {};
    for (const [name, propSchema] of fields) {
      const value = values[name];
      const missing = isMissing(value);
      const fieldError = getFieldError(name, propSchema, value);
      if (fieldError) {
        nextErrors[name] = fieldError;
      }
      if (missing) continue;
      const result = validateElicitationInput(value, propSchema);
      if (!result.isValid) {
        nextErrors[name] = result.error ?? 'Invalid value';
        continue;
      }
      if (result.value !== undefined) {
        content[name] = result.value;
      }
    }
    if (Object.keys(nextErrors).length > 0) {
      setValidationErrors(nextErrors);
      return { error: 'Please fix the highlighted fields before accepting.' };
    }
    setValidationErrors({});
    return { content };
  };

  const submit = (action: ElicitResult['action']) => {
    if (action !== 'accept') {
      event.respond({ action });
      event.dismiss();
      return;
    }
    const result = validateAll();
    if (result.error) {
      setSubmitError(result.error);
      return;
    }
    event.respond({ action: 'accept', content: result.content });
    event.dismiss();
  };

  useKeypress(
    (key) => {
      if (isTextField && focusedButton === null) {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          submit('cancel');
          return;
        }
        if (key.name !== 'up' && key.name !== 'down' && key.name !== 'tab') {
          return;
        }
      }

      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        submit('cancel');
        return;
      }
      if (key.name === 'tab') {
        setFocusedButton((previous) =>
          previous === 'accept'
            ? 'decline'
            : previous === 'decline'
              ? null
              : 'accept',
        );
        return;
      }
      if (keyMatchers[Command.SELECTION_UP](key)) {
        if (
          currentSchema &&
          (isSingleSelectSchema(currentSchema) ||
            isMultiSelectSchema(currentSchema))
        ) {
          if (enumIndex > 0) {
            setEnumIndex(enumIndex - 1);
          } else {
            setFieldIndex(Math.max(0, fieldIndex - 1));
          }
        } else if (focusedButton) {
          setFocusedButton(null);
        } else {
          setFieldIndex(Math.max(0, fieldIndex - 1));
        }
        return;
      }
      if (keyMatchers[Command.SELECTION_DOWN](key)) {
        if (
          currentSchema &&
          (isSingleSelectSchema(currentSchema) ||
            isMultiSelectSchema(currentSchema))
        ) {
          const options = isSingleSelectSchema(currentSchema)
            ? getEnumOptions(currentSchema)
            : getMultiSelectOptions(currentSchema);
          if (enumIndex < options.length - 1) {
            setEnumIndex(enumIndex + 1);
          } else {
            moveToNextFieldOrButton();
          }
        } else if (!focusedButton && fieldIndex < fields.length - 1) {
          setFieldIndex(fieldIndex + 1);
        } else {
          setFocusedButton('accept');
        }
        return;
      }
      if (key.name === 'space' && currentName && currentSchema) {
        if (currentSchema.type === 'boolean') {
          setFieldValue(currentName, currentSchema, currentValue !== true);
          return;
        }
        if (isMultiSelectSchema(currentSchema)) {
          const option = getMultiSelectOptions(currentSchema)[enumIndex];
          if (!option) return;
          const currentValues = Array.isArray(currentValue) ? currentValue : [];
          setFieldValue(
            currentName,
            currentSchema,
            currentValues.includes(option.value)
              ? currentValues.filter((value) => value !== option.value)
              : [...currentValues, option.value],
          );
          return;
        }
      }
      if (key.name === 'return') {
        if (focusedButton) {
          submit(focusedButton);
          return;
        }
        if (
          currentName &&
          currentSchema &&
          isSingleSelectSchema(currentSchema)
        ) {
          const option = getEnumOptions(currentSchema)[enumIndex];
          if (option) {
            setFieldValue(currentName, currentSchema, option.value);
            moveToNextFieldOrButton();
          }
          return;
        }
        moveToNextFieldOrButton();
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" padding={1}>
      <Text color={theme.text.accent} bold>
        MCP server &quot;{event.serverName}&quot; requests input
      </Text>
      <Box marginY={1}>
        <Text>{event.params.message}</Text>
      </Box>
      <Box flexDirection="column">
        {fields.map(([name, propSchema], index) => {
          const active = focusedButton === null && index === fieldIndex;
          const value = values[name];
          const textInputValue = value !== undefined ? String(value) : '';
          const label = fieldLabel(name, propSchema);
          const error = validationErrors[name];
          const missing = isMissing(value);
          const status = error
            ? '!'
            : !missing
              ? '✓'
              : required.has(name)
                ? '*'
                : ' ';
          return (
            <Box key={name} flexDirection="column">
              <Box>
                <Text
                  color={active ? theme.text.accent : theme.text.primary}
                  bold={active}
                >
                  {active ? '❯ ' : '  '}
                </Text>
                <Text
                  color={
                    error
                      ? theme.status.error
                      : !missing
                        ? theme.status.success
                        : theme.text.primary
                  }
                >
                  {status}{' '}
                </Text>
                <Text
                  color={active ? theme.text.accent : theme.text.primary}
                  bold={active}
                >
                  {label}
                  {required.has(name) ? ' *' : ''}:{' '}
                </Text>
                {active && isTextField ? (
                  <TextInput
                    value={textInputValue}
                    initialCursorOffset={textInputValue.length}
                    onChange={(next) => {
                      setFieldValue(name, propSchema, next);
                    }}
                    onSubmit={moveToNextFieldOrButton}
                    isActive
                    inputWidth={50}
                  />
                ) : (
                  <Text>{renderValue(propSchema, value)}</Text>
                )}
              </Box>
              {active && isSingleSelectSchema(propSchema) && (
                <EnumOptions
                  options={getEnumOptions(propSchema)}
                  selectedValues={typeof value === 'string' ? [value] : []}
                  activeIndex={enumIndex}
                />
              )}
              {active && isMultiSelectSchema(propSchema) && (
                <EnumOptions
                  options={getMultiSelectOptions(propSchema)}
                  selectedValues={Array.isArray(value) ? value : []}
                  activeIndex={enumIndex}
                  multi
                />
              )}
              {typeof propSchema.description === 'string' && (
                <Box marginLeft={4}>
                  <Text dimColor>{propSchema.description}</Text>
                </Box>
              )}
              {error && (
                <Box marginLeft={4}>
                  <Text color={theme.status.error}>{error}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
      {submitError && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{submitError}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text
          color={
            focusedButton === 'accept'
              ? theme.status.success
              : theme.text.primary
          }
          bold={focusedButton === 'accept'}
        >
          {focusedButton === 'accept' ? '❯ ' : '  '}Accept
        </Text>
        <Text> </Text>
        <Text
          color={
            focusedButton === 'decline'
              ? theme.status.error
              : theme.text.primary
          }
          bold={focusedButton === 'decline'}
        >
          {focusedButton === 'decline' ? '❯ ' : '  '}Decline
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ navigate · Space toggle · Enter select/submit · Tab buttons · Esc
          cancel
        </Text>
      </Box>
    </Box>
  );
};

function renderValue(
  schema: PrimitiveElicitationSchema,
  value: FormValue | undefined,
): string {
  if (value === undefined || value === '') return '(not set)';
  if (schema.type === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    const labels = getMultiSelectOptions(schema)
      .filter((option) => value.includes(option.value))
      .map((option) => option.label);
    return labels.length > 0 ? labels.join(', ') : '(not set)';
  }
  if (isSingleSelectSchema(schema)) {
    return (
      getEnumOptions(schema).find((option) => option.value === value)?.label ??
      String(value)
    );
  }
  return String(value);
}

const EnumOptions: React.FC<{
  options: Array<{ value: string; label: string }>;
  selectedValues: string[];
  activeIndex: number;
  multi?: boolean;
}> = ({ options, selectedValues, activeIndex, multi }) => (
  <Box flexDirection="column" marginLeft={4}>
    {options.map((option, index) => {
      const selected = selectedValues.includes(option.value);
      const active = index === activeIndex;
      return (
        <Text
          key={option.value}
          color={active ? theme.text.accent : theme.text.primary}
          bold={active}
        >
          {active ? '❯ ' : '  '}
          {multi ? (selected ? '[✓] ' : '[ ] ') : selected ? '(●) ' : '(○) '}
          {option.label}
        </Text>
      );
    })}
  </Box>
);

const UrlElicitationDialog: React.FC<Props> = ({ event }) => {
  const params = event.params as Extract<
    ElicitationRequestEvent['params'],
    { mode: 'url' }
  >;
  const [phase, setPhase] = useState<'prompt' | 'waiting'>('prompt');
  const [focused, setFocused] = useState<
    'accept' | 'decline' | 'open' | 'done' | 'cancel'
  >('accept');
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    const handleAbort = () => {
      // AppContainer owns promise cancellation; this effect only keeps the
      // dialog from lingering if the URL flow is already mounted.
      if (phase === 'prompt') {
        event.respond({ action: 'cancel' });
      }
      event.dismiss();
    };
    if (event.signal.aborted) {
      handleAbort();
      return;
    }
    event.signal.addEventListener('abort', handleAbort, { once: true });
    return () => event.signal.removeEventListener('abort', handleAbort);
  }, [event, phase]);

  useEffect(() => {
    if (phase === 'waiting' && event.completed) {
      event.dismiss();
    }
  }, [event, event.completed, phase]);

  const openRequestedUrl = async (): Promise<boolean> => {
    const safetyError = getUrlSafetyError(params.url);
    if (safetyError) {
      setOpenError(safetyError);
      return false;
    }

    try {
      await open(params.url);
      setOpenError(null);
      return true;
    } catch (error) {
      setOpenError(
        `Failed to open URL: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  };

  const accept = async () => {
    if (!(await openRequestedUrl())) {
      return;
    }
    event.respond({ action: 'accept' });
    setPhase('waiting');
    setFocused('open');
  };

  useKeypress(
    (key) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        if (phase === 'prompt') {
          event.respond({ action: 'cancel' });
        }
        event.dismiss();
        return;
      }
      if (key.name === 'left' || key.name === 'right' || key.name === 'tab') {
        if (phase === 'prompt') {
          setFocused((prev) => (prev === 'accept' ? 'decline' : 'accept'));
        } else {
          setFocused((prev) =>
            prev === 'open' ? 'done' : prev === 'done' ? 'cancel' : 'open',
          );
        }
        return;
      }
      if (key.name === 'return') {
        if (phase === 'prompt') {
          if (focused === 'accept') void accept();
          else {
            event.respond({ action: 'decline' });
            event.dismiss();
          }
        } else if (focused === 'open') {
          void openRequestedUrl();
        } else if (focused === 'cancel') {
          event.cancel?.();
          event.dismiss();
        } else {
          event.dismiss();
        }
      }
    },
    { isActive: true },
  );

  const parsed = parseUrl(params.url);
  return (
    <Box flexDirection="column" padding={1}>
      <Text color={theme.text.accent} bold>
        MCP server &quot;{event.serverName}&quot; requests a URL interaction
      </Text>
      <Box marginY={1}>
        <Text>{params.message}</Text>
      </Box>
      <Text>
        URL: {parsed.before}
        <Text color={theme.text.accent} bold>
          {parsed.host}
        </Text>
        {parsed.after}
      </Text>
      {openError && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{openError}</Text>
        </Box>
      )}
      {phase === 'waiting' && (
        <Box marginTop={1}>
          <Text dimColor>Waiting for the server to confirm completion...</Text>
        </Box>
      )}
      <Box marginTop={1}>
        {phase === 'prompt' ? (
          <>
            <Text
              color={
                focused === 'accept' ? theme.status.success : theme.text.primary
              }
              bold={focused === 'accept'}
            >
              {focused === 'accept' ? '❯ ' : '  '}Accept and open URL
            </Text>
            <Text> </Text>
            <Text
              color={
                focused === 'decline' ? theme.status.error : theme.text.primary
              }
              bold={focused === 'decline'}
            >
              {focused === 'decline' ? '❯ ' : '  '}Decline
            </Text>
          </>
        ) : (
          <>
            <Text
              color={
                focused === 'open' ? theme.text.accent : theme.text.primary
              }
              bold={focused === 'open'}
            >
              {focused === 'open' ? '❯ ' : '  '}Reopen URL
            </Text>
            <Text> </Text>
            <Text
              color={
                focused === 'done' ? theme.text.accent : theme.text.primary
              }
              bold={focused === 'done'}
            >
              {focused === 'done' ? '❯ ' : '  '}Continue
            </Text>
            <Text> </Text>
            <Text
              color={
                focused === 'cancel' ? theme.status.error : theme.text.primary
              }
              bold={focused === 'cancel'}
            >
              {focused === 'cancel' ? '❯ ' : '  '}Cancel wait
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
};

function parseUrl(url: string): {
  before: string;
  host: string;
  after: string;
} {
  try {
    const parsed = new URL(url);
    if (!parsed.host) {
      return { before: '', host: parsed.href, after: '' };
    }
    const userInfo = parsed.username
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
      : '';
    return {
      before: `${parsed.protocol}//${userInfo}`,
      host: parsed.host,
      after: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    };
  } catch {
    return { before: '', host: url, after: '' };
  }
}

function getUrlSafetyError(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'The MCP server provided an invalid URL.';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Only http:// and https:// URLs can be opened automatically.';
  }

  return null;
}
