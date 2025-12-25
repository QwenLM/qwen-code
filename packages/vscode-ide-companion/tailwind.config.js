/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-env node */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/webview/**/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      keyframes: {
        // CompletionMenu mount animation: fade in + slight upward slide
        'completion-menu-enter': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // Pulse animation for in-progress tool calls
        'pulse-slow': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        // PermissionDrawer enter animation: slide up from bottom
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
      colors: {
        qwen: {
          orange: '#615fff',
          'clay-orange': '#4f46e5',
          ivory: '#f5f5ff',
          slate: '#141420',
          green: '#6bcf7f',
          // Status colors used by toolcall components
          success: '#74c991',
          error: '#c74e39',
          warning: '#e1c08d',
          loading: 'var(--app-secondary-foreground)',
        },
      },
      borderRadius: {
        small: '4px',
        medium: '6px',
        large: '8px',
      },
      spacing: {
        small: '4px',
        medium: '8px',
        large: '12px',
        xlarge: '16px',
      },
    },
  },
  plugins: [],
};
