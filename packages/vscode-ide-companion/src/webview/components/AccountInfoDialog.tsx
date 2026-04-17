/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';
import { useEffect } from 'react';

export interface AccountInfo {
  authType?: string | null;
  baseUrl?: string | null;
  envKey?: string | null;
  modelId?: string | null;
  error?: string;
}

interface AccountInfoDialogProps {
  info: AccountInfo;
  onClose: () => void;
}

const AUTH_LABELS: Record<string, string> = {
  'qwen-oauth': 'Qwen OAuth',
  openai: 'OpenAI-compatible',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  'vertex-ai': 'Vertex AI',
};

export const AccountInfoDialog: FC<AccountInfoDialogProps> = ({
  info,
  onClose,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const rows: Array<{ label: string; value: string; accent?: boolean }> = [];

  if (info.error) {
    rows.push({ label: 'Error', value: info.error });
  } else {
    const authLabel =
      AUTH_LABELS[info.authType ?? ''] ?? info.authType ?? 'Unknown';
    rows.push({ label: 'Auth Method', value: authLabel });

    if (info.envKey) {
      rows.push({ label: 'API Key Env', value: info.envKey });
    }

    if (info.baseUrl) {
      rows.push({ label: 'Base URL', value: info.baseUrl });
    }

    if (info.modelId) {
      rows.push({ label: 'Current Model', value: info.modelId });
    }
  }

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
      onClick={onClose}
    >
      {/* Card */}
      <div
        className="relative w-[480px] rounded-lg border p-5 shadow-xl"
        style={{
          backgroundColor: 'var(--app-input-secondary-background)',
          borderColor: 'var(--app-input-border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <span
            className="font-semibold text-base"
            style={{ color: 'var(--app-primary-foreground)' }}
          >
            Account Information
          </span>
          <button
            className="flex items-center justify-center w-6 h-6 rounded cursor-pointer border-none text-lg leading-none hover:opacity-70"
            style={{
              backgroundColor: 'transparent',
              color: 'var(--app-secondary-foreground)',
            }}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Rows */}
        <div className="flex flex-col gap-2">
          {rows.map(({ label, value, accent }) => (
            <div key={label} className="flex justify-between items-start gap-3">
              <span
                className="text-sm shrink-0"
                style={{ color: 'var(--app-secondary-foreground)' }}
              >
                {label}
              </span>
              <span
                className="text-sm text-right break-all"
                style={{
                  color: accent
                    ? 'var(--app-link-color)'
                    : 'var(--app-primary-foreground)',
                }}
              >
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
