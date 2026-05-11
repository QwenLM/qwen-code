/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Context } from '@opentelemetry/api';

let sessionRootContext: Context | undefined;

export function setSessionContext(ctx: Context | undefined): void {
  sessionRootContext = ctx;
}

export function getSessionContext(): Context | undefined {
  return sessionRootContext;
}
