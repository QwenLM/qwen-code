/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ColorsTheme, Theme } from './theme.js';
import { lightSemanticColors } from './semantic-tokens.js';

const qwenLightColors: ColorsTheme = {
  type: 'light',
  Background: '#f8f9fa',
  Foreground: '#34343c',
  LightBlue: '#28778d',
  AccentBlue: '#326dad',
  AccentPurple: '#7655a3',
  AccentCyan: '#287866',
  AccentGreen: '#4d7c35',
  AccentYellow: '#8a621f',
  AccentRed: '#b54d5c',
  AccentYellowDim: '#8B7000',
  AccentRedDim: '#993333',
  DiffAdded: '#86b300',
  DiffRemoved: '#f07171',
  Comment: '#71717a',
  Gray: '#71717a',
  GradientColors: ['#7657aa', '#9771cf'],
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
  {
    ...lightSemanticColors,
    text: {
      ...lightSemanticColors.text,
      secondary: qwenLightColors.Gray,
    },
    background: {
      ...lightSemanticColors.background,
      primary: qwenLightColors.Background,
      surface: '#ececf0',
      code: '#f0f0f3',
    },
    border: { default: '#c7c7ce', focused: '#8d819f' },
    ui: {
      ...lightSemanticColors.ui,
      comment: qwenLightColors.Comment,
      symbol: qwenLightColors.Gray,
      gradient: qwenLightColors.GradientColors,
    },
  },
);
