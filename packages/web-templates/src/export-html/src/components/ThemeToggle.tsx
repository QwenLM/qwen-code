/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExportTheme } from './useExportTheme.js';

export type ThemeToggleProps = {
  theme: ExportTheme;
  onToggle: () => void;
};

const SunIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>
);

const MoonIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
);

export const ThemeToggle = ({ theme, onToggle }: ThemeToggleProps) => {
  const isLight = theme === 'light';
  const nextThemeLabel = isLight
    ? 'Switch to dark theme'
    : 'Switch to light theme';
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={nextThemeLabel}
      aria-pressed={isLight}
      title={nextThemeLabel}
      onClick={onToggle}
    >
      {isLight ? <MoonIcon /> : <SunIcon />}
    </button>
  );
};
