/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDesktopShell, openExternalUrl } from './externalOpen';

type TauriWindow = { __TAURI__?: { core?: { invoke?: unknown } } };

describe('externalOpen', () => {
  afterEach(() => {
    delete (window as TauriWindow).__TAURI__;
    vi.restoreAllMocks();
  });

  it('detects the desktop shell through the global Tauri bridge', () => {
    expect(isDesktopShell()).toBe(false);
    (window as TauriWindow).__TAURI__ = { core: { invoke: vi.fn() } };
    expect(isDesktopShell()).toBe(true);
  });

  it('routes opens through the open_external_url command in desktop', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as TauriWindow).__TAURI__ = { core: { invoke } };
    await openExternalUrl('https://github.com/QwenLM/qwen-code/issues/9060');
    expect(invoke).toHaveBeenCalledWith('open_external_url', {
      url: 'https://github.com/QwenLM/qwen-code/issues/9060',
    });
  });

  it('propagates desktop command failures so callers can toast', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('command not allowed'));
    (window as TauriWindow).__TAURI__ = { core: { invoke } };
    await expect(openExternalUrl('https://example.com')).rejects.toThrow(
      'command not allowed',
    );
  });

  it('falls back to window.open in a plain browser', async () => {
    const win = { opener: 'self' as unknown };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(win as Window);
    await openExternalUrl('https://example.com');
    expect(openSpy).toHaveBeenCalledWith(
      'https://example.com',
      '_blank',
      'noopener,noreferrer',
    );
    expect(win.opener).toBeNull();
  });

  it('rejects when the browser blocks the popup', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    await expect(openExternalUrl('https://example.com')).rejects.toThrow(
      'blocked',
    );
  });
});
