/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { GoogleOAuthInteractiveOptions } from '@qwen-code/qwen-code-core/code_assist/oauth2.js';
import { useGoogleOAuth } from './use-google-oauth.js';

type Callbacks = Omit<GoogleOAuthInteractiveOptions, 'interactive' | 'signal'>;

describe('useGoogleOAuth', () => {
  it('connects the manual authorization code to the activation promise', async () => {
    let callbacks: Callbacks | undefined;
    let finish: () => void = () => undefined;
    const onActivate = vi.fn((_signal: AbortSignal, next: Callbacks) => {
      callbacks = next;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const { result, unmount } = renderHook(() =>
      useGoogleOAuth({ suppressBrowserLaunch: true, onActivate }),
    );
    await waitFor(() => expect(callbacks).toBeDefined());

    let code: Promise<string> | undefined;
    act(() => {
      code = callbacks!.requestAuthorizationCode!('https://oauth.test');
    });
    expect(result.current.status).toBe('awaiting-code');
    act(() => result.current.submitCode('manual-code'));

    await expect(code!).resolves.toBe('manual-code');
    expect(result.current.status).toBe('waiting');
    act(() => finish());
    unmount();
  });

  it('exposes errors and starts a clean attempt on retry', async () => {
    const onActivate = vi
      .fn()
      .mockRejectedValueOnce(new Error('setup failed'))
      .mockImplementation(() => new Promise<void>(() => undefined));
    const { result, unmount } = renderHook(() =>
      useGoogleOAuth({ suppressBrowserLaunch: false, onActivate }),
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('setup failed');
    act(() => result.current.retry());
    await waitFor(() => expect(onActivate).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe('waiting');
    expect(result.current.error).toBe('');
    unmount();
  });

  it('aborts activation on cancellation without publishing an error', async () => {
    let signal: AbortSignal | undefined;
    const onActivate = vi.fn((nextSignal: AbortSignal) => {
      signal = nextSignal;
      return new Promise<void>(() => undefined);
    });
    const { result, unmount } = renderHook(() =>
      useGoogleOAuth({ suppressBrowserLaunch: false, onActivate }),
    );
    await waitFor(() => expect(signal).toBeDefined());

    act(() => result.current.cancel());
    expect(signal!.aborted).toBe(true);
    unmount();
    expect(result.current.status).not.toBe('error');
  });
});
