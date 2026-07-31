/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @qwen-code/webui Tailwind CSS Preset
 *
 * This preset provides shared theme configuration for all Qwen Code products.
 * Consumers should include this preset in their tailwind.config.js:
 *
 * @example
 * module.exports = {
 *   presets: [require('@qwen-code/webui/tailwind.preset')],
 *   content: [
 *     './src/**\/*.{ts,tsx}',
 *     './node_modules/@qwen-code/webui/dist/**\/*.js'
 *   ]
 * }
 */

/* eslint-env node */
module.exports = {
  theme: {
    extend: {
      colors: {
        // Primary colors using CSS variables for runtime theming
        'app-primary': 'var(--app-primary, #3b82f6)',
        'app-primary-hover': 'var(--app-primary-hover, #2563eb)',
        'app-primary-foreground': 'var(--app-primary-foreground, #ffffff)',

        // Background colors
        'app-background': 'var(--app-background, #ffffff)',
        'app-background-secondary': 'var(--app-background-secondary, #f3f4f6)',
        'app-background-tertiary': 'var(--app-background-tertiary, #e5e7eb)',

        // Foreground/text colors
        'app-foreground': 'var(--app-foreground, #111827)',
        'app-foreground-secondary': 'var(--app-foreground-secondary, #6b7280)',
        'app-foreground-muted': 'var(--app-foreground-muted, #9ca3af)',

        // Border colors
        'app-border': 'var(--app-border, #e5e7eb)',
        'app-border-focus': 'var(--app-border-focus, #3b82f6)',

        // Status colors
        'app-success': 'var(--app-success, #10b981)',
        'app-warning': 'var(--app-warning, #f59e0b)',
        'app-error': 'var(--app-error, #ef4444)',
        'app-info': 'var(--app-info, #3b82f6)',
      },
      fontFamily: {
        sans: ['var(--app-font-sans, system-ui, sans-serif)'],
        mono: ['var(--app-font-mono, ui-monospace, monospace)'],
      },
      borderRadius: {
        'app-sm': 'var(--app-radius-sm, 0.25rem)',
        'app-md': 'var(--app-radius-md, 0.375rem)',
        'app-lg': 'var(--app-radius-lg, 0.5rem)',
      },
      spacing: {
        'app-xs': 'var(--app-spacing-xs, 0.25rem)',
        'app-sm': 'var(--app-spacing-sm, 0.5rem)',
        'app-md': 'var(--app-spacing-md, 1rem)',
        'app-lg': 'var(--app-spacing-lg, 1.5rem)',
        'app-xl': 'var(--app-spacing-xl, 2rem)',
      },
      keyframes: {
        'completion-menu-enter': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-slow': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        'slide-up': {
          '0%': { transform: 'translateY(100%)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        'completion-menu-enter': 'completion-menu-enter 150ms ease-out both',
        'pulse-slow': 'pulse-slow 1.5s ease-in-out infinite',
        'slide-up': 'slide-up 200ms ease-out both',
      },
    },
  },
};
