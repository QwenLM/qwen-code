/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { ModRenderInput } from '@qwen-code/qwen-code-core/mods/render-tree.js';
import { getInteractiveModSession } from '../../services/interactive-mod-session.js';

const unsubscribed = () => {};

/**
 * The props the Mods' hooks draw a transcript row with, while it is shown:
 * undefined until they answer, and when they leave it as it is. Pass no
 * input for a row they do not draw, such as one still streaming.
 */
export function useModRow<T extends ModRenderInput>(
  config: Config | undefined,
  sessionId: string | undefined,
  input: T | undefined,
): T['props'] | undefined {
  const session =
    config && input ? getInteractiveModSession(config) : undefined;
  // A row shown before the Mods have loaded is offered to them once they do.
  const [ready, setReady] = useState(() =>
    Boolean(session && !session.starting),
  );
  useEffect(() => {
    if (!session || ready) return;
    let live = true;
    session.ready.then(
      () => {
        if (live) setReady(true);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [session, ready]);
  const key = input ? JSON.stringify(input) : '';
  // The input is read through its key, so a re-created equal input keeps the
  // subscription.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => input, [key]);
  const subscribe = useCallback(
    (listener: () => void) =>
      (ready &&
        stable &&
        sessionId !== undefined &&
        session?.watchRow(sessionId, stable, listener)) ||
      unsubscribed,
    [session, sessionId, ready, stable],
  );
  const snapshot = useCallback(
    () =>
      stable && sessionId !== undefined
        ? (session?.rowProps(sessionId, stable.component, stable.requestId) as
            | T['props']
            | undefined)
        : undefined,
    [session, sessionId, stable],
  );
  return useSyncExternalStore(subscribe, snapshot);
}
