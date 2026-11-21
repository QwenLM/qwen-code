/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '@qwen-code/qwen-code-core/utils/errors.js';
import type { GoogleOAuthInteractiveOptions } from '@qwen-code/qwen-code-core/code_assist/oauth2.js';

export type GoogleOAuthStatus = 'waiting' | 'awaiting-code' | 'error';
export type GoogleOAuthActivate = (
  signal: AbortSignal,
  callbacks: Omit<GoogleOAuthInteractiveOptions, 'interactive' | 'signal'>,
) => Promise<void>;

type ManualCodeRequest = {
  resolve: (code: string) => void;
  reject: (error: unknown) => void;
};

export function useGoogleOAuth({
  suppressBrowserLaunch,
  onActivate,
}: {
  suppressBrowserLaunch: boolean;
  onActivate: GoogleOAuthActivate;
}) {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<GoogleOAuthStatus>('waiting');
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const [error, setError] = useState('');
  const activateRef = useRef(onActivate);
  activateRef.current = onActivate;
  const controllerRef = useRef<AbortController | null>(null);
  const manualCodeRef = useRef<ManualCodeRequest | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    let mounted = true;
    setStatus('waiting');
    setAuthorizationUrl('');
    setError('');
    manualCodeRef.current = null;

    const callbacks: Omit<
      GoogleOAuthInteractiveOptions,
      'interactive' | 'signal'
    > = {
      onAuthorizationUrl: (url) => {
        if (mounted) setAuthorizationUrl(url);
      },
      requestAuthorizationCode: () =>
        new Promise<string>((resolve, reject) => {
          manualCodeRef.current = { resolve, reject };
          if (mounted) setStatus('awaiting-code');
        }),
    };

    void Promise.resolve()
      .then(() =>
        controller.signal.aborted
          ? undefined
          : activateRef.current(controller.signal, callbacks),
      )
      .catch((activationError: unknown) => {
        if (mounted && !controller.signal.aborted) {
          setError(getErrorMessage(activationError));
          setStatus('error');
        }
      });

    return () => {
      mounted = false;
      manualCodeRef.current = null;
      controllerRef.current = null;
      controller.abort();
    };
  }, [attempt, suppressBrowserLaunch]);

  const cancel = () => {
    controllerRef.current?.abort();
  };

  const retry = () => {
    controllerRef.current?.abort();
    setAttempt((value) => value + 1);
  };

  const submitCode = (code: string) => {
    const request = manualCodeRef.current;
    if (!request) return;
    manualCodeRef.current = null;
    setStatus('waiting');
    request.resolve(code);
  };

  return {
    status,
    authorizationUrl,
    error,
    manualCodePending: manualCodeRef.current !== null,
    cancel,
    retry,
    submitCode,
  };
}
