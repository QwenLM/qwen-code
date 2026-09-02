/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import type { LoadedSettings } from '../../config/settings.js';
import { OverflowProvider } from '../contexts/OverflowContext.js';
import { getScreenBuffer } from '../selection/screen-buffer.js';
import { getSelectedText } from '../selection/selection-text.js';
import { colorizeCode } from './CodeColorizer.js';

it('excludes code line numbers from copied text', () => {
  const settings = {
    merged: { ui: { showLineNumbers: true } },
  } as LoadedSettings;
  const { stdout } = render(
    <OverflowProvider>
      {colorizeCode(
        'const value = 1;\nreturn value;',
        'javascript',
        undefined,
        20,
        {
          settings,
        },
      )}
    </OverflowProvider>,
  );
  const frame = getScreenBuffer(
    stdout as unknown as NodeJS.WriteStream,
  )!.frame!;

  expect(
    getSelectedText(frame, {
      sx: 0,
      sy: 0,
      ex: frame.width - 1,
      ey: frame.height - 1,
    }),
  ).toBe('const value = 1;\nreturn value;');
});
