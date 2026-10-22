/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { ToolCallStatus } from '../../types.js';
import { ToolMessage } from './ToolMessage.js';

const resultDisplay = [
  'Stdout:',
  '# Diagnostics',
  '- file.ts:1:1 error',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  'Stderr: (empty)',
].join('\n');

describe('resumed tool render mode', () => {
  it.each([undefined, false, true])(
    'preserves the declared mode %s without guessing from the tool name',
    (renderOutputAsMarkdown) => {
      const { lastFrame } = renderWithProviders(
        <ToolMessage
          callId="resumed-lsp"
          name="Lsp"
          description=""
          resultDisplay={resultDisplay}
          renderOutputAsMarkdown={renderOutputAsMarkdown}
          status={ToolCallStatus.Success}
          confirmationDetails={undefined}
          contentWidth={80}
          availableTerminalHeight={100}
        />,
      );
      const frame = lastFrame() ?? '';
      if (renderOutputAsMarkdown) {
        expect(frame).not.toContain('# Diagnostics');
        expect(frame).not.toContain('| a | b |');
        expect(frame).toContain('┌');
      } else {
        expect(frame).toContain('# Diagnostics');
        expect(frame).toContain('- file.ts:1:1 error');
        expect(frame).toContain('| a | b |');
        expect(frame).not.toContain('┌');
      }
      expect(frame).toContain('Stderr: (empty)');
    },
  );
});
