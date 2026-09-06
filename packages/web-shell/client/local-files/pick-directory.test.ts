import { describe, expect, it, vi } from 'vitest';
import type { LocalFilesWindowLike } from './capabilities.js';
import {
  ensureReadwritePermission,
  pickDirectoryHandle,
} from './pick-directory.js';

function handleWith(permissions: {
  query?: PermissionState | Error;
  request?: PermissionState | Error;
}): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: 'ai_coding',
    queryPermission: vi.fn(async () => {
      if (permissions.query instanceof Error) throw permissions.query;
      return permissions.query ?? 'prompt';
    }),
    requestPermission: vi.fn(async () => {
      if (permissions.request instanceof Error) throw permissions.request;
      return permissions.request ?? 'granted';
    }),
  } as unknown as FileSystemDirectoryHandle;
}

function windowWith(pick: unknown): LocalFilesWindowLike {
  const self = {};
  return {
    isSecureContext: true,
    showDirectoryPicker: pick,
    self,
    top: self,
  };
}

describe('pickDirectoryHandle', () => {
  it('returns the granted handle and asks for readwrite', async () => {
    const handle = handleWith({ query: 'granted' });
    const pick = vi.fn(async () => handle);

    const result = await pickDirectoryHandle(windowWith(pick));

    expect(result).toEqual({ kind: 'picked', handle });
    expect(pick).toHaveBeenCalledWith({
      id: 'qwen-local-files',
      mode: 'readwrite',
    });
  });

  it('reports a dismissed picker as cancelled, not as a failure', async () => {
    const pick = vi.fn(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    expect(await pickDirectoryHandle(windowWith(pick))).toEqual({
      kind: 'cancelled',
    });
  });

  it('keeps the real reason when the picker itself fails', async () => {
    const pick = vi.fn(async () => {
      throw new DOMException('Blocked by policy', 'SecurityError');
    });
    // Not "unsupported browser": that would send the user to the wrong fix.
    expect(await pickDirectoryHandle(windowWith(pick))).toEqual({
      kind: 'failed',
      message: 'Blocked by policy',
    });
  });

  it('never opens the picker when the context cannot support it', async () => {
    const pick = vi.fn(async () => handleWith({ query: 'granted' }));
    const insecure = windowWith(pick);
    insecure.isSecureContext = false;

    expect(await pickDirectoryHandle(insecure)).toEqual({
      kind: 'unavailable',
      blocker: 'insecure-context',
    });
    expect(pick).not.toHaveBeenCalled();
  });
});

describe('ensureReadwritePermission', () => {
  it('reports an already-granted handle without consuming a gesture', async () => {
    const handle = handleWith({ query: 'granted' });
    expect(await ensureReadwritePermission(handle)).toEqual({
      state: 'granted',
      requested: false,
    });
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('does not prompt unless the caller is inside a real gesture', async () => {
    const handle = handleWith({ query: 'prompt' });
    expect(await ensureReadwritePermission(handle)).toEqual({
      state: 'prompt',
      requested: false,
    });
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('asks when allowed and reports that a gesture was consumed', async () => {
    const handle = handleWith({ query: 'prompt', request: 'granted' });
    expect(
      await ensureReadwritePermission(handle, { allowRequest: true }),
    ).toEqual({ state: 'granted', requested: true });
    expect(handle.requestPermission).toHaveBeenCalledWith({
      mode: 'readwrite',
    });
  });

  it('passes a denial through', async () => {
    const handle = handleWith({ query: 'denied' });
    expect(
      await ensureReadwritePermission(handle, { allowRequest: true }),
    ).toEqual({ state: 'denied', requested: false });
  });

  it('treats an unqueryable handle as denied so the user is asked to pick again', async () => {
    const handle = handleWith({
      query: new DOMException('Gone', 'NotFoundError'),
    });
    expect(await ensureReadwritePermission(handle)).toEqual({
      state: 'denied',
      requested: false,
    });
  });

  it('treats a throwing requestPermission as denied', async () => {
    const handle = handleWith({
      query: 'prompt',
      request: new DOMException('No gesture', 'SecurityError'),
    });
    expect(
      await ensureReadwritePermission(handle, { allowRequest: true }),
    ).toEqual({ state: 'denied', requested: true });
  });
});
