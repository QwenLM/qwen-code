/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { setTimeout as settleInput } from 'node:timers/promises';
import type { GoogleOAuthInteractiveOptions } from '@qwen-code/qwen-code-core/code_assist/oauth2.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { GoogleOAuthDialog } from './GoogleOAuthDialog.js';

type Callbacks = Omit<GoogleOAuthInteractiveOptions, 'interactive' | 'signal'>;

describe('GoogleOAuthDialog', () => {
  it('renders the authorization URL and submits the manual code from the input', async () => {
    let callbacks: Callbacks | undefined;
    let finish: () => void = () => undefined;
    const onActivate = vi.fn((_signal: AbortSignal, next: Callbacks) => {
      callbacks = next;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const ui = renderWithProviders(
      <GoogleOAuthDialog
        suppressBrowserLaunch
        onBack={vi.fn()}
        onConnect={onActivate}
      />,
    );
    try {
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      await callbacks!.onAuthorizationUrl?.(
        'https://accounts.google.test/auth',
      );
      const code = callbacks!.requestAuthorizationCode!(
        'https://accounts.google.test/auth',
      );
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('Sign in with Google');
        expect(ui.lastFrame()).toContain('https://accounts.google.test/auth');
        expect(ui.lastFrame()).toContain('Authorization code');
      });

      await settleInput(150);
      for (const char of 'manual-code') {
        ui.stdin.write(char);
        await settleInput(5);
      }
      ui.stdin.write('\r');
      await expect(code).resolves.toBe('manual-code');
      finish();
    } finally {
      ui.unmount();
    }
  });
});
