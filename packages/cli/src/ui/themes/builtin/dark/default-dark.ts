/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { darkTheme, Theme } from '../../theme.js';
import type { SemanticColors } from '../../semantic-tokens.js';

/**
 * Explicit semantic colors for DefaultDark to precisely match the design spec
 * where the Theme constructor fallback mapping would produce different values.
 *
 * Differences from fallback:
 * - text.response: #D4D4CF (fallback would use Foreground #EEEEEB)
 * - ui.active: #2ADB5C (fallback would use AccentBlue #6AD86C)
 * - ui.dark: #2A2926 (fallback would use DarkGray #484743)
 */
const defaultDarkSemanticColors: SemanticColors = {
  text: {
    primary: darkTheme.Foreground,
    secondary: darkTheme.Gray,
    link: darkTheme.AccentBlue,
    accent: darkTheme.AccentPurple,
    response: '#D4D4CF',
  },
  background: {
    primary: darkTheme.Background,
    message: darkTheme.MessageBackground!,
    focus: darkTheme.FocusBackground!,
    diff: {
      added: darkTheme.DiffAdded,
      removed: darkTheme.DiffRemoved,
    },
  },
  border: {
    default: darkTheme.DarkGray,
    input: darkTheme.InputBackground!,
  },
  ui: {
    comment: darkTheme.Comment,
    symbol: darkTheme.AccentCyan,
    active: '#2ADB5C',
    dark: '#2A2926',
    focus: darkTheme.FocusColor ?? darkTheme.AccentGreen,
    gradient: darkTheme.GradientColors,
  },
  status: {
    error: darkTheme.AccentRed,
    success: darkTheme.AccentGreen,
    warning: darkTheme.AccentYellow,
  },
  agent: {
    red: darkTheme.AgentRed!,
    blue: darkTheme.AgentBlue!,
    green: darkTheme.AgentGreen!,
    yellow: darkTheme.AgentYellow!,
    purple: darkTheme.AgentPurple!,
    orange: darkTheme.AgentOrange!,
    pink: darkTheme.AgentPink!,
    cyan: darkTheme.AgentCyan!,
    badgeText: '#000000',
  },
};

export const DefaultDark: Theme = new Theme(
  'Default',
  'dark',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: darkTheme.Background,
      color: darkTheme.Foreground,
    },
    'hljs-keyword': {
      color: darkTheme.AccentBlue,
    },
    'hljs-literal': {
      color: darkTheme.AccentBlue,
    },
    'hljs-symbol': {
      color: darkTheme.AccentBlue,
    },
    'hljs-name': {
      color: darkTheme.AccentBlue,
    },
    'hljs-link': {
      color: darkTheme.AccentBlue,
      textDecoration: 'underline',
    },
    'hljs-built_in': {
      color: darkTheme.AccentCyan,
    },
    'hljs-type': {
      color: darkTheme.AccentCyan,
    },
    'hljs-number': {
      color: darkTheme.AccentGreen,
    },
    'hljs-class': {
      color: darkTheme.AccentGreen,
    },
    'hljs-string': {
      color: darkTheme.AccentYellow,
    },
    'hljs-meta-string': {
      color: darkTheme.AccentYellow,
    },
    'hljs-regexp': {
      color: darkTheme.AccentRed,
    },
    'hljs-template-tag': {
      color: darkTheme.AccentRed,
    },
    'hljs-subst': {
      color: darkTheme.Foreground,
    },
    'hljs-function': {
      color: darkTheme.Foreground,
    },
    'hljs-title': {
      color: darkTheme.Foreground,
    },
    'hljs-params': {
      color: darkTheme.Foreground,
    },
    'hljs-formula': {
      color: darkTheme.Foreground,
    },
    'hljs-comment': {
      color: darkTheme.Comment,
      fontStyle: 'italic',
    },
    'hljs-quote': {
      color: darkTheme.Comment,
      fontStyle: 'italic',
    },
    'hljs-doctag': {
      color: darkTheme.Comment,
    },
    'hljs-meta': {
      color: darkTheme.Gray,
    },
    'hljs-meta-keyword': {
      color: darkTheme.Gray,
    },
    'hljs-tag': {
      color: darkTheme.Gray,
    },
    'hljs-variable': {
      color: darkTheme.AccentPurple,
    },
    'hljs-template-variable': {
      color: darkTheme.AccentPurple,
    },
    'hljs-attr': {
      color: darkTheme.LightBlue,
    },
    'hljs-attribute': {
      color: darkTheme.LightBlue,
    },
    'hljs-builtin-name': {
      color: darkTheme.LightBlue,
    },
    'hljs-section': {
      color: darkTheme.AccentYellow,
    },
    'hljs-emphasis': {
      fontStyle: 'italic',
    },
    'hljs-strong': {
      fontWeight: 'bold',
    },
    'hljs-bullet': {
      color: darkTheme.AccentYellow,
    },
    'hljs-selector-tag': {
      color: darkTheme.AccentYellow,
    },
    'hljs-selector-id': {
      color: darkTheme.AccentYellow,
    },
    'hljs-selector-class': {
      color: darkTheme.AccentYellow,
    },
    'hljs-selector-attr': {
      color: darkTheme.AccentYellow,
    },
    'hljs-selector-pseudo': {
      color: darkTheme.AccentYellow,
    },
    'hljs-addition': {
      backgroundColor: darkTheme.DiffAdded,
      display: 'inline-block',
      width: '100%',
    },
    'hljs-deletion': {
      backgroundColor: darkTheme.DiffRemoved,
      display: 'inline-block',
      width: '100%',
    },
  },
  darkTheme,
  defaultDarkSemanticColors,
);
