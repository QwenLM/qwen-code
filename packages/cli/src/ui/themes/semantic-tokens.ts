/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { lightTheme, darkTheme } from './theme.js';

export interface SemanticColors {
  text: {
    primary: string;
    secondary: string;
    link: string;
    accent: string;
    response: string;
  };
  background: {
    primary: string;
    message: string;
    focus: string;
    diff: {
      added: string;
      removed: string;
    };
  };
  border: {
    default: string;
    input: string;
  };
  ui: {
    comment: string;
    symbol: string;
    active: string;
    dark: string;
    focus: string;
    gradient: string[] | undefined;
    /** Optional product palette for interactive emphasis, separate from success. */
    selection?: string;
    selectionGradient?: string[];
  };
  status: {
    error: string;
    success: string;
    warning: string;
  };
  agent: {
    red: string;
    blue: string;
    green: string;
    yellow: string;
    purple: string;
    orange: string;
    pink: string;
    cyan: string;
    /** Foreground color for text on agent color badges (should contrast with badge bg). */
    badgeText: string;
  };
}

export const lightSemanticColors: SemanticColors = {
  text: {
    primary: lightTheme.Foreground,
    secondary: lightTheme.Gray,
    link: lightTheme.AccentBlue,
    accent: lightTheme.AccentPurple,
    response: lightTheme.Foreground,
  },
  background: {
    primary: lightTheme.Background,
    message: lightTheme.MessageBackground!,
    focus: lightTheme.FocusBackground!,
    diff: {
      added: lightTheme.DiffAdded,
      removed: lightTheme.DiffRemoved,
    },
  },
  border: {
    default: lightTheme.DarkGray,
    input: lightTheme.InputBackground!,
  },
  ui: {
    comment: lightTheme.Comment,
    symbol: lightTheme.Gray,
    active: lightTheme.AccentBlue,
    dark: lightTheme.DarkGray,
    focus: lightTheme.AccentGreen,
    gradient: lightTheme.GradientColors,
  },
  status: {
    error: lightTheme.AccentRed,
    success: lightTheme.AccentGreen,
    warning: lightTheme.AccentYellow,
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

export const darkSemanticColors: SemanticColors = {
  text: {
    primary: darkTheme.Foreground,
    secondary: darkTheme.Gray,
    link: darkTheme.AccentBlue,
    accent: darkTheme.AccentPurple,
    response: darkTheme.Foreground,
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
    symbol: darkTheme.Gray,
    active: darkTheme.AccentBlue,
    dark: darkTheme.DarkGray,
    focus: darkTheme.AccentGreen,
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
