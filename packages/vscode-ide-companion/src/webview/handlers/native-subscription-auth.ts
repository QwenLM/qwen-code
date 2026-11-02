/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import { setTimeout as delay } from 'node:timers/promises';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import { logger } from '../../utils/logger.js';

interface Choice extends vscode.QuickPickItem {
  value: string;
}
export interface NativeSubscriptionActionOptions {
  transport: Pick<
    DaemonClient,
    'getSubscriptionConfig' | 'signOutSubscription'
  >;
  signal: AbortSignal;
  action: 'logout' | 'upgrade';
}
export type NativeSubscriptionActionResult = {
  kind: 'signed-out' | 'upgrade-opened' | 'unavailable' | 'cancelled';
};

export async function runNativeSubscriptionAction({
  transport,
  signal: ownerSignal,
  action,
}: NativeSubscriptionActionOptions): Promise<NativeSubscriptionActionResult> {
  if (action === 'logout') {
    ownerSignal.throwIfAborted();
    const config = await transport.getSubscriptionConfig({
      signal: ownerSignal,
    });
    ownerSignal.throwIfAborted();
    if (!config.enabled) return { kind: 'unavailable' };
    try {
      await transport.signOutSubscription();
    } catch (error) {
      if (
        (error as { body?: { errorStage?: string } })?.body?.errorStage !==
        'revoke'
      )
        throw error;
      logger.warn(
        '[QwenSubscription] Remote revocation failed after local sign-out',
      );
    }
    return { kind: ownerSignal.aborted ? 'cancelled' : 'signed-out' };
  }
  const lifetime = new AbortController();
  const signal = AbortSignal.any([ownerSignal, lifetime.signal]);
  const picker = vscode.window.createQuickPick<Choice>();
  picker.title = 'Qwen';
  picker.placeholder = 'Filter options';
  picker.ignoreFocusOut = true;
  const hidden = picker.onDidHide(() => lifetime.abort());
  const abort = () => picker.hide();
  signal.addEventListener('abort', abort, { once: true });

  const status = (label: string) => {
    signal.throwIfAborted();
    picker.value = '';
    picker.items = [
      { label, kind: vscode.QuickPickItemKind.Separator, value: '' },
    ];
    picker.busy = true;
  };
  const choose = (label: string, item: Choice): Promise<void> => {
    status(label);
    picker.items = [...picker.items, item];
    picker.busy = false;
    return new Promise((resolve, reject) => {
      const accepted = picker.onDidAccept(() => {
        if (!picker.selectedItems[0]?.value) return;
        cleanup();
        resolve();
      });
      const cancelled = () => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => {
        accepted.dispose();
        signal.removeEventListener('abort', cancelled);
      };
      signal.addEventListener('abort', cancelled, { once: true });
    });
  };
  picker.show();
  try {
    while (!signal.aborted) {
      try {
        status('Checking your Qwen account…');
        const config = await transport.getSubscriptionConfig({ signal });
        signal.throwIfAborted();
        if (!config.enabled || !config.plansUrl) {
          await choose('Qwen subscription is not available in this build', {
            label: 'Done',
            value: 'done',
          });
          return { kind: 'unavailable' };
        }
        status('Opening subscription plans…');
        if (!(await vscode.env.openExternal(vscode.Uri.parse(config.plansUrl))))
          throw new Error('Unable to open the browser.');
        await choose('Qwen subscription plans opened in your browser', {
          label: 'Done',
          value: 'done',
        });
        return { kind: 'upgrade-opened' };
      } catch (error) {
        const failure = error as {
          body?: {
            code?: unknown;
            errorStage?: unknown;
            errorStatus?: unknown;
            retryAfterMs?: number;
          };
          status?: unknown;
        } | null;
        if (signal.aborted) throw error;
        const code =
          typeof failure?.body?.code === 'string' &&
          /^[a-z][a-z0-9_]{0,80}$/.test(failure.body.code)
            ? failure.body.code
            : undefined;
        const statusCode =
          typeof failure?.status === 'number'
            ? failure.status
            : typeof failure?.body?.errorStatus === 'number'
              ? failure.body.errorStatus
              : undefined;
        logger.warn('[QwenSubscription] Request failed', {
          code,
          status: statusCode,
          action,
        });
        const retryAfter = failure?.body?.retryAfterMs;
        if (retryAfter && retryAfter > 0) {
          status('Too many requests. Waiting before retry…');
          await delay(retryAfter, undefined, { signal });
        }
        await choose('Unable to open Qwen subscription plans', {
          label: 'Retry',
          value: 'retry',
          detail: `Check your connection and retry${statusCode ? ` (HTTP ${statusCode})` : ''}.`,
        });
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    hidden.dispose();
    picker.hide();
    picker.dispose();
  }
  return { kind: 'cancelled' };
}
