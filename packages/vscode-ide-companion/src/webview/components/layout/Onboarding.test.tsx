/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('./ProviderSetupForm.js', () => ({
  ProviderSetupForm: () => <button type="button">Get Started</button>,
}));

import { Onboarding } from './Onboarding.js';

describe('Onboarding', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    document.body.removeAttribute('data-extension-uri');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
  });

  it('renders the logo without requiring an extension URI on the body', () => {
    act(() => {
      root?.render(<Onboarding />);
    });

    const logo = container?.querySelector('img[alt="Qwen Code"]');

    expect(logo).toBeTruthy();
    expect(logo?.getAttribute('src')).toBeTruthy();
  });
});
