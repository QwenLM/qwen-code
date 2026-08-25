/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CSSProperties } from 'react';
// eslint-disable-next-line import/no-internal-modules -- bundle the extension icon into the webview
import iconUrl from '../../../assets/icon.png';

interface QwenOnboardingProps {
  connecting: boolean;
  error?: string;
  onGetStarted: () => void;
}

const BUTTON_STYLE: CSSProperties = {
  display: 'inline-flex',
  width: '100%',
  minHeight: 32,
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '6px 12px',
  border: '1px solid transparent',
  borderRadius: 4,
  font: 'inherit',
  fontWeight: 600,
};

export function QwenOnboarding({
  connecting,
  error,
  onGetStarted,
}: QwenOnboardingProps) {
  return (
    <div
      style={{
        display: 'flex',
        minWidth: 0,
        minHeight: 0,
        flex: '1 1 auto',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        color: 'var(--vscode-foreground)',
      }}
    >
      <div
        style={{
          display: 'flex',
          width: 'min(100%, 300px)',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
          textAlign: 'center',
        }}
      >
        <img
          src={iconUrl}
          alt="Qwen Code"
          width={48}
          height={48}
          style={{ objectFit: 'contain' }}
        />
        <div>
          <div style={{ fontSize: 17, fontWeight: 600 }}>Qwen Code</div>
          <div
            style={{
              marginTop: 5,
              color: 'var(--vscode-descriptionForeground)',
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            Connect a model provider to start coding with Qwen.
          </div>
        </div>
        <div
          style={{
            boxSizing: 'border-box',
            width: '100%',
            padding: 14,
            border: '1px solid var(--vscode-widget-border, var(--vscode-panel-border))',
            borderRadius: 6,
            background: 'var(--vscode-editorWidget-background)',
          }}
        >
          <button
            type="button"
            disabled={connecting}
            onClick={onGetStarted}
            style={{
              ...BUTTON_STYLE,
              background: connecting
                ? 'var(--vscode-button-secondaryBackground)'
                : 'var(--vscode-button-background)',
              color: connecting
                ? 'var(--vscode-button-secondaryForeground)'
                : 'var(--vscode-button-foreground)',
              cursor: connecting ? 'wait' : 'pointer',
              opacity: connecting ? 0.75 : 1,
            }}
          >
            {connecting && (
              <span
                aria-hidden="true"
                style={{
                  width: 13,
                  height: 13,
                  border: '2px solid currentColor',
                  borderTopColor: 'transparent',
                  borderRadius: '50%',
                  animation: 'qwen-vscode-spin 0.8s linear infinite',
                }}
              />
            )}
            {connecting ? 'Connecting…' : 'Get Started'}
          </button>
          {error && (
            <div
              role="alert"
              style={{
                marginTop: 10,
                color: 'var(--vscode-errorForeground)',
                fontSize: 11,
                lineHeight: 1.45,
                textAlign: 'left',
              }}
            >
              {error}
            </div>
          )}
        </div>
        <div
          style={{
            color: 'var(--vscode-descriptionForeground)',
            fontSize: 11,
            lineHeight: 1.45,
          }}
        >
          Supports Coding Plan, ModelStudio API Key, and OpenAI-compatible
          providers.
        </div>
      </div>
    </div>
  );
}
