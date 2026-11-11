/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { lightTheme, Theme } from '../../theme.js';
import type { SemanticColors } from '../../semantic-tokens.js';

/**
 * Explicit semantic colors for DefaultLight to precisely match the design spec
 * where the Theme constructor fallback mapping would produce different values.
 *
 * Differences from fallback (lightTheme base palette):
 * - text.primary: #1A1917 (fallback would use Foreground #000000)
 * - text.secondary: #6B6A65 (fallback would use Gray #5F5F5F)
 * - text.link: #278035 (fallback would use AccentBlue #005FAF)
 * - text.accent: #7D6793 (fallback would use AccentPurple #5F00FF)
 * - text.response: #2E2D2A (fallback would use Foreground #000000)
 * - background.message: #F5F5F2 (fallback would use MessageBackground #FAFAFA)
 * - border.input: #EEEDEA (fallback would use InputBackground #E4E4E4)
 * - background.focus: #D8F3D7 (fallback would use FocusBackground #D7FFD7)
 * - background.diff.added: #DCFCE7 (fallback would use DiffAdded #D7FFD7)
 * - background.diff.removed: #FEE2E2 (fallback would use DiffRemoved #FFD7D7)
 * - border.default: #B8B7B3 (fallback would use DarkGray #5F5F5F)
 * - ui.comment: #878580 (fallback would use Comment #008700)
 * - ui.symbol: #0A8070 (fallback would use Gray #5F5F5F)
 * - ui.active: #14802E (fallback would use AccentBlue #005FAF)
 * - ui.dark: #DAD9D6 (fallback would use DarkGray #5F5F5F)
 * - ui.focus: #14802E (fallback would use AccentGreen #006400)
 * - status.error: #D93025 (fallback would use AccentRed #AF0000)
 * - status.success: #3B7D5E (fallback would use AccentGreen #006400)
 * - status.warning: #9F6500 (fallback would use AccentYellow #875F00)
 */
const defaultLightSemanticColors: SemanticColors = {
  text: {
    primary: '#1A1917',
    secondary: '#6B6A65',
    link: '#278035',
    accent: '#7D6793',
    response: '#2E2D2A',
  },
  background: {
    primary: '#FFFFFF',
    message: '#F5F5F2',
    focus: '#D8F3D7',
    diff: {
      added: '#DCFCE7',
      removed: '#FEE2E2',
    },
  },
  border: {
    default: '#B8B7B3',
    input: '#EEEDEA',
  },
  ui: {
    comment: '#878580',
    symbol: '#0A8070',
    active: '#14802E',
    dark: '#DAD9D6',
    focus: '#14802E',
    gradient: lightTheme.GradientColors,
  },
  status: {
    error: '#D93025',
    success: '#3B7D5E',
    warning: '#9F6500',
  },
  agent: {
    red: lightTheme.AgentRed!,
    blue: lightTheme.AgentBlue!,
    green: lightTheme.AgentGreen!,
    yellow: lightTheme.AgentYellow!,
    purple: lightTheme.AgentPurple!,
    orange: lightTheme.AgentOrange!,
    pink: lightTheme.AgentPink!,
    cyan: lightTheme.AgentCyan!,
    badgeText: '#FFFFFF',
  },
};

export const DefaultLight: Theme = new Theme(
  'Default Light',
  'light',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: lightTheme.Background,
      color: lightTheme.Foreground,
    },
    'hljs-comment': {
      color: lightTheme.Comment,
    },
    'hljs-quote': {
      color: lightTheme.Comment,
    },
    'hljs-variable': {
      color: lightTheme.Foreground,
    },
    'hljs-keyword': {
      color: lightTheme.AccentBlue,
    },
    'hljs-selector-tag': {
      color: lightTheme.AccentBlue,
    },
    'hljs-built_in': {
      color: lightTheme.AccentBlue,
    },
    'hljs-name': {
      color: lightTheme.AccentBlue,
    },
    'hljs-tag': {
      color: lightTheme.AccentBlue,
    },
    'hljs-string': {
      color: lightTheme.AccentRed,
    },
    'hljs-title': {
      color: lightTheme.AccentRed,
    },
    'hljs-section': {
      color: lightTheme.AccentRed,
    },
    'hljs-attribute': {
      color: lightTheme.AccentRed,
    },
    'hljs-literal': {
      color: lightTheme.AccentRed,
    },
    'hljs-template-tag': {
      color: lightTheme.AccentRed,
    },
    'hljs-template-variable': {
      color: lightTheme.AccentRed,
    },
    'hljs-type': {
      color: lightTheme.AccentRed,
    },
    'hljs-addition': {
      color: lightTheme.AccentGreen,
    },
    'hljs-deletion': {
      color: lightTheme.AccentRed,
    },
    'hljs-selector-attr': {
      color: lightTheme.AccentCyan,
    },
    'hljs-selector-pseudo': {
      color: lightTheme.AccentCyan,
    },
    'hljs-meta': {
      color: lightTheme.AccentCyan,
    },
    'hljs-doctag': {
      color: lightTheme.Gray,
    },
    'hljs-attr': {
      color: lightTheme.AccentRed,
    },
    'hljs-symbol': {
      color: lightTheme.AccentCyan,
    },
    'hljs-bullet': {
      color: lightTheme.AccentCyan,
    },
    'hljs-link': {
      color: lightTheme.AccentCyan,
    },
    'hljs-emphasis': {
      fontStyle: 'italic',
    },
    'hljs-strong': {
      fontWeight: 'bold',
    },
  },
  lightTheme,
  defaultLightSemanticColors,
);
