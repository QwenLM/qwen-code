import { describe, expect, it } from 'vitest';
import {
  detectLocalFilesCapability,
  type LocalFilesWindowLike,
} from './capabilities.js';

const picker = (): Promise<FileSystemDirectoryHandle> =>
  Promise.resolve({
    kind: 'directory',
    name: 'x',
  } as FileSystemDirectoryHandle);

function topLevel(overrides: Partial<LocalFilesWindowLike> = {}) {
  const self = {};
  return {
    isSecureContext: true,
    showDirectoryPicker: picker,
    self,
    top: self,
    ...overrides,
  } satisfies LocalFilesWindowLike;
}

function framedIn(top: unknown): LocalFilesWindowLike {
  return {
    isSecureContext: true,
    showDirectoryPicker: picker,
    self: {},
    top,
  };
}

describe('detectLocalFilesCapability', () => {
  it('offers the bridge in a secure-context top-level document', () => {
    expect(detectLocalFilesCapability(topLevel())).toEqual({
      pickerAvailable: true,
      secureContext: true,
      frame: 'top-level',
      blocker: null,
    });
  });

  it('offers the bridge in a same-origin iframe', () => {
    const capability = detectLocalFilesCapability(
      framedIn({ location: { href: 'https://daemon.example/' } }),
    );
    expect(capability.frame).toBe('same-origin-iframe');
    expect(capability.blocker).toBeNull();
  });

  it('blocks a cross-origin iframe — the extension side panel shape', () => {
    const top = {};
    Object.defineProperty(top, 'location', {
      get() {
        throw new DOMException('Blocked a frame with origin', 'SecurityError');
      },
    });
    const capability = detectLocalFilesCapability(framedIn(top));
    expect(capability.frame).toBe('cross-origin-iframe');
    expect(capability.blocker).toBe('cross-origin-frame');
  });

  it('treats a null top as top-level rather than crashing', () => {
    expect(detectLocalFilesCapability(framedIn(null)).frame).toBe('top-level');
  });

  it('blocks an insecure origin — a daemon reached over plain http', () => {
    const capability = detectLocalFilesCapability(
      topLevel({ isSecureContext: false }),
    );
    expect(capability.blocker).toBe('insecure-context');
  });

  it('blocks a browser with no picker', () => {
    expect(
      detectLocalFilesCapability(topLevel({ showDirectoryPicker: undefined }))
        .blocker,
    ).toBe('unsupported-browser');
    expect(
      detectLocalFilesCapability(topLevel({ showDirectoryPicker: 'nope' }))
        .blocker,
    ).toBe('unsupported-browser');
  });

  it('reports the browser blocker first, because that is what the user can act on', () => {
    const capability = detectLocalFilesCapability(
      topLevel({ isSecureContext: false, showDirectoryPicker: undefined }),
    );
    expect(capability.blocker).toBe('unsupported-browser');
  });
});
