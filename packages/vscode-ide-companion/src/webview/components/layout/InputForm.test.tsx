/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
// eslint-disable-next-line import/no-internal-modules
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InputForm } from '../../../../../webui/src/components/layout/InputForm.js';

describe('webui InputForm', () => {
  it('keeps the submit button enabled when attachments are present without text', () => {
    const html = renderToStaticMarkup(
      <InputForm
        inputText=""
        inputFieldRef={React.createRef<HTMLDivElement>()}
        isStreaming={false}
        isWaitingForResponse={false}
        isComposing={false}
        editModeInfo={{ label: 'Default', title: 'Default', icon: null }}
        thinkingEnabled={false}
        activeFileName={null}
        activeSelection={null}
        skipAutoActiveContext={false}
        contextUsage={null}
        onInputChange={() => {}}
        onCompositionStart={() => {}}
        onCompositionEnd={() => {}}
        onKeyDown={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        onToggleEditMode={() => {}}
        onToggleThinking={() => {}}
        onToggleSkipAutoActiveContext={() => {}}
        onShowCommandMenu={() => {}}
        onAttachContext={() => {}}
        completionIsOpen={false}
        canSubmit
        extraContent={<div>attachment</div>}
      />,
    );

    expect(html).toContain('aria-label="Send message"');
    expect(html).not.toMatch(
      /<button[^>]*type="submit"[^>]*disabled=""[^>]*aria-label="Send message"/,
    );
  });
});
