/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-env node */
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    // Progressive adoption strategy: Only scan newly created Tailwind components
    './src/webview/App.tsx',
    './src/webview/components/ui/**/*.{js,jsx,ts,tsx}',
    './src/webview/components/messages/**/*.{js,jsx,ts,tsx}',
    './src/webview/components/toolcalls/**/*.{js,jsx,ts,tsx}',
    './src/webview/components/InProgressToolCall.tsx',
    './src/webview/components/MessageContent.tsx',
    './src/webview/components/InputForm.tsx',
    './src/webview/components/PermissionDrawer.tsx',
    './src/webview/components/PlanDisplay.tsx',
    './src/webview/components/session/SessionSelector.tsx',
  ],
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
      },
      animation: {
        'completion-menu-enter': 'completion-menu-enter 150ms ease-out both',
        'pulse-slow': 'pulse-slow 1.5s ease-in-out infinite',
      },
      colors: {
        qwen: {
          orange: '#615fff',
          'clay-orange': '#4f46e5',
          ivory: '#f5f5ff',
          slate: '#141420',
          green: '#6bcf7f',
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
