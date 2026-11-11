/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ErrorFields {
  name?: string;
  message?: string;
  code?: string;
  stackTop?: string;
}

export function getErrorFields(error: unknown): ErrorFields | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) {
    const record = error as Error & Record<string, unknown>;
    return compactObject({
      name: error.name,
      message: error.message,
      code: stringify(record['code']),
      stackTop: getStackTop(error.stack),
    });
  }
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const name = stringify(record['name']);
    const message = stringify(record['message']);
    const code = stringify(record['code']);
    return compactObject({
      name,
      message: message ?? (name === undefined && code === undefined ? String(error) : undefined),
      code,
      stackTop: getStackTop(stringify(record['stack'])),
    });
  }
  return {
    message: String(error),
  };
}

export function getErrorCause(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<string, unknown>)['cause'];
}

export function getStackTop(stack: string | undefined): string | undefined {
  return stack
    ?.split(/\r?\n/)
    .find((line) => line.trimStart().startsWith('at '))
    ?.trim();
}

export function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  return String(value);
}

export interface ErrorDiagnostic {
  errorName?: string;
  errorMessage?: string;
  errorCode?: string;
  errorStackTop?: string;
  errorCauseName?: string;
  errorCauseMessage?: string;
  errorCauseCode?: string;
  errorCauseStackTop?: string;
}

export function getErrorDiagnostic(
  error: unknown,
): ErrorDiagnostic | undefined {
  const errorFields = getErrorFields(error);
  if (!errorFields) return undefined;

  const causeFields = getErrorFields(getErrorCause(error));
  return compactObject({
    errorName: errorFields.name,
    errorMessage: errorFields.message,
    errorCode: errorFields.code,
    errorStackTop: errorFields.stackTop,
    errorCauseName: causeFields?.name,
    errorCauseMessage: causeFields?.message,
    errorCauseCode: causeFields?.code,
    errorCauseStackTop: causeFields?.stackTop,
  });
}

export function formatErrorDiagnostic(diag: ErrorDiagnostic): string {
  const errorPart = formatNameMessageCode(
    diag.errorName,
    diag.errorMessage,
    diag.errorCode,
  );
  const causePart = formatNameMessageCode(
    diag.errorCauseName,
    diag.errorCauseMessage,
    diag.errorCauseCode,
  );
  return causePart ? `${errorPart}; cause=${causePart}` : errorPart;
}

function formatNameMessageCode(
  name?: string,
  message?: string,
  code?: string,
): string {
  const nameAndMessage = [name, message].filter(Boolean).join(': ');
  const base = nameAndMessage || code || 'unknown';
  return code && base !== code ? `${base} (${code})` : base;
}

export function compactObject<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}
