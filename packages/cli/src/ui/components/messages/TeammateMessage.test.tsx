/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { FEED_MARKER } from '../../constants/feedGrammar.js';
import { figures } from '../../utils/figures.js';
import {
  buildTeammateMessageHistoryItem,
  TeammateMessage,
} from './TeammateMessage.js';

describe('<TeammateMessage />', () => {
  it('renders idle notifications as teammate lifecycle status', async () => {
    const value = `<teammate-message teammate_id="frontend" color="cyan">
{"type":"idle_notification","from":"frontend","idleReason":"available"}
</teammate-message>`;
    const renderResult = await renderWithProviders(
      <TeammateMessage value={value} />,
      { uiState: { constrainHeight: true } },
    );

    expect(renderResult.lastFrame()).toContain('Teammate @frontend finished');
    expect(renderResult.lastFrame()).toBe(renderResult.lastFrame()?.trimStart());
    expect(renderResult.lastFrame()).not.toContain('idle_notification');
    expect(renderResult.lastFrame()).not.toContain('teammate-message');
    renderResult.unmount();
  });

  it('collapses ordinary teammate messages by default', async () => {
    const value = `<teammate-message teammate_id="architect" summary="Architecture ready">
Use the event queue as the single delivery path.
</teammate-message>`;
    const renderResult = await renderWithProviders(
      <TeammateMessage value={value} />,
      { uiState: { constrainHeight: true } },
    );

    expect(renderResult.lastFrame()).toContain(
      `${FEED_MARKER.info}@architect ${figures.pointer} Architecture ready`,
    );
    expect(renderResult.lastFrame()).toBe(renderResult.lastFrame()?.trimStart());
    expect(renderResult.lastFrame()).not.toContain('Ctrl+O to expand');
    expect(renderResult.lastFrame()).not.toContain(
      'Use the event queue as the single delivery path.',
    );
    renderResult.unmount();
  });

  it('renders colored sender identity and body without summary when expanded', async () => {
    const value = `<teammate-message teammate_id="architect" color="blue" summary="Architecture ready">
Use the event queue as the single delivery path.
</teammate-message>`;
    const renderResult = await renderWithProviders(
      <TeammateMessage value={value} />,
      { uiState: { constrainHeight: false } },
    );

    expect(renderResult.lastFrame()).toContain('@architect');
    expect(renderResult.lastFrame()).toContain(FEED_MARKER.info.trim());
    expect(renderResult.lastFrame()).not.toContain('Architecture ready');
    expect(renderResult.lastFrame()).toContain(
      'Use the event queue as the single delivery path.',
    );
    expect(renderResult.lastFrame()).not.toContain('Message from');
    renderResult.unmount();
  });

  it('uses the UI-only summary for a collapsed agent message', async () => {
    const value = `<agent-message from="coder">
The package name is @qwen-code/qwen-code.
</agent-message>`;
    const renderResult = await renderWithProviders(
      <TeammateMessage
        value={value}
        summary="Report package name"
        color="blue"
      />,
      { uiState: { constrainHeight: true } },
    );

    expect(renderResult.lastFrame()).toContain(
      `${FEED_MARKER.info}@coder ${figures.pointer} Report package name`,
    );
    expect(renderResult.lastFrame()).not.toContain(
      'The package name is @qwen-code/qwen-code.',
    );
    renderResult.unmount();
  });

  it('hides internal shutdown approval protocol messages', async () => {
    const value = `<teammate-message teammate_id="architect" color="blue" summary="Approving shutdown request">
{"type":"shutdown_approved","requestId":"shutdown-1","from":"architect","paneId":"in-process","backendType":"in-process"}
</teammate-message>`;
    const renderResult = await renderWithProviders(
      <TeammateMessage value={value} />,
      { uiState: { constrainHeight: false } },
    );

    expect(renderResult.lastFrame({ allowEmpty: true })).toBe('');
    expect(buildTeammateMessageHistoryItem(value)).toBeNull();
    renderResult.unmount();
  });

  it('shows a bounded failure reason for failed teammates', async () => {
    const reason = `build failed ${'x'.repeat(240)}`;
    const value = `<teammate-message teammate_id="builder" color="red">
${JSON.stringify({
  type: 'idle_notification',
  from: 'builder',
  idleReason: 'failed',
  failureReason: reason,
})}
</teammate-message>`;
    const renderResult = await renderWithProviders(
      <TeammateMessage value={value} />,
      { uiState: { constrainHeight: true } },
    );

    expect(renderResult.lastFrame()).toContain('Teammate @builder failed');
    expect(renderResult.lastFrame()).toContain('build failed');
    expect(renderResult.lastFrame()).not.toContain('x'.repeat(201));
    renderResult.unmount();
  });
});
