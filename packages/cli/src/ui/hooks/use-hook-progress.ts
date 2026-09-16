/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '../../i18n/index.js';
import { formatDuration } from '../utils/formatters.js';
import { useEffect, useRef, useState } from 'react';
import {
  MessageBusType,
  type HookProgress,
} from '@qwen-code/qwen-code-core/confirmation-bus/types.js';
import type { MessageBus } from '@qwen-code/qwen-code-core/confirmation-bus/message-bus.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  sanitizeForStderr,
  DENIAL_REASON_ECHO_LIMIT,
} from '../../utils/errors.js';

export interface HookProgressRow {
  eventName: string;
  hookName: string;
  text: string;
  level: 'info' | 'warning' | 'error';
}

export function hookProgressToRow(msg: HookProgress): HookProgressRow | null {
  if (msg.phase !== 'end' || msg.async || msg.outcome === 'cancelled')
    return null;
  const hookName = `${msg.hookType} #${msg.index + 1}`;
  let text: string;
  let level: HookProgressRow['level'];
  switch (msg.outcome) {
    case 'timeout':
      text = `Hook ${hookName} (${msg.eventName}) timed out after ${formatDuration(msg.durationMs ?? 0)} — raise the hook's timeout to give it more time.`;
      level = 'error';
      break;
    case 'error':
      text =
        msg.exitCode !== undefined
          ? `Hook ${hookName} (${msg.eventName}) exited with code ${msg.exitCode}: ${msg.error ?? msg.systemMessage ?? 'no output'}`
          : `Hook ${hookName} (${msg.eventName}) failed: ${msg.error ?? msg.systemMessage ?? 'no output'}`;
      level = msg.exitCode !== undefined ? 'warning' : 'error';
      break;
    case 'blocked':
      if (msg.eventName === 'Stop' || msg.eventName === 'UserPromptSubmit')
        return null;
      text = `Hook ${hookName} blocked ${msg.eventName}: ${msg.blockedReason ?? 'no reason given'}`;
      level = 'warning';
      break;
    case 'success':
      if (msg.eventName === 'Stop' || !msg.systemMessage) return null;
      text = msg.systemMessage;
      level = 'info';
      break;
    default:
      return null;
  }
  return {
    eventName: msg.eventName,
    hookName,
    text: sanitizeForStderr(text, DENIAL_REASON_ECHO_LIMIT),
    level,
  };
}

export interface UseHookProgressOptions {
  config: Config | undefined;
  onOutcome: (row: HookProgressRow) => void;
}

export function useHookProgress({
  config,
  onOutcome,
}: UseHookProgressOptions): string | null {
  const [status, setStatus] = useState<string | null>(null);
  const running = useRef(
    new Map<
      string,
      { count: number; eventName: string; statusMessage?: string }
    >(),
  );
  const onOutcomeRef = useRef(onOutcome);
  onOutcomeRef.current = onOutcome;
  useEffect(() => {
    if (!config) return;
    let bus: MessageBus | undefined;
    const active = running.current;
    const listener = (msg: HookProgress) => {
      const key = `${msg.eventName}\0${msg.index}\0${msg.hookName}`;
      const existing = active.get(key);
      if (msg.phase === 'start') {
        if (existing) existing.count++;
        else
          active.set(key, {
            count: 1,
            eventName: msg.eventName,
            statusMessage: msg.statusMessage,
          });
      } else {
        if (existing && existing.count > 1) existing.count--;
        else active.delete(key);
        const row = hookProgressToRow(msg);
        if (row) onOutcomeRef.current(row);
      }
      const first = active.values().next().value;
      setStatus(
        first
          ? sanitizeForStderr(
              first.statusMessage ?? '',
              DENIAL_REASON_ECHO_LIMIT,
            ) || t('Running {{event}} hooks…', { event: first.eventName })
          : null,
      );
    };
    const attach = (nextBus: MessageBus) => {
      bus?.unsubscribe(MessageBusType.HOOK_PROGRESS, listener);
      active.clear();
      setStatus(null);
      bus = nextBus;
      bus.subscribe(MessageBusType.HOOK_PROGRESS, listener);
    };
    const currentBus = config.getMessageBus();
    if (currentBus) attach(currentBus);
    const unsubscribeBusChange = config.onMessageBusChange(attach);
    return () => {
      unsubscribeBusChange();
      bus?.unsubscribe(MessageBusType.HOOK_PROGRESS, listener);
      active.clear();
      setStatus(null);
    };
  }, [config]);
  return status;
}
