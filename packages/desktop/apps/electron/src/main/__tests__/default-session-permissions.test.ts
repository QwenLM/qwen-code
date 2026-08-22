import { describe, expect, it } from 'bun:test';
import { canUseDefaultSessionClipboard } from '../default-session-permissions';

const trustedRequest = {
  permission: 'clipboard-sanitized-write',
  isMainFrame: true,
  isWorkspaceWindow: true,
  requestingUrl: 'file:///app/index.html',
  devServerUrl: undefined,
};

describe('default session permissions', () => {
  it('allows clipboard writes from the packaged app renderer', () => {
    expect(canUseDefaultSessionClipboard(trustedRequest)).toBe(true);
  });

  it('allows clipboard writes from the configured Vite dev origin', () => {
    expect(
      canUseDefaultSessionClipboard({
        ...trustedRequest,
        requestingUrl: 'http://localhost:5173/chat',
        devServerUrl: 'http://localhost:5173',
      }),
    ).toBe(true);
  });

  it.each([
    ['clipboard reads', { permission: 'clipboard-read' }],
    ['unrelated permissions', { permission: 'geolocation' }],
    ['subframes', { isMainFrame: false }],
    ['unregistered windows', { isWorkspaceWindow: false }],
    ['external pages', { requestingUrl: 'https://example.com' }],
    [
      'a different dev port',
      {
        requestingUrl: 'http://localhost:5174/chat',
        devServerUrl: 'http://localhost:5173',
      },
    ],
    ['requests without a URL', { requestingUrl: undefined }],
  ])('rejects %s', (_label, overrides) => {
    expect(
      canUseDefaultSessionClipboard({
        ...trustedRequest,
        ...overrides,
      }),
    ).toBe(false);
  });
});
