/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import { computeModelDialogMaxItems } from './dialogs-model.js';
import {
  getBuiltInOpenTuiThemes,
  openTuiThemeFromInkTheme,
} from './theme-parity.js';
import { applyOpenTuiTheme, applyThemeMode, C } from './theme.js';
import { QwenLight } from '../themes/qwen-light.js';
import { QwenDark } from '../themes/qwen-dark.js';
import { NoColorTheme } from '../themes/no-color.js';
import { toHex } from '../themes/color-utils.js';

afterEach(() => applyThemeMode('dark'));

it.each([
  [12, false, 0, 6],
  [11, true, 0, 2],
  [19, false, 5, 8],
])(
  'R2-2 mirrors compact model capacity at %i rows (descriptions=%s, errors=%i)',
  (rows, descriptions, errorRows, count) => {
    expect(
      computeModelDialogMaxItems(
        rows as number,
        descriptions as boolean,
        errorRows as number,
      ),
    ).toBe(count);
  },
);

it('R2-4 gives Qwen Light its own readable semantic text and surface colors', () => {
  expect(QwenLight.semanticColors.text).toMatchObject({
    link: '#326dad',
    accent: '#7655a3',
    code: '#28778d',
  });
  expect(QwenLight.semanticColors.background).toMatchObject({
    surface: '#ececf0',
    code: '#f0f0f3',
  });
  expect(QwenLight.semanticColors.border).toEqual({
    default: '#c7c7ce',
    focused: '#8d819f',
  });
});

it.each([
  [QwenDark, '#242424', '#1c1c1c', '#44444b', '#77717f'],
  [QwenLight, '#ececf0', '#f0f0f3', '#c7c7ce', '#8d819f'],
] as const)(
  'pins %s surface, code and both border tokens',
  (theme, surface, code, border, focused) => {
    expect(theme.semanticColors.background).toMatchObject({ surface, code });
    expect(theme.semanticColors.border).toEqual({ default: border, focused });
  },
);

it.each([...getBuiltInOpenTuiThemes(), openTuiThemeFromInkTheme(NoColorTheme)])(
  'applies $name with its actual optional surface and gradient',
  (definition) => {
    expect(() => applyOpenTuiTheme(definition)).not.toThrow();
    expect(C.surface).toBe(
      definition.palette.surface
        ? toHex(definition.palette.surface)
        : undefined,
    );
  },
);
