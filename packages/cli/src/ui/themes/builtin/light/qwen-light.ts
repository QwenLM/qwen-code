/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ColorsTheme, Theme } from '../../theme.js';
import type { SemanticColors } from '../../semantic-tokens.js';

const qwenLightColors: ColorsTheme = {
  type: 'light',
  Background: '#f8f9fa',
  Foreground: '#5c6166',
  LightBlue: '#55b4d4',
  AccentBlue: '#399ee6',
  AccentPurple: '#a37acc',
  AccentCyan: '#4cbf99',
  AccentGreen: '#86b300',
  AccentYellow: '#f2ae49',
  AccentRed: '#f07171',
  DiffAdded: '#86b300',
  DiffRemoved: '#f07171',
  Comment: '#ABADB1',
  Gray: '#CCCFD3',
  DarkGray: '#CCCFD3',
  FocusColor: '#8B5CF6',
  FocusBackground: '#EDE9FE',
  GradientColors: ['#399ee6', '#86b300'],
};

/** Qwen Code's light chrome palette, matching the client's default tone. */
const qwenLightSemanticColors: SemanticColors = {
  text: {
    primary: '#5c6166',
    secondary: '#97a0b0',
    link: '#3B82F6',
    accent: '#8B5CF6',
    response: '#5c6166',
  },
  background: {
    primary: '#FAFAFA',
    message: '#F0F1F3',
    focus: qwenLightColors.FocusBackground!,
    diff: {
      added: '#C6EAD8',
      removed: '#FFCCCC',
    },
  },
  border: {
    default: '#97a0b0',
    input: '#E4E4E4',
  },
  ui: {
    comment: '#008000',
    symbol: '#97a0b0',
    active: qwenLightColors.FocusColor!,
    dark: '#E4E4E4',
    focus: qwenLightColors.FocusColor!,
    gradient: ['#4796E4', '#847ACE', '#C3677F'],
    selection: '#4796E4',
    selectionGradient: ['#4796E4', '#847ACE'],
  },
  status: {
    error: '#DD4C4C',
    success: '#3CA84B',
    warning: '#D5A40A',
  },
  agent: {
    red: '#D93025',
    blue: '#1A73E8',
    green: '#188038',
    yellow: '#E37400',
    purple: '#8430CE',
    orange: '#C5621C',
    pink: '#D01884',
    cyan: '#007B83',
    badgeText: '#000000',
  },
};

export const QwenLight: Theme = new Theme(
  'Qwen Light',
  'light',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: qwenLightColors.Background,
      color: qwenLightColors.Foreground,
    },
    'hljs-comment': {
      color: qwenLightColors.Comment,
      fontStyle: 'italic',
    },
    'hljs-quote': {
      color: qwenLightColors.AccentCyan,
      fontStyle: 'italic',
    },
    'hljs-string': {
      color: qwenLightColors.AccentGreen,
    },
    'hljs-constant': {
      color: qwenLightColors.AccentCyan,
    },
    'hljs-number': {
      color: qwenLightColors.AccentPurple,
    },
    'hljs-keyword': {
      color: qwenLightColors.AccentYellow,
    },
    'hljs-selector-tag': {
      color: qwenLightColors.AccentYellow,
    },
    'hljs-attribute': {
      color: qwenLightColors.AccentYellow,
    },
    'hljs-variable': {
      color: qwenLightColors.Foreground,
    },
    'hljs-variable.language': {
      color: qwenLightColors.LightBlue,
      fontStyle: 'italic',
    },
    'hljs-title': {
      color: qwenLightColors.AccentBlue,
    },
    'hljs-section': {
      color: qwenLightColors.AccentGreen,
      fontWeight: 'bold',
    },
    'hljs-type': {
      color: qwenLightColors.LightBlue,
    },
    'hljs-class .hljs-title': {
      color: qwenLightColors.AccentBlue,
    },
    'hljs-tag': {
      color: qwenLightColors.LightBlue,
    },
    'hljs-name': {
      color: qwenLightColors.AccentBlue,
    },
    'hljs-builtin-name': {
      color: qwenLightColors.AccentYellow,
    },
    'hljs-meta': {
      color: qwenLightColors.AccentYellow,
    },
    'hljs-symbol': {
      color: qwenLightColors.AccentRed,
    },
    'hljs-bullet': {
      color: qwenLightColors.AccentYellow,
    },
    'hljs-regexp': {
      color: qwenLightColors.AccentCyan,
    },
    'hljs-link': {
      color: qwenLightColors.LightBlue,
    },
    'hljs-deletion': {
      color: qwenLightColors.AccentRed,
    },
    'hljs-addition': {
      color: qwenLightColors.AccentGreen,
    },
    'hljs-emphasis': {
      fontStyle: 'italic',
    },
    'hljs-strong': {
      fontWeight: 'bold',
    },
    'hljs-literal': {
      color: qwenLightColors.AccentCyan,
    },
    'hljs-built_in': {
      color: qwenLightColors.AccentRed,
    },
    'hljs-doctag': {
      color: qwenLightColors.AccentRed,
    },
    'hljs-template-variable': {
      color: qwenLightColors.AccentCyan,
    },
    'hljs-selector-id': {
      color: qwenLightColors.AccentRed,
    },
  },
  qwenLightColors,
  qwenLightSemanticColors,
);
