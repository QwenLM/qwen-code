/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ColorsTheme, Theme } from '../../theme.js';
import type { SemanticColors } from '../../semantic-tokens.js';

const qwenDarkColors: ColorsTheme = {
  type: 'dark',
  Background: '#0b0e14',
  Foreground: '#bfbdb6',
  LightBlue: '#59C2FF',
  AccentBlue: '#39BAE6',
  AccentPurple: '#D2A6FF',
  AccentCyan: '#95E6CB',
  AccentGreen: '#AAD94C',
  AccentYellow: '#FFD700',
  AccentRed: '#F26D78',
  DiffAdded: '#AAD94C',
  DiffRemoved: '#F26D78',
  Comment: '#646A71',
  Gray: '#3D4149',
  DarkGray: '#3D4149',
  FocusColor: '#CBA6F7',
  FocusBackground: '#352A46',
  GradientColors: ['#FFD700', '#da7959'],
};

/**
 * Qwen Code's dark chrome palette. The editor tokens come from the Qwen Dark
 * palette above; UI chrome follows the same tone as the Qwen Code client.
 */
const qwenDarkSemanticColors: SemanticColors = {
  text: {
    primary: '#bfbdb6',
    secondary: '#6C7086',
    link: '#89B4FA',
    accent: '#CBA6F7',
    response: '#CDD6F4',
  },
  background: {
    primary: '#1E1E2E',
    message: '#181825',
    focus: qwenDarkColors.FocusBackground!,
    diff: {
      added: '#28350B',
      removed: '#430000',
    },
  },
  border: {
    default: '#6C7086',
    input: '#313244',
  },
  ui: {
    comment: '#6C7086',
    symbol: '#89DCEB',
    active: qwenDarkColors.FocusColor!,
    dark: '#181825',
    focus: qwenDarkColors.FocusColor!,
    selection: '#89B4FA',
    selectionGradient: ['#89B4FA', '#CBA6F7'],
    gradient: ['#4796E4', '#847ACE', '#C3677F'],
  },
  status: {
    error: '#F38BA8',
    success: '#A6E3A1',
    warning: '#F9E2AF',
  },
  agent: {
    red: '#EA4335',
    blue: '#669DF6',
    green: '#34A853',
    yellow: '#FBBC04',
    purple: '#AF5CF7',
    orange: '#E8710A',
    pink: '#FF63B8',
    cyan: '#24C1E0',
    badgeText: '#000000',
  },
};

export const QwenDark: Theme = new Theme(
  'Qwen Dark',
  'dark',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: qwenDarkColors.Background,
      color: qwenDarkColors.Foreground,
    },
    'hljs-keyword': {
      color: qwenDarkColors.AccentYellow,
    },
    'hljs-literal': {
      color: qwenDarkColors.AccentPurple,
    },
    'hljs-symbol': {
      color: qwenDarkColors.AccentCyan,
    },
    'hljs-name': {
      color: qwenDarkColors.LightBlue,
    },
    'hljs-link': {
      color: qwenDarkColors.AccentBlue,
    },
    'hljs-function .hljs-keyword': {
      color: qwenDarkColors.AccentYellow,
    },
    'hljs-subst': {
      color: qwenDarkColors.Foreground,
    },
    'hljs-string': {
      color: qwenDarkColors.AccentGreen,
    },
    'hljs-title': {
      color: qwenDarkColors.AccentYellow,
    },
    'hljs-type': {
      color: qwenDarkColors.AccentBlue,
    },
    'hljs-attribute': {
      color: qwenDarkColors.AccentYellow,
    },
    'hljs-bullet': {
      color: qwenDarkColors.AccentYellow,
    },
    'hljs-addition': {
      color: qwenDarkColors.AccentGreen,
    },
    'hljs-variable': {
      color: qwenDarkColors.Foreground,
    },
    'hljs-template-tag': {
      color: qwenDarkColors.AccentYellow,
    },
    'hljs-template-variable': {
      color: qwenDarkColors.AccentYellow,
    },
    'hljs-comment': {
      color: qwenDarkColors.Comment,
      fontStyle: 'italic',
    },
    'hljs-quote': {
      color: qwenDarkColors.AccentCyan,
      fontStyle: 'italic',
    },
    'hljs-deletion': {
      color: qwenDarkColors.AccentRed,
    },
    'hljs-meta': {
      color: qwenDarkColors.AccentYellow,
    },
    'hljs-doctag': {
      fontWeight: 'bold',
    },
    'hljs-strong': {
      fontWeight: 'bold',
    },
    'hljs-emphasis': {
      fontStyle: 'italic',
    },
  },
  qwenDarkColors,
  qwenDarkSemanticColors,
);
