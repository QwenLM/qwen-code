/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * WebView Component Test Rendering Utilities
 *
 * Provides rendering functions with necessary Providers and mocks,
 * simplifying WebView React component testing.
 */

import type React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * Mock VSCode WebView API
 *
 * Components in WebView obtain this API via acquireVsCodeApi(),
 * used for bidirectional communication with VSCode extension.
 */
export const mockVSCodeAPI = {
  /** Send message to extension */
  postMessage: vi.fn(),
  /** Get WebView persistent state */
  getState: vi.fn(() => ({})),
  /** Set WebView persistent state */
  setState: vi.fn(),
};

/**
 * Test Provider wrapper
 *
 * Add specific Context Providers here if components need them.
 */
const AllTheProviders: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => <>{children}</>;

/**
 * Render function with Providers
 *
 * Usage:
 * ```tsx
 * import { renderWithProviders, screen } from './test-utils/render';
 *
 * it('should render component', () => {
 *   renderWithProviders(<MyComponent />);
 *   expect(screen.getByText('Hello')).toBeInTheDocument();
 * });
 * ```
 */
export const renderWithProviders = (
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
) => render(ui, { wrapper: AllTheProviders, ...options });

/**
 * Simulate receiving message from extension
 *
 * WebView receives messages via window.addEventListener('message', ...).
 * Use this function to simulate messages sent by the extension.
 *
 * @param type Message type
 * @param data Message data
 *
 * Usage example:
 * ```ts
 * simulateExtensionMessage('authState', { authenticated: true });
 * ```
 */
export const simulateExtensionMessage = (type: string, data: unknown) => {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, data },
    }),
  );
};

/**
 * Wait for async state updates
 *
 * Used to wait for React state updates to complete before assertions.
 */
export const waitForStateUpdate = () =>
  new Promise((resolve) => setTimeout(resolve, 0));

// Export all utilities from @testing-library/react and other helpers
export * from '@testing-library/react';
