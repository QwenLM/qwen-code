/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Provider Setup — triggers the auth interactive flow (QuickPick + InputBox).
 */

import { useState, useEffect, type FC } from 'react';
import { useVSCode } from '../../hooks/useVSCode.js';

/**
 * Small rotating spinner for loading states.
 */
const Spinner: FC<{ size?: number }> = ({ size = 14 }) => (
  <span
    className="inline-block animate-spin rounded-full border-2 border-current"
    style={{
      width: size,
      height: size,
      borderTopColor: 'transparent',
    }}
  />
);

/**
 * ProviderSetupForm — Single button that launches the interactive auth flow.
 */
export const ProviderSetupForm: FC = () => {
  const vscode = useVSCode();
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === 'authError' || msg?.type === 'agentConnectionError') {
        setIsConnecting(false);
        setError(
          msg.data?.message || 'Connection failed. Check your settings.',
        );
      }
      if (msg?.type === 'authCancelled') {
        setIsConnecting(false);
        setError(null);
      }
      if (msg?.type === 'authSuccess' || msg?.type === 'agentConnected') {
        setIsConnecting(false);
        setError(null);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleGetStarted = () => {
    setError(null);
    setIsConnecting(true);
    vscode.postMessage({ type: 'auth' });
  };

  return (
    <div className="flex flex-col gap-2.5">
      <button
        onClick={handleGetStarted}
        disabled={isConnecting}
        className="w-full py-2 rounded-md text-[13px] font-medium flex items-center justify-center gap-2 transition-all"
        style={{
          backgroundColor: isConnecting
            ? 'var(--app-input-secondary-background)'
            : 'var(--app-primary, var(--app-button-background))',
          color: isConnecting
            ? 'var(--app-secondary-foreground)'
            : 'var(--app-button-foreground, #fff)',
          cursor: isConnecting ? 'not-allowed' : 'pointer',
          border: isConnecting
            ? '1px solid var(--app-input-border)'
            : '1px solid transparent',
        }}
      >
        {isConnecting ? (
          <>
            <Spinner />
            Connecting...
          </>
        ) : (
          <>
            Get Started
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4.5 2.5L8 6L4.5 9.5" />
            </svg>
          </>
        )}
      </button>

      {error && (
        <div
          className="text-[11px] leading-snug px-2.5 py-2 rounded"
          style={{
            backgroundColor: 'color-mix(in srgb, #ef4444 10%, transparent)',
            color: '#f87171',
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
};
