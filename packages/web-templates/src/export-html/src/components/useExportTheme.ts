/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// React is loaded as a UMD bundle via the CDN <script> tag in index.html
// (see __REACT_UMD_VERSION__ replacement). All code in this package consumes
// React/JSX through `window.React` + the `react/jsx-runtime` shim, instead
// of ESM imports.
const React = window.React;
const { useCallback, useEffect, useState } = React;

export type ExportTheme = 'light' | 'dark';

// IMPORTANT: keep this string in sync with the inline FOUC bootstrap script
// in `index.html` — both reads must agree on the same key for theme
// persistence to work without an initial flash.
export const EXPORT_THEME_STORAGE_KEY = 'qwen-export-theme';

const isExportTheme = (value: unknown): value is ExportTheme =>
  value === 'light' || value === 'dark';

const readInitialTheme = (): ExportTheme => {
  try {
    const stored = window.localStorage.getItem(EXPORT_THEME_STORAGE_KEY);
    if (isExportTheme(stored)) {
      return stored;
    }
  } catch {
    // localStorage may be unavailable (private mode, file:// sandbox).
  }
  return 'dark';
};

const applyThemeToDocument = (theme: ExportTheme) => {
  const root = document.documentElement;
  root.classList.toggle('light', theme === 'light');
  root.classList.toggle('dark', theme === 'dark');
};

export type UseExportThemeResult = {
  theme: ExportTheme;
  toggleTheme: () => void;
};

export const useExportTheme = (): UseExportThemeResult => {
  const [theme, setTheme] = useState<ExportTheme>(readInitialTheme);

  useEffect(() => {
    applyThemeToDocument(theme);
    try {
      window.localStorage.setItem(EXPORT_THEME_STORAGE_KEY, theme);
    } catch {
      // Persisting is best-effort; ignore failures.
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  }, []);

  return { theme, toggleTheme };
};
