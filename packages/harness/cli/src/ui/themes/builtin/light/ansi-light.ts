/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ansiTheme, Theme } from '../../theme.js';

export const ANSILight: Theme = new Theme(
  'ANSI Light',
  'ansi',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: '',
      color: '',
    },
    'hljs-keyword': {
      color: 'blue',
    },
    'hljs-literal': {
      color: 'blue',
    },
    'hljs-symbol': {
      color: 'blue',
    },
    'hljs-name': {
      color: 'blue',
    },
    'hljs-link': {
      color: 'blue',
    },
    'hljs-built_in': {
      color: 'cyan',
    },
    'hljs-type': {
      color: 'cyan',
    },
    'hljs-number': {
      color: 'green',
    },
    'hljs-class': {
      color: 'green',
    },
    'hljs-string': {
      color: 'red',
    },
    'hljs-meta-string': {
      color: 'red',
    },
    'hljs-regexp': {
      color: 'magenta',
    },
    'hljs-template-tag': {
      color: 'magenta',
    },
    'hljs-subst': {
      color: '',
    },
    'hljs-function': {
      color: '',
    },
    'hljs-title': {
      color: '',
    },
    'hljs-params': {
      color: '',
    },
    'hljs-formula': {
      color: '',
    },
    'hljs-comment': {
      color: 'gray',
    },
    'hljs-quote': {
      color: 'gray',
    },
    'hljs-doctag': {
      color: 'gray',
    },
    'hljs-meta': {
      color: 'gray',
    },
    'hljs-meta-keyword': {
      color: 'gray',
    },
    'hljs-tag': {
      color: 'gray',
    },
    'hljs-variable': {
      color: 'magenta',
    },
    'hljs-template-variable': {
      color: 'magenta',
    },
    'hljs-attr': {
      color: 'blue',
    },
    'hljs-attribute': {
      color: 'blue',
    },
    'hljs-builtin-name': {
      color: 'blue',
    },
    'hljs-section': {
      color: 'yellow',
    },
    'hljs-bullet': {
      color: 'yellow',
    },
    'hljs-selector-tag': {
      color: 'yellow',
    },
    'hljs-selector-id': {
      color: 'yellow',
    },
    'hljs-selector-class': {
      color: 'yellow',
    },
    'hljs-selector-attr': {
      color: 'yellow',
    },
    'hljs-selector-pseudo': {
      color: 'yellow',
    },
  },
  { ...ansiTheme, LightBlue: 'blue' },
);
