/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';

import { staleSessionError } from '../core/errors.js';
import type { ScreenshotEnvelope } from '../core/primitives.js';
import type { SupportedCommand } from '../core/schemas.js';
import { createBrowserBackend, type BrowserBackend } from '../runtime.js';

function jsonBoundary(value: unknown, label: string): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return JSON.parse(serialized);
  } catch (error) {
    const wrapped = new TypeError(label + ' must be JSON-serializable');
    wrapped.cause = error;
    throw wrapped;
  }
  throw new TypeError(label + ' must be JSON-serializable');
}

export class BrowserSdkContext {
  private active = true;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly backend: BrowserBackend) {}

  async call<Result>(method: SupportedCommand, args: unknown): Promise<Result> {
    this.assertActive();
    let result: unknown;
    try {
      result = await this.backend.dispatch(
        method,
        jsonBoundary(args, 'Browser operation arguments'),
      );
    } catch (error) {
      if (!this.active) throw staleSessionError();
      throw error;
    }
    this.assertActive();
    return jsonBoundary(result, 'Browser operation result') as Result;
  }

  async screenshotCall(
    method: SupportedCommand,
    args: unknown,
  ): Promise<Uint8Array> {
    const image = await this.call<ScreenshotEnvelope>(method, args);
    return Uint8Array.from(Buffer.from(image.base64, 'base64'));
  }

  close(): Promise<void> {
    this.active = false;
    return (this.closePromise ??= this.backend.stop());
  }

  private assertActive(): void {
    if (!this.active) throw staleSessionError();
  }
}

export async function createBrowserSdkContext(): Promise<BrowserSdkContext> {
  return new BrowserSdkContext(await createBrowserBackend());
}
