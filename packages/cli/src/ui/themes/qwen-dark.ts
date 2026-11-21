/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ColorsTheme, Theme } from './theme.js';
import { darkSemanticColors } from './semantic-tokens.js';

const qwenDarkColors: ColorsTheme = {
  type: 'dark',
  Background: '#141414',
  Foreground: '#e1e1e1',
  LightBlue: '#59C2FF',
  AccentBlue: '#39BAE6',
  AccentPurple: '#D2A6FF',
  AccentCyan: '#95E6CB',
  AccentGreen: '#AAD94C',
  AccentYellow: '#e5c07b',
  AccentRed: '#F26D78',
  AccentYellowDim: '#8B7530',
  AccentRedDim: '#8B3A4A',
  DiffAdded: '#AAD94C',
  DiffRemoved: '#F26D78',
  Comment: '#787880',
  Gray: '#92929b',
  GradientColors: ['#a594e8', '#c4b5fd'],
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
  {
    ...darkSemanticColors,
    text: {
      ...darkSemanticColors.text,
      secondary: qwenDarkColors.Gray,
    },
    background: {
      ...darkSemanticColors.background,
      primary: qwenDarkColors.Background,
      surface: '#242424',
      code: '#1c1c1c',
    },
    border: { default: '#44444b', focused: '#77717f' },
    ui: {
      ...darkSemanticColors.ui,
      comment: qwenDarkColors.Comment,
      symbol: qwenDarkColors.Gray,
      gradient: qwenDarkColors.GradientColors,
    },
  },
);
