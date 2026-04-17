/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import { TextInput } from '../components/shared/TextInput.js';
import { KeypressProvider } from './KeypressContext.js';

function TextInputHarness({
  initialInputChunks,
}: {
  initialInputChunks: Buffer[];
}) {
  const [value, setValue] = useState('');

  return (
    <KeypressProvider
      kittyProtocolEnabled={false}
      initialInputChunks={initialInputChunks}
    >
      <TextInput value={value} onChange={setValue} />
    </KeypressProvider>
  );
}

describe('KeypressProvider replay', () => {
  afterEach(() => {
    delete process.env['DEBUG'];
  });

  it('replays buffered startup input into the prompt after mount', async () => {
    const app = render(
      <TextInputHarness initialInputChunks={[Buffer.from('fast typer')]} />,
    );

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(app.lastFrame()).toContain('fast typer');
  });
});
