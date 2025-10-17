/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ColorsTheme, Theme } from './theme.js';
import { darkSemanticColors } from './semantic-tokens.js';

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
  GradientColors: ['#FFD700', '#da7959'],
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
  darkSemanticColors,
);
